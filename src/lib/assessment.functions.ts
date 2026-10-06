import { createServerFn } from "@tanstack/react-start";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { candidateAssessments, candidates, requisitions } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { generateQuestions, scoreAnswers, type AssessmentQuestion } from "./assessment.server";

/* ------------------------------------------------------------ recruiter side */

const CreateInput = z.object({
  candidateId: z.string().uuid(),
  requisitionId: z.string().uuid().optional().nullable(),
  count: z.number().min(4).max(10).default(6),
});

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

  const [row] = await db
    .insert(candidateAssessments)
    .values({
      candidateId: candidate.id,
      requisitionId: data.requisitionId ?? null,
      orgId: orgId,
      token,
      status: "sent",
      questions,
    })
    .returning({ id: candidateAssessments.id, token: candidateAssessments.token });
  if (!row) throw new Error("The assessment could not be created.");

  return { id: row.id, token: row.token, questions };
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
      })
      .from(candidateAssessments)
      .where(eq(candidateAssessments.token, data.token))
      .limit(1);
    if (!row) throw new Error("This assessment link is not valid");
    // Links expire 14 days after they are issued.
    if (Date.now() - row.createdAt.getTime() > 14 * 24 * 60 * 60 * 1000) {
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

/** Public: submit answers once, score them, and lock the assessment. */
export const submitAssessment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => SubmitInput.parse(data))
  .handler(async ({ data }) => {
    const [row] = await db
      .select({
        id: candidateAssessments.id,
        status: candidateAssessments.status,
        questions: candidateAssessments.questions,
        requisitionId: candidateAssessments.requisitionId,
        orgId: candidateAssessments.orgId,
      })
      .from(candidateAssessments)
      .where(eq(candidateAssessments.token, data.token))
      .limit(1);
    if (!row) throw new Error("This assessment link is not valid");
    if (!row.orgId) throw new Error("This assessment link is not valid");
    if (row.status === "completed") throw new Error("This assessment has already been submitted");

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

    const result = await scoreAnswers({
      orgId: row.orgId,
      title,
      questions,
      answers: data.answers,
    });

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
      .where(and(eq(candidateAssessments.id, row.id), ne(candidateAssessments.status, "completed")))
      .returning({ id: candidateAssessments.id });
    if (!locked.length) throw new Error("This assessment has already been submitted");

    return { ok: true as const };
  });
