/**
 * Hiring desk (docs/agentic-plan.md §13.2, Phase 6a): one chat thread per
 * hiring need.
 *
 * A TA member describes the need in plain words; the desk fills a fixed set
 * of details (slots) one short question at a time, shows similar roles, and
 * — once the person chooses — creates the draft requisition as that person
 * or reuses an existing role, then hands the work to the specialist agents.
 * Every agent run working for the thread posts its results, its requests for
 * a person, and the ranked candidate list back into the thread.
 *
 * The model only extracts details and words the next question; what happens
 * next (which agent, which records) is decided here in plain code.
 */
import { and, asc, desc, eq, ilike, inArray, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { INJECTION_RULES, aiJson, untrusted } from "@/lib/ai-gateway.server";
import { db } from "../db";
import { writeAudit } from "../audit";
import { log } from "../log";
import { getTool } from "../agents/registry";
import {
  agentRuns,
  agentTasks,
  applications,
  candidates,
  hiringConversations,
  hiringMessages,
  jobDescriptions,
  matchScores,
  requisitions,
  type AgentType,
} from "@db/schema";

/* ------------------------------------------------------------------ slots */

const skillList = z.array(z.string().trim().min(1).max(60)).max(20);

/** The hiring details the desk gathers. Budget is in lakhs per annum (LPA). */
export const DeskSlots = z.object({
  roleTitle: z.string().trim().min(2).max(120).optional(),
  location: z.string().trim().min(2).max(120).optional(),
  experienceMin: z.number().min(0).max(40).optional(),
  experienceMax: z.number().min(0).max(50).optional(),
  openings: z.number().int().min(1).max(100).optional(),
  mustHaveSkills: skillList.optional(),
  goodToHaveSkills: skillList.optional(),
  budgetLpaMax: z.number().min(0).max(1000).optional(),
  maxNoticeDays: z.number().int().min(0).max(365).optional(),
  employmentType: z.enum(["full_time", "contract", "internship"]).optional(),
  urgency: z.enum(["immediate", "within_a_month", "flexible"]).optional(),
  // For a deeper JD (asked once, after the required details):
  responsibilities: z.string().trim().max(3000).optional(),
  reportingTo: z.string().trim().max(200).optional(),
  successMeasures: z.string().trim().max(2000).optional(),
  education: z.string().trim().max(500).optional(),
  /** The person asked the JD to fill responsibilities / success from typical market practice. */
  researchRole: z.boolean().optional(),
  /** Set by the desk once the JD-detail question has been asked. */
  jdDetailsAsked: z.boolean().optional(),
});
export type DeskSlots = z.infer<typeof DeskSlots>;

/** Details without which no requisition is drafted, in the order they are asked. */
export const REQUIRED_SLOTS = [
  "roleTitle",
  "location",
  "experience",
  "openings",
  "mustHaveSkills",
] as const;
export type RequiredSlot = (typeof REQUIRED_SLOTS)[number];

const FALLBACK_QUESTION: Record<RequiredSlot, string> = {
  roleTitle: "Which role are you hiring for?",
  location: "Which location is this role based in?",
  experience: "How many years of experience should candidates have (for example 3–6)?",
  openings: "How many people do you need for this role?",
  mustHaveSkills: "Which skills are must-haves for this role?",
};

export function missingSlots(s: DeskSlots): RequiredSlot[] {
  return REQUIRED_SLOTS.filter((k) => {
    if (k === "experience") return s.experienceMin === undefined;
    if (k === "mustHaveSkills") return !s.mustHaveSkills?.length;
    return s[k] === undefined;
  });
}

/** Merge newly extracted details over the known ones; empty values never erase. */
export function mergeSlots(prev: DeskSlots, next: DeskSlots): DeskSlots {
  const out: DeskSlots = { ...prev };
  for (const [k, v] of Object.entries(next) as [keyof DeskSlots, unknown][]) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && !v.length) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  if (
    out.experienceMin !== undefined &&
    out.experienceMax !== undefined &&
    out.experienceMax < out.experienceMin
  ) {
    [out.experienceMin, out.experienceMax] = [out.experienceMax, out.experienceMin];
  }
  return out;
}

/** The JD-relevant details as the requisition's responsibilities text (the JD generator builds on it). */
export function jdBrief(s: DeskSlots): string | null {
  const parts = [
    s.responsibilities ? `Key responsibilities:\n${s.responsibilities}` : "",
    s.reportingTo ? `Reports to: ${s.reportingTo}` : "",
    s.successMeasures ? `Success after 12 months: ${s.successMeasures}` : "",
    s.researchRole && (!s.responsibilities || !s.successMeasures)
      ? `Draft the key responsibilities${s.successMeasures ? "" : " and the 6- and 12-month success measures"} from typical market practice for a ${s.roleTitle ?? "role"} at this seniority.`
      : "",
  ].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

export function describeNeed(s: DeskSlots): string {
  const exp =
    s.experienceMin === undefined
      ? ""
      : s.experienceMax !== undefined && s.experienceMax !== s.experienceMin
        ? `${s.experienceMin}–${s.experienceMax} years`
        : `${s.experienceMin}+ years`;
  return [
    `${s.openings ?? 1} × ${s.roleTitle ?? "role"}`,
    s.location ? `in ${s.location}` : "",
    exp ? `· ${exp}` : "",
    s.mustHaveSkills?.length ? `· must have ${s.mustHaveSkills.join(", ")}` : "",
    s.goodToHaveSkills?.length ? `· good to have ${s.goodToHaveSkills.join(", ")}` : "",
    s.budgetLpaMax !== undefined ? `· budget up to ${s.budgetLpaMax} LPA` : "",
    s.maxNoticeDays !== undefined ? `· notice up to ${s.maxNoticeDays} days` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/* --------------------------------------------------------------- threads */

type Conversation = typeof hiringConversations.$inferSelect;
export type DeskCard = Record<string, unknown> & { type: string };

export async function postMessage(
  conv: { id: string; orgId: string },
  m: { role: "user" | "desk" | "agent"; body: string; agentType?: string | null; card?: DeskCard },
): Promise<void> {
  await db.insert(hiringMessages).values({
    conversationId: conv.id,
    orgId: conv.orgId,
    role: m.role,
    agentType: m.agentType ?? null,
    body: m.body.slice(0, 4000),
    card: (m.card ?? null) as never,
  });
  await db
    .update(hiringConversations)
    .set({ updatedAt: new Date() })
    .where(eq(hiringConversations.id, conv.id));
}

export async function loadConversation(orgId: string, id: string): Promise<Conversation> {
  const [c] = await db
    .select()
    .from(hiringConversations)
    .where(and(eq(hiringConversations.id, id), eq(hiringConversations.orgId, orgId)))
    .limit(1);
  if (!c) throw new Error("Conversation not found.");
  return c;
}

/** The thread a requisition belongs to (newest first), if any. */
export async function conversationForRequisition(
  orgId: string,
  requisitionId: string,
): Promise<Conversation | null> {
  const [c] = await db
    .select()
    .from(hiringConversations)
    .where(
      and(
        eq(hiringConversations.orgId, orgId),
        eq(hiringConversations.requisitionId, requisitionId),
        notInArray(hiringConversations.status, ["closed"]),
      ),
    )
    .orderBy(desc(hiringConversations.createdAt))
    .limit(1);
  return c ?? null;
}

/** Thread for a run's subject: a requisition directly, an application through its requisition. */
export async function conversationForSubject(
  orgId: string,
  subjectType: string | null | undefined,
  subjectId: string | null | undefined,
): Promise<string | null> {
  if (!subjectId) return null;
  let requisitionId: string | null = null;
  if (subjectType === "requisition") requisitionId = subjectId;
  else if (subjectType === "application") {
    const [a] = await db
      .select({ requisitionId: applications.requisitionId })
      .from(applications)
      .where(and(eq(applications.id, subjectId), eq(applications.orgId, orgId)))
      .limit(1);
    requisitionId = a?.requisitionId ?? null;
  }
  if (!requisitionId) return null;
  return (await conversationForRequisition(orgId, requisitionId))?.id ?? null;
}

/* ---------------------------------------------------------- model turn */

const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("screen"),
    /** "the first 5" → top: 5; "candidates 1, 3 and 4" → ranks: [1,3,4]. */
    top: z.number().int().min(1).max(20).optional(),
    ranks: z.array(z.number().int().min(1).max(50)).max(20).optional(),
  }),
  z.object({ type: z.literal("new_role") }),
  z.object({ type: z.literal("use_existing"), code: z.string().max(40).optional() }),
  z.object({ type: z.literal("close_role") }),
  /** The person delegated details to market research ("as per market", "you decide"). */
  z.object({
    type: z.literal("research"),
    fields: z
      .array(z.enum(["skills", "experience", "budget"]))
      .max(3)
      .optional(),
  }),
  /** The person agreed to the latest proposal ("ok", "yes", "use these"). */
  z.object({ type: z.literal("accept") }),
  /** The person wants a pending agent request changed, or answers an agent's question. */
  z.object({ type: z.literal("feedback"), text: z.string().min(1).max(1000) }),
]);

const TurnOutput = z.object({
  slots: DeskSlots.default({}),
  command: Command.default({ type: "none" }),
  reply: z.string().max(600).default(""),
});
export type DeskTurn = z.infer<typeof TurnOutput>;

const SYSTEM = [
  INJECTION_RULES,
  "",
  "You are the hiring desk of an applicant tracking system. A recruiter describes a hiring need in a chat.",
  "Each turn, return JSON with:",
  '- "slots": only the hiring details the LATEST message states or changes (omit the rest). Fields: roleTitle, location, experienceMin, experienceMax (years), openings, mustHaveSkills, goodToHaveSkills (short skill names), budgetLpaMax (lakhs per annum), maxNoticeDays, employmentType (full_time|contract|internship), urgency (immediate|within_a_month|flexible). "a candidate" means openings 1. Expand obvious role shorthands (e.g. "Full stack" → "Full Stack Developer"). Never invent values that were not said.',
  '- JD details (only when the person gives them): responsibilities (their key responsibilities, as text), reportingTo, successMeasures (what success looks like), education. If they ask you to fill these from the market / research / "you decide", set researchRole true.',
  '- "command": {"type":"none"} unless the person asks to act: "talk to / screen / call the first 5" → {"type":"screen","top":5}; "screen 1, 3 and 4" → {"type":"screen","ranks":[1,3,4]}; "create a new role" → {"type":"new_role"}; "use REQ-2026-014" → {"type":"use_existing","code":"REQ-2026-014"}.',
  '- "command" also: "close / cancel / delete / withdraw this role" → {"type":"close_role"}.',
  '- When the person delegates a detail to you or to the market ("as per market needs", "you decide", "what does the market say?", "pick it up from research") → {"type":"research","fields":[...]} with the fields they delegated: "skills", "experience" and/or "budget". (JD details are not a research command — for those set researchRole true as above.) When OPEN PROPOSAL is yes and they agree ("ok", "yes", "use these", "go ahead") → {"type":"accept"}.',
  '- When OPEN REQUESTS lists a request and the person comments on it, objects to it or asks for a change ("give more weight to experience", "budget is too high", "use Pune instead") — or answers an agent\'s question — → {"type":"feedback","text":"<what they want, faithfully, in their words>"}. The system sends it to the agent, which revises and asks again.',
  '- The reply must never promise an action ("I\'ll benchmark…", "I\'ll check…"): the desk acts only through commands, and the system reports what it did. With a research command the reply can be empty.',
  '- "reply": one short, friendly message. If MISSING lists details, ask for the FIRST missing one only, in one sentence, offering a typical example. Otherwise acknowledge briefly. Never claim that anything was created, approved or sent.',
  "- Questions about the role, its status, the candidates or how to do something: answer ONLY from FACTS and APP RULES below. Never describe screens, menus, statuses or abilities that are not listed there; if the facts do not answer the question, say you do not know and where to look.",
].join("\n");

