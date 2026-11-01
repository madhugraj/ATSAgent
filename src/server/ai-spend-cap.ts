/**
 * Denial-of-wallet guards (docs/guardrails.md, P1-2; migration 0064).
 *
 * - Monthly token cap: once an organisation's AI tokens this calendar month
 *   (UTC, from the ai_usage_events ledger — what providers reported) reach
 *   `ai_settings.monthly_token_cap`, the gateway refuses new AI requests with
 *   a vendor-neutral message. Covers every feature (scoring, agents, research,
 *   voice), not only agents' own budgets.
 * - Daily scorings per requisition: automatic CV scoring stops for a
 *   requisition after `daily_scores_per_requisition` scorings today (UTC); the
 *   rest wait for the next day (src/lib/autoscore.server.ts).
 *
 * Reads are cached briefly per organisation so a burst of calls costs one
 * query, not one per call; the cap can overshoot by at most the calls in
 * flight during that window.
 */
import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "./db";
import { aiSettings, aiUsageEvents } from "@db/schema";

const CACHE_MS = 30_000;

export const SPEND_CAP_MESSAGE =
  "This organisation's monthly AI limit has been reached. The HR head can raise it in Integrations → AI model settings.";

/** Start of the current calendar month, UTC. */
export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Start of the current day, UTC. */
export function dayStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Pure: is a further request refused? */
export function overCap(used: number, cap: number | null | undefined): boolean {
  return typeof cap === "number" && cap > 0 && used >= cap;
}

export type SpendCaps = {
  monthlyTokenCap: number | null;
  dailyScoresPerRequisition: number | null;
};

export async function loadCaps(orgId: string): Promise<SpendCaps> {
  const [row] = await db
    .select({
      monthlyTokenCap: aiSettings.monthlyTokenCap,
      dailyScoresPerRequisition: aiSettings.dailyScoresPerRequisition,
    })
    .from(aiSettings)
    .where(eq(aiSettings.orgId, orgId))
    .limit(1);
  return {
    monthlyTokenCap: row?.monthlyTokenCap ?? null,
    dailyScoresPerRequisition: row?.dailyScoresPerRequisition ?? null,
  };
}

/** Tokens the organisation used this calendar month (UTC), from the ledger. */
export async function monthTokensUsed(orgId: string, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)::bigint` })
    .from(aiUsageEvents)
    .where(and(eq(aiUsageEvents.orgId, orgId), gte(aiUsageEvents.createdAt, monthStartUtc(now))));
  return Number(row?.n ?? 0);
}

const cache = new Map<string, { at: number; cap: number | null; used: number }>();

/** Forget cached figures (tests; and after the cap is changed). */
export function clearSpendCapCache(orgId?: string): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

/**
 * The refusal message when the organisation is over its monthly cap, else
 * null. Never throws: a failed check must not stop the work it guards.
 */
export async function spendCapRefusal(orgId: string | null | undefined): Promise<string | null> {
  if (!orgId) return null;
  try {
    const now = Date.now();
    let hit = cache.get(orgId);
    if (!hit || now - hit.at > CACHE_MS) {
      const { monthlyTokenCap } = await loadCaps(orgId);
      const used = monthlyTokenCap ? await monthTokensUsed(orgId) : 0;
      hit = { at: now, cap: monthlyTokenCap, used };
      cache.set(orgId, hit);
    }
    return overCap(hit.used, hit.cap) ? SPEND_CAP_MESSAGE : null;
  } catch (e) {
    console.error("[ai-spend-cap] check failed", e);
    return null;
  }
}

/** Automatic CV scorings already made for a requisition today (UTC), from the ledger. */
export async function scoresToday(orgId: string, requisitionId: string): Promise<number> {
  const [row] = await db
    // Distinct applications: a schema retry is a second ledger row for one scoring.
    .select({ n: sql<number>`count(distinct ${aiUsageEvents.applicationId})::int` })
    .from(aiUsageEvents)
    .where(
      and(
        eq(aiUsageEvents.orgId, orgId),
        eq(aiUsageEvents.requisitionId, requisitionId),
        eq(aiUsageEvents.feature, "candidate_score"),
        gte(aiUsageEvents.createdAt, dayStartUtc()),
      ),
    );
  return Number(row?.n ?? 0);
}
