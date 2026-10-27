/**
 * "Why this score": the reasons behind a screening grade, for the hiring desk's
 * pop-up — each question's verdict, the evidence it rests on and why, the
 * questions a call did not reach, and how the score is put together. Never the
 * transcript, pay or the AI engine (those stay on the candidate page / HR-only
 * record / the database).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { applications, candidates, requisitions, screeningKits, screeningRuns } from "@db/schema";
import type { ScreeningCoverage } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { db } from "../server/db";
import { coverageWords, notReached } from "./screening-coverage";

export type ScreeningRationale = {
  candidateId: string;
  name: string;
  role: string;
  /** phone = the AI screening call; written = the written assessment or a typed screen. */
  kind: "phone" | "written";
  at: string;
  score: number;
  matchScore: number | null;
  combinedScore: number | null;
  /** As shown to people: "Proceed", "Probe further", "Hold", "Reject". */
  recommendation: string | null;
  recommendationReason: string | null;
  rationale: string | null;
  redFlags: string[];
  coverage: { words: string; confidence: "high" | "medium" | "low" } | null;
  questions: {
    question: string;
    focus: string | null;
    verdict: string;
    score: number;
    weight: number | null;
    evidence: string;
    rationale: string;
  }[];
  notReached: { question: string; focus: string | null }[];
};

type Verdict = {
  question_id: string;
  question: string;
  verdict: string;
  score: number;
  evidence: string;
  rationale: string;
};
type KitQuestion = { id: string; question: string; focus?: string; weight?: number };

const LABEL: Record<string, string> = {
  proceed: "Proceed",
  hold: "Hold",
  reject: "Reject",
};

export const getScreeningRationale = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({ runId: z.string().uuid().optional(), applicationId: z.string().uuid().optional() })
      .refine((v) => v.runId || v.applicationId, "runId or applicationId")
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<ScreeningRationale | null> => {
    const [run] = await db
      .select()
      .from(screeningRuns)
      .where(
        and(
          eq(screeningRuns.orgId, context.orgId),
          data.runId
            ? eq(screeningRuns.id, data.runId)
            : eq(screeningRuns.applicationId, data.applicationId!),
        ),
      )
      .orderBy(desc(screeningRuns.createdAt))
      .limit(1);
    if (!run) return null;
    const [who] = await db
      .select({ name: candidates.fullName })
      .from(candidates)
      .where(and(eq(candidates.id, run.candidateId), eq(candidates.orgId, context.orgId)))
      .limit(1);
    const [req] = run.applicationId
      ? await db
          .select({ code: requisitions.code, title: requisitions.title })
          .from(applications)
          .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
          .where(and(eq(applications.id, run.applicationId), eq(applications.orgId, context.orgId)))
          .limit(1)
      : [];
    const [kit] = await db
      .select({ questions: screeningKits.questions })
      .from(screeningKits)
      .where(and(eq(screeningKits.id, run.kitId), eq(screeningKits.orgId, context.orgId)))
      .limit(1);
    const kitQs = (Array.isArray(kit?.questions) ? kit.questions : []) as KitQuestion[];
    const byId = new Map(kitQs.map((q) => [q.id, q]));
    const verdicts = (Array.isArray(run.verdicts) ? run.verdicts : []) as Verdict[];
    const phone = run.inputKind === "phone_ai";
    const coverage = (run.coverage ?? null) as ScreeningCoverage | null;
    return {
      candidateId: run.candidateId,
      name: who?.name ?? "The candidate",
      role: req ? `${req.code} ${req.title}` : "",
      kind: phone ? "phone" : "written",
      at: run.createdAt.toISOString(),
      score: run.screeningScore,
      matchScore: run.matchScore,
      combinedScore: run.combinedScore,
      recommendation:
        phone && run.recommendation === "hold"
          ? "Probe further"
          : run.recommendation
            ? (LABEL[run.recommendation] ?? run.recommendation)
            : null,
      recommendationReason: run.recommendationReason,
      rationale: run.rationale,
      redFlags: run.redFlags,
      coverage: coverage
        ? { words: coverageWords(coverage), confidence: coverage.confidence }
        : null,
      questions: verdicts.map((v) => ({
        question: v.question,
        focus: byId.get(v.question_id)?.focus ?? null,
        verdict: v.verdict,
        score: v.score,
        weight: byId.get(v.question_id)?.weight ?? null,
        evidence: v.evidence,
        rationale: v.rationale,
      })),
      notReached: coverage
        ? notReached(coverage).map((id) => ({
            question: byId.get(id)?.question ?? id,
            focus: byId.get(id)?.focus ?? null,
          }))
        : [],
    };
  });
