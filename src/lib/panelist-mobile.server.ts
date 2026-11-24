/**
 * Panel members add their own mobile (migration 0093) so the AI assistant can
 * phone them when they have not answered an interview time (the panel time
 * check, 0092). Each panellist has one private link, /panel-mobile/<token>:
 * the token is derived (HMAC of the server secret and the panellist), only its
 * SHA-256 is stored, and it opens that one form — their name, the
 * organisation, the last four digits on file. Saving is audited as the
 * panellist; they may also say "no AI calls".
 *
 * Asking is part of the process, not a one-off: an active panellist with no
 * mobile is e-mailed the link at most twice, 14 days apart (the agent tick, in
 * organisations that use the panel time check), and every interviewer brief
 * carries the link until a number is saved.
 */
import { createHash, createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { organizations, panelists } from "@db/schema";
import { db } from "../server/db";

export const MOBILE_ASK = { maxAsks: 2, everyDays: 14 } as const;

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** The panellist's private link token (stable; stored as a hash). */
export async function mobileToken(orgId: string, panelistId: string): Promise<string> {
  const { env } = await import("../server/env");
  const token = createHmac("sha256", `panel-mobile:${env.SESSION_SECRET}`)
    .update(`${orgId}:${panelistId}`)
    .digest("hex");
  await db
    .update(panelists)
    .set({ mobileTokenHash: hash(token) })
    .where(and(eq(panelists.id, panelistId), eq(panelists.orgId, orgId)));
  return token;
}

export async function mobileUrl(orgId: string, panelistId: string): Promise<string> {
  const { env } = await import("../server/env");
  return `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/panel-mobile/${await mobileToken(orgId, panelistId)}`;
}

async function byToken(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const [r] = await db
    .select({ p: panelists, orgName: organizations.name })
    .from(panelists)
    .innerJoin(organizations, eq(organizations.id, panelists.orgId))
    .where(and(eq(panelists.mobileTokenHash, hash(token)), eq(panelists.active, true)))
    .limit(1);
  return r ?? null;
}

export type PublicMobileAsk = {
  firstName: string;
  orgName: string;
  phoneLast4: string | null;
  aiCalls: boolean;
};

export async function publicMobileAsk(token: string): Promise<PublicMobileAsk | null> {
  const r = await byToken(token);
  if (!r) return null;
  return {
    firstName: r.p.fullName.trim().split(/\s+/)[0] ?? r.p.fullName,
    orgName: r.orgName,
    phoneLast4: r.p.phone ? r.p.phone.replace(/\D/g, "").slice(-4) || null : null,
    aiCalls: !r.p.aiCallOptOutAt,
  };
}

/** The panellist saves their mobile (or says no AI calls). Audited as them. */
export async function saveMobileByLink(
  token: string,
  input: { phone: string | null; aiCalls: boolean },
): Promise<{ ok: true; phoneLast4: string | null } | { ok: false; error: string }> {
  const r = await byToken(token);
  if (!r) return { ok: false, error: "This link is not valid." };
  const { dialNumber } = await import("../server/voice/phone");
  const clean = input.phone?.trim() || null;
  const n = clean ? dialNumber(clean) : null;
  if (clean && !n)
    return { ok: false, error: "Enter an Indian mobile number (10 digits, optionally +91)." };
  const now = new Date();
  await db
    .update(panelists)
    .set({
      phone: clean,
      aiCallOptOutAt: input.aiCalls ? null : (r.p.aiCallOptOutAt ?? now),
      updatedAt: now,
    })
    .where(and(eq(panelists.id, r.p.id), eq(panelists.orgId, r.p.orgId)));
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `panelist:${r.p.email}`,
    orgId: r.p.orgId,
    action: "panelist.phone_set",
    entityType: "panelist",
    entityId: r.p.id,
    detail: { last4: n?.last4 ?? null, removed: !n, self: true, aiCalls: input.aiCalls },
  });
  return { ok: true, phoneLast4: n?.last4 ?? null };
}

/** Whether an ask is due (pure): never answered, under the cap, spaced out. */
export function askDue(
  p: {
    phone: string | null;
    aiCallOptOutAt: Date | null;
    phoneAskCount: number;
    phoneAskedAt: Date | null;
  },
  now: number,
): boolean {
  if (p.phone || p.aiCallOptOutAt) return false;
  if (p.phoneAskCount >= MOBILE_ASK.maxAsks) return false;
  return !p.phoneAskedAt || now - p.phoneAskedAt.getTime() >= MOBILE_ASK.everyDays * 864e5;
}

/** E-mail one panellist their link (counts as an ask). */
export async function askForMobile(
  orgId: string,
  panelistId: string,
  now = Date.now(),
): Promise<boolean> {
  const [p] = await db
    .select({ p: panelists, orgName: organizations.name })
    .from(panelists)
    .innerJoin(organizations, eq(organizations.id, panelists.orgId))
    .where(
      and(eq(panelists.id, panelistId), eq(panelists.orgId, orgId), eq(panelists.active, true)),
    )
    .limit(1);
  if (!p || !askDue(p.p, now)) return false;
  const [claimed] = await db
    .update(panelists)
    .set({ phoneAskedAt: new Date(now), phoneAskCount: sql`${panelists.phoneAskCount} + 1` })
    .where(and(eq(panelists.id, panelistId), eq(panelists.phoneAskCount, p.p.phoneAskCount)))
    .returning({ n: panelists.phoneAskCount });
  if (!claimed) return false;
  const { enqueueEmail } = await import("./email-outbox.server");
  await enqueueEmail({
    orgId,
    kind: "panel_mobile_ask",
    templateName: "panel_mobile_ask",
    toEmail: p.p.email,
    idempotencyKey: `panel-mobile-ask:${panelistId}:${claimed.n}`,
    templateData: {
      firstName: p.p.fullName.trim().split(/\s+/)[0] ?? p.p.fullName,
      orgName: p.orgName,
      actionUrl: await mobileUrl(orgId, panelistId),
      again: claimed.n > 1 ? "yes" : undefined,
    },
  });
  return true;
}

/**
 * Run by the agent tick: in organisations that use the panel time check, ask
 * every active panellist with no mobile (at most twice, 14 days apart).
 */
export async function sweepMobileAsks(orgId?: string, now = Date.now()): Promise<number> {
  const rows = await db
    .select({ id: panelists.id, orgId: panelists.orgId })
    .from(panelists)
    .where(
      and(
        orgId ? eq(panelists.orgId, orgId) : sql`true`,
        eq(panelists.active, true),
        sql`${panelists.phone} is null`,
        sql`${panelists.aiCallOptOutAt} is null`,
        sql`${panelists.phoneAskCount} < ${MOBILE_ASK.maxAsks}`,
        sql`(${panelists.phoneAskedAt} is null or ${panelists.phoneAskedAt} <= ${new Date(now - MOBILE_ASK.everyDays * 864e5).toISOString()}::timestamptz)`,
        sql`exists (select 1 from agent_policies a where a.org_id = ${panelists.orgId}
          and a.agent_type = 'panel_check_call' and a.enabled)`,
      ),
    )
    .limit(100);
  let asked = 0;
  for (const r of rows) if (await askForMobile(r.orgId, r.id, now).catch(() => false)) asked++;
  return asked;
}
