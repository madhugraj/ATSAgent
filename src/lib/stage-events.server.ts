/**
 * Single choke point for application stage transitions: writes the immutable
 * stage_events, then enqueues the matching candidate emails through the outbox.
 *
 * Email rules (v1):
 *  - only shortlisted / l1 / l2 / l3 send a stage email
 *  - AI transitions only email on shortlisted (ai_screened reads as an
 *    automated rejection and stays silent)
 *  - interview_scheduled transitions stay silent (the invite email covers them)
 */
import { eq, inArray } from "drizzle-orm";

import { db } from "../server/db";
import {
  applications,
  candidates,
  organizations,
  requisitions,
  screeningKits,
  screeningPrepJobs,
  stageEvents,
} from "@db/schema";
import { enqueueStageUpdates } from "./email-outbox.server";
import type { Stage } from "./lifecycle";

const STAGE_EMAIL_COPY: Partial<Record<Stage, { heading: string; body: string }>> = {
  shortlisted: {
    heading: "You have been shortlisted",
    body: "Your profile stood out for this role, and the recruiting team would like to take your application forward to the next round.",
  },
  l1: {
    heading: "You have advanced to the first interview round",
    body: "Congratulations — you have advanced to the first interview round. The team will share the details shortly.",
  },
  l2: {
    heading: "You have advanced to the next interview round",
    body: "Congratulations — you have advanced to the next interview round. The team will share the details shortly.",
  },
  l3: {
    heading: "You have advanced to the final interview round",
    body: "Congratulations — you have advanced to the final interview round. The team will share the details shortly.",
  },
};

export interface RecordStageTransitionInput {
  orgId: string;
  applicationId: string;
  fromStage: Stage | null;
  toStage: Stage;
  actor: string;
  reason?: string | null;
  note?: string | null;
  source?: "human" | "ai";
  cause?: "interview_scheduled" | "offer";
}

export async function recordStageTransition(input: RecordStageTransitionInput): Promise<void> {
  return recordStageTransitions([input]);
}

export async function recordStageTransitions(inputs: RecordStageTransitionInput[]): Promise<void> {
  if (!inputs.length) return;

  await enqueueScreeningPrep(inputs);

  const events = await db
    .insert(stageEvents)
    .values(
      inputs.map((i) => ({
        applicationId: i.applicationId,
        orgId: i.orgId,
        fromStage: i.fromStage,
        toStage: i.toStage,
        actor: i.actor,
        reason: i.reason ?? null,
        note: i.note ?? null,
      })),
    )
    .returning({ id: stageEvents.id });

  await emitAgentStageEvents(inputs);
  // Agent requests that assumed the old stage no longer apply: close them.
  for (const i of inputs) {
    if (!i.fromStage || i.fromStage === i.toStage) continue;
    try {
      const { cancelStaleRequests } = await import("../server/agents/runtime.server");
      await cancelStaleRequests(i.orgId, i.applicationId, i.fromStage, i.toStage);
    } catch (e) {
      console.error("[stage-events] stale request check failed (stage move unaffected):", e);
    }
  }
  // Multi-row INSERT ... RETURNING preserves insertion order.
  const eligible = inputs
    .map((input, i) => ({ input, eventId: events[i]?.id }))
    .filter(({ input, eventId }) => {
      if (!eventId) return false;
      if (!STAGE_EMAIL_COPY[input.toStage]) return false;
      if (input.fromStage && input.fromStage === input.toStage) return false;
      if (input.source === "ai" && input.toStage !== "shortlisted") return false;
      if (input.cause === "interview_scheduled") return false;
      return true;
    });
  if (!eligible.length) return;

  const [ctx] = eligible;
  const contact = await db
    .select({
      applicationId: applications.id,
      email: candidates.email,
      fullName: candidates.fullName,
      jobTitle: requisitions.title,
      orgName: organizations.name,
    })
    .from(applications)
    .innerJoin(candidates, eq(applications.candidateId, candidates.id))
    .innerJoin(requisitions, eq(applications.requisitionId, requisitions.id))
    .innerJoin(organizations, eq(applications.orgId, organizations.id))
    .where(
      inArray(
        applications.id,
        eligible.map((e) => e.input.applicationId),
      ),
    );
  const byApplication = new Map(contact.map((c) => [c.applicationId, c]));

  const byOrg = new Map<string, Parameters<typeof enqueueStageUpdates>[0]>();
  for (const { input, eventId } of eligible) {
    const c = byApplication.get(input.applicationId);
    if (!c?.email) continue;
    const copy = STAGE_EMAIL_COPY[input.toStage]!;
    const rows = byOrg.get(input.orgId) ?? [];
    rows.push({
      applicationId: input.applicationId,
      toEmail: c.email,
      idempotencyKey: `stage:${eventId}`,
      templateData: {
        candidateName: c.fullName,
        orgName: c.orgName,
        jobTitle: c.jobTitle,
        stageHeading: copy.heading,
        stageBody: copy.body,
      },
    });
    byOrg.set(input.orgId, rows);
  }

  for (const [orgId, rows] of byOrg) {
    await enqueueStageUpdates(rows, { orgId });
  }
}

