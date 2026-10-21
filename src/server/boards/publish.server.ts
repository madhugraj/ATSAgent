/**
 * Board publishing — the server-side write path behind publishToBoard /
 * closeBoardPosting. Client input only ever names a requisition and a
 * provider: the requisition's approval state, the board's capability verdict
 * and the posting row are all resolved and written here.
 */
import { placeLabel } from "@/lib/work-mode";
import { and, eq, ne } from "drizzle-orm";

import { db } from "../db";
import { requisitions, requisitionBoardPostings } from "@db/schema";
import { writeAudit } from "../audit";
import { assertRequisitionInOrg } from "../guards";
import { getBoardAdapter, isBoardProvider, loadBoardConnection } from "./registry";
import type { BoardProviderId, RequisitionSnapshot } from "./types";
import { env } from "../env";

export type BoardActor = { memberEmail: string; userId: string };

function applyUrl(requisitionId: string): string {
  return `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/apply/${requisitionId}`;
}

/** Publish (or re-publish) one requisition on one board. */
export async function publishToBoardImpl(input: {
  orgId: string;
  actor: BoardActor;
  requisitionId: string;
  provider: BoardProviderId;
  postText: string | null;
}): Promise<{ status: string; externalId: string | null; externalUrl: string | null }> {
  await assertRequisitionInOrg(input.requisitionId, input.orgId);

  const [requisition] = await db
    .select({
      id: requisitions.id,
      status: requisitions.status,
      title: requisitions.title,
      location: requisitions.location,
      workMode: requisitions.workMode,
      openings: requisitions.openings,
      experienceMin: requisitions.experienceMin,
      experienceMax: requisitions.experienceMax,
      mustHaveSkills: requisitions.mustHaveSkills,
      goodToHaveSkills: requisitions.goodToHaveSkills,
      responsibilities: requisitions.responsibilities,
    })
    .from(requisitions)
    .where(and(eq(requisitions.id, input.requisitionId), eq(requisitions.orgId, input.orgId)))
    .limit(1);
  if (!requisition) throw new Error("Requisition not found.");
  // Parity with the public apply page: only an approved role may be listed.
  if (requisition.status !== "approved") {
    throw new Error("Only an approved requisition can be published to a job board.");
  }

  const conn = await loadBoardConnection(input.orgId, input.provider);
  if (!conn.integrationId) {
    throw new Error(
      `${input.provider} is not set up on the Integrations page — add the connection first.`,
    );
  }
  if (!conn.enabled) {
    throw new Error(`Enable the ${input.provider} connection on the Integrations page first.`);
  }

  const adapter = getBoardAdapter(input.provider);
  const caps = await adapter.capabilities(conn);
  if (caps.posting !== true) {
    throw new Error(
      caps.detail || `${input.provider} posting is not available on this connection yet.`,
    );
  }

  const snapshot: RequisitionSnapshot = {
    id: requisition.id,
    title: requisition.title,
    location: placeLabel(requisition.location, requisition.workMode),
    openings: requisition.openings,
    experienceMin: requisition.experienceMin,
    experienceMax: requisition.experienceMax,
    mustHaveSkills: requisition.mustHaveSkills ?? [],
    goodToHaveSkills: requisition.goodToHaveSkills ?? [],
    responsibilities: requisition.responsibilities,
  };

  const [existing] = await db
    .select({ id: requisitionBoardPostings.id, attempts: requisitionBoardPostings.attempts })
    .from(requisitionBoardPostings)
    .where(
      and(
        eq(requisitionBoardPostings.requisitionId, input.requisitionId),
        eq(requisitionBoardPostings.provider, input.provider),
      ),
    )
    .limit(1);

  try {
    const outcome = await adapter.publishPosting(conn, {
      requisition: snapshot,
      postText: input.postText,
      applyUrl: applyUrl(input.requisitionId),
    });
    const now = new Date();
    const values = {
      orgId: input.orgId,
      requisitionId: input.requisitionId,
      provider: input.provider,
      status: "published",
      externalId: outcome.externalId,
      externalUrl: outcome.externalUrl,
      payload: { applyUrl: applyUrl(input.requisitionId) } as Record<string, unknown>,
      lastError: null,
      publishedBy: input.actor.userId,
      publishedAt: now,
      closedAt: null,
      updatedAt: now,
    };
    if (existing) {
      await db
        .update(requisitionBoardPostings)
        .set({ ...values, attempts: existing.attempts + 1 })
        .where(eq(requisitionBoardPostings.id, existing.id));
    } else {
      await db.insert(requisitionBoardPostings).values({ ...values, attempts: 1 });
    }
    await writeAudit({
      actor: input.actor.memberEmail,
      orgId: input.orgId,
      actorUserId: input.actor.userId,
      action: "board.posting.publish",
      entityType: "requisition",
      entityId: input.requisitionId,
      detail: { provider: input.provider, externalId: outcome.externalId },
    });
    return { status: "published", ...outcome };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Publishing failed.";
    const now = new Date();
    const failure = {
      orgId: input.orgId,
      requisitionId: input.requisitionId,
      provider: input.provider,
      status: "failed",
      lastError: message.slice(0, 500),
      updatedAt: now,
    };
    if (existing) {
      await db
        .update(requisitionBoardPostings)
        .set({ ...failure, attempts: existing.attempts + 1 })
        .where(eq(requisitionBoardPostings.id, existing.id));
    } else {
      await db.insert(requisitionBoardPostings).values({ ...failure, attempts: 1 });
    }
    throw e;
  }
}

