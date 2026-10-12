/**
 * New CV → open roles (docs/agentic-plan.md §13.4). The other direction of the
 * talent-pool search: when someone joins the pool without a role — an inbox
 * mail that named no role, an upload, a capture, an HRMS import — the
 * scheduler checks them against every approved role with an approved JD,
 * using the same evidence ranking as the pool search (must-haves and their
 * equivalents in skills or CV text, the experience band). A strong match is
 * added to that role's pipeline with source "pool_match", so the Intake &
 * matching agent scores it within minutes and the role's desk thread
 * announces it.
 *
 * Plain code, no agent run: one skill expansion per role (cached), then pure
 * matching per CV. Part of the Sourcing agent's remit, so it runs only for
 * organisations that switched the Sourcing agent on. Each person is checked
 * once (candidates.role_match_checked_at); only CVs from the last few days are
 * considered, so switching it on does not re-sweep the whole pool.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "../db";
import { applications, candidates, requisitions } from "@db/schema";
import { writeAudit } from "../audit";
import { expandSkills, rankPool } from "./talent-search.server";

export const POOL_MATCH = {
  /** Only CVs added within this many days are checked. */
  recentDays: 7,
  /** CVs checked per organisation per sweep. */
  batch: 50,
  /** Share of must-haves (or equivalents) that must be evidenced. */
  minCoverage: 0.75,
  /** People added to one role per sweep, at most. */
  maxPerRole: 5,
  /** Skill expansions are reused for this long (ms). */
  expansionTtlMs: 6 * 3600_000,
} as const;

const expansions = new Map<string, { at: number; groups: { skill: string; terms: string[] }[] }>();

async function groupsFor(orgId: string, title: string, mustHave: string[]) {
  const key = `${orgId}|${title}|${mustHave.join("\u0001")}`;
  const hit = expansions.get(key);
  if (hit && Date.now() - hit.at < POOL_MATCH.expansionTtlMs) return hit.groups;
  const groups = await expandSkills(orgId, title, mustHave);
  expansions.set(key, { at: Date.now(), groups });
  return groups;
}

export type PoolMatchResult = {
  checked: number;
  added: { requisitionId: string; candidateId: string; name: string; why: string }[];
};

export async function matchNewCvsToRoles(orgId: string): Promise<PoolMatchResult> {
  const fresh = await db
    .select({
      id: candidates.id,
      name: candidates.fullName,
      experienceYears: candidates.experienceYears,
      location: candidates.location,
      skills: candidates.skills,
      resumeText: candidates.resumeText,
      currentEmployer: candidates.currentEmployer,
    })
    .from(candidates)
    .where(
      and(
        eq(candidates.orgId, orgId),
        isNull(candidates.roleMatchCheckedAt),
        eq(candidates.isInternal, false),
        sql`${candidates.createdAt} >= now() - make_interval(days => ${POOL_MATCH.recentDays})`,
      ),
    )
    .limit(POOL_MATCH.batch);
  if (!fresh.length) return { checked: 0, added: [] };

  const roles = await db
    .select({
      id: requisitions.id,
      code: requisitions.code,
      title: requisitions.title,
      mustHave: requisitions.mustHaveSkills,
      location: requisitions.location,
      experienceMin: requisitions.experienceMin,
      experienceMax: requisitions.experienceMax,
      createdBy: requisitions.createdBy,
    })
    .from(requisitions)
    .where(
      and(
        eq(requisitions.orgId, orgId),
        eq(requisitions.status, "approved"),
        sql`exists (select 1 from job_descriptions j where j.requisition_id = ${requisitions.id} and j.status = 'approved')`,
        sql`coalesce(array_length(${requisitions.mustHaveSkills}, 1), 0) > 0`,
      ),
    )
    .limit(30);

  const added: PoolMatchResult["added"] = [];
  if (roles.length) {
    const ids = fresh.map((c) => c.id);
    const existing = await db
      .select({ c: applications.candidateId, r: applications.requisitionId })
      .from(applications)
      .where(and(eq(applications.orgId, orgId), inArray(applications.candidateId, ids)));
    const inPipeline = new Set(existing.map((x) => `${x.r}|${x.c}`));
    // Employees and people already hired elsewhere are not "new candidates".
    const employed = new Set(
      (
        await db
          .select({ c: applications.candidateId })
          .from(applications)
          .where(
            and(
              eq(applications.orgId, orgId),
              inArray(applications.candidateId, ids),
              inArray(applications.stage, ["hired", "joined", "offer_accepted"]),
            ),
          )
      ).map((x) => x.c),
    );
    const pool = fresh
      .filter((c) => !employed.has(c.id))
      .map((c) => ({
        candidateId: c.id,
        name: c.name,
        experienceYears: Number(c.experienceYears ?? 0),
        location: c.location,
        skills: c.skills ?? [],
        resumeText: c.resumeText,
        currentEmployer: c.currentEmployer,
      }));
    for (const role of roles) {
      const groups = await groupsFor(orgId, role.title, role.mustHave ?? []);
      const strong = rankPool(
        pool.filter((p) => !inPipeline.has(`${role.id}|${p.candidateId}`)),
        groups,
        {
          experienceMin: role.experienceMin,
          experienceMax: role.experienceMax,
          location: role.location,
        },
      )
        .filter(
          (m) =>
            (m.skillHits.length + m.textHits.length) / groups.length >= POOL_MATCH.minCoverage &&
            !m.why.includes("outside the band"),
        )
        .slice(0, POOL_MATCH.maxPerRole);
      if (!strong.length) continue;
      await db.insert(applications).values(
        strong.map((m) => ({
          orgId,
          requisitionId: role.id,
          candidateId: m.candidateId,
          source: "pool_match",
        })),
      );
      for (const m of strong) {
        inPipeline.add(`${role.id}|${m.candidateId}`);
        added.push({
          requisitionId: role.id,
          candidateId: m.candidateId,
          name: m.name,
          why: m.why,
        });
      }
      await writeAudit({
        actor: "system:pool-match",
        orgId,
        action: "pool.matched_to_role",
        entityType: "requisition",
        entityId: role.id,
        detail: {
          candidates: strong.map((m) => ({ id: m.candidateId, why: m.why })),
        },
      });
    }
  }

  await db
    .update(candidates)
    .set({ roleMatchCheckedAt: new Date() })
    .where(
      and(
        eq(candidates.orgId, orgId),
        inArray(
          candidates.id,
          fresh.map((c) => c.id),
        ),
      ),
    );
  return { checked: fresh.length, added };
}
