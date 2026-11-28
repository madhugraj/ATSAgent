/**
 * Profile-based matching (plan row 8, C1; docs/candidate-identification/track-a-design.md §4).
 *
 * Two passes per requisition, against the consolidated evidence profile:
 *
 * 1. Evidence pass over the whole eligible pool (no AI per candidate): each
 *    requirement is expanded once into the terms CVs use (cached per
 *    requisition), then every candidate's claims are searched — a hit inside a
 *    demonstrated claim counts more than a listed one, a bare CV-text hit least.
 *    Experience band, location and sector add their factors.
 * 2. Requirement review for the top K (tenant setting): one gateway call per
 *    candidate judges each requirement met / partial / missing and must cite
 *    the candidate's own claim ids as evidence. Citations are verified in code;
 *    the overall score is computed in code from the verdicts and the tenant's
 *    weights, never taken from the model.
 *
 * Scores are display and ranking only: nothing here moves a candidate, rejects
 * anyone or contacts anyone. Recruiters decide on the shortlist page.
 */
import { createHash } from "node:crypto";

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  applications,
  candidateClaims,
  candidateCvVersions,
  candidates,
  jdRequirementProfiles,
  profileMatchRuns,
  profileMatchScores,
  requisitions,
  type MatchEvidenceRef,
  type MatchFactor,
  type MatchKnockout,
  type MatchRequirement,
} from "@db/schema";
import type { RequirementProfile } from "@/lib/jd-requirements";
import { db } from "../db";
import { log } from "../log";

export type FactorKey = MatchFactor["key"];
export const DEFAULT_WEIGHTS: Record<FactorKey, number> = {
  must: 0.55,
  nice: 0.15,
  experience: 0.15,
  sector: 0.1,
  location: 0.05,
};
export const DEFAULT_TOP_K = 50;
const STRENGTH_WEIGHT = { demonstrated: 1, listed: 0.6, inferred: 0.4 } as const;
const TEXT_ONLY_WEIGHT = 0.35;
const JUDGE_CLAIMS_CAP = 120;

/* ------------------------------------------------------------ inputs */

export type PoolCandidate = {
  id: string;
  experienceYears: number;
  location: string | null;
  text: string;
  claims: {
    id: string;
    versionId: string;
    type: string;
    value: string;
    key: string;
    passage: string;
    strength: keyof typeof STRENGTH_WEIGHT;
  }[];
  stamp: string;
};

export type Expansion = { requirement: string; kind: "must" | "nice"; terms: string[] };

export function normaliseWeights(w?: Partial<Record<FactorKey, number>> | null) {
  const merged = { ...DEFAULT_WEIGHTS, ...(w ?? {}) };
  const total = Object.values(merged).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  return Object.fromEntries(
    Object.entries(merged).map(([k, v]) => [k, Math.max(0, v) / total]),
  ) as Record<FactorKey, number>;
}

/** Words that carry no matching signal inside a long requirement sentence. */
const STOP = new Set(
  "a an and or the of in on at to for with within across including such as e g eg ie other related experience years year professional strong proven ideally gained preferably ability skills skill knowledge understanding good excellent etc genuine interest background working environment capacity".split(
    " ",
  ),
);

