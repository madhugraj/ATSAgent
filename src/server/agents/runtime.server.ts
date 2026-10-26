/**
 * Agent runtime (docs/agentic-plan.md §3.2).
 *
 * A run is a row: its transcript is the checkpoint, so a crash, a deploy or a
 * week-long wait for an approver costs nothing. `runAgentTick` (called by the
 * scheduler through /api/public/agent-tick) reclaims expired leases, claims
 * queued runs and drives each one through model → tool → model turns until it
 * finishes, needs a person, or hits a budget.
 *
 * Safety properties, each enforced here rather than trusted to the model:
 *  - only tools the agent's definition lists can run, with zod-validated args;
 *  - write / external tools go through the org's autonomy policy;
 *  - tools run as the human principal, so existing role checks apply;
 *  - third-party text in tool output is fenced with untrusted();
 *  - every write/external action and every human decision is audited.
 */
import { rupees } from "@/lib/money";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod/v4";

import {
  aiAgentStep,
  INJECTION_RULES,
  INVALID_TOOL_ARGS,
  toolParameters,
  untrusted,
  type AgentMessage,
  type AgentToolCall,
  type AgentToolSpec,
  type AiConfig,
} from "@/lib/ai-gateway.server";
import { assertRole, type AppRole } from "@/lib/auth.middleware";
import { db } from "../db";
import { writeAudit } from "../audit";
import { log } from "../log";
import {
  agentPolicies,
  agentRuns,
  agentSteps,
  agentTasks,
  applications,
  candidates,
  jobDescriptions,
  offers,
  onboardingDocuments,
  requisitions,
  screeningRuns,
  type AgentTaskKind,
  type AgentType,
} from "@db/schema";
import { agentRunScope } from "./context";
import { ensureDefinition, manifestHash, RUNTIME_RULES } from "./manifest.server";
import { looksLikeInjection } from "./injection";
import { decideToolCall, loadPolicy } from "./policy";
import { getAgent, getTool, type ToolContext } from "./registry";

/**
 * Eval-only: run agents against a fixed model config instead of the org's
 * saved key (scripts/agent-eval.ts). Never set in the app.
 */
let modelOverride: AiConfig | null = null;
export function setEvalModelOverride(cfg: AiConfig | null): void {
  modelOverride = cfg;
}

const LEASE_MINUTES = 10;
const MAX_ATTEMPTS = 3;
/** Model turns per run per tick, so one long run cannot starve the queue. */
const TURNS_PER_TICK = 8;
const CONCURRENCY = 2;
const PREVIEW_CHARS = 600;

/** The harness limits every run executes under (shown in Agent observability). */
export const HARNESS_LIMITS = {
  leaseMinutes: LEASE_MINUTES,
  maxAttempts: MAX_ATTEMPTS,
  turnsPerTick: TURNS_PER_TICK,
  concurrency: CONCURRENCY,
  /** agent_runs.max_tokens default (per run). */
  maxTokensPerRun: 200_000,
  /** Budget-paused runs are re-checked after this many minutes. */
  budgetRecheckMinutes: 60,
} as const;

/**
 * Run limits work per leg: the AI turns and tokens between two human
 * decisions. Waiting for a person is not a loop, so a decision starts a fresh
 * leg; a hard ceiling of LEG_CEILING legs' worth still stops a looping agent.
 * Organisations may raise an agent's per-leg limits up to these maximums.
 */
export const RUN_LIMITS = {
  legCeiling: 4,
  maxStepsPerLeg: 60,
  minStepsPerLeg: 4,
  maxTokensPerLeg: 1_000_000,
  minTokensPerLeg: 20_000,
} as const;
import { CEILING_MESSAGE, LEG_LIMIT_MESSAGE } from "./run-messages";
export { CEILING_MESSAGE, LEG_LIMIT_MESSAGE };

/** Messages of things that broke rather than rules that said no (pure; unit-tested). */
const BROKEN =
  /ECONN|ETIMEDOUT|timed? ?out|fetch failed|network|socket|database|Failed query|syntax error|duplicate key|deadlock|violates|does not exist|undefined|null|NaN|Cannot read/i;

/**
 * A tool that threw: was it a business rule or guardrail saying no (shown as
 * "refused", not counted as a failure), or did something break? Only a plain
 * Error with a readable message counts as a refusal; driver, validation and
 * programming errors (their own classes) and infrastructure messages are failures.
 */
export function isRuleRefusal(e: unknown): boolean {
  if (!(e instanceof Error) || e.constructor !== Error) return false;
  const m = e.message.trim();
  return m.length > 0 && m.length < 600 && !BROKEN.test(m);
}

/** Which limit (if any) a run has reached now (pure; unit-tested). Ceiling first. */
export function limitReached(r: {
  stepCount: number;
  tokensUsed: number;
  legStepStart: number;
  legTokenStart: number;
  maxSteps: number;
  maxTokens: number;
}): "ceiling" | "leg" | null {
  if (
    r.stepCount >= r.maxSteps * RUN_LIMITS.legCeiling ||
    r.tokensUsed >= r.maxTokens * RUN_LIMITS.legCeiling
  )
    return "ceiling";
  if (r.stepCount - r.legStepStart >= r.maxSteps || r.tokensUsed - r.legTokenStart >= r.maxTokens)
    return "leg";
  return null;
}

/**
 * What the model re-reads each turn (pure; unit-tested): the run's own record
 * keeps everything, but tool results older than the last `keep` messages are
 * shortened — a long run's cost no longer grows with every earlier result.
 * Untrusted fences stay intact around what is kept.
 */
export function compactForModel(transcript: AgentMessage[], keep = 8, max = 700): AgentMessage[] {
  const cut = transcript.length - keep;
  return transcript.map((m, i) => {
    if (i >= cut || m.role !== "tool" || m.content.length <= max) return m;
    const note = `\n[… shortened: ${m.content.length - max} more characters are in the run trail]`;
    const fenced = /^(<untrusted_data[^>]*>\n)([\s\S]*)(\n<\/untrusted_data>)$/.exec(m.content);
    const content = fenced
      ? `${fenced[1]}${fenced[2]!.slice(0, max)}${note}${fenced[3]}`
      : `${m.content.slice(0, max)}${note}`;
    return { ...m, content };
  });
}

/** Said to the model once when its reply was cut off at the output limit without a tool call. */
export const CUT_OFF_NUDGE =
  "Your last reply was cut off at the length limit before you did anything. Do not think out loud or repeat your reasoning: call the next tool now, or, if you are finished, reply with a short summary.";
export const CUT_OFF_MESSAGE =
  "The agent's replies were cut off at the length limit twice without acting. Try again; if it repeats, the agent's instructions need a look.";

type AgentRun = typeof agentRuns.$inferSelect;
type PendingCall = { taskId: string; call: AgentToolCall };

import { HITL_TOOLS, isHitl, type HitlName } from "./hitl";
import {
  approvedPanelWords,
  panelGateFor,
  performPanelGate,
  performSubstituteGate,
  substituteGateFor,
  type PanelApprovalSubject,
  type PanelSubstituteSubject,
} from "./panel-gate.server";

/* --------------------------------------------- gates tied to real records */

type RecordSubject = { type: "requisition" | "jd" | "offer"; id: string; expects?: string };
type RejectionSubject = {
  type: "rejection";
  items: { applicationId: string; reason: string; expects?: string }[];
};
type HiringDecisionSubject = {
  type: "hiring_decision";
  applicationId: string;
  recommendation: "select" | "hold" | "reject";
  rationale: string;
  expects?: string;
};
type ScreeningDecisionSubject = {
  type: "screening_decision";
  applicationId: string;
  recommendation: "proceed" | "hold";
  rationale: string;
  expects?: string;
};
type OfferReleaseSubject = { type: "offer_release"; offerId: string; expects?: string };
type DocumentValidationSubject = {
  type: "document_validation";
  applicationId: string;
  documentIds: string[];
};
type GateSubject =
  | PanelApprovalSubject
  | PanelSubstituteSubject
  | RecordSubject
  | RejectionSubject
  | HiringDecisionSubject
  | ScreeningDecisionSubject
  | OfferReleaseSubject
  | DocumentValidationSubject;

const OFFER_APPROVER: Record<string, AppRole> = {
  pending_hr: "hr_head",
  pending_cbo: "president_cbo",
};
const OFFER_NEXT: Record<string, "pending_cbo" | "approved"> = {
  pending_hr: "pending_cbo",
  pending_cbo: "approved",
};

const DECISION_STAGES = new Set(["l1", "l2", "l3", "on_hold", "reserve", "offer_pending"]);

/** Where a candidate still is "in screening" — a screening decision applies only here. */
const SCREENING_STAGES = new Set(["applied", "ai_screened", "shortlisted", "reserve", "on_hold"]);

const TERMINAL_STAGES = new Set(["rejected", "hired", "joined", "withdrawn", "no_show"]);

/** Which role must decide `subject` now, or why it is not awaiting approval. */
type GateInfo = {
  role: AppRole | null;
  status: string;
  /** Rejection batches go to the person the agent works for. */
  toPrincipal?: boolean;
  /** A named person decides (e.g. a role's hiring manager approves its panels). */
  assigneeUserId?: string;
  /** Server-built detail appended to the agent's summary. */
  detail?: string;
  subject?: GateSubject;
};

/**
 * The candidate's own numbers against the offer, stated by the system on the
 * approval card (pure; unit-tested) — never left to the agent's brief.
 */
/** What was agreed with the candidate in a pay discussion, against the offer (pure). */
export function agreedLine(
  ctc: number,
  agreed: { agreedCtc: number; joiningBonus: number | null; cboApproved: boolean } | null,
): string {
  if (!agreed) return "";
  const match =
    ctc === agreed.agreedCtc
      ? "this offer matches it"
      : `this offer is ${rupees(Math.abs(ctc - agreed.agreedCtc))} ${ctc > agreed.agreedCtc ? "above" : "below"} it`;
  return ` Agreed with the candidate in a pay discussion: ${rupees(agreed.agreedCtc)}${agreed.joiningBonus ? ` plus a ${rupees(agreed.joiningBonus)} joining bonus` : ""}${agreed.cboApproved ? " (ceiling approved by the CBO)" : ""}; ${match}.`;
}

