/**
 * Organisation agreements: recording that an organisation accepted the
 * current Terms of Service, Privacy Policy and Data Processing Agreement
 * (src/lib/legal), and reading back what is still outstanding. Callers decide
 * who may accept (the creator at registration, the owner afterwards); every
 * query here is scoped to the organisation it is given.
 */
import { createHmac } from "node:crypto";
import { desc, eq } from "drizzle-orm";

import { orgAgreements, organizations } from "@db/schema";
import {
  AGREEMENT_KINDS,
  type AgreementKind,
  currentAgreementVersions,
  outstandingAgreements,
} from "@/lib/legal/agreements";
import type { AgreementAcceptance } from "@/lib/legal/acceptance";
import { writeAudit } from "./audit";
import { db } from "./db";

export type AgreementRecord = {
  kind: AgreementKind;
  version: string;
  acceptedAt: string;
  accepterName: string;
  accepterTitle: string;
  accepterEmail: string;
};

/**
 * The request IP as an HMAC — enough to show two acceptances came from the
 * same place, never the address itself. Null when the IP is unknown.
 */
export function hashIp(ip: string | null | undefined): string | null {
  const value = ip?.trim();
  if (!value || value === "unknown") return null;
  const secret = process.env["SESSION_SECRET"];
  if (!secret) return null;
  return createHmac("sha256", secret).update(`org-agreement-ip:${value}`).digest("hex");
}

/** Refuse versions that are not the current ones (the document changed after it was shown). */
export function assertCurrentVersions(
  versions: AgreementAcceptance["versions"],
  current: Record<AgreementKind, string> = currentAgreementVersions(),
): void {
  for (const kind of AGREEMENT_KINDS) {
    if (versions[kind] !== current[kind])
      throw new Error(
        "These documents were updated after you opened them. Reload the page, review the current versions and accept again.",
      );
  }
}

/**
 * Record the organisation's acceptance of every current document it has not
 * accepted yet, and audit it. Idempotent: a version already accepted is kept
 * as it was (first acceptance wins).
 */
export async function recordAgreementAcceptance(input: {
  orgId: string;
  userId: string;
  email: string;
  acceptance: AgreementAcceptance;
  ipHash: string | null;
  current?: Record<AgreementKind, string>;
}): Promise<{ recorded: AgreementKind[] }> {
  const current = input.current ?? currentAgreementVersions();
  assertCurrentVersions(input.acceptance.versions, current);
  const rows = await db
    .insert(orgAgreements)
    .values(
      AGREEMENT_KINDS.map((kind) => ({
        orgId: input.orgId,
        kind,
        version: current[kind],
        acceptedBy: input.userId,
        accepterName: input.acceptance.signatoryName.trim(),
        accepterTitle: input.acceptance.signatoryTitle.trim(),
        accepterEmail: input.email.toLowerCase(),
        ipHash: input.ipHash,
      })),
    )
    .onConflictDoNothing({
      target: [orgAgreements.orgId, orgAgreements.kind, orgAgreements.version],
    })
    .returning({ kind: orgAgreements.kind });
  const recorded = rows.map((r) => r.kind as AgreementKind);
  if (recorded.length) {
    await writeAudit({
      actor: input.email,
      actorUserId: input.userId,
      orgId: input.orgId,
      action: "org.agreement.accepted",
      entityType: "organization",
      entityId: input.orgId,
      detail: {
        documents: Object.fromEntries(recorded.map((k) => [k, current[k]])),
        signatoryTitle: input.acceptance.signatoryTitle.trim(),
      },
    });
  }
  return { recorded };
}

function toRecord(r: typeof orgAgreements.$inferSelect): AgreementRecord {
  return {
    kind: r.kind as AgreementKind,
    version: r.version,
    acceptedAt: r.acceptedAt.toISOString(),
    accepterName: r.accepterName,
    accepterTitle: r.accepterTitle,
    accepterEmail: r.accepterEmail,
  };
}

/** What this organisation has accepted (newest first) and which current documents are outstanding. */
export async function orgAgreementStatus(
  orgId: string,
  current: Record<AgreementKind, string> = currentAgreementVersions(),
): Promise<{ outstanding: AgreementKind[]; history: AgreementRecord[] }> {
  const rows = await db
    .select()
    .from(orgAgreements)
    .where(eq(orgAgreements.orgId, orgId))
    .orderBy(desc(orgAgreements.acceptedAt));
  return { outstanding: outstandingAgreements(rows, current), history: rows.map(toRecord) };
}

export type PlatformOrgAgreements = {
  orgId: string;
  name: string;
  status: string;
  outstanding: AgreementKind[];
  history: AgreementRecord[];
};

/** Platform view: every organisation with its acceptance history. Callers must be platform admins. */
export async function listAllOrgAgreements(
  current: Record<AgreementKind, string> = currentAgreementVersions(),
): Promise<PlatformOrgAgreements[]> {
  const [orgs, rows] = await Promise.all([
    db
      .select({ id: organizations.id, name: organizations.name, status: organizations.status })
      .from(organizations)
      .orderBy(organizations.name),
    db.select().from(orgAgreements).orderBy(desc(orgAgreements.acceptedAt)),
  ]);
  return orgs.map((o) => {
    const mine = rows.filter((r) => r.orgId === o.id);
    return {
      orgId: o.id,
      name: o.name,
      status: o.status,
      outstanding: outstandingAgreements(mine, current),
      history: mine.map(toRecord),
    };
  });
}
