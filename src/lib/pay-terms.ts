/**
 * Pay terms — currency, pay basis, kinds of work and pay zones
 * (docs/pay-terms-plan.md, Phase 1).
 *
 * One figure carries three currencies that must never be confused:
 *  - quoted:    what the candidate (or a document) said — stored as said;
 *  - pay:       what the role pays in — set by where the job is (its pay zone);
 *  - reporting: what the organisation normalises to (organizations.currency).
 *
 * Pure: no database, no clock (callers pass rates and dates). Unit-tested in
 * scripts/pay-terms.test.ts, one test per scenario in the plan.
 */
import { z } from "zod";

export const KINDS_OF_WORK = [
  "permanent",
  "fixed_term",
  "contract_hourly",
  "part_time",
  "intern",
] as const;
export type KindOfWork = (typeof KINDS_OF_WORK)[number];

export const PAY_BASES = ["annual", "monthly", "daily", "hourly"] as const;
export type PayBasis = (typeof PAY_BASES)[number];

/** What a quoted figure may include, by name (zone conventions differ). */
export const PAY_COMPONENTS = [
  "base",
  "variable",
  "bonus",
  "equity",
  "employer_pf",
  "gratuity",
  "allowances",
  "thirteenth_month",
  "fourteenth_month",
  "tfr",
] as const;
export type PayComponent = (typeof PAY_COMPONENTS)[number];

const Iso4217 = z
  .string()
  .regex(/^[A-Z]{3}$/, "a three-letter ISO 4217 code such as INR, USD, EUR or GBP");

/** A pay zone: one place with one way of paying (organisation-defined). */
export const PayZone = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** ISO 3166-1 alpha-2 codes. */
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
  /** Optional city narrowing ("Milan", "Bengaluru"), case-insensitive. */
  cities: z.array(z.string()).default([]),
  currency: Iso4217,
  /** How pay is usually quoted here. */
  basis: z.enum(PAY_BASES),
  /** Salary payments a year: IN 12, IT 13 or 14, BR 13. */
  paymentsPerYear: z.number().int().min(12).max(16),
  /** What a quoted figure here includes. */
  includes: z.array(z.enum(PAY_COMPONENTS)).default(["base"]),
  hoursPerWeek: z.number().min(1).max(80),
  workingDaysPerYear: z.number().int().min(150).max(300),
  kinds: z.array(z.enum(KINDS_OF_WORK)).min(1),
  /** Contract types used here: "ir35_inside", "ir35_outside", "w2", "1099", "c2c", "payroll", "third_party". */
  contractTypes: z.array(z.string()).default([]),
  entity: z.string().nullable().default(null),
  /** Pay factor against the organisation's reference zone (remote, pay by location). */
  geoFactor: z.number().positive().nullable().default(null),
});
export type PayZone = z.infer<typeof PayZone>;

/** A figure as said, with what it means. */
export const Money = z.object({
  amount: z.number().nonnegative(),
  currency: Iso4217,
  basis: z.enum(PAY_BASES),
  /** null: not said. Net is never converted to gross by us. */
  gross: z.boolean().nullable().default(null),
  /** For monthly figures: how many payments a year (null: the zone's). */
  paymentsPerYear: z.number().int().min(12).max(16).nullable().default(null),
  includes: z.array(z.enum(PAY_COMPONENTS)).nullable().default(null),
  /** Their words ("€52k RAL", "95 lakhs to 1 crore"). */
  saidAs: z.string().default(""),
  /** The currency was assumed for display, not said. */
  currencyAssumed: z.boolean().default(false),
});
export type Money = z.infer<typeof Money>;
export type MoneyInput = z.input<typeof Money>;

/** The terms a role is paid on (set on the requisition). */
export const PayTerms = z.object({
  kind: z.enum(KINDS_OF_WORK),
  basis: z.enum(PAY_BASES),
  currency: Iso4217,
  hoursPerWeek: z.number().min(1).max(80).nullable().default(null),
  daysPerWeek: z.number().min(1).max(7).nullable().default(null),
  contractMonths: z.number().int().min(1).max(120).nullable().default(null),
  extendable: z.boolean().nullable().default(null),
  /** YYYY-MM-DD — the role's urgency. */
  neededBy: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  /** Contract type when the zone distinguishes them (w2, 1099, ir35_outside…). */
  contractType: z.string().nullable().default(null),
  /** Remote role paid by the candidate's location (geo factor) rather than one band. */
  paysByLocation: z.boolean().default(false),
});
export type PayTerms = z.infer<typeof PayTerms>;

/** The terms every existing row is backfilled to — behaviour unchanged. */
export function defaultPayTerms(orgCurrency: string | null | undefined): PayTerms {
  return PayTerms.parse({
    kind: "permanent",
    basis: "annual",
    currency: orgCurrency && /^[A-Z]{3}$/.test(orgCurrency) ? orgCurrency : "INR",
  });
}

/** A dated exchange rate: 1 unit of `from` = `rate` units of `to`. */
export type ExchangeRate = {
  from: string;
  to: string;
  rate: number;
  source: string;
  /** ISO timestamp the rate is for. */
  at: string;
};

/**
 * The zone a location falls in (pure): a city match wins over a country-only
 * zone. `country` is ISO alpha-2. Null when no zone covers it — the requisition
 * agent then asks.
 */
export function zoneFor(
  zones: PayZone[],
  place: { country: string | null; city?: string | null },
): PayZone | null {
  if (!place.country) return null;
  const country = place.country.toUpperCase();
  const city = place.city?.trim().toLowerCase() ?? "";
  const inCountry = zones.filter((z) => z.countries.includes(country));
  const byCity = city
    ? inCountry.find((z) => z.cities.some((c) => c.toLowerCase() === city))
    : undefined;
  return byCity ?? inCountry.find((z) => z.cities.length === 0) ?? null;
}