/** How the app really works — the only how-to the desk may describe. */
export const APP_RULES = [
  "Requisition statuses: draft → pending department head → pending HR head → pending CBO → approved; also rejected, on hold, closed. There is no 'archived' or 'open' status.",
  "Delete: only a draft with no applications, by the HR head, CBO or owner (Requisitions list → the requisition's menu). Everything else is rejected or closed so the trail is kept.",
  "Reject: while in the approval chain, by the approver of the current step (requisition page → Reject, with a reason).",
  "Close: an approved or on-hold requisition, by the HR head or CBO (requisition page → Close requisition, with a reason). Job-board postings come down with it.",
  "Reopen: a closed or rejected requisition cannot be reopened. Start a new hiring need; the new role can reuse the closed role's approved job description.",
  "On hold: the HR head or CBO can put a requisition on hold; from on hold it can be resubmitted or closed.",
  "In this chat the person can say 'close this role' to get a Close (or Delete for an unused draft) button.",
].join("\n");

export async function runTurn(
  orgId: string,
  conv: Conversation,
  history: { role: string; body: string }[],
): Promise<{ ok: true; turn: DeskTurn } | { ok: false; message: string }> {
  const slots = conv.slots as DeskSlots;
  const open = await latestProposal(conv);
  const requests = await openRequests(conv);
  const prompt = [
    `CURRENT DETAILS: ${JSON.stringify(slots)}`,
    `MISSING (ask in this order): ${missingSlots(slots).join(", ") || "none"}`,
    `STAGE: ${conv.status}`,
    `OPEN PROPOSAL: ${open ? `yes — ${JSON.stringify({ ...open.proposal, sources: undefined, reasoning: undefined })} (if the person asks for changes to it, put the changed full lists in "slots")` : "no"}`,
    `OPEN REQUESTS (from agents in this thread): ${
      requests.length
        ? requests
            .map(
              (r) => `"${r.title}" by the ${AGENT_TITLE[r.agentType] ?? r.agentType} (${r.kind})`,
            )
            .join("; ")
        : "none"
    }`,
    `FACTS (live from the system):\n${await deskFacts(conv)}`,
    `APP RULES:\n${APP_RULES}`,
    "CONVERSATION (oldest first):",
    untrusted(
      "conversation",
      history
        .slice(-12)
        .map((m) => `${m.role === "user" ? "Recruiter" : "Desk"}: ${m.body}`)
        .join("\n"),
    ),
  ].join("\n");
  const res = await aiJson({
    system: SYSTEM,
    prompt,
    orgId,
    feature: "hiring_desk",
    schema: TurnOutput,
  });
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, turn: res.data };
}

/* ------------------------------------------------------------ similar roles */

export type SimilarRole = {
  requisitionId: string;
  code: string;
  title: string;
  location: string;
  status: string;
  openings: number;
  jdApproved: boolean;
  /** An open role the person can continue with. */
  usable: boolean;
};

const OPEN = ["draft", "pending_dh", "pending_hr", "pending_cbo", "approved", "on_hold"];

export async function findSimilarRoles(orgId: string, s: DeskSlots): Promise<SimilarRole[]> {
  const words = (s.roleTitle ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}+#.-]/gu, ""))
    .filter((w) => w.length >= 3 && !/^(developer|engineer|senior|junior|lead)$/i.test(w))
    .slice(0, 4);
  if (!words.length) return [];
  const rows = await db
    .select({
      id: requisitions.id,
      code: requisitions.code,
      title: requisitions.title,
      location: requisitions.location,
      status: requisitions.status,
      openings: requisitions.openings,
      jdApproved: sql<boolean>`exists (
        select 1 from ${jobDescriptions} j
        where j.requisition_id = ${requisitions.id} and j.org_id = ${orgId} and j.status = 'approved')`,
    })
    .from(requisitions)
    .where(
      and(
        eq(requisitions.orgId, orgId),
        or(...words.map((w) => ilike(requisitions.title, `%${w}%`))),
        notInArray(requisitions.status, ["rejected"]),
      ),
    )
    .orderBy(desc(requisitions.createdAt))
    .limit(12);
  const loc = (s.location ?? "").toLowerCase();
  return rows
    .map((r) => ({
      requisitionId: r.id,
      code: r.code,
      title: r.title,
      location: r.location ?? "",
      status: r.status,
      openings: r.openings,
      jdApproved: Boolean(r.jdApproved),
      usable: OPEN.includes(r.status),
    }))
    .filter((r) => r.usable || r.jdApproved)
    .sort(
      (a, b) =>
        Number(b.location.toLowerCase().includes(loc)) -
          Number(a.location.toLowerCase().includes(loc)) || Number(b.usable) - Number(a.usable),
    )
    .slice(0, 5);
}

/* ---------------------------------------------------------------- actions */

async function agentOn(orgId: string, type: AgentType): Promise<boolean> {
  const { loadPolicy } = await import("../agents/policy");
  return (await loadPolicy(orgId, type)).enabled;
}

const AGENT_NAME: Record<string, string> = {
  publishing: "Publishing agent",
  requisition: "Requisition agent",
  jd: "JD agent",
  intake: "Intake & matching agent",
  screening: "Screening agent",
};

/** Start an agent for the thread, or tell the person why it cannot start. */
async function startForThread(
  conv: Conversation,
  agentType: AgentType,
  principalUserId: string,
  goal: string,
  requisitionId: string,
  announce: string,
): Promise<string | null> {
  if (!(await agentOn(conv.orgId, agentType))) {
    await postMessage(conv, {
      role: "desk",
      body: `The ${AGENT_NAME[agentType] ?? agentType} is switched off, so I can't continue automatically. Switch it on in Agent settings, or carry on from the requisition page.`,
    });
    return null;
  }
  const { startRun } = await import("../agents/runtime.server");
  const { runId } = await startRun({
    orgId: conv.orgId,
    agentType,
    principalUserId,
    goal: `${goal}\n\nRequisition id: ${requisitionId}`,
    subjectType: "requisition",
    subjectId: requisitionId,
    conversationId: conv.id,
  });
  await postMessage(conv, { role: "desk", body: announce, agentType });
  const { kickAgents } = await import("../agents/orchestrator.server");
  kickAgents(conv.orgId);
  return runId;
}

async function latestJdStatus(orgId: string, requisitionId: string) {
  const [jd] = await db
    .select({ status: jobDescriptions.status })
    .from(jobDescriptions)
    .where(and(eq(jobDescriptions.requisitionId, requisitionId), eq(jobDescriptions.orgId, orgId)))
    .orderBy(desc(jobDescriptions.version))
    .limit(1);
  return jd?.status ?? null;
}

export const INTAKE_GOAL = (code: string, title: string) =>
  `Find and rank candidates for ${code} "${title}": score any unscored applications, search the talent pool and add the strongest matches (up to 15) to the pipeline, score them, and finish with a short summary of the top candidates. Do not reject anyone.`;

/** Continue with an existing requisition. */
export async function continueWithRole(
  conv: Conversation,
  userId: string,
  requisitionId: string,
): Promise<void> {
  const [req] = await db
    .select()
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, conv.orgId)))
    .limit(1);
  if (!req) throw new Error("Requisition not found.");
  if (!OPEN.includes(req.status))
    throw new Error(`${req.code} is ${req.status} and cannot be reused.`);
  await db
    .update(hiringConversations)
    .set({ requisitionId: req.id, status: "active", title: `${req.title} · ${req.location}` })
    .where(eq(hiringConversations.id, conv.id));
  conv = { ...conv, requisitionId: req.id, status: "active" };
  await postMessage(conv, {
    role: "desk",
    body: `Continuing with ${req.code} "${req.title}" (${req.location}, ${req.status.replace(/_/g, " ")}).`,
  });

  if (req.status !== "approved") {
    await postMessage(conv, {
      role: "desk",
      body: `${req.code} is still waiting for approval (${req.status.replace(/_/g, " ")}). I'll carry on here once it is approved.`,
    });
    return;
  }
  const jd = await latestJdStatus(conv.orgId, req.id);
  if (jd === "approved") {
    await startForThread(
      conv,
      "intake",
      userId,
      INTAKE_GOAL(req.code, req.title),
      req.id,
      "The job description is already approved, so I've asked the Intake & matching agent to search the talent pool and rank the best matches. The ranked list will appear here.",
    );
  } else if (jd === "pending_dh") {
    await postMessage(conv, {
      role: "desk",
      body: "Its job description is waiting for the department head's approval. I'll search the talent pool as soon as it is approved.",
    });
  } else {
    await startForThread(
      conv,
      "jd",
      userId,
      `Requisition ${req.code} "${req.title}" is approved. Draft its job description and get it approved by the department head.`,
      req.id,
      "I've asked the JD agent to draft the job description; it will come back here for approval.",
    );
  }
}

/**
 * Create a new role from the gathered details, as the person (their own
 * action), optionally reusing an earlier role's approved JD, and hand the
 * draft to the Requisition agent to complete and submit for approval.
 */
