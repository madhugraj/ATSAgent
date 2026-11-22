/**
 * E-mail branding for the organisation (Organisation → E-mail branding): the
 * logo and brand colour every e-mail the organisation sends is themed with.
 * Read: any member. Change: owner, HR heads and CBOs (as other governance
 * settings on that page); audited.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { organizations, userRoles } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { deleteObject, getObject, isStorageConfigured, putObject } from "../server/storage";
import { writeAudit } from "../server/audit";

const LOGO_TYPES = ["image/png", "image/jpeg"] as const;
const MAX_LOGO_BASE64 = 1_400_000; // ≈1 MB decoded

async function brandRow(orgId: string) {
  const [row] = await db
    .select({
      name: organizations.name,
      color: organizations.brandColor,
      logoPath: organizations.brandLogoPath,
      logoType: organizations.brandLogoContentType,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) throw new Error("Organisation not found");
  return row;
}

/** Owner, HR head or CBO of the caller's own org. */
async function assertBrandEditor(ctx: { userId: string; orgId: string; isOwner?: boolean }) {
  if (ctx.isOwner) return;
  const [row] = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.orgId, ctx.orgId),
        eq(userRoles.userId, ctx.userId),
        inArray(userRoles.role, ["hr_head", "president_cbo"]),
      ),
    )
    .limit(1);
  if (!row) throw new Error("Only the owner, an HR head or a CBO can change e-mail branding.");
}

async function forget(orgId: string) {
  const { clearEmailBrandCache } = await import("../server/email-brand.server");
  clearEmailBrandCache(orgId);
}

export const getEmailBrand = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const row = await brandRow(context.orgId);
    let logo: { base64: string; contentType: string } | null = null;
    if (row.logoPath?.startsWith(`${context.orgId}/branding/`)) {
      const f = await getObject(row.logoPath).catch(() => null);
      if (f)
        logo = {
          base64: Buffer.from(f.bytes).toString("base64"),
          contentType: row.logoType || f.contentType,
        };
    }
    return { orgName: row.name, color: row.color, logo, storage: isStorageConfigured() };
  });

export const setEmailBrandColor = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    z
      .object({
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertBrandEditor(context);
    await db
      .update(organizations)
      .set({ brandColor: data.color?.toLowerCase() ?? null })
      .where(eq(organizations.id, context.orgId));
    await forget(context.orgId);
    await writeAudit({
      actor: (context.claims?.["email"] as string | undefined) ?? "member",
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "org.email_brand.color",
      entityType: "organization",
      entityId: context.orgId,
      detail: { color: data.color },
    });
    return { ok: true as const };
  });

export const uploadEmailBrandLogo = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    z
      .object({
        base64: z.string().min(1).max(MAX_LOGO_BASE64),
        contentType: z.enum(LOGO_TYPES),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertBrandEditor(context);
    if (!isStorageConfigured())
      throw new Error("File storage is not configured on this deployment.");
    const bytes = Buffer.from(data.base64, "base64");
    const png = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const jpg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    if (!(data.contentType === "image/png" ? png : jpg))
      throw new Error("That file is not a PNG or JPEG image.");
    const row = await brandRow(context.orgId);
    const key = `${context.orgId}/branding/email-logo-${Date.now()}`;
    await putObject(key, new Uint8Array(bytes), data.contentType);
    await db
      .update(organizations)
      .set({ brandLogoPath: key, brandLogoContentType: data.contentType })
      .where(eq(organizations.id, context.orgId));
    if (row.logoPath && row.logoPath !== key) await deleteObject(row.logoPath).catch(() => {});
    await forget(context.orgId);
    await writeAudit({
      actor: (context.claims?.["email"] as string | undefined) ?? "member",
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "org.email_brand.logo",
      entityType: "organization",
      entityId: context.orgId,
      detail: { bytes: bytes.byteLength, contentType: data.contentType },
    });
    return { ok: true as const };
  });

export const removeEmailBrandLogo = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    await assertBrandEditor(context);
    const row = await brandRow(context.orgId);
    await db
      .update(organizations)
      .set({ brandLogoPath: null, brandLogoContentType: null })
      .where(eq(organizations.id, context.orgId));
    if (row.logoPath) await deleteObject(row.logoPath).catch(() => {});
    await forget(context.orgId);
    await writeAudit({
      actor: (context.claims?.["email"] as string | undefined) ?? "member",
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "org.email_brand.logo_removed",
      entityType: "organization",
      entityId: context.orgId,
    });
    return { ok: true as const };
  });
