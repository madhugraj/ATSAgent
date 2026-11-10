/**
 * Call reviews (docs/voice-guard.md): the Voice Guard's review of every
 * answered AI phone call, for a person — the queue, one review with the
 * transcript it quotes, a person's reading of it (the findings hold or not),
 * "Review again", and the summary on the agent health page.
 *
 * Reviews quote the transcript, which carries the pay the candidate stated:
 * the people who may see a call's transcript (TA, the HR head, the CBO,
 * owners) only. Vendor- and model-neutral.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, count, desc, eq, gte, isNull, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import {
  callReviews,
  candidates,
  requisitions,
  screeningCalls,
  type CallReviewCheck,
  type CallReviewFinding,
  type CallStats,
  type ScreeningCallTurn,
} from "@db/schema";
import { requireOrg } from "./auth.middleware";

/** Who may read call transcripts — and so the reviews that quote them. */
const CALL_ROLES = ["recruiter", "hr_head", "president_cbo"] as const;

async function assertCallRole(userId: string, orgId: string): Promise<void> {
  const { assertRole } = await import("./auth.middleware");
  await assertRole(userId, orgId, [...CALL_ROLES]);
}

const ListInput = z.object({
  purpose: z.enum(["screening", "scheduling", "negotiation"]).optional(),
  verdict: z.enum(["pass", "attention", "breach"]).optional(),
  status: z.enum(["due", "reviewing", "done", "failed"]).optional(),
  /** Only reviews no person has read yet. */
  unread: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});

export type CallReviewRow = {
  id: string;
  callId: string;
  purpose: "screening" | "scheduling" | "negotiation";
  status: "due" | "reviewing" | "done" | "failed";
  scope: "full" | "timing_only";
  verdict: "pass" | "attention" | "breach" | null;
  breaches: number;
  findings: number;
  qualityScore: number | null;
  candidateId: string;
  candidateName: string | null;
  role: string | null;
  endedAt: string | null;
  durationS: number | null;
  reviewedAt: string | null;
  ackOutcome: "confirmed" | "disputed" | null;
};

export const listCallReviews = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => ListInput.parse(d ?? {}))
  .handler(async ({ data, context }): Promise<{ rows: CallReviewRow[]; total: number }> => {
    await assertCallRole(context.userId, context.orgId);
    const where = and(
      eq(callReviews.orgId, context.orgId),
      data.purpose ? eq(callReviews.purpose, data.purpose) : undefined,
      data.verdict ? eq(callReviews.verdict, data.verdict) : undefined,
      data.status ? eq(callReviews.status, data.status) : undefined,
      data.unread
        ? and(eq(callReviews.status, "done"), isNull(callReviews.acknowledgedAt))
        : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select({
          id: callReviews.id,
          callId: callReviews.callId,
          purpose: callReviews.purpose,
          status: callReviews.status,
          scope: callReviews.scope,
          verdict: callReviews.verdict,
          breaches: callReviews.breaches,
          findings: sql<number>`jsonb_array_length(${callReviews.findings})::int`,
          qualityScore: callReviews.qualityScore,
          candidateId: screeningCalls.candidateId,
          candidateName: candidates.fullName,
          role: requisitions.title,
          endedAt: screeningCalls.endedAt,
          durationS: screeningCalls.durationS,
          reviewedAt: callReviews.reviewedAt,
          ackOutcome: callReviews.ackOutcome,
        })
        .from(callReviews)
        .innerJoin(
          screeningCalls,
          and(eq(screeningCalls.id, callReviews.callId), eq(screeningCalls.orgId, context.orgId)),
        )
        .leftJoin(
          candidates,
          and(eq(candidates.id, screeningCalls.candidateId), eq(candidates.orgId, context.orgId)),
        )
        .leftJoin(
          requisitions,
          and(
            eq(requisitions.id, screeningCalls.requisitionId),
            eq(requisitions.orgId, context.orgId),
          ),
        )
        .where(where)
        .orderBy(desc(screeningCalls.endedAt))
        .limit(data.limit)
        .offset(data.offset),
      db.select({ n: count() }).from(callReviews).where(where),
    ]);
    return {
      total: total?.n ?? 0,
      rows: rows.map((r) => ({
        ...r,
        endedAt: r.endedAt?.toISOString() ?? null,
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
      })),
    };
  });

