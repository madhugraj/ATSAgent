/**
 * Roles run from the hiring desk: a hiring thread is linked to the
 * requisition. On these the person picks who is screened (desk "screen these"),
 * so nothing automatic shortlists — the scorer ranks and records, the pick is
 * the decision (no shortlist event, no "you're shortlisted" e-mail).
 */
import { and, eq, inArray } from "drizzle-orm";

import { hiringConversations } from "@db/schema";
import { db } from "../server/db";

export async function deskRequisitions(
  orgId: string,
  requisitionIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(requisitionIds.filter(Boolean))];
  if (!ids.length) return new Set();
  const rows = await db
    .select({ id: hiringConversations.requisitionId })
    .from(hiringConversations)
    .where(
      and(
        eq(hiringConversations.orgId, orgId),
        eq(hiringConversations.kind, "hiring"),
        inArray(hiringConversations.requisitionId, ids),
      ),
    );
  return new Set(rows.map((r) => r.id).filter((x): x is string => Boolean(x)));
}
