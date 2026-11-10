import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { copilotMessages } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { MANUAL_TEXT } from "@/lib/user-manual";
import { NAV_GROUPS } from "@/components/nav-config";

/** Every page in the menu, from the same source as the sidebar so the list cannot drift. */
const PAGE_LIST = [
  ...new Map(
    NAV_GROUPS.flatMap((g) => g.items).map((i) => {
      const path = i.search ? `${i.to}?${new URLSearchParams(i.search)}` : i.to;
      return [path, `  ${i.label} (${path})`] as const;
    }),
  ).values(),
].join("\n");

export type CopilotMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Work the copilot proposed handing to the agents, until it is started. */
  handoff: { goal: string; summary: string } | null;
  createdAt: string;
};

/** The single ongoing copilot conversation for the signed-in user. */
export const copilotHistory = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<CopilotMessage[]> => {
    const rows = await db
      .select({
        id: copilotMessages.id,
        role: copilotMessages.role,
        content: copilotMessages.content,
        handoff: copilotMessages.handoff,
        createdAt: copilotMessages.createdAt,
      })
      .from(copilotMessages)
      .where(
        and(eq(copilotMessages.userId, context.userId), eq(copilotMessages.orgId, context.orgId)),
      )
      .orderBy(asc(copilotMessages.createdAt))
      .limit(200);
    return rows.map((r) => ({
      id: r.id,
      role: r.role as "user" | "assistant",
      content: r.content,
      handoff: r.handoff ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  });

export const clearCopilot = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    await db
      .delete(copilotMessages)
      .where(
        and(eq(copilotMessages.userId, context.userId), eq(copilotMessages.orgId, context.orgId)),
      );
    return { ok: true };
  });

export const COPILOT_SYSTEM = `You are the HR copilot inside a talent-acquisition system (ATS).
You help recruiters, hiring managers, department heads, HR heads and the CBO understand
their own live hiring data and advise on process: requisition status and approvals, the
skill and role ontology, talent-pool coverage, future role demand, governance, JD quality,
matching weights, interview scheduling, offers and pipeline risk.

Rules:
- Answer ONLY from what your tools return plus general HR expertise. Never invent
  candidate names, numbers or requisitions that the tools did not return.
- If the tools have no data for the question, say so plainly and suggest the page to use.
- Never invent navigation. These are the ONLY pages that exist, use their exact names
  (some are limited to certain roles):
${PAGE_LIST}
  Name a tab, section or setting inside a page only if the USER MANUAL below names it;
  otherwise name just the page.
- User administration lives on Users & roles (/team): the organisation owner can invite
  people, grant or revoke roles, pause (disable) access, and permanently delete a member
  from the row action menu. Deleting removes their membership and roles; pausing keeps
  history intact. Owners cannot be deleted until ownership is transferred; a platform super
  user can delete any user, including an owner, from Platform console > Users.
- Organisation (/organisation): the owner edits the organisation profile and can archive the
  organisation. Archiving locks everyone out but deletes nothing; only a platform super user
  can restore it, and they also see every registered organisation's statistics.
- For "how do I ..." questions, answer strictly from the USER MANUAL below, quoting the
  real page names and the actual order of steps. Never invent a setting that is not in it.

USER MANUAL (authoritative product documentation):
${MANUAL_TEXT}`;

export type CopilotAnswer = { answer: string; handoff: { goal: string; summary: string } | null };

export const askCopilot = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ message: z.string().min(1).max(2000) }).parse(data))
  .handler(async ({ data, context }): Promise<CopilotAnswer> => {
    const { loadCopilotCtx } = await import("../server/copilot/data.server");
    const { runCopilotTurn, historyMessages } = await import("../server/copilot/copilot.server");

    await db.insert(copilotMessages).values({
      userId: context.userId,
      orgId: context.orgId,
      role: "user",
      content: data.message,
    });

    const prior = await db
      .select({ role: copilotMessages.role, content: copilotMessages.content })
      .from(copilotMessages)
      .where(
        and(eq(copilotMessages.userId, context.userId), eq(copilotMessages.orgId, context.orgId)),
      )
      .orderBy(desc(copilotMessages.createdAt))
      .limit(12);

    const ctx = await loadCopilotCtx(context.orgId, context.userId, context.isOwner);
    const result = await runCopilotTurn({
      ctx,
      system: COPILOT_SYSTEM,
      history: historyMessages(prior.reverse()),
    });

    const answer = result.failed
      ? `I could not complete that: ${result.failed}`
      : result.answer || "I could not produce an answer for that.";

    await db.insert(copilotMessages).values({
      userId: context.userId,
      orgId: context.orgId,
      role: "assistant",
      content: answer,
      handoff: result.handoff,
    });

    return { answer, handoff: result.handoff };
  });

