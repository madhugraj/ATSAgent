/**
 * The consolidated candidate profile (A2): every CV version, the evidence-backed
 * claims, and the consistency flags. Org-scoped on every query; accepting a
 * pending version and re-queueing extraction are recruiter-side actions and audited.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { candidates } from "@db/schema";
import { db } from "../server/db";
import { assertRole, requireOrg } from "./auth.middleware";
import { requireCapability } from "./capabilities.server";

const RECRUITER_SIDE = ["recruiter", "hr_head", "president_cbo"] as const;

async function assertCandidateInOrg(orgId: string, candidateId: string) {
  const [c] = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)))
    .limit(1);
  if (!c) throw new Error("Candidate not found in your organisation.");
}

export const getCandidateProfileFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.pool")])
  .validator((d: unknown) =>
    z
      .object({ candidateId: z.string().uuid(), requisitionId: z.string().uuid().nullish() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertCandidateInOrg(context.orgId, data.candidateId);
    if (data.requisitionId) {
      const { assertRequisitionInOrg } = await import("../server/guards");
      await assertRequisitionInOrg(data.requisitionId, context.orgId);
    }
    const { getConsolidatedProfile } = await import("../server/candidates/versions.server");
    return getConsolidatedProfile(context.orgId, data.candidateId, {
      requisitionId: data.requisitionId ?? null,
    });
  });

export const acceptCvVersionFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.pool")])
  .validator((d: unknown) => z.object({ versionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId, context.orgId, [...RECRUITER_SIDE]);
    const { acceptCvVersion } = await import("../server/candidates/versions.server");
    const ok = await acceptCvVersion(context.orgId, data.versionId);
    if (!ok) throw new Error("That CV is not waiting for acceptance.");
    const { writeAudit } = await import("../server/audit");
    void writeAudit({
      actorUserId: context.userId,
      actor: context.memberEmail,
      orgId: context.orgId,
      action: "candidate.cv_version.accepted",
      entityType: "candidate_cv_version",
      entityId: data.versionId,
    });
    return { ok: true as const };
  });

export const requeueClaimsFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.pool")])
  .validator((d: unknown) => z.object({ candidateId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId, context.orgId, [...RECRUITER_SIDE]);
    await assertCandidateInOrg(context.orgId, data.candidateId);
    const { requeueClaimsExtraction } = await import("../server/candidates/versions.server");
    const queued = await requeueClaimsExtraction(context.orgId, [data.candidateId]);
    return { queued };
  });
