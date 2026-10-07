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
  '- "command": {"type":"none"} unless the person asks to act: "talk to / screen / call the first 5" → {"type":"screen","top":5}; "screen 1, 3 and 4" → {"type":"screen","ranks":[1,3,4]}; "create a new role" → {"type":"new_role"}; "use REQ-2026-014" → {"type":"use_existing","code":"REQ-2026-014"}.',
  '- "reply": one short, friendly message. If MISSING lists details, ask for the FIRST missing one only, in one sentence, offering a typical example. Otherwise acknowledge briefly. Never claim that anything was created, approved or sent.',
].join("\n");

export async function runTurn(
  orgId: string,
  conv: Conversation,
  history: { role: string; body: string }[],
): Promise<{ ok: true; turn: DeskTurn } | { ok: false; message: string }> {
  const slots = conv.slots as DeskSlots;
  const prompt = [
    `CURRENT DETAILS: ${JSON.stringify(slots)}`,
    `MISSING (ask in this order): ${missingSlots(slots).join(", ") || "none"}`,
    `STAGE: ${conv.status}`,
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
      responsibilities: null,
      educationRequirement: null,
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
  if (!items.length) {
    await postMessage(conv, {
      role: "agent",
      agentType: "intake",
      body: "No matching candidates are in the pipeline or the talent pool yet. New applications will be scored as they arrive.",
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
  const slots = mergeSlots(conv.slots as DeskSlots, turn.slots);
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

  // Commands the person gave in words.
  const cmd = turn.command;
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
    const missing = missingSlots(slots);
    if (missing.length) {
      await postMessage(conv, {
        role: "desk",
        body: turn.reply.trim() || FALLBACK_QUESTION[missing[0]!],
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
      card: { type: "similar_roles", slots, items: similar },
    });
    return;
  }

  await postMessage(conv, {
    role: "desk",
    body:
      turn.reply.trim() ||
      (conv.status === "confirming"
        ? "Choose one of the options above, or tell me what to change."
        : "Noted."),
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
          : "May I go ahead with this?",
    card: {
      type: "task",
      taskId: task.id,
      kind: task.kind,
      title: task.title,
      body,
      ...(step ? { step } : {}),
      ...(repeated ? { repeated: true } : {}),
    },
  });
}

/** Current status of the tasks shown in a thread (for the cards' buttons). */
export async function taskStatuses(orgId: string, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const rows = await db
    .select({ id: agentTasks.id, status: agentTasks.status })
    .from(agentTasks)
    .where(and(eq(agentTasks.orgId, orgId), inArray(agentTasks.id, ids)));
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
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
  stages: { key: StageKey; label: string; state: "done" | "current" | "todo" }[];
  next: {
    stage: StageKey;
    /** What happens next, in plain words. */
    text: string;
    agentType: string | null;
    agentName: string | null;
    /** on = switched on; off = switched off (nothing will happen until it is). */
    agentEnabled: boolean | null;
    /** The responsible agent's latest run on this role. */
    run: { id: string; status: string } | null;
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
      .select({ code: requisitions.code, status: requisitions.status })
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
  let run: { id: string; status: string } | null = null;
  if (agentType) {
    agentEnabled = await agentOn(conv.orgId, agentType);
    if (conv.requisitionId) {
      const [r] = await db
        .select({ id: agentRuns.id, status: agentRuns.status })
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
      run = r ?? null;
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
  const body = `The next step needs the ${AGENT_TITLE[agentType] ?? agentType}, which is switched off. Switch it on in Agent settings and I'll continue — or do this step yourself in Manual mode.`;
  const [last] = await db
    .select({ body: hiringMessages.body })
    .from(hiringMessages)
    .where(eq(hiringMessages.conversationId, conv.id))
    .orderBy(desc(hiringMessages.createdAt))
    .limit(1);
  if (last?.body === body) return;
  await postMessage(conv, { role: "desk", body, agentType });
}