export async function createNewRole(
  conv: Conversation,
  userId: string,
  opts: { reuseJdFrom?: string | null } = {},
): Promise<{ requisitionId: string; code: string }> {
  const s = conv.slots as DeskSlots;
  const missing = missingSlots(s);
  if (missing.length) throw new Error(`Still missing: ${missing.join(", ")}.`);
  if (conv.requisitionId) throw new Error("This conversation already has a requisition.");

  let reuse: { id: string; code: string } | null = null;
  if (opts.reuseJdFrom) {
    const [src] = await db
      .select({ id: requisitions.id, code: requisitions.code })
      .from(requisitions)
      .where(and(eq(requisitions.id, opts.reuseJdFrom), eq(requisitions.orgId, conv.orgId)))
      .limit(1);
    if (!src || (await latestApprovedJd(conv.orgId, src.id)) === null)
      throw new Error("That role has no approved job description to reuse.");
    reuse = src;
  }

  const { activeOrgOf } = await import("@/lib/auth.middleware");
  const org = await activeOrgOf(userId);
  if (!org || org.orgId !== conv.orgId)
    throw new Error("You are not a member of this organisation.");
  const { createRequisitionCore } = await import("@/lib/requisitions.server");
  const created = await createRequisitionCore(
    { orgId: conv.orgId, userId, memberEmail: org.memberEmail },
    {
      title: s.roleTitle!,
      departmentId: null,
      location: s.location!,
      openings: s.openings ?? 1,
      experienceMin: s.experienceMin ?? 0,
      experienceMax: s.experienceMax ?? s.experienceMin ?? 0,
      budgetCtc: s.budgetLpaMax ? s.budgetLpaMax * 100_000 : 0,
      ctcBandMin: null,
      ctcBandMax: null,
      maxNoticePeriodDays: s.maxNoticeDays ?? null,
      workAuthorizationRequired: null,
      hiringManager: null,
      mustHaveSkills: s.mustHaveSkills ?? [],
      goodToHaveSkills: s.goodToHaveSkills ?? [],
      responsibilities: jdBrief(s),
      educationRequirement: s.education ?? null,
      billingType: "Non-billable",
      engagementType: s.employmentType === "contract" ? "Contract" : "Internal / Corporate",
      clientName: null,
      costCenter: null,
    },
    "draft",
  );
  await db
    .update(hiringConversations)
    .set({
      requisitionId: created.id,
      reuseJdFrom: reuse?.id ?? null,
      status: "active",
      title: `${s.roleTitle} · ${s.location}`,
    })
    .where(eq(hiringConversations.id, conv.id));
  conv = { ...conv, requisitionId: created.id, reuseJdFrom: reuse?.id ?? null, status: "active" };
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId: conv.orgId,
    action: "desk.requisition_created",
    entityType: "requisition",
    entityId: created.id,
    detail: { conversation_id: conv.id, reuse_jd_from: reuse?.code ?? null },
  });
  await postMessage(conv, {
    role: "desk",
    body: `Created draft ${created.code} for ${describeNeed(s)}.${reuse ? ` Once it is approved, the approved job description of ${reuse.code} will be reused — no new JD approval needed.` : ""}`,
    card: { type: "requisition", requisitionId: created.id, code: created.code },
  });
  await startForThread(
    conv,
    "requisition",
    userId,
    [
      `Complete draft requisition ${created.code} "${s.roleTitle}" (${s.location}) raised from the hiring desk: ${describeNeed(s)}.`,
      "Find the department, research the market pay band for this role and location, set the scoring weights, then submit it for approval and prepare the approval brief.",
      reuse
        ? `Mention in the approval brief that the approved job description of ${reuse.code} will be reused for this role.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    created.id,
    "I've asked the Requisition agent to add the pay band and scoring weights and send it for approval. Approval requests will show up here.",
  );
  return { requisitionId: created.id, code: created.code };
}

async function latestApprovedJd(orgId: string, requisitionId: string) {
  const [jd] = await db
    .select()
    .from(jobDescriptions)
    .where(
      and(
        eq(jobDescriptions.requisitionId, requisitionId),
        eq(jobDescriptions.orgId, orgId),
        eq(jobDescriptions.status, "approved"),
      ),
    )
    .orderBy(desc(jobDescriptions.version))
    .limit(1);
  return jd ?? null;
}

/**
 * On approval of a requisition whose thread chose to reuse an earlier JD:
 * file that approved JD as this requisition's approved version (audited as
 * the person's choice) instead of drafting a new one. Returns true when done.
 */
export async function reuseJdIfChosen(orgId: string, requisitionId: string): Promise<boolean> {
  const conv = await conversationForRequisition(orgId, requisitionId);
  if (!conv?.reuseJdFrom) return false;
  if ((await latestApprovedJd(orgId, requisitionId)) !== null) return true;
  const src = await latestApprovedJd(orgId, conv.reuseJdFrom);
  if (!src) return false;
  const [latest] = await db
    .select({ version: jobDescriptions.version })
    .from(jobDescriptions)
    .where(and(eq(jobDescriptions.requisitionId, requisitionId), eq(jobDescriptions.orgId, orgId)))
    .orderBy(desc(jobDescriptions.version))
    .limit(1);
  const [row] = await db
    .insert(jobDescriptions)
    .values({
      requisitionId,
      orgId,
      version: (latest?.version ?? 0) + 1,
      status: "approved",
      purpose: src.purpose,
      responsibilities: src.responsibilities,
      mustHave: src.mustHave,
      goodToHave: src.goodToHave,
      qualifications: src.qualifications,
      successFactors: src.successFactors,
      reportingTo: src.reportingTo,
      fullText: src.fullText,
      templateId: src.templateId,
      templateName: src.templateName,
    })
    .returning({ id: jobDescriptions.id });
  const [srcReq] = await db
    .select({ code: requisitions.code })
    .from(requisitions)
    .where(eq(requisitions.id, conv.reuseJdFrom))
    .limit(1);
  await writeAudit({
    actor: `user:${conv.createdBy}`,
    actorUserId: conv.createdBy,
    orgId,
    action: "jd.reused",
    entityType: "job_description",
    entityId: row!.id,
    detail: {
      requisition_id: requisitionId,
      source_requisition: srcReq?.code ?? conv.reuseJdFrom,
      source_jd_id: src.id,
      chosen_in_conversation: conv.id,
    },
  });
  const { emitAgentEvent } = await import("../agents/events");
  await emitAgentEvent({
    orgId,
    type: "jd.approved",
    subjectType: "jd",
    subjectId: row!.id,
    actorUserId: conv.createdBy,
    payload: { requisitionId, reusedFrom: conv.reuseJdFrom },
  });
  await postMessage(conv, {
    role: "desk",
    body: `The requisition is approved and the approved job description of ${srcReq?.code ?? "the earlier role"} has been reused.`,
  });
  return true;
}

/** After a thread's JD is approved: rank candidates for it. */
export async function onJdApproved(orgId: string, requisitionId: string): Promise<void> {
  const conv = await conversationForRequisition(orgId, requisitionId);
  if (!conv) return;
  const [req] = await db
    .select({ code: requisitions.code, title: requisitions.title, status: requisitions.status })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!req || req.status !== "approved") return;
  const [active] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentType, "intake"),
        eq(agentRuns.subjectId, requisitionId),
        inArray(agentRuns.status, ["queued", "running", "awaiting_human"]),
      ),
    )
    .limit(1);
  if (active) return;
  await startForThread(
    conv,
    "intake",
    conv.createdBy,
    INTAKE_GOAL(req.code, req.title),
    requisitionId,
    "The job description is approved. I've asked the Intake & matching agent to search the talent pool and rank the best matches.",
  );
}

/* --------------------------------------------------------- ranked list */

export type RankedItem = {
  rank: number;
  applicationId: string;
  name: string;
  score: number | null;
  recommendation: string | null;
  stage: string;
  experienceYears: number;
  location: string | null;
  matched: string[];
  missing: string[];
  risks: number;
};

const CLOSED_STAGES = ["rejected", "withdrawn", "no_show", "offer_declined"];

export async function rankedCandidates(
  orgId: string,
  requisitionId: string,
  limit = 15,
): Promise<RankedItem[]> {
  const rows = await db
    .select({
      applicationId: applications.id,
      name: candidates.fullName,
      stage: applications.stage,
      experienceYears: candidates.experienceYears,
      location: candidates.location,
      score: matchScores.overallScore,
      recommendation: matchScores.recommendation,
      matched: matchScores.matchedSkills,
      missing: matchScores.missingSkills,
      riskFlags: matchScores.riskFlags,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .leftJoin(matchScores, eq(matchScores.applicationId, applications.id))
    .where(
      and(
        eq(applications.orgId, orgId),
        eq(applications.requisitionId, requisitionId),
        notInArray(applications.stage, CLOSED_STAGES as never),
      ),
    )
    .orderBy(desc(sql`coalesce(${matchScores.overallScore}, -1)`), asc(candidates.fullName))
    .limit(limit);
  return rows.map((r, i) => ({
    rank: i + 1,
    applicationId: r.applicationId,
    name: r.name,
    score: r.score ?? null,
    recommendation: r.recommendation ?? null,
    stage: r.stage,
    experienceYears: Number(r.experienceYears ?? 0),
    location: r.location,
    matched: (r.matched ?? []).slice(0, 4),
    missing: (r.missing ?? []).slice(0, 3),
    risks: (r.riskFlags ?? []).length,
  }));
}

export async function postRankedList(conv: Conversation): Promise<void> {
  if (!conv.requisitionId) return;
  const items = await rankedCandidates(conv.orgId, conv.requisitionId);
  if (items.length < 3) {
    // Too few to choose from: ask for candidates instead of stopping quietly.
    if (items.length)
      await postMessage(conv, {
        role: "agent",
        agentType: "intake",
        body: `Only ${items.length} candidate(s) so far, best first.`,
        card: { type: "ranked_candidates", requisitionId: conv.requisitionId, items },
      });
    await postMessage(conv, {
      role: "desk",
      body: items.length
        ? "That is too few to choose from. Let's bring more candidates in:"
        : "No matching candidates are in this role's pipeline or your talent pool yet. Let's bring candidates in:",
      card: { type: "bring_candidates", requisitionId: conv.requisitionId, found: items.length },
    });
    return;
  }
  await postMessage(conv, {
    role: "agent",
    agentType: "intake",
    body: `Here are the top ${items.length} matches, best first. Pick the ones to screen, or say for example "talk to the first 5".`,
    card: { type: "ranked_candidates", requisitionId: conv.requisitionId, items },
  });
}

/** Resolve "the first 5" / ranks against the latest ranked list in the thread. */
export async function resolveRanks(
  conv: Conversation,
  sel: { top?: number | undefined; ranks?: number[] | undefined },
): Promise<string[]> {
  const [m] = await db
    .select({ card: hiringMessages.card })
    .from(hiringMessages)
    .where(
      and(
        eq(hiringMessages.conversationId, conv.id),
        sql`${hiringMessages.card} ->> 'type' = 'ranked_candidates'`,
      ),
    )
    .orderBy(desc(hiringMessages.createdAt))
    .limit(1);
  const items = ((m?.card as { items?: RankedItem[] } | null)?.items ?? []) as RankedItem[];
  if (sel.ranks?.length)
    return items.filter((i) => sel.ranks!.includes(i.rank)).map((i) => i.applicationId);
  return items.slice(0, sel.top ?? 5).map((i) => i.applicationId);
}

/**
 * The person picked candidates to screen. Their pick is the decision; the
 * Screening agent prepares a kit per candidate (calls come with the voice
 * agent in Phase 6b) under its own autonomy rules.
 */
export async function screenCandidates(
  conv: Conversation,
  userId: string,
  applicationIds: string[],
): Promise<number> {
  if (!conv.requisitionId) throw new Error("Choose or create the role first.");
  const ids = [...new Set(applicationIds)].slice(0, 20);
  if (!ids.length) throw new Error("No candidates selected.");
  const rows = await db
    .select({ id: applications.id, name: candidates.fullName })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(
      and(
        eq(applications.orgId, conv.orgId),
        eq(applications.requisitionId, conv.requisitionId),
        inArray(applications.id, ids),
      ),
    );
  if (!rows.length) throw new Error("Those candidates are not in this role's pipeline.");
  // Keep the order the person chose (rank order for "the first N").
  rows.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
  const [req] = await db
    .select({ code: requisitions.code, title: requisitions.title })
    .from(requisitions)
    .where(eq(requisitions.id, conv.requisitionId))
    .limit(1);
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId: conv.orgId,
    action: "desk.candidates_selected",
    entityType: "requisition",
    entityId: conv.requisitionId,
    detail: { conversation_id: conv.id, applications: rows.map((r) => r.id) },
  });
  await startForThread(
    conv,
    "screening",
    userId,
    [
      `The recruiter chose these candidates for screening for ${req?.code} "${req?.title}":`,
      ...rows.map((r) => `- application ${r.id}`),
      "Shortlist any that are not shortlisted yet, prepare a screening kit for each, and summarise who should proceed. Automated screening calls are not connected yet, so say that the kits are ready for the call.",
    ].join("\n"),
    conv.requisitionId,
    `Screening ${rows.length} candidate(s): ${rows.map((r) => r.name).join(", ")}. The Screening agent is preparing their screening questions; calls will be placed by the voice agent once it is connected.`,
  );
  return rows.length;
}

/* ----------------------------------------------------------- the turn */

/** Handle one message from the person. */
export async function handleUserMessage(
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
  const res = await runTurn(conv.orgId, conv, history);
  if (!res.ok) {
    log.warn("desk.turn_failed", { org_id: conv.orgId, error: res.message });
    await postMessage(conv, {
      role: "desk",
      body: /key/i.test(res.message)
        ? "I can't reach the AI model — add your organisation's AI key on the Integrations page."
        : "I couldn't process that just now. Please try again in a moment.",
    });
    return;
  }
  const { turn } = res;
  const before = conv.slots as DeskSlots;
  const slots = mergeSlots(before, turn.slots);
  await db
    .update(hiringConversations)
    .set({
      slots: slots as never,
      ...(slots.roleTitle && !conv.requisitionId
        ? { title: `${slots.roleTitle}${slots.location ? ` · ${slots.location}` : ""}` }
        : {}),
    })
    .where(eq(hiringConversations.id, conv.id));
  conv = { ...conv, slots: slots as never };
  const understood = changedSlots(before, slots);
  // The person edited the proposed details themselves: the open proposal is superseded,
  // so a later "ok" cannot overwrite their edits with it.
  if (
    turn.command.type !== "accept" &&
    understood.some((u) => /skills|Experience|Budget/.test(u.label))
  )
    await supersedeProposal(conv);

  // Commands the person gave in words.
  const cmd = turn.command;
  if (conv.status === "closed" && cmd.type !== "none") {
    await postMessage(conv, {
      role: "desk",
      body: "This role is closed, so nothing more can be done on it here. Start a new hiring need to hire for it again — I can reuse this role's approved job description.",
    });
    return;
  }
  if (cmd.type === "screen") {
    if (!conv.requisitionId) {
      await postMessage(conv, {
        role: "desk",
        body: "Let's settle the role first, then I'll line up candidates.",
      });
      return;
    }
    const ids = await resolveRanks(conv, cmd);
    if (!ids.length) {
      await postMessage(conv, {
        role: "desk",
        body: "There is no ranked list yet — I'll post one as soon as the matching is done.",
      });
      return;
    }
    await screenCandidates(conv, userId, ids);
    return;
  }
  if (cmd.type === "close_role") {
    await offerCloseRole(conv);
    return;
  }
  if (cmd.type === "research") {
    await researchRole(conv, cmd.fields?.length ? cmd.fields : ["skills"], understood);
    return;
  }
  if (cmd.type === "feedback") {
    await sendFeedback(conv, userId, cmd.text, understood);
    return;
  }
  if (cmd.type === "accept" && (await latestProposal(conv))) {
    await applyProposal(conv);
    return;
  }
  if (conv.status === "confirming" && cmd.type === "new_role") {
    await createNewRole(conv, userId);
    return;
  }
  if (conv.status === "confirming" && cmd.type === "use_existing" && cmd.code) {
    const [r] = await db
      .select({ id: requisitions.id })
      .from(requisitions)
      .where(and(eq(requisitions.orgId, conv.orgId), eq(requisitions.code, cmd.code.toUpperCase())))
      .limit(1);
    if (r) {
      await continueWithRole(conv, userId, r.id);
      return;
    }
  }

  if (conv.status === "gathering") {
    await advanceGathering(conv, turn.reply, understood);
    return;
  }

  // No command: the desk only answered. While agents wait on the person, say
  // plainly that nothing was passed on, so a reply never reads as an action.
  const waiting = await openRequests(conv);
  await postMessage(conv, {
    role: "desk",
    body:
      turn.reply.trim() ||
      (conv.status === "confirming"
        ? "Choose one of the options above, or tell me what to change."
        : "Noted."),
    ...(waiting.length
      ? {
          card: {
            type: "reasoning",
            understood,
            missing: [],
            next: `Nothing was sent to the agents. To change "${waiting[0]!.title}", tell me what to change and I'll send it back to the ${AGENT_TITLE[waiting[0]!.agentType] ?? waiting[0]!.agentType}.`,
          },
        }
      : {}),
  });
}

