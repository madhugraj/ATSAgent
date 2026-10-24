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

type CandRow = typeof candidates.$inferSelect;
type CandInsert = typeof candidates.$inferInsert;

const isBlank = (v: unknown) =>
  v === null ||
  v === undefined ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "number" && v === 0);

/**
 * Field-level merge that never loses information: the survivor keeps everything
 * it already has and only fills its blanks from the duplicates. Skills are
 * unioned and the longest resume text wins. Identity/audit columns (id,
 * createdAt, orgId) are never taken from a duplicate.
 */
function mergeCandidateFields(survivor: CandRow, dupes: CandRow[]): CandInsert {
  const patch: Record<string, unknown> = {};
  const skills = new Set((survivor.skills ?? []).map((s) => s.trim()).filter(Boolean));
  let resume = survivor.resumeText ?? "";

  for (const d of dupes) {
    for (const [key, value] of Object.entries(d)) {
      if (
        key === "id" ||
        key === "createdAt" ||
        key === "orgId" ||
        key === "skills" ||
        key === "resumeText"
      )
        continue;
      const current = patch[key] ?? (survivor as unknown as Record<string, unknown>)[key];
      if (isBlank(current) && !isBlank(value)) patch[key] = value;
    }
    for (const s of d.skills ?? []) if (s.trim()) skills.add(s.trim());
    if ((d.resumeText ?? "").length > resume.length) resume = d.resumeText ?? "";
  }

  if (skills.size !== (survivor.skills ?? []).length) patch["skills"] = [...skills];
  if (resume !== (survivor.resumeText ?? "")) patch["resumeText"] = resume;
  return patch as CandInsert;
}

/**
 * Merge duplicates into one record: fill blanks, re-point applications and all
 * child records at the survivor, then delete the emptied duplicates. Nothing is
 * dropped silently — applications that already exist on the survivor for the
 * same requisition are removed as true duplicates.
 */
export const mergeCandidatesFn = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
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
    const survivor = byId.get(data.survivorId);
    if (!survivor) throw new Error("Survivor candidate not found in your organisation.");
    const others = data.dupeIds
      .map((id) => byId.get(id))
      .filter((r): r is CandRow => r !== undefined);
    if (others.length === 0) return { merged: 0, movedApplications: 0 };

    const patch = mergeCandidateFields(survivor, others);
    if (Object.keys(patch).length > 0) {
      await db.update(candidates).set(patch).where(eq(candidates.id, survivor.id));
    }

    const dupeIds = others.map((d) => d.id);

    const survivorApps = await db
      .select({ id: applications.id, requisitionId: applications.requisitionId })
      .from(applications)
      .where(and(eq(applications.candidateId, survivor.id), eq(applications.orgId, context.orgId)));
    const taken = new Set(survivorApps.map((a) => a.requisitionId));

    const dupeApps = await db
      .select({ id: applications.id, requisitionId: applications.requisitionId })
      .from(applications)
      .where(
        and(inArray(applications.candidateId, dupeIds), eq(applications.orgId, context.orgId)),
      );

    let moved = 0;
    for (const a of dupeApps) {
      if (taken.has(a.requisitionId)) {
        await db
          .delete(applications)
          .where(and(eq(applications.id, a.id), eq(applications.orgId, context.orgId)));
        continue;
      }
      await db
        .update(applications)
        .set({ candidateId: survivor.id })
        .where(and(eq(applications.id, a.id), eq(applications.orgId, context.orgId)));
      taken.add(a.requisitionId);
      moved++;
    }

    // Child records that hang off the candidate directly — explicit per table.
    await db
      .update(socialProfiles)
      .set({ candidateId: survivor.id })
      .where(
        and(inArray(socialProfiles.candidateId, dupeIds), eq(socialProfiles.orgId, context.orgId)),
      );
    await db
      .update(candidateVerifications)
      .set({ candidateId: survivor.id })
      .where(
        and(
          inArray(candidateVerifications.candidateId, dupeIds),
          eq(candidateVerifications.orgId, context.orgId),
        ),
      );
    await db
      .update(candidateAssessments)
      .set({ candidateId: survivor.id })
      .where(
        and(
          inArray(candidateAssessments.candidateId, dupeIds),
          eq(candidateAssessments.orgId, context.orgId),
        ),
      );

    await db
      .delete(candidates)
      .where(and(inArray(candidates.id, dupeIds), eq(candidates.orgId, context.orgId)));
    // Agent requests about a duplicate's dropped applications no longer apply.
    const { afterSubjectsDeleted } = await import("../server/agents/runtime.server");
    await afterSubjectsDeleted(context.orgId);

    return { merged: others.length, movedApplications: moved };
  });
