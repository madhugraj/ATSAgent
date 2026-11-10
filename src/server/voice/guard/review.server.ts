/**
 * Voice Guard — the after-call review of every answered AI phone call
 * (docs/voice-guard.md). Observe and report only: it reads what the call left
 * and files a review for a person; it changes nothing on the call, the
 * candidate or any hiring decision.
 *
 *  - sweepCallReviews (every agent tick): queues a review for each answered
 *    call that has none; a call with no transcript (the candidate did not
 *    consent, so nothing was kept) is reviewed on its line stats alone, by the
 *    system; a call with a transcript starts a Voice Guard run; a run that
 *    ended without filing is retried (three attempts).
 *  - reviewPacket / fileReview: the agent's two tools — what it reads (the
 *    call's rules, the facts it ran with, the transcript, the records, what
 *    the system already found) and what it files (merged with the system's
 *    own checks; a quote not in the transcript is dropped).
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  callReviews,
  screeningCalls,
  type CallReviewCheckId,
  type ScreeningCallDetails,
  type ScreeningCallTurn,
  type VoiceCallPurpose,
} from "@db/schema";
import { db } from "../../db";
import { log } from "../../log";
import {
  NEGOTIATION_CALL_CHARTER,
  SCHEDULING_CALL_CHARTER,
  SCREENING_CALL_CHARTER,
  charterBlock,
} from "../charter";
import { type AgentReview, checksFor, codeChecks, type GuardInput, mergeReview } from "./checks";

/** Calls older than this are not queued (the guard went live after them). */
const QUEUE_DAYS = 14;
/** Reviews started per organisation per tick. */
const START_PER_TICK = 5;
export const MAX_REVIEW_ATTEMPTS = 3;

const CHARTER = {
  screening: SCREENING_CALL_CHARTER,
  scheduling: SCHEDULING_CALL_CHARTER,
  negotiation: NEGOTIATION_CALL_CHARTER,
} as const;

type CallRow = typeof screeningCalls.$inferSelect;

function guardInput(c: CallRow, scope: "full" | "timing_only"): GuardInput {
  return {
    purpose: c.purpose,
    scope,
    status: c.status,
    endReason: c.endReason,
    consentAt: c.consentAt,
    qualityDisclosed: (c.brief ?? "").includes("checked for quality"),
    transcript: c.transcript,
    answers: c.answers,
    details: c.details,
    stats: c.callStats ?? null,
  };
}

async function loadCall(orgId: string, callId: string): Promise<CallRow | null> {
  const [c] = await db
    .select()
    .from(screeningCalls)
    .where(and(eq(screeningCalls.orgId, orgId), eq(screeningCalls.id, callId)))
    .limit(1);
  return c ?? null;
}

/* ------------------------------------------------------------- the tools */

/**
 * What the Voice Guard reads for one call. The run claims the call's review
 * (one run per review); another run's review is refused.
 */
export async function reviewPacket(orgId: string, runId: string, callId: string) {
  const [r] = await db
    .select()
    .from(callReviews)
    .where(and(eq(callReviews.orgId, orgId), eq(callReviews.callId, callId)))
    .limit(1);
  if (!r) throw new Error("This call has no review to do.");
  if (r.agentRunId && r.agentRunId !== runId)
    throw new Error("Another run is reviewing this call.");
  if (r.status === "done") throw new Error("This call has already been reviewed.");
  const c = await loadCall(orgId, callId);
  if (!c) throw new Error("Call not found.");
  if (!r.agentRunId)
    await db
      .update(callReviews)
      .set({ agentRunId: runId, status: "reviewing", updatedAt: new Date() })
      .where(eq(callReviews.id, r.id));
  const code = codeChecks(guardInput(c, r.scope));
  return {
    callId: c.id,
    purpose: c.purpose,
    outcome: {
      status: c.status,
      endReason: c.endReason,
      durationSeconds: c.durationS,
      consented: c.consentAt !== null,
    },
    rules: charterBlock(CHARTER[c.purpose]),
    brief: c.brief ?? "(The call's brief was not kept — judge facts conservatively.)",
    ...(c.brief
      ? {}
      : {
          olderCall:
            "This call was made before the Voice Guard: its rules then did not include saying the call is checked for quality or the no-read-back rule. Do not hold it to those two; judge it by the other rules.",
        }),
    transcript: c.transcript.map((t: ScreeningCallTurn, turn: number) => ({
      turn,
      who: t.who === "ai" ? "assistant" : "candidate",
      at: t.at,
      text: t.text,
      ...(t.interrupted ? { interrupted: true } : {}),
    })),
    records: {
      consentWords: c.consentWords,
      answers: c.answers.map((a) => ({
        questionId: a.question_id,
        summary: a.summary,
        ...(a.declined ? { declined: true } : {}),
        ...(a.prompted ? { prompted: true } : {}),
      })),
      details: c.details satisfies ScreeningCallDetails,
    },
    alreadyFoundBySystem: code.findings.map((f) => ({
      check: f.check,
      severity: f.severity,
      summary: f.summary,
    })),
    yourChecks: checksFor(c.purpose, r.scope, !c.brief)
      .filter((x) => x.by === "review")
      .map((x) => ({ check: x.id, title: x.title, question: x.question })),
  };
}