export function expectationLine(
  ctc: number,
  pay: {
    expectedCtc: number | null;
    currentTotal: number | null;
    noticePeriodDays: number | null;
    competingOffers: boolean | null;
    source: string | null;
  },
): string {
  if (pay.expectedCtc == null)
    return "\n\nThe candidate's expected CTC is not on record — this offer was not checked against what they asked for.";
  const gap = ctc - pay.expectedCtc;
  const where =
    gap === 0
      ? "meets it exactly"
      : gap > 0
        ? `is ${rupees(gap)} (${Math.round((gap / pay.expectedCtc) * 100)}%) above it`
        : `is ${rupees(-gap)} (${Math.round((-gap / pay.expectedCtc) * 100)}%) below it`;
  const from =
    pay.source === "candidate_form"
      ? "the candidate's form"
      : pay.source === "screening_call"
        ? "the screening call"
        : pay.source === "recruiter"
          ? "TA"
          : "the candidate profile";
  const hike =
    pay.currentTotal && pay.currentTotal > 0
      ? ` Current CTC ${rupees(pay.currentTotal)}; this offer is a ${Math.round(((ctc - pay.currentTotal) / pay.currentTotal) * 100)}% change.`
      : " Current CTC not on record.";
  return `\n\nThe candidate expects ${rupees(pay.expectedCtc)} (from ${from}); this offer ${where}.${hike}${pay.noticePeriodDays != null ? ` Notice period ${pay.noticePeriodDays} days.` : ""}${pay.competingOffers ? " They have other offers in hand." : ""}`;
}

