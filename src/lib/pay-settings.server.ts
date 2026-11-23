/**
 * Pay conventions and exchange rates (docs/pay-terms-plan.md, Phase 2).
 *
 * - The organisation agent proposes conventions (`proposeConventionsCore`); the
 *   HR head (or an owner, or the CBO) approves (`decideConventionsCore`) and only
 *   then are they applied to pay_zones, pooling_regions and the organisation's
 *   defaults, in one transaction, audited.
 * - Exchange rates are entered by HR leadership or finance members, audited.
 * - A requisition's pay terms are set on a draft (or one sent back for changes).
 *
 * Every query carries the organisation predicate (AGENTS.md).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  exchangeRates,
  organizations,
  payConventionDrafts,
  payZones,
  poolingRegions,
  requisitions,
} from "../../drizzle/schema";
import { db } from "../server/db";
import { writeAudit } from "../server/audit";
import { PayConventions, conventionChanges, type PayConventionsInput } from "./pay-settings";
import { PayTerms, type ExchangeRate, type PayZone } from "./pay-terms";

export type PayActor = { orgId: string; userId: string; memberEmail: string };

/** Who decides pay conventions and enters rates. */
export const PAY_DECIDERS = ["hr_head", "president_cbo"] as const;

async function assertDecider(actor: PayActor): Promise<void> {
  const { assertRole } = await import("./auth.middleware");
  await assertRole(
    actor.userId,
    actor.orgId,
    [...PAY_DECIDERS],
    "Only the HR head, the CBO or an owner can decide pay conventions.",
  );
}

const num = (v: string | null): number | null => (v == null ? null : Number(v));