/**
 * Screening kits are prepared in the background when a candidate is
 * shortlisted, so the questions are ready before HR opens the triage queue.
 * Sitting on the shared transition choke point covers every path that
 * advances a stage: recruiter moves (single + bulk), autoscore and the
 * matching engine.
 *
 * Never throws — a prep-enqueue failure must not fail the stage move.
 */
async function enqueueScreeningPrep(inputs: RecordStageTransitionInput[]): Promise<void> {
  try {
    const shortlisted = inputs.filter((i) => i.toStage === "shortlisted");
    if (!shortlisted.length) return;

    // orgId is re-taken from the application row, not the caller's input.
    const appRows = await db
      .select({
        id: applications.id,
        orgId: applications.orgId,
        candidateId: applications.candidateId,
        requisitionId: applications.requisitionId,
      })
      .from(applications)
      .where(
        inArray(
          applications.id,
          inputs.map((i) => i.applicationId),
        ),
      );
    const candidates2 = appRows.filter((a) => a.orgId && a.requisitionId);
    if (!candidates2.length) return;

    // Pairings that already have any kit are skipped — manual "Rebuild
    // questions" keeps multiple kits per pairing, so dedupe happens here in
    // code rather than through a unique index. Candidate ids are globally
    // unique uuids, so no org predicate is needed for this existence check.
    const kitRows = await db
      .select({
        candidateId: screeningKits.candidateId,
        requisitionId: screeningKits.requisitionId,
      })
      .from(screeningKits)
      .where(
        inArray(
          screeningKits.candidateId,
          candidates2.map((a) => a.candidateId),
        ),
      );
    const kitted = new Set(kitRows.map((k) => `${k.candidateId}:${k.requisitionId}`));

    const fresh = candidates2.filter((a) => !kitted.has(`${a.candidateId}:${a.requisitionId}`));
    if (!fresh.length) return;

    await db
      .insert(screeningPrepJobs)
      .values(
        fresh.map((a) => ({
          orgId: a.orgId!,
          applicationId: a.id,
          candidateId: a.candidateId,
          requisitionId: a.requisitionId!,
        })),
      )
      // Upsert, not insert-only: a previously failed job re-enqueues with a
      // clean slate. A `ready` job only reaches this statement when its
      // pairing has no kit row (i.e. the kit vanished) — re-prepping is then
      // the correct outcome.
      .onConflictDoUpdate({
        target: screeningPrepJobs.applicationId,
        set: { status: "pending", attempts: 0, lastError: null, updatedAt: new Date() },
      });
  } catch (e) {
    console.error("[screening-prep] enqueue failed (stage move unaffected):", e);
  }
}

/**
 * Tell the orchestrator about new shortlists (one event per requisition and
 * org), so a switched-on Screening agent can prepare screening and assessments.
 */
async function emitAgentStageEvents(inputs: RecordStageTransitionInput[]): Promise<void> {
  const ROUNDS = ["l1", "l2", "l3"];
  // Advanced into an interview round by a decision (not by scheduling it):
  // the next round needs coordinating.
  const advanced = inputs.filter(
    (i) =>
      ROUNDS.includes(i.toStage) && i.fromStage !== i.toStage && i.cause !== "interview_scheduled",
  );
  const shortlisted = inputs.filter(
    (i) => i.toStage === "shortlisted" && i.fromStage !== "shortlisted",
  );
  if (advanced.length) await emitPerRequisition(advanced, "application.advanced");
  if (!shortlisted.length) return;
  await emitPerRequisition(shortlisted, "application.shortlisted");
}

async function emitPerRequisition(
  inputs: RecordStageTransitionInput[],
  type: "application.shortlisted" | "application.advanced",
): Promise<void> {
  const apps = await db
    .select({
      id: applications.id,
      orgId: applications.orgId,
      requisitionId: applications.requisitionId,
    })
    .from(applications)
    .where(
      inArray(
        applications.id,
        inputs.map((i) => i.applicationId),
      ),
    );
  const byReq = new Map<string, { orgId: string; applicationIds: string[] }>();
  for (const a of apps) {
    if (!a.orgId) continue;
    const entry = byReq.get(a.requisitionId) ?? { orgId: a.orgId, applicationIds: [] };
    entry.applicationIds.push(a.id);
    byReq.set(a.requisitionId, entry);
  }
  const { emitAgentEvent } = await import("../server/agents/events");
  for (const [requisitionId, e] of byReq) {
    await emitAgentEvent({
      orgId: e.orgId,
      type,
      subjectType: "requisition",
      subjectId: requisitionId,
      actorUserId: null,
      payload: { applicationIds: e.applicationIds },
    });
  }
}
