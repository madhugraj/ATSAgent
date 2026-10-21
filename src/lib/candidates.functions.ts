import { poolUseFor } from "./job-channels";
import { and, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { candidates, applications, requisitions } from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";

/**
 * Permanently delete candidates and everything attached to them:
 * applications, match scores, interviews, evaluations, offers, assessments,
 * verifications, social profiles (all cascade), plus the stored CV files.
 * capture_events has a restrictive FK, so its candidate link is cleared first.
 */
export const deleteCandidates = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data) =>
    z.object({ candidateIds: z.array(z.string().uuid()).min(1).max(100) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    // Deletion is rare and destructive — HR head or above only.
    await assertRole(
      context.userId,
      context.orgId,
      ["hr_head", "president_cbo"],
      "Only the HR head or the CBO can delete candidates.",
    );
    // Org predicate everywhere: an id from another tenant simply does not match.
    const { eraseCandidatesCore } = await import("../server/erase.server");
    const found = await eraseCandidatesCore(context.orgId, data.candidateIds);
    if (found.length === 0)
      throw new Error("No matching candidates found — they may already be deleted.");

    return { deleted: found.length, names: found.map((r) => r.fullName).slice(0, 5) };
  });

/**
 * Attach a talent-pool candidate to a requisition's pipeline (the "Add to
 * pipeline" suggestion on the dashboard). Org comes from the caller's verified
 * context, and both the requisition and the candidate must belong to it — a
 * cross-tenant id simply is not found.
 */
export const attachApplication = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        requisitionId: z.string().uuid(),
        candidateId: z.string().uuid(),
        source: z.string().min(1).max(60).default("talent_pool"),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const [req] = await db
      .select({ id: requisitions.id })
      .from(requisitions)
      .where(and(eq(requisitions.id, data.requisitionId), eq(requisitions.orgId, context.orgId)))
      .limit(1);
    if (!req) throw new Error("Requisition not found.");

    const [cand] = await db
      .select({
        id: candidates.id,
        name: candidates.fullName,
        poolUse: candidates.poolUse,
        poolUseSource: candidates.poolUseSource,
      })
      .from(candidates)
      .where(and(eq(candidates.id, data.candidateId), eq(candidates.orgId, context.orgId)))
      .limit(1);
    if (!cand) throw new Error("Candidate not found.");
    const { assertReusable } = await import("./pipeline.server");
    assertReusable([cand]);

    // The (requisition_id, candidate_id) unique index keeps repeat attaches out.
    await db.insert(applications).values({
      requisitionId: req.id,
      candidateId: cand.id,
      source: data.source,
      orgId: context.orgId,
    });
    return { ok: true as const };
  });

const CreateCandidateInput = z.object({
  fullName: z.string().min(1),
  email: z.string().min(1),
  location: z.string(),
  experienceYears: z.string(),
  education: z.string(),
  skills: z.string(),
  linkedinUrl: z.string(),
  githubUrl: z.string(),
  websiteUrl: z.string(),
  xUrl: z.string(),
  source: z.string().min(1),
  currentEmployer: z.string(),
  noticePeriodDays: z.string(),
  currentCtc: z.string(),
  expectedCtc: z.string(),
  workAuthorization: z.string(),
  willingToRelocate: z.enum(["yes", "no", "unknown"]),
  resumeText: z.string(),
  requisitionId: z.string().uuid().nullish(),
});

/**
 * Recruiter "add candidate" flow: create the talent-pool record (org from the
 * caller's context), optionally attaching it to a requisition at stage
 * "sourced". The legacy client ignored application-attach failures, so they
 * stay non-fatal.
 */
export const createCandidate = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => CreateCandidateInput.parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .insert(candidates)
      .values({
        orgId: context.orgId,
        fullName: data.fullName,
        email: data.email,
        location: data.location || null,
        experienceYears: String(Number(data.experienceYears) || 0),
        education: data.education || null,
        skills: data.skills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        linkedinUrl: data.linkedinUrl || null,
        githubUrl: data.githubUrl || null,
        websiteUrl: data.websiteUrl || null,
        xUrl: data.xUrl || null,
        source: data.source,
        // A CV a portal handed over may be limited to its role (job-channels.ts).
        poolUse: poolUseFor(data.source),
        poolUseSource: poolUseFor(data.source) === "role_only" ? data.source : null,
        currentEmployer: data.currentEmployer || null,
        noticePeriodDays: data.noticePeriodDays ? Number(data.noticePeriodDays) : null,
        currentCtc: data.currentCtc ? String(Number(data.currentCtc)) : null,
        expectedCtc: data.expectedCtc ? String(Number(data.expectedCtc)) : null,
        workAuthorization: data.workAuthorization || null,
        willingToRelocate:
          data.willingToRelocate === "unknown" ? null : data.willingToRelocate === "yes",
        resumeText: data.resumeText || null,
      })
      .returning({ id: candidates.id });
    if (!row) throw new Error("Could not save the candidate");

    if (data.requisitionId) {
      const { assertRequisitionInOrg } = await import("../server/guards");
      await assertRequisitionInOrg(data.requisitionId, context.orgId);
      try {
        await db.insert(applications).values({
          requisitionId: data.requisitionId,
          candidateId: row.id,
          orgId: context.orgId,
          source: data.source,
          stage: "sourced",
        });
      } catch (e) {
        console.error("[createCandidate] could not attach the application:", e);
      }
    }
    return { id: row.id };
  });