async function gateFor(orgId: string, subject: GateSubject): Promise<GateInfo | { error: string }> {
  if (subject.type === "panel_approval") return panelGateFor(orgId, subject);
  if (subject.type === "panel_substitute") return substituteGateFor(orgId, subject);
  if (subject.type === "offer" || subject.type === "offer_release") {
    const offerId = "offerId" in subject ? subject.offerId : subject.id;
    const [o] = await db
      .select({
        status: offers.status,
        applicationId: offers.applicationId,
        ctc: offers.offeredCtc,
        joiningDate: offers.joiningDate,
        name: candidates.fullName,
        title: requisitions.title,
        budget: requisitions.budgetCtc,
        bandMin: requisitions.ctcBandMin,
        bandMax: requisitions.ctcBandMax,
      })
      .from(offers)
      .innerJoin(applications, eq(applications.id, offers.applicationId))
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
      .where(and(eq(offers.id, offerId), eq(offers.orgId, orgId)))
      .limit(1);
    if (!o) return { error: "Offer not found." };
    if (subject.type === "offer") {
      const role = OFFER_APPROVER[o.status];
      if (!role) return { error: `The offer is ${o.status}, not waiting for an approval.` };
      // Stated by the system, not left to the agent: where the CTC sits
      // against the role's approved budget and band.
      const ctc = Number(o.ctc);
      const budget = Number(o.budget ?? 0);
      const [lo, hi] = [Number(o.bandMin ?? 0), Number(o.bandMax ?? 0)];
      const vsBudget =
        budget > 0
          ? ctc > budget
            ? ` Above the role's budget of ${rupees(budget)} by ${rupees(ctc - budget)} (${Math.round(((ctc - budget) / budget) * 100)}%).`
            : ` Within the role's budget of ${rupees(budget)}.`
          : "";
      const vsBand =
        hi > 0
          ? ctc > hi || ctc < lo
            ? ` Outside the approved band ${rupees(lo)}–${rupees(hi)}.`
            : ` Inside the approved band ${rupees(lo)}–${rupees(hi)}.`
          : "";
      const { detailsFor, offerTermsMissing, listWords } =
        await import("@/lib/compensation.server");
      const missing = await offerTermsMissing(
        orgId,
        o.applicationId,
        o.joiningDate ? String(o.joiningDate) : null,
      );
      return {
        role,
        status: o.status,
        detail: `Offer for ${o.name} (${o.title}): ${rupees(ctc)} CTC — ${o.status}.${vsBudget}${vsBand}${expectationLine(ctc, await detailsFor(orgId, o.applicationId))}${agreedLine(ctc, await (await import("@/lib/negotiation.server")).agreedTerms(orgId, o.applicationId))}${
          missing.length
            ? `\n\nThis offer cannot be approved yet: ${listWords(missing)} ${missing.length > 1 ? "are" : "is"} missing. Decline it with that reason — it goes back to draft and the Offer agent collects them.`
            : ""
        }`,
      };
    }
    if (o.status !== "approved")
      return { error: `The offer is ${o.status}; only approved offers are released.` };
    const { readinessFor, docTypeLabel } = await import("@/lib/onboarding.server");
    const ready = await readinessFor(orgId, o.applicationId);
    if (!ready.ready) {
      return {
        error: `Pre-onboarding is incomplete — still missing verified: ${ready.missing.map(docTypeLabel).join(", ")}.`,
      };
    }
    return {
      role: "hr_head",
      status: o.status,
      detail: `Release the approved offer to ${o.name} (${o.title}). All required pre-onboarding documents are verified.\n\nApprove to release the offer letter; decline to hold it.`,
      subject: { ...subject, expects: o.status },
    };
  }
  if (subject.type === "document_validation") {
    const docs = await db
      .select({
        id: onboardingDocuments.id,
        docType: onboardingDocuments.docType,
        fileName: onboardingDocuments.fileName,
        status: onboardingDocuments.status,
      })
      .from(onboardingDocuments)
      .where(
        and(
          inArray(onboardingDocuments.id, subject.documentIds),
          eq(onboardingDocuments.orgId, orgId),
          eq(onboardingDocuments.applicationId, subject.applicationId),
        ),
      );
    if (docs.length !== new Set(subject.documentIds).size) {
      return { error: "Some documents were not found for this application." };
    }
    const notPending = docs.filter((d) => d.status !== "pending");
    if (notPending.length)
      return { error: `Already reviewed: ${notPending.map((d) => d.fileName).join(", ")}` };
    const { docTypeLabel } = await import("@/lib/onboarding.server");
    return {
      role: "hr_head",
      status: "pending",
      detail: `Documents to validate (${docs.length}):\n${docs.map((d) => `• ${docTypeLabel(d.docType)} — ${d.fileName}`).join("\n")}\n\nApprove to mark them verified; decline to reject them (give the reason the candidate will see).`,
    };
  }
  if (subject.type === "hiring_decision") {
    const [row] = await db
      .select({
        stage: applications.stage,
        name: candidates.fullName,
        code: requisitions.code,
        title: requisitions.title,
      })
      .from(applications)
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
      .where(and(eq(applications.id, subject.applicationId), eq(applications.orgId, orgId)))
      .limit(1);
    if (!row) return { error: "Application not found." };
    if (!DECISION_STAGES.has(row.stage)) {
      return {
        error: `The candidate is ${row.stage}; a hiring decision follows the interview rounds.`,
      };
    }
    // A select (→ offer) only after the role's final round is complete; a hold
    // or reject may come after any completed round.
    {
      const { hiringDecisionBlocked } = await import("@/lib/interview-plan.server");
      const blocked = await hiringDecisionBlocked(
        orgId,
        subject.applicationId,
        subject.recommendation,
      );
      if (blocked) return { error: blocked };
    }
    return {
      role: "hiring_manager",
      status: row.stage,
      detail: `Hiring decision for ${row.name} (${row.code} ${row.title}, ${row.stage}).\nRecommendation: ${subject.recommendation.toUpperCase()}\nRationale: ${subject.rationale}\n\nApprove to accept this recommendation; decline to leave the candidate where they are.`,
      subject: { ...subject, expects: row.stage },
    };
  }
  if (subject.type === "screening_decision") {
    const [row] = await db
      .select({
        stage: applications.stage,
        name: candidates.fullName,
        code: requisitions.code,
        title: requisitions.title,
      })
      .from(applications)
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
      .where(and(eq(applications.id, subject.applicationId), eq(applications.orgId, orgId)))
      .limit(1);
    if (!row) return { error: "Application not found." };
    if (!SCREENING_STAGES.has(row.stage))
      return {
        error: `The candidate is ${row.stage}, past screening; a screening decision no longer applies.`,
      };
    if (subject.recommendation === "hold" && row.stage === "on_hold")
      return { error: "The candidate is already on hold." };
    // Stated by the system, not left to the agent: the graded result it rests on.
    const [graded] = await db
      .select({ score: screeningRuns.screeningScore, coverage: screeningRuns.coverage })
      .from(screeningRuns)
      .where(
        and(eq(screeningRuns.orgId, orgId), eq(screeningRuns.applicationId, subject.applicationId)),
      )
      .orderBy(desc(screeningRuns.createdAt))
      .limit(1);
    if (!graded)
      return {
        error:
          "No graded screening is on record for this candidate yet — wait for the call or the assessment to be graded.",
      };
    // One decision per candidate at a time: never a second card for the same person.
    const [waiting] = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(
        and(
          eq(agentTasks.orgId, orgId),
          eq(agentTasks.status, "open"),
          eq(agentTasks.kind, "gate"),
          sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'type' = 'screening_decision'`,
          sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'applicationId' = ${subject.applicationId}`,
        ),
      )
      .limit(1);
    if (waiting)
      return { error: "A screening decision for this candidate is already waiting for a person." };
    const { coverageWords } = await import("@/lib/screening-coverage");
    const rests = graded.coverage
      ? ` (${coverageWords(graded.coverage)}; ${graded.coverage.confidence} confidence)`
      : "";
    return {
      role: null,
      status: row.stage,
      toPrincipal: true,
      detail: `Screening decision for ${row.name} (${row.code} ${row.title}).\nRecommendation: ${subject.recommendation === "proceed" ? "PROCEED to the first interview round" : "HOLD"}\nScreening score: ${graded.score}/100${rests}\nWhy: ${subject.rationale}\n\n${
        subject.recommendation === "proceed"
          ? "Approve to move them to the first interview round — the Interview coordinator then books it."
          : "Approve to put them on hold."
      } Decline to keep them in screening, or to reject them with a reason.`,
      subject: { ...subject, expects: row.stage },
    };
  }
  if (subject.type === "rejection") {
    const ids = subject.items.map((i) => i.applicationId);
    const rows = await db
      .select({
        id: applications.id,
        stage: applications.stage,
        name: candidates.fullName,
        code: requisitions.code,
      })
      .from(applications)
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
      .where(and(inArray(applications.id, ids), eq(applications.orgId, orgId)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) return { error: `Applications not found: ${missing.join(", ")}` };
    const closed = rows.filter((r) => TERMINAL_STAGES.has(r.stage));
    if (closed.length) {
      return { error: `Already closed: ${closed.map((r) => r.name).join(", ")}` };
    }
    const items = subject.items.map((i) => ({ ...i, expects: byId.get(i.applicationId)!.stage }));
    const detail = items
      .map((i) => {
        const r = byId.get(i.applicationId)!;
        return `• ${r.name} (${r.code}, ${r.stage}) — ${i.reason}`;
      })
      .join("\n");
    return {
      role: null,
      status: "batch",
      toPrincipal: true,
      detail: `Candidates to reject (${items.length}):\n${detail}`,
      subject: { type: "rejection", items },
    };
  }
  const { APPROVER_ROLE } = await import("@/lib/requisitions.server");
  if (subject.type === "requisition") {
    const [r] = await db
      .select({ status: requisitions.status })
      .from(requisitions)
      .where(and(eq(requisitions.id, subject.id), eq(requisitions.orgId, orgId)))
      .limit(1);
    if (!r) return { error: "Requisition not found." };
    const role = APPROVER_ROLE[r.status];
    if (!role) return { error: `The requisition is ${r.status}, not waiting for an approval.` };
    return { role, status: r.status };
  }
  const [jd] = await db
    .select({ status: jobDescriptions.status })
    .from(jobDescriptions)
    .where(and(eq(jobDescriptions.id, subject.id), eq(jobDescriptions.orgId, orgId)))
    .limit(1);
  if (!jd) return { error: "Job description not found." };
  if (jd.status !== "pending_dh") {
    return { error: `The job description is ${jd.status}, not waiting for review.` };
  }
  return { role: "department_head", status: jd.status };
}

/**
 * Carry out the human decision on a gate tied to a requisition or JD, as the
 * person deciding — the lifecycle core checks their role exactly as on the
 * requisition page. Throws (and the task stays open) if they may not decide.
 */
async function performGate(
  orgId: string,
  userId: string,
  subject: GateSubject,
  decision: TaskDecision,
): Promise<void> {
  const lifecycle = await import("@/lib/requisitions.server");
  const { activeOrgOf } = await import("@/lib/auth.middleware");
  const org = await activeOrgOf(userId);
  if (!org || org.orgId !== orgId) throw new Error("You are not a member of this organisation.");
  const actor = { orgId, userId, memberEmail: org.memberEmail };
  if (subject.type === "panel_approval") return performPanelGate(orgId, userId, subject, decision);
  if (subject.type === "panel_substitute")
    return performSubstituteGate(orgId, userId, org.memberEmail, subject, decision);
  if (subject.type === "offer" || subject.type === "offer_release") {
    const offerId = "offerId" in subject ? subject.offerId : subject.id;
    if (decision.status !== "approved") {
      // A declined approval step sends the offer back to draft with the
      // reason (never stuck at pending); a declined release holds it.
      if (subject.type === "offer" && decision.status === "rejected") {
        const { sendBackOfferCore } = await import("@/lib/offers.functions");
        await sendBackOfferCore(actor, {
          id: offerId,
          reason: decision.reason?.trim() || "Declined at approval — no reason given.",
        });
      }
      return;
    }
    const [o] = await db
      .select({ status: offers.status })
      .from(offers)
      .where(and(eq(offers.id, offerId), eq(offers.orgId, orgId)))
      .limit(1);
    if (!o) throw new Error("Offer not found.");
    if (subject.expects && o.status !== subject.expects) {
      throw new Error("This offer has already moved on; refresh to see its current state.");
    }
    const { advanceOfferCore } = await import("@/lib/offers.functions");
    if (subject.type === "offer_release") {
      await advanceOfferCore(actor, {
        id: offerId,
        status: "released",
        applicationStage: "offer_released",
      });
      return;
    }
    const next = OFFER_NEXT[o.status];
    if (!next) throw new Error(`The offer is ${o.status}, not waiting for an approval.`);
    await advanceOfferCore(actor, { id: offerId, status: next });
    return;
  }
  if (subject.type === "document_validation") {
    const { reviewOnboardingDocCore } = await import("@/lib/onboarding.functions");
    const note =
      decision.status === "approved"
        ? (decision.comment ?? null)
        : decision.status === "rejected"
          ? decision.reason?.trim() || "Not accepted at HR validation — please resend a clear copy."
          : null;
    for (const id of subject.documentIds) {
      const [d] = await db
        .select({ status: onboardingDocuments.status })
        .from(onboardingDocuments)
        .where(and(eq(onboardingDocuments.id, id), eq(onboardingDocuments.orgId, orgId)))
        .limit(1);
      if (!d || d.status !== "pending") continue;
      await reviewOnboardingDocCore(actor, {
        id,
        decision: decision.status === "approved" ? "verified" : "rejected",
        note,
      });
    }
    return;
  }
  if (subject.type === "hiring_decision") {
    if (decision.status !== "approved") return; // declining changes nothing
    const [app] = await db
      .select({ stage: applications.stage, candidateId: applications.candidateId })
      .from(applications)
      .where(and(eq(applications.id, subject.applicationId), eq(applications.orgId, orgId)))
      .limit(1);
    if (!app) throw new Error("Application not found.");
    if (subject.expects && app.stage !== subject.expects) {
      throw new Error("This candidate has already moved on; refresh to see their current stage.");
    }
    const pipeline = await import("@/lib/pipeline.server");
    const note =
      decision.status === "approved" && decision.comment ? ` Comment: ${decision.comment}` : "";
    if (subject.recommendation === "select") {
      await pipeline.addCandidateNoteCore(actor, {
        candidateId: app.candidateId,
        body: `Hiring decision: SELECT. ${subject.rationale}${note}`,
      });
      const { emitAgentEvent } = await import("./events");
      await emitAgentEvent({
        orgId,
        type: "hiring.selected",
        subjectType: "application",
        subjectId: subject.applicationId,
        actorUserId: userId,
        payload: { rationale: subject.rationale },
      });
      return;
    }
    await pipeline.moveStageCore(actor, {
      applicationId: subject.applicationId,
      toStage: subject.recommendation === "reject" ? "rejected" : "on_hold",
      reason: subject.rationale,
      note: note.trim() || null,
    });
    return;
  }
  if (subject.type === "screening_decision") {
    const [app] = await db
      .select({ stage: applications.stage, candidateId: applications.candidateId })
      .from(applications)
      .where(and(eq(applications.id, subject.applicationId), eq(applications.orgId, orgId)))
      .limit(1);
    if (!app) throw new Error("Application not found.");
    if (subject.expects && app.stage !== subject.expects) {
      throw new Error("This candidate has already moved on; refresh to see their current stage.");
    }
    const pipeline = await import("@/lib/pipeline.server");
    if (decision.status === "approved") {
      // A person's decision, made as that person: into L1 raises
      // application.advanced and the Interview coordinator books the round.
      await pipeline.moveStageCore(actor, {
        applicationId: subject.applicationId,
        toStage: subject.recommendation === "proceed" ? "l1" : "on_hold",
        reason: subject.rationale,
        note: decision.comment?.trim() || null,
      });
      return;
    }
    if (decision.status !== "rejected") return;
    const why = decision.reason?.trim() || null;
    if (decision.rejectCandidate) {
      if (!why) throw new Error("Say why the candidate is not moving on — it is kept on record.");
      await pipeline.moveStageCore(actor, {
        applicationId: subject.applicationId,
        toStage: "rejected",
        reason: why,
      });
      return;
    }
    await pipeline.addCandidateNoteCore(actor, {
      candidateId: app.candidateId,
      body: `Screening recommendation (${subject.recommendation}) declined — kept in screening.${why ? ` Reason: ${why}` : ""}`,
    });
    return;
  }
  if (subject.type === "rejection") {
    if (decision.status !== "approved") return; // declining rejects nobody
    const { moveStageCore } = await import("@/lib/pipeline.server");
    for (const item of subject.items) {
      const [app] = await db
        .select({ stage: applications.stage })
        .from(applications)
        .where(and(eq(applications.id, item.applicationId), eq(applications.orgId, orgId)))
        .limit(1);
      // Skip anyone who moved since the batch was proposed.
      if (!app || (item.expects && app.stage !== item.expects)) continue;
      await moveStageCore(actor, {
        applicationId: item.applicationId,
        toStage: "rejected",
        reason: item.reason,
      });
    }
    return;
  }
  const reason =
    decision.status === "rejected"
      ? (decision.reason ?? null)
      : decision.status === "approved"
        ? (decision.comment ?? null)
        : null;
  if (subject.type === "requisition") {
    const [r] = await db
      .select({ status: requisitions.status })
      .from(requisitions)
      .where(and(eq(requisitions.id, subject.id), eq(requisitions.orgId, orgId)))
      .limit(1);
    if (!r) throw new Error("Requisition not found.");
    if (subject.expects && r.status !== subject.expects) {
      throw new Error("This requisition has already moved on; refresh to see its current state.");
    }
    if (decision.status === "rejected" && decision.changes) {
      // Sent back for changes (not final): draft again, the reason on the trail.
      await lifecycle.sendBackRequisitionCore(actor, {
        id: subject.id,
        reason: decision.reason?.trim() || "Changes requested.",
      });
      return;
    }
    const to =
      decision.status === "approved" ? lifecycle.NEXT_APPROVAL[r.status] : ("rejected" as const);
    if (!to) throw new Error(`The requisition is ${r.status}, not waiting for an approval.`);
    await lifecycle.advanceRequisitionCore(actor, { id: subject.id, status: to, comment: reason });
    return;
  }
  if (decision.status === "approved") {
    await lifecycle.approveJobDescriptionCore(actor, { id: subject.id });
  } else {
    await lifecycle.requestJdChangesCore(actor, {
      id: subject.id,
      comment: reason?.trim() || "Changes requested.",
    });
  }
}

/**
 * Close gate tasks whose requisition or JD was decided outside the inbox
 * (e.g. on the requisition page), so the waiting agent run carries on.
 */
export async function syncGateTasks(
  orgId: string,
  subject: { type: "requisition" | "jd" | "offer"; id: string },
  decidedBy: string | null,
  /** The status the event moved the record away from; only gates waiting on it close. */
  fromStatus: string,
): Promise<number> {
  const open = await db
    .select()
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.orgId, orgId),
        eq(agentTasks.status, "open"),
        eq(agentTasks.kind, "gate"),
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'id' = ${subject.id}`,
      ),
    );
  let closed = 0;
  for (const t of open) {
    const expects = (t.proposedAction as { args?: { subject?: RecordSubject } } | null)?.args
      ?.subject?.expects;
    const current =
      subject.type === "offer"
        ? (
            await db
              .select({ status: offers.status })
              .from(offers)
              .where(eq(offers.id, subject.id))
              .limit(1)
          )[0]?.status
        : subject.type === "requisition"
          ? (
              await db
                .select({ status: requisitions.status })
                .from(requisitions)
                .where(eq(requisitions.id, subject.id))
                .limit(1)
            )[0]?.status
          : (
              await db
                .select({ status: jobDescriptions.status })
                .from(jobDescriptions)
                .where(eq(jobDescriptions.id, subject.id))
                .limit(1)
            )[0]?.status;
    if (expects !== fromStatus || !current || current === expects) continue;
    // An offer sent back from an approval step returns to draft: that is a decline.
    const declined =
      current === "rejected" ||
      current === "changes_requested" ||
      ((subject.type === "offer" || subject.type === "requisition") && current === "draft");
    const now = new Date();
    // A requisition sent back for changes carries what to change (its trail's last entry).
    const sentBack =
      subject.type === "requisition" && current === "draft"
        ? await (async () => {
            const [r] = await db
              .select({ trail: requisitions.approvalTrail })
              .from(requisitions)
              .where(eq(requisitions.id, subject.id))
              .limit(1);
            const last = (Array.isArray(r?.trail) ? r.trail : []).at(-1) as
              { decision?: string; comment?: string } | undefined;
            return last?.decision === "sent_back" ? (last.comment ?? "Changes requested.") : null;
          })()
        : null;
    const done = await db
      .update(agentTasks)
      .set({
        status: declined ? "rejected" : "approved",
        response: (sentBack
          ? { status: "rejected", reason: sentBack, changes: true }
          : {
              status: declined ? "rejected" : "approved",
              [declined ? "reason" : "comment"]: `Decided outside the inbox (now ${current}).`,
            }) as never,
        decidedBy,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentTasks.id, t.id), eq(agentTasks.status, "open")))
      .returning({ id: agentTasks.id });
    if (!done.length) continue;
    closed++;
    await requeueIfUnblocked(t.runId);
  }
  return closed;
}

async function requeueIfUnblocked(runId: string) {
  const [stillOpen] = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, "open")))
    .limit(1);
  if (stillOpen) return;
  await db
    .update(agentRuns)
    .set({ status: "queued", updatedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "awaiting_human")));
}

/* ------------------------------------------------------------ public API */

/** Queue a new run. The goal must not embed untrusted text without untrusted(). */
export async function startRun(input: {
  orgId: string;
  agentType: AgentType;
  principalUserId: string;
  goal: string;
  subjectType?: string | null;
  subjectId?: string | null;
  triggerEventId?: string | null;
  maxSteps?: number;
  /** Hiring-desk thread; defaults to the thread of the subject's requisition. */
  conversationId?: string | null;
}): Promise<{ runId: string }> {
  const def = getAgent(input.agentType);
  if (!def) throw new Error(`Unknown agent: ${input.agentType}`);
  const definition = await ensureDefinition(def);
  let conversationId = input.conversationId ?? null;
  if (!conversationId && input.subjectId) {
    try {
      const { conversationForSubject } = await import("../desk/desk.server");
      conversationId = await conversationForSubject(
        input.orgId,
        input.subjectType,
        input.subjectId,
      );
    } catch (e) {
      log.warn("desk.link_failed", { org_id: input.orgId, error: e as Error });
    }
  }
  const startPolicy = await loadPolicy(input.orgId, input.agentType);
  const [run] = await db
    .insert(agentRuns)
    .values({
      definitionId: definition.id,
      definitionVersion: definition.version,
      definitionHash: definition.hash,
      orgId: input.orgId,
      agentType: input.agentType,
      principalUserId: input.principalUserId,
      goal: input.goal,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      triggerEventId: input.triggerEventId ?? null,
      maxSteps: input.maxSteps ?? startPolicy.maxStepsPerLeg ?? def.maxSteps ?? 20,
      ...(startPolicy.maxTokensPerLeg ? { maxTokens: startPolicy.maxTokensPerLeg } : {}),
      conversationId,
      transcript: [{ role: "user", content: input.goal } satisfies AgentMessage],
    })
    .returning({ id: agentRuns.id });
  await writeAudit({
    actor: `agent:${input.agentType}:${run!.id}`,
    actorUserId: input.principalUserId,
    orgId: input.orgId,
    action: "agent.run.started",
    entityType: "agent_run",
    entityId: run!.id,
    detail: {
      on_behalf_of: input.principalUserId,
      definition_version: definition.version,
      definition_hash: definition.hash,
      subject: input.subjectId ? { type: input.subjectType ?? null, id: input.subjectId } : null,
      trigger_event_id: input.triggerEventId ?? null,
    },
  });
  return { runId: run!.id };
}

/** Statuses a run can be replayed from. */
const REPLAYABLE = new Set(["done", "failed", "cancelled"]);

/**
 * Queue a dry-run replay of a finished live run (docs/agentic-plan.md §11):
 * the same goal under the agent's current definition and the org's current
 * model settings. Read tools run for real; write, external and human steps
 * are simulated, so a replay changes nothing and asks nobody. Compare it with
 * the original via `compareRuns`.
 */
export async function startReplay(input: {
  orgId: string;
  runId: string;
  userId: string;
}): Promise<{ runId: string }> {
  const [orig] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.orgId, input.orgId)))
    .limit(1);
  if (!orig) throw new Error("Run not found");
  if (orig.mode !== "live") throw new Error("Replay the original run, not a replay.");
  if (!REPLAYABLE.has(orig.status)) throw new Error("Only finished runs can be replayed.");
  const def = getAgent(orig.agentType);
  if (!def) throw new Error(`Unknown agent: ${orig.agentType}`);
  const definition = await ensureDefinition(def);
  const [run] = await db
    .insert(agentRuns)
    .values({
      definitionId: definition.id,
      definitionVersion: definition.version,
      definitionHash: definition.hash,
      orgId: orig.orgId,
      agentType: orig.agentType,
      // Reads run with the requester's own permissions.
      principalUserId: input.userId,
      goal: orig.goal,
      subjectType: orig.subjectType,
      subjectId: orig.subjectId,
      maxSteps: orig.maxSteps,
      mode: "replay",
      replayOf: orig.id,
      transcript: [{ role: "user", content: orig.goal } satisfies AgentMessage],
    })
    .returning({ id: agentRuns.id });
  await writeAudit({
    actor: `user:${input.userId}`,
    actorUserId: input.userId,
    orgId: input.orgId,
    action: "agent.run.replay_started",
    entityType: "agent_run",
    entityId: run!.id,
    detail: {
      replay_of: orig.id,
      original_definition_hash: orig.definitionHash,
      definition_version: definition.version,
      definition_hash: definition.hash,
    },
  });
  return { runId: run!.id };
}

export type TaskDecision =
  | { status: "approved"; args?: unknown; comment?: string | undefined }
  | {
      status: "rejected";
      reason?: string | undefined;
      /** Sent back with changes to make (from the hiring desk), not refused outright. */
      changes?: boolean | undefined;
      /** A screening decision declined by rejecting the candidate (a person's decision, with a reason). */
      rejectCandidate?: boolean | undefined;
    }
  | { status: "answered"; answer: string };

/**
 * Record a person's decision on an open task and re-queue the run when no
 * other decision is outstanding. The decider must hold the task's role (the
 * org owner passes) or be its named assignee.
 */
export async function resolveTask(input: {
  orgId: string;
  taskId: string;
  userId: string;
  decision: TaskDecision;
}): Promise<void> {
  const [task] = await db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.id, input.taskId), eq(agentTasks.orgId, input.orgId)))
    .limit(1);
  if (!task) throw new Error("Task not found");
  if (task.status !== "open") throw new Error("This task has already been decided.");
  if (task.assigneeUserId && task.assigneeUserId !== input.userId) {
    // The named person decides; the organisation's owner may too (as the desk shows).
    const { activeOrgOf } = await import("@/lib/auth.middleware");
    const org = await activeOrgOf(input.userId);
    if (!org || org.orgId !== input.orgId || !org.isOwner)
      throw new Error("This task is assigned to someone else.");
  }
  if (task.assigneeRole) await assertRole(input.userId, input.orgId, task.assigneeRole as AppRole);
  const { decision } = input;
  if (task.kind === "clarification" && decision.status !== "answered") {
    throw new Error("Answer the question to continue.");
  }
  if (task.kind !== "clarification" && decision.status === "answered") {
    throw new Error("Approve or reject this request.");
  }

  // A gate tied to a requisition or JD performs the real approval step first;
  // if the decider may not make it, this throws and the task stays open.
  const gateSubject = (task.proposedAction as { args?: { subject?: GateSubject } } | null)?.args
    ?.subject;
  if (task.kind === "gate" && gateSubject) {
    await performGate(input.orgId, input.userId, gateSubject, decision);
  }

  const now = new Date();
  const updated = await db
    .update(agentTasks)
    .set({
      status: decision.status,
      response: decision as never,
      decidedBy: input.userId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, "open")))
    .returning({ id: agentTasks.id });
  if (!updated.length) {
    // The gate's own event can close the task first ("decided outside the
    // inbox") while this decision is being applied: the person's decision —
    // their status and reason — is the record, so it takes the task over.
    const takenOver =
      task.kind === "gate" && gateSubject
        ? await db
            .update(agentTasks)
            .set({
              status: decision.status,
              response: decision as never,
              decidedBy: input.userId,
              decidedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(agentTasks.id, task.id),
                sql`coalesce(${agentTasks.response} ->> 'comment', ${agentTasks.response} ->> 'reason') like 'Decided outside the inbox%'`,
              ),
            )
            .returning({ id: agentTasks.id })
        : [];
    if (!takenOver.length) throw new Error("This task has already been decided.");
  }

  await writeAudit({
    actor: `user:${input.userId}`,
    actorUserId: input.userId,
    orgId: input.orgId,
    action: `agent.task.${decision.status}`,
    entityType: "agent_task",
    entityId: task.id,
    detail: {
      run_id: task.runId,
      kind: task.kind,
      edited: decision.status === "approved" && decision.args !== undefined,
    },
  });

  // Training data: a person's judgement on what the agent proposed. An edit is
  // a correction (what the agent should have proposed); a decline carries why.
  {
    const proposed = (task.proposedAction as { args?: unknown } | null)?.args;
    const [run] = await db
      .select({ subjectType: agentRuns.subjectType, subjectId: agentRuns.subjectId })
      .from(agentRuns)
      .where(eq(agentRuns.id, task.runId))
      .limit(1);
    const { captureFeedback } = await import("../training/capture.server");
    await captureFeedback({
      orgId: input.orgId,
      source: task.kind === "clarification" ? "clarification" : "task_decision",
      label:
        decision.status === "answered"
          ? "answered"
          : decision.status === "approved"
            ? decision.args !== undefined
              ? "edited"
              : "approved"
            : decision.changes
              ? "changes_requested"
              : "rejected",
      reason:
        decision.status === "rejected"
          ? (decision.reason ?? null)
          : decision.status === "approved"
            ? (decision.comment ?? null)
            : null,
      original: { kind: task.kind, title: task.title, body: task.body, proposed: proposed ?? null },
      corrected:
        decision.status === "answered"
          ? { answer: decision.answer }
          : decision.status === "approved" && decision.args !== undefined
            ? { args: decision.args }
            : undefined,
      agentRunId: task.runId,
      agentTaskId: task.id,
      proposedAt: task.createdAt,
      applicationId: run?.subjectType === "application" ? run.subjectId : null,
      requisitionId: run?.subjectType === "requisition" ? run.subjectId : null,
      actorUserId: input.userId,
    });
  }

  await requeueIfUnblocked(task.runId);
}

/** Stop a run and close its open tasks. */
export async function cancelRun(input: { orgId: string; runId: string; userId: string }) {
  const now = new Date();
  const done = await db
    .update(agentRuns)
    .set({ status: "cancelled", finishedAt: now, updatedAt: now, leaseUntil: null })
    .where(
      and(
        eq(agentRuns.id, input.runId),
        eq(agentRuns.orgId, input.orgId),
        inArray(agentRuns.status, ["queued", "running", "awaiting_human"]),
      ),
    )
    .returning({ id: agentRuns.id });
  if (!done.length) return;
  await db
    .update(agentTasks)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(agentTasks.runId, input.runId), eq(agentTasks.status, "open")));
  await writeAudit({
    actor: `user:${input.userId}`,
    actorUserId: input.userId,
    orgId: input.orgId,
    action: "agent.run.cancelled",
    entityType: "agent_run",
    entityId: input.runId,
  });
}

export type TickCounts = {
  events: number;
  reclaimed: number;
  claimed: number;
  done: number;
  awaiting: number;
  yielded: number;
  failed: number;
};

/** One scheduler tick: reclaim expired leases, claim queued runs, drive them. */
/** `orgId` limits the tick to one organisation (eval harness); the scheduler omits it. */
export async function runAgentTick(
  opts: {
    max?: number;
    orgId?: string;
    /**
     * Drive only this run — no events, no sweeps, no other runs (evals: a sweep
     * starting another run would take the scripted model's replies).
     */
    onlyRunId?: string;
  } = {},
): Promise<TickCounts> {
  const max = Math.min(Math.max(opts.max ?? 10, 1), 50);
  const counts: TickCounts = {
    events: 0,
    reclaimed: 0,
    claimed: 0,
    done: 0,
    awaiting: 0,
    yielded: 0,
    failed: 0,
  };
  const now = new Date();

  // 0. Turn lifecycle events into agent runs and close gates decided elsewhere.
  if (!opts.onlyRunId)
    try {
      const { processAgentEvents } = await import("./orchestrator.server");
      counts.events = (await processAgentEvents(opts.orgId ? { orgId: opts.orgId } : {})).processed;
      const { scheduleSweeps } = await import("./orchestrator.server");
      await scheduleSweeps(opts.orgId ? { orgId: opts.orgId } : {});
    } catch (e) {
      log.error("agent.orchestrator.failed", { error: e instanceof Error ? e : String(e) });
    }

  // 1. Reclaim runs whose worker died mid-turn; give up after MAX_ATTEMPTS.
  const expired = await db
    .update(agentRuns)
    .set({
      status: sql`case when ${agentRuns.attempts} + 1 >= ${MAX_ATTEMPTS} then 'failed' else 'queued' end`,
      attempts: sql`${agentRuns.attempts} + 1`,
      lastError: "The worker stopped before finishing this step.",
      leaseUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentRuns.status, "running"),
        lt(agentRuns.leaseUntil, now),
        opts.orgId ? eq(agentRuns.orgId, opts.orgId) : undefined,
      ),
    )
    .returning({ id: agentRuns.id });
  counts.reclaimed = expired.length;

  // 2. Claim queued runs of agents the org has switched on (opt-in) and not
  //    paused org-wide; disjoint across workers.
  const paused = db
    .select({ one: sql`1` })
    .from(agentPolicies)
    .where(
      and(
        eq(agentPolicies.orgId, agentRuns.orgId),
        eq(agentPolicies.agentType, "*"),
        eq(agentPolicies.enabled, false),
      ),
    );
  const switchedOn = db
    .select({ one: sql`1` })
    .from(agentPolicies)
    .where(
      and(
        eq(agentPolicies.orgId, agentRuns.orgId),
        sql`${agentPolicies.agentType} = ${agentRuns.agentType}`,
        eq(agentPolicies.enabled, true),
      ),
    );
  const dueIds = db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "queued"),
        // leaseUntil on a queued run is a "not before" (budget pause).
        sql`(${agentRuns.leaseUntil} is null or ${agentRuns.leaseUntil} < now())`,
        sql`not exists (${paused})`,
        // A dry-run replay changes nothing, so it does not need the agent switched on.
        sql`(${agentRuns.mode} = 'replay' or exists (${switchedOn}))`,
        opts.orgId ? eq(agentRuns.orgId, opts.orgId) : undefined,
        opts.onlyRunId ? eq(agentRuns.id, opts.onlyRunId) : undefined,
      ),
    )
    .orderBy(agentRuns.updatedAt)
    .limit(max)
    .for("update", { skipLocked: true });
  const claimed = await db
    .update(agentRuns)
    .set({
      status: "running",
      leaseUntil: new Date(now.getTime() + LEASE_MINUTES * 60_000),
      startedAt: sql`coalesce(${agentRuns.startedAt}, now())`,
      updatedAt: now,
    })
    .where(inArray(agentRuns.id, dueIds))
    .returning();
  counts.claimed = claimed.length;

  // 3. Drive them.
  const queue = [...claimed];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let run = queue.shift(); run; run = queue.shift()) {
      const started = Date.now();
      const runLog = log.child({
        trace_id: run.traceId,
        run_id: run.id,
        org_id: run.orgId,
        agent: run.agentType,
      });
      const scoped = run;
      const outcome = await agentRunScope
        .run({ runId: scoped.id, orgId: scoped.orgId, agentType: scoped.agentType }, () =>
          driveRun(scoped),
        )
        .catch(async (e: unknown) => {
          runLog.error("agent.run.crashed", { error: e instanceof Error ? e : String(e) });
          await finish(run!, "failed", null, e instanceof Error ? e.message : String(e));
          return "failed" as const;
        });
      runLog.info("agent.run.turn", { outcome, duration_ms: Date.now() - started });
      counts[outcome]++;
    }
  });
  await Promise.all(workers);

  // 4. Keep today's dashboard rollup fresh (cheap: only orgs with recent activity).
  try {
    const { rollupAgentMetrics } = await import("./metrics.server");
    await rollupAgentMetrics();
  } catch (e) {
    log.error("agent.metrics.rollup_failed", { error: e instanceof Error ? e : String(e) });
  }
  if (counts.claimed || counts.reclaimed || counts.events) log.info("agent.tick", counts);

  // 5. Liveness heartbeat, and the health engine every few minutes. Only the
  //    scheduler's org-wide tick counts — not inline per-org kicks.
  if (!opts.orgId) {
    try {
      const { heartbeatAndMaybeEvaluate } = await import("./health.server");
      await heartbeatAndMaybeEvaluate(counts);
    } catch (e) {
      log.error("agent.health.failed", { error: e instanceof Error ? e : String(e) });
    }
  }

  // 6. Trace export to organisations' own OpenTelemetry collectors.
  if (!opts.orgId) {
    try {
      const { exportAgentTraces } = await import("./otel.server");
      const x = await exportAgentTraces();
      if (x.runs) log.info("agent.otel.exported", x);
    } catch (e) {
      log.error("agent.otel.failed", { error: e instanceof Error ? e : String(e) });
    }
  }
  return counts;
}

/* -------------------------------------------------------------- internals */

async function driveRun(run: AgentRun): Promise<"done" | "awaiting" | "yielded" | "failed"> {
  const def = getAgent(run.agentType);
  if (!def) {
    await finish(run, "failed", null, `Unknown agent: ${run.agentType}`);
    return "failed";
  }
  const policy = await loadPolicy(run.orgId, run.agentType);
  const ctx: ToolContext = {
    orgId: run.orgId,
    principalUserId: run.principalUserId,
    runId: run.id,
    agentType: run.agentType,
    actor: `agent:${run.agentType}:${run.id}`,
  };
  const transcript = [...(run.transcript as AgentMessage[])];
  let seq = await nextSeq(run.id);
  let stepCount = run.stepCount;
  let tokensUsed = run.tokensUsed;

  // Resume: turn each decided task into the tool result the model is waiting for.
  if (run.pending) {
    for (const p of run.pending as PendingCall[]) {
      const [task] = await db.select().from(agentTasks).where(eq(agentTasks.id, p.taskId)).limit(1);
      const message = await applyDecision(ctx, task, p.call, seq++);
      transcript.push(message);
    }
    // A person decided: the next stretch of work gets a fresh allowance.
    if ((run.pending as PendingCall[]).length) {
      run.legStepStart = stepCount;
      run.legTokenStart = tokensUsed;
      await db
        .update(agentRuns)
        .set({ legStepStart: stepCount, legTokenStart: tokensUsed })
        .where(eq(agentRuns.id, run.id));
    }
  }

  const allowed = new Set(def.tools);
  const specs: AgentToolSpec[] = [
    ...def.tools.flatMap((name) => {
      const t = getTool(name);
      return t ? [{ name, description: t.description, parameters: toolParameters(t.input) }] : [];
    }),
    ...(Object.keys(HITL_TOOLS) as HitlName[]).map((name) => ({
      name,
      description: HITL_TOOLS[name].description,
      parameters: toolParameters(HITL_TOOLS[name].input),
    })),
  ];
  const system = `${INJECTION_RULES}\n\n${RUNTIME_RULES}\n\n${def.system}`;

  // A deploy may have changed the agent since this run started: record the
  // definition the remaining steps execute under.
  if (run.definitionHash !== manifestHash(def)) {
    const d = await ensureDefinition(def);
    await db
      .update(agentRuns)
      .set({ definitionId: d.id, definitionVersion: d.version, definitionHash: d.hash })
      .where(eq(agentRuns.id, run.id));
    await writeAudit({
      actor: ctx.actor,
      actorUserId: run.principalUserId,
      orgId: run.orgId,
      action: "agent.run.definition_changed",
      entityType: "agent_run",
      entityId: run.id,
      detail: { from: run.definitionHash, to: d.hash, version: d.version },
    });
    run.definitionHash = d.hash;
  }

  // Back under budget: the pause is over, so it must not read as paused later.
  if (
    run.lastError === BUDGET_PAUSE_MESSAGE &&
    !(await overBudget(run, policy.monthlyTokenBudget))
  ) {
    await db.update(agentRuns).set({ lastError: null }).where(eq(agentRuns.id, run.id));
    run.lastError = null;
  }
  for (let turn = 0; turn < TURNS_PER_TICK; turn++) {
    if (await overBudget(run, policy.monthlyTokenBudget)) {
      await save(run, transcript, null, stepCount, tokensUsed);
      await pauseForBudget(run);
      return "yielded";
    }
    const reached = limitReached({
      stepCount,
      tokensUsed,
      legStepStart: run.legStepStart,
      legTokenStart: run.legTokenStart,
      // The organisation's raised limits apply to runs already under way.
      maxSteps: policy.maxStepsPerLeg ?? run.maxSteps,
      maxTokens: policy.maxTokensPerLeg ?? run.maxTokens,
    });
    if (reached) {
      await save(run, transcript, null, stepCount, tokensUsed);
      await finish(
        run,
        "failed",
        null,
        reached === "ceiling" ? CEILING_MESSAGE : LEG_LIMIT_MESSAGE,
      );
      return "failed";
    }

    const started = Date.now();
    const res = await aiAgentStep({
      system,
      messages: compactForModel(transcript),
      tools: specs,
      orgId: run.orgId,
      feature: def.feature,
      ...(modelOverride ? { config: modelOverride } : {}),
    });
    stepCount++;
    if (!res.ok) {
      await recordStep(run, seq++, {
        kind: "model",
        status: "error",
        output: { error: res.message },
        durationMs: Date.now() - started,
      });
      await save(run, transcript, null, stepCount, tokensUsed);
      const retriable = res.status === 429 || res.status >= 500;
      if (retriable && run.attempts + 1 < MAX_ATTEMPTS) {
        await db
          .update(agentRuns)
          .set({
            status: "queued",
            attempts: run.attempts + 1,
            lastError: res.message,
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        return "yielded";
      }
      await finish(run, "failed", null, res.message);
      return "failed";
    }

    tokensUsed += res.usage?.totalTokens ?? 0;
    await recordStep(run, seq++, {
      kind: "model",
      status: "ok",
      output: {
        text: preview(res.text),
        toolCalls: res.toolCalls.map((c) => c.name),
        stopReason: res.stopReason,
      },
      promptTokens: res.usage?.promptTokens ?? 0,
      completionTokens: res.usage?.completionTokens ?? 0,
      durationMs: Date.now() - started,
    });
    transcript.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

    if (!res.toolCalls.length) {
      // Cut off at the output limit is not an answer (a real run thought aloud until it
      // ran out, never called its tool and was marked done with the fragment as its
      // summary): nudge once, then fail with the reason instead of a false "done".
      if (res.stopReason === "max_tokens") {
        const nudged = transcript.some((m) => m.role === "user" && m.content === CUT_OFF_NUDGE);
        if (nudged) {
          await save(run, transcript, null, stepCount, tokensUsed);
          await finish(run, "failed", null, CUT_OFF_MESSAGE);
          return "failed";
        }
        transcript.push({ role: "user", content: CUT_OFF_NUDGE });
        continue;
      }
      await save(run, transcript, null, stepCount, tokensUsed);
      await finish(run, "done", res.text.trim() || "Done.", null);
      return "done";
    }

    const pending: PendingCall[] = [];
    for (const call of res.toolCalls) {
      const outcome = await handleCall(run, ctx, policy, allowed, call, seq++);
      if (outcome.kind === "message") transcript.push(outcome.message);
      else if (outcome.kind === "pending") pending.push({ taskId: outcome.taskId, call });
      else {
        // handoff: close the turn so the transcript stays well-formed.
        transcript.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: "Handed off.",
        });
        await save(run, transcript, null, stepCount, tokensUsed);
        await finish(run, "done", `Handed off: ${outcome.reason}`, null);
        return "done";
      }
    }

    if (pending.length) {
      await save(run, transcript, pending, stepCount, tokensUsed);
      await db
        .update(agentRuns)
        .set({ status: "awaiting_human", leaseUntil: null, updatedAt: new Date() })
        .where(eq(agentRuns.id, run.id));
      return "awaiting";
    }
  }

  // Yield the worker; the run continues on the next tick.
  await save(run, transcript, null, stepCount, tokensUsed);
  await db
    .update(agentRuns)
    .set({ status: "queued", leaseUntil: null, updatedAt: new Date() })
    .where(eq(agentRuns.id, run.id));
  return "yielded";
}

type CallOutcome =
  | { kind: "message"; message: AgentMessage }
  | { kind: "pending"; taskId: string }
  | { kind: "handoff"; reason: string };

async function handleCall(
  run: AgentRun,
  ctx: ToolContext,
  policy: Awaited<ReturnType<typeof loadPolicy>>,
  allowed: Set<string>,
  call: AgentToolCall,
  seq: number,
): Promise<CallOutcome> {
  /** `refused`: a rule or guardrail said no (not a failure of the agent or the system). */
  const toolError = async (message: string, refused = false): Promise<CallOutcome> => {
    await recordStep(run, seq, {
      kind: "tool",
      toolName: call.name,
      toolCallId: call.id,
      status: "error",
      input: redactArgs(call.args),
      output: refused ? { error: message, refused: true } : { error: message },
    });
    return {
      kind: "message",
      message: {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: message,
        isError: true,
      },
    };
  };

  if (call.args && typeof call.args === "object" && INVALID_TOOL_ARGS in call.args) {
    return toolError("The tool arguments were not valid JSON. Send a JSON object.");
  }

  if (isHitl(call.name)) {
    const parsed = HITL_TOOLS[call.name].input.safeParse(call.args);
    if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.message}`);
    if (call.name === "handoff") {
      const { reason } = parsed.data as { reason: string };
      await recordStep(run, seq, {
        kind: "decision",
        toolName: call.name,
        toolCallId: call.id,
        status: "ok",
        input: { reason: preview(reason) },
      });
      return { kind: "handoff", reason };
    }
    if (run.mode === "replay" && call.name === "ask_human") {
      return simulated(
        run,
        call,
        seq,
        "No person is available in a dry-run replay. Continue with your best judgement and state any assumption you make.",
      );
    }
    const data = parsed.data as {
      question?: string;
      title?: string;
      summary?: string;
      assignee_role?: AppRole;
    };
    return openDecision(run, call, seq, toolError, {
      kind: call.name === "ask_human" ? "clarification" : "gate",
      title: data.title ?? "The agent has a question",
      summary: data.summary ?? data.question ?? "",
      assigneeRole: data.assignee_role ?? null,
      subject:
        call.name === "request_approval"
          ? (parsed.data as { subject?: GateSubject }).subject
          : undefined,
    });
  }

  const tool = allowed.has(call.name) ? getTool(call.name) : undefined;
  if (!tool) return toolError(`Unknown tool: ${call.name}`);
  const parsed = tool.input.safeParse(call.args);
  if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.message}`);

  if (tool.precheck && tool.risk !== "read") {
    const refusal = await tool.precheck(ctx, parsed.data);
    if (refusal) return toolError(refusal, true);
  }

  // A proposal never runs by itself: whatever the autonomy, a person decides.
  if (tool.proposes) {
    const p = await tool.proposes(ctx, parsed.data);
    return openDecision(run, call, seq, toolError, {
      kind: "gate",
      title: p.title,
      summary: p.summary,
      assigneeRole: null,
      subject: p.subject as GateSubject,
    });
  }

  const verdict = decideToolCall(tool.risk, policy, tool.templateOf?.(parsed.data) ?? null);
  if (run.mode === "replay" && tool.risk !== "read") {
    return simulated(
      run,
      call,
      seq,
      `${tool.name} was not executed (simulated success). In a live run it would ${verdict === "run" ? "run now" : "wait for a person's approval"}.`,
      { args: redactArgs(parsed.data), wouldRun: verdict === "run" },
    );
  }
  if (verdict === "approve") {
    const taskId = await openTask(run, {
      kind: "approval",
      title: tool.describe?.(parsed.data) ?? `Allow the agent to run ${tool.name}`,
      body: tool.brief ? await tool.brief(ctx, parsed.data).catch(() => "") : "",
      // Most approvals go to the person the agent works for; some tools name
      // the role that must approve them (e.g. job-board posts → HR head).
      assigneeRole: tool.approverRole ?? null,
      ...(tool.approverRole ? { assigneeUserId: null } : {}),
      proposedAction: { toolCallId: call.id, name: call.name, args: parsed.data },
    });
    await recordStep(run, seq, {
      kind: "tool",
      toolName: call.name,
      toolCallId: call.id,
      status: "awaiting",
      input: redactArgs(parsed.data),
      output: { taskId },
    });
    return { kind: "pending", taskId };
  }

  // act_and_notify: the action runs now and the person the agent works for is told.
  const notify = tool.risk !== "read" && policy.autonomy === "act_and_notify";
  return {
    kind: "message",
    message: await execute(run, ctx, tool.name, call, parsed.data, seq, notify),
  };
}

/**
 * Ask a person: a question, or a decision on a gate. A gate subject is checked
 * by the system first (who decides, the facts on the card, or a refusal).
 */
async function openDecision(
  run: AgentRun,
  call: AgentToolCall,
  seq: number,
  toolError: (message: string, refused?: boolean) => Promise<CallOutcome>,
  d: {
    kind: AgentTaskKind;
    title: string;
    summary: string;
    assigneeRole: AppRole | null;
    subject: GateSubject | undefined;
  },
): Promise<CallOutcome> {
  let assigneeRole = d.assigneeRole;
  let args: unknown = call.args;
  let assigneeUserId: string | undefined;
  let detail = "";
  if (d.subject) {
    const gate = await gateFor(run.orgId, d.subject);
    if ("error" in gate) return toolError(gate.error, true);
    if (run.mode === "replay") {
      return simulated(run, call, seq, "Approval simulated as granted; nothing was changed.", {
        gate: gate.role,
      });
    }
    assigneeRole = gate.role;
    assigneeUserId = gate.assigneeUserId ?? (gate.toPrincipal ? run.principalUserId : undefined);
    detail = gate.detail ?? "";
    args = {
      ...(call.args as object),
      subject: gate.subject ?? { ...d.subject, expects: gate.status },
    };
  }
  const taskId = await openTask(run, {
    kind: d.kind,
    title: d.title,
    body: [d.summary, detail].filter(Boolean).join("\n\n"),
    assigneeRole,
    proposedAction: { toolCallId: call.id, name: call.name, args },
    ...(assigneeUserId ? { assigneeUserId } : {}),
  });
  await recordStep(run, seq, {
    kind: "tool",
    toolName: call.name,
    toolCallId: call.id,
    status: "awaiting",
    input: redactArgs(call.args),
    output: { taskId },
  });
  return { kind: "pending", taskId };
}

/** Dry-run replay: record a step the live run would have taken and tell the model it "happened". */
async function simulated(
  run: AgentRun,
  call: AgentToolCall,
  seq: number,
  message: string,
  output: Record<string, unknown> = {},
): Promise<CallOutcome> {
  await recordStep(run, seq, {
    kind: "tool",
    toolName: call.name,
    toolCallId: call.id,
    status: "simulated",
    input: redactArgs(call.args),
    output,
  });
  return {
    kind: "message",
    message: {
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: `[Dry-run replay] ${message}`,
    },
  };
}

/** Run an allowed tool and turn its result (or failure) into a tool message. */
async function execute(
  run: AgentRun,
  ctx: ToolContext,
  name: string,
  call: AgentToolCall,
  args: unknown,
  seq: number,
  notify = false,
): Promise<AgentMessage> {
  const tool = getTool(name)!;
  const started = Date.now();
  try {
    // A tool working on one candidate / role: its AI calls count towards them.
    const a = (args ?? {}) as { applicationId?: unknown; requisitionId?: unknown };
    const { withAiSubject } = await import("./context");
    const result = await withAiSubject(
      {
        applicationId: typeof a.applicationId === "string" ? a.applicationId : null,
        requisitionId: typeof a.requisitionId === "string" ? a.requisitionId : null,
      },
      () => tool.run(ctx, args),
    );
    const raw = typeof result === "string" ? result : JSON.stringify(result ?? null);
    const content = tool.untrustedOutput ? untrusted(`${name} result`, raw) : raw;
    const injection = Boolean(tool.untrustedOutput) && looksLikeInjection(raw);
    await recordStep(run, seq, {
      kind: "tool",
      toolName: name,
      toolCallId: call.id,
      status: "ok",
      input: redactArgs(args),
      output: tool.untrustedOutput ? { chars: raw.length } : { preview: preview(raw) },
      durationMs: Date.now() - started,
      ...(notify ? { notifyState: "pending" as const } : {}),
      injectionSuspected: injection,
    });
    if (injection) {
      log.warn("agent.injection.suspected", {
        trace_id: run.traceId,
        run_id: run.id,
        org_id: run.orgId,
        agent: run.agentType,
        tool: name,
      });
      await writeAudit({
        actor: ctx.actor,
        actorUserId: ctx.principalUserId,
        orgId: ctx.orgId,
        action: "agent.injection.suspected",
        entityType: "agent_run",
        entityId: ctx.runId,
        detail: { tool: name, seq },
      });
    }
    if (tool.risk !== "read") {
      await writeAudit({
        actor: ctx.actor,
        actorUserId: ctx.principalUserId,
        orgId: ctx.orgId,
        action: `agent.tool.${name}`,
        entityType: "agent_run",
        entityId: ctx.runId,
        detail: { on_behalf_of: ctx.principalUserId, risk: tool.risk },
      });
    }
    return { role: "tool", toolCallId: call.id, name, content };
  } catch (e) {
    const message = e instanceof Error ? e.message : "The tool failed.";
    log.warn("agent.tool.error", {
      trace_id: run.traceId,
      run_id: run.id,
      org_id: run.orgId,
      agent: run.agentType,
      tool: name,
      error: message,
    });
    await recordStep(run, seq, {
      kind: "tool",
      toolName: name,
      toolCallId: call.id,
      status: "error",
      input: redactArgs(args),
      output: isRuleRefusal(e)
        ? { error: preview(message), refused: true }
        : { error: preview(message) },
      durationMs: Date.now() - started,
    });
    return { role: "tool", toolCallId: call.id, name, content: message, isError: true };
  }
}

async function applyDecision(
  ctx: ToolContext,
  task: typeof agentTasks.$inferSelect | undefined,
  call: AgentToolCall,
  seq: number,
): Promise<AgentMessage> {
  const reply = (content: string, isError = false): AgentMessage => ({
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content,
    ...(isError ? { isError } : {}),
  });
  if (!task) return reply("The decision for this request could not be found.", true);
  const response = (task.response ?? {}) as Record<string, unknown>;
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, ctx.runId)).limit(1);
  // What the person decided — and exactly what the agent was told — is a step
  // of the run, so the trail shows why the agent did what it did next.
  // (An approved tool call is recorded by the tool step it runs.)
  const told = async (content: string, isError = false): Promise<AgentMessage> => {
    if (run)
      await recordStep(run, seq, {
        kind: "decision",
        status: task.status,
        toolName: call.name,
        toolCallId: call.id,
        input: { taskId: task.id, decidedBy: task.decidedBy, ...response },
        output: { told: content },
      });
    return reply(content, isError);
  };

  if (task.status === "answered") return told(String(response["answer"] ?? ""));
  if (task.status === "rejected" && response["changes"]) {
    return told(
      `The person did not approve this yet and asked for changes: "${String(response["reason"] ?? "")}". ` +
        "Revise the proposal to reflect their request and ask for approval again with the revised values. " +
        "If the change is not possible within your rules, explain why in your reply.",
      true,
    );
  }
  if (task.status === "rejected") {
    const reason = response["reason"] ? ` Reason: ${String(response["reason"])}` : "";
    return told(`A person declined this request.${reason}`, true);
  }
  if (task.status !== "approved")
    return told(
      response["reason"]
        ? `This request was cancelled: ${String(response["reason"])} Do not retry it or work around it.`
        : "This request was cancelled.",
      true,
    );

  // Gate approvals carry no tool to run — the human acted in the app.
  if (isHitl(call.name) || task.kind === "gate") {
    const comment = response["comment"] ? ` Comment: ${String(response["comment"])}` : "";
    const subject = (task.proposedAction as { args?: { subject?: GateSubject } } | null)?.args
      ?.subject;
    if (subject?.type === "panel_approval")
      return told(`${await approvedPanelWords(task.orgId, subject)}${comment}`);
    return told(`Approved.${comment}`);
  }
  // An approved tool call runs with the (possibly edited) arguments, re-validated.
  const tool = getTool(call.name);
  if (!tool || !run) return reply(`Unknown tool: ${call.name}`, true);
  const edited = response["args"] !== undefined ? response["args"] : call.args;
  const parsed = tool.input.safeParse(edited);
  if (!parsed.success)
    return reply(`The approved arguments are invalid: ${parsed.error.message}`, true);
  // A tool approved by a named role runs as the approver, who authorised it
  // (their own permissions apply and the audit names them).
  const asApprover =
    tool.approverRole && task.decidedBy ? { ...ctx, principalUserId: task.decidedBy } : ctx;
  return execute(run, asApprover, tool.name, call, parsed.data, seq);
}

async function openTask(
  run: AgentRun,
  t: {
    kind: AgentTaskKind;
    title: string;
    body: string;
    assigneeRole: AppRole | null;
    proposedAction: unknown;
    /** A specific person; null = whoever holds `assigneeRole`; omitted = the default. */
    assigneeUserId?: string | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(agentTasks)
    .values({
      orgId: run.orgId,
      runId: run.id,
      kind: t.kind,
      title: t.title.slice(0, 200),
      body: t.body.slice(0, 8000),
      assigneeRole: t.assigneeRole,
      // Action approvals default to the person the agent works for.
      assigneeUserId:
        t.assigneeUserId !== undefined
          ? t.assigneeUserId
          : t.kind === "approval"
            ? run.principalUserId
            : null,
      proposedAction: t.proposedAction as never,
    })
    .returning({ id: agentTasks.id });
  if (run.conversationId) {
    try {
      const { onTaskOpened } = await import("../desk/desk.server");
      await onTaskOpened(run, {
        id: row!.id,
        kind: t.kind,
        title: t.title,
        body: t.body,
        assigneeRole: t.assigneeRole,
        proposedAction: t.proposedAction,
      });
    } catch (e) {
      log.warn("desk.post_failed", { run_id: run.id, error: e as Error });
    }
  }
  return row!.id;
}

async function nextSeq(runId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${agentSteps.seq}), 0)` })
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId));
  return Number(row?.max ?? 0) + 1;
}