/* ---------------------------------------------------- runtime hooks */

const SAFE_ERRORS = new Set([
  "The run reached its step or token budget.",
  "The worker stopped before finishing this step.",
  "No AI model key saved. Add one on the Integrations page.",
]);

/**
 * Why a run stopped, in plain words. Provider text never reaches the browser
 * (it can name the vendor); known runtime messages pass through.
 */
export function failureReason(error: string | null): string {
  if (error && SAFE_ERRORS.has(error)) return error;
  const e = error ?? "";
  if (/api[ _-]?key|unauthori[sz]ed|permission denied|\b40[13]\b/i.test(e))
    return "the AI model rejected the key. Check Integrations → AI model, then try again.";
  if (/quota|rate.?limit|resource.?exhausted|\b429\b|overloaded/i.test(e))
    return "the AI model is busy or out of quota. Try again in a few minutes.";
  if (/timeout|timed out|ECONN|network|fetch failed/i.test(e))
    return "the AI model could not be reached. Try again.";
  if (e)
    return "the AI model or one of its tools returned an error. Try again; if it repeats, export the run trail from Agent activity.";
  return "it could not complete this step. Try again.";
}

/** A run working for a thread finished: post its result (and the ranked list after matching). */
export async function onRunFinished(run: {
  id?: string;
  conversationId: string | null;
  orgId: string;
  agentType: string;
  mode?: string;
  status: "done" | "failed";
  result: string | null;
  error: string | null;
}): Promise<void> {
  if (!run.conversationId || run.mode === "replay") return;
  const conv = await loadConversation(run.orgId, run.conversationId).catch(() => null);
  if (!conv) return;
  const name = AGENT_NAME[run.agentType] ?? `${run.agentType} agent`;
  await postMessage(conv, {
    role: "agent",
    agentType: run.agentType,
    body:
      run.status === "done"
        ? (run.result ?? "Done.").slice(0, 1500)
        : `The ${name} stopped: ${failureReason(run.error)}`,
    ...(run.status === "failed" && run.id
      ? { card: { type: "run_failed", runId: run.id, agentType: run.agentType } }
      : {}),
  });
  if (run.status === "done" && run.agentType === "intake") await postRankedList(conv);
}

/** A run working for a thread needs a person: show the request in the thread. */
const ROLE_NAME: Record<string, string> = {
  recruiter: "Recruiter",
  hiring_manager: "Hiring manager",
  department_head: "Department head",
  hr_head: "HR head",
  president_cbo: "CBO",
};

/** Multi-step approval chains: which step a gate is, so repeated cards read as progress. */
const CHAIN_STEP: Record<string, Record<string, [number, number]>> = {
  requisition: { pending_dh: [1, 3], pending_hr: [2, 3], pending_cbo: [3, 3] },
  offer: { pending_hr: [1, 2], pending_cbo: [2, 2] },
};

/** "Approval 2 of 3 · HR head" for a chain step, "Decision · Hiring manager" otherwise. */
export function taskStep(task: {
  kind: string;
  assigneeRole?: string | null;
  proposedAction?: unknown;
}): string | null {
  if (task.kind !== "gate") return null;
  const subject = (
    task.proposedAction as { args?: { subject?: { type?: string; expects?: string } } } | null
  )?.args?.subject;
  const who = task.assigneeRole ? (ROLE_NAME[task.assigneeRole] ?? task.assigneeRole) : null;
  const step =
    subject?.type && subject.expects ? CHAIN_STEP[subject.type]?.[subject.expects] : undefined;
  if (step) return `Approval ${step[0]} of ${step[1]}${who ? ` · ${who}` : ""}`;
  return who ? `Decision · ${who}` : null;
}

export async function onTaskOpened(
  run: { conversationId: string | null; orgId: string; agentType: string },
  task: {
    id: string;
    kind: string;
    title: string;
    body: string;
    assigneeRole?: string | null;
    proposedAction?: unknown;
  },
): Promise<void> {
  if (!run.conversationId) return;
  const conv = await loadConversation(run.orgId, run.conversationId).catch(() => null);
  if (!conv) return;
  const step = taskStep(task);
  // The same brief again for the next approver: show it collapsed, not twice.
  const [prev] = await db
    .select({ card: hiringMessages.card })
    .from(hiringMessages)
    .where(
      and(
        eq(hiringMessages.conversationId, conv.id),
        sql`${hiringMessages.card} ->> 'type' = 'task'`,
      ),
    )
    .orderBy(desc(hiringMessages.createdAt))
    .limit(1);
  const body = task.body.slice(0, 1500);
  const revision = task.kind === "approval" ? await revisionOf(conv, task) : null;
  const repeated = (prev?.card as { body?: string } | null)?.body === body && body.length > 0;
  await postMessage(conv, {
    role: "agent",
    agentType: run.agentType,
    body:
      task.kind === "clarification"
        ? "I have a question before I continue."
        : task.kind === "gate"
          ? step
            ? `${step.replace(" · ", " — waiting for the ")}.`
            : "This needs a decision."
          : revision
            ? `Revised as you asked ("${revision.reason}")${
                revision.changes.length
                  ? `: ${revision.changes.map((c) => `${c.label} ${c.from} → ${c.to}`).join(", ")}`
                  : " — but nothing in the proposal changed; tell me what to change, or decline it"
              }. May I go ahead with this?`
            : task.assigneeRole
              ? `This needs ${ROLE_TITLE[task.assigneeRole] ?? task.assigneeRole}'s approval.`
              : "May I go ahead with this?",
    card: {
      type: "task",
      taskId: task.id,
      kind: task.kind,
      title: task.title,
      body,
      ...(step ? { step } : {}),
      ...(repeated ? { repeated: true } : {}),
      ...(revision ? { revision } : {}),
      ...(task.kind === "approval"
        ? (() => {
            const a = task.proposedAction as { name?: string; args?: unknown } | null;
            const details = argDetails(a?.name ?? null, a?.args);
            return details.length ? { details } : {};
          })()
        : {}),
    },
  });
}

async function getToolDescription(name: string): Promise<string | null> {
  const { ensureAgentsRegistered } = await import("../agents");
  ensureAgentsRegistered();
  return getTool(name)?.description ?? null;
}

/** Readable details of the action each approval card asks about (old cards included). */
export async function taskDetails(
  orgId: string,
  ids: string[],
): Promise<Record<string, { label: string; value: string }[]>> {
  if (!ids.length) return {};
  const rows = await db
    .select({ id: agentTasks.id, kind: agentTasks.kind, action: agentTasks.proposedAction })
    .from(agentTasks)
    .where(and(eq(agentTasks.orgId, orgId), inArray(agentTasks.id, ids)));
  const out: Record<string, { label: string; value: string }[]> = {};
  for (const r of rows) {
    if (r.kind !== "approval") continue;
    const a = r.action as { name?: string; args?: unknown } | null;
    const d = argDetails(a?.name ?? null, a?.args);
    // Nothing to show (the tool works it out itself): say what it does instead.
    const what = a?.name ? await getToolDescription(a.name) : null;
    if (d.length) out[r.id] = d;
    // First sentence only: the rest is guidance written for the model.
    else if (what) out[r.id] = [{ label: "What it does", value: what.split(/(?<=\.)\s/)[0]! }];
  }
  return out;
}

const ROLE_TITLE: Record<string, string> = {
  recruiter: "a recruiter",
  hiring_manager: "the hiring manager",
  department_head: "the department head",
  hr_head: "the HR head",
  president_cbo: "the CBO",
};

/**
 * For each open request: whether this person may decide it (same rule as the
 * runtime: the named assignee, a holder of the assigned role, or the owner),
 * and who it is waiting for when they may not.
 */
export async function taskDeciders(
  orgId: string,
  userId: string,
  isOwner: boolean,
  ids: string[],
): Promise<Record<string, { canDecide: boolean; waitingFor: string | null }>> {
  if (!ids.length) return {};
  const rows = await db
    .select({
      id: agentTasks.id,
      role: agentTasks.assigneeRole,
      user: agentTasks.assigneeUserId,
    })
    .from(agentTasks)
    .where(and(eq(agentTasks.orgId, orgId), inArray(agentTasks.id, ids)));
  const { userRoles } = await import("@db/schema");
  const mine = (
    await db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.orgId, orgId)))
  ).map((r) => r.role as string);
  return Object.fromEntries(
    rows.map((t) => {
      const canDecide =
        isOwner || ((!t.user || t.user === userId) && (!t.role || mine.includes(t.role)));
      return [
        t.id,
        {
          canDecide,
          waitingFor: canDecide
            ? null
            : t.role
              ? (ROLE_TITLE[t.role] ?? t.role)
              : "the person it is assigned to",
        },
      ];
    }),
  );
}

/** Current status of the tasks shown in a thread (for the cards' buttons). */
export async function taskStatuses(orgId: string, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const rows = await db
    .select({ id: agentTasks.id, status: agentTasks.status, response: agentTasks.response })
    .from(agentTasks)
    .where(and(eq(agentTasks.orgId, orgId), inArray(agentTasks.id, ids)));
  return Object.fromEntries(
    rows.map((r) => [
      r.id,
      r.status === "rejected" && (r.response as { changes?: boolean } | null)?.changes
        ? "changes_requested"
        : r.status,
    ]),
  );
}

/* ------------------------------------------------------------- progress */

export type StageKey =
  | "need"
  | "requisition"
  | "jd"
  | "candidates"
  | "screening"
  | "interviews"
  | "decision"
  | "offer"
  | "joining";

export type DeskProgress = {
  /** The requisition was closed, rejected or deleted — the journey has ended. */
  ended?: { status: "closed" | "rejected" | "deleted"; reason: string | null; by: string | null };
  stages: { key: StageKey; label: string; state: "done" | "current" | "todo" }[];
  next: {
    stage: StageKey;
    /** What happens next, in plain words. */
    text: string;
    agentType: string | null;
    agentName: string | null;
    /** on = switched on; off = switched off (nothing will happen until it is). */
    agentEnabled: boolean | null;
    /** The responsible agent's latest run on this role (`paused` = at its monthly token budget). */
    run: { id: string; status: string; paused?: boolean } | null;
    /** Open requests from this thread's agents waiting for a person. */
    waitingForYou: number;
  } | null;
};

const STAGES: { key: StageKey; label: string; agent: AgentType | null }[] = [
  { key: "need", label: "Need", agent: null },
  { key: "requisition", label: "Requisition approval", agent: "requisition" },
  { key: "jd", label: "Job description", agent: "jd" },
  { key: "candidates", label: "Candidates", agent: "intake" },
  { key: "screening", label: "Screening", agent: "screening" },
  { key: "interviews", label: "Interviews", agent: "interview" },
  { key: "decision", label: "Hiring decision", agent: "evaluation" },
  { key: "offer", label: "Offer", agent: "offer" },
  { key: "joining", label: "Pre-onboarding & joining", agent: "onboarding" },
];

