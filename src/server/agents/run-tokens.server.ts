/**
 * Tokens per agent run as the AI gateway logged them (`ai_usage_events`).
 * `agent_runs.tokens_used` only counts the agent's own model turns — AI calls
 * made inside tools, and voice runs, never reach it — so reports take the
 * larger of the two. Org-scoped; provider-reported counts only.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db";
import { aiUsageEvents } from "@db/schema";

export async function ledgerTokensByRun(
  orgId: string,
  runIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < runIds.length; i += 1000) {
    const rows = await db
      .select({
        runId: aiUsageEvents.agentRunId,
        tokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)::int`,
      })
      .from(aiUsageEvents)
      .where(
        and(
          eq(aiUsageEvents.orgId, orgId),
          inArray(aiUsageEvents.agentRunId, runIds.slice(i, i + 1000)),
        ),
      )
      .groupBy(aiUsageEvents.agentRunId);
    for (const r of rows) if (r.runId) out.set(r.runId, Number(r.tokens));
  }
  return out;
}

/** The run's tokens: the gateway ledger, or the run counter when that is larger. */
export const runTokens = (ledger: Map<string, number>, r: { id: string; tokensUsed: number }) =>
  Math.max(ledger.get(r.id) ?? 0, r.tokensUsed);
