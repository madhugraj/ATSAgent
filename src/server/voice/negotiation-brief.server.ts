/**
 * The facts for one negotiation call (docs/negotiator-voice-agent.md): the
 * pay discussion it follows up, and the two figures it may say. The figures
 * stay here, in code, for the in-call tools — the prompt gets names and the
 * reason for the call only. The ceiling and band are never loaded at all.
 */
import { and, desc, eq } from "drizzle-orm";

import {
  applications,
  candidates,
  jobDescriptions,
  offerNegotiations,
  organizations,
  requisitions,
  screeningCalls,
  type NegotiationStatus,
} from "@db/schema";
import { CALLABLE_NEGOTIATION } from "@/lib/negotiation.server";
import { db } from "../db";
import type { NegotiationFigures } from "./negotiation-call-tools";
import type { NegotiationFacts } from "./negotiation-prompt";
import { payFigureReason } from "@/lib/org-profile";
import { amountsIn } from "./negotiation-graders";
import { phoneScreeningPolicyOf } from "./settings.server";

/** Hard limit for a negotiation call, in minutes. */
export const NEGOTIATION_MAX_MINUTES = 10;

/** At most this many approved facts of each kind go into the call. */
export const MAX_HIGHLIGHTS = 6;
const MAX_HIGHLIGHT_CHARS = 280;

/**
 * Approved lines the assistant may use to sell the role (pure; unit-tested):
 * trimmed, at most `MAX_HIGHLIGHTS`, and never one that carries an amount or a
 * pay figure — the call's prompt holds no figure at all.
 */
export function safeHighlights(lines: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const t = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!t || t.length > MAX_HIGHLIGHT_CHARS) continue;
    if (amountsIn(t).length || payFigureReason(t) || /\d{5,}/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= MAX_HIGHLIGHTS) break;
  }
  return out;
}

/**
 * Where they stand (pure; unit-tested). A pay discussion exists only after the
 * hiring decision, so the candidate cleared every round of the role's plan and
 * was selected — named by round, never scores, ratings or who interviewed.
 */
export function progressWords(roundNames: string[]): string {
  const names = roundNames.map((n) => n.trim()).filter(Boolean);
  if (!names.length)
    return "They cleared the interviews, and the hiring team selected them for the role.";
  const n = ["", "one", "two", "three", "four", "five"][names.length] ?? String(names.length);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return names.length === 1
    ? `They cleared the interview round — ${list} — and the hiring team selected them for the role.`
    : `They cleared all ${n} interview rounds — ${list} — and the hiring team selected them for the role.`;
}

/** Why the call, from the discussion's state (pure). */
export function whyOf(status: NegotiationStatus): NegotiationFacts["why"] {
  if (status === "call_requested") return "they_asked";
  if (status === "countered") return "they_replied";
  if (status === "expired") return "no_reply";
  return "follow_up";
}

export type NegotiationBrief = {
  negotiationId: string;
  status: NegotiationStatus;
  /** The discussion can still be called about (otherwise the call is not placed). */
  open: boolean;
  candidateName: string;
  facts: NegotiationFacts;
  figures: NegotiationFigures;
};

export async function loadNegotiationBrief(
  orgId: string,
  callId: string,
): Promise<NegotiationBrief | null> {
  const [row] = await db
    .select({
      negotiationId: offerNegotiations.id,
      status: offerNegotiations.status,
      proposedCtc: offerNegotiations.proposedCtc,
      callStepCtc: offerNegotiations.callStepCtc,
      levers: offerNegotiations.levers,
      callBrief: offerNegotiations.callBrief,
      fullName: candidates.fullName,
      roleTitle: requisitions.title,
      applicationId: applications.id,
      requisitionId: requisitions.id,
      orgName: organizations.name,
    })
    .from(screeningCalls)
    .innerJoin(offerNegotiations, eq(offerNegotiations.id, screeningCalls.negotiationId))
    .innerJoin(applications, eq(applications.id, offerNegotiations.applicationId))
    .innerJoin(candidates, eq(candidates.id, offerNegotiations.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, screeningCalls.orgId))
    .where(
      and(
        eq(screeningCalls.id, callId),
        eq(screeningCalls.orgId, orgId),
        eq(screeningCalls.purpose, "negotiation"),
        eq(offerNegotiations.orgId, orgId),
        eq(applications.orgId, orgId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const policy = await phoneScreeningPolicyOf(orgId);
  const [progress, orgHighlights, roleHighlights] = await Promise.all([
    progressFor(orgId, row.requisitionId),
    orgFacts(orgId),
    roleFacts(orgId, row.requisitionId),
  ]);
  return {
    negotiationId: row.negotiationId,
    status: row.status,
    open: CALLABLE_NEGOTIATION.includes(row.status),
    candidateName: row.fullName,
    facts: {
      assistantName: policy.assistantName,
      orgName: row.orgName,
      candidateFirstName: row.fullName.trim().split(/\s+/)[0] ?? row.fullName,
      roleTitle: row.roleTitle,
      why: whyOf(row.status),
      maxMinutes: NEGOTIATION_MAX_MINUTES,
      progress,
      orgHighlights,
      roleHighlights,
    },
    figures: {
      proposalCtc: Number(row.proposedCtc),
      stepCtc: row.callStepCtc == null ? null : Number(row.callStepCtc),
      levers: row.levers ?? {},
      brief: row.callBrief ?? null,
    },
  };
}

/** The rounds of the role's interview plan (never how they did). A failure leaves the plain line. */
async function progressFor(orgId: string, requisitionId: string): Promise<string> {
  try {
    const { planFor } = await import("@/lib/interview-plan.server");
    const { plan } = await planFor(orgId, requisitionId);
    return progressWords(plan.rounds.map((r) => r.name));
  } catch {
    return progressWords([]);
  }
}

/** Approved organisation-profile items marked for candidates. */
async function orgFacts(orgId: string): Promise<string[]> {
  try {
    const { profileState } = await import("@/lib/org-profile.server");
    const { candidateVisible } = await import("@/lib/org-profile");
    const st = await profileState(orgId);
    if (!st.approved) return [];
    return safeHighlights(candidateVisible(st.approved.sections).map((i) => i.text));
  } catch {
    return [];
  }
}

/** The role's purpose and what success looks like, from its approved job description. */
async function roleFacts(orgId: string, requisitionId: string): Promise<string[]> {
  const [jd] = await db
    .select({
      purpose: jobDescriptions.purpose,
      successFactors: jobDescriptions.successFactors,
      responsibilities: jobDescriptions.responsibilities,
    })
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
  if (!jd) return [];
  const lines = [jd.purpose, jd.successFactors, jd.responsibilities]
    .flatMap((t) => (t ?? "").split(/\n+|(?<=\.)\s+/))
    .map((t) => t.replace(/^[-•*\d.)\s]+/, ""));
  return safeHighlights(lines);
}
