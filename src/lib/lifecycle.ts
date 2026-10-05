/**
 * Candidate lifecycle state machine — pure, shared by UI and server functions.
 *
 * Interviews are optional: a candidate can jump from shortlisted straight to an
 * offer. What is NOT allowed is moving backwards through the funnel without
 * parking the candidate (on_hold / reserve) first, so the audit trail stays honest.
 */
import type { Database } from "@/lib/database.types";

export type Stage = Database["public"]["Enums"]["app_stage"];

/** Forward funnel, in order. */
export const FLOW: Stage[] = [
  "sourced",
  "applied",
  "ai_screened",
  "shortlisted",
  "l1",
  "l2",
  "l3",
  "offer_pending",
  "offer_released",
  "offer_accepted",
  "joined",
];

/** Outcomes that sit off the funnel. */
export const SIDE: Stage[] = [
  "offer_declined",
  "no_show",
  "joining_deferred",
  "on_hold",
  "reserve",
  "withdrawn",
  "rejected",
];

/** Stages kept only for rows created before the lifecycle expansion. */
const LEGACY: Partial<Record<Stage, Stage>> = { offer: "offer_pending", hired: "joined" };

export function canonical(stage: Stage): Stage {
  return LEGACY[stage] ?? stage;
}

export const STAGE_LABEL: Record<Stage, string> = {
  sourced: "Sourced",
  applied: "Applied",
  ai_screened: "AI screened",
  shortlisted: "Shortlisted",
  l1: "Interview L1",
  l2: "Interview L2",
  l3: "Interview L3",
  offer: "Offer (legacy)",
  offer_pending: "Offer pending approval",
  offer_released: "Offer released",
  offer_accepted: "Offer accepted",
  offer_declined: "Offer declined",
  joined: "Joined",
  hired: "Hired (legacy)",
  no_show: "No show",
  joining_deferred: "Joining deferred",
  on_hold: "On hold",
  reserve: "Talent pool reserve",
  withdrawn: "Withdrawn",
  rejected: "Rejected",
};

export type StageTone = "neutral" | "active" | "good" | "warn" | "bad";

export const STAGE_TONE: Record<Stage, StageTone> = {
  sourced: "neutral",
  applied: "neutral",
  ai_screened: "active",
  shortlisted: "active",
  l1: "active",
  l2: "active",
  l3: "active",
  offer: "active",
  offer_pending: "active",
  offer_released: "active",
  offer_accepted: "good",
  joined: "good",
  hired: "good",
  offer_declined: "bad",
  no_show: "bad",
  joining_deferred: "warn",
  on_hold: "warn",
  reserve: "neutral",
  withdrawn: "bad",
  rejected: "bad",
};

/** Stages that must carry a reason so reporting can explain drop-offs. */
export const REASON_REQUIRED: Stage[] = [
  "rejected",
  "withdrawn",
  "offer_declined",
  "no_show",
  "on_hold",
  "joining_deferred",
];

/**
 * Reasons that make sense for each destination stage. The reason picker is
 * driven by the stage the recruiter chose, so a "Salary expectation mismatch"
 * can never be attached to a "Shortlisted" move.
 */