const AGENT_TITLE: Record<string, string> = {
  requisition: "Requisition agent",
  jd: "JD agent",
  intake: "Intake & matching agent",
  screening: "Screening agent",
  interview: "Interview coordinator",
  evaluation: "Evaluation agent",
  offer: "Offer agent",
  onboarding: "Pre-onboarding & release agent",
  publishing: "Publishing agent",
  followup: "Follow-up agent",
  copilot: "Copilot",
};

/** Agents that work alongside the journey rather than being a step of it. */
const SIDE_STEP: Record<string, string> = {
  publishing:
    "The Publishing agent is switched off, so this role will not be posted internally or to job boards automatically. Switch it on in Agent settings, or post it yourself in Manual mode.",
  followup:
    "The Follow-up agent is switched off, so overdue approvals and interviews will not be chased automatically.",
};

const APPROVER: Record<string, string> = {
  pending_dh: "the department head",
  pending_hr: "the HR head",
  pending_cbo: "the CBO",
};

/** Where this hire stands, and what happens next (the thread's progress tracker). */
export async function deskProgress(conv: Conversation): Promise<DeskProgress> {
  const done = new Set<StageKey>();
  const slotsComplete = !missingSlots(conv.slots as DeskSlots).length;
  if (conv.requisitionId || slotsComplete) done.add("need");

  let detail: Partial<Record<StageKey, string>> = {};
  if (conv.requisitionId) {
    const orgId = conv.orgId;
    const [req] = await db
      .select({
        code: requisitions.code,
        status: requisitions.status,
        approvalTrail: requisitions.approvalTrail,
      })
      .from(requisitions)
      .where(and(eq(requisitions.id, conv.requisitionId), eq(requisitions.orgId, orgId)))
      .limit(1);
    const jd = await latestJdStatus(orgId, conv.requisitionId);
    const [c] = (await db.execute(sql`
      select
        count(*) filter (where m.id is not null)::int scored,
        count(*) filter (where a.stage in ('l1','l2','l3','offer','offer_pending','offer_released','offer_accepted','hired','joined','joining_deferred'))::int interviewing,
        count(*) filter (where a.stage = 'joined')::int joined,
        (select count(*) from evaluations e join applications a2 on a2.id = e.application_id
          where a2.requisition_id = ${conv.requisitionId} and e.org_id = ${orgId})::int evaluations,
        (select count(*) from offers o join applications a3 on a3.id = o.application_id
          where a3.requisition_id = ${conv.requisitionId} and o.org_id = ${orgId})::int offers,
        (select count(*) from offers o join applications a4 on a4.id = o.application_id
          where a4.requisition_id = ${conv.requisitionId} and o.org_id = ${orgId}
            and o.status in ('released','accepted'))::int released
      from applications a left join match_scores m on m.application_id = a.id
      where a.requisition_id = ${conv.requisitionId} and a.org_id = ${orgId}`)) as unknown as {
      scored: number;
      interviewing: number;
      joined: number;
      evaluations: number;
      offers: number;
      released: number;
    }[];
    if (!req || req.status === "closed" || req.status === "rejected") {
      const trail = Array.isArray(req?.approvalTrail)
        ? (req!.approvalTrail as { actor?: string; comment?: string | null }[])
        : [];
      const stages = STAGES.map((st) => ({
        key: st.key,
        label: st.label,
        state: (st.key === "need" || (st.key === "requisition" && req?.status === "closed")
          ? "done"
          : "todo") as "done" | "todo",
      }));
      return {
        stages,
        next: null,
        ended: {
          status: !req ? "deleted" : (req.status as "closed" | "rejected"),
          reason: trail.at(-1)?.comment ?? null,
          by: trail.at(-1)?.actor ?? null,
        },
      };
    }
    if (req?.status === "approved") done.add("requisition");
    if (jd === "approved") done.add("jd");
    if ((c?.scored ?? 0) > 0) done.add("candidates");
    if ((c?.interviewing ?? 0) > 0) done.add("screening");
    if ((c?.evaluations ?? 0) > 0) done.add("interviews");
    if ((c?.offers ?? 0) > 0) done.add("decision");
    if ((c?.released ?? 0) > 0) done.add("offer");
    if ((c?.joined ?? 0) > 0) done.add("joining");
    detail = {
      requisition:
        req && APPROVER[req.status]
          ? `${req.code} is waiting for ${APPROVER[req.status]} to approve it — from this thread, Waiting for you, or the requisition page.`
          : `The Requisition agent completes draft ${req?.code ?? ""} (pay band, scoring weights) and sends it for approval.`,
      jd:
        jd === "pending_dh"
          ? "The job description is waiting for the department head's approval."
          : "The JD agent drafts the job description; the department head approves it.",
    };
  }
  // Later stages only count once the earlier ones are done (no skipping ahead).
  let current: StageKey | null = null;
  const stages = STAGES.map((s) => {
    if (current === null && !done.has(s.key)) current = s.key;
    const state: "done" | "current" | "todo" =
      current === s.key ? "current" : current === null ? "done" : "todo";
    return { key: s.key, label: s.label, state };
  });
  if (current === null) return { stages, next: null };
  const cur: StageKey = current;

  const TEXT: Record<StageKey, string> = {
    need: "Answer the desk's questions until the role, location, experience, openings and must-have skills are known.",
    requisition: detail.requisition ?? "",
    jd: detail.jd ?? "",
    candidates:
      "The Intake & matching agent searches the talent pool and posts a ranked list here.",
    screening:
      'Pick candidates from the ranked list (or type "talk to the first 5"); the Screening agent prepares their screening. Move the ones who pass to an interview round (Manual mode → Screening calls or the candidate page).',
    interviews:
      "The Interview coordinator books the rounds. After each interview the interviewer submits a scorecard (My interviews).",
    decision:
      "Once scorecards are in, the Evaluation agent writes the debrief and sends the hiring decision to the hiring manager — it appears here and in Waiting for you.",
    offer:
      "The Offer agent drafts the offer within the band; the HR head and then the CBO approve it.",
    joining:
      "The Pre-onboarding agent collects and cross-checks documents; HR validates them and releases the offer.",
  };

  const agentType = STAGES.find((s) => s.key === cur)!.agent;
  let agentEnabled: boolean | null = null;
  let run: { id: string; status: string; paused?: boolean } | null = null;
  if (agentType) {
    agentEnabled = await agentOn(conv.orgId, agentType);
    if (conv.requisitionId) {
      const [r] = await db
        .select({ id: agentRuns.id, status: agentRuns.status, lastError: agentRuns.lastError })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, conv.orgId),
            eq(agentRuns.agentType, agentType),
            eq(agentRuns.mode, "live"),
            or(eq(agentRuns.conversationId, conv.id), eq(agentRuns.subjectId, conv.requisitionId)),
          ),
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);
      run = r
        ? {
            id: r.id,
            status: r.status,
            ...(r.status === "queued" && r.lastError === BUDGET_PAUSED ? { paused: true } : {}),
          }
        : null;
    }
  }
  const [w] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentTasks)
    .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
    .where(
      and(
        eq(agentTasks.orgId, conv.orgId),
        eq(agentTasks.status, "open"),
        eq(agentRuns.conversationId, conv.id),
      ),
    );
  // The responsible agent already ran for this step and it is still not done:
  // say what came of it instead of "not started yet".
  if (cur === "candidates" && run?.status === "done") {
    TEXT.candidates =
      "The Intake & matching agent searched the pipeline and the talent pool and found no matching candidates yet. Add candidates (Manual mode → Talent pool or Careers inbox), then search again.";
  }
  return {
    stages,
    next: {
      stage: cur,
      text: TEXT[cur],
      agentType,
      agentName: agentType ? (AGENT_TITLE[agentType] ?? agentType) : null,
      agentEnabled,
      run,
      waitingForYou: Number(w?.n ?? 0),
    },
  };
}

/** Run a stopped agent again for the thread (same goal, same role). */
export async function retryRun(conv: Conversation, userId: string, runId: string): Promise<string> {
  const [r] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, conv.orgId)))
    .limit(1);
  if (!r) throw new Error("Run not found.");
  if (r.status !== "failed" || r.mode !== "live")
    throw new Error("Only a stopped run can be tried again.");
  if (r.conversationId !== conv.id && r.subjectId !== conv.requisitionId)
    throw new Error("That run does not belong to this conversation.");
  if (!(await agentOn(conv.orgId, r.agentType))) {
    throw new Error(
      `The ${AGENT_TITLE[r.agentType] ?? r.agentType} is switched off — switch it on in Agent settings first.`,
    );
  }
  const { startRun } = await import("../agents/runtime.server");
  const { runId: next } = await startRun({
    orgId: conv.orgId,
    agentType: r.agentType,
    principalUserId: userId,
    goal: r.goal,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    conversationId: conv.id,
  });
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId: conv.orgId,
    action: "desk.run_retried",
    entityType: "agent_run",
    entityId: next,
    detail: { retry_of: r.id, conversation_id: conv.id },
  });
  await postMessage(conv, {
    role: "desk",
    body: `Trying the ${AGENT_TITLE[r.agentType] ?? r.agentType} again.`,
    agentType: r.agentType,
  });
  const { kickAgents } = await import("../agents/orchestrator.server");
  kickAgents(conv.orgId);
  return next;
}

/**
 * The orchestrator wanted to start an agent for a thread's role but it is
 * switched off: say so in the thread (once) instead of stalling silently.
 */
export async function notifyAgentOff(
  orgId: string,
  requisitionId: string,
  agentType: string,
): Promise<void> {
  const conv = await conversationForRequisition(orgId, requisitionId);
  if (!conv) return;
  const body =
    SIDE_STEP[agentType] ??
    `The next step needs the ${AGENT_TITLE[agentType] ?? agentType}, which is switched off. Switch it on in Agent settings and I'll continue — or do this step yourself in Manual mode.`;
  const [last] = await db
    .select({ body: hiringMessages.body })
    .from(hiringMessages)
    .where(eq(hiringMessages.conversationId, conv.id))
    .orderBy(desc(hiringMessages.createdAt))
    .limit(1);
  if (last?.body === body) return;
  await postMessage(conv, { role: "desk", body, agentType });
}

/* ------------------------------------------- live activity and details */

/** What an agent step means, in plain words (for the live activity list). */
const STEP_LABEL: Record<string, string> = {
  get_requisition: "Read the requisition",
  find_similar_requisitions: "Checked similar roles",
  list_requisitions: "Looked through open roles",
  list_departments: "Looked up departments",
  research_compensation: "Researched market pay",
  set_compensation: "Set the pay band",
  suggest_weights: "Worked out scoring weights",
  save_weights: "Saved scoring weights",
  draft_requisition: "Drafted the requisition",
  update_requisition_draft: "Updated the draft",
  submit_requisition_for_approval: "Submitted for approval",
  request_approval: "Asked for a decision",
  ask_human: "Asked you a question",
  submit_jd_version: "Filed the job description",
  pipeline_summary: "Reviewed the pipeline",
  list_applications: "Read the applications",
  score_new_applications: "Scored applications",
  search_talent_pool: "Searched the talent pool",
  add_to_pipeline: "Added candidates to the pipeline",
  move_candidate: "Moved a candidate",
  prepare_screening_kit: "Prepared a screening kit",
  get_screening_status: "Checked screening status",
  send_assessment: "Sent an assessment",
  schedule_interview: "Booked an interview",
  draft_offer: "Drafted the offer",
  generate_offer_letter: "Wrote the offer letter",
  request_documents: "Requested documents",
};

