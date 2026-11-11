/**
 * Pay context for matching and the screening call (docs/pay-terms-plan.md, Phase 3):
 *  - a role's pay terms, zone, pooling and the organisation's rates, for the
 *    logistics check;
 *  - a candidate's latest stated details for one application (the screening
 *    call or TA, newer than the CV) and where they are, resolved to a pay zone;
 *  - pay figures recorded as said, with the derived pay and reporting values.
 * Every query carries the organisation predicate (AGENTS.md).
 */
import { and, desc, eq } from "drizzle-orm";

import {
  compensationDetails,
  organizations,
  payFigures,
  payZones,
  poolingRegions,
  requisitions,
} from "../../drizzle/schema";
import { db } from "../server/db";
import type { LogisticsCandidate, LogisticsRequisition } from "./logistics";
import { conventionsOf, convert } from "./pay-convert";
import { Money, PayTerms, type ExchangeRate, type PayBasis, type PayZone } from "./pay-terms";
import { ratesOf, zonesOf } from "./pay-settings.server";

type Req = typeof requisitions.$inferSelect;

export function termsOf(r: Req): PayTerms {
  return PayTerms.parse({
    kind: r.kindOfWork,
    basis: r.payBasis,
    currency: r.payCurrency,
    hoursPerWeek: r.hoursPerWeek != null ? Number(r.hoursPerWeek) : null,
    daysPerWeek: r.daysPerWeek != null ? Number(r.daysPerWeek) : null,
    contractMonths: r.contractMonths,
    extendable: r.extendable,
    neededBy: r.neededBy,
    contractType: r.contractType,
    paysByLocation: r.paysByLocation,
  });
}

/** Country names and common spellings → ISO codes, for resolving free-text places. */
const COUNTRY_WORDS: Record<string, string> = {
  india: "IN",
  italy: "IT",
  italia: "IT",
  "united kingdom": "GB",
  uk: "GB",
  england: "GB",
  "united states": "US",
  usa: "US",
  "u.s.": "US",
  poland: "PL",
  germany: "DE",
  france: "FR",
  spain: "ES",
  "united arab emirates": "AE",
  uae: "AE",
  dubai: "AE",
  singapore: "SG",
  brazil: "BR",
  argentina: "AR",
  canada: "CA",
  australia: "AU",
  netherlands: "NL",
  ireland: "IE",
  japan: "JP",
};

/**
 * The pay zone a free-text place falls in (pure): a zone city named in the text
 * wins, then a country named in it. Null when nothing matches — never guessed.
 */
export function placeOf(
  text: string | null | undefined,
  zones: (PayZone & { region?: string | null })[],
): { zone: string | null; region: string | null } | null {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return null;
  const word = (w: string) => new RegExp(`(^|[^a-z])${w.replace(/[.]/g, "\\.")}([^a-z]|$)`).test(t);
  const byCity = zones.find((z) => z.cities.some((c) => word(c.toLowerCase())));
  if (byCity) return { zone: byCity.name, region: byCity.region ?? null };
  const codes = Object.entries(COUNTRY_WORDS)
    .filter(([w]) => word(w))
    .map(([, c]) => c);
  for (const code of codes) {
    const z = zones.find((x) => x.countries.includes(code) && x.cities.length === 0);
    if (z) return { zone: z.name, region: z.region ?? null };
  }
  return null;
}

export type RoleContext = {
  terms: PayTerms;
  zones: (PayZone & { region: string | null })[];
  zone: (PayZone & { region: string | null }) | null;
  rates: ExchangeRate[];
  reportingCurrency: string;
  farAbovePct: number;
};

export async function roleContext(orgId: string, r: Req): Promise<RoleContext> {
  const [org] = await db
    .select({ currency: organizations.currency, far: organizations.payFarAbovePct })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const zoneRows = await db
    .select({ id: payZones.id, regionId: payZones.regionId })
    .from(payZones)
    .where(eq(payZones.orgId, orgId));
  const regions = await db.select().from(poolingRegions).where(eq(poolingRegions.orgId, orgId));
  const regionOf = new Map(
    zoneRows.map((z) => [z.id, regions.find((g) => g.id === z.regionId)?.name ?? null]),
  );
  const zones = (await zonesOf(orgId)).map((z) => ({ ...z, region: regionOf.get(z.id) ?? null }));
  return {
    terms: termsOf(r),
    zones,
    zone: zones.find((z) => z.id === r.payZoneId) ?? null,
    rates: await ratesOf(orgId),
    reportingCurrency: org?.currency && /^[A-Z]{3}$/.test(org.currency) ? org.currency : "INR",
    farAbovePct: org?.far ?? 20,
  };
}