/** File the agent's review: merged with the system's checks and saved. */
export async function fileReview(
  orgId: string,
  runId: string,
  callId: string,
  review: AgentReview,
): Promise<{ verdict: string; findings: number; dropped: number }> {
  const [r] = await db
    .select()
    .from(callReviews)
    .where(and(eq(callReviews.orgId, orgId), eq(callReviews.callId, callId)))
    .limit(1);
  if (!r) throw new Error("This call has no review to do.");
  if (r.agentRunId !== runId)
    throw new Error(
      "Read the call with read_call_for_review first (this run is not reviewing it).",
    );
  if (r.status === "done") throw new Error("This call has already been reviewed.");
  const c = await loadCall(orgId, callId);
  if (!c) throw new Error("Call not found.");
  const merged = mergeReview(
    c.purpose,
    r.scope,
    codeChecks(guardInput(c, r.scope)),
    review,
    c.transcript,
    !c.brief,
  );
  await db
    .update(callReviews)
    .set({
      status: "done",
      verdict: merged.verdict,
      checks: merged.checks,
      findings: merged.findings,
      breaches: merged.breaches,
      qualityScore: Math.min(5, Math.max(1, Math.round(review.qualityScore))),
      summary: review.summary.slice(0, 1000),
      reviewedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(callReviews.id, r.id));
  if (merged.dropped)
    log.info("voice_guard.findings_dropped", { call_id: callId, dropped: merged.dropped });
  return { verdict: merged.verdict, findings: merged.findings.length, dropped: merged.dropped };
}

/* ------------------------------------------------------------- the sweep */

/** Organisations where the Voice Guard is on: an AI phone agent is on and agents are not paused. */
async function guardedOrgs(orgId?: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    select distinct p.org_id id from agent_policies p
    where p.enabled and p.agent_type in ('screening_call', 'scheduling_call', 'negotiation_call', 'voice_guard')
      ${orgId ? sql`and p.org_id = ${orgId}` : sql``}
      and not exists (select 1 from agent_policies x where x.org_id = p.org_id and x.agent_type = '*' and x.enabled = false)`)) as unknown as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}

/** Who the review run acts for: whoever asked for the call, else the owner. */
async function principalFor(orgId: string, c: CallRow): Promise<string | null> {
  if (c.requestedBy) return c.requestedBy;
  const rows = (await db.execute(sql`
    select user_id from org_members
    where org_id = ${orgId} and is_owner and status = 'active' limit 1`)) as unknown as {
    user_id: string;
  }[];
  return rows[0]?.user_id ?? null;
}

/** Save a review the system can do alone (no transcript was kept). */
export async function reviewTimingOnly(orgId: string, reviewId: string, c: CallRow): Promise<void> {
  const merged = mergeReview(
    c.purpose,
    "timing_only",
    codeChecks(guardInput(c, "timing_only")),
    null,
    [],
  );
  await db
    .update(callReviews)
    .set({
      status: "done",
      verdict: merged.verdict,
      checks: merged.checks,
      findings: merged.findings,
      breaches: merged.breaches,
      summary:
        "Nothing the candidate said was kept (no consent to notes and the quality check), so only the call's line stats were reviewed.",
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(callReviews.id, reviewId));
}

export type SweepCounts = { queued: number; timingOnly: number; started: number; retried: number };

/**
 * Queue, start and retry reviews (every agent tick). Every answered call is
 * reviewed — the review is mandatory wherever an AI phone agent is on.
 */
export async function sweepCallReviews(opts: { orgId?: string } = {}): Promise<SweepCounts> {
  const counts: SweepCounts = { queued: 0, timingOnly: 0, started: 0, retried: 0 };
  const { startRun } = await import("../../agents/runtime.server");
  for (const orgId of await guardedOrgs(opts.orgId)) {
    try {
      // 1. Queue: every answered, ended call without a review.
      const queued = (await db.execute(sql`
        insert into call_reviews (org_id, call_id, purpose, scope)
        select c.org_id, c.id, c.purpose,
          case when jsonb_array_length(c.transcript) > 0 then 'full' else 'timing_only' end
        from screening_calls c
        where c.org_id = ${orgId}
          and c.started_at is not null and c.ended_at is not null
          and c.status not in ('dialling', 'in_progress')
          and c.ended_at >= now() - interval '${sql.raw(String(QUEUE_DAYS))} days'
          and not exists (select 1 from call_reviews r where r.call_id = c.id)
        on conflict do nothing
        returning id`)) as unknown as { id: string }[];
      counts.queued += queued.length;

      // 2. Retry: a run that ended without filing its review.
      const stalled = (await db.execute(sql`
        select r.id, r.attempts, ar.status run_status, ar.last_error
        from call_reviews r join agent_runs ar on ar.id = r.agent_run_id
        where r.org_id = ${orgId} and r.status = 'reviewing'
          and ar.status in ('done', 'failed', 'cancelled')`)) as unknown as {
        id: string;
        attempts: number;
        run_status: string;
        last_error: string | null;
      }[];
      for (const s of stalled) {
        const give = s.attempts >= MAX_REVIEW_ATTEMPTS;
        await db
          .update(callReviews)
          .set({
            status: give ? "failed" : "due",
            agentRunId: null,
            lastError: (
              s.last_error ?? `The review run ended (${s.run_status}) without filing a review.`
            ).slice(0, 500),
            updatedAt: new Date(),
          })
          .where(eq(callReviews.id, s.id));
        counts.retried++;
      }

      // 3. Review what is due: line stats alone by the system, transcripts by the agent.
      const due = await db
        .select()
        .from(callReviews)
        .where(and(eq(callReviews.orgId, orgId), eq(callReviews.status, "due")))
        .orderBy(callReviews.createdAt)
        .limit(START_PER_TICK * 4);
      let started = 0;
      for (const r of due) {
        const c = await loadCall(orgId, r.callId);
        if (!c) continue;
        if (r.scope === "timing_only") {
          await reviewTimingOnly(orgId, r.id, c);
          counts.timingOnly++;
          continue;
        }
        if (started >= START_PER_TICK) continue;
        const principal = await principalFor(orgId, c);
        if (!principal) continue;
        const { runId } = await startRun({
          orgId,
          agentType: "voice_guard",
          principalUserId: principal,
          goal: `Review the AI ${c.purpose} phone call ${c.id}: read it with read_call_for_review, check it against every check listed, and file your review with submit_call_review.\n\nCall id: ${c.id}`,
          subjectType: "voice_call",
          subjectId: c.id,
        });
        await db
          .update(callReviews)
          .set({
            status: "reviewing",
            agentRunId: runId,
            attempts: sql`${callReviews.attempts} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(callReviews.id, r.id));
        started++;
        counts.started++;
      }
    } catch (err) {
      log.warn("voice_guard.sweep_failed", { org_id: orgId, error: err as Error });
    }
  }
  return counts;
}

/** A person asks for the call to be reviewed again (after the guard changed, say). */
export async function requeueReview(orgId: string, reviewId: string): Promise<boolean> {
  const done = await db
    .update(callReviews)
    .set({
      status: "due",
      agentRunId: null,
      attempts: 0,
      lastError: null,
      verdict: null,
      checks: [],
      findings: [],
      breaches: 0,
      qualityScore: null,
      summary: null,
      reviewedAt: null,
      acknowledgedBy: null,
      acknowledgedAt: null,
      ackOutcome: null,
      ackNote: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(callReviews.orgId, orgId),
        eq(callReviews.id, reviewId),
        inArray(callReviews.status, ["done", "failed"]),
      ),
    )
    .returning({ id: callReviews.id });
  return done.length > 0;
}

export type { CallReviewCheckId, VoiceCallPurpose };
