/**
 * How the organisation reaches people in its talent pool beyond an
 * application they are in: invitations to apply (role_invite) and the notice
 * that a pool match is being considered for a role (pool_match_intro).
 *
 * - Every such email carries a signed opt-out link (/api/public/contact-preferences).
 *   Opting out stops pool matching, invitations and introductions; mail about an
 *   application already in progress still goes.
 * - OUTREACH.gapDays: one outreach email per person per window, across all roles,
 *   so several starving roles cannot each email the same person in one week.
 *
 * Server-only.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "../server/db";
import { candidates, emailOutbox, organizations } from "@db/schema";
import { writeAudit } from "../server/audit";
import { env } from "../server/env";

export const OUTREACH = {
  /** At most one invitation or introduction per person in this many days, any role. */
  gapDays: 14,
} as const;

export const OUTREACH_KINDS = ["role_invite", "pool_match_intro"] as const;

function sign(candidateId: string): string {
  const secret = process.env["SESSION_SECRET"];
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return createHmac("sha256", secret).update(`contact-opt-out:${candidateId}`).digest("base64url");
}

/** Token for one person's opt-out link; never expires (the link must keep working). */
export function optOutToken(candidateId: string): string {
  return `${candidateId}.${sign(candidateId)}`;
}

export function optOutUrl(candidateId: string): string {
  return `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/api/public/contact-preferences?t=${encodeURIComponent(optOutToken(candidateId))}`;
}

/** The candidate id a token names, or null when the signature does not match. */
export function verifyOptOutToken(token: string): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(id));
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

export async function candidateForToken(token: string) {
  const id = verifyOptOutToken(token);
  if (!id) return null;
  const [row] = await db
    .select({
      id: candidates.id,
      orgId: candidates.orgId,
      optedOutAt: candidates.contactOptOutAt,
      orgName: organizations.name,
    })
    .from(candidates)
    .innerJoin(organizations, eq(organizations.id, candidates.orgId))
    .where(eq(candidates.id, id))
    .limit(1);
  return row ?? null;
}

/** Records the opt-out (idempotent). Returns the organisation's name, or null for a bad token. */
export async function recordOptOut(token: string): Promise<string | null> {
  const c = await candidateForToken(token);
  if (!c?.orgId) return null;
  const orgId = c.orgId;
  if (!c.optedOutAt) {
    await db
      .update(candidates)
      .set({ contactOptOutAt: new Date() })
      .where(and(eq(candidates.id, c.id), eq(candidates.orgId, orgId)));
    // Anything not yet sent stops too.
    await db
      .update(emailOutbox)
      .set({ status: "suppressed", lastError: "recipient opted out" })
      .where(
        and(
          eq(emailOutbox.orgId, orgId),
          inArray(emailOutbox.kind, [...OUTREACH_KINDS]),
          inArray(emailOutbox.status, ["queued", "held"]),
          sql`split_part(${emailOutbox.idempotencyKey}, ':', 3) = ${c.id}`,
        ),
      );
    await writeAudit({
      actor: "candidate:self",
      orgId,
      action: "candidate.contact_opt_out",
      entityType: "candidate",
      entityId: c.id,
      detail: {},
    });
  }
  return c.orgName;
}

/** Of these people, the ones who opted out of role emails. */
export async function optedOut(orgId: string, candidateIds: string[]): Promise<Set<string>> {
  if (!candidateIds.length) return new Set();
  const rows = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(
      and(
        eq(candidates.orgId, orgId),
        inArray(candidates.id, candidateIds),
        isNotNull(candidates.contactOptOutAt),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * Of these people, the ones sent an invitation or introduction for any role in
 * the last OUTREACH.gapDays. Outreach idempotency keys are
 * `<kind>:<requisitionId>:<candidateId>[:…]`.
 */
export async function recentlyContacted(
  orgId: string,
  candidateIds: string[],
): Promise<Set<string>> {
  if (!candidateIds.length) return new Set();
  const rows = await db
    .select({ id: sql<string>`split_part(${emailOutbox.idempotencyKey}, ':', 3)` })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.orgId, orgId),
        inArray(emailOutbox.kind, [...OUTREACH_KINDS]),
        inArray(emailOutbox.status, ["queued", "held", "sent"]),
        gte(emailOutbox.createdAt, new Date(Date.now() - OUTREACH.gapDays * 864e5)),
        sql`split_part(${emailOutbox.idempotencyKey}, ':', 3) in (${sql.join(
          candidateIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );
  return new Set(rows.map((r) => r.id));
}
