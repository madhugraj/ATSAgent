/**
 * The organisation desk (docs/org-context-agent-plan.md, O1): a chat thread
 * with the Organisation context agent, like the hiring desk. The admin
 * describes the organisation; the agent asks for the sections still missing,
 * can be sent to the website or the documents with a button, and submits the
 * draft for the HR head's approval — a decision it never makes itself.
 *
 * Threads share the hiring-desk tables with `kind = 'org_profile'`; the two
 * kinds never mix. Only the HR head, the CBO or the owner use this desk (the
 * same people who edit the profile).
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db";
import { hiringConversations, hiringMessages } from "@db/schema";
import { INJECTION_RULES, aiJson, untrusted } from "@/lib/ai-gateway.server";
import { log } from "../log";
import { loadConversation, postMessage } from "./desk.server";
import { PROFILE_SECTIONS } from "@/lib/org-profile";

type Conversation = typeof hiringConversations.$inferSelect;

/** How far the conversation has got, per profile section. */
const OrgSlots = z.object(
  Object.fromEntries(
    PROFILE_SECTIONS.map((s) => [
      s.key,
      z
        .object({
          done: z.boolean(),
          /** What the admin still wants captured for this section. */
          notes: z.string().max(2000).optional(),
        })
        .optional(),
    ]),
  ),
);
export type OrgSlots = z.infer<typeof OrgSlots>;

const TurnOutput = z.object({
  slots: OrgSlots,
  reply: z.string().max(600).default(""),
  /** The person asked for the website to be read (a button does the same). */
  readWebsite: z.boolean().default(false),
  /** The person gave the organisation's website address — the system saves it. */
  saveWebsite: z.string().max(400).optional(),
});
export type OrgTurn = z.infer<typeof TurnOutput>;

const SECTION_ORDER = PROFILE_SECTIONS.map((s) => s.key);
const SECTION_TITLES = new Map(PROFILE_SECTIONS.map((s) => [s.key, s.title]));

export function missingSections(s: OrgSlots): string[] {
  return SECTION_ORDER.filter((k) => !s[k]?.done);
}

const SYSTEM = [
  INJECTION_RULES,
  "",
  "You are the organisation desk of an applicant tracking system. An HR head (or the CBO or owner) describes their organisation so its profile can be written — what it does, its products and projects, its tech stacks, its customers, domain and regulators, locations, structure, culture, hiring norms, policies, tone of voice, and what must never be said to candidates.",
  "This profile is the context every other agent works from: the JD agent writes “About us” from it, the requisition agent drafts from it, and candidate matching weighs it. Facts must be exact and quotable.",
  "Each turn, return JSON with:",
  '- "slots": which sections are settled ("done": true) from the conversation so far, and any "notes" still to capture for a section. Mark a section done only when the person gave you something real for it. Never invent facts to fill a section.',
  '- "reply": one short, friendly message. Ask about the FIRST section in MISSING (below) that is not done, in one sentence — show the section title and what belongs in it, and build on what the person already said. When everything is done, say you will build the draft and what you will read (the website, the documents).',
  '- "readWebsite": true when the person asks you to read the website (or answers yes to that offer).',
  '- "saveWebsite": when the person gives the organisation\'s website address (a domain like "www.acme.com", with or without https://), return it here exactly as a full address — the system saves it and tells them. Never invent or guess a website.',
  "The organisation profile never holds pay figures or pay bands, and never staff names, e-mails or phone numbers — if the person gives any, say you keep the philosophy in words and roles by title, not the figures or names.",
].join("\n");

async function orgDeskFacts(orgId: string) {
  const { readOrgRecords } = await import("@/lib/org-context.server");
  const [records, profileState] = await Promise.all([
    readOrgRecords(orgId),
    (async () => {
      const { profileState } = await import("@/lib/org-profile.server");
      return profileState(orgId);
    })(),
  ]);
  return [
    `ORGANISATION RECORD: ${JSON.stringify(records.organisation)}`,
    `WEBSITE SAVED: ${records.website ?? "no"}`,
    `DOCUMENTS UPLOADED: ${records.documents.map((d) => d.fileName).join(", ") || "none"}`,
    `PROFILE: ${
      profileState.approved
        ? `approved version ${profileState.approved.version}`
        : profileState.open
          ? `draft version ${profileState.open.version} (${profileState.open.status})`
          : "none yet"
    }`,
  ].join("\n");
}

export async function runOrgTurn(
  orgId: string,
  conv: Conversation,
  history: { role: string; body: string }[],
): Promise<{ ok: true; turn: OrgTurn } | { ok: false; message: string }> {
  const slots = (conv.slots ?? {}) as OrgSlots;
  const missing = missingSections(slots);
  const prompt = [
    `KNOWN (sections done so far): ${JSON.stringify(slots)}`,
    `MISSING (ask about these, in this order): ${
      missing.length ? missing.map((k) => SECTION_TITLES.get(k) ?? k).join(" → ") : "none"
    }`,
    `WHAT THE SYSTEM ALREADY KNOWS:\n${await orgDeskFacts(orgId)}`,
    "CONVERSATION (oldest first):",
    untrusted(
      "admin_message",
      history
        .slice(-12)
        .map((m) => `${m.role === "user" ? "Admin" : "Desk"}: ${m.body}`)
        .join("\n"),
    ),
  ].join("\n");
  const res = await aiJson({
    system: SYSTEM,
    prompt,
    orgId,
    feature: "org_desk",
    schema: TurnOutput,
  });
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, turn: res.data };
}

