/**
 * Loads an organisation's ontology inputs (industry, requisitions of the last
 * 18 months, candidate pool, confirmed role titles) and builds it with the
 * pure engine in src/lib/org-ontology.ts. Shared by the page server functions
 * and the agent tools. Every query is scoped to the organisation.
 */
import { and, eq, gte } from "drizzle-orm";

import { db } from "./db";
import { candidates, masterItems, organizations, requisitions } from "@db/schema";
import { ONTOLOGY_MONTHS, buildOrgOntology, type OrgOntology } from "../lib/org-ontology";

export async function loadOntology(orgId: string): Promise<OrgOntology> {
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - ONTOLOGY_MONTHS);
  const [org, reqs, cands, confirmed] = await Promise.all([
    db
      .select({ industry: organizations.industry })
      .from(organizations)
      .where(eq(organizations.id, orgId)),
    db
      .select({
        id: requisitions.id,
        title: requisitions.title,
        must: requisitions.mustHaveSkills,
        good: requisitions.goodToHaveSkills,
        createdAt: requisitions.createdAt,
      })
      .from(requisitions)
      .where(and(eq(requisitions.orgId, orgId), gte(requisitions.createdAt, since))),
    db
      .select({ skills: candidates.skills, createdAt: candidates.createdAt })
      .from(candidates)
      .where(eq(candidates.orgId, orgId)),
    db
      .select({ name: masterItems.name })
      .from(masterItems)
      .where(
        and(
          eq(masterItems.orgId, orgId),
          eq(masterItems.kind, "role_title"),
          eq(masterItems.active, true),
        ),
      ),
  ]);
  return buildOrgOntology({
    industry: org[0]?.industry ?? null,
    requisitions: reqs.map((r) => ({
      id: r.id,
      title: r.title,
      skills: [...((r.must as string[] | null) ?? []), ...((r.good as string[] | null) ?? [])],
      createdAt: r.createdAt,
    })),
    candidates: cands.map((c) => ({
      skills: (c.skills as string[] | null) ?? [],
      createdAt: c.createdAt,
    })),
    confirmedTitles: confirmed.map((c) => c.name),
  });
}
