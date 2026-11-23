/**
 * Talent-pool search by meaning, not exact skill names (docs/agentic-plan.md
 * §13). The requisition's must-haves (and title) are expanded once into
 * equivalent terms — "LLM" → "large language models", "GenAI", "transformers"
 * — then the organisation's pool is searched on parsed skills AND the CV
 * text, and ranked by evidence: a must-have found in the skills list counts
 * most, a mention in the CV text counts too, the experience band and the
 * location break ties. The AI scoring that follows (score_new_applications)
 * judges real fit; this only decides who is worth scoring.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { aiJson } from "@/lib/ai-gateway.server";
import { db } from "../db";
import { applications, candidates, requisitions } from "@db/schema";

export type PoolMatch = {
  candidateId: string;
  name: string;
  experienceYears: number;
  location: string | null;
  /** Must-haves (or their equivalents) found in the parsed skills. */
  skillHits: string[];
  /** Must-haves (or their equivalents) mentioned in the CV text. */
  textHits: string[];
  score: number;
  why: string;
  /** True when the candidate's experience sits inside (or within the grace of) the band. */
  inBand: boolean;
};

const Expansion = z.object({
  groups: z
    .array(
      z.object({
        skill: z.string(),
        equivalents: z.array(z.string().min(2).max(60)).max(8),
      }),
    )
    .max(20),
});

/**
 * The parts of a compound skill — "Python or TypeScript" → Python, TypeScript;
 * "Cloud deployment (Docker, Kubernetes)" → Cloud deployment, Docker,
 * Kubernetes — so a CV listing the parts still counts, with or without AI.
 */
export function skillParts(skill: string): string[] {
  const parts = skill
    .split(/\s*(?:[,/;()]|\bor\b|\band\b|&)\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && p.toLowerCase() !== skill.toLowerCase());
  return parts.length > 1 || (parts.length === 1 && parts[0] !== skill) ? parts : [];
}

