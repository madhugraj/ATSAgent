/**
 * Organisation desk server functions (docs/org-context-agent-plan.md, O1).
 * The HR head, the CBO and the owner only — the same people who edit the
 * profile. There is one thread per organisation (kind = 'org_profile'); it
 * never appears in the hiring desk and hiring threads never appear here.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { PROFILE_SECTIONS } from "./org-profile";

import { db } from "../server/db";
import { agentTasks, hiringConversations, hiringMessages } from "@db/schema";
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

export type OrgDeskActivityView = {
  runId: string;
  /** queued | running | awaiting_human | done | failed | cancelled */
  status: string;
  goal: string;
  result: string | null;
  error: string | null;
  updatedAt: string;
  /** The latest step, in plain words (never its content). */
  lastStep: { text: string; at: string } | null;
};

export type OrgDeskThreadView = {
  id: string;
  title: string;
  status: string;
  messages: OrgDeskMessageView[];
  /** Status of every agent request shown in the thread. */
  tasks: Record<string, string>;
  /** What the person answered to each question (shown under it). */
  answers: Record<string, string>;
  /** Whether the viewer may decide each request, and who it waits for otherwise. */
  deciders: Record<string, { canDecide: boolean; waitingFor: string | null }>;
  /** What the agent is doing right now (its latest run in this thread). */
  activity: OrgDeskActivityView | null;
};

const sectionTitle = (key: string | undefined) => {
  const found = PROFILE_SECTIONS.find((x) => x.key === key);
  return found ? `“${found.title}”` : "the draft";
};

/**
 * While a run is working, what it is doing NOW: a step is recorded only once
 * it finishes, so the last finished step names the one in progress by the
 * agent's fixed order (records → website → sources → writing → approval).
 * Showing the finished one read as "stuck on the records" during a website
 * read that takes a minute.
 */
const NOW_AFTER: Record<string, string> = {
  read_org_profile: "reading your organisation's records",
  read_org_records: "reading your website",
  read_org_website: "reading what your website, documents and answers say",
  read_org_sources: "writing the draft",
  read_org_document: "writing the draft",
  submit_profile_version: "asking for approval",
};

/** Tool names in words people can read (ids and flags stay out). */
const STEP_WORDS: Record<string, string> = {
  read_org_profile: "reading the profile as it stands",
  read_org_records: "reading your organisation's records",
  read_org_website: "reading your website",
  read_org_sources: "reading what your website, documents and answers say",
  read_org_document: "reading an uploaded document",
  propose_profile_items: "writing the draft",
  submit_profile_version: "submitting the draft for approval",
  ask_human: "asking you a question",
  request_approval: "asking for approval",
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
    // The agent's latest run in this thread, with its newest step in plain words.
    const { agentRuns, agentSteps } = await import("@db/schema");
    const [run] = await db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        goal: agentRuns.goal,
        result: agentRuns.result,
        lastError: agentRuns.lastError,
        updatedAt: agentRuns.updatedAt,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, context.orgId),
          eq(agentRuns.conversationId, conv.id),
          eq(agentRuns.agentType, "org_context"),
          eq(agentRuns.mode, "live"),
        ),
      )
      .orderBy(desc(agentRuns.updatedAt))
      .limit(1);
    let activity: OrgDeskActivityView | null = null;
    if (run) {
      const [step] = await db
        .select({
          kind: agentSteps.kind,
          toolName: agentSteps.toolName,
          status: agentSteps.status,
          input: agentSteps.input,
          createdAt: agentSteps.createdAt,
        })
        .from(agentSteps)
        // The latest thing it DID (a model turn between tools reads as
        // "thinking" most of the time and says nothing).
        .where(and(eq(agentSteps.runId, run.id), inArray(agentSteps.kind, ["tool", "decision"])))
        .orderBy(desc(agentSteps.seq))
        .limit(1);
      activity = {
        runId: run.id,
        status: run.status,
        goal: run.goal,
        result: run.result,
        error: run.lastError,
        updatedAt: run.updatedAt.toISOString(),
        lastStep: step
          ? {
              text:
                run.status === "running" &&
                step.kind === "tool" &&
                step.toolName &&
                NOW_AFTER[step.toolName]
                  ? NOW_AFTER[step.toolName]!
                  : step.kind === "tool" && step.toolName === "propose_profile_items"
                    ? `writing ${sectionTitle((step.input as { section?: string } | null)?.section)}`
                    : step.kind === "tool" && step.toolName
                      ? (STEP_WORDS[step.toolName] ?? "working")
                      : step.kind === "model"
                        ? "thinking"
                        : step.kind === "decision"
                          ? "a person decided"
                          : "working",
              at: step.createdAt.toISOString(),
            }
          : null,
      };
    }
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
      answers: await taskAnswersFor(context.orgId, taskIds),
      deciders,
      activity,
    };
  });

