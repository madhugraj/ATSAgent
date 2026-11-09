import { and, asc, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
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
  status: z.enum(["ok", "error"]).optional().nullable(),
  model: z.string().max(120).optional().nullable(),
  search: z.string().trim().max(120).optional().nullable(),
  retriesOnly: z.boolean().optional().nullable(),
  minLatencyMs: z.coerce.number().int().min(0).max(600_000).optional().nullable(),
  sort: z.enum(["newest", "oldest", "tokens", "latency"]).default("newest"),
});

type EventsFilter = z.infer<typeof EventsInput>;

/** Range filters plus the request-log-only narrowing (status, model, search…). */
function eventsWhere(d: EventsFilter) {
  const conds = [rangeWhere(d)];
  if (d.status) conds.push(eq(aiUsageEvents.status, d.status));
  if (d.model) conds.push(eq(aiUsageEvents.model, d.model));
  if (d.retriesOnly) conds.push(sql`${aiUsageEvents.attempt} > 1`);
  if (d.minLatencyMs) conds.push(gte(aiUsageEvents.durationMs, d.minLatencyMs));
  if (d.search) {
    const q = `%${d.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(
      or(
        ilike(organizations.name, q),
        ilike(aiUsageEvents.feature, q),
        ilike(aiUsageEvents.model, q),
        ilike(aiUsageEvents.errorMessage, q),
      ),
    );
  }
  const defined = conds.filter((c) => c !== undefined);
  return defined.length ? and(...defined) : undefined;
}

const SORTS = {
  newest: [desc(aiUsageEvents.createdAt)],
  oldest: [asc(aiUsageEvents.createdAt)],
  tokens: [desc(aiUsageEvents.totalTokens), desc(aiUsageEvents.createdAt)],
  latency: [sql`${aiUsageEvents.durationMs} desc nulls last`, desc(aiUsageEvents.createdAt)],
} as const;

/** Latency histogram buckets (upper bound in ms; last is open-ended). */
const LATENCY_BUCKETS = [
  { label: "<1s", max: 1000 },
  { label: "1–3s", max: 3000 },
  { label: "3–10s", max: 10_000 },
  { label: "10–30s", max: 30_000 },
  { label: "30–60s", max: 60_000 },
  { label: "60s+", max: null },
] as const;

export type AiUsageEventStats = {
  calls: number;
  errors: number;
  retries: number;
  grounded: number;
  avgTokens: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  latency: { bucket: string; calls: number }[];
  timeline: { at: string; ok: number; errors: number }[];
  bucket: "hour" | "day";
};

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
  .handler(
    async ({
      data,
    }): Promise<{ rows: AiUsageEventRow[]; total: number; stats: AiUsageEventStats }> => {
      const where = eventsWhere(data);
      const rows = await db
        .select(eventSelection)
        .from(aiUsageEvents)
        .leftJoin(organizations, eq(organizations.id, aiUsageEvents.orgId))
        .where(where)
        .orderBy(...SORTS[data.sort])
        .limit(data.limit)
        .offset(data.offset);

      const latencyCase = sql.raw(
        `case ${LATENCY_BUCKETS.filter((b) => b.max != null)
          .map((b, i) => `when "ai_usage_events"."duration_ms" < ${b.max} then ${i}`)
          .join(" ")} else ${LATENCY_BUCKETS.length - 1} end`,
      );

      // Short windows read better per hour; longer ones per day.
      const spanDays = data.from
        ? (Date.now() - new Date(`${data.from}T00:00:00Z`).getTime()) / 86_400_000
        : Infinity;
      const bucket: "hour" | "day" = spanDays <= 3 ? "hour" : "day";
      const truncFmt = bucket === "hour" ? 'YYYY-MM-DD"T"HH24:00' : "YYYY-MM-DD";

      const [[agg], latency, timeline] = await Promise.all([
        db
          .select({
            calls: sql<number>`count(*)`,
            errors: sql<number>`count(*) filter (where ${aiUsageEvents.status} = 'error')`,
            retries: sql<number>`count(*) filter (where ${aiUsageEvents.attempt} > 1)`,
            grounded: sql<number>`count(*) filter (where ${aiUsageEvents.grounded})`,
            avgTokens: sql<number>`coalesce(avg(${aiUsageEvents.totalTokens}), 0)`,
            p50: sql<
              number | null
            >`percentile_cont(0.5) within group (order by ${aiUsageEvents.durationMs})`,
            p95: sql<
              number | null
            >`percentile_cont(0.95) within group (order by ${aiUsageEvents.durationMs})`,
            maxMs: sql<number | null>`max(${aiUsageEvents.durationMs})`,
          })
          .from(aiUsageEvents)
          .leftJoin(organizations, eq(organizations.id, aiUsageEvents.orgId))
          .where(where),
        db
          .select({ b: sql<number>`${latencyCase}`, calls: sql<number>`count(*)` })
          .from(aiUsageEvents)
          .leftJoin(organizations, eq(organizations.id, aiUsageEvents.orgId))
          .where(and(where, sql`${aiUsageEvents.durationMs} is not null`))
          .groupBy(sql`1`),
        db
          .select({
            at: sql<string>`to_char(date_trunc(${bucket}, ${aiUsageEvents.createdAt}), ${truncFmt})`,
            ok: sql<number>`count(*) filter (where ${aiUsageEvents.status} <> 'error')`,
            errors: sql<number>`count(*) filter (where ${aiUsageEvents.status} = 'error')`,
          })
          .from(aiUsageEvents)
          .leftJoin(organizations, eq(organizations.id, aiUsageEvents.orgId))
          .where(where)
          .groupBy(sql`1`)
          .orderBy(sql`1`),
      ]);

      const byBucket = new Map(latency.map((l) => [n(l.b), n(l.calls)]));
      const ms = (v: unknown) => (v == null ? null : Math.round(Number(v)));
      return {
        rows: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        total: n(agg?.calls),
        stats: {
          calls: n(agg?.calls),
          errors: n(agg?.errors),
          retries: n(agg?.retries),
          grounded: n(agg?.grounded),
          avgTokens: Math.round(n(agg?.avgTokens)),
          p50Ms: ms(agg?.p50),
          p95Ms: ms(agg?.p95),
          maxMs: ms(agg?.maxMs),
          latency: LATENCY_BUCKETS.map((b, i) => ({
            bucket: b.label,
            calls: byBucket.get(i) ?? 0,
          })),
          timeline: timeline.map((t) => ({ at: t.at, ok: n(t.ok), errors: n(t.errors) })),
          bucket,
        },
      };
    },
  );

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
