/**
 * Org-scoped salary benchmark runs: cache-first research trigger plus the
 * latest-benchmark lookup used by the requisition surfaces. Every query and
 * write is predicated on the caller's organisation (`requireOrg`).
 */
import { and, desc, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { organizations, salaryBenchmarks } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { resolveAiConfig } from "./ai-gateway.server";
import { benchmarkInputKey, researchSalaryBenchmark } from "./salary-benchmark.server";
import type { BenchmarkPayload } from "./career-ladder";

/** A cached benchmark is offered as-is for 30 days before research re-runs. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type BenchRow = typeof salaryBenchmarks.$inferSelect;

/** PostgREST-style snake_case wire row, matching the shapes routes read.
 *  provider/model stay server-internal (persisted on the row, logged in ai_usage_events). */
function toWire(row: BenchRow) {
  return {
    id: row.id,
    requisition_id: row.requisitionId,
    input_key: row.inputKey,
    title: row.title,
    location: row.location,
    experience_min: row.experienceMin,
    experience_max: row.experienceMax,
    currency: row.currency,
    grounded: row.grounded,
    confidence: row.confidence,
    payload: row.payload as BenchmarkPayload,
    created_at: new Date(row.createdAt).toISOString(),
  };
}

export type BenchmarkRow = ReturnType<typeof toWire>;

const BenchmarkInputs = z.object({
  title: z.string().min(1),
  location: z.string().nullish(),
  experienceMin: z.coerce.number().int().min(0),
  experienceMax: z.coerce.number().int().min(0),
  requisitionId: z.string().uuid().nullish(),
  /** Skip the 30-day cache and pay for a fresh research run. */
  refresh: z.boolean().optional(),
});

/**
 * Run (or reuse) a market benchmark for a role. Fresh inputs return a cached
 * row younger than 30 days unless `refresh`; otherwise the AI market agent
 * researches live salary pages and the result is persisted.
 */
export const runSalaryBenchmark = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => BenchmarkInputs.parse(data))
  .handler(async ({ data, context }) => {
    const input = {
      title: data.title,
      location: data.location ?? "",
      experienceMin: data.experienceMin,
      experienceMax: data.experienceMax,
    };
    const inputKey = benchmarkInputKey(input);

    if (!data.refresh) {
      const [cached] = await db
        .select()
        .from(salaryBenchmarks)
        .where(
          and(eq(salaryBenchmarks.orgId, context.orgId), eq(salaryBenchmarks.inputKey, inputKey)),
        )
        .orderBy(desc(salaryBenchmarks.createdAt))
        .limit(1);
      if (cached && Date.now() - new Date(cached.createdAt).getTime() < CACHE_TTL_MS) {
        return toWire(cached);
      }
    }

    const [org] = await db
      .select({ currency: organizations.currency })
      .from(organizations)
      .where(eq(organizations.id, context.orgId))
      .limit(1);

    const result = await researchSalaryBenchmark(
      { ...input, currency: org?.currency ?? "INR" },
      undefined,
      context.orgId,
    );

    const [row] = await db
      .insert(salaryBenchmarks)
      .values({
        orgId: context.orgId,
        requisitionId: data.requisitionId ?? null,
        inputKey,
        title: data.title,
        location: data.location?.trim() || null,
        experienceMin: data.experienceMin,
        experienceMax: data.experienceMax,
        currency: result.payload.currency,
        grounded: result.payload.grounded,
        confidence: result.confidence,
        payload: result.payload,
        provider: result.provider,
        model: result.model,
      })
      .returning();
    if (!row) throw new Error("Could not save the benchmark run");
    return toWire(row);
  });

const LookupInputs = z.object({
  title: z.string().min(1),
  location: z.string().nullish(),
  experienceMin: z.coerce.number().int().min(0),
  experienceMax: z.coerce.number().int().min(0),
});

/** Latest run for these role inputs, plus whether it is past its 30-day window. */
export const getLatestBenchmark = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => LookupInputs.parse(data))
  .handler(async ({ data, context }) => {
    const inputKey = benchmarkInputKey({
      title: data.title,
      location: data.location ?? "",
      experienceMin: data.experienceMin,
      experienceMax: data.experienceMax,
    });
    const [latest] = await db
      .select()
      .from(salaryBenchmarks)
      .where(
        and(eq(salaryBenchmarks.orgId, context.orgId), eq(salaryBenchmarks.inputKey, inputKey)),
      )
      .orderBy(desc(salaryBenchmarks.createdAt))
      .limit(1);
    if (!latest) return null;
    return {
      benchmark: toWire(latest),
      stale: Date.now() - new Date(latest.createdAt).getTime() >= CACHE_TTL_MS,
    };
  });
