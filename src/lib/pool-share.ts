/**
 * Which of a partner organisation's candidates a consortium share may show:
 * only CVs that may join a talent pool. A CV a portal limited to its role
 * (candidates.pool_use = 'role_only', migration 0045) never leaves the
 * organisation that received it — Naukri's terms forbid onward transfer and
 * Internshala's forbid sharing.
 */
import { and, eq, inArray } from "drizzle-orm";

import { candidates } from "@db/schema";

export function sharedFrom(ownerOrgIds: string[]) {
  return and(inArray(candidates.orgId, ownerOrgIds), eq(candidates.poolUse, "pool"));
}
