/**
 * What the Screening call agent knows and must do on one call
 * (docs/voice-screening-agent.md): the organisation's facts, the role, the
 * kit's questions (pay questions removed), whether to ask notice period, and
 * the rules. Facts come from the organisation's own records; the candidate's
 * words on the call are the only untrusted input, and the rules say so.
 */
import { and, desc, eq } from "drizzle-orm";

import {
  applications,
  candidates,
  jobDescriptions,
  matchScores,
  organizations,
  requisitions,
  screeningKits,
  users,
} from "@db/schema";
import type { ScreeningQuestion } from "@/lib/screening.server";
import { sourceLabel } from "@/lib/job-channels";
import { placeLabel } from "@/lib/work-mode";
import { db } from "../db";
import { type BriefFacts, questionsForCall } from "./call-prompt";
import type { PhoneScreeningPolicy } from "./settings.server";

export {
  type BriefFacts,
  type CallQuestion,
  callSystemPrompt,
  questionsForCall,
} from "./call-prompt";

/** Everything the call needs from the database for one application. */
export async function loadBriefFacts(input: {
  orgId: string;
  applicationId: string;
  kitId: string;
  policy: PhoneScreeningPolicy;
  /** The candidate agreed this time on an earlier call. */
  booked?: boolean;
}): Promise<BriefFacts & { kitQuestions: ScreeningQuestion[] }> {
  const [row] = await db
    .select({
      orgName: organizations.name,
      careersEmail: organizations.careersEmail,
      candidateName: candidates.fullName,
      candidateEmail: candidates.email,
      candidateLocation: candidates.location,
      candidateCompany: candidates.currentEmployer,
      candidateYears: candidates.experienceYears,
      candidateSkills: candidates.skills,
      requisitionId: requisitions.id,
      roleTitle: requisitions.title,
      roleCode: requisitions.code,
      location: requisitions.location,
      workMode: requisitions.workMode,
      engagementType: requisitions.engagementType,
      mustHave: requisitions.mustHaveSkills,
      contactName: users.fullName,
      source: applications.source,
      appliedAt: applications.appliedAt,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, applications.orgId))
    .leftJoin(users, eq(users.id, requisitions.createdBy))
    .where(and(eq(applications.id, input.applicationId), eq(applications.orgId, input.orgId)))
    .limit(1);
  if (!row) throw new Error("Application not found");
  const [kit] = await db
    .select({ questions: screeningKits.questions })
    .from(screeningKits)
    .where(and(eq(screeningKits.id, input.kitId), eq(screeningKits.orgId, input.orgId)))
    .limit(1);
  if (!kit) throw new Error("Screening kit not found");
  const kitQuestions = (Array.isArray(kit.questions) ? kit.questions : []) as ScreeningQuestion[];

  const [jd] = await db
    .select({
      purpose: jobDescriptions.purpose,
      responsibilities: jobDescriptions.responsibilities,
    })
    .from(jobDescriptions)
    .where(
      and(
        eq(jobDescriptions.requisitionId, row.requisitionId),
        eq(jobDescriptions.status, "approved"),
      ),
    )
    .orderBy(desc(jobDescriptions.createdAt))
    .limit(1);
  const [match] = await db
    .select({ matched: matchScores.matchedSkills })
    .from(matchScores)
    .where(
      and(eq(matchScores.orgId, input.orgId), eq(matchScores.applicationId, input.applicationId)),
    )
    .orderBy(desc(matchScores.computedAt))
    .limit(1);

  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const { detailsFor } = await import("@/lib/compensation.server");
  const [email, pay] = await Promise.all([
    getOrgEmailSettings(input.orgId),
    detailsFor(input.orgId, input.applicationId),
  ]);

  return {
    assistantName: input.policy.assistantName,
    orgName: row.orgName,
    roleTitle: row.roleTitle,
    roleCode: row.roleCode,
    place: placeLabel(row.location, row.workMode),
    forClient: row.engagementType !== "internal",
    roleSummary: jd?.purpose ? clip(plain(jd.purpose), 320) : null,
    responsibilities: bullets(jd?.responsibilities).slice(0, 3),
    appliedVia: appliedVia(row.source),
    appliedOn: row.appliedAt ? dayMonth(row.appliedAt, email.timezone) : null,
    booked: Boolean(input.booked),
    contactName: row.contactName?.trim() || null,
    contactEmail: email.replyTo?.trim() || row.careersEmail?.trim() || null,
    candidateFirstName: (row.candidateName ?? "").trim().split(/\s+/)[0] || "the candidate",
    cv: {
      currentCompany: row.candidateCompany?.trim() || null,
      experienceYears: Number(row.candidateYears) > 0 ? Number(row.candidateYears) : null,
      location: row.candidateLocation?.trim() || null,
    },
    strengths: strengthsFor(row.mustHave ?? [], match?.matched ?? row.candidateSkills ?? []),
    known: {
      notice: pay.noticePeriodDays != null,
      currentPay: pay.currentTotal != null,
      expectedPay: pay.expectedCtc != null,
    },
    emailDomain: row.candidateEmail?.split("@")[1]?.toLowerCase() || null,
    questions: questionsForCall(kitQuestions),
    maxMinutes: input.policy.maxMinutes,
    nextSteps:
      input.policy.nextStepsText ||
      "the hiring team will review this conversation and get back to you by e-mail",
    callingHours: callingHours(input.policy),
    kitQuestions,
  };
}

/* ------------------------------------------------------------- helpers */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const plain = (s: string) =>
  s
    .replace(/[#*_`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Lines of a JD field as short items ("- Keep it up" → "Keep it up"). */
export function bullets(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\n+/)
    .map((l) => plain(l.replace(/^\s*([-*•]|\d+[.)])\s*/, "")))
    .filter((l) => l.length > 3)
    .map((l) => clip(l, 140));
}

/** Must-have skills the candidate has, must-haves first (pure). */
export function strengthsFor(mustHave: string[], theirs: string[]): string[] {
  const have = new Set(theirs.map((s) => s.toLowerCase().trim()));
  const fit = mustHave.filter((m) => have.has(m.toLowerCase().trim()));
  return [...new Set(fit)].slice(0, 4);
}

/** "Naukri", "our careers page" — how they applied, in words; null if unknown. */
export function appliedVia(source: string | null | undefined): string | null {
  const s = (source ?? "").trim().toLowerCase();
  if (!s || s === "direct" || s === "unknown") return null;
  if (s === "apply" || s === "careers" || s === "careers_page") return "our careers page";
  if (s === "referral") return "a referral";
  const named = sourceLabel(s);
  return named && named !== "Unknown" ? named : null;
}

const dayMonth = (d: Date, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone }).format(d);
  } catch {
    return null;
  }
};

const DAY_NAMES = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const hm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "Monday to Saturday, 10:00 to 19:00" (pure). */
export function callingHours(
  p: Pick<PhoneScreeningPolicy, "callDays" | "windowStartMinute" | "windowEndMinute">,
) {
  const d = [...p.callDays].sort((a, b) => a - b);
  const contiguous = d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  const days =
    d.length === 7
      ? "every day"
      : contiguous && d.length > 2
        ? `${DAY_NAMES[d[0]!]} to ${DAY_NAMES[d[d.length - 1]!]}`
        : d.map((x) => DAY_NAMES[x]).join(", ");
  return `${days}, ${hm(p.windowStartMinute)} to ${hm(p.windowEndMinute)}`;
}
