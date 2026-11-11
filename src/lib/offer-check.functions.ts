/**
 * The offer check on the Offers page (docs/labour-policy-agent-plan.md, L3).
 * Reading and running need an organisation member on the recruiting team;
 * overriding a "fix needed" needs the HR head (checked in the core, audited).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { assertRole, requireOrg } from "./auth.middleware";

const OfferRef = z.object({ offerId: z.string().uuid() });

export const getOfferCheck = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((d: unknown) => OfferRef.parse(d))
  .handler(async ({ data, context }) => {
    const { db } = await import("../server/db");
    const { offers } = await import("../../drizzle/schema");
    const [o] = await db
      .select({ check: offers.policyCheck, override: offers.policyOverride })
      .from(offers)
      .where(and(eq(offers.id, data.offerId), eq(offers.orgId, context.orgId)))
      .limit(1);
    if (!o) throw new Error("Offer not found.");
    const { currentCheckKey } = await import("./offer-check.server");
    const key = await currentCheckKey(context.orgId, data.offerId);
    const canOverride = await assertRole(context.userId, context.orgId, "hr_head")
      .then(() => true)
      .catch(() => false);
    return {
      check: o.check,
      stale: Boolean(o.check && o.check.key !== key),
      override: o.override && o.override.checkKey === key ? o.override : null,
      canOverride,
    };
  });

export const runOfferCheck = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => OfferRef.parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      ["recruiter", "hr_head", "president_cbo"],
      "Only the recruiting team can run the offer check.",
    );
    const { runOfferCheckCore } = await import("./offer-check.server");
    return runOfferCheckCore(context.orgId, data.offerId, { actor: context.memberEmail });
  });

export const overrideOfferCheck = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    OfferRef.extend({ reason: z.string().trim().min(10).max(1000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { overrideOfferCheckCore } = await import("./offer-check.server");
    await overrideOfferCheckCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      data,
    );
    return { ok: true };
  });