/** The role's side of the logistics check: pay terms, needed-by, pool. */
export async function roleLogistics(
  orgId: string,
  r: Req,
  now = new Date(),
): Promise<{ ctx: RoleContext; constraints: Partial<LogisticsRequisition> }> {
  const ctx = await roleContext(orgId, r);
  const regions = await db.select().from(poolingRegions).where(eq(poolingRegions.orgId, orgId));
  const rule = ctx.zone?.region
    ? (regions.find((g) => g.name === ctx.zone!.region)?.defaultRule ?? "same_region")
    : "same_zone";
  return {
    ctx,
    constraints: {
      pay: {
        terms: ctx.terms,
        zone: ctx.zone,
        rates: ctx.rates,
        reportingCurrency: ctx.reportingCurrency,
        farAbovePct: ctx.farAbovePct,
        now,
      },
      neededBy: r.neededBy,
      // Pooling applies only once the role has a zone; remote by location never pools.
      pool:
        ctx.zone && !ctx.terms.paysByLocation
          ? {
              rule: rule as NonNullable<LogisticsRequisition["pool"]>["rule"],
              zone: ctx.zone.name,
              region: ctx.zone.region,
            }
          : null,
    },
  };
}

/**
 * The candidate's latest stated details for this application (the screening call
 * or TA — newer than the CV), and where they are as a zone. Fields not stated
 * stay as the CV has them (the caller merges).
 */
export async function candidateLogistics(
  orgId: string,
  applicationId: string,
  cvLocation: string | null,
  ctx: RoleContext,
): Promise<Partial<LogisticsCandidate>> {
  const rows = await db
    .select()
    .from(compensationDetails)
    .where(
      and(
        eq(compensationDetails.orgId, orgId),
        eq(compensationDetails.applicationId, applicationId),
      ),
    )
    .orderBy(desc(compensationDetails.createdAt))
    .limit(10);
  const latest = <K extends keyof (typeof rows)[number]>(k: K) =>
    rows.find((x) => x[k] != null)?.[k] ?? null;
  const out: Partial<LogisticsCandidate> = {};
  const notice = latest("noticePeriodDays");
  if (notice != null) out.noticePeriodDays = notice as number;
  const joining = latest("earliestJoining");
  if (joining) out.earliestJoining = joining as string;
  const relocate = latest("openToRelocate");
  if (relocate != null) out.willingToRelocate = relocate as boolean;
  const where = (latest("currentLocation") as string | null) ?? cvLocation;
  if (where) out.location = where;
  out.place = placeOf(where, ctx.zones);
  const expectedRow = rows.find((x) => x.expectedCtc != null);
  if (expectedRow) {
    out.expectedCtc = Number(expectedRow.expectedCtc);
    // The figure as recorded with its currency and basis (pay_figures), when it was.
    const [fig] = await db
      .select()
      .from(payFigures)
      .where(
        and(
          eq(payFigures.orgId, orgId),
          eq(payFigures.ownerType, "application"),
          eq(payFigures.ownerId, applicationId),
          eq(payFigures.figure, "expected"),
        ),
      )
      .orderBy(desc(payFigures.createdAt))
      .limit(1);
    out.expectedPay = Money.parse(
      fig && fig.createdAt >= expectedRow.createdAt
        ? {
            amount: Number(fig.amount),
            currency: fig.currency,
            basis: fig.payBasis,
            gross: fig.gross,
            paymentsPerYear: fig.paymentsPerYear,
            includes: fig.includes,
            saidAs: fig.saidAs ?? "",
            currencyAssumed: fig.currencyAssumed,
          }
        : {
            amount: Number(expectedRow.expectedCtc),
            currency: expectedRow.currency,
            basis: "annual",
            gross: true,
          },
    );
  }
  return out;
}

/**
 * Record pay figures as said, with what they come to in the role's pay currency
 * and the organisation's reporting currency (or why they could not be derived).
 * HR-only rows; named for the candidate so erasure cascades.
 */
export async function recordPayFigures(
  orgId: string,
  app: { id: string; candidateId: string; requisitionId: string },
  figures: { figure: "current_fixed" | "current_variable" | "expected"; money: Money }[],
  source: string,
  now = new Date(),
): Promise<void> {
  if (!figures.length) return;
  const [r] = await db
    .select()
    .from(requisitions)
    .where(and(eq(requisitions.id, app.requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!r) return;
  const ctx = await roleContext(orgId, r);
  const c = conventionsOf(ctx.terms, ctx.zone);
  for (const f of figures) {
    const pay = convert(
      f.money,
      { currency: ctx.terms.currency, basis: ctx.terms.basis },
      c,
      ctx.rates,
      now,
    );
    const rep = convert(
      f.money,
      { currency: ctx.reportingCurrency, basis: "annual" as PayBasis },
      c,
      ctx.rates,
      now,
    );
    await db.insert(payFigures).values({
      orgId,
      ownerType: "application",
      ownerId: app.id,
      figure: f.figure,
      amount: String(f.money.amount),
      currency: f.money.currency,
      payBasis: f.money.basis,
      gross: f.money.gross,
      paymentsPerYear: f.money.paymentsPerYear,
      includes: f.money.includes,
      saidAs: f.money.saidAs || null,
      currencyAssumed: f.money.currencyAssumed,
      source,
      payAmount: pay.ok ? String(pay.money.amount) : null,
      payCurrency: pay.ok ? pay.money.currency : null,
      reportingAmount: rep.ok ? String(rep.money.amount) : null,
      reportingCurrency: rep.ok ? rep.money.currency : null,
      rate:
        pay.ok && pay.rate
          ? { rate: pay.rate.rate, source: pay.rate.source, at: pay.rate.at }
          : null,
      refusal: pay.ok ? null : pay.refusal,
      candidateId: app.candidateId,
    });
  }
}
