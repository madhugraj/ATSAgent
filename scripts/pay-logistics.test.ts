/**
 * Pay terms, Phase 3 — the logistics check with pay terms, the date a role is
 * needed by and the candidate pool; how the screening call asks pay; places
 * resolved to pay zones (docs/pay-terms-plan.md). Pure: no database.
 *
 * Run: bun test scripts/pay-logistics.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  CTC_CEILING_BLOCKER,
  JOIN_AFTER_NEEDED_BLOCKER,
  OUTSIDE_POOL_BLOCKER,
  holdingBlockers,
  logisticsCheck,
  type LogisticsRequisition,
} from "../src/lib/logistics";
import { gatedRecommendation } from "../src/lib/matching.server";
import { placeOf } from "../src/lib/pay-context.server";
import { Money, PayTerms, PayZone, callPayWords } from "../src/lib/pay-terms";
import { callSystemPrompt, type BriefFacts } from "../src/server/voice/call-prompt";
import { STATES_AMOUNT } from "../src/server/voice/call-tools";

const NOW = new Date("2026-11-11T06:00:00Z");
const milan = {
  ...PayZone.parse({
    id: "z1",
    name: "Milan",
    countries: ["IT"],
    cities: ["Milan", "Milano"],
    currency: "EUR",
    basis: "annual",
    paymentsPerYear: 14,
    hoursPerWeek: 40,
    workingDaysPerYear: 250,
    kinds: ["permanent", "fixed_term"],
  }),
  region: "South Europe",
};
const madrid = {
  ...PayZone.parse({
    id: "z2",
    name: "Spain",
    countries: ["ES"],
    currency: "EUR",
    basis: "annual",
    paymentsPerYear: 14,
    hoursPerWeek: 40,
    workingDaysPerYear: 250,
    kinds: ["permanent"],
  }),
  region: "South Europe",
};
const india = {
  ...PayZone.parse({
    id: "z3",
    name: "India",
    countries: ["IN"],
    currency: "INR",
    basis: "annual",
    paymentsPerYear: 12,
    hoursPerWeek: 45,
    workingDaysPerYear: 250,
    kinds: ["permanent"],
  }),
  region: "India",
};

const role = (over: Partial<LogisticsRequisition> = {}): LogisticsRequisition => ({
  ctcBandMin: 45_000,
  ctcBandMax: 60_000,
  pay: {
    terms: PayTerms.parse({ kind: "permanent", basis: "annual", currency: "EUR" }),
    zone: milan,
    rates: [{ from: "EUR", to: "USD", rate: 1.08, source: "finance", at: "2026-11-10T00:00:00Z" }],
    reportingCurrency: "USD",
    farAbovePct: 20,
    now: NOW,
  },
  neededBy: "2027-02-01",
  pool: { rule: "same_region", zone: "Milan", region: "South Europe" },
  ...over,
});
const eur = (amount: number) =>
  Money.parse({ amount, currency: "EUR", basis: "annual", gross: true });

describe("logistics with pay terms, needed-by and pool", () => {
  test("pay is compared in the role's currency: €58k inside, €75k far above (blocks)", () => {
    expect(logisticsCheck({ expectedPay: eur(58_000) }, role()).blockers).toEqual([]);
    const far = logisticsCheck({ expectedPay: eur(75_000) }, role());
    expect(far.blockers).toContain(CTC_CEILING_BLOCKER);
    // The organisation's tolerance decides "far": at 30%, €75k is only above.
    const loose = logisticsCheck(
      { expectedPay: eur(75_000) },
      role({ pay: { ...role().pay!, farAbovePct: 30 } }),
    );
    expect(loose.blockers).toEqual([]);
    expect(loose.flags.join(" ")).toContain("above the approved band");
  });

  test("a net figure is not compared — flagged, never blocked", () => {
    const r = logisticsCheck(
      { expectedPay: { ...eur(2_400), basis: "monthly", gross: false } },
      role(),
    );
    expect(r.blockers).toEqual([]);
    expect(r.flags.join(" ")).toContain("not compared — net figure");
  });

  test("joining after the role is needed by holds; the notice estimate only flags", () => {
    const late = logisticsCheck({ earliestJoining: "2027-03-01" }, role());
    expect(late.blockers[0]).toStartWith(JOIN_AFTER_NEEDED_BLOCKER);
    expect(late.blockers[0]).toContain("2027-03-01");
    expect(logisticsCheck({ earliestJoining: "2027-01-15" }, role()).blockers).toEqual([]);
    const estimate = logisticsCheck({ noticePeriodDays: 90 }, role());
    expect(estimate.blockers).toEqual([]);
    expect(estimate.flags.join(" ")).toContain("could join around 2027-02-09");
    expect(logisticsCheck({}, role()).missing).toContain("joining date");
  });

  test("the pool: same region passes Madrid, holds Bangalore unless they relocate", () => {
    const place = (zone: string, region: string) => ({ place: { zone, region } });
    expect(logisticsCheck(place("Spain", "South Europe"), role()).blockers).toEqual([]);
    const out = logisticsCheck(place("India", "India"), role());
    expect(out.blockers[0]).toStartWith(OUTSIDE_POOL_BLOCKER);
    expect(out.outside_pool).toBe(true);
    const moving = logisticsCheck({ ...place("India", "India"), willingToRelocate: true }, role());
    expect(moving.blockers).toEqual([]);
    expect(moving.flags).toContain("Outside the role's pool — open to relocating");
    // Same zone is stricter; global remote never pools; an unknown place is not judged.
    const strict = role({ pool: { rule: "same_zone", zone: "Milan", region: "South Europe" } });
    expect(logisticsCheck(place("Spain", "South Europe"), strict).blockers[0]).toStartWith(
      OUTSIDE_POOL_BLOCKER,
    );
    const remote = role({ pool: { rule: "global_remote", zone: "Milan", region: "South Europe" } });
    expect(logisticsCheck(place("India", "India"), remote).blockers).toEqual([]);
    expect(logisticsCheck({ place: null }, role()).blockers).toEqual([]);
  });

  test("roles without pay terms behave exactly as before", () => {
    const legacy = logisticsCheck({ expectedCtc: 3_000_000 }, { ctcBandMax: 2_000_000 });
    expect(legacy.blockers).toEqual([CTC_CEILING_BLOCKER]);
    expect(logisticsCheck({ noticePeriodDays: 60 }, {}).blockers).toEqual([]);
  });

  test("each hold keeps the score but never earns select", () => {
    const blockers = [
      `${JOIN_AFTER_NEEDED_BLOCKER} (2027-02-01): they can join on 2027-03-01`,
      "Location mismatch and candidate will not relocate",
    ];
    expect(holdingBlockers(blockers)).toHaveLength(1);
    const gate = {
      injectionSuspected: false,
      experienceScore: 100,
      levelMismatch: false,
      directionMismatch: false,
      ctcOverBand: holdingBlockers(blockers).length > 0,
    };
    expect(gatedRecommendation(90, gate)).toBe("hold");
    expect(gatedRecommendation(90, { ...gate, ctcOverBand: false })).toBe("select");
  });
});

describe("places resolve to pay zones", () => {
  const zones = [milan, madrid, india];
  test("a zone city wins; then the country; nothing is guessed", () => {
    expect(placeOf("Milano, Lombardy", zones)).toEqual({ zone: "Milan", region: "South Europe" });
    expect(placeOf("Madrid, Spain", zones)).toEqual({ zone: "Spain", region: "South Europe" });
    expect(placeOf("Bengaluru, India", zones)).toEqual({ zone: "India", region: "India" });
    expect(placeOf("Rome, Italy", zones)).toBeNull(); // Italy has only a Milan zone
    expect(placeOf("Lisbon", zones)).toBeNull();
    expect(placeOf("", zones)).toBeNull();
  });
});

describe("the screening call asks pay in the role's terms", () => {
  test("the term per currency, basis and kind", () => {
    const w = (x: Partial<PayTerms>) =>
      callPayWords(PayTerms.parse({ kind: "permanent", basis: "annual", currency: "INR", ...x }));
    expect(w({}).term).toBe("CTC per year");
    expect(w({ currency: "EUR" })).toMatchObject({
      term: "gross yearly salary",
      currencyName: "euros",
    });
    expect(
      w({ currency: "USD", kind: "contract_hourly", basis: "hourly", contractMonths: 6 }),
    ).toMatchObject({
      term: "hourly rate",
      contract: true,
      contractMonths: 6,
    });
    expect(w({ currency: "GBP", basis: "daily", kind: "contract_hourly" }).term).toBe("day rate");
  });

  const facts = (pay?: BriefFacts["pay"]): BriefFacts =>
    ({
      assistantName: "Saranya",
      orgName: "Acme",
      roleTitle: "Data Engineer",
      roleCode: "REQ-1",
      place: "Milan",
      forClient: false,
      roleSummary: null,
      responsibilities: [],
      appliedVia: null,
      appliedOn: null,
      booked: false,
      reschedulesLeft: 2,
      contactEmail: "careers@acme.test",
      candidateFirstName: "Giulia",
      cv: { currentCompany: null, experienceYears: null, location: null },
      strengths: [],
      known: { notice: false, currentPay: false, expectedPay: false },
      emailDomain: null,
      questions: [],
      maxMinutes: 3,
      nextSteps: "the hiring team will be in touch",
      callingHours: "Monday to Friday, 09:00 to 18:00",
      ...(pay ? { pay } : {}),
    }) as BriefFacts;

  test("an Indian permanent role is unchanged: notice, date, CTC per year", () => {
    const p = callSystemPrompt(facts());
    expect(p).toContain('"What is your notice period?"');
    expect(p).toContain('"What is your current CTC per year?"');
    expect(p).not.toContain("Pay for this role is asked as");
  });

  test("a Milan fixed-term role: start date, contract length, gross yearly salary in euros", () => {
    const p = callSystemPrompt(
      facts(
        callPayWords(
          PayTerms.parse({
            kind: "fixed_term",
            basis: "annual",
            currency: "EUR",
            contractMonths: 12,
          }),
        ),
      ),
    );
    expect(p).toContain('"When could you start?"');
    expect(p).toContain('"How long a contract are you looking for?"');
    expect(p).not.toContain('"What is your notice period?"');
    expect(p).toContain('"What is your current gross yearly salary?"');
    expect(p).toContain("gross yearly salary in euros; it is a contract of 12 months");
  });

  test("figures in other currencies count as stated amounts", () => {
    for (const r of ["52,000 euros", "€52k", "$65 an hour", "65 dollars an hour", "£550 a day"])
      expect(STATES_AMOUNT.test(r)).toBe(true);
    expect(STATES_AMOUNT.test("I would negotiate with HR")).toBe(false);
  });
});