/**
 * Start the agent Copilot with the goal the HR copilot proposed on one of its
 * answers. The goal is read from the stored message (never from the client),
 * so the person confirms exactly what was shown; the hand-off is used once.
 */
export const startCopilotHandoff = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ messageId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ runId: string }> => {
    const mine = and(
      eq(copilotMessages.id, data.messageId),
      eq(copilotMessages.orgId, context.orgId),
      eq(copilotMessages.userId, context.userId),
      eq(copilotMessages.role, "assistant"),
    );
    const { ensureAgentsRegistered } = await import("../server/agents");
    ensureAgentsRegistered();
    const { loadPolicy } = await import("../server/agents/policy");
    const policy = await loadPolicy(context.orgId, "copilot");
    if (!policy.enabled) throw new Error("Switch on the Copilot in Agent settings first.");
    const [msg] = await db
      .select({ handoff: copilotMessages.handoff })
      .from(copilotMessages)
      .where(mine)
      .limit(1);
    if (!msg?.handoff) throw new Error("That suggestion is no longer available.");
    // Claim it atomically: a double click starts the agents once.
    const claimed = await db
      .update(copilotMessages)
      .set({ handoff: null })
      .where(and(mine, isNotNull(copilotMessages.handoff)))
      .returning({ id: copilotMessages.id });
    if (!claimed.length) throw new Error("Those agents were already started.");
    const { startRun } = await import("../server/agents/runtime.server");
    let runId: string;
    try {
      ({ runId } = await startRun({
        orgId: context.orgId,
        agentType: "copilot",
        principalUserId: context.userId,
        goal: msg.handoff.goal,
      }));
    } catch (e) {
      await db.update(copilotMessages).set({ handoff: msg.handoff }).where(mine);
      throw e;
    }
    const { kickAgents } = await import("../server/agents/orchestrator.server");
    kickAgents(context.orgId);
    return { runId };
  });

/* ------------------------------------------------ pool coverage and outlook */

async function poolCtx(orgId: string, userId: string, isOwner: boolean) {
  const { loadCopilotCtx } = await import("../server/copilot/data.server");
  const ctx = await loadCopilotCtx(orgId, userId, isOwner);
  if (!ctx.scope.pool) throw new Error("Your role does not include the talent pool.");
  return ctx;
}

/**
 * Talent-pool coverage and the cached demand outlook for the Talent pool page.
 * Never calls the AI model: the outlook is only built on request.
 */
export const poolInsights = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const ctx = await poolCtx(context.orgId, context.userId, context.isOwner);
    const { poolCoverage } = await import("../server/copilot/data.server");
    const { demandOutlooks } = await import("@db/schema");
    const [coverage, cached] = await Promise.all([
      poolCoverage(ctx),
      db
        .select({ payload: demandOutlooks.payload })
        .from(demandOutlooks)
        .where(eq(demandOutlooks.orgId, context.orgId))
        .limit(1),
    ]);
    return {
      coverage,
      outlook: cached[0]?.payload ?? null,
      canRefresh: ctx.scope.tier === "leadership",
    };
  });

/** Build (or rebuild) the demand outlook. Leadership may refresh; anyone with pool access may build the first. */
export const refreshDemandOutlook = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const ctx = await poolCtx(context.orgId, context.userId, context.isOwner);
    const { demandOutlook } = await import("../server/copilot/data.server");
    return demandOutlook(ctx, ctx.scope.tier === "leadership");
  });

/** A person judges one outlook row useful or not — training feedback, behind consent. */
export const rateDemandOutlook = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    z.object({ role: z.string().min(1).max(120), useful: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const ctx = await poolCtx(context.orgId, context.userId, context.isOwner);
    const { demandOutlooks } = await import("@db/schema");
    const [cached] = await db
      .select({ payload: demandOutlooks.payload })
      .from(demandOutlooks)
      .where(eq(demandOutlooks.orgId, ctx.orgId))
      .limit(1);
    const row = cached?.payload.rows.find((r) => r.role === data.role);
    if (!row) throw new Error("That role is not in the current outlook.");
    const { captureFeedback } = await import("../server/training/capture.server");
    await captureFeedback({
      orgId: ctx.orgId,
      source: "demand_outlook",
      label: data.useful ? "useful" : "not_useful",
      rating: data.useful ? 1 : 0,
      original: { ...row, generatedAt: cached!.payload.generatedAt },
      actorUserId: ctx.userId,
    });
    return { ok: true };
  });