export const STAGE_REASONS: Partial<Record<Stage, string[]>> = {
  shortlisted: [
    "Strong JD match",
    "Recruiter recommendation",
    "Referral",
    "Internal applicant priority",
  ],
  l1: ["Cleared screening", "Panel availability confirmed"],
  l2: ["Cleared L1", "Panel availability confirmed"],
  l3: ["Cleared L2", "Leadership round required"],
  offer_pending: ["Cleared final round", "Approved by hiring manager"],
  offer_released: ["Approvals complete", "Verbal acceptance received"],
  offer_accepted: ["Candidate accepted in writing", "Joining date agreed"],
  offer_declined: [
    "Better offer elsewhere",
    "Compensation mismatch",
    "Location or relocation issue",
    "Counter-offer from current employer",
    "Role expectation mismatch",
  ],
  joined: ["Joined on agreed date", "Joined after deferral"],
  no_show: [
    "Did not report on joining date",
    "Unreachable after acceptance",
    "Absconded post acceptance",
  ],
  joining_deferred: [
    "Notice period extended",
    "Personal reasons",
    "Requisition start date moved",
    "Relocation delay",
  ],
  on_hold: [
    "Requisition on hold",
    "Budget freeze",
    "Panel unavailable",
    "Awaiting candidate response",
  ],
  reserve: [
    "Good fit, no open role",
    "Runner-up for this requisition",
    "Keep warm for next quarter",
  ],
  withdrawn: [
    "Candidate withdrew",
    "Accepted another offer",
    "Not interested in the role",
    "Unresponsive to follow-ups",
  ],
  rejected: [
    "Skills gap against must-haves",
    "Insufficient relevant experience",
    "Education criteria not met",
    "Compensation expectation beyond band",
    "Failed interview round",
    "Background or authenticity concern",
    "Location or notice-period constraint",
  ],
};

/** The reason options for a destination stage (empty means free-text note only). */
export function reasonsForStage(stage: Stage): string[] {
  return STAGE_REASONS[canonical(stage)] ?? [];
}

export function isTerminal(stage: Stage) {
  return ["joined", "hired", "rejected", "withdrawn", "offer_declined", "no_show"].includes(stage);
}

export function isActive(stage: Stage) {
  return FLOW.includes(canonical(stage)) && canonical(stage) !== "joined";
}

/** Every stage this application may legally move to next. */
export function allowedTransitions(from: Stage): Stage[] {
  const s = canonical(from);
  const idx = FLOW.indexOf(s);

  if (idx >= 0 && s !== "joined") {
    return [...FLOW.slice(idx + 1), ...SIDE];
  }
  if (s === "joined") return ["no_show", "withdrawn"];
  if (["on_hold", "reserve", "joining_deferred"].includes(s)) {
    return [...FLOW, "rejected", "withdrawn"].filter((x) => x !== s) as Stage[];
  }
  // Re-open a closed candidate: they go back to the pool, not mid-funnel.
  return ["reserve", "sourced", "shortlisted"];
}

export function canMove(from: Stage, to: Stage) {
  return allowedTransitions(from).includes(canonical(to));
}

/** The next thing a recruiter should do for this stage. */
export function nextAction(stage: Stage): string {
  switch (canonical(stage)) {
    case "sourced":
      return "Screen the CV against the JD";
    case "applied":
      return "Run AI screening";
    case "ai_screened":
      return "Review the score and shortlist";
    case "shortlisted":
      return "Schedule L1";
    case "l1":
      return "Capture L1 feedback";
    case "l2":
      return "Capture L2 feedback";
    case "l3":
      return "Capture L3 feedback";
    case "offer_pending":
      return "Push the offer through approval";
    case "offer_released":
      return "Chase the candidate response";
    case "offer_accepted":
      return "Confirm joining date";
    case "joining_deferred":
      return "Re-confirm the new joining date";
    case "on_hold":
      return "Decide: resume or close";
    case "reserve":
      return "Consider for the next matching requisition";
    default:
      return "Closed — no action";
  }
}

/** Stale-pipeline hygiene: how long a stage may sit untouched before it's flagged. */
const SLA_DAYS: Partial<Record<Stage, number>> = {
  sourced: 5,
  applied: 5,
  ai_screened: 5,
  shortlisted: 7,
  l1: 7,
  l2: 7,
  l3: 7,
  offer_pending: 5,
  offer_released: 7,
  offer_accepted: 30,
};

export function stalledDays(
  stage: Stage,
  lastActivityAt: string | null | undefined,
): number | null {
  const sla = SLA_DAYS[canonical(stage)];
  if (!sla || !lastActivityAt) return null;
  const days = Math.floor((Date.now() - new Date(lastActivityAt).getTime()) / 86_400_000);
  return days > sla ? days : null;
}
