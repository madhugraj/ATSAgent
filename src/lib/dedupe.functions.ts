/**
 * Talent-pool hygiene write paths (the server twin of the pure helpers in
 * dedupe.ts): merge duplicate candidate rows into a survivor, re-pointing
 * applications and child records, all scoped to the caller's verified
 * organisation. An id from another tenant simply does not match the org
 * predicate, so cross-org merges and deletions are impossible.
 */
import { and, eq, inArray } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import {
  applications,
  candidateAssessments,
  candidateVerifications,
  candidates,
  socialProfiles,
} from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { requireCapability } from "./capabilities.server";

type CandRow = typeof candidates.$inferSelect;

const isBlank = (v: unknown) =>
  v === null ||
  v === undefined ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "number" && v === 0);

/**
 * Merge duplicates into one record through the reversible identity core
 * (plan row 1): each duplicate is tombstoned (not deleted) into the survivor,
 * every moved or deleted child is snapshotted, and each merge is audited and
 * undoable from the merge review queue. Sequential so each duplicate's merge
 * is a separate undoable step; applications the survivor already holds for the
 * same requisition are removed as true duplicates and restored on undo.
 */
export const mergeCandidatesFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.pool")])
  .validator((data: unknown) =>
    z
      .object({
        survivorId: z.string().uuid(),
        dupeIds: z.array(z.string().uuid()).min(1).max(100),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const rows = await db
      .select()
      .from(candidates)
      .where(
        and(
          inArray(candidates.id, [data.survivorId, ...data.dupeIds]),
          eq(candidates.orgId, context.orgId),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (!byId.get(data.survivorId))
      throw new Error("Survivor candidate not found in your organisation.");
    const others = data.dupeIds.filter((id) => byId.has(id) && id !== data.survivorId);
    if (others.length === 0) return { merged: 0, movedApplications: 0 };

    const { mergeCandidatesCore } = await import("../server/candidates/identity.server");
    let movedApplications = 0;
    for (const id of others) {
      const result = await mergeCandidatesCore({
        orgId: context.orgId,
        survivorId: data.survivorId,
        mergedId: id,
        actor: { userId: context.userId, email: context.memberEmail },
      });
      movedApplications += result.movedChildren;
    }
    return { merged: others.length, movedApplications };
  });