export type CallReviewDetail = CallReviewRow & {
  summary: string | null;
  lastError: string | null;
  checks: CallReviewCheck[];
  findingList: CallReviewFinding[];
  stats: CallStats | null;
  transcript: ScreeningCallTurn[];
  endReason: string | null;
  consented: boolean;
  ackNote: string | null;
  acknowledgedAt: string | null;
  /** The checks in plain words, for the page. */
  checkTitles: Record<string, { title: string; question: string }>;
};

export const getCallReview = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<CallReviewDetail> => {
    await assertCallRole(context.userId, context.orgId);
    const [r] = await db
      .select({
        review: callReviews,
        call: {
          candidateId: screeningCalls.candidateId,
          endedAt: screeningCalls.endedAt,
          durationS: screeningCalls.durationS,
          endReason: screeningCalls.endReason,
          consentAt: screeningCalls.consentAt,
          transcript: screeningCalls.transcript,
          callStats: screeningCalls.callStats,
        },
        candidateName: candidates.fullName,
        role: requisitions.title,
      })
      .from(callReviews)
      .innerJoin(
        screeningCalls,
        and(eq(screeningCalls.id, callReviews.callId), eq(screeningCalls.orgId, context.orgId)),
      )
      .leftJoin(
        candidates,
        and(eq(candidates.id, screeningCalls.candidateId), eq(candidates.orgId, context.orgId)),
      )
      .leftJoin(
        requisitions,
        and(
          eq(requisitions.id, screeningCalls.requisitionId),
          eq(requisitions.orgId, context.orgId),
        ),
      )
      .where(and(eq(callReviews.orgId, context.orgId), eq(callReviews.id, data.id)))
      .limit(1);
    if (!r) throw new Error("Review not found.");
    const { GUARD_CHECKS } = await import("../server/voice/guard/checks");
    const v = r.review;
    return {
      id: v.id,
      callId: v.callId,
      purpose: v.purpose,
      status: v.status,
      scope: v.scope,
      verdict: v.verdict,
      breaches: v.breaches,
      findings: v.findings.length,
      qualityScore: v.qualityScore,
      candidateId: r.call.candidateId,
      candidateName: r.candidateName,
      role: r.role,
      endedAt: r.call.endedAt?.toISOString() ?? null,
      durationS: r.call.durationS,
      reviewedAt: v.reviewedAt?.toISOString() ?? null,
      ackOutcome: v.ackOutcome,
      summary: v.summary,
      lastError: v.status === "failed" ? v.lastError : null,
      checks: v.checks,
      findingList: v.findings,
      stats: r.call.callStats ?? null,
      transcript: r.call.transcript,
      endReason: r.call.endReason,
      consented: r.call.consentAt !== null,
      ackNote: v.ackNote,
      acknowledgedAt: v.acknowledgedAt?.toISOString() ?? null,
      checkTitles: Object.fromEntries(
        GUARD_CHECKS.map((c) => [c.id, { title: c.title, question: c.question }]),
      ),
    };
  });

/**
 * A person's reading of a review: the findings hold (confirmed) or they do not
 * (disputed). Audited, and captured as training feedback on both the Voice
 * Guard's run and — when confirmed — the call agent's run.
 */
export const acknowledgeCallReview = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        outcome: z.enum(["confirmed", "disputed"]),
        note: z.string().trim().max(1000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertCallRole(context.userId, context.orgId);
    const [r] = await db
      .update(callReviews)
      .set({
        acknowledgedBy: context.userId,
        acknowledgedAt: new Date(),
        ackOutcome: data.outcome,
        ackNote: data.note ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(callReviews.orgId, context.orgId),
          eq(callReviews.id, data.id),
          eq(callReviews.status, "done"),
        ),
      )
      .returning();
    if (!r) throw new Error("Only a finished review can be marked.");
    const [call] = await db
      .select({
        agentRunId: screeningCalls.agentRunId,
        applicationId: screeningCalls.applicationId,
        candidateId: screeningCalls.candidateId,
        requisitionId: screeningCalls.requisitionId,
      })
      .from(screeningCalls)
      .where(and(eq(screeningCalls.orgId, context.orgId), eq(screeningCalls.id, r.callId)))
      .limit(1);
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "call_review.acknowledged",
      entityType: "call_review",
      entityId: r.id,
      detail: { outcome: data.outcome, verdict: r.verdict, findings: r.findings.length },
    });
    // Training data (docs/agentic-plan.md §14): a person judged the guard's work,
    // and — when the findings hold — the call agent's.
    const { captureFeedback } = await import("../server/training/capture.server");
    const who = {
      orgId: context.orgId,
      requisitionId: call?.requisitionId ?? null,
      applicationId: call?.applicationId ?? null,
      candidateId: call?.candidateId ?? null,
      actorUserId: context.userId,
    };
    if (r.agentRunId)
      void captureFeedback({
        ...who,
        source: "voice_guard_review",
        label: data.outcome,
        reason: data.note ?? null,
        original: { verdict: r.verdict, findings: r.findings },
        agentRunId: r.agentRunId,
      });
    if (data.outcome === "confirmed" && r.verdict !== "pass" && call?.agentRunId)
      void captureFeedback({
        ...who,
        source: "voice_call_reviewed",
        label: r.verdict ?? "attention",
        reason: data.note ?? null,
        original: { findings: r.findings },
        agentRunId: call.agentRunId,
      });
    return { ok: true };
  });

