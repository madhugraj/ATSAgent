import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";

import { assertRole, requireOrg } from "@/lib/auth.middleware";
import {
  buildRecruiterPerformance,
  DEFAULT_SCHEME,
  type IncentiveScheme,
  type QualityBand,
} from "./hr-performance.server";
import { db } from "@/server/db";
import {
  applications,
  hrIncentiveSchemes,
  interviews,
  matchScores,
  offers,
  screeningRuns,
  stageEvents,
} from "@db/schema";

const loadScheme = createServerOnlyFn(async function loadScheme(
  orgId: string,
): Promise<IncentiveScheme> {
  const [row] = await db
    .select()
    .from(hrIncentiveSchemes)
    .where(eq(hrIncentiveSchemes.orgId, orgId))
    .limit(1);
  if (!row) return DEFAULT_SCHEME;
  return {
    currency: row.currency ?? "INR",
    target_closures_per_month: Number(row.targetClosuresPerMonth ?? 3),
    payout_per_closure: Number(row.payoutPerClosure ?? 10000),
    quality_bands: (Array.isArray(row.qualityBands)
      ? row.qualityBands
      : DEFAULT_SCHEME.quality_bands) as QualityBand[],
    monthly_cap: row.monthlyCap === null ? null : Number(row.monthlyCap),
    notes: row.notes ?? null,
  };
});

/** Recruiter-by-recruiter delivery, quality and incentive workings for the CHRO. */
export const getHrPerformance = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((input: unknown) =>
    z.object({ days: z.number().int().min(7).max(730).default(90) }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    // Team-wide numbers: owner plus the CHRO (President/CBO) and HR Head only.
    if (!context.isOwner) {
      await assertRole(
        context.userId,
        context.orgId,
        ["president_cbo", "hr_head"],
        "Team performance is visible to the CHRO, HR Head and the account owner only.",
      );
    }
    const orgId = context.orgId;
    const scheme = await loadScheme(orgId);

    const since = new Date(Date.now() - data.days * 86_400_000);

    const [events, applicationRows, interviewRows, offerRows, matchRows, runRows] =
      await Promise.all([
        db
          .select({
            application_id: stageEvents.applicationId,
            actor: stageEvents.actor,
            to_stage: stageEvents.toStage,
            created_at: stageEvents.createdAt,
          })
          .from(stageEvents)
          .where(and(eq(stageEvents.orgId, orgId), gte(stageEvents.createdAt, since))),
        db
          .select({ id: applications.id, applied_at: applications.appliedAt })
          .from(applications)
          .where(eq(applications.orgId, orgId)),
        db
          .select({
            application_id: interviews.applicationId,
            status: interviews.status,
            scheduled_at: interviews.scheduledAt,
          })
          .from(interviews)
          .where(eq(interviews.orgId, orgId)),
        db
          .select({ application_id: offers.applicationId, status: offers.status })
          .from(offers)
          .where(eq(offers.orgId, orgId)),
        db
          .select({
            application_id: matchScores.applicationId,
            overall_score: matchScores.overallScore,
            computed_at: matchScores.computedAt,
          })
          .from(matchScores)
          .where(eq(matchScores.orgId, orgId)),
        db
          .select({
            application_id: screeningRuns.applicationId,
            combined_score: screeningRuns.combinedScore,
            created_at: screeningRuns.createdAt,
          })
          .from(screeningRuns)
          .where(eq(screeningRuns.orgId, orgId)),
      ]);

    // Quality per application: the screening-backed combined fit when it exists,
    // otherwise the JD/CV match score.
    const quality = new Map<string, number>();
    for (const m of matchRows) {
      if (typeof m.overall_score === "number") quality.set(m.application_id, m.overall_score);
    }
    for (const r of runRows) {
      if (r.application_id && typeof r.combined_score === "number") {
        quality.set(r.application_id, r.combined_score);
      }
    }

    const result = buildRecruiterPerformance({
      events: events.map((e) => ({
        application_id: e.application_id,
        actor: e.actor,
        to_stage: e.to_stage,
        created_at: e.created_at.toISOString(),
      })),
      applications: applicationRows.map((a) => ({
        id: a.id,
        applied_at: a.applied_at.toISOString(),
      })),
      interviews: interviewRows.map((i) => ({
        application_id: i.application_id,
        status: i.status,
        scheduled_at: i.scheduled_at ? i.scheduled_at.toISOString() : null,
      })),
      offers: offerRows,
      quality: [...quality.entries()].map(([application_id, score]) => ({ application_id, score })),
      scheme,
      months: Math.max(1, Math.round(data.days / 30)),
    });

    return {
      scheme,
      days: data.days,
      rows: result.rows,
      unattributed: result.unattributed,
      totals: {
        closures: result.rows.reduce((s, r) => s + (r.joined || r.offers_accepted), 0),
        payout: result.rows.reduce((s, r) => s + r.payout, 0),
        recruiters: result.rows.length,
      },
    };
  });

/** Save the incentive scheme the payouts above are calculated from. */
export const saveIncentiveScheme = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((input: unknown) =>
    z
      .object({
        currency: z.string().min(1).max(8),
        target_closures_per_month: z.number().int().min(1).max(100),
        payout_per_closure: z.number().min(0),
        quality_bands: z
          .array(
            z.object({
              min_score: z.number().min(0).max(100),
              multiplier: z.number().min(0).max(5),
            }),
          )
          .min(1),
        monthly_cap: z.number().min(0).nullable(),
        notes: z.string().max(2000).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await db
      .insert(hrIncentiveSchemes)
      .values({
        orgId: context.orgId,
        currency: data.currency,
        targetClosuresPerMonth: data.target_closures_per_month,
        payoutPerClosure: String(data.payout_per_closure),
        qualityBands: data.quality_bands,
        monthlyCap: data.monthly_cap === null ? null : String(data.monthly_cap),
        notes: data.notes,
        updatedBy: context.userId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: hrIncentiveSchemes.orgId,
        set: {
          currency: data.currency,
          targetClosuresPerMonth: data.target_closures_per_month,
          payoutPerClosure: String(data.payout_per_closure),
          qualityBands: data.quality_bands,
          monthlyCap: data.monthly_cap === null ? null : String(data.monthly_cap),
          notes: data.notes,
          updatedBy: context.userId,
          updatedAt: new Date(),
        },
      });
    return { ok: true as const };
  });
