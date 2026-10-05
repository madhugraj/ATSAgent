import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";

import { requireIdentity } from "@/lib/auth.middleware";
import { db } from "../server/db";
import {
  applications,
  candidates,
  ontologySnapshots,
  organizations,
  orgMembers,
  platformAdmins,
  requisitions,
  skillEdges,
  skillNodes,
  userRoles,
} from "@db/schema";
import {
  buildOntology,
  prettyName,
  type OntologyBuild,
  type OntologyDemandRow,
  type OntologySourceRow,
} from "./ontology.server";

export type TalentBrain = OntologyBuild & {
  scope: "org" | "platform";
  orgName: string | null;
  builtAt: string | null;
  history: Array<{
    at: string;
    nodes: number;
    edges: number;
    added: number;
    grown: number;
    dormant: number;
    retired: number;
  }>;
  narrative: string | null;
};

/** The Talent Brain is a governance view: CHRO, HR head, owner or the product super admin. */
async function requireBrainAccess(userId: string, email: string | null) {
  const [member] = await db
    .select({
      orgId: orgMembers.orgId,
      isOwner: orgMembers.isOwner,
      orgName: organizations.name,
    })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.status, "active")))
    .orderBy(orgMembers.createdAt)
    .limit(1);

  let superUser = false;
  if (email) {
    const [pa] = await db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(ilike(platformAdmins.email, email.toLowerCase()))
      .limit(1);
    superUser = Boolean(pa);
  }

  if (!member?.orgId) {
    if (superUser) return { orgId: null as string | null, orgName: null, superUser: true };
    throw new Error("You are not part of an organisation yet.");
  }

  if (member.isOwner || superUser) {
    return { orgId: member.orgId as string, orgName: member.orgName ?? null, superUser };
  }

  const roles = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.orgId, member.orgId as string)));
  const allowed = roles.some((r) => ["president_cbo", "hr_head"].includes(r.role));
  if (!allowed) {
    throw new Error("The Talent Brain is available to the CHRO, HR Head and the account owner.");
  }
  return { orgId: member.orgId as string, orgName: member.orgName ?? null, superUser: false };
}

async function loadSources(orgId: string | null) {
  const cand = await db
    .select({
      id: candidates.id,
      skills: candidates.skills,
      resumeText: candidates.resumeText,
      createdAt: candidates.createdAt,
      lastSyncedAt: candidates.lastSyncedAt,
    })
    .from(candidates)
    .where(orgId ? eq(candidates.orgId, orgId) : undefined)
    .limit(5000);

  const reqs = await db
    .select({
      id: requisitions.id,
      title: requisitions.title,
      openings: requisitions.openings,
      status: requisitions.status,
      mustHaveSkills: requisitions.mustHaveSkills,
      goodToHaveSkills: requisitions.goodToHaveSkills,
    })
    .from(requisitions)
    .where(orgId ? eq(requisitions.orgId, orgId) : undefined)
    .limit(2000);

  const apps = await db
    .select({ candidateId: applications.candidateId, stage: applications.stage })
    .from(applications)
    .where(orgId ? eq(applications.orgId, orgId) : undefined)
    .limit(10000);

  const prevNodes = await db
    .select({
      slug: skillNodes.slug,
      firstSeenAt: skillNodes.firstSeenAt,
      lastSeenAt: skillNodes.lastSeenAt,
      evidenceCount: skillNodes.evidenceCount,
      status: skillNodes.status,
      category: skillNodes.category,
      aliases: skillNodes.aliases,
    })
    .from(skillNodes)
    .where(orgId ? eq(skillNodes.orgId, orgId) : undefined)
    .limit(5000);

  const snaps = orgId
    ? await db
        .select()
        .from(ontologySnapshots)
        .where(eq(ontologySnapshots.orgId, orgId))
        .orderBy(desc(ontologySnapshots.createdAt))
        .limit(12)
    : await db
        .select()
        .from(ontologySnapshots)
        .orderBy(desc(ontologySnapshots.createdAt))
        .limit(12);

  const hired = new Set(
    apps
      .filter((a) => ["hired", "joined", "offer_accepted", "offer_released"].includes(a.stage))
      .map((a) => a.candidateId),
  );

  const candidatesOut: OntologySourceRow[] = cand.map((c) => ({
    candidateId: c.id,
    skills: Array.isArray(c.skills) ? c.skills : [],
    resumeText: c.resumeText,
    observedAt: (c.lastSyncedAt ?? c.createdAt ?? new Date()).toISOString(),
    hired: hired.has(c.id),
  }));

  const openStatuses = new Set(["approved", "pending_hr", "pending_cbo", "pending_dh", "draft"]);
  const demand: OntologyDemandRow[] = reqs.map((r) => ({
    requisitionId: r.id,
    title: r.title,
    openings: Number(r.openings ?? 1),
    mustHave: Array.isArray(r.mustHaveSkills) ? r.mustHaveSkills : [],
    goodToHave: Array.isArray(r.goodToHaveSkills) ? r.goodToHaveSkills : [],
    open: openStatuses.has(r.status),
  }));

  const previous = prevNodes.map((n) => ({
    slug: n.slug,
    firstSeenAt: n.firstSeenAt.toISOString(),
    lastSeenAt: n.lastSeenAt.toISOString(),
    evidence: Number(n.evidenceCount ?? 0),
    status: n.status ?? "active",
  }));

  // Curation already learned (families, merged aliases) is reused on every read.
  const curated: Record<string, { category?: string; aliases?: string[] }> = {};
  for (const n of prevNodes) {
    const entry: { category?: string; aliases?: string[] } = {};
    if (typeof n.category === "string" && n.category !== "general") entry.category = n.category;
    if (Array.isArray(n.aliases)) entry.aliases = n.aliases;
    if (entry.category || entry.aliases?.length) curated[n.slug] = entry;
  }

  return { candidates: candidatesOut, demand, previous, curated, snapshots: snaps };
}

