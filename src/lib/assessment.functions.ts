import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { applications, candidateAssessments, candidates, requisitions } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { generateQuestions, scoreAnswers, type AssessmentQuestion } from "./assessment.server";

/* ------------------------------------------------------------ recruiter side */

const CreateInput = z.object({
  candidateId: z.string().uuid(),
  requisitionId: z.string().uuid().optional().nullable(),
  count: z.number().min(4).max(10).default(6),
  /** The application it is for, when known (reminders and decisions act on it). */
  applicationId: z.string().uuid().optional().nullable(),
});

async function applicationFor(
  orgId: string,
  candidateId: string,
  requisitionId: string | null | undefined,
): Promise<string | null> {
  if (!requisitionId) return null;
  const [a] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.orgId, orgId),
        eq(applications.candidateId, candidateId),
        eq(applications.requisitionId, requisitionId),
      ),
    )
    .limit(1);
  return a?.id ?? null;
}

/** Build a role-specific questionnaire and issue a private candidate link. */
/** Shared by the candidate page and the Screening agent. */
export async function createAssessmentCore(orgId: string, data: z.infer<typeof CreateInput>) {
  const [candidate] = await db
    .select({
      id: candidates.id,
      fullName: candidates.fullName,
      currentEmployer: candidates.currentEmployer,
      skills: candidates.skills,
    })
    .from(candidates)
    .where(and(eq(candidates.id, data.candidateId), eq(candidates.orgId, orgId)))
    .limit(1);
  if (!candidate) throw new Error("Candidate not found");

  let title = candidate.currentEmployer
    ? `their next role after ${candidate.currentEmployer}`
    : "the role";
  let mustHave: string[] = candidate.skills ?? [];
  let responsibilities: string | null = null;

  if (data.requisitionId) {
    const [req] = await db
      .select({
        title: requisitions.title,
        mustHaveSkills: requisitions.mustHaveSkills,
        responsibilities: requisitions.responsibilities,
      })
      .from(requisitions)
      .where(and(eq(requisitions.id, data.requisitionId), eq(requisitions.orgId, orgId)))
      .limit(1);
    if (req) {
      title = req.title;
      mustHave = req.mustHaveSkills ?? mustHave;
      responsibilities = req.responsibilities ?? null;
    }
  }

  const questions = await generateQuestions({
    orgId: orgId,
    title,
    mustHave,
    responsibilities,
    count: data.count,
  });
  const token = crypto.randomUUID().replace(/-/g, "");
  // One organisation policy decides the due date the candidate is told and
  // when the link closes (src/lib/assessment-timeline.server.ts).
  const { assessmentPolicyOf, timelineFor } = await import("./assessment-timeline.server");
  const { getOrgEmailSettings } = await import("./email-outbox.server");
  const timeZone = (await getOrgEmailSettings(orgId)).timezone;
  // One instant for "sent", the due date and the closing time — they must agree exactly.
  const issuedAt = new Date();
  const timeline = timelineFor(issuedAt, await assessmentPolicyOf(orgId), timeZone);

  const [row] = await db
    .insert(candidateAssessments)
    .values({
      candidateId: candidate.id,
      requisitionId: data.requisitionId ?? null,
      orgId: orgId,
      token,
      status: "sent",
      questions,
      applicationId:
        data.applicationId ?? (await applicationFor(orgId, candidate.id, data.requisitionId)),
      dueAt: timeline.dueAt,
      closesAt: timeline.closesAt,
      createdAt: issuedAt,
    })
    .returning({ id: candidateAssessments.id, token: candidateAssessments.token });
  if (!row) throw new Error("The assessment could not be created.");

  return {
    id: row.id,
    token: row.token,
    questions,
    dueAt: timeline.dueAt,
    closesAt: timeline.closesAt,
    timeZone,
  };
}

export const createAssessment = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => CreateInput.parse(data))
  .handler(async ({ data, context }) => createAssessmentCore(context.orgId, data));

/* ------------------------------------------------------------ candidate side */

const TokenInput = z.object({ token: z.string().min(16) });

