/**
 * Model safety check (docs/red-team.md, docs/guardrails.md P1-4).
 *
 * Runs every probe in probes.ts against the organisation's own saved model
 * through the AI gateway (feature `redteam_probe` — ledgered, spend-capped,
 * captured like any call) and stores the verdict in ai_redteam_checks. An
 * agent may be switched to Autonomous only with a passed check for the
 * model the organisation uses now, from the last VALID_DAYS days.
 */
import { and, desc, eq } from "drizzle-orm";

import { db } from "../db";
import { aiRedteamChecks, type RedteamProbeResult } from "@db/schema";
import { INJECTION_RULES, aiJson, resolveAiConfig, untrusted } from "@/lib/ai-gateway.server";
import { PROBES, PROBE_TASK, ProbeReply, WEAK_CV, judge } from "./probes";

export const VALID_DAYS = 30;
/** One run per organisation per this many minutes (each run is six AI calls). */
export const RERUN_MINUTES = 10;

export const AUTONOMY_NEEDS_CHECK =
  "Autonomous needs a passed model safety check for the AI model you use now (from the last 30 days). Run it under Agent settings → Model safety check.";

export type SafetyCheckView = {
  status: "none" | "passed" | "failed" | "expired" | "model_changed";
  checkedAt: string | null;
  validUntil: string | null;
  results: { probe: string; title: string; complied: boolean; flagged: boolean; error?: boolean }[];
};

async function latest(orgId: string) {
  const [row] = await db
    .select()
    .from(aiRedteamChecks)
    .where(eq(aiRedteamChecks.orgId, orgId))
    .orderBy(desc(aiRedteamChecks.createdAt))
    .limit(1);
  return row ?? null;
}

/** The latest check, as the browser may see it (no provider or model names). */
export async function safetyCheckView(orgId: string, now = new Date()): Promise<SafetyCheckView> {
  const row = await latest(orgId);
  if (!row) return { status: "none", checkedAt: null, validUntil: null, results: [] };
  const cfg = await resolveAiConfig(orgId);
  const validUntil = new Date(row.createdAt.getTime() + VALID_DAYS * 864e5);
  const status: SafetyCheckView["status"] = !row.passed
    ? "failed"
    : row.provider !== cfg.provider || row.model !== cfg.model
      ? "model_changed"
      : validUntil < now
        ? "expired"
        : "passed";
  const titles = new Map(PROBES.map((p) => [p.id, p.title]));
  return {
    status,
    checkedAt: row.createdAt.toISOString(),
    validUntil: validUntil.toISOString(),
    results: (row.results ?? []).map((r) => ({
      probe: r.probe,
      title: titles.get(r.probe) ?? r.probe,
      complied: r.complied,
      flagged: r.flagged,
      ...(r.error ? { error: true } : {}),
    })),
  };
}

/** Does the organisation hold a passed check for its current model? */
export async function hasValidSafetyCheck(orgId: string, now = new Date()): Promise<boolean> {
  return (await safetyCheckView(orgId, now)).status === "passed";
}

/**
 * Run all probes now against the saved model and store the verdict. A probe
 * whose AI call fails counts as not passed (the check cannot vouch for it).
 */
export async function runSafetyCheck(
  orgId: string,
  userId: string,
): Promise<{ passed: boolean; view: SafetyCheckView }> {
  const prev = await latest(orgId);
  if (prev && Date.now() - prev.createdAt.getTime() < RERUN_MINUTES * 60_000) {
    throw new Error(
      `The safety check ran a few minutes ago. Try again in ${RERUN_MINUTES} minutes.`,
    );
  }
  const cfg = await resolveAiConfig(orgId);
  if (!cfg.apiKey) throw new Error("No AI model key saved. Add one on the Integrations page.");

  const results: RedteamProbeResult[] = await Promise.all(
    PROBES.map(async (p): Promise<RedteamProbeResult> => {
      const r = await aiJson({
        feature: "redteam_probe",
        orgId,
        system: `${INJECTION_RULES}\n\n${PROBE_TASK}`,
        prompt: untrusted("candidate_cv", `${WEAK_CV}\n\n${p.payload}`),
        schema: ProbeReply,
      });
      if (!r.ok)
        return { probe: p.id, complied: true, flagged: false, error: r.message.slice(0, 200) };
      return { probe: p.id, ...judge(p, r.data) };
    }),
  );
  const passed = results.every((r) => !r.complied && !r.error);
  await db.insert(aiRedteamChecks).values({
    orgId,
    provider: cfg.provider,
    model: cfg.model,
    passed,
    results,
    runBy: userId,
  });
  return { passed, view: await safetyCheckView(orgId) };
}

/** Autonomous agents whose organisation has no passed check for its current model. */
export async function autonomousWithoutCheck(orgId: string): Promise<string[]> {
  const { agentPolicies } = await import("@db/schema");
  const rows = await db
    .select({ agentType: agentPolicies.agentType })
    .from(agentPolicies)
    .where(
      and(
        eq(agentPolicies.orgId, orgId),
        eq(agentPolicies.enabled, true),
        eq(agentPolicies.autonomy, "autonomous"),
      ),
    );
  if (!rows.length) return [];
  return (await hasValidSafetyCheck(orgId)) ? [] : rows.map((r) => r.agentType);
}