/** Deterministic fallback terms for a requirement sentence (used with or without AI expansion). */
export function fallbackTerms(requirement: string): string[] {
  const parts = requirement
    .toLowerCase()
    .split(/[,;/()]| or | and /)
    .map((p) =>
      p
        .replace(/[^\p{L}\p{N}\s+#.-]/gu, " ")
        .split(/\s+/)
        .filter((w) => w && !STOP.has(w))
        .join(" ")
        .trim(),
    )
    .filter((p) => p.length >= 3 && p.split(" ").length <= 4);
  return [...new Set(parts)].slice(0, 12);
}

/* ----------------------------------------------------- evidence pass */

export type CoarseResult = {
  candidateId: string;
  score: number;
  factors: MatchFactor[];
  requirementHits: {
    requirement: string;
    kind: "must" | "nice";
    score: number;
    evidence: MatchEvidenceRef[];
  }[];
  knockouts: MatchKnockout[];
};

function termHit(hay: string, term: string): boolean {
  if (term.length <= 3) return new RegExp(`\\b${escapeRe(term)}\\b`, "i").test(hay);
  return hay.includes(term);
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function coarseScore(
  c: PoolCandidate,
  req: RequirementProfile,
  expansions: Expansion[],
  weights: Record<FactorKey, number>,
  sectorTerms: string[],
): CoarseResult {
  const hits = expansions.map((e) => {
    const terms = e.terms.map((t) => t.toLowerCase()).filter(Boolean);
    let best = 0;
    let ev: MatchEvidenceRef[] = [];
    for (const cl of c.claims) {
      const hay = `${cl.key} ${cl.passage.toLowerCase()}`;
      if (!terms.some((t) => termHit(hay, t))) continue;
      const w = STRENGTH_WEIGHT[cl.strength];
      if (w > best) {
        best = w;
        ev = [{ claimId: cl.id, versionId: cl.versionId, passage: cl.passage }];
      }
    }
    if (best === 0 && terms.some((t) => termHit(c.text, t))) best = TEXT_ONLY_WEIGHT;
    return { requirement: e.requirement, kind: e.kind, score: best, evidence: ev };
  });
  const avg = (k: "must" | "nice") => {
    const xs = hits.filter((h) => h.kind === k);
    return xs.length ? xs.reduce((a, h) => a + h.score, 0) / xs.length : null;
  };

  const knockouts: MatchKnockout[] = [];
  // Experience band: inside → 1; short of the minimum scales down; far over a
  // stated maximum is a soft mismatch, never a rejection.
  let experience = 0.5;
  const band = req.experienceYears;
  const yrs = c.experienceYears;
  if (band && (band.min != null || band.max != null) && yrs > 0) {
    const min = band.min ?? 0;
    const max = band.max ?? Infinity;
    if (yrs >= min && yrs <= max) experience = 1;
    else if (yrs < min) experience = Math.max(0, 1 - (min - yrs) / Math.max(min, 1));
    else experience = yrs <= max * 1.5 ? 0.7 : 0.4;
    if (yrs < min * 0.5)
      knockouts.push({ kind: "experience", detail: `${yrs} years vs ${min}+ required` });
  }

  // Location: remote roles always fit; otherwise the stated country or city.
  let location = 0.5;
  const loc = (c.location ?? "").toLowerCase();
  const country = (req.location.country ?? "").toLowerCase();
  const city = (req.location.city ?? "").toLowerCase();
  if (req.location.remotePolicy === "remote") location = 1;
  else if (country || city) {
    const near =
      (country && loc.includes(country)) ||
      (city && loc.includes(city)) ||
      (country === "uk" && /united kingdom|england|scotland|wales|london/.test(loc)) ||
      (country === "united kingdom" && /\buk\b|england|scotland|wales|london/.test(loc));
    location = !loc ? 0.5 : near ? 1 : 0.2;
    if (loc && !near && req.location.remotePolicy === "onsite")
      knockouts.push({
        kind: "location",
        detail: `${c.location} vs ${[city, country].filter(Boolean).join(", ")}`,
      });
  }

  // Sector: the JD's sector (and the tenant's matching taxonomy term) in the evidence.
  let sector = 0.5;
  const s = (req.sector ?? "").toLowerCase();
  if (s && s !== "unknown") {
    const terms = [
      s,
      ...sectorTerms.map((t) => t.toLowerCase()).filter((t) => t.includes(s) || s.includes(t)),
    ];
    const claimHit = c.claims.some((cl) =>
      terms.some((t) => termHit(`${cl.key} ${cl.passage.toLowerCase()}`, t)),
    );
    sector = claimHit ? 1 : terms.some((t) => termHit(c.text, t)) ? 0.7 : 0.1;
  }

  const must = avg("must");
  const nice = avg("nice");
  const factorList: [FactorKey, number | null, MatchEvidenceRef[]][] = [
    [
      "must",
      must,
      hits
        .filter((h) => h.kind === "must")
        .flatMap((h) => h.evidence)
        .slice(0, 6),
    ],
    [
      "nice",
      nice,
      hits
        .filter((h) => h.kind === "nice")
        .flatMap((h) => h.evidence)
        .slice(0, 4),
    ],
    ["experience", experience, []],
    ["sector", sector, []],
    ["location", location, []],
  ];
  // A factor the JD does not define does not count (its weight is redistributed).
  const present = factorList.filter(([, v]) => v !== null) as [
    FactorKey,
    number,
    MatchEvidenceRef[],
  ][];
  const wsum = present.reduce((a, [k]) => a + weights[k], 0) || 1;
  const score = present.reduce((a, [k, v]) => a + (weights[k] / wsum) * v, 0);
  return {
    candidateId: c.id,
    score: Math.round(score * 1000) / 1000,
    factors: present.map(([key, v, evidence]) => ({
      key,
      score: Math.round(v * 100) / 100,
      weight: Math.round((weights[key] / wsum) * 100) / 100,
      evidence,
    })),
    requirementHits: hits,
    knockouts,
  };
}

/* -------------------------------------------------- requirement review */

const JudgeSchema = z.object({
  requirements: z
    .array(
      z.object({
        id: z.string().max(8),
        verdict: z.enum(["met", "partial", "missing"]),
        claimIds: z.array(z.string().max(8)).max(6).default([]),
        note: z.string().max(240).nullish().catch(null),
      }),
    )
    .max(60),
  knockouts: z
    .array(
      z.object({
        kind: z.enum(["location", "right_to_work", "language", "experience"]),
        detail: z.string().max(200),
      }),
    )
    .max(6)
    .default([]),
  rationale: z.string().max(700),
});
type JudgeOut = z.infer<typeof JudgeSchema>;

const JUDGE_SYSTEM =
  "\nYou assess one candidate against one job's requirements for a recruiter. " +
  "For every requirement (ids R1, R2, …) give verdict met | partial | missing and cite the claim ids " +
  "(C1, C2, …) from the candidate profile that support it. Cite only claims that genuinely support the " +
  "requirement; with no supporting claim the verdict is missing. 'partial' means related but weaker or " +
  "narrower evidence. Equivalent wording counts (e.g. business development ≈ B2B sales). " +
  "List knockouts only for location, right to work, language or experience clearly in conflict with the job. " +
  "rationale: 2–3 plain sentences a recruiter can read, naming the strongest evidence and the main gap. " +
  "Judge only what the profile shows; never assume. Respond with JSON only.";

function stableId(prefix: string, i: number) {
  return `${prefix}${i + 1}`;
}

export function scoreFromVerdicts(
  reqs: MatchRequirement[],
  coarse: CoarseResult,
  weights: Record<FactorKey, number>,
): { overall: number; factors: MatchFactor[] } {
  const val = (r: MatchRequirement) =>
    r.verdict === "missing"
      ? 0
      : (r.verdict === "met" ? 1 : 0.5) * (r.strength ? STRENGTH_WEIGHT[r.strength] : 0.5);
  const avg = (k: "must" | "nice") => {
    const xs = reqs.filter((r) => r.kind === k);
    return xs.length ? xs.reduce((a, r) => a + val(r), 0) / xs.length : null;
  };
  const byKey = new Map(coarse.factors.map((f) => [f.key, f]));
  const parts: [FactorKey, number | null, MatchEvidenceRef[]][] = [
    [
      "must",
      avg("must"),
      reqs
        .filter((r) => r.kind === "must")
        .flatMap((r) => r.evidence)
        .slice(0, 8),
    ],
    [
      "nice",
      avg("nice"),
      reqs
        .filter((r) => r.kind === "nice")
        .flatMap((r) => r.evidence)
        .slice(0, 4),
    ],
    ["experience", byKey.get("experience")?.score ?? null, []],
    ["sector", byKey.get("sector")?.score ?? null, []],
    ["location", byKey.get("location")?.score ?? null, []],
  ];
  const present = parts.filter(([, v]) => v !== null) as [FactorKey, number, MatchEvidenceRef[]][];
  const wsum = present.reduce((a, [k]) => a + weights[k], 0) || 1;
  const overall = present.reduce((a, [k, v]) => a + (weights[k] / wsum) * v, 0);
  return {
    overall: Math.round(overall * 100),
    factors: present.map(([key, v, evidence]) => ({
      key,
      score: Math.round(v * 100) / 100,
      weight: Math.round((weights[key] / wsum) * 100) / 100,
      evidence,
    })),
  };
}

async function judgeCandidate(
  orgId: string,
  requisitionId: string,
  req: RequirementProfile,
  c: PoolCandidate,
  coarse: CoarseResult,
  weights: Record<FactorKey, number>,
): Promise<{
  overall: number;
  factors: MatchFactor[];
  requirements: MatchRequirement[];
  knockouts: MatchKnockout[];
  rationale: string;
} | null> {
  const reqList = [
    ...req.mustHave.map((r) => ({ text: r, kind: "must" as const })),
    ...req.niceToHave.map((r) => ({ text: r, kind: "nice" as const })),
  ];
  if (!reqList.length) return null;
  const claims = [...c.claims]
    .sort((a, b) => STRENGTH_WEIGHT[b.strength] - STRENGTH_WEIGHT[a.strength])
    .slice(0, JUDGE_CLAIMS_CAP);
  const job = [
    `Title: ${req.title}`,
    req.sector && req.sector !== "unknown" ? `Sector: ${req.sector}` : "",
    req.experienceYears
      ? `Experience: ${req.experienceYears.min ?? "?"}–${req.experienceYears.max ?? "?"} years`
      : "",
    `Location: ${[req.location.city, req.location.country].filter(Boolean).join(", ") || "unknown"} (${req.location.remotePolicy})`,
    req.rightToWork ? `Right to work: ${req.rightToWork}` : "",
    req.languages.length ? `Languages: ${req.languages.map((l) => l.name).join(", ")}` : "",
    ...reqList.map((r, i) => `${stableId("R", i)} [${r.kind}] ${r.text}`),
  ]
    .filter(Boolean)
    .join("\n");
  const profile = [
    `Experience years (parsed): ${c.experienceYears || "unknown"}`,
    `Location: ${c.location ?? "unknown"}`,
    ...claims.map(
      (cl, i) =>
        `${stableId("C", i)} ${cl.type} "${cl.value}" (${cl.strength}): ${cl.passage.slice(0, 220)}`,
    ),
    claims.length ? "" : `CV text: ${c.text.slice(0, 6000)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { aiJson, INJECTION_RULES, untrusted } = await import("@/lib/ai-gateway.server");
  const { withAiSubject } = await import("../agents/context");
  const res = await withAiSubject({ candidateId: c.id, requisitionId }, () =>
    aiJson<JudgeOut>({
      system: INJECTION_RULES + JUDGE_SYSTEM,
      prompt: `${untrusted("job_requirements", job)}\n\n${untrusted("candidate_profile", profile)}`,
      orgId,
      feature: "profile_match",
      schema: JudgeSchema,
    }),
  );
  if (!res.ok) return null;

  const byClaim = new Map(claims.map((cl, i) => [stableId("C", i), cl]));
  const byReq = new Map(res.data.requirements.map((r) => [r.id, r]));
  const requirements: MatchRequirement[] = reqList.map((r, i) => {
    const v = byReq.get(stableId("R", i));
    // Only citations that resolve to this candidate's claims count as evidence.
    const cited = (v?.claimIds ?? []).map((id) => byClaim.get(id)).filter((x) => x !== undefined);
    let verdict = v?.verdict ?? "missing";
    if (verdict !== "missing" && cited.length === 0 && claims.length > 0) verdict = "missing";
    const strength = cited.length
      ? cited.reduce<keyof typeof STRENGTH_WEIGHT>(
          (m, x) => (STRENGTH_WEIGHT[x.strength] > STRENGTH_WEIGHT[m] ? x.strength : m),
          "inferred",
        )
      : verdict === "missing"
        ? null
        : "listed";
    return {
      requirement: r.text,
      kind: r.kind,
      verdict,
      strength,
      evidence: cited.map((x) => ({ claimId: x.id, versionId: x.versionId, passage: x.passage })),
      note: v?.note ?? null,
    };
  });
  const { overall, factors } = scoreFromVerdicts(requirements, coarse, weights);
  const knockouts = dedupeKnockouts([...coarse.knockouts, ...res.data.knockouts]);
  return { overall, factors, requirements, knockouts, rationale: res.data.rationale.trim() };
}

function dedupeKnockouts(k: MatchKnockout[]): MatchKnockout[] {
  const seen = new Set<string>();
  return k.filter((x) => (seen.has(x.kind) ? false : (seen.add(x.kind), true)));
}

/* ------------------------------------------------------------ the run */

async function latestRequirementProfile(
  orgId: string,
  requisitionId: string,
): Promise<RequirementProfile | null> {
  const [row] = await db
    .select({ profile: jdRequirementProfiles.profile })
    .from(jdRequirementProfiles)
    .where(
      and(
        eq(jdRequirementProfiles.orgId, orgId),
        eq(jdRequirementProfiles.requisitionId, requisitionId),
      ),
    )
    .orderBy(desc(jdRequirementProfiles.createdAt))
    .limit(1);
  return row?.profile ?? null;
}

async function expansionsFor(
  orgId: string,
  requisitionId: string,
  req: RequirementProfile,
): Promise<Expansion[]> {
  const stamp = createHash("sha256")
    .update(JSON.stringify([req.title, req.mustHave, req.niceToHave]))
    .digest("hex")
    .slice(0, 16);
  const [run] = await db
    .select({ expansions: profileMatchRuns.expansions, stamp: profileMatchRuns.expansionsStamp })
    .from(profileMatchRuns)
    .where(
      and(eq(profileMatchRuns.requisitionId, requisitionId), eq(profileMatchRuns.orgId, orgId)),
    )
    .limit(1);
  if (run && run.stamp === stamp && run.expansions.length) return run.expansions;

  const reqs = [
    ...req.mustHave.map((r) => ({ requirement: r, kind: "must" as const })),
    ...req.niceToHave.map((r) => ({ requirement: r, kind: "nice" as const })),
  ];
  let ai: { skill: string; terms: string[] }[] = [];
  try {
    const { expandSkills } = await import("../agents/talent-search.server");
    ai = await expandSkills(
      orgId,
      req.title,
      reqs.map((r) => r.requirement),
    );
  } catch (e) {
    log.warn("profile_match.expand_failed", { org_id: orgId, error: e as Error });
  }
  const bySkill = new Map(ai.map((a) => [a.skill, a.terms]));
  const expansions = reqs.map((r) => ({
    ...r,
    terms: [
      ...new Set(
        [
          ...(bySkill.get(r.requirement) ?? []).filter((t) => t.length <= 60),
          ...fallbackTerms(r.requirement),
        ].map((t) => t.toLowerCase().trim()),
      ),
    ].slice(0, 20),
  }));
  await db
    .insert(profileMatchRuns)
    .values({ requisitionId, orgId, expansions, expansionsStamp: stamp })
    .onConflictDoUpdate({
      target: profileMatchRuns.requisitionId,
      set: { expansions, expansionsStamp: stamp, updatedAt: new Date() },
    });
  return expansions;
}

/** The eligible pool: org, not merged, consented, pool-use (or already applied to this role). */
export async function loadPool(orgId: string, requisitionId: string): Promise<PoolCandidate[]> {
  const applied = db
    .select({ id: applications.candidateId })
    .from(applications)
    .where(and(eq(applications.orgId, orgId), eq(applications.requisitionId, requisitionId)));
  const rows = await db
    .select({
      id: candidates.id,
      experienceYears: candidates.experienceYears,
      location: candidates.location,
      resumeText: candidates.resumeText,
      skills: candidates.skills,
    })
    .from(candidates)
    .where(
      and(
        eq(candidates.orgId, orgId),
        isNull(candidates.mergedIntoId),
        eq(candidates.consentGiven, true),
        or(eq(candidates.poolUse, "pool"), inArray(candidates.id, applied)),
      ),
    );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const claimRows: (typeof candidateClaims.$inferSelect & { vAt: Date })[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const part = await db
      .select({ c: candidateClaims, vAt: candidateCvVersions.createdAt })
      .from(candidateClaims)
      .innerJoin(candidateCvVersions, eq(candidateCvVersions.id, candidateClaims.versionId))
      .where(
        and(
          eq(candidateClaims.orgId, orgId),
          inArray(candidateClaims.candidateId, ids.slice(i, i + 1000)),
          eq(candidateCvVersions.accepted, true),
        ),
      );
    for (const p of part) claimRows.push({ ...p.c, vAt: p.vAt });
  }
  const byCand = new Map<string, typeof claimRows>();
  for (const c of claimRows) {
    const g = byCand.get(c.candidateId);
    if (g) g.push(c);
    else byCand.set(c.candidateId, [c]);
  }
  return rows.map((r) => {
    const cl = byCand.get(r.id) ?? [];
    const latest = cl.reduce((m, c) => Math.max(m, c.vAt.getTime()), 0);
    return {
      id: r.id,
      experienceYears: Number(r.experienceYears) || 0,
      location: r.location,
      text: `${(r.resumeText ?? "").slice(0, 30000)} ${(r.skills ?? []).join(" ")}`.toLowerCase(),
      claims: cl.map((c) => ({
        id: c.id,
        versionId: c.versionId,
        type: c.claimType,
        value: c.rawValue,
        key: c.normalisedValue,
        passage: c.passage,
        strength: c.evidenceStrength,
      })),
      stamp: `${cl.length}:${latest}:${r.experienceYears}:${r.location ?? ""}`,
    };
  });
}

export type RunOutcome = {
  status: "done" | "deferred" | "no_profile" | "not_approved";
  pool: number;
  judged: number;
};

/** Rank the whole pool for one requisition; review the top K. Idempotent. */
export async function runRequisitionMatch(
  orgId: string,
  requisitionId: string,
  opts: { topK?: number; weights?: Partial<Record<FactorKey, number>> | null } = {},
): Promise<RunOutcome> {
  const [rq] = await db
    .select({ status: requisitions.status })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!rq || rq.status !== "approved") return { status: "not_approved", pool: 0, judged: 0 };
  const req = await latestRequirementProfile(orgId, requisitionId);
  if (!req) return { status: "no_profile", pool: 0, judged: 0 };

  const { profileOf } = await import("@/lib/capabilities.server");
  const settings = (await profileOf(orgId)).settings;
  const weights = normaliseWeights(opts.weights ?? settings.profileMatchWeights);
  const topK = opts.topK ?? settings.profileMatchTopK ?? DEFAULT_TOP_K;

  const expansions = await expansionsFor(orgId, requisitionId, req);
  const { sectorTerms } = await import("@/lib/jd-import.server");
  const sectors = await sectorTerms(orgId).catch(() => [] as string[]);
  const pool = await loadPool(orgId, requisitionId);
  const coarse = pool
    .map((c) => ({ c, r: coarseScore(c, req, expansions, weights, sectors) }))
    .sort((a, b) => b.r.score - a.r.score);

  const existing = await db
    .select({
      candidateId: profileMatchScores.candidateId,
      stage: profileMatchScores.reviewStage,
      stamp: profileMatchScores.profileStamp,
    })
    .from(profileMatchScores)
    .where(
      and(eq(profileMatchScores.orgId, orgId), eq(profileMatchScores.requisitionId, requisitionId)),
    );
  const prior = new Map(existing.map((e) => [e.candidateId, e]));

  // Evidence pass for everyone: upsert coarse fields, keep judged results.
  for (let i = 0; i < coarse.length; i += 500) {
    const chunk = coarse.slice(i, i + 500).map(({ c, r }, j) => ({
      orgId,
      requisitionId,
      candidateId: c.id,
      coarseScore: String(r.score),
      coarseRank: i + j + 1,
      factors: r.factors,
      knockouts: r.knockouts,
      computedAt: new Date(),
    }));
    await db
      .insert(profileMatchScores)
      .values(chunk)
      .onConflictDoUpdate({
        target: [profileMatchScores.requisitionId, profileMatchScores.candidateId],
        set: {
          coarseScore: sql`excluded.coarse_score`,
          coarseRank: sql`excluded.coarse_rank`,
          computedAt: sql`excluded.computed_at`,
          factors: sql`case when ${profileMatchScores.reviewStage} = 'judged' then ${profileMatchScores.factors} else excluded.factors end`,
          knockouts: sql`case when ${profileMatchScores.reviewStage} = 'judged' then ${profileMatchScores.knockouts} else excluded.knockouts end`,
        },
      });
  }

  // Requirement review for the top K whose profile changed (or never reviewed).
  const top = coarse.slice(0, topK).filter(({ c }) => {
    const p = prior.get(c.id);
    return !p || p.stage !== "judged" || p.stamp !== c.stamp;
  });
  const { spendCapRefusal } = await import("../ai-spend-cap");
  let judged = 0;
  let deferred = false;
  const queue = [...top];
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      if (deferred || (await spendCapRefusal(orgId))) {
        deferred = true;
        return;
      }
      try {
        const j = await judgeCandidate(orgId, requisitionId, req, it.c, it.r, weights);
        if (!j) continue;
        await db
          .update(profileMatchScores)
          .set({
            reviewStage: "judged",
            overallScore: j.overall,
            factors: j.factors,
            requirements: j.requirements,
            knockouts: j.knockouts,
            rationale: j.rationale,
            profileStamp: it.c.stamp,
            judgedAt: new Date(),
          })
          .where(
            and(
              eq(profileMatchScores.orgId, orgId),
              eq(profileMatchScores.requisitionId, requisitionId),
              eq(profileMatchScores.candidateId, it.c.id),
            ),
          );
        judged++;
      } catch (e) {
        log.warn("profile_match.judge_failed", {
          org_id: orgId,
          candidate_id: it.c.id,
          error: e as Error,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));

  await db
    .update(profileMatchRuns)
    .set({
      status: deferred ? "queued" : "idle",
      poolSize: pool.length,
      judged: sql`${profileMatchRuns.judged} + ${judged}`,
      lastRunAt: new Date(),
      lastError: deferred ? "spend_cap" : null,
      updatedAt: new Date(),
    })
    .where(eq(profileMatchRuns.requisitionId, requisitionId));
  return { status: deferred ? "deferred" : "done", pool: pool.length, judged };
}

/** Mark a requisition for (re)ranking on the next tick. */
export async function requestRequisitionMatch(orgId: string, requisitionId: string): Promise<void> {
  await db
    .insert(profileMatchRuns)
    .values({ requisitionId, orgId, status: "queued", requestedAt: new Date() })
    .onConflictDoUpdate({
      target: profileMatchRuns.requisitionId,
      set: { status: "queued", requestedAt: new Date(), updatedAt: new Date() },
    });
}

/** New evidence arrived for these organisations: re-rank their open, profiled requisitions. */
export async function queueMatchesForOrgs(orgIds: string[]): Promise<void> {
  if (!orgIds.length) return;
  await db.execute(sql`
    update profile_match_runs r set status = 'queued', requested_at = now(), updated_at = now()
    from requisitions q
    where q.id = r.requisition_id and q.status = 'approved'
      and r.org_id in (${sql.join(
        orgIds.map((o) => sql`${o}`),
        sql`, `,
      )})
      and r.status = 'idle'
  `);
}

/**
 * Tick: discover approved requisitions with a requirement profile that were
 * never ranked (bulk JD import creates these), then run queued ones.
 */
export async function drainProfileMatches(
  opts: { limit?: number } = {},
): Promise<Record<string, number>> {
  await db.execute(sql`
    insert into profile_match_runs (requisition_id, org_id, status, requested_at)
    select distinct p.requisition_id, p.org_id, 'queued', now()
    from jd_requirement_profiles p
    join requisitions q on q.id = p.requisition_id and q.org_id = p.org_id
    where q.status = 'approved'
      and not exists (select 1 from profile_match_runs r where r.requisition_id = p.requisition_id)
    on conflict (requisition_id) do nothing
  `);
  const claimed = (await db.execute(sql`
    update profile_match_runs set status = 'running', updated_at = now()
    where requisition_id in (
      select requisition_id from profile_match_runs
      where (status = 'queued' or (status = 'running' and updated_at < now() - interval '20 minutes'))
        -- Hold ranking while the organisation is still importing or extracting
        -- evidence: ranking a half-filled pool is redone as soon as it grows.
        and not exists (
          select 1 from candidate_archive_imports m
          where m.org_id = profile_match_runs.org_id and m.status in ('staging', 'running'))
        and not exists (
          select 1 from candidate_cv_versions v
          where v.org_id = profile_match_runs.org_id
            and v.extraction_status in ('pending', 'running'))
      order by requested_at nulls last
      limit ${opts.limit ?? 2}
      for update skip locked
    )
    returning requisition_id, org_id
  `)) as unknown as { rows?: Row[] } | Row[];
  type Row = { requisition_id: string; org_id: string };
  const runs: Row[] = Array.isArray(claimed) ? claimed : (claimed.rows ?? []);
  const counts: Record<string, number> = { runs: runs.length, judged: 0 };
  for (const r of runs) {
    try {
      const out = await runRequisitionMatch(r.org_id, r.requisition_id);
      counts["judged"]! += out.judged;
      counts[out.status] = (counts[out.status] ?? 0) + 1;
      if (out.status === "no_profile" || out.status === "not_approved")
        await db
          .update(profileMatchRuns)
          .set({ status: "idle", updatedAt: new Date() })
          .where(eq(profileMatchRuns.requisitionId, r.requisition_id));
    } catch (e) {
      log.warn("profile_match.run_failed", {
        org_id: r.org_id,
        requisition_id: r.requisition_id,
        error: e as Error,
      });
      await db
        .update(profileMatchRuns)
        .set({ status: "failed", lastError: "run_failed", updatedAt: new Date() })
        .where(eq(profileMatchRuns.requisitionId, r.requisition_id));
    }
  }
  return counts;
}
