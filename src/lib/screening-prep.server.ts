/**
 * Background screening-kit preparation worker (server-only).
 *
 * Candidates who are shortlisted owe HR a first screening call, and the
 * questions for that call should be ready before HR arrives — never something
 * a recruiter waits on. The queue lives in `screening_prep_jobs`; this worker
 * is driven by the platform scheduler through /api/public/screening-prep.
 *
 * Per run:
 *  1. backfill  — active shortlisted applications missing both a kit and a job
 *  2. reclaim   — rows stuck in `running` past the lease go back to pending
 *  3. claim     — pending rows due by retry backoff, FOR UPDATE SKIP LOCKED
 *  4. process   — build + insert the kit, bounded concurrency
 *
 * Failure text is vendor-neutral by construction: only an allowlisted message
 * is ever persisted to `last_error` (which the UI may show); anything else —
 * including provider/model details from transport errors — collapses to a
 * generic retry hint. Note: a failed job re-enqueues on the candidate's next
 * shortlist transition or via the backfill after its row is gone; terminal
 * failures are not auto-retried forever.
 */
import { and, eq, inArray, notExists, sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  applications,
  screeningKits,
  screeningPrepJobs,
  type ScreeningPrepStatus,
} from "@db/schema";
import { mapWithConcurrency } from "./matching.server";
import { prepareScreeningKitForPairing } from "./screening.functions";

const MAX_ATTEMPTS = 3;
const CONCURRENCY = 2;
const RUNNING_LEASE_MINUTES = 10;
/** Seconds of backoff per failed attempt; fresh rows (attempts = 0) are due immediately. */
const BACKOFF_SECONDS = 60;

/** Messages safe to surface to HR; everything else maps to the generic hint. */
const FRIENDLY_ERRORS = new Set([
  "No AI model key saved. Add one on the Integrations page.",
  "This role has no job description text yet.",
  "Candidate not found",
  "The model returned no questions — try again.",
  "Could not save the screening kit",
]);
const GENERIC_ERROR =
  "Questions could not be prepared automatically. Open the candidate and press Prepare questions to retry.";

export interface PrepRunCounts {
  backfilled: number;
  reclaimed: number;
  claimed: number;
  ready: number;
  skipped: number;
  requeued: number;
  failed: number;
}

/**
 * One scheduler tick. Safe to run concurrently with itself: claims are
 * disjoint (SKIP LOCKED) and each job re-checks kit existence before building.
 */