/** The conventions in force (from the organisation, its regions and zones). */
export async function currentConventions(orgId: string): Promise<PayConventions> {
  const [org] = await db
    .select({
      currency: organizations.currency,
      basis: organizations.payBasisDefault,
      hours: organizations.hoursPerWeekDefault,
      kinds: organizations.kindsOfWork,
      far: organizations.payFarAbovePct,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error("Organisation not found.");
  const regions = await db
    .select()
    .from(poolingRegions)
    .where(eq(poolingRegions.orgId, orgId))
    .orderBy(poolingRegions.name);
  const regionName = new Map(regions.map((r) => [r.id, r.name]));
  const zones = await db
    .select()
    .from(payZones)
    .where(eq(payZones.orgId, orgId))
    .orderBy(payZones.name);
  return PayConventions.parse({
    reportingCurrency: /^[A-Z]{3}$/.test(org.currency) ? org.currency : "INR",
    payBasisDefault: org.basis,
    hoursPerWeekDefault: Number(org.hours),
    kindsOfWork: org.kinds.length ? org.kinds : ["permanent"],
    farAbovePct: org.far,
    regions: regions.map((r) => ({ name: r.name, rule: r.defaultRule })),
    zones: zones.map((z) => ({
      name: z.name,
      countries: z.countries,
      cities: z.cities,
      currency: z.currency,
      basis: z.payBasis,
      paymentsPerYear: z.paymentsPerYear,
      includes: z.includes,
      hoursPerWeek: Number(z.hoursPerWeek),
      workingDaysPerYear: z.workingDaysPerYear,
      kinds: z.kinds,
      contractTypes: z.contractTypes,
      entity: z.entity,
      geoFactor: num(z.geoFactor),
      region: z.regionId ? (regionName.get(z.regionId) ?? null) : null,
    })),
  });
}

/** Zones as the converter takes them (ids included). */
export async function zonesOf(orgId: string): Promise<PayZone[]> {
  const rows = await db.select().from(payZones).where(eq(payZones.orgId, orgId));
  return rows.map((z) => ({
    id: z.id,
    name: z.name,
    countries: z.countries,
    cities: z.cities,
    currency: z.currency,
    basis: z.payBasis as PayZone["basis"],
    paymentsPerYear: z.paymentsPerYear,
    includes: z.includes as PayZone["includes"],
    hoursPerWeek: Number(z.hoursPerWeek),
    workingDaysPerYear: z.workingDaysPerYear,
    kinds: z.kinds as PayZone["kinds"],
    contractTypes: z.contractTypes,
    entity: z.entity,
    geoFactor: num(z.geoFactor),
  }));
}

/** The latest rate per pair (newest first per pair), for the converter. */
export async function ratesOf(orgId: string, limit = 200): Promise<ExchangeRate[]> {
  const rows = await db
    .select()
    .from(exchangeRates)
    .where(eq(exchangeRates.orgId, orgId))
    .orderBy(desc(exchangeRates.rateAt))
    .limit(limit);
  return rows.map((r) => ({
    from: r.fromCurrency,
    to: r.toCurrency,
    rate: Number(r.rate),
    source: r.source,
    at: r.rateAt.toISOString(),
  }));
}

/* ------------------------------------------------------------ proposals */

/**
 * The organisation agent's proposal: validated, compared with what is in force,
 * stored pending. An earlier pending proposal is superseded. Nothing is applied.
 */
export async function proposeConventionsCore(
  orgId: string,
  input: PayConventionsInput,
  opts: { agentRunId?: string | null; proposedBy?: string | null } = {},
): Promise<{ draftId: string; changes: string[] }> {
  const conventions = PayConventions.parse(input);
  const changes = conventionChanges(await currentConventions(orgId), conventions);
  if (!changes.length)
    throw new Error("Nothing would change — these are the conventions in force.");
  return db.transaction(async (tx) => {
    await tx
      .update(payConventionDrafts)
      .set({ status: "superseded" })
      .where(and(eq(payConventionDrafts.orgId, orgId), eq(payConventionDrafts.status, "pending")));
    const [row] = await tx
      .insert(payConventionDrafts)
      .values({
        orgId,
        conventions,
        summary: changes.join("\n"),
        agentRunId: opts.agentRunId ?? null,
        proposedBy: opts.proposedBy ?? null,
      })
      .returning({ id: payConventionDrafts.id });
    await writeAudit({
      actor: opts.agentRunId ? "agent:org_context" : "user",
      actorUserId: opts.proposedBy ?? null,
      orgId,
      action: "pay_conventions.proposed",
      entityType: "pay_convention_draft",
      entityId: row!.id,
      detail: { changes: changes.length, agentRunId: opts.agentRunId ?? null },
    });
    return { draftId: row!.id, changes };
  });
}

export async function pendingConventions(orgId: string, draftId: string) {
  const [d] = await db
    .select()
    .from(payConventionDrafts)
    .where(and(eq(payConventionDrafts.id, draftId), eq(payConventionDrafts.orgId, orgId)))
    .limit(1);
  return d ?? null;
}

/**
 * The HR head's decision. Approve applies the draft: regions and zones are
 * replaced by the draft's (by name; requisitions keep their zone when its name
 * stays), defaults updated — one transaction, audited.
 */
export async function decideConventionsCore(
  actor: PayActor,
  input: { draftId: string; decision: "approve" | "send_back" | "decline"; note?: string | null },
): Promise<{ status: string; changes: string[] }> {
  await assertDecider(actor);
  const draft = await pendingConventions(actor.orgId, input.draftId);
  if (!draft) throw new Error("Pay conventions proposal not found.");
  if (draft.status !== "pending")
    throw new Error(
      `This proposal is ${draft.status.replace("_", " ")}, not waiting for a decision.`,
    );
  const note = input.note?.trim() || null;
  if (input.decision !== "approve") {
    if (!note) throw new Error("Say what to change, or why it is declined.");
    const status = input.decision === "send_back" ? "sent_back" : "declined";
    await db
      .update(payConventionDrafts)
      .set({ status, decidedBy: actor.userId, decidedAt: new Date(), decisionNote: note })
      .where(and(eq(payConventionDrafts.id, draft.id), eq(payConventionDrafts.orgId, actor.orgId)));
    await writeAudit({
      actor: actor.memberEmail,
      actorUserId: actor.userId,
      orgId: actor.orgId,
      action: `pay_conventions.${status}`,
      entityType: "pay_convention_draft",
      entityId: draft.id,
      detail: { note },
    });
    return { status, changes: [] };
  }
  const c = PayConventions.parse(draft.conventions);
  const changes = await applyConventions(actor, c, { draftId: draft.id });
  await db
    .update(payConventionDrafts)
    .set({ status: "approved", decidedBy: actor.userId, decidedAt: new Date(), decisionNote: note })
    .where(and(eq(payConventionDrafts.id, draft.id), eq(payConventionDrafts.orgId, actor.orgId)));
  return { status: "approved", changes };
}

/** Apply conventions as a decider (approval above, or the settings page). Audited. */
export async function applyConventionsCore(
  actor: PayActor,
  input: PayConventionsInput,
): Promise<{ changes: string[] }> {
  await assertDecider(actor);
  return { changes: await applyConventions(actor, PayConventions.parse(input), {}) };
}

async function applyConventions(
  actor: PayActor,
  c: PayConventions,
  via: { draftId?: string },
): Promise<string[]> {
  const changes = conventionChanges(await currentConventions(actor.orgId), c);
  const orgId = actor.orgId;
  await db.transaction(async (tx) => {
    await tx
      .update(organizations)
      .set({
        currency: c.reportingCurrency,
        payBasisDefault: c.payBasisDefault,
        hoursPerWeekDefault: String(c.hoursPerWeekDefault),
        kindsOfWork: c.kindsOfWork,
        payFarAbovePct: c.farAbovePct,
      })
      .where(eq(organizations.id, orgId));

    // Regions by name: keep ids for names that stay.
    const oldRegions = await tx
      .select()
      .from(poolingRegions)
      .where(eq(poolingRegions.orgId, orgId));
    const regionId = new Map<string, string>();
    for (const r of c.regions) {
      const found = oldRegions.find((o) => o.name.toLowerCase() === r.name.toLowerCase());
      if (found) {
        await tx
          .update(poolingRegions)
          .set({ name: r.name, defaultRule: r.rule })
          .where(and(eq(poolingRegions.id, found.id), eq(poolingRegions.orgId, orgId)));
        regionId.set(r.name.toLowerCase(), found.id);
      } else {
        const [row] = await tx
          .insert(poolingRegions)
          .values({ orgId, name: r.name, defaultRule: r.rule })
          .returning({ id: poolingRegions.id });
        regionId.set(r.name.toLowerCase(), row!.id);
      }
    }

    // Zones by name: keep ids so requisitions keep their zone.
    const oldZones = await tx.select().from(payZones).where(eq(payZones.orgId, orgId));
    const kept = new Set<string>();
    for (const z of c.zones) {
      const values = {
        name: z.name,
        countries: z.countries,
        cities: z.cities,
        currency: z.currency,
        payBasis: z.basis,
        paymentsPerYear: z.paymentsPerYear,
        includes: z.includes,
        hoursPerWeek: String(z.hoursPerWeek),
        workingDaysPerYear: z.workingDaysPerYear,
        kinds: z.kinds,
        contractTypes: z.contractTypes,
        entity: z.entity,
        geoFactor: z.geoFactor != null ? String(z.geoFactor) : null,
        regionId: z.region ? (regionId.get(z.region.toLowerCase()) ?? null) : null,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      };
      const found = oldZones.find((o) => o.name.toLowerCase() === z.name.toLowerCase());
      if (found) {
        await tx
          .update(payZones)
          .set(values)
          .where(and(eq(payZones.id, found.id), eq(payZones.orgId, orgId)));
        kept.add(found.id);
      } else {
        await tx.insert(payZones).values({ orgId, ...values });
      }
    }
    const gone = oldZones.filter((o) => !kept.has(o.id)).map((o) => o.id);
    if (gone.length)
      await tx.delete(payZones).where(and(eq(payZones.orgId, orgId), inArray(payZones.id, gone)));
    const goneRegions = oldRegions
      .filter((o) => ![...regionId.values()].includes(o.id))
      .map((o) => o.id);
    if (goneRegions.length)
      await tx
        .delete(poolingRegions)
        .where(and(eq(poolingRegions.orgId, orgId), inArray(poolingRegions.id, goneRegions)));
  });
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId,
    action: "pay_conventions.applied",
    entityType: "organization",
    entityId: orgId,
    detail: { changes, draftId: via.draftId ?? null },
  });
  return changes;
}

