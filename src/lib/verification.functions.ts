import { and, eq, inArray } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { candidateVerifications, candidates } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { verifyClaims } from "./verification.server";

const Input = z.object({
  candidateId: z.string().uuid(),
  linkedinProfileText: z.string().optional().nullable(),
});

/**
 * Run the genuineness agent for one candidate and persist the result so
 * recruiters and approvers always see the same audited verdicts.
 */
export const verifyCandidate = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const [candidate] = await db
      .select({
        id: candidates.id,
        fullName: candidates.fullName,
        skills: candidates.skills,
        resumeText: candidates.resumeText,
        linkedinUrl: candidates.linkedinUrl,
        githubUrl: candidates.githubUrl,
        websiteUrl: candidates.websiteUrl,
        xUrl: candidates.xUrl,
      })
      .from(candidates)
      .where(and(eq(candidates.id, data.candidateId), eq(candidates.orgId, context.orgId)))
      .limit(1);
    if (!candidate) throw new Error("Candidate not found");

    const result = await verifyClaims({
      orgId: context.orgId,
      name: candidate.fullName,
      resumeText: candidate.resumeText,
      skills: candidate.skills ?? [],
      linkedinUrl: candidate.linkedinUrl,
      githubUrl: candidate.githubUrl,
      websiteUrl: candidate.websiteUrl,
      xUrl: candidate.xUrl,
      linkedinProfileText: data.linkedinProfileText ?? null,
    });

    await db.insert(candidateVerifications).values({
      candidateId: candidate.id,
      orgId: context.orgId,
      authenticityScore: result.authenticity_score,
      claims: result.claims,
      redFlags: result.red_flags,
      evidence: result.evidence,
      summary: result.summary,
      model: result.model,
      status: "ok",
    });
    await db
      .update(candidates)
      .set({ lastSyncedAt: new Date(), syncStatus: "ok" })
      .where(eq(candidates.id, candidate.id));

    // `model` is persisted above and logged in ai_usage_events — not sent on.
    const { model: _model, ...wire } = result;
    return wire;
  });

/** Bulk re-verification from the talent pool table. */
export const verifyCandidates = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) =>
    z.object({ candidateIds: z.array(z.string().uuid()).min(1).max(50) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const rows = await db
      .select({
        id: candidates.id,
        fullName: candidates.fullName,
        skills: candidates.skills,
        resumeText: candidates.resumeText,
        linkedinUrl: candidates.linkedinUrl,
        githubUrl: candidates.githubUrl,
        websiteUrl: candidates.websiteUrl,
        xUrl: candidates.xUrl,
      })
      .from(candidates)
      .where(and(inArray(candidates.id, data.candidateIds), eq(candidates.orgId, context.orgId)));

    let ok = 0;
    let failed = 0;

    for (const c of rows) {
      try {
        const result = await verifyClaims({
          orgId: context.orgId,
          name: c.fullName,
          resumeText: c.resumeText,
          skills: c.skills ?? [],
          linkedinUrl: c.linkedinUrl,
          githubUrl: c.githubUrl,
          websiteUrl: c.websiteUrl,
          xUrl: c.xUrl,
        });
        await db.insert(candidateVerifications).values({
          candidateId: c.id,
          orgId: context.orgId,
          authenticityScore: result.authenticity_score,
          claims: result.claims,
          redFlags: result.red_flags,
          evidence: result.evidence,
          summary: result.summary,
          model: result.model,
          status: "ok",
        });
        await db
          .update(candidates)
          .set({ lastSyncedAt: new Date(), syncStatus: "ok" })
          .where(eq(candidates.id, c.id));
        ok++;
      } catch (e) {
        failed++;
        await db
          .update(candidates)
          .set({
            lastSyncedAt: new Date(),
            syncStatus: `error: ${(e as Error).message}`.slice(0, 200),
          })
          .where(eq(candidates.id, c.id));
      }
    }

    return { ok, failed, total: rows.length };
  });
