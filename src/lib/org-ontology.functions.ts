/**
 * Organisation ontology (governance roles): the domain → family → skill → role
 * map and the roles emerging from combinations of established ones, built
 * deterministically from this organisation's requisitions and candidate pool
 * (src/lib/org-ontology.ts). A person may ask for a suggested name for a new
 * role (one gateway call: titles and skills are fenced as untrusted, the reply
 * is schema-validated) and confirms the role into job architecture (master
 * data, audited); the judgement on the suggestion is captured for training.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { candidates, masterItems, organizations, requisitions } from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";
import { ONTOLOGY_MONTHS, buildOrgOntology, type OrgOntology } from "./org-ontology";

export type * from "./org-ontology";

const ROLES = ["hr_head", "president_cbo"] as const;

async function loadOntology(orgId: string): Promise<OrgOntology> {
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

export const readOrgOntology = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<OrgOntology> => {
    await assertRole(context.userId, context.orgId, [...ROLES]);
    return loadOntology(context.orgId);
  });

/** Suggest a clear, conventional name for an emerging role. The person decides. */
export const suggestRoleName = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((input: unknown) => z.object({ roleId: z.string().min(1).max(120) }).parse(input))
  .handler(
    async ({ context, data }): Promise<{ name: string; reason: string } | { error: string }> => {
      await assertRole(context.userId, context.orgId, [...ROLES]);
      const ont = await loadOntology(context.orgId);
      const role = ont.emerging.find((e) => e.id === data.roleId);
      if (!role) return { error: "That role is no longer detected." };
      const parents = role.parents.map(
        (p) => [...ont.roles, ...ont.emerging].find((r) => r.id === p)?.name ?? p,
      );
      const { INJECTION_RULES, aiJson, untrusted } = await import("./ai-gateway.server");
      const res = await aiJson<{ name: string; reason: string }>({
        orgId: context.orgId,
        feature: "talent_brain",
        system: `${INJECTION_RULES}\n\nYou name job roles for an organisation's job architecture. Given the job titles its requisitions used, the skills they asked for and the established roles the new role grew out of, return the clearest conventional name a recruiter in the ${ont.domain.name} industry would recognise (2 to 5 words, no seniority level), and one sentence on why. Return JSON {"name": string, "reason": string}.`,
        prompt: `Established parent roles: ${parents.join(" + ")}\n\n${untrusted("job_titles", role.titles.join("\n"))}\n\n${untrusted("skills", role.skills.join(", "))}`,
        schema: z.object({ name: z.string().min(2).max(60), reason: z.string().max(300) }),
      });
      if (!res.ok)
        return {
          error: "No suggestion available right now — confirm the detected name or type your own.",
        };
      return { name: res.data.name.trim(), reason: res.data.reason.trim() };
    },
  );

/** Confirm an emerging role into job architecture (master data role titles). */
export const confirmEmergingRole = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((input: unknown) =>
    z
      .object({
        roleId: z.string().min(1).max(120),
        name: z.string().trim().min(2).max(80),
        suggested: z.string().max(80).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }): Promise<{ ok: true; name: string }> => {
    await assertRole(context.userId, context.orgId, [...ROLES]);
    const ont = await loadOntology(context.orgId);
    const role = ont.emerging.find((e) => e.id === data.roleId);
    if (!role) throw new Error("That role is no longer detected.");
    await db
      .insert(masterItems)
      .values({
        orgId: context.orgId,
        kind: "role_title",
        name: data.name,
        category: "emerging role",
      })
      .onConflictDoNothing();
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      orgId: context.orgId,
      actorUserId: context.userId,
      action: "ontology.role_confirmed",
      entityType: "role_title",
      detail: {
        name: data.name,
        detected: role.name,
        parents: role.parents,
        requisitions: role.requisitions,
      },
    });
    if (data.suggested) {
      const { captureFeedback } = await import("../server/training/capture.server");
      await captureFeedback({
        orgId: context.orgId,
        source: "ontology_role_name",
        label:
          data.suggested.trim().toLowerCase() === data.name.trim().toLowerCase()
            ? "accepted"
            : "edited",
        original: { name: data.suggested },
        corrected: { name: data.name },
        actorUserId: context.userId,
      });
    }
    return { ok: true, name: data.name };
  });
