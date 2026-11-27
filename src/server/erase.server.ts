/**
 * Permanently erasing candidates: applications, match scores, interviews,
 * evaluations, offers, assessments, verifications and social profiles (all
 * cascade), plus the stored CV files. capture_events has a restrictive FK, so
 * its candidate link is cleared first. Storage deletions must actually happen
 * — a failed delete aborts instead of silently orphaning a CV. Callers check
 * who may erase; every id is org-scoped here.
 */
import { and, eq, inArray } from "drizzle-orm";

import { candidateCvVersions, candidates, captureEvents } from "@db/schema";
import { db } from "./db";
import { deleteObject } from "./storage";

export async function eraseCandidatesCore(
  orgId: string,
  candidateIds: string[],
): Promise<{ id: string; fullName: string }[]> {
  if (!candidateIds.length) return [];
  const found = await db
    .select({
      id: candidates.id,
      fullName: candidates.fullName,
      resumeFilePath: candidates.resumeFilePath,
    })
    .from(candidates)
    .where(and(inArray(candidates.id, candidateIds), eq(candidates.orgId, orgId)));
  if (!found.length) return [];
  // Records merged into an erased person are that same person: erase them too,
  // so no tombstone keeps their name, contacts or CV text (design §2.5).
  const tombstones = await db
    .select({
      id: candidates.id,
      fullName: candidates.fullName,
      resumeFilePath: candidates.resumeFilePath,
    })
    .from(candidates)
    .where(
      and(
        eq(candidates.orgId, orgId),
        inArray(
          candidates.mergedIntoId,
          found.map((r) => r.id),
        ),
      ),
    );
  for (const t of tombstones) if (!found.some((f) => f.id === t.id)) found.push(t);
  const ids = found.map((r) => r.id);
  // Every stored CV version's file goes first (delete-files-first, abort on failure).
  const versionFiles = await db
    .select({ filePath: candidateCvVersions.filePath })
    .from(candidateCvVersions)
    .where(
      and(eq(candidateCvVersions.orgId, orgId), inArray(candidateCvVersions.candidateId, ids)),
    );
  const paths = new Set(versionFiles.map((v) => v.filePath).filter((p): p is string => Boolean(p)));
  for (const f of found) if (f.resumeFilePath) paths.delete(f.resumeFilePath);
  for (const p of paths) await deleteObject(p);
  await db
    .update(captureEvents)
    .set({ candidateId: null })
    .where(inArray(captureEvents.candidateId, ids));
  for (const file of found) {
    if (file.resumeFilePath) await deleteObject(file.resumeFilePath);
  }
  await db.delete(candidates).where(and(inArray(candidates.id, ids), eq(candidates.orgId, orgId)));
  // Agent requests about these candidates' applications can no longer be decided.
  const { afterSubjectsDeleted } = await import("./agents/runtime.server");
  await afterSubjectsDeleted(orgId);
  return found.map(({ id, fullName }) => ({ id, fullName }));
}
