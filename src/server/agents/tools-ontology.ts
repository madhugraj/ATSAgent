/**
 * Ontology tools for conversational hiring (read-only). They let the copilot
 * and the requisition agent answer "I need a forward deployment resource"
 * with what the role is in this organisation's ontology — must-haves,
 * good-to-haves, where it comes from, how often it is asked for — and whether
 * people who fit it are already in the pool, before anyone opens a
 * requisition. Neither tool changes anything; a person decides what happens.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db";
import { candidates } from "@db/schema";
import { findRoleProfile } from "@/lib/org-ontology";
import { loadOntology } from "../org-ontology.server";
import { registerTool } from "./registry";
import { searchPoolBySkills } from "./talent-search.server";

export function registerOntologyTools(): void {
  registerTool({
    name: "get_role_profile",
    description:
      'Look up a role in the organisation\'s ontology from how the person described it ("a forward deployment resource", "AI engineer"): its must-have and good-to-have skills, the roles it grew out of, the titles used for it, how many requisitions asked for it and how many people in the pool fit. Returns found: false with the known roles when nothing matches.',
    input: z.object({ request: z.string().min(2).max(300) }),
    risk: "read",
    run: async (ctx, i) => {
      const ont = await loadOntology(ctx.orgId);
      const profile = findRoleProfile(ont, i.request);
      if (profile) return { found: true, ...profile };
      return {
        found: false,
        domain: ont.domain.name,
        knownRoles: [...ont.roles.map((r) => r.name), ...ont.emerging.map((e) => e.name)],
      };
    },
  });

  registerTool({
    name: "check_talent_availability",
    description:
      "Check whether people who fit a role are already in the organisation's talent pool, before a requisition exists. Give the role title and its must-have skills (from get_role_profile or the person). Returns how many cover most of the skills (strong), half of them (partial), how many of those are internal employees, and the best matches.",
    input: z.object({
      title: z.string().min(2).max(120),
      skills: z.array(z.string().min(1).max(80)).min(1).max(12),
      experienceMin: z.number().int().min(0).max(40).optional(),
      experienceMax: z.number().int().min(0).max(50).optional(),
      location: z.string().max(120).optional(),
    }),
    risk: "read",
    // candidate names and CV-derived reasons are third-party text
    untrustedOutput: true,
    skills: ["talent_search"],
    run: async (ctx, i) => talentAvailability(ctx.orgId, i),
  });
}

/**
 * Strong and partial fits for a role in the talent pool, how many are
 * internal and the best five. Shared by the agent tool above and the HR
 * copilot. Candidate names and reasons are third-party text: callers must
 * fence them as untrusted before they reach a prompt.
 */
export async function talentAvailability(
  orgId: string,
  i: {
    title: string;
    skills: string[];
    experienceMin?: number | undefined;
    experienceMax?: number | undefined;
    location?: string | undefined;
  },
) {
  const res = await searchPoolBySkills(
    orgId,
    {
      title: i.title,
      mustHave: i.skills,
      location: i.location ?? null,
      experienceMin: i.experienceMin ?? 0,
      experienceMax: i.experienceMax ?? 40,
    },
    50,
  );
  const total = Math.max(res.searchedFor.length, 1);
  const scored = res.matches.map((m) => ({
    ...m,
    coverage: (m.skillHits.length + m.textHits.length) / total,
  }));
  const fitting = scored.filter((m) => m.coverage >= 0.5);
  const internal = fitting.length
    ? await db
        .select({ id: candidates.id })
        .from(candidates)
        .where(
          and(
            eq(candidates.orgId, orgId),
            eq(candidates.isInternal, true),
            inArray(
              candidates.id,
              fitting.map((m) => m.candidateId),
            ),
          ),
        )
    : [];
  const internalIds = new Set(internal.map((r) => r.id));
  return {
    searchedFor: res.searchedFor.map((g) => g.skill),
    strong: scored.filter((m) => m.coverage >= 0.8).length,
    partial: scored.filter((m) => m.coverage >= 0.5 && m.coverage < 0.8).length,
    internal: fitting.filter((m) => internalIds.has(m.candidateId)).length,
    best: fitting
      .sort((a, b) => b.coverage - a.coverage || b.score - a.score)
      .slice(0, 5)
      .map((m) => ({
        candidateId: m.candidateId,
        name: m.name,
        coverage: `${Math.round(m.coverage * 100)}%`,
        internal: internalIds.has(m.candidateId),
        why: m.why,
      })),
  };
}