export function stepLabel(tool: string | null): string {
  if (!tool) return "Thinking";
  if (STEP_LABEL[tool]) return STEP_LABEL[tool]!;
  const words = tool.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const HIDDEN_ARG = /(^|_)id$|Id$|^subject$/;
const MONEY_ARG = /ctc|budget|band|salary|compensation/i;

const fmtValue = (k: string, v: unknown): string => {
  if (typeof v === "number" && MONEY_ARG.test(k))
    return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/** A proposed tool call's arguments as label/value lines a person can read. */
export function argDetails(tool: string | null, args: unknown): { label: string; value: string }[] {
  if (!args || typeof args !== "object") return [];
  const entries = Object.entries(args as Record<string, unknown>).filter(
    ([k, v]) => !HIDDEN_ARG.test(k) && v !== null && v !== undefined && v !== "",
  );
  // Scoring weights read best as one line of percentages.
  if (tool === "save_weights") {
    const line = entries
      .map(([k, v]) => `${k.charAt(0).toUpperCase()}${k.slice(1)} ${v}%`)
      .join(" · ");
    return line ? [{ label: "Weights", value: line }] : [];
  }
  return entries.slice(0, 12).map(([k, v]) => ({
    label: k
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .replace(/^./, (c) => c.toUpperCase()),
    value: fmtValue(k, v).slice(0, 400),
  }));
}

/** Mirrors the runtime's budget-pause message (runtime.server BUDGET_PAUSE_MESSAGE). */
const BUDGET_PAUSED = "Paused: this agent reached its monthly token budget.";

export type DeskActivity = {
  agentType: string;
  agentName: string;
  status: string;
  steps: { label: string; state: "done" | "error" | "waiting" | "working" }[];
} | null;

/** The thread's agent working right now (or most recently), with its latest steps. */
export async function deskActivity(conv: Conversation): Promise<DeskActivity> {
  const [run] = await db
    .select({
      id: agentRuns.id,
      agentType: agentRuns.agentType,
      status: agentRuns.status,
      lastError: agentRuns.lastError,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, conv.orgId),
        eq(agentRuns.conversationId, conv.id),
        eq(agentRuns.mode, "live"),
        inArray(agentRuns.status, ["queued", "running", "awaiting_human"]),
      ),
    )
    .orderBy(desc(agentRuns.updatedAt))
    .limit(1);
  if (!run) return null;
  const { agentSteps } = await import("@db/schema");
  const rows = await db
    .select({
      kind: agentSteps.kind,
      tool: agentSteps.toolName,
      status: agentSteps.status,
      input: agentSteps.input,
    })
    .from(agentSteps)
    .where(and(eq(agentSteps.runId, run.id), eq(agentSteps.orgId, conv.orgId)))
    .orderBy(desc(agentSteps.seq))
    .limit(30);
  // Tool steps only (model turns are "thinking"). An approved call appears
  // twice — "awaiting", then "ok" later — so drop the waiting entry once the
  // same tool has a later result. Rows are newest first.
  const resolved = new Set<string>();
  const steps = rows
    .filter(
      (s) => (s.kind === "tool" && s.tool) || (s.kind === "decision" && s.status !== "approved"),
    )
    .filter((s) => {
      if (s.kind === "decision") return true;
      if (s.status === "awaiting") return !resolved.has(s.tool!);
      resolved.add(s.tool!);
      return true;
    })
    .slice(0, 6)
    .reverse()
    .map((s) => ({
      label: s.kind === "decision" ? decisionLabel(s.status, s.input) : stepLabel(s.tool),
      state: (s.status === "error" ? "error" : s.status === "awaiting" ? "waiting" : "done") as
        "done" | "error" | "waiting",
    }));
  const paused = run.status === "queued" && run.lastError === BUDGET_PAUSED;
  const working = !paused && (run.status === "running" || run.status === "queued");
  return {
    agentType: run.agentType,
    agentName: AGENT_TITLE[run.agentType] ?? run.agentType,
    status: paused ? "paused" : run.status,
    steps: working
      ? [...steps, { label: run.status === "queued" ? "Starting" : "Thinking", state: "working" }]
      : steps,
  };
}

/** Stages an agent can start on its own once reached (the others wait for a person or an event). */
const STARTABLE: Partial<Record<StageKey, AgentType>> = {
  requisition: "requisition",
  jd: "jd",
  candidates: "intake",
};

/**
 * Start the agent for the thread's current stage when the stage is reached,
 * the agent is on, and nothing is running for it. Returns the run id or null.
 */
export async function startStage(
  conv: Conversation,
  userId: string,
  opts: { dryRun?: boolean } = {},
): Promise<string | null> {
  if (!conv.requisitionId) return null;
  const progress = await deskProgress(conv);
  const next = progress.next;
  const agentType = next ? STARTABLE[next.stage] : undefined;
  if (!next || !agentType || next.agentEnabled !== true) return null;
  if (next.run && ["queued", "running", "awaiting_human"].includes(next.run.status)) return null;
  const [req] = await db
    .select({ code: requisitions.code, title: requisitions.title, status: requisitions.status })
    .from(requisitions)
    .where(and(eq(requisitions.id, conv.requisitionId), eq(requisitions.orgId, conv.orgId)))
    .limit(1);
  if (!req) return null;
  if (next.stage === "requisition") {
    if (req.status !== "draft") return null; // waiting for an approver, not for the agent
    if (opts.dryRun) return "requisition";
    return startForThread(
      conv,
      "requisition",
      userId,
      `Complete draft requisition ${req.code} "${req.title}": find the department, research the market pay band, set the scoring weights, then submit it for approval and prepare the approval brief.`,
      conv.requisitionId,
      "I've asked the Requisition agent to complete the draft and send it for approval.",
    );
  }
  if (next.stage === "jd") {
    const jd = await latestJdStatus(conv.orgId, conv.requisitionId);
    if (jd === "pending_dh") return null; // waiting for the department head
    if (opts.dryRun) return "jd";
    if (await reuseJdIfChosen(conv.orgId, conv.requisitionId)) return null;
    return startForThread(
      conv,
      "jd",
      userId,
      `Requisition ${req.code} "${req.title}" is approved. Draft its job description and get it approved by the department head.`,
      conv.requisitionId,
      "I've asked the JD agent to draft the job description; it will come back here for approval.",
    );
  }
  if (opts.dryRun) return "intake";
  return startForThread(
    conv,
    "intake",
    userId,
    INTAKE_GOAL(req.code, req.title),
    conv.requisitionId,
    "I've asked the Intake & matching agent to search the talent pool and rank the best matches.",
  );
}

/** An agent was switched on: continue every thread that was waiting for it. */
export async function resumeThreadsForAgent(
  orgId: string,
  agentType: string | "*",
): Promise<number> {
  const threads = await db
    .select()
    .from(hiringConversations)
    .where(
      and(
        eq(hiringConversations.orgId, orgId),
        eq(hiringConversations.status, "active"),
        sql`${hiringConversations.requisitionId} is not null`,
      ),
    )
    .limit(200);
  let started = 0;
  for (const conv of threads) {
    const p = await deskProgress(conv);
    if (!p.next?.agentType || (agentType !== "*" && p.next.agentType !== agentType)) continue;
    if (await startStage(conv, conv.createdBy)) started++;
  }
  return started;
}

/* ------------------------------------------------------- the reasoning */

export type CandidateReasoning = {
  rationale: string | null;
  recommendation: string | null;
  overall: number | null;
  /** Score per dimension (0-100) with the requisition's weight, highest weight first. */
  breakdown: { label: string; score: number; weight: number | null }[];
  matched: string[];
  missing: string[];
  risks: string[];
  highlights: string[];
};

/** Why each ranked candidate scored as they did — read live from their match score. */
export async function candidateReasoning(
  orgId: string,
  applicationIds: string[],
): Promise<Record<string, CandidateReasoning>> {
  if (!applicationIds.length) return {};
  const rows = await db
    .select({
      applicationId: matchScores.applicationId,
      overall: matchScores.overallScore,
      rationale: matchScores.rationale,
      recommendation: matchScores.recommendation,
      skills: matchScores.skillsScore,
      experience: matchScores.experienceScore,
      career: matchScores.careerScore,
      impact: matchScores.impactScore,
      education: matchScores.educationScore,
      social: matchScores.socialScore,
      weights: matchScores.weights,
      matched: matchScores.matchedSkills,
      missing: matchScores.missingSkills,
      risks: matchScores.riskFlags,
      highlights: matchScores.impactHighlights,
    })
    .from(matchScores)
    .innerJoin(applications, eq(applications.id, matchScores.applicationId))
    .where(and(eq(applications.orgId, orgId), inArray(matchScores.applicationId, applicationIds)));
  const out: Record<string, CandidateReasoning> = {};
  for (const r of rows) {
    const w = (r.weights ?? {}) as Record<string, number>;
    const dims: [string, string, number][] = [
      ["skills", "Skills", r.skills],
      ["experience", "Experience", r.experience],
      ["career", "Career", r.career],
      ["impact", "Impact", r.impact],
      ["education", "Education", r.education],
      ["social", "Profile & signals", r.social],
    ];
    out[r.applicationId] = {
      rationale: r.rationale,
      recommendation: r.recommendation,
      overall: r.overall,
      breakdown: dims
        .map(([k, label, score]) => ({
          label,
          score,
          weight: typeof w[k] === "number" ? w[k]! : null,
        }))
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)),
      matched: r.matched ?? [],
      missing: r.missing ?? [],
      risks: r.risks ?? [],
      highlights: (r.highlights ?? []).slice(0, 4),
    };
  }
  return out;
}

/* ----------------------------------------------------- bring candidates in */

/** Score the role's new applications (e.g. CVs uploaded in the thread) and post the ranked list. */
export async function scoreAndRank(conv: Conversation, userId: string): Promise<number> {
  if (!conv.requisitionId) throw new Error("Choose or create the role first.");
  const { scoreUnscored } = await import("@/lib/autoscore.server");
  const r = await scoreUnscored({
    orgId: conv.orgId,
    requisitionId: conv.requisitionId,
    limit: 25,
  });
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId: conv.orgId,
    action: "desk.candidates_scored",
    entityType: "requisition",
    entityId: conv.requisitionId,
    detail: { conversation_id: conv.id, scored: r.scored, errors: r.errors },
  });
  await postRankedList(conv);
  return r.scored;
}

/** Ask the Publishing agent to post the role (internal posting and job boards, reviewed). */
export async function publishRole(conv: Conversation, userId: string): Promise<string | null> {
  if (!conv.requisitionId) throw new Error("Choose or create the role first.");
  const [req] = await db
    .select({ code: requisitions.code, title: requisitions.title, status: requisitions.status })
    .from(requisitions)
    .where(and(eq(requisitions.id, conv.requisitionId), eq(requisitions.orgId, conv.orgId)))
    .limit(1);
  if (req?.status !== "approved") throw new Error("Only an approved role can be published.");
  return startForThread(
    conv,
    "publishing",
    userId,
    `Requisition ${req.code} "${req.title}" needs candidates. Publish it internally and prepare the external posts (LinkedIn and job boards) for review.`,
    conv.requisitionId,
    "I've asked the Publishing agent to post the role internally and prepare the LinkedIn and job-board posts. Each job-board post goes to the HR head for approval and is published as them — unless your organisation pre-approved that board for an Autonomous agent.",
  );
}

/** After the JD agent files a draft: say in the thread which template shaped it. */
export async function noteJdTemplate(
  orgId: string,
  runId: string,
  version: number,
  template: { name: string; reason: string } | null,
): Promise<void> {
  const [run] = await db
    .select({ conversationId: agentRuns.conversationId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)))
    .limit(1);
  if (!run?.conversationId) return;
  const conv = await loadConversation(orgId, run.conversationId).catch(() => null);
  if (!conv) return;
  await postMessage(conv, {
    role: "agent",
    agentType: "jd",
    body: template
      ? `Drafted JD version ${version} with the template "${template.name}" (${template.reason}).`
      : `Drafted JD version ${version} in the built-in format — you have no JD template yet. Add one under Content templates (and mark it default) to control sections and wording.`,
  });
}

/* ----------------------------------------- grounding and the role's end */

const STATUS_WORDS: Record<string, string> = {
  draft: "draft (not yet submitted)",
  pending_dh: "waiting for the department head's approval",
  pending_hr: "waiting for the HR head's approval",
  pending_cbo: "waiting for the CBO's approval",
  approved: "approved and open",
  rejected: "rejected",
  on_hold: "on hold",
  closed: "closed",
};