function history(snapshots: Array<typeof ontologySnapshots.$inferSelect>) {
  return snapshots
    .slice()
    .reverse()
    .map((s) => ({
      at: s.createdAt.toISOString(),
      nodes: Number(s.nodeCount ?? 0),
      edges: Number(s.edgeCount ?? 0),
      added: (s.added ?? []).length,
      grown: (s.grown ?? []).length,
      dormant: (s.dormant ?? []).length,
      retired: (s.retired ?? []).length,
    }));
}

/** Read the stored graph (cheap) — falls back to a fresh in-memory build when empty. */
export const readTalentBrain = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((input: unknown) =>
    z.object({ scope: z.enum(["org", "platform"]).default("org") }).parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<TalentBrain> => {
    const email = context.claims?.email ?? null;
    const access = await requireBrainAccess(context.userId, email);
    const platform = data.scope === "platform" && access.superUser;
    if (data.scope === "platform" && !access.superUser) {
      throw new Error("Cross-organisation view is limited to the product super admin.");
    }

    const orgId = platform ? null : access.orgId;
    if (!platform && !orgId) throw new Error("You are not part of an organisation yet.");

    const src = await loadSources(orgId);
    const build = buildOntology({
      candidates: src.candidates,
      demand: src.demand,
      previous: src.previous,
      aiCategories: src.curated,
    });

    return {
      ...build,
      scope: platform ? "platform" : "org",
      orgName: platform ? "All organisations" : access.orgName,
      builtAt: src.snapshots[0]?.createdAt.toISOString() ?? null,
      history: history(src.snapshots),
      narrative: null,
    };
  });

/**
 * Rebuild and persist the ontology: canonicalise skills with the configured model,
 * store nodes/edges/evidence, then record a snapshot so growth and shrink are auditable.
 */
