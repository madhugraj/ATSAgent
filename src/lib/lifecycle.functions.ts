import { and, eq, inArray } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { applications } from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";
import { canMove, REASON_REQUIRED, STAGE_LABEL, type Stage } from "./lifecycle";

const STAGES = Object.keys(STAGE_LABEL) as [Stage, ...Stage[]];

/** Offer and hiring stages are HR-controlled — not every org member may act. */
const HR_CONTROLLED_TARGETS = new Set<string>([
  "offer_pending",
  "offer_released",
  "offer_accepted",
  "offer",
  "hired",
  "joined",
]);

const MoveInput = z.object({
  applicationId: z.string().uuid(),
  toStage: z.enum(STAGES),
  reason: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});

/**
 * The only sanctioned way to change an application's stage: the transition is
 * validated server-side, HR-controlled stages require the HR head (or owner),
 * and an immutable stage_event is written for the audit trail. The UI never
 * updates `applications.stage` directly.
 */
export const moveStage = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => MoveInput.parse(data))
  .handler(async ({ data, context }) => {
    const { moveStageCore } = await import("./pipeline.server");
    const r = await moveStageCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      {
        applicationId: data.applicationId,
        toStage: data.toStage,
        reason: data.reason ?? null,
        note: data.note ?? null,
      },
    );
    return { ok: true as const, ...r };
  });

/** Same validation, applied to a selection from the talent pool table. */
export const moveStages = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        applicationIds: z.array(z.string().uuid()).min(1).max(200),
        toStage: z.enum(STAGES),
        reason: z.string().optional().nullable(),
        note: z.string().optional().nullable(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    if (REASON_REQUIRED.includes(data.toStage) && !data.reason?.trim()) {
      throw new Error(`A reason is required to move candidates to ${STAGE_LABEL[data.toStage]}.`);
    }
    if (HR_CONTROLLED_TARGETS.has(data.toStage)) {
      await assertRole(
        context.userId,
        context.orgId,
        ["hr_head", "president_cbo"],
        "Only the HR head or an owner can move candidates into an offer or hiring stage.",
      );
    }

    const apps = await db
      .select({ id: applications.id, stage: applications.stage })
      .from(applications)
      .where(
        and(inArray(applications.id, data.applicationIds), eq(applications.orgId, context.orgId)),
      );

    const actorClaim = (context.claims as Record<string, unknown> | undefined)?.["email"];
    const actor = typeof actorClaim === "string" ? actorClaim : context.userId;
    const now = new Date();

    const moved: { id: string; from: Stage }[] = [];
    let blocked = 0;
    for (const a of apps) {
      const from = a.stage as Stage;
      if (from === data.toStage) continue;
      if (!canMove(from, data.toStage)) {
        blocked += 1;
        continue;
      }
      moved.push({ id: a.id, from });
    }

    if (moved.length) {
      await db
        .update(applications)
        .set({
          stage: data.toStage,
          stageReason: data.reason?.trim() || null,
          stageNote: data.note?.trim() || null,
          lastActivityAt: now,
        })
        .where(
          inArray(
            applications.id,
            moved.map((m) => m.id),
          ),
        );
      const { recordStageTransitions } = await import("./stage-events.server");
      await recordStageTransitions(
        moved.map((m) => ({
          orgId: context.orgId,
          applicationId: m.id,
          fromStage: m.from,
          toStage: data.toStage,
          actor,
          reason: data.reason?.trim() || null,
          note: data.note?.trim() || null,
        })),
      );
    }

    return { moved: moved.length, blocked };
  });