/** What is actually true for this thread right now, for the desk's answers. */
export async function deskFacts(conv: Conversation): Promise<string> {
  if (!conv.requisitionId) return "No requisition yet — the role is still being described.";
  const [req] = await db
    .select({
      code: requisitions.code,
      title: requisitions.title,
      status: requisitions.status,
      location: requisitions.location,
      openings: requisitions.openings,
      trail: requisitions.approvalTrail,
    })
    .from(requisitions)
    .where(and(eq(requisitions.id, conv.requisitionId), eq(requisitions.orgId, conv.orgId)))
    .limit(1);
  if (!req) return "The requisition this thread was for no longer exists (it was deleted).";
  const jd = await latestJdStatus(conv.orgId, conv.requisitionId);
  const [c] = (await db.execute(sql`
    select count(*)::int total,
      count(*) filter (where m.id is not null)::int scored,
      count(*) filter (where a.stage = 'shortlisted')::int shortlisted
    from applications a left join match_scores m on m.application_id = a.id
    where a.requisition_id = ${conv.requisitionId} and a.org_id = ${conv.orgId}`)) as unknown as {
    total: number;
    scored: number;
    shortlisted: number;
  }[];
  const trail = Array.isArray(req.trail)
    ? (req.trail as { to?: string; comment?: string | null; at?: string }[])
    : [];
  const last = trail.at(-1);
  const progress = await deskProgress(conv);
  return [
    `${req.code} "${req.title}" (${req.location ?? "—"}, ${req.openings} opening(s)) is ${STATUS_WORDS[req.status] ?? req.status}.`,
    last?.to && ["closed", "rejected", "on_hold"].includes(last.to)
      ? `It became ${last.to.replace("_", " ")}${last.at ? ` on ${last.at.slice(0, 10)}` : ""}${last.comment ? ` — reason: "${last.comment}"` : ""}.`
      : "",
    `Job description: ${jd ? jd.replace("_", " ") : "none yet"}.`,
    `Candidates in its pipeline: ${c?.total ?? 0} (${c?.scored ?? 0} scored, ${c?.shortlisted ?? 0} shortlisted).`,
    progress.next ? `Current journey step: ${progress.next.stage} — ${progress.next.text}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** "Close this role": the right action for its status, as a card with a button. */
export async function offerCloseRole(conv: Conversation): Promise<void> {
  if (!conv.requisitionId) {
    await postMessage(conv, {
      role: "desk",
      body: "There is no requisition yet, so there is nothing to close. You can simply leave this conversation.",
    });
    return;
  }
  const [req] = await db
    .select({ code: requisitions.code, status: requisitions.status })
    .from(requisitions)
    .where(and(eq(requisitions.id, conv.requisitionId), eq(requisitions.orgId, conv.orgId)))
    .limit(1);
  if (!req) return;
  const [apps] = (await db.execute(sql`
    select count(*)::int n from applications
    where requisition_id = ${conv.requisitionId} and org_id = ${conv.orgId}`)) as unknown as {
    n: number;
  }[];
  const action: "delete" | "reject" | "close" | null =
    req.status === "draft" && !(apps?.n ?? 0)
      ? "delete"
      : ["pending_dh", "pending_hr", "pending_cbo"].includes(req.status)
        ? "reject"
        : ["approved", "on_hold"].includes(req.status)
          ? "close"
          : null;
  if (!action) {
    await postMessage(conv, {
      role: "desk",
      body: `${req.code} is already ${STATUS_WORDS[req.status] ?? req.status}. A closed or rejected requisition cannot be reopened — start a new hiring need instead (it can reuse this role's approved job description).`,
    });
    return;
  }
  const who =
    action === "reject" ? "the approver of the current step" : "the HR head, CBO or owner";
  await postMessage(conv, {
    role: "desk",
    body:
      action === "delete"
        ? `${req.code} is an unused draft, so it can be deleted. Give a reason and confirm below (${who}).`
        : action === "reject"
          ? `${req.code} is still in the approval chain, so it is rejected rather than closed. Give a reason and confirm below (${who}).`
          : `${req.code} will be closed: agents stop working on it and its job-board postings come down. It cannot be reopened. Give a reason and confirm below (${who}).`,
    card: { type: "close_role", requisitionId: conv.requisitionId, code: req.code, action },
  });
}

/** Perform the close / reject / delete from the thread, as the person (role-checked, audited). */
export async function closeRole(
  conv: Conversation,
  userId: string,
  reason: string,
): Promise<{ action: "delete" | "reject" | "close" }> {
  if (!conv.requisitionId) throw new Error("There is no requisition to close.");
  const [req] = await db
    .select({ id: requisitions.id, code: requisitions.code, status: requisitions.status })
    .from(requisitions)
    .where(and(eq(requisitions.id, conv.requisitionId), eq(requisitions.orgId, conv.orgId)))
    .limit(1);
  if (!req) throw new Error("Requisition not found.");
  const { activeOrgOf, assertRole } = await import("@/lib/auth.middleware");
  const org = await activeOrgOf(userId);
  if (!org || org.orgId !== conv.orgId)
    throw new Error("You are not a member of this organisation.");
  const actor = { orgId: conv.orgId, userId, memberEmail: org.memberEmail };
  const { advanceRequisitionCore } = await import("@/lib/requisitions.server");
  if (req.status === "draft") {
    // The same rule as the Requisitions list: unused drafts only, HR leadership.
    await assertRole(userId, conv.orgId, ["hr_head", "president_cbo"]);
    const [apps] = (await db.execute(sql`
      select count(*)::int n from applications where requisition_id = ${req.id} and org_id = ${conv.orgId}`)) as unknown as {
      n: number;
    }[];
    if ((apps?.n ?? 0) > 0)
      throw new Error(
        "This draft already has applications — it can be closed only after approval.",
      );
    await db
      .delete(requisitions)
      .where(and(eq(requisitions.id, req.id), eq(requisitions.orgId, conv.orgId)));
    await writeAudit({
      actor: org.memberEmail,
      actorUserId: userId,
      orgId: conv.orgId,
      action: "requisition.delete",
      entityType: "requisition",
      entityId: req.id,
      detail: { code: req.code, reason, via: "hiring_desk", conversation_id: conv.id },
    });
    await endThread(conv, `${req.code} was deleted. Reason: ${reason}`);
    return { action: "delete" };
  }
  const to = ["pending_dh", "pending_hr", "pending_cbo"].includes(req.status)
    ? "rejected"
    : "closed";
  // Role checks and the trail live in the lifecycle core (same as the requisition page);
  // the requisition.status_changed event then ends the thread.
  await advanceRequisitionCore(actor, { id: req.id, status: to, comment: reason });
  await onRequisitionEnded(conv.orgId, req.id, to, userId, reason);
  return { action: to === "rejected" ? "reject" : "close" };
}

/** Mark the thread closed and say why (once). */
async function endThread(conv: Conversation, body: string): Promise<void> {
  await db
    .update(hiringConversations)
    .set({ status: "closed", updatedAt: new Date() })
    .where(eq(hiringConversations.id, conv.id));
  const [last] = await db
    .select({ body: hiringMessages.body })
    .from(hiringMessages)
    .where(eq(hiringMessages.conversationId, conv.id))
    .orderBy(desc(hiringMessages.createdAt))
    .limit(1);
  if (last?.body !== body)
    await postMessage(conv, { role: "desk", body, card: { type: "role_ended" } });
}

/**
 * A requisition was closed or rejected (anywhere — this thread, the requisition
 * page, an approver): stop its agents, cancel their open requests, and end the
 * thread with who and why. Idempotent.
 */
export async function onRequisitionEnded(
  orgId: string,
  requisitionId: string,
  to: string,
  actorUserId: string | null,
  comment?: string | null,
): Promise<void> {
  if (!["closed", "rejected"].includes(to)) return;
  const conv = await conversationForRequisition(orgId, requisitionId);
  const [req] = await db
    .select({
      code: requisitions.code,
      trail: requisitions.approvalTrail,
      createdBy: requisitions.createdBy,
    })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  const stopper = actorUserId ?? req?.createdBy ?? conv?.createdBy ?? null;
  // Stop the agents still working on this role (the role and its candidates).
  const active = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        inArray(agentRuns.status, ["queued", "running", "awaiting_human"]),
        or(
          eq(agentRuns.subjectId, requisitionId),
          sql`${agentRuns.subjectId} in (select id from applications where requisition_id = ${requisitionId} and org_id = ${orgId})`,
        ),
      ),
    );
  if (active.length && stopper) {
    const { cancelRun } = await import("../agents/runtime.server");
    for (const r of active) await cancelRun({ orgId, runId: r.id, userId: stopper });
  }
  // Closed threads are skipped by conversationForRequisition, so this runs once.
  if (!conv) return;
  const trail = Array.isArray(req?.trail)
    ? (req!.trail as { actor?: string; comment?: string | null }[])
    : [];
  const last = trail.at(-1);
  const reason = comment ?? last?.comment ?? null;
  await endThread(
    conv,
    `${req?.code ?? "The requisition"} was ${to}${last?.actor ? ` by ${last.actor}` : ""}${reason ? ` — reason: "${reason}"` : ""}. ${active.length ? `${active.length} agent run(s) working on it were stopped. ` : ""}A ${to} requisition cannot be reopened; start a new hiring need to hire for this again.`,
  );
}

/* ---------------------------------------- thinking, research, proposals */

const SLOT_LABEL: Record<string, string> = {
  roleTitle: "Role",
  location: "Location",
  experienceMin: "Experience from",
  experienceMax: "Experience up to",
  openings: "Openings",
  mustHaveSkills: "Must-have skills",
  goodToHaveSkills: "Good-to-have skills",
  budgetLpaMax: "Budget (LPA, up to)",
  maxNoticeDays: "Notice period (days, max)",
  employmentType: "Employment type",
  urgency: "Urgency",
  responsibilities: "Responsibilities",
  reportingTo: "Reports to",
  successMeasures: "Success after 12 months",
  education: "Education",
};
const REQUIRED_LABEL: Record<RequiredSlot, string> = {
  roleTitle: "role",
  location: "location",
  experience: "experience",
  openings: "number of openings",
  mustHaveSkills: "must-have skills",
};

/** What the latest message changed, as label / value lines (the desk's "understood"). */
export function changedSlots(
  before: DeskSlots,
  after: DeskSlots,
): { label: string; value: string }[] {
  return (Object.keys(SLOT_LABEL) as (keyof DeskSlots)[])
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]) && after[k] !== undefined)
    .map((k) => {
      const v = after[k];
      return { label: SLOT_LABEL[k]!, value: Array.isArray(v) ? v.join(", ") : String(v) };
    });
}

/** "How I read that": what was understood, what is still missing, what happens next. */
function thinking(
  understood: { label: string; value: string }[],
  slots: DeskSlots,
  next: string,
): DeskCard {
  return {
    type: "reasoning",
    understood,
    missing: missingSlots(slots).map((m) => REQUIRED_LABEL[m]),
    next,
  };
}

/** Continue gathering: ask the next missing detail, the JD question once, then similar roles. */
async function advanceGathering(
  conv: Conversation,
  reply: string,
  understood: { label: string; value: string }[],
): Promise<void> {
  const slots = conv.slots as DeskSlots;
  const missing = missingSlots(slots);
  if (missing.length) {
    await postMessage(conv, {
      role: "desk",
      body: reply.trim() || FALLBACK_QUESTION[missing[0]!],
      card: thinking(
        understood,
        slots,
        `Asking for the ${REQUIRED_LABEL[missing[0]!]}. You can also say "as per market" and I'll research it.`,
      ),
    });
    return;
  }
  // One question for a deeper JD, asked once; any answer (or "research it") moves on.
  if (!slots.jdDetailsAsked) {
    const asked = { ...slots, jdDetailsAsked: true };
    await db
      .update(hiringConversations)
      .set({ slots: asked as never })
      .where(eq(hiringConversations.id, conv.id));
    await postMessage(conv, {
      role: "desk",
      body: `To write a strong job description for ${slots.roleTitle}: what are the 3–5 key responsibilities, who does this role report to, and what does success look like after 12 months? Any education requirement? Answer in your own words — or say "research it" and I'll draft these from typical market practice for this role.`,
      card: thinking(
        understood,
        slots,
        "All required details are in. One optional question for a deeper job description.",
      ),
    });
    return;
  }
  await db
    .update(hiringConversations)
    .set({ status: "confirming" })
    .where(eq(hiringConversations.id, conv.id));
  const similar = await findSimilarRoles(conv.orgId, slots);
  await postMessage(conv, {
    role: "desk",
    body: similar.length
      ? `Got it: ${describeNeed(slots)}. I found ${similar.length} similar role(s). Continue with one of them, reuse an approved JD for a new role, or create a new role.`
      : `Got it: ${describeNeed(slots)}. There is no similar role yet — shall I create a new one?`,
    card: {
      type: "similar_roles",
      slots,
      items: similar,
      why: {
        understood,
        missing: [],
        next: `Checked your requisitions for roles similar to "${slots.roleTitle}": ${similar.length} found.`,
      },
    },
  });
}