/** Review the call again (e.g. after the Voice Guard changed). Audited. */
export const reviewCallAgain = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertCallRole(context.userId, context.orgId);
    const { requeueReview } = await import("../server/voice/guard/review.server");
    if (!(await requeueReview(context.orgId, data.id)))
      throw new Error("Only a finished or failed review can be done again.");
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "call_review.requeued",
      entityType: "call_review",
      entityId: data.id,
    });
    const { kickAgents } = await import("../server/agents/orchestrator.server");
    kickAgents(context.orgId);
    return { ok: true };
  });

export type CallReviewSummary = {
  days: number;
  reviewed: number;
  pass: number;
  attention: number;
  breach: number;
  /** Reviewed but no person has marked them yet (breach and attention). */
  unread: number;
  /** Still to be reviewed, under review, or given up on. */
  pending: number;
  failed: number;
  avgQuality: number | null;
  byPurpose: { purpose: string; reviewed: number; breach: number }[];
  topChecks: { check: string; title: string; n: number }[];
};

/** Last 7 days of reviews — the card on the agent health page. */
export const callReviewSummary = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<CallReviewSummary> => {
    await assertCallRole(context.userId, context.orgId);
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = await db
      .select({
        purpose: callReviews.purpose,
        status: callReviews.status,
        verdict: callReviews.verdict,
        quality: callReviews.qualityScore,
        acked: isNotNull(callReviews.acknowledgedAt),
        findings: callReviews.findings,
      })
      .from(callReviews)
      .where(and(eq(callReviews.orgId, context.orgId), gte(callReviews.createdAt, since)));
    const done = rows.filter((r) => r.status === "done");
    const quality = done.map((r) => r.quality).filter((q): q is number => q !== null);
    const { CHECK_BY_ID } = await import("../server/voice/guard/checks");
    const checkCounts = new Map<string, number>();
    for (const r of done)
      for (const f of r.findings)
        if (f.severity !== "low") checkCounts.set(f.check, (checkCounts.get(f.check) ?? 0) + 1);
    const purposes = new Map<string, { reviewed: number; breach: number }>();
    for (const r of done) {
      const p = purposes.get(r.purpose) ?? { reviewed: 0, breach: 0 };
      p.reviewed++;
      if (r.verdict === "breach") p.breach++;
      purposes.set(r.purpose, p);
    }
    return {
      days: 7,
      reviewed: done.length,
      pass: done.filter((r) => r.verdict === "pass").length,
      attention: done.filter((r) => r.verdict === "attention").length,
      breach: done.filter((r) => r.verdict === "breach").length,
      unread: done.filter((r) => r.verdict !== "pass" && !r.acked).length,
      pending: rows.filter((r) => r.status !== "done").length,
      failed: rows.filter((r) => r.status === "failed").length,
      avgQuality: quality.length
        ? Math.round((quality.reduce((a, b) => a + b, 0) / quality.length) * 10) / 10
        : null,
      byPurpose: [...purposes].map(([purpose, v]) => ({ purpose, ...v })),
      topChecks: [...checkCounts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([check, n]) => ({
          check,
          n,
          title: CHECK_BY_ID.get(check as never)?.title ?? check,
        })),
    };
  });
