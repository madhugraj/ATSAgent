/**
 * Practical hiring logistics: compensation band, notice period, location and
 * work authorisation. These deliberately never touch the match score — a great
 * engineer is not "worse" for having a 90-day notice. They surface as risk
 * flags, blockers and an offer-drop risk band the recruiter can filter on.
 */

export type LogisticsCandidate = {
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
};

export type LogisticsCheck = {
  flags: string[];
  blockers: string[];
  join_risk: "low" | "medium" | "high" | "unknown";
  missing: string[];
};

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
  if (c.expectedCtc == null) missing.push("expected CTC");
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

  return { flags, blockers, join_risk, missing };
}

/** Does this candidate clear the requisition's hard constraints? */
export function passesLogistics(c: LogisticsCandidate, r: LogisticsRequisition) {
  return logisticsCheck(c, r).blockers.length === 0;
}
