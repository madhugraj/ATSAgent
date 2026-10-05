/**
 * Scheduled candidate sync.
 *
 * Re-runs the genuineness agent and refreshes social evidence for candidates
 * whose data is stale, prioritising anyone currently active in a pipeline.
 * Called by the platform scheduler with the cron secret; never public.
 */
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { db } from "../../../server/db";
import { applications, candidateVerifications, candidates } from "@db/schema";
import { authenticateCronRequest } from "@/server/cron-auth";
import { verifyClaims } from "@/lib/verification.server";

const Body = z.object({
  staleDays: z.number().min(0).max(365).optional(),
  limit: z.number().min(1).max(50).optional(),
});

async function run(request: Request) {
  const denied = await authenticateCronRequest(request);
  if (denied) return denied;

  let opts: z.infer<typeof Body> = {};
  try {
    const raw = await request.text();
    if (raw) opts = Body.parse(JSON.parse(raw));
  } catch {
    /* no body is fine — defaults apply */
  }
  const staleDays = opts.staleDays ?? 30;
  const limit = opts.limit ?? 15;

  const cutoff = new Date(Date.now() - staleDays * 86_400_000);

  // Candidates active in a pipeline come first, then the rest of the pool.
  const activeApps = await db
    .select({ candidateId: applications.candidateId, stage: applications.stage })
    .from(applications)
    .where(
      notInArray(applications.stage, [
        "rejected",
        "withdrawn",
        "offer_declined",
        "no_show",
        "joined",
        "hired",
      ]),
    );
  const activeIds = new Set(activeApps.map((a) => a.candidateId));

  const staleCandidates = await db
    .select({
      id: candidates.id,
      orgId: candidates.orgId,
      fullName: candidates.fullName,
      skills: candidates.skills,
      resumeText: candidates.resumeText,
      linkedinUrl: candidates.linkedinUrl,
      githubUrl: candidates.githubUrl,
      websiteUrl: candidates.websiteUrl,
      xUrl: candidates.xUrl,
      lastSyncedAt: candidates.lastSyncedAt,
    })
    .from(candidates)
    .where(or(isNull(candidates.lastSyncedAt), lt(candidates.lastSyncedAt, cutoff)))
    .limit(200);

  const queue = [...staleCandidates]
    .sort((a, b) => Number(activeIds.has(b.id)) - Number(activeIds.has(a.id)))
    .slice(0, limit);

  let ok = 0;
  let failed = 0;
  for (const c of queue) {
    try {
      // Each candidate is re-verified with their own organisation's AI key;
      // candidates with no organisation are skipped rather than billed elsewhere.
      if (!c.orgId) continue;
      const result = await verifyClaims({
        orgId: c.orgId,
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

  // Daily bias watch: selection-rate parity by intake source (four-fifths).
  // Breaches are written to audit_log so they surface in the platform trail.
  try {
    const { selectionParity } = await import("@/lib/bias.server");
    const { writeAudit } = await import("../../../server/audit");
    const orgs = await db
      .select({ id: applications.orgId })
      .from(applications)
      .groupBy(applications.orgId)
      .limit(200);
    for (const { id: orgId } of orgs) {
      if (!orgId) continue;
      const { breaches } = await selectionParity(orgId);
      if (breaches.length) {
        await writeAudit({
          actor: "system",
          orgId,
          action: "bias.parity.breach",
          entityType: "organization",
          entityId: orgId,
          detail: { breaches },
        });
      }
    }
  } catch (e) {
    console.error("bias watch failed", e);
  }

  return Response.json({
    scanned: staleCandidates.length,
    processed: queue.length,
    ok,
    failed,
    staleDays,
  });
}

export const Route = createFileRoute("/api/public/sync-candidates")({
  server: { handlers: { POST: ({ request }) => run(request) } },
});