/** Each must-have with its equivalents; falls back to the skill itself if AI is unavailable. */
export async function expandSkills(
  orgId: string,
  title: string,
  mustHave: string[],
): Promise<{ skill: string; terms: string[] }[]> {
  const base = mustHave.map((s) => ({ skill: s, terms: [s, ...skillParts(s)] }));
  if (!mustHave.length) return base;
  const res = await aiJson({
    orgId,
    feature: "talent_search",
    schema: Expansion,
    system:
      "You expand recruiting skill requirements into the equivalent terms that appear in CVs. " +
      "For each skill give up to 8 equivalents: synonyms, abbreviations and expansions, closely related " +
      "technologies that evidence the same capability, and common spellings. No generic words " +
      '("software", "engineering", "experience"). Return ONLY JSON: {"groups":[{"skill","equivalents":[...]}]}.',
    prompt: JSON.stringify({ role: title, skills: mustHave }),
  });
  if (!res.ok) return base;
  return mustHave.map((skill) => {
    const g = res.data.groups.find((x) => x.skill.toLowerCase() === skill.toLowerCase());
    const terms = [skill, ...skillParts(skill), ...(g?.equivalents ?? [])]
      .map((t) => t.trim())
      .filter(
        (t, i, all) =>
          t.length >= 2 && all.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i,
      );
    return { skill, terms };
  });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** Whole-word, case-insensitive test (so "Go" does not match "good"). */
const mentions = (text: string, term: string) =>
  new RegExp(
    `(^|[^\\p{L}\\p{N}+#])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}+#])`,
    "iu",
  ).test(text);

/** Rank pool candidates against expanded must-haves. Pure — unit-tested. */
export function rankPool(
  pool: {
    candidateId: string;
    name: string;
    experienceYears: number;
    location: string | null;
    skills: string[];
    resumeText: string | null;
    currentEmployer: string | null;
  }[],
  groups: { skill: string; terms: string[] }[],
  req: { experienceMin: number; experienceMax: number; location: string | null },
): PoolMatch[] {
  const locWords = (req.location ?? "")
    .toLowerCase()
    .split(/[,/·]|\band\b/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
  return (
    pool
      .map((c) => {
        const skillsText = c.skills.join(" · ");
        const cv = `${c.resumeText ?? ""}\n${c.currentEmployer ?? ""}`;
        const skillHits: string[] = [];
        const textHits: string[] = [];
        for (const g of groups) {
          if (g.terms.some((t) => mentions(skillsText, t))) skillHits.push(g.skill);
          else if (g.terms.some((t) => mentions(cv, t))) textHits.push(g.skill);
        }
        const exp = c.experienceYears;
        // The band is literal: a max of 0 is a fresher-only role (3-year grace on
        // both edges), never "no limit" — the requisition form is a plain number.
        const inBand = exp >= req.experienceMin - 1 && exp <= req.experienceMax + 3;
        const nearLoc = !!c.location && locWords.some((w) => c.location!.toLowerCase().includes(w));
        const score =
          skillHits.length * 3 + textHits.length * 2 + (inBand ? 1 : 0) + (nearLoc ? 1 : 0);
        const why = [
          skillHits.length ? `skills: ${skillHits.join(", ")}` : "",
          textHits.length ? `in CV: ${textHits.join(", ")}` : "",
          `${exp} yrs${inBand ? "" : " (outside the band)"}`,
          nearLoc ? `in ${c.location}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return {
          candidateId: c.candidateId,
          name: c.name,
          experienceYears: exp,
          location: c.location,
          skillHits,
          textHits,
          score,
          why,
          inBand,
        };
      })
      .filter((m) => m.skillHits.length + m.textHits.length > 0)
      // The band comes before evidence: a fresher band is not topped up by a
      // 19-year VP whose CV happens to hit every must-have.
      .sort(
        (a, b) =>
          Number(b.inBand) - Number(a.inBand) || b.score - a.score || a.name.localeCompare(b.name),
      )
  );
}

/** People in the org's pool, not yet in this requisition's pipeline, worth scoring. */
export async function searchTalentPool(
  orgId: string,
  requisitionId: string,
  limit = 10,
): Promise<{ searchedFor: { skill: string; terms: string[] }[]; matches: PoolMatch[] }> {
  const [req] = await db
    .select({
      title: requisitions.title,
      mustHave: requisitions.mustHaveSkills,
      location: requisitions.location,
      experienceMin: requisitions.experienceMin,
      experienceMax: requisitions.experienceMax,
    })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!req) throw new Error("Requisition not found.");
  const inPipeline = db
    .select({ id: applications.candidateId })
    .from(applications)
    .where(and(eq(applications.requisitionId, requisitionId), eq(applications.orgId, orgId)));
  return searchPoolBySkills(
    orgId,
    {
      title: req.title,
      mustHave: req.mustHave ?? [],
      location: req.location,
      experienceMin: req.experienceMin,
      experienceMax: req.experienceMax,
    },
    limit,
    sql`${candidates.id} not in (${inPipeline})`,
  );
}

/**
 * The same search for a skill bundle with no requisition yet ("do we already
 * have people for this role?"). `exclude` narrows the pool further.
 */
export async function searchPoolBySkills(
  orgId: string,
  want: {
    title: string;
    mustHave: string[];
    location: string | null;
    experienceMin: number;
    experienceMax: number;
  },
  limit = 10,
  exclude?: SQL,
): Promise<{ searchedFor: { skill: string; terms: string[] }[]; matches: PoolMatch[] }> {
  const groups = await expandSkills(orgId, want.title, want.mustHave);
  const terms = [...new Set(groups.flatMap((g) => g.terms).map((t) => t.toLowerCase()))].slice(
    0,
    60,
  );
  if (!terms.length) return { searchedFor: groups, matches: [] };
  // Coarse database filter (any term in skills or CV text); exact ranking below.
  const pool = await db
    .select({
      candidateId: candidates.id,
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
        // CVs a portal limited to their own role are never reused (migration 0045).
        eq(candidates.poolUse, "pool"),
        ...(exclude ? [exclude] : []),
        sql`(${sql.join(
          terms.map(
            (t) =>
              sql`(exists (select 1 from unnest(${candidates.skills}) s where s ilike ${`%${escapeLike(t)}%`}) or ${candidates.resumeText} ilike ${`%${escapeLike(t)}%`})`,
          ),
          sql` or `,
        )})`,
      ),
    )
    .limit(500);
  const matches = rankPool(
    pool.map((p) => ({
      ...p,
      experienceYears: Number(p.experienceYears ?? 0),
      skills: p.skills ?? [],
    })),
    groups,
    {
      experienceMin: want.experienceMin,
      experienceMax: want.experienceMax,
      location: want.location,
    },
  ).slice(0, limit);
  return { searchedFor: groups, matches };
}
