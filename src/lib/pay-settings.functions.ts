/**
 * Pay conventions and a requisition's pay terms (docs/pay-terms-plan.md, Phase 2).
 * Reading needs an organisation member; changing conventions and entering rates
 * needs the HR head, the CBO or an owner (checked in the core); pay terms are set
 * on drafts. Every change is audited in the core.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { requireOrg } from "./auth.middleware";
import { PayConventions } from "./pay-settings";
import { KINDS_OF_WORK, PAY_BASES } from "./pay-terms";

const actorOf = (c: { orgId: string; userId: string; memberEmail: string }) => ({
  orgId: c.orgId,
  userId: c.userId,
  memberEmail: c.memberEmail,
});

/** The conventions in force, the proposal waiting for a decision, the latest rates. */
export const getPaySettings = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { db } = await import("../server/db");
    const { payConventionDrafts, exchangeRates } = await import("../../drizzle/schema");
    const { currentConventions } = await import("./pay-settings.server");
    const { assertRole } = await import("./auth.middleware");
    const canDecide = await assertRole(context.userId, context.orgId, ["hr_head", "president_cbo"])
      .then(() => true)
      .catch(() => false);
    const [pending] = await db
      .select({
        id: payConventionDrafts.id,
        summary: payConventionDrafts.summary,
        createdAt: payConventionDrafts.createdAt,
      })
      .from(payConventionDrafts)
      .where(
        and(
          eq(payConventionDrafts.orgId, context.orgId),
          eq(payConventionDrafts.status, "pending"),
        ),
      )
      .limit(1);
    const rates = await db
      .select({
        id: exchangeRates.id,
        from: exchangeRates.fromCurrency,
        to: exchangeRates.toCurrency,
        rate: exchangeRates.rate,
        source: exchangeRates.source,
        at: exchangeRates.rateAt,
      })
      .from(exchangeRates)
      .where(eq(exchangeRates.orgId, context.orgId))
      .orderBy(desc(exchangeRates.rateAt))
      .limit(20);
    return {
      conventions: await currentConventions(context.orgId),
      pending: pending
        ? {
            id: pending.id,
            changes: pending.summary.split("\n"),
            at: pending.createdAt.toISOString(),
          }
        : null,
      rates: rates.map((r) => ({ ...r, rate: Number(r.rate), at: r.at.toISOString() })),
      canDecide,
    };
  });

/** Apply conventions directly (HR head, CBO or owner) — the settings page path. */
export const savePayConventions = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => PayConventions.parse(d))
  .handler(async ({ data, context }) => {
    const { applyConventionsCore } = await import("./pay-settings.server");
    return applyConventionsCore(actorOf(context), data);
  });

export const addExchangeRate = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    z
      .object({
        from: z.string().regex(/^[A-Za-z]{3}$/),
        to: z.string().regex(/^[A-Za-z]{3}$/),
        rate: z.number().positive(),
        source: z.string().trim().min(2).max(120),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { addExchangeRateCore } = await import("./pay-settings.server");
    return addExchangeRateCore(actorOf(context), data);
  });

/** A requisition's pay terms and the zones it may use. */
export const getRequisitionPayTerms = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { db } = await import("../server/db");
    const { requisitions, payZones } = await import("../../drizzle/schema");
    const [r] = await db
      .select()
      .from(requisitions)
      .where(and(eq(requisitions.id, data.id), eq(requisitions.orgId, context.orgId)))
      .limit(1);
    if (!r) throw new Error("Requisition not found.");
    const zones = await db
      .select({
        id: payZones.id,
        name: payZones.name,
        currency: payZones.currency,
        basis: payZones.payBasis,
        kinds: payZones.kinds,
      })
      .from(payZones)
      .where(eq(payZones.orgId, context.orgId))
      .orderBy(payZones.name);
    return {
      status: r.status,
      zone: zones.find((z) => z.id === r.payZoneId)?.name ?? null,
      zones,
      terms: {
        kind: r.kindOfWork,
        basis: r.payBasis,
        currency: r.payCurrency,
        hoursPerWeek: r.hoursPerWeek != null ? Number(r.hoursPerWeek) : null,
        contractMonths: r.contractMonths,
        extendable: r.extendable,
        contractType: r.contractType,
        paysByLocation: r.paysByLocation,
        neededBy: r.neededBy,
      },
    };
  });

export const setRequisitionPayTerms = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        zone: z.string().max(60).nullable(),
        kind: z.enum(KINDS_OF_WORK),
        basis: z.enum(PAY_BASES),
        currency: z.string().regex(/^[A-Za-z]{3}$/),
        hoursPerWeek: z.number().min(1).max(80).nullable(),
        contractMonths: z.number().int().min(1).max(120).nullable(),
        extendable: z.boolean().nullable(),
        neededBy: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { updateRequisitionPayTermsCore } = await import("./pay-settings.server");
    const { id, zone, currency, ...rest } = data;
    return updateRequisitionPayTermsCore(actorOf(context), {
      id,
      zone,
      terms: { ...rest, currency: currency.toUpperCase() },
    });
  });