async function recordStep(
  run: AgentRun,
  seq: number,
  s: {
    kind: string;
    status: string;
    toolName?: string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    promptTokens?: number;
    completionTokens?: number;
    durationMs?: number;
    notifyState?: "pending";
    injectionSuspected?: boolean;
  },
) {
  await db.insert(agentSteps).values({
    runId: run.id,
    orgId: run.orgId,
    seq,
    kind: s.kind,
    status: s.status,
    toolName: s.toolName ?? null,
    toolCallId: s.toolCallId ?? null,
    input: (s.input ?? null) as never,
    output: (s.output ?? null) as never,
    promptTokens: s.promptTokens ?? 0,
    completionTokens: s.completionTokens ?? 0,
    durationMs: s.durationMs ?? 0,
    notifyState: s.notifyState ?? null,
    injectionSuspected: s.injectionSuspected ?? false,
  });
}

async function save(
  run: AgentRun,
  transcript: AgentMessage[],
  pending: PendingCall[] | null,
  stepCount: number,
  tokensUsed: number,
) {
  await db
    .update(agentRuns)
    .set({
      transcript: transcript as never,
      pending: pending as never,
      stepCount,
      tokensUsed,
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, run.id));
}

async function finish(
  run: AgentRun,
  status: "done" | "failed",
  result: string | null,
  error: string | null,
) {
  const now = new Date();
  await db
    .update(agentRuns)
    .set({ status, result, lastError: error, leaseUntil: null, finishedAt: now, updatedAt: now })
    .where(eq(agentRuns.id, run.id));
  await writeAudit({
    actor: `agent:${run.agentType}:${run.id}`,
    actorUserId: run.principalUserId,
    orgId: run.orgId,
    action: status === "done" ? "agent.run.completed" : "agent.run.failed",
    entityType: "agent_run",
    entityId: run.id,
    detail: {
      on_behalf_of: run.principalUserId,
      definition_hash: run.definitionHash,
      mode: run.mode,
      handed_off: Boolean(result?.startsWith("Handed off:")),
      error: error ? error.slice(0, 300) : null,
    },
  });
  if (run.conversationId) {
    try {
      const { onRunFinished } = await import("../desk/desk.server");
      await onRunFinished({ ...run, status, result, error });
    } catch (e) {
      log.warn("desk.post_failed", { run_id: run.id, error: e as Error });
    }
  }
}

