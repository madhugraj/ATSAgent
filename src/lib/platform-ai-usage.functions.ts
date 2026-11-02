import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { aiUsageEvents, organizations } from "@db/schema";
import { requirePlatformAdmin } from "./auth.middleware";

/**
 * Platform-console AI spend analytics. Every row of ai_usage_events is one
 * provider request; these read-only aggregates are what the R&D dashboard and
 * the event log render. Super-user only (platform_admins allowlist).
 */

const RangeInput = z.object({
  orgId: z.string().uuid().optional().nullable(),
  feature: z.string().max(60).optional().nullable(),
  provider: z.string().max(30).optional().nullable(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
});

type Range = z.infer<typeof RangeInput>;

function rangeWhere(r: Range | undefined) {
  if (!r) return undefined;
  const conds = [];
  if (r.orgId) conds.push(eq(aiUsageEvents.orgId, r.orgId));
  if (r.feature) conds.push(eq(aiUsageEvents.feature, r.feature));
  if (r.provider) conds.push(eq(aiUsageEvents.provider, r.provider));
  if (r.from) conds.push(gte(aiUsageEvents.createdAt, new Date(`${r.from}T00:00:00Z`)));
  if (r.to) conds.push(lte(aiUsageEvents.createdAt, new Date(`${r.to}T23:59:59Z`)));
  return conds.length ? and(...conds) : undefined;
}

const n = (v: unknown) => Number(v ?? 0);

export type AiUsageOverview = Awaited<ReturnType<typeof aiUsageOverview>>;

export const aiUsageOverview = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((data: unknown) => RangeInput.parse(data ?? {}))
  .handler(async ({ data }) => {
    const where = rangeWhere(data);

    const [totals] = await db
      .select({
        calls: sql<number>`count(*)`,
        promptTokens: sql<number>`coalesce(sum(${aiUsageEvents.promptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${aiUsageEvents.completionTokens}), 0)`,
        totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)`,
        errors: sql<number>`count(*) filter (where ${aiUsageEvents.status} = 'error')`,
        avgDurationMs: sql<number>`coalesce(avg(${aiUsageEvents.durationMs}), 0)`,
        orgs: sql<number>`count(distinct ${aiUsageEvents.orgId})`,
      })
      .from(aiUsageEvents)
      .where(where);

    const byFeature = await db
      .select({
        feature: aiUsageEvents.feature,
        calls: sql<number>`count(*)`,
        promptTokens: sql<number>`coalesce(sum(${aiUsageEvents.promptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${aiUsageEvents.completionTokens}), 0)`,
        totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)`,
        errors: sql<number>`count(*) filter (where ${aiUsageEvents.status} = 'error')`,
      })
      .from(aiUsageEvents)
      .where(where)
      .groupBy(aiUsageEvents.feature)
      .orderBy(desc(sql`coalesce(sum(${aiUsageEvents.totalTokens}), 0)`));

    const byOrg = await db
      .select({
        orgId: aiUsageEvents.orgId,
        orgName: organizations.name,
        calls: sql<number>`count(*)`,
        promptTokens: sql<number>`coalesce(sum(${aiUsageEvents.promptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${aiUsageEvents.completionTokens}), 0)`,
        totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)`,
        errors: sql<number>`count(*) filter (where ${aiUsageEvents.status} = 'error')`,
      })
      .from(aiUsageEvents)
      .leftJoin(organizations, eq(organizations.id, aiUsageEvents.orgId))
      .where(where)
      .groupBy(aiUsageEvents.orgId, organizations.name)
      .orderBy(desc(sql`coalesce(sum(${aiUsageEvents.totalTokens}), 0)`));

    const byModel = await db
      .select({
        provider: aiUsageEvents.provider,
        model: aiUsageEvents.model,
        calls: sql<number>`count(*)`,
        promptTokens: sql<number>`coalesce(sum(${aiUsageEvents.promptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${aiUsageEvents.completionTokens}), 0)`,
        totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)`,
      })
      .from(aiUsageEvents)
      .where(where)
      .groupBy(aiUsageEvents.provider, aiUsageEvents.model)
      .orderBy(desc(sql`coalesce(sum(${aiUsageEvents.totalTokens}), 0)`));

    const daily = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${aiUsageEvents.createdAt}), 'YYYY-MM-DD')`,
        calls: sql<number>`count(*)`,
        promptTokens: sql<number>`coalesce(sum(${aiUsageEvents.promptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${aiUsageEvents.completionTokens}), 0)`,
        totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)`,
      })
      .from(aiUsageEvents)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    return {
      totals: {
        calls: n(totals?.calls),
        promptTokens: n(totals?.promptTokens),
        completionTokens: n(totals?.completionTokens),
        totalTokens: n(totals?.totalTokens),
        errors: n(totals?.errors),
        avgDurationMs: Math.round(n(totals?.avgDurationMs)),
        orgs: n(totals?.orgs),
      },
      byFeature: byFeature.map((r) => ({
        feature: r.feature,
        calls: n(r.calls),
        promptTokens: n(r.promptTokens),
        completionTokens: n(r.completionTokens),
        totalTokens: n(r.totalTokens),
        errors: n(r.errors),
      })),
      byOrg: byOrg.map((r) => ({
        orgId: r.orgId,
        orgName: r.orgName ?? "Unattributed",
        calls: n(r.calls),
        promptTokens: n(r.promptTokens),
        completionTokens: n(r.completionTokens),
        totalTokens: n(r.totalTokens),
        errors: n(r.errors),
      })),
      byModel: byModel.map((r) => ({
        provider: r.provider,
        model: r.model,
        calls: n(r.calls),
        promptTokens: n(r.promptTokens),
        completionTokens: n(r.completionTokens),
        totalTokens: n(r.totalTokens),
      })),
      daily: daily.map((r) => ({
        day: r.day,
        calls: n(r.calls),
        promptTokens: n(r.promptTokens),
        completionTokens: n(r.completionTokens),
        totalTokens: n(r.totalTokens),
      })),
    };
  });

