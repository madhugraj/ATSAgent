/**
 * An organisation's e-mail branding, for rendering: its brand colour and logo
 * bytes (sent inline as a cid: attachment, so no public logo URL exists).
 * Cached briefly per org; a missing or unreadable logo falls back to a
 * monogram. Server-only.
 */
import { eq } from "drizzle-orm";

import { db } from "./db";
import { getObject } from "./storage";
import { log } from "./log";
import { organizations } from "@db/schema";

export const DEFAULT_BRAND_COLOR = "#4f46e5";
export const BRAND_LOGO_CID = "org-logo";
const MAX_LOGO_BYTES = 1_100_000;
const TTL_MS = 5 * 60_000;

export type EmailBrand = {
  orgName: string;
  color: string;
  logo: { bytes: Uint8Array; contentType: string } | null;
};

const cache = new Map<string, { at: number; brand: EmailBrand }>();

export function clearEmailBrandCache(orgId: string): void {
  cache.delete(orgId);
}

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

export async function loadEmailBrand(orgId: string): Promise<EmailBrand | null> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.brand;
  const [org] = await db
    .select({
      name: organizations.name,
      color: organizations.brandColor,
      logoPath: organizations.brandLogoPath,
      logoType: organizations.brandLogoContentType,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return null;
  let logo: EmailBrand["logo"] = null;
  if (org.logoPath && org.logoPath.startsWith(`${orgId}/branding/`)) {
    try {
      const f = await getObject(org.logoPath);
      if (f && f.bytes.byteLength <= MAX_LOGO_BYTES)
        logo = { bytes: f.bytes, contentType: org.logoType || f.contentType || "image/png" };
    } catch (e) {
      log.warn("email.brand.logo_unreadable", { org_id: orgId, error: e as Error });
    }
  }
  const brand: EmailBrand = {
    orgName: org.name,
    color: isHexColor(org.color) ? org.color : DEFAULT_BRAND_COLOR,
    logo,
  };
  cache.set(orgId, { at: Date.now(), brand });
  return brand;
}