export async function runScreeningPrep(opts: { max?: number } = {}): Promise<PrepRunCounts> {
  const max = Math.min(Math.max(opts.max ?? 25, 1), 100);
  const counts: PrepRunCounts = {
    backfilled: 0,
    reclaimed: 0,
    claimed: 0,
    ready: 0,
    skipped: 0,
    requeued: 0,
    failed: 0,
  };

  /* ------------------------------------------------- 1. backfill */

  // Active shortlisted applications that owe a kit and have no job row yet.
  // This pass self-heals tenants that shortlisted people before this feature
  // existed (or while the scheduler entry was still unregistered).
  const needsJob = await db
    .select({
      orgId: applications.orgId,
      id: applications.id,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
    })
    .from(applications)
    .where(
      and(
        eq(applications.stage, "shortlisted"),
        notExists(
          db
            .select({ one: screeningKits.id })
            .from(screeningKits)
            .where(
              and(
                eq(screeningKits.orgId, applications.orgId),
                eq(screeningKits.candidateId, applications.candidateId),
                eq(screeningKits.requisitionId, applications.requisitionId),
              ),
            ),
        ),
        notExists(
          db
            .select({ one: screeningPrepJobs.id })
            .from(screeningPrepJobs)
            .where(eq(screeningPrepJobs.applicationId, applications.id)),
        ),
      ),
    )
    .limit(max);

  if (needsJob.length) {
    const inserted = await db
      .insert(screeningPrepJobs)
      .values(
        needsJob.map((a) => ({
          orgId: a.orgId,
          applicationId: a.id,
          candidateId: a.candidateId,
          requisitionId: a.requisitionId,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: screeningPrepJobs.id });
    counts.backfilled = inserted.length;
  }

  /* -------------------------------------------------- 2. reclaim */

  const reclaimed = await db
    .update(screeningPrepJobs)
    .set({ status: "pending", updatedAt: new Date() })
    .where(
      and(
        eq(screeningPrepJobs.status, "running"),
        sql`${screeningPrepJobs.updatedAt} < now() - interval '${sql.raw(String(RUNNING_LEASE_MINUTES))} minutes'`,
      ),
    )
    .returning({ id: screeningPrepJobs.id });
  counts.reclaimed = reclaimed.length;

  /* --------------------------------------------------- 3. claim */

  // Same two-step shape as the email outbox: the FOR UPDATE SKIP LOCKED
  // subselect makes concurrent runs claim disjoint sets.
  const dueIds = db
    .select({ id: screeningPrepJobs.id })
    .from(screeningPrepJobs)
    .where(
      and(
        eq(screeningPrepJobs.status, "pending"),
        sql`${screeningPrepJobs.updatedAt} < now() - (${screeningPrepJobs.attempts} * interval '${sql.raw(String(BACKOFF_SECONDS))} seconds')`,
      ),
    )
    .orderBy(screeningPrepJobs.createdAt)
    .limit(max)
    .for("update", { skipLocked: true });

  const claimed = await db
    .update(screeningPrepJobs)
    .set({ status: "running", updatedAt: new Date() })
    .where(inArray(screeningPrepJobs.id, dueIds))
    .returning();
  counts.claimed = claimed.length;

  /* ------------------------------------------------- 4. process */

  const outcomes = await mapWithConcurrency(claimed, CONCURRENCY, (job) => processOne(job));
  for (const outcome of outcomes) counts[outcome]++;

  return counts;
}

async function processOne(
  job: typeof screeningPrepJobs.$inferSelect,
): Promise<"ready" | "skipped" | "requeued" | "failed"> {
  try {
    // Dedupe: a manual prep (or an earlier job) may have raced us to it.
    // Kits intentionally have no unique index — "Rebuild questions" keeps
    // multiple kits per pairing — so the check lives here.
    const [existing] = await db
      .select({ id: screeningKits.id })
      .from(screeningKits)
      .where(
        and(
          eq(screeningKits.orgId, job.orgId!),
          eq(screeningKits.candidateId, job.candidateId),
          eq(screeningKits.requisitionId, job.requisitionId),
        ),
      )
      .limit(1);
    if (existing) {
      await mark(job.id, "ready", null, job.attempts);
      return "skipped";
    }

    const { withAiSubject } = await import("../server/agents/context");
    await withAiSubject({ candidateId: job.candidateId, requisitionId: job.requisitionId }, () =>
      prepareScreeningKitForPairing({
        orgId: job.orgId!,
        candidateId: job.candidateId,
        requisitionId: job.requisitionId,
        createdBy: null,
      }),
    );
    await mark(job.id, "ready", null, job.attempts);
    return "ready";
  } catch (e) {
    const message =
      e instanceof Error && FRIENDLY_ERRORS.has(e.message) ? e.message : GENERIC_ERROR;
    const attempts = job.attempts + 1;
    if (attempts < MAX_ATTEMPTS) {
      await mark(job.id, "pending", message, attempts);
      return "requeued";
    }
    await mark(job.id, "failed", message, attempts);
    return "failed";
  }
}

async function mark(
  id: string,
  status: ScreeningPrepStatus,
  lastError: string | null,
  attempts: number,
) {
  await db
    .update(screeningPrepJobs)
    .set({ status, lastError, attempts, updatedAt: new Date() })
    .where(eq(screeningPrepJobs.id, id));
}