const EventsInput = RangeInput.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type AiUsageEventRow = {
  id: string;
  createdAt: string;
  orgId: string | null;
  orgName: string | null;
  feature: string;
  provider: string;
  model: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  attempt: number;
  durationMs: number | null;
  grounded: boolean | null;
  errorMessage: string | null;
};

const eventSelection = {
  id: aiUsageEvents.id,
  createdAt: aiUsageEvents.createdAt,
  orgId: aiUsageEvents.orgId,
  orgName: organizations.name,
  feature: aiUsageEvents.feature,
  provider: aiUsageEvents.provider,
  model: aiUsageEvents.model,
  status: aiUsageEvents.status,
  promptTokens: aiUsageEvents.promptTokens,
  completionTokens: aiUsageEvents.completionTokens,
  totalTokens: aiUsageEvents.totalTokens,
  attempt: aiUsageEvents.attempt,
  durationMs: aiUsageEvents.durationMs,
  grounded: aiUsageEvents.grounded,
  errorMessage: aiUsageEvents.errorMessage,
};

/** Filterable event log for the platform console (newest first). */
export const aiUsageEventsList = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((data: unknown) => EventsInput.parse(data ?? {}))
  .handler(async ({ data }): Promise<{ rows: AiUsageEventRow[]; total: number }> => {
    const where = rangeWhere(data);
    const rows = await db
      .select(eventSelection)
      .from(aiUsageEvents)
      .leftJoin(organizations, eq(organizations.id, aiUsageEvents.orgId))
      .where(where)
      .orderBy(desc(aiUsageEvents.createdAt))
      .limit(data.limit)
      .offset(data.offset);
    const [counted] = await db
      .select({ total: sql<number>`count(*)` })
      .from(aiUsageEvents)
      .where(where);
    return {
      rows: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      total: n(counted?.total),
    };
  });

/** Bulk dump for the CSV download (flat, newest first, hard-capped). */
export const aiUsageExport = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((data: unknown) => RangeInput.parse(data ?? {}))
  .handler(async ({ data }): Promise<{ rows: AiUsageEventRow[] }> => {
    const where = rangeWhere(data);
    const rows = await db
      .select(eventSelection)
      .from(aiUsageEvents)
      .leftJoin(organizations, eq(organizations.id, aiUsageEvents.orgId))
      .where(where)
      .orderBy(desc(aiUsageEvents.createdAt))
      .limit(5000);
    return { rows: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
  });
