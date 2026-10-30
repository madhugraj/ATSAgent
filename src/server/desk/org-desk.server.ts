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
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db";
import { hiringConversations, hiringMessages } from "@db/schema";
import { INJECTION_RULES, aiJson, untrusted } from "@/lib/ai-gateway.server";
import { log } from "../log";
import { loadConversation, postMessage } from "./desk.server";
import { PROFILE_SECTIONS } from "@/lib/org-profile";

type Conversation = typeof hiringConversations.$inferSelect;

const SECTION_KEYS = PROFILE_SECTIONS.map((s) => s.key) as [string, ...string[]];
const SECTION_TITLES = new Map(PROFILE_SECTIONS.map((s) => [s.key, s.title]));

/**
 * A fact the admin stated in the latest message, as a profile item. The chat
 * used to track only which sections were "done" — what the admin actually
 * said never reached the profile (the build read the website and documents,
 * not the chat). Now each stated fact joins the draft at once, through the
 * same checks as the Profile page (pay figures and staff names refused).
 */
const StatedFact = z.object({
  section: z.enum(SECTION_KEYS),
  text: z.string().min(3).max(600),
  visibility: z.enum(["candidate", "internal"]).default("candidate"),
});

const TurnOutput = z.object({
  facts: z.array(StatedFact).max(12).default([]),
  reply: z.string().max(600).default(""),
  /** The person asked for the website to be read (a button does the same). */
  readWebsite: z.boolean().default(false),
  /** The person asked for the draft to be built from everything on file. */
  build: z.boolean().default(false),
  /** The person gave the organisation's website address — the system saves it. */
  saveWebsite: z.string().max(400).optional(),
});
export type OrgTurn = z.infer<typeof TurnOutput>;

/** How many items each section holds now — the open draft, else the approved version. */
export async function sectionCoverage(orgId: string): Promise<Record<string, number>> {
  const { profileState } = await import("@/lib/org-profile.server");
  const state = await profileState(orgId);
  const v = state.open ?? state.approved;
  return Object.fromEntries(
    PROFILE_SECTIONS.map((s) => [s.key, (v?.sections?.[s.key] ?? []).length]),
  );
}

/** Sections to ask about next: empty ones first, then thin ones, in profile order. */
export function sectionsToAsk(coverage: Record<string, number>): string[] {
  const keys = PROFILE_SECTIONS.map((s) => s.key);
  return [
    ...keys.filter((k) => (coverage[k] ?? 0) === 0),
    ...keys.filter((k) => (coverage[k] ?? 0) > 0 && (coverage[k] ?? 0) < 3),
  ];
}

const SYSTEM = [
  INJECTION_RULES,
  "",
  "You are the organisation desk of an applicant tracking system. An HR head (or the CBO or owner) describes their organisation so its profile can be written — what it does, its products and projects, its tech stacks, its customers, domain and regulators, locations, structure, culture, hiring norms, policies, tone of voice, and what must never be said to candidates.",
  "This profile is the context every other agent works from: the JD agent writes “About us” from it, the requisition agent drafts from it, and candidate matching weighs it. Facts must be exact.",
  "Each turn, return JSON with:",
  '- "facts": every concrete fact the LATEST admin message states about the organisation, one per item: {"section": one of the section keys, "text": the fact in plain words, faithful to what they said, "visibility": "candidate" when it may be said to candidates, "internal" for internal structure, policies, never-say rules and anything they call internal}. Only what they said — never invent, never restate what COVERAGE says is already there. Empty when the message states no fact (a question, "ok", a request).',
  '- "reply": one short, friendly message. If facts were captured, do NOT list them (the system confirms them) — go straight to the next question. Ask about the FIRST section in ASK NEXT, in one sentence: name the section and give one example of what belongs there, building on what they said. When ASK NEXT is empty, say the profile looks well covered and they can press Build the draft (or say "build it").',
  '- "readWebsite": true when the person asks you to read the website (or answers yes to that offer).',
  '- "build": true when the person asks you to build / write / draft the profile now ("build it", "go ahead and draft it").',
  '- "saveWebsite": when the person gives the organisation\'s website address (a domain like "www.acme.com", with or without https://), return it here exactly as a full address — the system saves it and tells them. Never invent or guess a website.',
  "The organisation profile never holds pay figures or pay bands, and never staff names, e-mails or phone numbers — if the person gives any, leave them out of facts and say you keep the philosophy in words and roles by title, not the figures or names.",
  `Section keys: ${PROFILE_SECTIONS.map((s) => `${s.key} (${s.title})`).join(", ")}.`,
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
    `WEBSITE SAVED: ${records.website ?? "no"} (${records.websitePages.length} pages read)`,
    `DOCUMENTS UPLOADED: ${records.documents.map((d) => d.fileName).join(", ") || "none"}`,
    `PROFILE: ${
      profileState.open
        ? `draft version ${profileState.open.version} (${profileState.open.status})`
        : profileState.approved
          ? `approved version ${profileState.approved.version}`
          : "none yet"
    }`,
  ].join("\n");
}