/* ------------------------------------------------------------- rates */

export async function addExchangeRateCore(
  actor: PayActor,
  input: { from: string; to: string; rate: number; source: string; at?: Date },
): Promise<{ id: string }> {
  await assertDecider(actor);
  const from = input.from.toUpperCase();
  const to = input.to.toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || from === to)
    throw new Error("Give two different three-letter currency codes.");
  if (!(input.rate > 0) || !Number.isFinite(input.rate))
    throw new Error("The rate must be above zero.");
  const source = input.source.trim();
  if (source.length < 2) throw new Error("Say where the rate comes from.");
  const at = input.at ?? new Date();
  if (at.getTime() > Date.now() + 86_400_000)
    throw new Error("A rate cannot be dated in the future.");
  const [row] = await db
    .insert(exchangeRates)
    .values({
      orgId: actor.orgId,
      fromCurrency: from,
      toCurrency: to,
      rate: String(input.rate),
      source: source.slice(0, 120),
      rateAt: at,
      enteredBy: actor.userId,
    })
    .returning({ id: exchangeRates.id });
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: "exchange_rate.added",
    entityType: "exchange_rate",
    entityId: row!.id,
    detail: { from, to, rate: input.rate, source, at: at.toISOString() },
  });
  return { id: row!.id };
}