/** Public: load the questionnaire behind a private token (no answers exposed). */
export const getAssessment = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => TokenInput.parse(data))
  .handler(async ({ data }) => {
    const [row] = await db
      .select({
        id: candidateAssessments.id,
        status: candidateAssessments.status,
        questions: candidateAssessments.questions,
        candidateId: candidateAssessments.candidateId,
        createdAt: candidateAssessments.createdAt,
        closesAt: candidateAssessments.closesAt,
      })
      .from(candidateAssessments)
      .where(eq(candidateAssessments.token, data.token))
      .limit(1);
    if (!row) throw new Error("This assessment link is not valid");
    // The link works until it closes (the organisation's policy; 14 days for old links).
    const closes = row.closesAt?.getTime() ?? row.createdAt.getTime() + 14 * 864e5;
    if (Date.now() > closes || row.status === "expired" || row.status === "waived") {
      throw new Error("This assessment link has expired.");
    }

    const [candidate] = await db
      .select({ fullName: candidates.fullName })
      .from(candidates)
      .where(eq(candidates.id, row.candidateId))
      .limit(1);

    const questions = (row.questions as unknown as AssessmentQuestion[]) ?? [];
    return {
      status: row.status,
      candidateName: candidate?.fullName ?? "",
      // 'looks_like' is the recruiter's rubric — never send it to the candidate.
      questions: questions.map((q) => ({ id: q.id, dimension: q.dimension, prompt: q.prompt })),
    };
  });

const SubmitInput = z.object({
  token: z.string().min(16),
  answers: z.array(z.object({ id: z.string(), answer: z.string().max(4000) })).min(1),
});

/**
 * Submit answers once, grade them, lock the assessment, and start what comes
 * next. `grade` is the AI grader (injectable for tests).
 */
export async function submitAssessmentCore(
  data: z.infer<typeof SubmitInput>,
  grade: typeof scoreAnswers = scoreAnswers,
): Promise<{ ok: true }> {
  const [row] = await db
    .select({
      id: candidateAssessments.id,
      status: candidateAssessments.status,
      questions: candidateAssessments.questions,
      requisitionId: candidateAssessments.requisitionId,
      orgId: candidateAssessments.orgId,
      candidateId: candidateAssessments.candidateId,
      applicationId: candidateAssessments.applicationId,
      createdAt: candidateAssessments.createdAt,
      closesAt: candidateAssessments.closesAt,
    })
    .from(candidateAssessments)
    .where(eq(candidateAssessments.token, data.token))
    .limit(1);
  if (!row) throw new Error("This assessment link is not valid");
  if (!row.orgId) throw new Error("This assessment link is not valid");
  if (row.status === "completed") throw new Error("This assessment has already been submitted");
  // A closed or waived link takes no answers, even from a page left open.
  const closes = row.closesAt?.getTime() ?? row.createdAt.getTime() + 14 * 864e5;
  if (row.status !== "sent" || Date.now() > closes)
    throw new Error("This assessment link has expired.");

  const questions = (row.questions as unknown as AssessmentQuestion[]) ?? [];
  let title: string = "the role";
  if (row.requisitionId) {
    const [req] = await db
      .select({ title: requisitions.title })
      .from(requisitions)
      .where(eq(requisitions.id, row.requisitionId))
      .limit(1);
    if (req?.title) title = req.title;
  }

  // Grading counts towards this candidate's hiring cost.
  const { withAiSubject } = await import("../server/agents/context");
  const result = await withAiSubject(
    { candidateId: row.candidateId, requisitionId: row.requisitionId },
    () =>
      grade({
        orgId: row.orgId!,
        title,
        questions,
        answers: data.answers,
      }),
  );

  // Atomic lock: the status guard lives in the UPDATE itself, so two
  // concurrent submissions cannot both write (TOCTOU).
  const locked = await db
    .update(candidateAssessments)
    .set({
      status: "completed",
      answers: data.answers,
      mindsetScore: result.mindset_score,
      dimensions: result.dimensions,
      strengths: result.strengths,
      redFlags: result.red_flags,
      summary: result.summary,
      model: result.model,
      completedAt: new Date(),
    })
    // Only an open link records answers (not completed, expired or waived).
    .where(and(eq(candidateAssessments.id, row.id), eq(candidateAssessments.status, "sent")))
    .returning({ id: candidateAssessments.id });
  if (!locked.length) throw new Error("This assessment has already been submitted");

  // The next step starts now: the role's thread is told, and the Screening
  // agent gives its recommendation for a person to decide on.
  const { onAssessmentCompleted } = await import("./assessment-timeline.server");
  await onAssessmentCompleted({
    orgId: row.orgId,
    assessmentId: row.id,
    candidateId: row.candidateId,
    requisitionId: row.requisitionId,
    applicationId: row.applicationId,
    score: result.mindset_score ?? null,
  });

  return { ok: true as const };
}

/** Public: submit answers once, score them, and lock the assessment. */
export const submitAssessment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => SubmitInput.parse(data))
  .handler(async ({ data }) => submitAssessmentCore(data));