async function taskAnswersFor(orgId: string, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const rows = await db
    .select({ id: agentTasks.id, response: agentTasks.response })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.orgId, orgId),
        inArray(agentTasks.id, ids),
        eq(agentTasks.status, "answered"),
      ),
    );
  return Object.fromEntries(
    rows.flatMap((r) => {
      const a = (r.response as { answer?: unknown } | null)?.answer;
      return typeof a === "string" && a.trim() ? [[r.id, a]] : [];
    }),
  );
}

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

/** An owner confirms a website outside the registered e-mail domain, from its card. */
export const confirmWebsiteFromDesk = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), url: z.string().url().max(400) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await actorCtx(context);
    await registered();
    const { loadConversation } = await import("../server/desk/desk.server");
    const conv = await loadConversation(context.orgId, data.id);
    if (conv.kind !== "org_profile") throw new Error("Conversation not found.");
    const { confirmWebsiteFromChat } = await import("../server/desk/org-desk.server");
    await confirmWebsiteFromChat(conv, context.userId, data.url);
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

/** Run the thread's stopped agent run again (same goal, same person). */
export const retryOrgDeskRun = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), runId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await actorCtx(context);
    await registered();
    const { loadConversation } = await import("../server/desk/desk.server");
    const conv = await loadConversation(context.orgId, data.id);
    if (conv.kind !== "org_profile") throw new Error("Conversation not found.");
    const { retryRun } = await import("../server/desk/desk.server");
    return { runId: await retryRun(conv, context.userId, data.runId) };
  });

/**
 * Clear the chat: stop the agent's open runs (their waiting questions go
 * with them), hide the thread, and start a fresh one with the greeting.
 * The old thread stays restorable for 30 days, as hiring threads do.
 */
export const clearOrgDeskChat = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await actorCtx(context);
    await registered();
    const { loadConversation } = await import("../server/desk/desk.server");
    const conv = await loadConversation(context.orgId, data.id);
    if (conv.kind !== "org_profile") throw new Error("Conversation not found.");
    const { agentRuns } = await import("@db/schema");
    const open = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, context.orgId),
          eq(agentRuns.conversationId, conv.id),
          eq(agentRuns.agentType, "org_context"),
          inArray(agentRuns.status, ["queued", "running", "awaiting_human"]),
        ),
      );
    const { cancelRun } = await import("../server/agents/runtime.server");
    for (const r of open)
      await cancelRun({ orgId: context.orgId, runId: r.id, userId: context.userId });
    await db
      .update(hiringConversations)
      .set({ deletedAt: new Date(), deletedBy: context.userId, updatedAt: new Date() })
      .where(
        and(eq(hiringConversations.id, conv.id), eq(hiringConversations.orgId, context.orgId)),
      );
    const { ensureOrgThread } = await import("../server/desk/org-desk.server");
    const fresh = await ensureOrgThread(context.orgId, context.userId);
    return { id: fresh.id };
  });