/* ------------------------------------------------------ requisition terms */

const EDITABLE = new Set(["draft"]);

/**
 * A requisition's pay terms, on a draft (or one sent back for changes). The pay
 * zone is found by name; when the zone is set and no currency is given, the
 * zone's currency and basis are used. Audited.
 */
export async function updateRequisitionPayTermsCore(
  actor: PayActor,
  input: {
    id: string;
    zone?: string | null;
    terms: Partial<import("./pay-terms").PayTerms>;
  },
): Promise<{ terms: import("./pay-terms").PayTerms; zone: string | null }> {
  const [r] = await db
    .select()
    .from(requisitions)
    .where(and(eq(requisitions.id, input.id), eq(requisitions.orgId, actor.orgId)))
    .limit(1);
  if (!r) throw new Error("Requisition not found.");
  if (!EDITABLE.has(r.status))
    throw new Error(
      "Pay terms change only on a draft (a requisition sent back for changes is a draft again).",
    );
  let zoneId: string | null = r.payZoneId;
  let zoneRow: typeof payZones.$inferSelect | null = null;
  if (input.zone !== undefined) {
    if (input.zone === null) zoneId = null;
    else {
      const all = await db.select().from(payZones).where(eq(payZones.orgId, actor.orgId));
      zoneRow = all.find((x) => x.name.toLowerCase() === input.zone!.trim().toLowerCase()) ?? null;
      if (!zoneRow)
        throw new Error(
          `No pay zone called “${input.zone}”. Zones: ${all.map((x) => x.name).join(", ") || "none yet"}.`,
        );
      zoneId = zoneRow.id;
    }
  }
  const t = input.terms;
  const terms = PayTerms.parse({
    kind: t.kind ?? r.kindOfWork,
    basis: t.basis ?? (zoneRow && !t.currency ? zoneRow.payBasis : r.payBasis),
    currency: (t.currency ?? (zoneRow ? zoneRow.currency : r.payCurrency)).toUpperCase(),
    hoursPerWeek: t.hoursPerWeek !== undefined ? t.hoursPerWeek : num(r.hoursPerWeek),
    daysPerWeek: t.daysPerWeek !== undefined ? t.daysPerWeek : num(r.daysPerWeek),
    contractMonths: t.contractMonths !== undefined ? t.contractMonths : r.contractMonths,
    extendable: t.extendable !== undefined ? t.extendable : r.extendable,
    neededBy: t.neededBy !== undefined ? t.neededBy : r.neededBy,
    contractType: t.contractType !== undefined ? t.contractType : r.contractType,
    paysByLocation: t.paysByLocation ?? r.paysByLocation,
  });
  if ((terms.kind === "fixed_term" || terms.kind === "contract_hourly") && !terms.contractMonths)
    throw new Error("A contract needs its length in months.");
  if (terms.neededBy && terms.neededBy < new Date().toISOString().slice(0, 10))
    throw new Error("The date the role is needed by is in the past.");
  if (zoneRow && zoneRow.kinds.length && !zoneRow.kinds.includes(terms.kind))
    throw new Error(
      `${zoneRow.name} does not hire ${terms.kind.replace(/_/g, " ")} (it hires: ${zoneRow.kinds.join(", ").replace(/_/g, " ")}).`,
    );
  await db
    .update(requisitions)
    .set({
      kindOfWork: terms.kind,
      payBasis: terms.basis,
      payCurrency: terms.currency,
      payZoneId: zoneId,
      hoursPerWeek: terms.hoursPerWeek != null ? String(terms.hoursPerWeek) : null,
      daysPerWeek: terms.daysPerWeek != null ? String(terms.daysPerWeek) : null,
      contractMonths: terms.contractMonths,
      extendable: terms.extendable,
      contractType: terms.contractType,
      paysByLocation: terms.paysByLocation,
      neededBy: terms.neededBy,
    })
    .where(and(eq(requisitions.id, r.id), eq(requisitions.orgId, actor.orgId)));
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: "requisition.pay_terms_set",
    entityType: "requisition",
    entityId: r.id,
    detail: { code: r.code, terms, zone: zoneRow?.name ?? null },
  });
  return { terms, zone: zoneRow?.name ?? null };
}