/** Close (or mark filled) a published board posting. */
export async function closeBoardPostingImpl(input: {
  orgId: string;
  actor: BoardActor;
  requisitionId: string;
  provider: BoardProviderId;
  reason: "filled" | "closed" | "withdrawn";
}): Promise<void> {
  await assertRequisitionInOrg(input.requisitionId, input.orgId);

  const [posting] = await db
    .select({
      id: requisitionBoardPostings.id,
      externalId: requisitionBoardPostings.externalId,
      status: requisitionBoardPostings.status,
      attempts: requisitionBoardPostings.attempts,
    })
    .from(requisitionBoardPostings)
    .where(
      and(
        eq(requisitionBoardPostings.requisitionId, input.requisitionId),
        eq(requisitionBoardPostings.provider, input.provider),
        eq(requisitionBoardPostings.orgId, input.orgId),
      ),
    )
    .limit(1);
  if (!posting) throw new Error("This requisition is not posted on that board.");

  let vendorError: string | null = null;
  // Feed, Google and hand-posted channels have no vendor posting to close.
  if (posting.externalId && posting.status === "published" && isBoardProvider(input.provider)) {
    try {
      const conn = await loadBoardConnection(input.orgId, input.provider);
      await getBoardAdapter(input.provider).closePosting(conn, posting.externalId, input.reason);
    } catch (e) {
      // The local state moves regardless — the vendor state is repaired on the
      // next publish/sync. Keep the message for the audit trail.
      vendorError = e instanceof Error ? e.message : "vendor close failed";
    }
  }

  await db
    .update(requisitionBoardPostings)
    .set({
      status: input.reason === "withdrawn" ? "withdrawn" : "closed",
      closedAt: new Date(),
      updatedAt: new Date(),
      ...(vendorError ? { lastError: vendorError.slice(0, 500) } : {}),
    })
    .where(eq(requisitionBoardPostings.id, posting.id));

  await writeAudit({
    actor: input.actor.memberEmail,
    orgId: input.orgId,
    actorUserId: input.actor.userId,
    action: "board.posting.close",
    entityType: "requisition",
    entityId: input.requisitionId,
    detail: {
      provider: input.provider,
      reason: input.reason,
      ...(vendorError ? { vendorError } : {}),
    },
  });
}

/**
 * Best-effort close of every published posting when the requisition itself is
 * closed. Never blocks the transition; failures are recorded per row.
 */
export async function closePostingsForRequisition(input: {
  orgId: string;
  actor: BoardActor;
  requisitionId: string;
}): Promise<void> {
  const rows = await db
    .select({ provider: requisitionBoardPostings.provider })
    .from(requisitionBoardPostings)
    .where(
      and(
        eq(requisitionBoardPostings.requisitionId, input.requisitionId),
        eq(requisitionBoardPostings.orgId, input.orgId),
        eq(requisitionBoardPostings.status, "published"),
        // Google for Jobs follows the requisition on its own (distribution sweep).
        ne(requisitionBoardPostings.provider, "google_jobs"),
      ),
    );
  for (const row of rows) {
    try {
      await closeBoardPostingImpl({
        orgId: input.orgId,
        actor: input.actor,
        requisitionId: input.requisitionId,
        provider: row.provider as BoardProviderId,
        reason: "closed",
      });
    } catch (e) {
      console.error("[boards] could not close posting on requisition close", row.provider, e);
    }
  }
}
