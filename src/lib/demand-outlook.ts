/**
 * Demand outlook: which roles the organisation is likely to need more of in
 * the next two quarters. Two signals, kept apart so the evidence is visible:
 *
 * - internal: requisitions per ontology role per quarter over the last eight
 *   quarters — the last two quarters against the two before;
 * - market: an outlook (rising / steady / falling) from live market research,
 *   labelled as such and never mixed into the internal counts.
 *
 * Emerging roles in the ontology add weight. Thin history (under four
 * quarters of requisitions) lowers confidence and is said plainly.
 */
import type { CoverageStatus } from "./pool-coverage";

export const OUTLOOK_QUARTERS = 8;
export const MIN_HISTORY_QUARTERS = 4;

export type ClassifiedRequisition = { role: string; createdAt: Date; openings: number };
export type MarketOutlook = "rising" | "steady" | "falling";
export type MarketSignal = { role: string; outlook: MarketOutlook; reason: string };

export type RoleTrend = {
  role: string;
  /** Openings per quarter, oldest first (index OUTLOOK_QUARTERS-1 is the current quarter). */
  quarters: number[];
  recent: number;
  prior: number;
  /** (recent − prior) / max(prior, 1). */
  growth: number;
};

export type OutlookConfidence = "high" | "medium" | "low";

export type OutlookRow = {
  role: string;
  score: number;
  internal: RoleTrend | null;
  market: MarketSignal | null;
  emerging: "signal" | "emerging" | "established" | null;
  coverage: CoverageStatus | null;
  confidence: OutlookConfidence;
  evidence: string[];
};

export type DemandOutlook = {
  generatedAt: string;
  historyQuarters: number;
  thinHistory: boolean;
  /** False when the market signal came from the model without live web access. */
  marketGrounded: boolean;
  marketAvailable: boolean;
  rows: OutlookRow[];
};

/** Whole quarters between `d` and `now` (0 = the last three months). */
export function quartersAgo(d: Date, now: Date): number {
  const months =
    (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
  return Math.floor(Math.max(months, 0) / 3);
}

export function roleTrends(reqs: ClassifiedRequisition[], now = new Date()): RoleTrend[] {
  const by = new Map<string, number[]>();
  for (const r of reqs) {
    const q = quartersAgo(r.createdAt, now);
    if (q >= OUTLOOK_QUARTERS) continue;
    const arr = by.get(r.role) ?? new Array<number>(OUTLOOK_QUARTERS).fill(0);
    const i = OUTLOOK_QUARTERS - 1 - q;
    arr[i] = (arr[i] ?? 0) + Math.max(r.openings, 1);
    by.set(r.role, arr);
  }
  return [...by.entries()].map(([role, quarters]) => {
    const n = OUTLOOK_QUARTERS;
    const at = (i: number) => quarters[i] ?? 0;
    const recent = at(n - 1) + at(n - 2);
    const prior = at(n - 3) + at(n - 4);
    return {
      role,
      quarters,
      recent,
      prior,
      growth: Math.round(((recent - prior) / Math.max(prior, 1)) * 100) / 100,
    };
  });
}

/** Quarters of requisition history the organisation has (capped at OUTLOOK_QUARTERS). */
export function historyQuarters(reqs: { createdAt: Date }[], now = new Date()): number {
  if (!reqs.length) return 0;
  const oldest = Math.max(...reqs.map((r) => quartersAgo(r.createdAt, now)));
  return Math.min(oldest + 1, OUTLOOK_QUARTERS);
}

const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const MARKET_WEIGHT: Record<MarketOutlook, number> = { rising: 1, steady: 0, falling: -1 };
const EMERGING_WEIGHT = { signal: 0.25, emerging: 0.5, established: 0 } as const;

export function rankOutlook(input: {
  trends: RoleTrend[];
  market: MarketSignal[];
  emerging: { name: string; status: "signal" | "emerging" | "established" }[];
  coverage: { label: string; status: CoverageStatus }[];
  historyQuarters: number;
  marketGrounded: boolean;
  limit?: number;
}): OutlookRow[] {
  const thin = input.historyQuarters < MIN_HISTORY_QUARTERS;
  const roles = new Map<string, string>();
  for (const t of input.trends) roles.set(key(t.role), t.role);
  for (const m of input.market) if (!roles.has(key(m.role))) roles.set(key(m.role), m.role);
  for (const e of input.emerging) if (!roles.has(key(e.name))) roles.set(key(e.name), e.name);

  const rows = [...roles.entries()].map(([k, role]): OutlookRow => {
    const internal = input.trends.find((t) => key(t.role) === k) ?? null;
    const market = input.market.find((m) => key(m.role) === k) ?? null;
    const em = input.emerging.find((e) => key(e.name) === k) ?? null;
    const cov = input.coverage.find((c) => key(c.label) === k) ?? null;

    // Internal growth counts less when history is thin; capped so one busy
    // quarter cannot outweigh everything else.
    const internalScore = internal
      ? Math.max(-1, Math.min(internal.growth, 2)) * (thin ? 0.5 : 1) +
        (internal.recent > 0 ? 0.25 : 0)
      : 0;
    const marketScore = market
      ? MARKET_WEIGHT[market.outlook] * (input.marketGrounded ? 1 : 0.5)
      : 0;
    const emergingScore = em ? EMERGING_WEIGHT[em.status] : 0;
    const score = Math.round((internalScore + marketScore + emergingScore) * 100) / 100;

    const signals = [
      internal && !thin ? Math.sign(internal.growth) : null,
      market && input.marketGrounded ? MARKET_WEIGHT[market.outlook] : null,
    ].filter((v): v is number => v !== null);
    const agree = signals.length === 2 && signals[0] === signals[1];
    const confidence: OutlookConfidence = agree ? "high" : signals.length >= 1 ? "medium" : "low";

    const evidence: string[] = [];
    if (internal) {
      evidence.push(
        `${internal.recent} opening(s) in the last two quarters against ${internal.prior} in the two before`,
      );
    }
    if (market) {
      evidence.push(
        `Market ${market.outlook}${input.marketGrounded ? "" : " (estimate without live sources)"}: ${market.reason}`,
      );
    }
    if (em && em.status !== "established") evidence.push(`An ${em.status} role in your ontology`);
    if (cov) evidence.push(`Pool coverage is ${cov.status}`);
    return {
      role,
      score,
      internal,
      market,
      emerging: em?.status ?? null,
      coverage: cov?.status ?? null,
      confidence,
      evidence,
    };
  });

  return rows
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.role.localeCompare(b.role))
    .slice(0, input.limit ?? 10);
}
