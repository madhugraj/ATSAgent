/**
 * Organisation desk server functions (docs/org-context-agent-plan.md, O1).
 * The HR head, the CBO and the owner only — the same people who edit the
 * profile. There is one thread per organisation (kind = 'org_profile'); it
 * never appears in the hiring desk and hiring threads never appear here.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { agentTasks, hiringMessages } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { EDITORS } from "./org-profile.server";

async function actorCtx(context: {
  orgId: string;
  userId: string;
  isOwner: boolean;
}): Promise<{ orgId: string; userId: string; isOwner: boolean }> {
  if (context.isOwner) return context;
  const { assertRole } = await import("./auth.middleware");
  await assertRole(
    context.userId,
    context.orgId,
    [...EDITORS],
    "Only the HR head, the CBO or the organisation owner can use the organisation desk.",
  );
  return context;
}

async function needsAiKey(orgId: string) {
  const { resolveAiConfig } = await import("./ai-gateway.server");
  const cfg = await resolveAiConfig(orgId);
  if (!cfg.apiKey)
    throw new Error("Add your organisation's AI model key on the Integrations page first.");
}

async function registered() {
  const { ensureAgentsRegistered } = await import("../server/agents");
  ensureAgentsRegistered();
}

export const startOrgDeskThread = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    await actorCtx(context);
    await needsAiKey(context.orgId);
    await registered();
    const { ensureOrgThread } = await import("../server/desk/org-desk.server");
    const conv = await ensureOrgThread(context.orgId, context.userId);
    return { id: conv.id };
  });

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type OrgDeskMessageView = {
  id: string;
  role: "user" | "desk" | "agent";
  agentType: string | null;
  body: string;
  card: { type: string; [k: string]: Json } | null;
  at: string;
};

export type OrgDeskThreadView = {
  id: string;
  title: string;
  status: string;
  messages: OrgDeskMessageView[];
  /** Status of every agent request shown in the thread. */
  tasks: Record<string, string>;
  /** Whether the viewer may decide each request, and who it waits for otherwise. */
  deciders: Record<string, { canDecide: boolean; waitingFor: string | null }>;
};

export const getOrgDeskThread = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<OrgDeskThreadView | null> => {
    await actorCtx(context);
    const { ensureOrgThread } = await import("../server/desk/org-desk.server");
    const conv = await ensureOrgThread(context.orgId, context.userId);
    const msgs = await db
      .select()
      .from(hiringMessages)
      .where(
        and(eq(hiringMessages.conversationId, conv.id), eq(hiringMessages.orgId, context.orgId)),
      )
      .orderBy(asc(hiringMessages.createdAt))
      .limit(500);
    const { tidyForPeople, deskTimeZone } = await import("../server/desk/desk.server");
    const timeZone = await deskTimeZone(context.orgId);
    const taskIds = msgs
      .map((m) => (m.card as { type?: string; taskId?: string } | null)?.taskId)
      .filter((x): x is string => typeof x === "string");
    const deciders = await (async () => {
      if (!taskIds.length) return {};
      const { taskDeciders } = await import("../server/desk/desk.server");
      return taskDeciders(context.orgId, context.userId, context.isOwner, taskIds);
    })();
    return {
      id: conv.id,
      title: conv.title,
      status: conv.status,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        agentType: m.agentType,
        body: m.role === "user" ? m.body : tidyForPeople(m.body, timeZone),
        card: (m.card as OrgDeskMessageView["card"] | null) ?? null,
        at: m.createdAt.toISOString(),
      })),
      tasks: await taskStatusesFor(context.orgId, taskIds),
      deciders,
    };
  });

async function taskStatusesFor(orgId: string, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const rows = await db
    .select({ id: agentTasks.id, status: agentTasks.status })
    .from(agentTasks)
    .where(and(eq(agentTasks.orgId, orgId), inArray(agentTasks.id, ids)));
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

const Text = z.string().trim().min(1).max(2000);

export const sendOrgDeskMessage = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), message: Text }).parse(d))
  .handler(async ({ data, context }) => {
    await actorCtx(context);
    await needsAiKey(context.orgId);
    await registered();
    const { loadConversation } = await import("../server/desk/desk.server");
    const conv = await loadConversation(context.orgId, data.id);
    if (conv.kind !== "org_profile") throw new Error("Conversation not found.");
    const { handleOrgUserMessage } = await import("../server/desk/org-desk.server");
    await handleOrgUserMessage(conv, context.userId, data.message);
    return { ok: true as const };
  });

/** "Read the website now" from the thread. */
export const readWebsiteFromDesk = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await actorCtx(context);
    await registered();
    const { loadConversation, postMessage } = await import("../server/desk/desk.server");
    const conv = await loadConversation(context.orgId, data.id);
    if (conv.kind !== "org_profile") throw new Error("Conversation not found.");
    await postMessage(conv, { role: "user", body: "Read the website now" });
    const { startWebsiteRead } = await import("../server/desk/org-desk.server");
    await startWebsiteRead(conv, context.userId);
    return { ok: true as const };
  });

/** "Build the draft" — records, website, documents, then submit for approval. */
export const buildFromDesk = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await actorCtx(context);
    await registered();
    const { loadConversation, postMessage } = await import("../server/desk/desk.server");
    const conv = await loadConversation(context.orgId, data.id);
    if (conv.kind !== "org_profile") throw new Error("Conversation not found.");
    await postMessage(conv, { role: "user", body: "Build the draft now" });
    const { startBuild } = await import("../server/desk/org-desk.server");
    await startBuild(conv, context.userId);
    return { ok: true as const };
  });
