import { and, desc, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import {
  type ScreeningCoverage,
  applications,
  candidates,
  jobDescriptions,
  matchScores,
  requisitions,
  screeningKits,
  screeningRuns,
} from "@db/schema";
import { getObject, putObject } from "../server/storage";
import { requireOrg } from "./auth.middleware";
import {
  buildScreeningKit,
  gradeScreening,
  transcribeScreeningAudio,
  type ScreeningQuestion,
} from "./screening.server";

const QuestionSchema = z.object({
  id: z.string(),
  focus: z.string(),
  question: z.string(),
  reason: z.string(),
  expected_answer: z.string(),
  weak_answer: z.string(),
  weight: z.number(),
});

/**
 * Pull JD, requisition, candidate and the latest match for one pairing.
 * Every lookup carries the caller's org predicate — the candidate, the
 * requisition and the application must all belong to the caller's org.
 * Exported for the background prep worker (screening-prep.server.ts).
 */
export async function loadPairing(
  orgId: string,
  candidateId: string,
  requisitionId: string | null,
) {
  const [candidate] = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)))
    .limit(1);
  if (!candidate) throw new Error("Candidate not found");

  let requisition: typeof requisitions.$inferSelect | null = null;
  if (requisitionId) {
    const [row] = await db
      .select()
      .from(requisitions)
      .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
      .limit(1);
    requisition = row ?? null;
  }

  let application: { id: string } | null = null;
  if (requisitionId) {
    const [row] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          eq(applications.candidateId, candidateId),
          eq(applications.requisitionId, requisitionId),
          eq(applications.orgId, orgId),
        ),
      )
      .orderBy(applications.appliedAt)
      .limit(1);
    application = row ?? null;
  }

  let jdText = "";
  if (requisitionId) {
    const [row] = await db
      .select({
        fullText: jobDescriptions.fullText,
        purpose: jobDescriptions.purpose,
        responsibilities: jobDescriptions.responsibilities,
        qualifications: jobDescriptions.qualifications,
      })
      .from(jobDescriptions)
      .where(
        and(eq(jobDescriptions.requisitionId, requisitionId), eq(jobDescriptions.orgId, orgId)),
      )
      .orderBy(desc(jobDescriptions.version))
      .limit(1);
    jdText =
      row?.fullText ??
      [row?.purpose, row?.responsibilities, row?.qualifications].filter(Boolean).join("\n\n") ??
      "";
  }
  if (!jdText && requisition) {
    jdText = [
      `Role: ${requisition.title}`,
      requisition.responsibilities ?? "",
      `Must-have: ${(requisition.mustHaveSkills ?? []).join(", ")}`,
      `Good to have: ${(requisition.goodToHaveSkills ?? []).join(", ")}`,
      requisition.educationRequirement ? `Qualification: ${requisition.educationRequirement}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  let match: {
    overallScore: number | null;
    rationale: string | null;
    missingSkills: string[];
    riskFlags: string[];
  } | null = null;
  if (application) {
    const [row] = await db
      .select({
        overallScore: matchScores.overallScore,
        rationale: matchScores.rationale,
        missingSkills: matchScores.missingSkills,
        riskFlags: matchScores.riskFlags,
      })
      .from(matchScores)
      .where(eq(matchScores.applicationId, application.id))
      .orderBy(desc(matchScores.computedAt))
      .limit(1);
    match = row ?? null;
  }

  return { candidate, requisition, application, jdText, match };
}

/* --------------------------------------------------------------- build kit */

/**
 * Resolve one pairing and build + insert a screening kit. Shared by the
 * recruiter's button (createScreeningKit) and the background prep worker —
 * one code path, so a background kit is indistinguishable from a manual one.
 * The caller has already established that candidateId/requisitionId live in
 * orgId (loadPairing re-checks every lookup).
 */
/** The candidate's completed written assessment for this role, for the call kit to build on. */
async function writtenAssessmentFor(orgId: string, candidateId: string, requisitionId: string) {
  const { candidateAssessments } = await import("@db/schema");
  const [a] = await db
    .select({
      score: candidateAssessments.mindsetScore,
      summary: candidateAssessments.summary,
      dimensions: candidateAssessments.dimensions,
      strengths: candidateAssessments.strengths,
      redFlags: candidateAssessments.redFlags,
    })
    .from(candidateAssessments)
    .where(
      and(
        eq(candidateAssessments.orgId, orgId),
        eq(candidateAssessments.candidateId, candidateId),
        eq(candidateAssessments.requisitionId, requisitionId),
        eq(candidateAssessments.status, "completed"),
      ),
    )
    .orderBy(desc(candidateAssessments.completedAt))
    .limit(1);
  if (!a) return null;
  return {
    score: a.score,
    summary: a.summary,
    areas: (Array.isArray(a.dimensions)
      ? (a.dimensions as { dimension?: string; score?: number }[])
      : []
    ).map((d) => ({ area: String(d.dimension ?? ""), score: d.score ?? null })),
    strengths: a.strengths ?? [],
    redFlags: a.redFlags ?? [],
  };
}

export async function prepareScreeningKitForPairing(input: {
  orgId: string;
  candidateId: string;
  requisitionId: string;
  /** Null for background prep — no signed-in user. */
  createdBy: string | null;
}): Promise<{ kitId: string; questions: ScreeningQuestion[]; focus_summary: string }> {
  const { candidate, requisition, application, jdText, match } = await loadPairing(
    input.orgId,
    input.candidateId,
    input.requisitionId,
  );
  if (!requisition) throw new Error("Pick the role this screening call is for.");
  if (!jdText.trim()) throw new Error("This role has no job description text yet.");

  const kit = await buildScreeningKit({
    orgId: input.orgId,
    role: requisition.title,
    jdText,
    mustHave: requisition.mustHaveSkills ?? [],
    goodToHave: requisition.goodToHaveSkills ?? [],
    experienceMin: requisition.experienceMin ?? 0,
    experienceMax: requisition.experienceMax ?? 0,
    budgetCtc: requisition.budgetCtc != null ? Number(requisition.budgetCtc) : null,
    currency: "INR",
    candidateName: candidate.fullName,
    resumeText: candidate.resumeText,
    candidateSkills: candidate.skills ?? [],
    experienceYears: Number(candidate.experienceYears) || 0,
    currentEmployer: candidate.currentEmployer,
    employmentHistory: candidate.employmentHistory,
    education: candidate.education,
    currentCtc: candidate.currentCtc != null ? Number(candidate.currentCtc) : null,
    expectedCtc: candidate.expectedCtc != null ? Number(candidate.expectedCtc) : null,
    noticePeriodDays: candidate.noticePeriodDays,
    location: candidate.location,
    matchRationale: match?.rationale ?? null,
    missingSkills: match?.missingSkills ?? [],
    riskFlags: match?.riskFlags ?? [],
    writtenAssessment: await writtenAssessmentFor(input.orgId, candidate.id, requisition.id),
    expertBrief: requisition.expertBrief ?? null,
  });

  const [row] = await db
    .insert(screeningKits)
    .values({
      orgId: input.orgId,
      candidateId: candidate.id,
      requisitionId: requisition.id,
      applicationId: application?.id ?? null,
      questions: kit.questions as never,
      focusSummary: kit.focus_summary,
      engine: kit.engine as never,
      createdBy: input.createdBy,
    })
    .returning({ id: screeningKits.id });
  if (!row) throw new Error("Could not save the screening kit");

  // `engine` stays server-internal (persisted above, logged in ai_usage_events).
  return { kitId: row.id, questions: kit.questions, focus_summary: kit.focus_summary };
}

/** Replace the candidate's name (full and each part) with "the candidate" (pure; unit-tested). */
export function blindName(text: string, fullName: string | null | undefined): string {
  const parts = (fullName ?? "")
    .split(/\s+/)
    .map((p) => p.replace(/[^\p{L}'-]/gu, ""))
    .filter((p) => p.length >= 2);
  if (!parts.length) return text;
  const escape = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const full = parts.map(escape).join("\\s+");
  return text
    .replace(new RegExp(`\\b${full}\\b`, "giu"), "the candidate")
    .replace(new RegExp(`\\b(${parts.map(escape).join("|")})\\b`, "giu"), "the candidate");
}

/**
 * Grade a screening against its kit and save the run — the typed answers, call
 * notes or a transcript. No request context: the screening-call worker uses it
 * as well as the form (`createdBy` null for the AI call). Callers check access.
 */
export async function gradeScreeningForKit(input: {
  orgId: string;
  kit: typeof screeningKits.$inferSelect;
  answers: { question_id: string; answer: string }[];
  transcript: string | null;
  inputKind: string;
  audioPath?: string | null;
  audioEngine?: string | null;
  createdBy: string | null;
  /** Grade only these kit questions (a phone screen: the ones the candidate answered). */
  onlyQuestionIds?: string[];
  /** "spoken" for an AI phone screen (see gradeScreening). */
  mode?: "written" | "spoken";
  /** What the grade rests on — stored with the run and shown beside the score. */
  coverage?: ScreeningCoverage;
}) {
  const { kit } = input;
  if (kit.orgId !== input.orgId) throw new Error("Screening kit not found");
  const all = (Array.isArray(kit.questions) ? kit.questions : []) as ScreeningQuestion[];
  const only = input.onlyQuestionIds ? new Set(input.onlyQuestionIds) : null;
  const questions = only ? all.filter((q) => only.has(q.id)) : all;
  if (!questions.length) throw new Error("This kit has no questions to grade against.");
  const { candidate, requisition, jdText, match } = await loadPairing(
    input.orgId,
    kit.candidateId,
    kit.requisitionId,
  );

  // Blind grading: the grader never sees who the candidate is.
  const blind = (t: string) => blindName(t, candidate.fullName);
  const grade = await gradeScreening({
    orgId: input.orgId,
    role: requisition?.title ?? "the role",
    jdText,
    mustHave: requisition?.mustHaveSkills ?? [],
    candidateName: "the candidate",
    questions,
    answers: input.answers
      .filter((a) => !only || only.has(a.question_id))
      .map((a) => ({ ...a, answer: blind(a.answer) })),
    transcript: input.transcript ? blind(input.transcript) : null,
    ...(input.mode ? { mode: input.mode } : {}),
  });

  const matchScore =
    typeof match?.overallScore === "number" ? Math.round(match.overallScore) : null;
  const combined =
    matchScore === null
      ? grade.screening_score
      : Math.round(matchScore * 0.6 + grade.screening_score * 0.4);

  const [run] = await db
    .insert(screeningRuns)
    .values({
      orgId: input.orgId,
      kitId: kit.id,
      candidateId: kit.candidateId,
      requisitionId: kit.requisitionId,
      applicationId: kit.applicationId,
      inputKind: input.inputKind,
      answers: input.answers as never,
      transcript: input.transcript,
      audioPath: input.audioPath ?? null,
      audioEngine: input.audioEngine ?? null,
      screeningScore: grade.screening_score,
      matchScore,
      combinedScore: combined,
      verdicts: grade.verdicts as never,
      redFlags: grade.red_flags,
      rationale: grade.rationale,
      recommendation: grade.recommendation,
      recommendationReason: grade.recommendation_reason,
      engine: grade.engine as never,
      coverage: input.coverage ?? null,
      createdBy: input.createdBy,
    })
    .returning({ id: screeningRuns.id });
  if (!run) throw new Error("Could not save the screening run");
  return { run, grade, matchScore, combined };
}

export const createScreeningKit = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        candidateId: z.string().uuid(),
        requisitionId: z.string().uuid().nullable().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) =>
    prepareScreeningKitForPairing({
      orgId: context.orgId,
      candidateId: data.candidateId,
      requisitionId: data.requisitionId ?? "",
      createdBy: context.userId,
    }),
  );

/* ------------------------------------------------------------- edit a kit */

export const saveScreeningKit = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        kitId: z.string().uuid(),
        questions: z.array(QuestionSchema).min(1).max(20),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const updated = await db
      .update(screeningKits)
      .set({ questions: data.questions as never, updatedAt: new Date() })
      .where(and(eq(screeningKits.id, data.kitId), eq(screeningKits.orgId, context.orgId)))
      .returning({ id: screeningKits.id });
    if (!updated.length) throw new Error("Screening kit not found");
    return { ok: true };
  });

/* ---------------------------------------------------------- grade answers */

export const gradeScreeningAnswers = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        kitId: z.string().uuid(),
        answers: z.array(z.object({ question_id: z.string(), answer: z.string() })).default([]),
        notes: z.string().optional().nullable(),
        audio: z
          .object({
            filename: z.string(),
            contentType: z.string(),
            base64: z.string().min(20),
          })
          .optional()
          .nullable(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const [kit] = await db
      .select()
      .from(screeningKits)
      .where(and(eq(screeningKits.id, data.kitId), eq(screeningKits.orgId, context.orgId)))
      .limit(1);
    if (!kit) throw new Error("Screening kit not found");

    const questions = (Array.isArray(kit.questions) ? kit.questions : []) as ScreeningQuestion[];
    if (!questions.length) throw new Error("This kit has no questions to grade against.");

    // Audio, when supplied, is stored first and transcribed with the org's provider.
    let transcript = data.notes?.trim() ? data.notes.trim() : null;
    let audioPath: string | null = null;
    let audioEngine: string | null = null;
    let inputKind = data.audio ? "audio" : transcript ? "notes" : "typed";
    if (data.audio) {
      const bytes = Uint8Array.from(Buffer.from(data.audio.base64, "base64"));
      if (!bytes.byteLength) throw new Error("The recording was empty.");
      if (bytes.byteLength > 25 * 1024 * 1024) {
        throw new Error("The recording is too large (25 MB maximum).");
      }
      const safe =
        data.audio.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "screening.webm";
      // The vault key is derived from the verified caller org — never from a fetched row.
      audioPath = `${context.orgId}/${kit.candidateId}/${Date.now()}-${safe}`;
      await putObject(audioPath, bytes, data.audio.contentType || "audio/webm");
      const heard = await transcribeScreeningAudio({
        orgId: context.orgId,
        bytes,
        filename: data.audio.filename,
        contentType: data.audio.contentType,
      });
      transcript = [transcript, heard.transcript].filter(Boolean).join("\n\n");
      audioEngine = heard.engine;
    }

    const typed = data.answers.filter((a) => a.answer.trim().length > 0);
    if (!typed.length && !transcript) {
      throw new Error("Add the candidate's answers, call notes, or a recording first.");
    }
    if (typed.length && !data.audio && !data.notes) inputKind = "typed";

    const { run, grade, matchScore, combined } = await gradeScreeningForKit({
      orgId: context.orgId,
      kit,
      answers: typed,
      transcript,
      inputKind,
      audioPath,
      audioEngine,
      createdBy: context.userId,
    });

    // `engine`/`audio_engine` stay server-internal (persisted above).
    return {
      runId: run.id,
      screening_score: grade.screening_score,
      verdicts: grade.verdicts,
      rationale: grade.rationale,
      red_flags: grade.red_flags,
      recommendation: grade.recommendation,
      recommendation_reason: grade.recommendation_reason,
      match_score: matchScore,
      combined_score: combined,
      audio_stored: Boolean(audioPath),
    };
  });

/* ------------------------------------------------- recording delivery */

/**
 * Authenticated recording delivery. The bytes travel through ATSIQ from the
 * private vault after the caller's org is verified — no signed storage URLs.
 */
export const getScreeningAudioUrl = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => z.object({ runId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const [run] = await db
      .select({ audioPath: screeningRuns.audioPath })
      .from(screeningRuns)
      .where(and(eq(screeningRuns.id, data.runId), eq(screeningRuns.orgId, context.orgId)))
      .limit(1);
    if (!run?.audioPath) throw new Error("No recording was stored for this screening.");
    // Defence in depth: the vault key must live inside this org's folder.
    if (!run.audioPath.startsWith(`${context.orgId}/`)) {
      throw new Error("That recording could not be opened.");
    }
    const file = await getObject(run.audioPath);
    if (!file) throw new Error("That recording could not be opened.");
    if (file.bytes.byteLength > 25 * 1024 * 1024) {
      throw new Error("That recording is too large to open through ATSIQ.");
    }
    const contentType = file.contentType.startsWith("audio/") ? file.contentType : "audio/webm";
    return {
      dataUrl: `data:${contentType};base64,${Buffer.from(file.bytes).toString("base64")}`,
    };
  });
