/**
 * Pay terms, Phase 1 — one test per scenario in docs/pay-terms-plan.md
 * ("Scenarios this has to get right"). Pure: no database.
 *
 * Run: bun test scripts/pay-terms.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  checkAgainstBand,
  conventionsOf,
  convert,
  hikePct,
  parseAmounts,
  rateFor,
  spokenMoney,
} from "../src/lib/pay-convert";
import {
  defaultPayTerms,
  Money,
  PayTerms,
  PayZone,
  zoneFor,
  type ExchangeRate,
  type MoneyInput,
} from "../src/lib/pay-terms";

const NOW = new Date("2026-11-11T06:00:00Z");
const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const zone = (z: Partial<PayZone> & Pick<PayZone, "id" | "name" | "countries" | "currency">) =>
  PayZone.parse({
    basis: "annual",
    paymentsPerYear: 12,
    hoursPerWeek: 40,
    workingDaysPerYear: 250,
    kinds: ["permanent"],
    ...z,
  });

const ZONES = {
  india: zone({
    id: "in",
    name: "India",
    countries: ["IN"],
    currency: "INR",
    includes: ["base", "variable", "employer_pf", "gratuity"],
    hoursPerWeek: 45,
  }),
  milan: zone({
    id: "it-mi",
    name: "Milan",
    countries: ["IT"],
    cities: ["Milan", "Milano"],
    currency: "EUR",
    paymentsPerYear: 14,
    includes: ["base", "thirteenth_month", "fourteenth_month"],
  }),
  italy: zone({ id: "it", name: "Italy", countries: ["IT"], currency: "EUR", paymentsPerYear: 13 }),
  krakow: zone({ id: "pl", name: "Poland", countries: ["PL"], currency: "PLN" }),
  uk: zone({
    id: "uk",
    name: "UK",
    countries: ["GB"],
    currency: "GBP",
    hoursPerWeek: 37.5,
    workingDaysPerYear: 230,
    kinds: ["permanent", "contract_hourly"],
    contractTypes: ["ir35_inside", "ir35_outside"],
  }),
  us: zone({
    id: "us",
    name: "US",
    countries: ["US"],
    currency: "USD",
    kinds: ["permanent", "contract_hourly"],
    contractTypes: ["w2", "1099", "c2c"],
  }),
  gulf: zone({
    id: "ae",
    name: "UAE",
    countries: ["AE"],
    currency: "AED",
    basis: "monthly",
    includes: ["base", "allowances"],
  }),
  argentina: zone({
    id: "ar",
    name: "Argentina",
    countries: ["AR"],
    currency: "ARS",
    basis: "monthly",
    paymentsPerYear: 13,
  }),
};

const RATES: ExchangeRate[] = [
  { from: "EUR", to: "USD", rate: 1.08, source: "finance table", at: day(1) },
  { from: "USD", to: "INR", rate: 84, source: "finance table", at: day(1) },
  { from: "EUR", to: "INR", rate: 90.7, source: "finance table", at: day(1) },
  { from: "GBP", to: "USD", rate: 1.27, source: "finance table", at: day(1) },
  { from: "PLN", to: "USD", rate: 0.25, source: "finance table", at: day(1) },
  { from: "AED", to: "USD", rate: 0.2723, source: "finance table", at: day(1) },
  { from: "USD", to: "ARS", rate: 1000, source: "finance table", at: day(3) },
];

const m = (x: MoneyInput) => Money.parse(x);
const terms = (x: Partial<PayTerms> & Pick<PayTerms, "currency">) =>
  PayTerms.parse({ kind: "permanent", basis: "annual", ...x });

const check = (o: {
  figure: Money;
  terms: PayTerms;
  zone: PayZone | null;
  band: { min: number | null; max: number | null };
  rates?: ExchangeRate[];
  reporting?: string;
  figureKind?: string;
  figureContractType?: string;
}) =>
  checkAgainstBand({
    figure: o.figure,
    terms: o.terms,
    zone: o.zone,
    band: o.band,
    rates: o.rates ?? RATES,
    reportingCurrency: o.reporting ?? "USD",
    now: NOW,
    ...(o.figureKind ? { figureKind: o.figureKind } : {}),
    ...(o.figureContractType ? { figureContractType: o.figureContractType } : {}),
  });

const milanRole = terms({ currency: "EUR" });
const milanBand = { min: 45_000, max: 60_000 };

describe("pay terms — the 20 scenarios", () => {
  test("1 · Milan role, USD reporting, candidate says €52k", () => {
    const fig = m({
      amount: 52_000,
      currency: "EUR",
      basis: "annual",
      gross: true,
      saidAs: "€52k RAL",
    });
    const r = check({ figure: fig, terms: milanRole, zone: ZONES.milan, band: milanBand });
    expect(r.comparable).toBe(true);
    expect(r.position).toBe("inside");
    expect(r.inPay).toMatchObject({ amount: 52_000, currency: "EUR" });
    expect(r.inReporting).toMatchObject({ amount: 56_160, currency: "USD" });
    expect(fig.amount).toBe(52_000); // the original is never changed
  });

  test("2 · same role, candidate quotes in $ because the posting said $", () => {
    const fig = m({ amount: 65_000, currency: "USD", basis: "annual", gross: true });
    const r = check({ figure: fig, terms: milanRole, zone: ZONES.milan, band: milanBand });
    expect(r.comparable).toBe(true);
    expect(r.inPay!.currency).toBe("EUR");
    expect(r.inPay!.amount).toBeCloseTo(60_185.19, 1);
    expect(r.position).toBe("above");
    expect(r.flags.join(" ")).toContain("Quoted in USD; the role pays in EUR");
  });

  test("3 · Italian candidate quotes monthly net — never converted, ask gross", () => {
    const fig = m({
      amount: 2_400,
      currency: "EUR",
      basis: "monthly",
      gross: false,
      saidAs: "€2,400 a month net",
    });
    const r = check({ figure: fig, terms: milanRole, zone: ZONES.milan, band: milanBand });
    expect(r.comparable).toBe(false);
    expect(r.refusal).toBe("net_figure");
    expect(r.flags.join(" ")).toContain("ask for the gross amount");
  });

  test("4 · 13th/14th month: €3,200 × 14 equals €44,800 a year", () => {
    const c = conventionsOf(milanRole, ZONES.milan);
    const monthly = m({ amount: 3_200, currency: "EUR", basis: "monthly", gross: true });
    const r = convert(monthly, { currency: "EUR", basis: "annual" }, c, RATES, NOW);
    expect(r.ok && r.money.amount).toBe(44_800);
    // A figure that says its own payments a year wins over the zone's.
    const over13 = m({ ...monthly, paymentsPerYear: 13 });
    const r13 = convert(over13, { currency: "EUR", basis: "annual" }, c, RATES, NOW);
    expect(r13.ok && r13.money.amount).toBe(41_600);
  });

  test("5 · India CTC vs US base: different pay definitions are flagged", () => {
    const usRole = terms({ currency: "USD" });
    const fig = m({
      amount: 6_720_000,
      currency: "INR",
      basis: "annual",
      gross: true,
      includes: ["base", "variable", "employer_pf", "gratuity"],
    });
    const r = check({
      figure: fig,
      terms: usRole,
      zone: ZONES.us,
      band: { min: 70_000, max: 90_000 },
    });
    expect(r.comparable).toBe(true);
    expect(r.inPay!.amount).toBe(80_000);
    expect(r.flags.join(" ")).toContain("Different pay definitions");
  });

  test("6 · remote role paid by the candidate's location (geo factor)", () => {
    const reference = { min: 100_000, max: 130_000 }; // US reference band
    const geo = 0.55; // Poland vs US, set on the zone by the organisation
    const krakow = { ...ZONES.krakow, geoFactor: geo };
    const bandUsd = { min: reference.min * geo, max: reference.max * geo };
    const role = terms({ currency: "USD", paysByLocation: true });
    const fig = m({ amount: 260_000, currency: "PLN", basis: "annual", gross: true });
    const r = check({ figure: fig, terms: role, zone: krakow, band: bandUsd });
    expect(r.inPay!.amount).toBe(65_000);
    expect(r.position).toBe("inside");
  });

  test("7 · remote role with one global USD band: local quotes converted to USD", () => {
    const role = terms({ currency: "USD" });
    const fig = m({ amount: 60_000, currency: "GBP", basis: "annual", gross: true });
    const r = check({
      figure: fig,
      terms: role,
      zone: ZONES.uk,
      band: { min: 70_000, max: 90_000 },
    });
    expect(r.inPay).toMatchObject({ amount: 76_200, currency: "USD" });
    expect(r.position).toBe("inside");
  });

  test("8 · relocating Bangalore → Milan: no raw hike % across currencies", () => {
    const current = m({ amount: 6_700_000, currency: "INR", basis: "annual", gross: true });
    const expected = m({ amount: 80_000, currency: "EUR", basis: "annual", gross: true });
    const c = conventionsOf(milanRole, ZONES.milan);
    const pct = hikePct(current, expected, c, RATES, NOW);
    // 6.7M INR at 90.7 = €73,870 → about 8.3%, not (80,000 − 6,700,000)/…
    expect(typeof pct).toBe("number");
    expect(pct as number).toBeCloseTo(8.3, 0);
    expect(hikePct(current, expected, c, [], NOW)).toBe("no_rate");
  });

  test("9 · UK contractor day rate outside IR35 — never against a permanent band", () => {
    const fig = m({ amount: 550, currency: "GBP", basis: "daily", gross: true });
    const permanentRole = terms({ currency: "GBP" });
    const r = check({
      figure: fig,
      terms: permanentRole,
      zone: ZONES.uk,
      band: { min: 60_000, max: 80_000 },
      figureKind: "contract_hourly",
    });
    expect(r.comparable).toBe(false);
    expect(r.refusal).toBe("different_kind_of_work");
    const contractRole = terms({
      currency: "GBP",
      kind: "contract_hourly",
      basis: "daily",
      contractType: "ir35_outside",
    });
    const ok = check({
      figure: fig,
      terms: contractRole,
      zone: ZONES.uk,
      band: { min: 450, max: 600 },
      figureKind: "contract_hourly",
      figureContractType: "ir35_outside",
    });
    expect(ok.position).toBe("inside");
  });

  test("10 · US 1099 rate is not compared with a W-2 band", () => {
    const role = terms({
      currency: "USD",
      kind: "contract_hourly",
      basis: "hourly",
      contractType: "w2",
    });
    const fig = m({ amount: 85, currency: "USD", basis: "hourly", gross: true });
    const r = check({
      figure: fig,
      terms: role,
      zone: ZONES.us,
      band: { min: 60, max: 80 },
      figureKind: "contract_hourly",
      figureContractType: "1099",
    });
    expect(r.refusal).toBe("different_contract_type");
  });

  test("11 · Gulf: tax-free with allowances — components kept, definitions compared", () => {
    const role = terms({ currency: "AED", basis: "monthly" });
    const fig = m({
      amount: 30_000,
      currency: "AED",
      basis: "monthly",
      gross: true,
      includes: ["base"],
    });
    const r = check({
      figure: fig,
      terms: role,
      zone: ZONES.gulf,
      band: { min: 28_000, max: 35_000 },
    });
    expect(r.position).toBe("inside");
    expect(r.flags.join(" ")).toContain("Different pay definitions");
  });

  test("12 · volatile currency: a 3-day-old ARS rate is refused", () => {
    expect(rateFor(RATES, "USD", "ARS", NOW)).toBe("stale_rate");
    const role = terms({ currency: "ARS", basis: "monthly" });
    const fig = m({ amount: 2_000, currency: "USD", basis: "monthly", gross: true });
    const r = check({
      figure: fig,
      terms: role,
      zone: ZONES.argentina,
      band: { min: 1e6, max: 3e6 },
    });
    expect(r.refusal).toBe("stale_rate");
    // EUR/USD a day old is fine; eight days old is not.
    expect(typeof rateFor(RATES, "EUR", "USD", NOW)).toBe("object");
    expect(rateFor([{ ...RATES[0]!, at: day(8) }], "EUR", "USD", NOW)).toBe("stale_rate");
  });

  test("13 · a rate move never flips the decision (made in pay currency)", () => {
    const fig = m({ amount: 58_000, currency: "EUR", basis: "annual", gross: true });
    const a = check({ figure: fig, terms: milanRole, zone: ZONES.milan, band: milanBand });
    const moved = RATES.map((r) => (r.from === "EUR" && r.to === "USD" ? { ...r, rate: 1.2 } : r));
    const b = check({
      figure: fig,
      terms: milanRole,
      zone: ZONES.milan,
      band: milanBand,
      rates: moved,
    });
    expect(a.position).toBe(b.position);
    expect(a.inReporting!.amount).not.toBe(b.inReporting!.amount);
  });

  test("14 · ranges and scales as said", () => {
    expect(parseAmounts("Between 95 lakhs to 1 crore").amounts).toEqual([9_500_000, 10_000_000]);
    expect(parseAmounts("€52k RAL")).toMatchObject({
      amounts: [52_000],
      currency: "EUR",
      basis: "annual",
    });
    expect(parseAmounts("1.2 M dollars").amounts).toEqual([1_200_000]);
    expect(parseAmounts("$65 an hour")).toMatchObject({
      amounts: [65],
      currency: "USD",
      basis: "hourly",
    });
    expect(parseAmounts("18 LPA")).toMatchObject({ amounts: [1_800_000], basis: "annual" });
    expect(parseAmounts("three months notice, joining on 1st March").amounts).toEqual([]);
  });

  test("15 · no currency said: assumed for display only, and flagged", () => {
    const fig = m({
      amount: 50_000,
      currency: "EUR",
      basis: "annual",
      gross: true,
      currencyAssumed: true,
      saidAs: "fifty thousand",
    });
    const r = check({ figure: fig, terms: milanRole, zone: ZONES.milan, band: milanBand });
    expect(r.flags.join(" ")).toContain("Currency not said");
  });

  test("16 · raised at India HQ for a Milan opening: zone from the job's location", () => {
    const zones = Object.values(ZONES);
    expect(zoneFor(zones, { country: "IT", city: "Milano" })!.id).toBe("it-mi");
    expect(zoneFor(zones, { country: "IT", city: "Rome" })!.id).toBe("it");
    expect(zoneFor(zones, { country: "IN", city: "Bengaluru" })!.id).toBe("in");
    expect(zoneFor(zones, { country: "FR", city: "Paris" })).toBeNull(); // the agent asks
  });

  test("17 · one requisition, Pune and Kraków: one band per zone", () => {
    const pune = check({
      figure: m({ amount: 2_500_000, currency: "INR", basis: "annual", gross: true }),
      terms: terms({ currency: "INR" }),
      zone: ZONES.india,
      band: { min: 2_000_000, max: 2_800_000 },
    });
    const krakow = check({
      figure: m({ amount: 180_000, currency: "PLN", basis: "annual", gross: true }),
      terms: terms({ currency: "PLN" }),
      zone: ZONES.krakow,
      band: { min: 150_000, max: 200_000 },
    });
    expect([pune.position, krakow.position]).toEqual(["inside", "inside"]);
    expect(pune.inReporting!.currency).toBe(krakow.inReporting!.currency);
  });

  test("18 · part-time 20 h/week: the role's hours, not the zone's", () => {
    const role = terms({ currency: "GBP", kind: "part_time", basis: "hourly", hoursPerWeek: 20 });
    const c = conventionsOf(role, ZONES.uk);
    expect(c.hoursPerWeek).toBe(20);
    const yearly = m({ amount: 26_000, currency: "GBP", basis: "annual", gross: true });
    const r = convert(yearly, { currency: "GBP", basis: "hourly" }, c, RATES, NOW);
    expect(r.ok && r.money.amount).toBe(25);
    // Without hours anywhere, hourly ↔ yearly is refused, never assumed.
    const none = convert(
      yearly,
      { currency: "GBP", basis: "hourly" },
      conventionsOf(null, null),
      RATES,
      NOW,
    );
    expect(none).toEqual({ ok: false, refusal: "hours_unknown" });
  });

  test("19 · working abroad, returning home: current pay in its own currency", () => {
    const current = m({ amount: 70_000, currency: "GBP", basis: "annual", gross: true });
    const expected = m({ amount: 5_000_000, currency: "INR", basis: "annual", gross: true });
    const rates = [
      ...RATES,
      { from: "GBP", to: "INR", rate: 106.7, source: "finance table", at: day(1) },
    ];
    const pct = hikePct(current, expected, conventionsOf(null, ZONES.india), rates, NOW);
    expect(pct as number).toBeCloseTo(-33.1, 0);
  });

  test("20 · reporting currency changes: derived values change, originals do not", () => {
    const fig = m({ amount: 52_000, currency: "EUR", basis: "annual", gross: true });
    const usd = check({
      figure: fig,
      terms: milanRole,
      zone: ZONES.milan,
      band: milanBand,
      reporting: "USD",
    });
    const inr = check({
      figure: fig,
      terms: milanRole,
      zone: ZONES.milan,
      band: milanBand,
      reporting: "INR",
    });
    expect(usd.inReporting!.currency).toBe("USD");
    expect(inr.inReporting).toMatchObject({ amount: 4_716_400, currency: "INR" });
    expect(usd.position).toBe(inr.position);
    expect(fig).toMatchObject({ amount: 52_000, currency: "EUR" });
  });
});

describe("pay terms — basics", () => {
  test("existing rows behave as today: organisation currency, annual, permanent", () => {
    expect(defaultPayTerms("INR")).toMatchObject({
      kind: "permanent",
      basis: "annual",
      currency: "INR",
    });
    expect(defaultPayTerms("usd").currency).toBe("INR"); // invalid code → today's default
    expect(defaultPayTerms(null).currency).toBe("INR");
  });

  test("money is spoken in its own currency and basis", () => {
    expect(spokenMoney({ amount: 1_850_000, currency: "INR", basis: "annual" })).toBe(
      "18 lakh 50 thousand rupees a year",
    );
    expect(spokenMoney({ amount: 90_000, currency: "GBP", basis: "annual" })).toBe(
      "90 thousand pounds a year",
    );
    expect(spokenMoney({ amount: 65.5, currency: "USD", basis: "hourly" })).toBe(
      "65.50 dollars an hour",
    );
    expect(spokenMoney({ amount: 52_000, currency: "EUR", basis: "annual" })).toBe(
      "52 thousand euros a year",
    );
    expect(spokenMoney({ amount: 4_000_000, currency: "ARS", basis: "monthly" })).toBe(
      "4 million ARS a month",
    );
  });

  test("an inverse rate is used when only the other direction is on record", () => {
    const r = rateFor(RATES, "USD", "EUR", NOW);
    expect(typeof r === "object" && r.rate).toBeCloseTo(1 / 1.08, 6);
  });
});
