/**
 * Application pipeline cores shared by the server functions (people) and the
 * Phase 2 agent tools: stage moves through the one sanctioned transition
 * check, attaching talent-pool candidates, and candidate notes. Every core
 * predicates on the organisation and applies the same role rules as the UI.
 */
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../server/db";
import { applications, candidateNotes, candidates, requisitions } from "@db/schema";
import { assertRole } from "./auth.middleware";
import { canMove, REASON_REQUIRED, STAGE_LABEL, type Stage } from "./lifecycle";
import type { LifecycleActor } from "./requisitions.server";

/** Offer and hiring stages are HR-controlled — not every org member may act. */
export const HR_CONTROLLED_TARGETS = new Set<string>([
  "offer_pending",
  "offer_released",
  "offer_accepted",
  "offer",
  "hired",
  "joined",
]);

const actorLabel = (a: LifecycleActor) => (a.via ? `${a.memberEmail} (via agent)` : a.memberEmail);

export async function moveStageCore(
  actor: LifecycleActor,
  input: { applicationId: string; toStage: Stage; reason?: string | null; note?: string | null },
): Promise<{ from: Stage; to: Stage; unchanged: boolean }> {
  const [app] = await db
    .select({ id: applications.id, stage: applications.stage })
    .from(applications)
    .where(and(eq(applications.id, input.applicationId), eq(applications.orgId, actor.orgId)))
    .limit(1);
  if (!app) throw new Error("Application not found");
  const from = app.stage as Stage;
  if (from === input.toStage) return { from, to: input.toStage, unchanged: true };
  if (!canMove(from, input.toStage)) {
    throw new Error(
      `${STAGE_LABEL[from]} → ${STAGE_LABEL[input.toStage]} is not an allowed transition. Park the candidate on hold or in the reserve pool first.`,
    );
  }
  if (REASON_REQUIRED.includes(input.toStage) && !input.reason?.trim()) {
    throw new Error(`A reason is required to move a candidate to ${STAGE_LABEL[input.toStage]}.`);
  }
  if (HR_CONTROLLED_TARGETS.has(input.toStage)) {
    await assertRole(
      actor.userId,
      actor.orgId,
      ["hr_head", "president_cbo"],
      "Only the HR head or an owner can move a candidate into an offer or hiring stage.",
    );
  }
  await db
    .update(applications)
    .set({
      stage: input.toStage,
      stageReason: input.reason?.trim() || null,
      stageNote: input.note?.trim() || null,
      lastActivityAt: new Date(),
    })
    .where(eq(applications.id, app.id));
  const { recordStageTransition } = await import("./stage-events.server");
  await recordStageTransition({
    orgId: actor.orgId,
    applicationId: app.id,
    fromStage: from,
    toStage: input.toStage,
    actor: actorLabel(actor),
    reason: input.reason?.trim() || null,
    note: input.note?.trim() || null,
  });
  return { from, to: input.toStage, unchanged: false };
}

/** Attach this organisation's candidates to one of its requisitions. */
export async function addApplicationsCore(
  actor: LifecycleActor,
  input: { requisitionId: string; candidateIds: string[]; source: string },
): Promise<{ added: number }> {
  const [requisition] = await db
    .select({ id: requisitions.id })
    .from(requisitions)
    .where(and(eq(requisitions.id, input.requisitionId), eq(requisitions.orgId, actor.orgId)))
    .limit(1);
  if (!requisition) throw new Error("Requisition not found");
  const owned = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(inArray(candidates.id, input.candidateIds), eq(candidates.orgId, actor.orgId)));
  if (owned.length !== new Set(input.candidateIds).size) {
    throw new Error("Some candidates are not in this organisation's talent pool.");
  }
  await db.insert(applications).values(
    input.candidateIds.map((candidateId) => ({
      requisitionId: input.requisitionId,
      candidateId,
      orgId: actor.orgId,
      source: input.source,
    })),
  );
  return { added: input.candidateIds.length };
}

export async function addCandidateNoteCore(
  actor: LifecycleActor,
  input: { candidateId: string; body: string; authorName?: string | null },
): Promise<{ id: string }> {
  const [c] = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.id, input.candidateId), eq(candidates.orgId, actor.orgId)))
    .limit(1);
  if (!c) throw new Error("Candidate not found");
  const [row] = await db
    .insert(candidateNotes)
    .values({
      orgId: actor.orgId,
      candidateId: c.id,
      authorId: actor.userId,
      authorName: input.authorName ?? actorLabel(actor),
      body: input.body,
    })
    .returning({ id: candidateNotes.id });
  return { id: row!.id };
}
