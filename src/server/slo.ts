/**
 * Service level objectives — the one place SLIs, targets and burn-rate alert
 * thresholds are defined. Read by the request recorder (latency threshold),
 * the platform "Service health" page, the burn-rate alerter
 * (src/server/slo.server.ts) and the Cloud Monitoring policies in
 * infra/monitoring/ (keep those numbers in step with this file).
 *
 * Pure: no database, no Node APIs — unit-tested in scripts/observability.test.ts.
 */

export type SloId = "server_fn_availability" | "server_fn_latency" | "agent_run_success";

export type Slo = {
  id: SloId;
  name: string;
  /** What counts as good, in plain words. */
  sli: string;
  /** Fraction of good events, e.g. 0.99. */
  target: number;
  /** Rolling compliance window. */
  windowDays: number;
};

/** A server-function request slower than this is a "slow" event for the latency SLO. */
export const LATENCY_THRESHOLD_MS = 2_500;

export const SLOS: readonly Slo[] = [
  {
    id: "server_fn_availability",
    name: "Server-function availability",
    sli: "Server-function (/_serverFn) requests answered without a 5xx status.",
    target: 0.99,
    windowDays: 30,
  },
  {
    id: "server_fn_latency",
    name: "Server-function latency",
    sli: `Server-function requests answered within ${LATENCY_THRESHOLD_MS / 1000} s (p95 ≤ ${LATENCY_THRESHOLD_MS / 1000} s).`,
    target: 0.95,
    windowDays: 30,
  },
  {
    id: "agent_run_success",
    name: "Agent run success",
    sli: "Finished live agent runs that end done or cancelled rather than failed.",
    target: 0.95,
    windowDays: 30,
  },
] as const;

/**
 * Multi-window, multi-burn-rate alerts (Google SRE workbook, ch. 5): alert
 * when both the long and the short window burn faster than `burnRate`. A
 * burn rate of 1 spends the whole budget in exactly one SLO window; 14.4 over
 * 1 h spends 2 % of a 30-day budget in that hour.
 */
export const BURN_ALERTS = [
  { severity: "critical", longMinutes: 60, shortMinutes: 5, burnRate: 14.4 },
  { severity: "serious", longMinutes: 360, shortMinutes: 30, burnRate: 6 },
] as const;

export type BurnSeverity = (typeof BURN_ALERTS)[number]["severity"];

/** Fewer events than this in a window are too few to judge (no alert, "—" on the panel). */
export const MIN_EVENTS_FOR_BURN = 20;

export type Counts = { total: number; bad: number };

/** Good-event ratio, or null when there were no events. */
export function sliRatio(c: Counts): number | null {
  return c.total > 0 ? (c.total - c.bad) / c.total : null;
}

/** How fast the error budget is being spent: observed error rate / allowed error rate. */
export function burnRate(c: Counts, target: number): number | null {
  if (c.total <= 0) return null;
  const allowed = 1 - target;
  if (allowed <= 0) return c.bad > 0 ? Number.POSITIVE_INFINITY : 0;
  return c.bad / c.total / allowed;
}

/** Share of the window's error budget still unspent (can go negative). */
export function budgetRemaining(c: Counts, target: number): number | null {
  if (c.total <= 0) return null;
  const allowedBad = (1 - target) * c.total;
  if (allowedBad <= 0) return c.bad > 0 ? -1 : 1;
  return 1 - c.bad / allowedBad;
}

/**
 * The most severe burn alert that fires for these window counts, or null.
 * `counts(minutes)` returns the good/bad counts over the last `minutes`.
 */
export function firingBurnAlert(
  target: number,
  counts: (minutes: number) => Counts,
): { severity: BurnSeverity; longBurn: number; shortBurn: number; windowMinutes: number } | null {
  for (const a of BURN_ALERTS) {
    const long = counts(a.longMinutes);
    const short = counts(a.shortMinutes);
    if (long.total < MIN_EVENTS_FOR_BURN) continue;
    const lb = burnRate(long, target) ?? 0;
    const sb = burnRate(short, target) ?? 0;
    if (lb >= a.burnRate && sb >= a.burnRate)
      return { severity: a.severity, longBurn: lb, shortBurn: sb, windowMinutes: a.longMinutes };
  }
  return null;
}
