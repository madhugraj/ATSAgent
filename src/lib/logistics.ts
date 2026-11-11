/**
 * Practical hiring logistics: compensation band, notice period, location and
 * work authorisation. These deliberately never touch the match score — a great
 * engineer is not "worse" for having a 90-day notice. They surface as risk
 * flags, blockers and an offer-drop risk band the recruiter can filter on.
 */

import { checkAgainstBand, REFUSAL_WORDS } from "./pay-convert";
import type { ExchangeRate, Money, PayTerms, PayZone } from "./pay-terms";

export type LogisticsCandidate = {
  /** The date they said they could join (YYYY-MM-DD), from the screening call or TA. */
  earliestJoining?: string | null | undefined;
  /** Expected pay as said, with its currency and basis (docs/pay-terms-plan.md). */
  expectedPay?: Money | null | undefined;
  /** Where they are, resolved to the organisation's pay zones (null: not known). */
  place?: { zone: string | null; region: string | null } | null | undefined;
  noticePeriodDays?: number | null | undefined;
  currentCtc?: number | null | undefined;
  expectedCtc?: number | null | undefined;
  location?: string | null | undefined;
  preferredLocations?: string[] | null | undefined;
  willingToRelocate?: boolean | null | undefined;
  workAuthorization?: string | null | undefined;
};

export type LogisticsRequisition = {
  ctcBandMin?: number | null | undefined;
  ctcBandMax?: number | null | undefined;
  budgetCtc?: number | null | undefined;
  maxNoticePeriodDays?: number | null | undefined;
  locations?: string[] | null | undefined;
  workAuthorizationRequired?: string | null | undefined;
  /** The role's pay terms, zone and the organisation's rates (Phase 3). */
  pay?:
    | {
        terms: PayTerms;
        zone: PayZone | null;
        rates: ExchangeRate[];
        reportingCurrency: string;
        farAbovePct: number;
        now: Date;
      }
    | null
    | undefined;
  /** The date the role is needed by (YYYY-MM-DD). */
  neededBy?: string | null | undefined;
  /** Who is pooled for this role: its zone and region and the region's rule. */
  pool?:
    | {
        rule: "same_zone" | "same_region" | "entity_countries" | "global_remote";
        zone: string | null;
        region: string | null;
      }
    | null
    | undefined;
};

export type LogisticsCheck = {
  flags: string[];
  blockers: string[];
  join_risk: "low" | "medium" | "high" | "unknown";
  missing: string[];
  /** Outside the role's pool (zone or region), not relocating — a person decides. */
  outside_pool?: boolean;
};

/** Joining after the role is needed by — holds the candidate for a person (prefix-matched). */
export const JOIN_AFTER_NEEDED_BLOCKER = "Can join only after the role is needed by";
/** Outside the role's pool — holds the candidate for a person (prefix-matched). */
export const OUTSIDE_POOL_BLOCKER = "Outside the role's candidate pool";