export async function runOrgTurn(
  orgId: string,
  history: { role: string; body: string }[],
): Promise<{ ok: true; turn: OrgTurn } | { ok: false; message: string }> {
  const coverage = await sectionCoverage(orgId);
  const ask = sectionsToAsk(coverage);
  const prompt = [
    `COVERAGE (items per section now): ${PROFILE_SECTIONS.map((s) => `${s.title}: ${coverage[s.key] ?? 0}`).join(" · ")}`,
    `ASK NEXT (empty first, then thin): ${
      ask.length ? ask.map((k) => SECTION_TITLES.get(k) ?? k).join(" → ") : "none"
    }`,
    `WHAT THE SYSTEM ALREADY KNOWS:\n${await orgDeskFacts(orgId)}`,
    "CONVERSATION (oldest first; the last Admin line is the LATEST message):",
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

/** Facts the admin stated: into the draft now, with what was kept and refused said plainly. */
async function addStatedFacts(
  conv: Conversation,
  userId: string,
  facts: OrgTurn["facts"],
): Promise<string> {
  if (!facts.length) return "";
  const { proposeItemsCore } = await import("@/lib/org-context.server");
  const bySection = new Map<string, OrgTurn["facts"]>();
  for (const f of facts) bySection.set(f.section, [...(bySection.get(f.section) ?? []), f]);
  const added: string[] = [];
  const refused: string[] = [];
  for (const [section, items] of bySection) {
    try {
      const res = await proposeItemsCore(
        { orgId: conv.orgId, userId },
        { section, items: items.map((i) => ({ text: i.text, visibility: i.visibility })) },
      );
      if (res.kept) added.push(`${SECTION_TITLES.get(section) ?? section} (${res.kept})`);
      for (const r of res.refused) refused.push(r.reason);
    } catch (e) {
      refused.push(e instanceof Error ? e.message : "could not be added");
    }
  }
  return [
    added.length ? `Added to the draft: ${added.join(", ")}.` : "",
    refused.length ? `Not kept: ${[...new Set(refused)].join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** One user turn: echo it, think, add what they stated to the draft, reply, act on asks. */
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
  const res = await runOrgTurn(conv.orgId, history);
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
  const captured = await addStatedFacts(conv, userId, turn.facts);
  await db
    .update(hiringConversations)
    .set({ updatedAt: new Date() })
    .where(eq(hiringConversations.id, conv.id));

  if (turn.saveWebsite) await saveWebsiteFromChat(conv, userId, turn.saveWebsite);
  const reply = [captured, turn.reply.trim()].filter(Boolean).join(" ");
  if (reply) await postMessage(conv, { role: "desk", body: reply });
  if (turn.build) await startBuild(conv, userId);
  else if (turn.readWebsite) await startWebsiteRead(conv, userId);
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
    "Re-read the organisation's website, then read_org_sources and propose what the pages state that the profile lacks, quoting each page exactly. Submit the version when the draft holds what you found.",
  );
}

/** The full build: records → website → documents → draft → approval. */
export async function startBuild(conv: Conversation, userId: string): Promise<void> {
  await startOrgAgentRun(
    conv,
    userId,
    "Build the organisation's profile: read the organisation's records, its website, every uploaded document and what the admin said in the chat (read_org_sources), write what you find as profile items with their exact quotes across every section the sources speak to, then submit the version for approval.",
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
    .where(
      and(
        eq(hiringConversations.orgId, orgId),
        eq(hiringConversations.kind, "org_profile"),
        // A cleared thread stays restorable but is never reused: clearing
        // must hand back a fresh conversation.
        isNull(hiringConversations.deletedAt),
      ),
    )
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
