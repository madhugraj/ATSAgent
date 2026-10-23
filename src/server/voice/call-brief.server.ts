/**
 * What the Screening call agent knows and must do on one call
 * (docs/voice-screening-agent.md): the organisation's facts, the role, the
 * kit's questions (pay questions removed), whether to ask notice period, and
 * the rules. Facts come from the organisation's own records; the candidate's
 * words on the call are the only untrusted input, and the rules say so.
 */
import { and, eq } from "drizzle-orm";

import {
  applications,
  candidates,
  organizations,
  requisitions,
  screeningKits,
  users,
} from "@db/schema";
import type { ScreeningQuestion } from "@/lib/screening.server";
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
}): Promise<BriefFacts & { kitQuestions: ScreeningQuestion[] }> {
  const [row] = await db
    .select({
      orgName: organizations.name,
      careersEmail: organizations.careersEmail,
      candidateName: candidates.fullName,
      roleTitle: requisitions.title,
      roleCode: requisitions.code,
      location: requisitions.location,
      workMode: requisitions.workMode,
      engagementType: requisitions.engagementType,
      contactName: users.fullName,
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
    contactName: row.contactName?.trim() || null,
    contactEmail: email.replyTo?.trim() || row.careersEmail?.trim() || null,
    candidateFirstName: (row.candidateName ?? "").trim().split(/\s+/)[0] || "the candidate",
    questions: questionsForCall(kitQuestions),
    askAvailability: pay.noticePeriodDays == null || pay.earliestJoining == null,
    maxMinutes: input.policy.maxMinutes,
    kitQuestions,
  };
}