/** One user turn: echo it, think, persist what settled, reply, act on the website ask. */
export async function handleOrgUserMessage(
  conv: Conversation,
  userId: string,
  text: string,
): Promise<void> {
  await postMessage(conv, { role: "user", body: text });
  const history = await db
    .select({ role: hiringMessages.role, body: hiringMessages.body })
    .from(hiringMessages)
    .where(eq(hiringMessages.conversationId, conv.id))
    .orderBy(asc(hiringMessages.createdAt));
  const res = await runOrgTurn(conv.orgId, conv, history);
  if (!res.ok) {
    log.warn("org_desk.turn_failed", { org_id: conv.orgId, error: res.message });
    await postMessage(conv, {
      role: "desk",
      body: /key/i.test(res.message)
        ? "I can't reach the AI model — add your organisation's AI key on the Integrations page."
        : "I couldn't process that just now. Please try again in a moment.",
    });
    return;
  }
  const { turn } = res;
  const before = (conv.slots ?? {}) as OrgSlots;
  const slots: OrgSlots = { ...before };
  for (const [k, v] of Object.entries(turn.slots)) {
    if (!v) continue;
    slots[k as keyof OrgSlots] = v;
  }
  await db
    .update(hiringConversations)
    .set({ slots: slots as never, updatedAt: new Date() })
    .where(eq(hiringConversations.id, conv.id));
  conv = { ...conv, slots: slots as never };

  if (turn.saveWebsite) await saveWebsiteFromChat(conv, userId, turn.saveWebsite);
  if (turn.readWebsite) await startWebsiteRead(conv, userId);
  if (turn.reply.trim()) await postMessage(conv, { role: "desk", body: turn.reply.trim() });
  if (missingSections(slots).length === 0) {
    await startBuild(conv, userId);
  }
}

/** "www.acme.com" said in the chat: normalise, save (owner rules apply), confirm. */
async function saveWebsiteFromChat(
  conv: Conversation,
  userId: string,
  said: string,
): Promise<void> {
  const trimmed = said.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const { setWebsiteCore } = await import("@/lib/org-context.server");
  let res;
  try {
    res = await setWebsiteCore({ orgId: conv.orgId, userId }, { url: withScheme });
  } catch (e) {
    await postMessage(conv, {
      role: "desk",
      body: e instanceof Error ? e.message : "That address could not be saved.",
    });
    return;
  }
  if (res.ok) {
    await postMessage(conv, {
      role: "desk",
      body: `Saved ${res.url} as your website (under Sources above). Press “Read the website” and I'll read it into your profile.`,
    });
    return;
  }
  await postMessage(conv, {
    role: "desk",
    body: `${withScheme} is outside your registered e-mail domain, so only an owner can confirm it — an owner can press Save under Sources above, or confirm it there.`,
  });
}

/** "Read the website now" — starts the agent on a read inside this thread. */
export async function startWebsiteRead(conv: Conversation, userId: string): Promise<void> {
  const { orgProfiles } = await import("@db/schema");
  const [p] = await db
    .select({ websiteUrl: orgProfiles.websiteUrl })
    .from(orgProfiles)
    .where(eq(orgProfiles.orgId, conv.orgId))
    .limit(1);
  if (!p?.websiteUrl) {
    await postMessage(conv, {
      role: "desk",
      body: "No website is saved yet — paste the address here in the chat (like https://www.acme.com), or type it under Sources above, and I'll read it.",
    });
    return;
  }
  await startOrgAgentRun(
    conv,
    userId,
    "Re-read the organisation's website and propose what it states as profile items, quoting each page exactly. Submit the version when the draft holds what you found.",
  );
}

/** The full build: records → website → documents → draft → approval. */
export async function startBuild(conv: Conversation, userId: string): Promise<void> {
  await startOrgAgentRun(
    conv,
    userId,
    "Build the organisation's profile: read the organisation's records, its website and every uploaded document, propose what you find as profile items with their exact quotes, then submit the version for approval.",
  );
}

async function startOrgAgentRun(conv: Conversation, userId: string, goal: string): Promise<void> {
  const { loadPolicy } = await import("../agents/policy");
  if (!(await loadPolicy(conv.orgId, "org_context")).enabled) {
    await postMessage(conv, {
      role: "desk",
      body: "The Organisation context agent is switched off — switch it on in Governance → Agent settings and try again.",
    });
    return;
  }
  const { startRun } = await import("../agents/runtime.server");
  await startRun({
    orgId: conv.orgId,
    agentType: "org_context",
    principalUserId: userId,
    goal,
    subjectType: "org_profile",
    conversationId: conv.id,
  });
  await postMessage(conv, {
    role: "desk",
    body: "The Organisation context agent is on it — its results and its request for approval will appear in this thread.",
    agentType: "org_context",
  });
  const { kickAgents } = await import("../agents/orchestrator.server");
  kickAgents(conv.orgId);
}

/** The organisation-desk thread for this org, creating it when absent. */
export async function ensureOrgThread(orgId: string, userId: string): Promise<Conversation> {
  const existing = await db
    .select()
    .from(hiringConversations)
    .where(and(eq(hiringConversations.orgId, orgId), eq(hiringConversations.kind, "org_profile")))
    .limit(1);
  if (existing[0]) return existing[0];
  const [conv] = await db
    .insert(hiringConversations)
    .values({
      orgId,
      createdBy: userId,
      kind: "org_profile",
      title: "Organisation profile",
    })
    .returning();
  await postMessage(conv!, {
    role: "desk",
    body: "Tell me about your organisation — what it does, what it makes, its tech stacks and projects, who it serves. I'll ask section by section; the profile this builds is what every hiring agent here works from. You can also paste your website address here (I'll save and read it), upload documents under Sources above, or press Build the draft to have me read everything on file and propose the profile for approval.",
  });
  return conv!;
}