export const rebuildTalentBrain = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((input: unknown) => z.object({}).parse(input ?? {}))
  .handler(async ({ context }): Promise<TalentBrain> => {
    const email = context.claims?.email ?? null;
    const access = await requireBrainAccess(context.userId, email);
    const orgId = access.orgId;
    if (!orgId) throw new Error("Choose an organisation before rebuilding its Talent Brain.");

    const src = await loadSources(orgId);

    // First pass without AI so the graph exists even when no model is configured.
    let build = buildOntology({
      candidates: src.candidates,
      demand: src.demand,
      previous: src.previous,
      aiCategories: src.curated,
    });

    // AI pass: canonical categories, merged aliases and an executive narrative.
    let engine: string | null = null;
    let narrative: string | null = null;
    try {
      const { aiJson } = await import("./ai-gateway.server");
      const top = build.nodes.slice(0, 220);
      const res = await aiJson<{
        skills?: Array<{ slug: string; category?: string; aliases?: string[] }>;
        narrative?: string;
      }>({
        orgId: access.orgId,
        feature: "talent_brain",
        system:
          "You curate an enterprise talent ontology. Group skills into consistent capability families, " +
          "merge obvious synonyms, and write a short executive reading of supply vs demand. " +
          'Return JSON: {"skills":[{"slug","category","aliases":[]}],"narrative":"..."}.',
        prompt: JSON.stringify({
          organisation: access.orgName,
          openRoles: build.stats.requisitions,
          candidates: build.stats.candidates,
          skills: top.map((n) => ({
            slug: n.slug,
            name: n.name,
            category: n.category,
            supply: n.supply,
            demand: n.demand,
            validated: n.validated,
            status: n.status,
          })),
        }),
      });
      if (res.ok) {
        engine = `${res.provider}/${res.model}`;
        narrative = res.data.narrative?.trim() || null;
        const aiCategories: Record<string, { category?: string; aliases?: string[] }> = {
          ...src.curated,
        };
        for (const s of res.data.skills ?? []) {
          if (!s?.slug) continue;
          const entry: { category?: string; aliases?: string[] } = {};
          if (typeof s.category === "string" && s.category.trim()) entry.category = s.category;
          if (Array.isArray(s.aliases)) entry.aliases = s.aliases;
          aiCategories[s.slug] = entry;
        }
        build = buildOntology({
          candidates: src.candidates,
          demand: src.demand,
          previous: src.previous,
          aiCategories,
        });
      }
    } catch {
      // A model outage must never block the deterministic graph.
    }

    // Persist nodes.
    const now = new Date();
    for (const n of build.nodes) {
      await db
        .insert(skillNodes)
        .values({
          orgId,
          slug: n.slug,
          name: n.name,
          category: n.category,
          aliases: n.aliases,
          supply: n.supply,
          demand: n.demand,
          validated: n.validated,
          evidenceCount: n.evidence,
          status: n.status,
          firstSeenAt: new Date(n.firstSeenAt),
          lastSeenAt: new Date(n.lastSeenAt),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [skillNodes.orgId, skillNodes.slug],
          set: {
            name: n.name,
            category: n.category,
            aliases: n.aliases,
            supply: n.supply,
            demand: n.demand,
            validated: n.validated,
            evidenceCount: n.evidence,
            status: n.status,
            lastSeenAt: new Date(n.lastSeenAt),
            updatedAt: now,
          },
        });
    }

    // Retire nodes that lost all live evidence — this is how the graph shrinks.
    const liveSlugs = new Set(build.nodes.map((n) => n.slug));
    const gone = src.previous
      .filter((p: { slug: string }) => !liveSlugs.has(p.slug))
      .map((p: { slug: string }) => p.slug);
    if (gone.length) {
      await db
        .delete(skillNodes)
        .where(and(eq(skillNodes.orgId, orgId), inArray(skillNodes.slug, gone.slice(0, 500))));
      await db
        .delete(skillEdges)
        .where(and(eq(skillEdges.orgId, orgId), inArray(skillEdges.fromSlug, gone.slice(0, 500))));
    }

    // Replace edges for this organisation.
    await db.delete(skillEdges).where(eq(skillEdges.orgId, orgId));
    if (build.edges.length) {
      await db.insert(skillEdges).values(
        build.edges.map((e) => ({
          orgId,
          fromSlug: e.from,
          toSlug: e.to,
          kind: "cooccurs",
          weight: String(e.weight),
          evidenceCount: e.count,
          updatedAt: now,
        })),
      );
    }

    await db.insert(ontologySnapshots).values({
      orgId,
      nodeCount: build.stats.nodeCount,
      edgeCount: build.stats.edgeCount,
      added: build.diff.added.slice(0, 200),
      grown: build.diff.grown.slice(0, 200),
      dormant: build.diff.dormant.slice(0, 200),
      retired: [...new Set([...build.diff.retired, ...gone])].slice(0, 200),
      stats: build.stats,
      model: engine,
    });

    const snaps = await db
      .select()
      .from(ontologySnapshots)
      .where(eq(ontologySnapshots.orgId, orgId))
      .orderBy(desc(ontologySnapshots.createdAt))
      .limit(12);

    return {
      ...build,
      diff: { ...build.diff, retired: [...new Set([...build.diff.retired, ...gone])] },
      scope: "org",
      orgName: access.orgName,
      builtAt: now.toISOString(),
      history: history(snaps),
      narrative,
    };
  });

export { prettyName };