/** The blockers that hold a candidate at ai_screened for a person (never the score). */
export function holdingBlockers(blockers: string[]): string[] {
  return blockers.filter(
    (b) =>
      b === CTC_CEILING_BLOCKER ||
      b.startsWith(JOIN_AFTER_NEEDED_BLOCKER) ||
      b.startsWith(OUTSIDE_POOL_BLOCKER),
  );
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The one compensation blocker the match gates on: the candidate's ask is
 * materially above the approved band, so auto-advancing them sets up an offer
 * that needs an exception anyway. Exact-matched on recompute; missing CTC
 * never gates (the blocker only exists when the ask is known).
 */
export const CTC_CEILING_BLOCKER = "Expected CTC is more than 20% above the band ceiling";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

export function logisticsCheck(c: LogisticsCandidate, r: LogisticsRequisition): LogisticsCheck {
  const flags: string[] = [];
  const blockers: string[] = [];
  const missing: string[] = [];
  let risk = 0;

  /* ---- compensation */
  const bandMax = r.ctcBandMax ?? r.budgetCtc ?? null;
  const bandMin = r.ctcBandMin ?? null;
  // Pay with its currency and basis: compared in the role's own terms (Phase 3).
  if (r.pay && c.expectedPay && (bandMax || bandMin)) {
    const b = checkAgainstBand({
      figure: c.expectedPay,
      terms: r.pay.terms,
      zone: r.pay.zone,
      band: { min: bandMin, max: bandMax },
      rates: r.pay.rates,
      reportingCurrency: r.pay.reportingCurrency,
      now: r.pay.now,
      farAbovePct: r.pay.farAbovePct,
    });
    flags.push(...b.flags.filter((f) => !Object.values(REFUSAL_WORDS).includes(f)));
    if (!b.comparable && b.refusal) {
      flags.push(`Expected pay not compared — ${REFUSAL_WORDS[b.refusal].toLowerCase()}`);
      risk += 1;
    } else if (b.position === "far_above") {
      blockers.push(CTC_CEILING_BLOCKER);
      risk += 3;
    } else if (b.position === "above") {
      flags.push("Expected pay is above the approved band — needs an exception");
      risk += 2;
    } else if (b.position === "below" && bandMin && b.inPay && b.inPay.amount < bandMin * 0.7) {
      flags.push("Expected pay well below the band — check for a level or scope mismatch");
      risk += 1;
    }
  } else if (c.expectedCtc == null) missing.push("expected CTC");
  else if (bandMax) {
    if (c.expectedCtc > bandMax * 1.2) {
      blockers.push(CTC_CEILING_BLOCKER);
      risk += 3;
    } else if (c.expectedCtc > bandMax) {
      flags.push("Expected CTC is above the approved band — needs an exception");
      risk += 2;
    } else if (bandMin && c.expectedCtc < bandMin * 0.7) {
      flags.push("Expected CTC well below the band — check for a level or scope mismatch");
      risk += 1;
    }
  }
  if (c.currentCtc && c.expectedCtc && c.currentCtc > 0) {
    const hike = ((c.expectedCtc - c.currentCtc) / c.currentCtc) * 100;
    if (hike > 60) {
      flags.push(`Asking for a ${Math.round(hike)}% hike — high counter-offer and drop risk`);
      risk += 2;
    }
  }

  /* ---- notice period */
  if (c.noticePeriodDays == null) missing.push("notice period");
  else {
    const cap = r.maxNoticePeriodDays ?? null;
    if (cap && c.noticePeriodDays > cap) {
      flags.push(`Notice period ${c.noticePeriodDays} days exceeds the ${cap}-day target`);
      risk += 2;
    } else if (!cap && c.noticePeriodDays > 90) {
      flags.push(`Long notice period (${c.noticePeriodDays} days)`);
      risk += 1;
    }
  }

  /* ---- joining date against the date the role is needed by */
  if (r.neededBy) {
    if (c.earliestJoining) {
      if (c.earliestJoining > r.neededBy) {
        blockers.push(
          `${JOIN_AFTER_NEEDED_BLOCKER} (${r.neededBy}): they can join on ${c.earliestJoining}`,
        );
        risk += 3;
      }
    } else if (c.noticePeriodDays != null) {
      // An estimate from the notice period only flags; it never holds.
      const today = (r.pay?.now ?? new Date()).toISOString().slice(0, 10);
      const estimate = addDays(today, c.noticePeriodDays);
      if (estimate > r.neededBy) {
        flags.push(
          `With ${c.noticePeriodDays} days' notice they could join around ${estimate}, after the role is needed by (${r.neededBy}) — confirm their joining date`,
        );
        risk += 2;
      }
    } else missing.push("joining date");
  }

  /* ---- the role's candidate pool (zone or region) */
  let outsidePool = false;
  if (r.pool && r.pool.rule !== "global_remote" && c.place) {
    const outside =
      r.pool.rule === "same_zone"
        ? Boolean(r.pool.zone && c.place.zone && c.place.zone !== r.pool.zone)
        : r.pool.rule === "same_region"
          ? Boolean(
              r.pool.region && c.place.region !== r.pool.region && c.place.zone !== r.pool.zone,
            )
          : false;
    if (outside && c.willingToRelocate !== true) {
      outsidePool = true;
      blockers.push(
        `${OUTSIDE_POOL_BLOCKER} (${r.pool.rule === "same_zone" ? r.pool.zone : r.pool.region}): they are in ${c.place.zone ?? c.place.region ?? "another place"}`,
      );
      risk += 2;
    } else if (outside) flags.push("Outside the role's pool — open to relocating");
  }

  /* ---- location */
  const reqLocations = (r.locations ?? []).filter(Boolean).map(norm);
  if (reqLocations.length > 0) {
    const candidateLocations = [c.location ?? "", ...(c.preferredLocations ?? [])]
      .filter(Boolean)
      .map(norm);
    const remote = reqLocations.some((l) => l.includes("remote"));
    const overlap = candidateLocations.some((l) =>
      reqLocations.some((rl) => rl.includes(l) || l.includes(rl)),
    );
    if (!remote && !overlap && candidateLocations.length > 0) {
      if (c.willingToRelocate === true) flags.push("Relocation needed — candidate is open to it");
      else if (c.willingToRelocate === false) {
        blockers.push("Location mismatch and candidate will not relocate");
        risk += 3;
      } else {
        flags.push("Location mismatch — relocation willingness not captured");
        risk += 2;
        missing.push("relocation willingness");
      }
    }
  }

  /* ---- work authorisation */
  if (r.workAuthorizationRequired) {
    if (!c.workAuthorization) {
      flags.push(`Work authorisation not captured (role needs ${r.workAuthorizationRequired})`);
      missing.push("work authorisation");
      risk += 1;
    } else if (norm(c.workAuthorization) !== norm(r.workAuthorizationRequired)) {
      blockers.push(
        `Work authorisation "${c.workAuthorization}" does not meet "${r.workAuthorizationRequired}"`,
      );
      risk += 3;
    }
  }

  const join_risk: LogisticsCheck["join_risk"] =
    missing.length >= 3 && risk === 0
      ? "unknown"
      : risk >= 4
        ? "high"
        : risk >= 2
          ? "medium"
          : "low";

  return { flags, blockers, join_risk, missing, ...(outsidePool ? { outside_pool: true } : {}) };
}

/** Does this candidate clear the requisition's hard constraints? */
export function passesLogistics(c: LogisticsCandidate, r: LogisticsRequisition) {
  return logisticsCheck(c, r).blockers.length === 0;
}
