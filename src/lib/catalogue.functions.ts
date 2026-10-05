import { createServerFn } from "@tanstack/react-start";
import { ilike } from "drizzle-orm";
import { z } from "zod";

import { requireIdentity } from "@/lib/auth.middleware";
import { db } from "../server/db";
import { platformAdmins, productCatalogueCommercials } from "@db/schema";
import { CATALOGUE_MODULES, type CatalogueModule } from "@/lib/product-catalogue";

/**
 * Product catalogue, for the product owner (super admin) only. Module and capability content
 * lives in code so the catalogue is always current with the shipped product; the commercial
 * layer (tier, list price, unit, notes) is editable and stored in the database.
 */

async function requireSuperUser(context: { claims?: Record<string, unknown> | null }) {
  const raw = (context.claims?.["email"] as string | undefined) ?? null;
  const email = raw ? raw.toLowerCase() : null;
  if (!email) throw new Error("Your account has no email address.");
  const [row] = await db
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(ilike(platformAdmins.email, email))
    .limit(1);
  if (!row) throw new Error("Super-user access only.");
  return email;
}

export type CatalogueCommercials = {
  moduleId: string;
  tier: string;
  listPrice: number | null;
  currency: string;
  unit: string;
  notes: string;
  updatedAt: string | null;
};

export type CatalogueRow = CatalogueModule & { commercials: CatalogueCommercials };

export type CatalogueResult = {
  generatedAt: string;
  modules: CatalogueRow[];
};

/** The live catalogue: shipped modules merged with their saved commercial terms. */
export const readCatalogue = createServerFn({ method: "GET" })
  .middleware([requireIdentity])
  .handler(async ({ context }): Promise<CatalogueResult> => {
    await requireSuperUser(context);
    const saved = new Map(
      (await db.select({ row: productCatalogueCommercials }).from(productCatalogueCommercials)).map(
        ({ row }) => [row.moduleId, row],
      ),
    );
    return {
      generatedAt: new Date().toISOString(),
      modules: CATALOGUE_MODULES.map((m) => {
        const s = saved.get(m.id);
        return {
          ...m,
          commercials: {
            moduleId: m.id,
            tier: s?.tier ?? m.defaultTier,
            listPrice:
              s?.listPrice === null || s?.listPrice === undefined ? null : Number(s.listPrice),
            currency: s?.currency ?? "USD",
            unit: s?.unit ?? "per user / month",
            notes: s?.notes ?? "",
            updatedAt: s?.updatedAt ? s.updatedAt.toISOString() : null,
          },
        };
      }),
    };
  });

/** Save the commercial terms for one module. */
export const saveCatalogueCommercials = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        moduleId: z.string().min(1),
        tier: z.string().min(1).max(40),
        listPrice: z.number().nonnegative().nullable(),
        currency: z.string().min(1).max(8),
        unit: z.string().max(60),
        notes: z.string().max(600),
      })
      .parse(d),
  )
  .middleware([requireIdentity])
  .handler(async ({ data, context }) => {
    await requireSuperUser(context);
    if (!CATALOGUE_MODULES.some((m) => m.id === data.moduleId)) throw new Error("Unknown module.");
    await db
      .insert(productCatalogueCommercials)
      .values({
        moduleId: data.moduleId,
        tier: data.tier,
        listPrice: data.listPrice === null ? null : String(data.listPrice),
        currency: data.currency,
        unit: data.unit,
        notes: data.notes,
        updatedBy: context.userId,
      })
      .onConflictDoUpdate({
        target: productCatalogueCommercials.moduleId,
        set: {
          tier: data.tier,
          listPrice: data.listPrice === null ? null : String(data.listPrice),
          currency: data.currency,
          unit: data.unit,
          notes: data.notes,
          updatedBy: context.userId,
          updatedAt: new Date(),
        },
      });
    return { ok: true };
  });
