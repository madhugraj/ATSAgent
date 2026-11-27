/**
 * Ranked shortlists (plan rows 9–10, C2): requisitions ranked by profile
 * matching, each candidate's score breakdown, per-requirement verdicts with the
 * CV passages behind them, knock-outs and rationale; a recruiter shortlists or
 * rejects. Decisions are recorded (audited, and as training feedback when the
 * organisation consented) — they never contact anyone. Org-scoped throughout.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  applications,
  candidateCvVersions,
  candidates,
  profileMatchRuns,
  profileMatchScores,
  requisitions,
  type MatchFactor,
  type MatchKnockout,
  type MatchRequirement,
} from "@db/schema";
import { db } from "../server/db";
import { assertRole, requireOrg, type AppRole } from "./auth.middleware";
import { requireCapability } from "./capabilities.server";
import { evaluateRanking, type EvaluationResult } from "./shortlist-eval";

export type { EvaluationResult };

const RECRUITER_SIDE: AppRole[] = ["recruiter", "hr_head", "president_cbo"];

export type RankedRequisition = {
  id: string;
  title: string;
  code: string;
  status: string;
  runStatus: string | null;
  lastRunAt: string | null;
  pool: number;
  reviewed: number;
  shortlisted: number;
  topScore: number | null;
};

export const listRankedRequisitionsFn = createServerFn({ method: "GET" })
  .middleware([requireOrg, requireCapability("matching.shortlist")])
  .handler(async ({ context }): Promise<RankedRequisition[]> => {
    const rows = await db
      .select({
        id: requisitions.id,
        title: requisitions.title,
        code: requisitions.code,
        status: requisitions.status,
        runStatus: profileMatchRuns.status,
        lastRunAt: profileMatchRuns.lastRunAt,
        pool: profileMatchRuns.poolSize,
      })
      .from(profileMatchRuns)
      .innerJoin(requisitions, eq(requisitions.id, profileMatchRuns.requisitionId))
      .where(and(eq(profileMatchRuns.orgId, context.orgId), eq(requisitions.orgId, context.orgId)))
      .orderBy(desc(requisitions.createdAt));
    if (!rows.length) return [];
    const stats = await db
      .select({
        requisitionId: profileMatchScores.requisitionId,
        reviewed: sql<number>`count(*) filter (where ${profileMatchScores.reviewStage} = 'judged')::int`,
        shortlisted: sql<number>`count(*) filter (where ${profileMatchScores.decision} = 'shortlisted')::int`,
        top: sql<number | null>`max(${profileMatchScores.overallScore})`,
      })
      .from(profileMatchScores)
      .where(
        and(
          eq(profileMatchScores.orgId, context.orgId),
          inArray(
            profileMatchScores.requisitionId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .groupBy(profileMatchScores.requisitionId);
    const by = new Map(stats.map((s) => [s.requisitionId, s]));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      code: r.code,
      status: r.status,
      runStatus: r.runStatus,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      pool: r.pool,
      reviewed: by.get(r.id)?.reviewed ?? 0,
      shortlisted: by.get(r.id)?.shortlisted ?? 0,
      topScore: by.get(r.id)?.top ?? null,
    }));
  });

export type ShortlistRow = {
  candidateId: string;
  name: string;
  location: string | null;
  experienceYears: number;
  currentRole: string | null;
  rank: number;
  score: number;
  reviewed: boolean;
  factors: MatchFactor[];
  requirements: MatchRequirement[];
  knockouts: MatchKnockout[];
  rationale: string | null;
  decision: "shortlisted" | "rejected" | null;
  decisionNote: string | null;
};

export const getShortlistFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.shortlist")])
  .validator((d: unknown) =>
    z
      .object({
        requisitionId: z.string().uuid(),
        filter: z.enum(["all", "shortlisted", "rejected", "open"]).default("all"),
        limit: z.number().int().min(10).max(500).default(100),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const [req] = await db
      .select({ id: requisitions.id, title: requisitions.title, code: requisitions.code })
      .from(requisitions)
      .where(and(eq(requisitions.id, data.requisitionId), eq(requisitions.orgId, context.orgId)));
    const [run] = await db
      .select()
      .from(profileMatchRuns)
      .where(
        and(
          eq(profileMatchRuns.requisitionId, data.requisitionId),
          eq(profileMatchRuns.orgId, context.orgId),
        ),
      );
    const where = [
      eq(profileMatchScores.orgId, context.orgId),
      eq(profileMatchScores.requisitionId, data.requisitionId),
    ];
    if (data.filter === "shortlisted") where.push(eq(profileMatchScores.decision, "shortlisted"));
    if (data.filter === "rejected") where.push(eq(profileMatchScores.decision, "rejected"));
    if (data.filter === "open") where.push(sql`${profileMatchScores.decision} is null`);
    const rows = await db
      .select({
        s: profileMatchScores,
        name: candidates.fullName,
        location: candidates.location,
        experienceYears: candidates.experienceYears,
        currentEmployer: candidates.currentEmployer,
      })
      .from(profileMatchScores)
      .innerJoin(candidates, eq(candidates.id, profileMatchScores.candidateId))
      .where(and(...where, eq(candidates.orgId, context.orgId)))
      .orderBy(
        sql`${profileMatchScores.overallScore} desc nulls last`,
        asc(profileMatchScores.coarseRank),
      )
      .limit(data.limit);
    const out: ShortlistRow[] = rows.map((r, i) => ({
      candidateId: r.s.candidateId,
      name: r.name,
      location: r.location,
      experienceYears: Number(r.experienceYears) || 0,
      currentRole: r.currentEmployer,
      rank: i + 1,
      score: r.s.overallScore ?? Math.round(Number(r.s.coarseScore) * 100),
      reviewed: r.s.reviewStage === "judged",
      factors: r.s.factors,
      requirements: r.s.requirements,
      knockouts: r.s.knockouts,
      rationale: r.s.rationale,
      decision: r.s.decision,
      decisionNote: r.s.decisionNote,
    }));
    // Version file names for the cited passages.
    const versionIds = [
      ...new Set(
        out.flatMap((r) => r.requirements.flatMap((q) => q.evidence.map((e) => e.versionId))),
      ),
    ];
    const versions = versionIds.length
      ? await db
          .select({ id: candidateCvVersions.id, fileName: candidateCvVersions.fileName })
          .from(candidateCvVersions)
          .where(
            and(
              eq(candidateCvVersions.orgId, context.orgId),
              inArray(candidateCvVersions.id, versionIds),
            ),
          )
      : [];
    return {
      requisition: req!,
      run: run
        ? {
            status: run.status,
            pool: run.poolSize,
            lastRunAt: run.lastRunAt?.toISOString() ?? null,
          }
        : null,
      versionNames: Object.fromEntries(versions.map((v) => [v.id, v.fileName ?? "CV"])),
      rows: out,
    };
  });

export const decideShortlistFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.shortlist")])
  .validator((d: unknown) =>
    z
      .object({
        requisitionId: z.string().uuid(),
        candidateId: z.string().uuid(),
        decision: z.enum(["shortlisted", "rejected", "clear"]),
        note: z.string().max(1000).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertRole(context.userId, context.orgId, RECRUITER_SIDE);
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const decision = data.decision === "clear" ? null : data.decision;
    const [row] = await db
      .update(profileMatchScores)
      .set({
        decision,
        decisionNote: data.note ?? null,
        decidedBy: decision ? context.userId : null,
        decidedAt: decision ? new Date() : null,
      })
      .where(
        and(
          eq(profileMatchScores.orgId, context.orgId),
          eq(profileMatchScores.requisitionId, data.requisitionId),
          eq(profileMatchScores.candidateId, data.candidateId),
        ),
      )
      .returning();
    if (!row) throw new Error("That candidate is not ranked for this role.");

    // A shortlisted person joins the role's pipeline the way pool matches do
    // (default stage, no message); an existing application is left exactly as it is.
    if (decision === "shortlisted")
      await db
        .insert(applications)
        .values({
          orgId: context.orgId,
          requisitionId: data.requisitionId,
          candidateId: data.candidateId,
          source: "profile_match",
        })
        .onConflictDoNothing();

    const { writeAudit } = await import("../server/audit");
    void writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: `shortlist.${data.decision}`,
      entityType: "requisition",
      entityId: data.requisitionId,
      detail: { candidateId: data.candidateId, score: row.overallScore },
    });
    if (decision) {
      const { captureFeedback } = await import("../server/training/capture.server");
      void captureFeedback({
        orgId: context.orgId,
        source: "shortlist_decision",
        label: decision,
        reason: data.note ?? null,
        original: {
          score: row.overallScore,
          rank: row.coarseRank,
          requirements: row.requirements.map((r) => ({
            requirement: r.requirement,
            verdict: r.verdict,
          })),
        },
        corrected: { decision },
        requisitionId: data.requisitionId,
        candidateId: data.candidateId,
        actorUserId: context.userId,
      });
    }
    return { ok: true as const };
  });

export const rerankFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.shortlist")])
  .validator((d: unknown) => z.object({ requisitionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId, context.orgId, RECRUITER_SIDE);
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const { requestRequisitionMatch } = await import("../server/candidates/profile-match.server");
    await requestRequisitionMatch(context.orgId, data.requisitionId);
    return { ok: true as const };
  });

/** CSV of the ranked list with decisions, for sharing outside the app. */
export const shortlistCsvFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.shortlist")])
  .validator((d: unknown) => z.object({ requisitionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const rows = await db
      .select({
        name: candidates.fullName,
        email: candidates.email,
        location: candidates.location,
        score: profileMatchScores.overallScore,
        coarse: profileMatchScores.coarseScore,
        decision: profileMatchScores.decision,
        rationale: profileMatchScores.rationale,
        requirements: profileMatchScores.requirements,
      })
      .from(profileMatchScores)
      .innerJoin(candidates, eq(candidates.id, profileMatchScores.candidateId))
      .where(
        and(
          eq(profileMatchScores.orgId, context.orgId),
          eq(profileMatchScores.requisitionId, data.requisitionId),
          eq(candidates.orgId, context.orgId),
          isNotNull(profileMatchScores.overallScore),
        ),
      )
      .orderBy(sql`${profileMatchScores.overallScore} desc`);
    const esc = (v: unknown) =>
      `"${String(v ?? "")
        .replace(/"/g, '""')
        .replace(/^[=+\-@]/, "'$&")}"`;
    const lines = [
      "rank,name,email,location,score,decision,met,partial,missing,rationale",
      ...rows.map((r, i) =>
        [
          i + 1,
          esc(r.name),
          esc(r.email),
          esc(r.location),
          r.score ?? "",
          r.decision ?? "",
          r.requirements.filter((q) => q.verdict === "met").length,
          r.requirements.filter((q) => q.verdict === "partial").length,
          r.requirements.filter((q) => q.verdict === "missing").length,
          esc(r.rationale),
        ].join(","),
      ),
    ];
    const { writeAudit } = await import("../server/audit");
    void writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "shortlist.exported",
      entityType: "requisition",
      entityId: data.requisitionId,
    });
    return { csv: lines.join("\n") };
  });

/**
 * Evaluation (C3): compare our ranking with people the organisation actually
 * shortlisted or placed for this role (emails or full names, one per line).
 * Read-only; nothing is stored.
 */
export const evaluateShortlistFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.shortlist")])
  .validator((d: unknown) =>
    z
      .object({
        requisitionId: z.string().uuid(),
        entries: z.array(z.string().trim().min(2).max(200)).min(1).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<EvaluationResult> => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const ranked = await db
      .select({ id: candidates.id, name: candidates.fullName, email: candidates.email })
      .from(profileMatchScores)
      .innerJoin(candidates, eq(candidates.id, profileMatchScores.candidateId))
      .where(
        and(
          eq(profileMatchScores.orgId, context.orgId),
          eq(profileMatchScores.requisitionId, data.requisitionId),
          eq(candidates.orgId, context.orgId),
        ),
      )
      .orderBy(
        sql`${profileMatchScores.overallScore} desc nulls last`,
        asc(profileMatchScores.coarseRank),
      );
    return evaluateRanking(
      ranked.map((r) => ({ name: r.name, email: r.email })),
      data.entries,
    );
  });