export const BUDGET_PAUSE_MESSAGE = "Paused: this agent reached its monthly token budget.";

/** Month-to-date tokens of this org's agent, from the AI ledger (incl. AI inside tools). */
export async function monthTokens(orgId: string, agentType: string): Promise<number> {
  const { aiUsageEvents } = await import("@db/schema");
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)::bigint` })
    .from(aiUsageEvents)
    .innerJoin(agentRuns, eq(agentRuns.id, aiUsageEvents.agentRunId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentType, agentType as never),
        sql`${aiUsageEvents.createdAt} >= date_trunc('month', now())`,
      ),
    );
  return Number(r?.n ?? 0);
}

/** The budget changed: let this agent's budget-paused runs be re-checked now, not in an hour. */
export async function releaseBudgetPaused(orgId: string, agentType: string): Promise<number> {
  const rows = await db
    .update(agentRuns)
    .set({ leaseUntil: null, updatedAt: new Date() })
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentType, agentType as never),
        eq(agentRuns.status, "queued"),
        eq(agentRuns.lastError, BUDGET_PAUSE_MESSAGE),
      ),
    )
    .returning({ id: agentRuns.id });
  return rows.length;
}

async function overBudget(run: AgentRun, budget: number | null): Promise<boolean> {
  if (budget == null) return false;
  return (await monthTokens(run.orgId, run.agentType)) >= budget;
}

/** Park the run (re-checked hourly; the budget resets with the month) and record it once. */
async function pauseForBudget(run: AgentRun) {
  const firstTime = run.lastError !== BUDGET_PAUSE_MESSAGE;
  await db
    .update(agentRuns)
    .set({
      status: "queued",
      lastError: BUDGET_PAUSE_MESSAGE,
      leaseUntil: new Date(Date.now() + 60 * 60_000),
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, run.id));
  if (firstTime) {
    log.warn("agent.run.budget_paused", {
      run_id: run.id,
      org_id: run.orgId,
      agent: run.agentType,
    });
    await writeAudit({
      actor: `agent:${run.agentType}:${run.id}`,
      actorUserId: run.principalUserId,
      orgId: run.orgId,
      action: "agent.run.budget_paused",
      entityType: "agent_run",
      entityId: run.id,
    });
  }
}

function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** Tool args are agent-authored but may quote candidate text; keep them short. */
function redactArgs(args: unknown): unknown {
  const raw = JSON.stringify(args ?? null);
  return raw.length > 2000 ? { truncated: preview(raw) } : args;
}

/** Tools whose request depends on the candidate's stage when it was asked. */
const STAGE_SENSITIVE_TOOLS = [
  "send_assessment",
  "remind_assessment",
  "move_candidate",
  "schedule_interview",
  "offer_interview_slots",
  "request_documents",
];

/**
 * A candidate moved (by a person or an agent): open requests to act on them
 * that depended on their old stage are closed as stale — nobody can approve
 * an assessment for someone already in an interview round — and the agent is
 * told why, so it does not try again. Audited; the run carries on.
 */
export async function cancelStaleRequests(
  orgId: string,
  applicationId: string,
  fromStage: string,
  toStage: string,
): Promise<number> {
  const now = new Date();
  const reason = `the candidate moved from ${fromStage} to ${toStage} after this was asked, so it no longer applies.`;
  const closed = await db
    .update(agentTasks)
    .set({
      status: "cancelled",
      response: { status: "cancelled", reason } as never,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentTasks.orgId, orgId),
        eq(agentTasks.status, "open"),
        eq(agentTasks.kind, "approval"),
        sql`${agentTasks.proposedAction} ->> 'name' in (${sql.join(
          STAGE_SENSITIVE_TOOLS.map((t) => sql`${t}`),
          sql`, `,
        )})`,
        sql`${agentTasks.proposedAction} -> 'args' ->> 'applicationId' = ${applicationId}`,
      ),
    )
    .returning({ id: agentTasks.id, runId: agentTasks.runId });
  // A screening decision waiting for a person no longer applies once the candidate moved.
  const decisions = await db
    .update(agentTasks)
    .set({
      status: "cancelled",
      // "Decided outside the inbox": a person approving this very card moves the
      // candidate too, and their decision then takes the task over (resolveTask).
      response: {
        status: "cancelled",
        reason: `Decided outside the inbox: the candidate moved from ${fromStage} to ${toStage}.`,
      } as never,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentTasks.orgId, orgId),
        eq(agentTasks.status, "open"),
        eq(agentTasks.kind, "gate"),
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'type' = 'screening_decision'`,
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'applicationId' = ${applicationId}`,
      ),
    )
    .returning({ id: agentTasks.id, runId: agentTasks.runId });
  closed.push(...decisions);
  for (const t of closed) {
    await writeAudit({
      actor: "system:stage-change",
      orgId,
      action: "agent.task.stale",
      entityType: "agent_task",
      entityId: t.id,
      detail: { run_id: t.runId, applicationId, fromStage, toStage },
    });
    await requeueIfUnblocked(t.runId);
  }
  return closed.length;
}