const Proposal = z.object({
  mustHaveSkills: z.array(z.string().min(1).max(60)).max(10).default([]),
  goodToHaveSkills: z.array(z.string().min(1).max(60)).max(10).default([]),
  experienceMin: z.number().min(0).max(40).nullable().default(null),
  experienceMax: z.number().min(0).max(50).nullable().default(null),
  budgetLpaMin: z.number().min(0).max(1000).nullable().default(null),
  budgetLpaMax: z.number().min(0).max(1000).nullable().default(null),
  reasoning: z.string().max(1200).default(""),
  sources: z
    .array(z.object({ title: z.string().max(200), url: z.string().max(500) }))
    .max(8)
    .default([]),
});
export type RoleProposal = z.infer<typeof Proposal>;

/**
 * The person delegated details to the market: research them (live web research
 * when the organisation's AI model supports it, else the model's knowledge —
 * labelled as such) and post a proposal they can accept or change.
 */
export async function researchRole(
  conv: Conversation,
  fields: ("skills" | "experience" | "budget")[],
  understood: { label: string; value: string }[] = [],
): Promise<void> {
  const s = conv.slots as DeskSlots;
  if (!s.roleTitle) {
    await postMessage(conv, {
      role: "desk",
      body: "Which role should I research? Tell me the role first.",
    });
    return;
  }
  const { aiResearchJson } = await import("@/lib/ai-gateway.server");
  const res = await aiResearchJson<RoleProposal>({
    orgId: conv.orgId,
    feature: "role_research",
    system:
      "You research current hiring-market expectations for a role, for a recruiter in India unless the location says otherwise. " +
      "Use live web sources when available (job postings, salary surveys, skills reports) and cite them. Be concrete and current: " +
      "skills as short names (tools, frameworks, methods), experience as a year range, budget as annual CTC in lakhs (LPA) for the location. " +
      "Only fill the fields asked for; leave the others empty / null. " +
      'Return ONLY JSON: {"mustHaveSkills":[],"goodToHaveSkills":[],"experienceMin":null,"experienceMax":null,' +
      '"budgetLpaMin":null,"budgetLpaMax":null,"reasoning":"2-4 sentences: why these, what the market shows","sources":[{"title","url"}]}',
    prompt: JSON.stringify({
      role: s.roleTitle,
      location: s.location ?? null,
      experience: s.experienceMin !== undefined ? [s.experienceMin, s.experienceMax ?? null] : null,
      known: { mustHaveSkills: s.mustHaveSkills ?? [], goodToHaveSkills: s.goodToHaveSkills ?? [] },
      research: fields,
    }),
  });
  if (!res.ok) {
    await postMessage(conv, {
      role: "desk",
      body: "I couldn't research that just now. Tell me the details yourself, or try again in a moment.",
    });
    return;
  }
  const parsed = Proposal.safeParse(res.data);
  if (!parsed.success) {
    await postMessage(conv, {
      role: "desk",
      body: "The research came back incomplete. Tell me the details yourself, or ask again.",
    });
    return;
  }
  const p = parsed.data;
  // Keep only http(s) links; never render anything else as a link.
  p.sources = p.sources.filter((x) => /^https?:\/\//i.test(x.url));
  await postMessage(conv, {
    role: "desk",
    body: `Here is what the market expects for a ${s.roleTitle}${s.location ? ` (${s.location})` : ""}. Use these, or tell me what to change.`,
    card: {
      type: "proposal",
      fields,
      proposal: p as never,
      grounded: res.grounded,
      accepted: false,
      why: {
        understood,
        missing: missingSlots(s).map((m) => REQUIRED_LABEL[m]),
        next: res.grounded
          ? `Researched ${fields.join(", ")} from live web sources (${p.sources.length}).`
          : `Estimated ${fields.join(", ")} from the AI model's knowledge — no live web sources were available.`,
      },
    },
  });
}

/** The newest proposal in the thread that has not been accepted yet. */
export async function latestProposal(
  conv: Conversation,
): Promise<{ messageId: string; proposal: RoleProposal; fields: string[] } | null> {
  const [m] = await db
    .select({ id: hiringMessages.id, card: hiringMessages.card })
    .from(hiringMessages)
    .where(
      and(
        eq(hiringMessages.conversationId, conv.id),
        sql`${hiringMessages.card} ->> 'type' = 'proposal'`,
      ),
    )
    .orderBy(desc(hiringMessages.createdAt))
    .limit(1);
  const card = m?.card as {
    proposal?: RoleProposal;
    fields?: string[];
    accepted?: boolean;
    superseded?: boolean;
  } | null;
  if (!m || !card?.proposal || card.accepted || card.superseded) return null;
  return { messageId: m.id, proposal: card.proposal, fields: card.fields ?? [] };
}

/** Accept the latest proposal: fill the details it covers, then carry on. */
export async function applyProposal(conv: Conversation): Promise<void> {
  const open = await latestProposal(conv);
  if (!open) throw new Error("There is no proposal to accept.");
  const p = open.proposal;
  const before = conv.slots as DeskSlots;
  const patch: DeskSlots = {
    ...(p.mustHaveSkills.length ? { mustHaveSkills: p.mustHaveSkills } : {}),
    ...(p.goodToHaveSkills.length ? { goodToHaveSkills: p.goodToHaveSkills } : {}),
    ...(p.experienceMin != null ? { experienceMin: p.experienceMin } : {}),
    ...(p.experienceMax != null ? { experienceMax: p.experienceMax } : {}),
    ...(p.budgetLpaMax != null ? { budgetLpaMax: p.budgetLpaMax } : {}),
  };
  const slots = mergeSlots(before, patch);
  await db
    .update(hiringConversations)
    .set({ slots: slots as never })
    .where(eq(hiringConversations.id, conv.id));
  const [msg] = await db
    .select({ card: hiringMessages.card })
    .from(hiringMessages)
    .where(eq(hiringMessages.id, open.messageId))
    .limit(1);
  await db
    .update(hiringMessages)
    .set({ card: { ...(msg?.card as object), accepted: true } as never })
    .where(eq(hiringMessages.id, open.messageId));
  conv = { ...conv, slots: slots as never };
  if (conv.status === "gathering") {
    await advanceGathering(conv, "", changedSlots(before, slots));
    return;
  }
  await postMessage(conv, {
    role: "desk",
    body: `Updated: ${describeNeed(slots)}.`,
    card: thinking(changedSlots(before, slots), slots, "Applied the researched details."),
  });
}

async function supersedeProposal(conv: Conversation): Promise<void> {
  const open = await latestProposal(conv);
  if (!open) return;
  await db
    .update(hiringMessages)
    .set({
      card: sql`${hiringMessages.card} || '{"superseded":true}'::jsonb`,
    })
    .where(eq(hiringMessages.id, open.messageId));
}

/* ------------------------------------------- person → agent feedback */

export type OpenRequest = {
  id: string;
  kind: string;
  title: string;
  agentType: string;
};

/** Requests from this thread's agents still waiting on a person, newest first. */
export async function openRequests(conv: Conversation): Promise<OpenRequest[]> {
  return db
    .select({
      id: agentTasks.id,
      kind: agentTasks.kind,
      title: agentTasks.title,
      agentType: agentRuns.agentType,
    })
    .from(agentTasks)
    .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
    .where(
      and(
        eq(agentTasks.orgId, conv.orgId),
        eq(agentTasks.status, "open"),
        eq(agentRuns.conversationId, conv.id),
      ),
    )
    .orderBy(desc(agentTasks.createdAt))
    .limit(5);
}

/**
 * The person asked, in the chat, for a pending agent request to change (or
 * answered an agent's question). Hand it to that agent as a decision on its
 * request — "changes requested" with their words — so the agent revises and
 * asks again. Gates (real approval steps such as a requisition or JD sign-off)
 * are never decided from chat; the person uses the card.
 */
export async function sendFeedback(
  conv: Conversation,
  userId: string,
  text: string,
  understood: { label: string; value: string }[] = [],
): Promise<void> {
  understood = [...understood, { label: "Your change", value: text }];
  const requests = await openRequests(conv);
  const target = requests.find((r) => r.kind === "approval" || r.kind === "clarification") ?? null;
  const agent = (r: OpenRequest) => AGENT_TITLE[r.agentType] ?? `${r.agentType} agent`;
  if (!target) {
    await postMessage(conv, {
      role: "desk",
      body: requests.length
        ? `"${requests[0]!.title}" is an approval step, so it is decided on its card (Approve, or Decline with a reason), not from the chat.`
        : "No agent is waiting on you in this thread, so there is nothing to send back. Tell me what you want done and I'll start the right agent.",
      card: { type: "reasoning", understood, missing: [], next: "Nothing was sent to the agents." },
    });
    return;
  }
  const { resolveTask } = await import("../agents/runtime.server");
  try {
    await resolveTask({
      orgId: conv.orgId,
      taskId: target.id,
      userId,
      decision:
        target.kind === "clarification"
          ? { status: "answered", answer: text }
          : { status: "rejected", reason: text, changes: true },
    });
  } catch (e) {
    await postMessage(conv, {
      role: "desk",
      body: `I couldn't pass that on: ${e instanceof Error ? e.message : "the request could not be updated."}`,
    });
    return;
  }
  const { kickAgents } = await import("../agents/orchestrator.server");
  kickAgents(conv.orgId);
  await postMessage(conv, {
    role: "desk",
    body:
      target.kind === "clarification"
        ? `Sent your answer to the ${agent(target)}. It continues from here.`
        : `Sent back to the ${agent(target)}: "${text}". It will revise "${target.title}" and ask you again.`,
    card: {
      type: "reasoning",
      understood,
      missing: [],
      next:
        target.kind === "clarification"
          ? `Answered "${target.title}" for you.`
          : `Returned "${target.title}" to the ${agent(target)} with your change. The old request is closed, so it cannot be approved by mistake.`,
    },
  });
}

/** Live-activity wording for a person's decision handed back to an agent. */
function decisionLabel(status: string, input: unknown): string {
  const i = (input ?? {}) as { changes?: boolean; reason?: string };
  if (status === "rejected" && i.changes)
    return `You asked for changes${i.reason ? `: "${i.reason.slice(0, 80)}"` : ""}`;
  if (status === "rejected") return "You declined";
  if (status === "answered") return "You answered its question";
  return "Request cancelled";
}

export type Revision = {
  reason: string;
  changes: { label: string; from: string; to: string }[];
};

/**
 * A request the agent re-proposed after the person asked for changes: the
 * reason and what actually changed, so the person sees the effect of their
 * words (and sees it plainly when nothing changed).
 */
export async function revisionOf(
  conv: Conversation,
  task: { title: string; proposedAction?: unknown },
): Promise<Revision | null> {
  const [prev] = await db
    .select({ action: agentTasks.proposedAction, response: agentTasks.response })
    .from(agentTasks)
    .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
    .where(
      and(
        eq(agentTasks.orgId, conv.orgId),
        eq(agentRuns.conversationId, conv.id),
        eq(agentTasks.title, task.title),
        eq(agentTasks.status, "rejected"),
        sql`(${agentTasks.response} ->> 'changes')::boolean is true`,
      ),
    )
    .orderBy(desc(agentTasks.decidedAt))
    .limit(1);
  if (!prev) return null;
  const before = (prev.action as { name?: string; args?: Record<string, unknown> } | null) ?? {};
  const after = (task.proposedAction as { args?: Record<string, unknown> } | null) ?? {};
  const a = before.args ?? {};
  const b = after.args ?? {};
  const pct = before.name === "save_weights";
  const show = (k: string, v: unknown) =>
    v === undefined || v === null ? "—" : pct ? `${String(v)}%` : fmtValue(k, v).slice(0, 80);
  const changes = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => !HIDDEN_ARG.test(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .slice(0, 8)
    .map((k) => ({
      label: k
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ")
        .replace(/^./, (c) => c.toUpperCase()),
      from: show(k, a[k]),
      to: show(k, b[k]),
    }));
  return {
    reason: String((prev.response as { reason?: string } | null)?.reason ?? "").slice(0, 200),
    changes,
  };
}
