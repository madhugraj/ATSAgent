/**
 * The organisation's pay conventions (docs/pay-terms-plan.md, Phase 2): its
 * reporting currency and defaults, the tolerance over a band, its pooling regions
 * and its pay zones. Conventions only — never a pay figure. The organisation agent
 * proposes them; the HR head approves; then they are applied
 * (src/lib/pay-settings.server.ts). Pure; shared by server and client.
 */
import { z } from "zod";
import { KINDS_OF_WORK, PAY_BASES, PAY_COMPONENTS } from "./pay-terms";

export const POOLING_RULES = [
  "same_zone",
  "same_region",
  "entity_countries",
  "global_remote",
] as const;
export type PoolingRule = (typeof POOLING_RULES)[number];

const Iso4217 = z.string().regex(/^[A-Z]{3}$/, "a three-letter currency code such as USD");
const Country = z.string().regex(/^[A-Z]{2}$/, "a two-letter country code such as IT");

export const ConventionZone = z.object({
  name: z.string().trim().min(1).max(60),
  countries: z.array(Country).min(1).max(30),
  cities: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  currency: Iso4217,
  basis: z.enum(PAY_BASES).default("annual"),
  paymentsPerYear: z.number().int().min(12).max(16).default(12),
  includes: z.array(z.enum(PAY_COMPONENTS)).min(1).default(["base"]),
  hoursPerWeek: z.number().min(1).max(80).default(40),
  workingDaysPerYear: z.number().int().min(150).max(300).default(250),
  kinds: z.array(z.enum(KINDS_OF_WORK)).min(1).default(["permanent"]),
  contractTypes: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  entity: z.string().trim().max(120).nullable().default(null),
  geoFactor: z.number().positive().max(5).nullable().default(null),
  /** The pooling region's name (one of `regions`), or null. */
  region: z.string().trim().max(60).nullable().default(null),
});
export type ConventionZone = z.infer<typeof ConventionZone>;

export const ConventionRegion = z.object({
  name: z.string().trim().min(1).max(60),
  rule: z.enum(POOLING_RULES).default("same_region"),
});

export const PayConventions = z
  .object({
    /** What pay is normalised to across zones. */
    reportingCurrency: Iso4217,
    payBasisDefault: z.enum(PAY_BASES).default("annual"),
    hoursPerWeekDefault: z.number().min(1).max(80).default(40),
    kindsOfWork: z.array(z.enum(KINDS_OF_WORK)).min(1).default(["permanent"]),
    /** Over a band's ceiling by more than this % is a blocker. */
    farAbovePct: z.number().int().min(0).max(100).default(20),
    regions: z.array(ConventionRegion).max(30).default([]),
    zones: z.array(ConventionZone).max(100).default([]),
  })
  .superRefine((c, ctx) => {
    const regions = new Set(c.regions.map((r) => r.name.toLowerCase()));
    if (regions.size !== c.regions.length)
      ctx.addIssue({ code: "custom", message: "Two regions have the same name." });
    const zones = new Set<string>();
    for (const z of c.zones) {
      const key = z.name.toLowerCase();
      if (zones.has(key))
        ctx.addIssue({ code: "custom", message: `Two zones are called “${z.name}”.` });
      zones.add(key);
      if (z.region && !regions.has(z.region.toLowerCase()))
        ctx.addIssue({
          code: "custom",
          message: `Zone “${z.name}” names region “${z.region}”, which is not in the list.`,
        });
    }
    // One country-wide zone per country (city zones may narrow it).
    const countryWide = new Map<string, string>();
    for (const z of c.zones.filter((z) => z.cities.length === 0))
      for (const country of z.countries) {
        const other = countryWide.get(country);
        if (other)
          ctx.addIssue({
            code: "custom",
            message: `${country} is covered by both “${other}” and “${z.name}” — give one of them cities.`,
          });
        countryWide.set(country, z.name);
      }
  });
export type PayConventions = z.infer<typeof PayConventions>;
export type PayConventionsInput = z.input<typeof PayConventions>;

/** What changes if `next` is applied over `current` (pure; for the approver). */
export function conventionChanges(current: PayConventions | null, next: PayConventions): string[] {
  const out: string[] = [];
  const cur = current;
  if (!cur || cur.reportingCurrency !== next.reportingCurrency)
    out.push(`Reporting currency: ${cur?.reportingCurrency ?? "—"} → ${next.reportingCurrency}`);
  if (!cur || cur.payBasisDefault !== next.payBasisDefault)
    out.push(`Pay usually quoted: ${cur?.payBasisDefault ?? "—"} → ${next.payBasisDefault}`);
  if (!cur || cur.farAbovePct !== next.farAbovePct)
    out.push(
      `Over a band's ceiling by more than ${next.farAbovePct}% blocks (was ${cur?.farAbovePct ?? "—"}%)`,
    );
  if (!cur || cur.kindsOfWork.join() !== next.kindsOfWork.join())
    out.push(`Kinds of work: ${next.kindsOfWork.join(", ")}`);
  const curZones = new Map((cur?.zones ?? []).map((z) => [z.name.toLowerCase(), z]));
  for (const z of next.zones) {
    const before = curZones.get(z.name.toLowerCase());
    const line = `${z.name} (${z.countries.join(", ")}${z.cities.length ? ` — ${z.cities.join(", ")}` : ""}): ${z.currency}, ${z.basis}, ${z.paymentsPerYear} payments, ${z.hoursPerWeek} h/week${z.region ? `, region ${z.region}` : ""}`;
    if (!before) out.push(`New zone — ${line}`);
    else if (JSON.stringify(before) !== JSON.stringify(z)) out.push(`Changed zone — ${line}`);
    curZones.delete(z.name.toLowerCase());
  }
  for (const z of curZones.values()) out.push(`Zone removed — ${z.name}`);
  const curRegions = new Map((cur?.regions ?? []).map((r) => [r.name.toLowerCase(), r]));
  for (const r of next.regions) {
    const before = curRegions.get(r.name.toLowerCase());
    if (!before || before.rule !== r.rule)
      out.push(`Region ${r.name}: candidates pooled by ${r.rule.replace(/_/g, " ")}`);
    curRegions.delete(r.name.toLowerCase());
  }
  for (const r of curRegions.values()) out.push(`Region removed — ${r.name}`);
  return out;
}
