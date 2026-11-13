/**
 * The practical blockers for a screening decision: the same logistics check the
 * CV match runs, but with what the candidate said on the screening call or to
 * TA (newer than the CV) — where they live and whether they will relocate,
 * notice period, pay, joining date. The CV match can only flag "relocation
 * willingness not captured"; once the call has the answer, a "no" is a blocker
 * the screening decision must state. Scoped to the organisation.
 */
import { and, eq } from "drizzle-orm";

import { applications, candidates, requisitions } from "@db/schema";
import { db } from "../server/db";
import { logisticsCheck } from "./logistics";

export type ScreeningLogistics = {
  blockers: string[];
  /** One plain line on where they are against where the role is, when that blocks. */
  location: string | null;
};

const NO_RELOCATE = "Location mismatch and candidate will not relocate";

export async function screeningLogistics(
  orgId: string,
  applicationId: string,
): Promise<ScreeningLogistics> {
  const [row] = await db
    .select({ req: requisitions, cand: candidates })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!row) return { blockers: [], location: null };
  const { req, cand } = row;
  const { roleLogistics, candidateLogistics } = await import("./pay-context.server");
  const role = await roleLogistics(orgId, req);
  const stated = await candidateLogistics(orgId, applicationId, cand.location, role.ctx);
  const check = logisticsCheck(
    {
      noticePeriodDays: cand.noticePeriodDays,
      currentCtc: cand.currentCtc ? Number(cand.currentCtc) : null,
      expectedCtc: cand.expectedCtc ? Number(cand.expectedCtc) : null,
      location: cand.location,
      preferredLocations: cand.preferredLocations,
      willingToRelocate: cand.willingToRelocate,
      workAuthorization: cand.workAuthorization,
      ...stated,
    },
    {
      // A remote role has no place to relocate to.
      locations: req.location && req.workMode !== "remote" ? [req.location] : null,
      ctcBandMin: req.ctcBandMin != null ? Number(req.ctcBandMin) : null,
      ctcBandMax: req.ctcBandMax != null ? Number(req.ctcBandMax) : null,
      maxNoticePeriodDays: req.maxNoticePeriodDays,
      workAuthorizationRequired: req.workAuthorizationRequired,
      ...role.constraints,
    },
  );
  const where = stated.location ?? cand.location ?? null;
  const location = check.blockers.includes(NO_RELOCATE)
    ? `lives in ${where ?? "another city"} and is not open to relocating to ${req.location}${req.workMode ? ` (${req.workMode})` : ""}`
    : null;
  return { blockers: check.blockers, location };
}
