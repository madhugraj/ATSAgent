import { aiJson, INJECTION_RULES, untrusted } from "./ai-gateway.server";
import {
  careerScore,
  computeCareerMetrics,
  type CareerAssessment,
  type CareerMetrics,
  type EmploymentRow,
} from "./career";
import { logisticsCheck, type LogisticsCheck, type LogisticsRequisition } from "./logistics";
import {
  blendSocial,
  fetchGithubSignal,
  fetchLinkedinSignal,
  fetchWritingSignal,
  type SocialSignal,
} from "./social.server";

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export type JdInputShape = {
  title: string;
  mustHave: string[];
  goodToHave: string[];
  responsibilities?: string | null | undefined;
  education?: string | null | undefined;
  experienceMin: number;
  experienceMax: number;
  jdText?: string | null | undefined;
  /** Practical constraints — used for logistics flags only, never for the score. */
  constraints?: LogisticsRequisition | null | undefined;
};

export type CandidateInputShape = {
  name: string;
  skills: string[];
  experienceYears: number;
  education?: string | null | undefined;
  resumeText?: string | null | undefined;
  linkedinUrl?: string | null | undefined;
  githubUrl?: string | null | undefined;
  websiteUrl?: string | null | undefined;
  xUrl?: string | null | undefined;
  linkedinProfileText?: string | null | undefined;
  /** Previously fetched social signals — reused instead of re-fetching. */
  cachedSocial?: SocialSignal[] | null | undefined;
  /** Logistics facts on file (notice, CTC, location, authorisation). */
  noticePeriodDays?: number | null | undefined;
  currentCtc?: number | null | undefined;
  expectedCtc?: number | null | undefined;
  location?: string | null | undefined;
  preferredLocations?: string[] | null | undefined;
  willingToRelocate?: boolean | null | undefined;
  workAuthorization?: string | null | undefined;
};

export type Weights = {
  skills: number;
  experience: number;
  career: number;
  impact: number;
  education: number;
  social: number;
};

export const DEFAULT_WEIGHTS: Weights = {
  skills: 40,
  experience: 15,
  career: 10,
  impact: 10,
  education: 10,
  social: 15,
};

export type MatchResult = {
  skills_score: number;
  experience_score: number;
  career_score: number;
  impact_score: number;
  innovation_score: number;
  /** Weighted blend of impact (60) and innovation (40) — the scored dimension. */
  impact_innovation_score: number;
  education_score: number;
  social_score: number;
  overall_score: number;
  weights: Weights;
  matched_skills: string[];
  missing_skills: string[];
  transferable_skills: string[];
  rationale: string;
  risk_flags: string[];
  recommendation: "select" | "reject" | "hold";
  social: { blended: number; basis: string; signals: SocialSignal[]; cached: boolean };
  career: {
    metrics: CareerMetrics;
    assessment: CareerAssessment;
    history: EmploymentRow[];
  };
  impact: {
    highlights: string[];
    innovation_signals: string[];
    rationale: string;
  };
  logistics: LogisticsCheck | null;
  contributions: { label: string; raw: number; weight: number; weighted: number }[];
  /** Server-internal — stripped from every wire return, resolved server-side on persist. */
  model: string;
};

/** The client-facing shape: everything but the engine id. */
export type MatchWire = Omit<MatchResult, "model">;

/**
 * Harvest public profile links straight out of the raw CV text.
 * Recruiter-entered fields always win; this only fills the blanks so a resume
 * that merely *mentions* github.com/foo still gets crawled and scored.
 */
export function harvestProfileLinks(resumeText: string | null | undefined) {
  const text = resumeText ?? "";
  const pick = (re: RegExp) => {
    const m = text.match(re);
    return m ? `https://${m[0].replace(/^https?:\/\//i, "").replace(/[).,;]+$/, "")}` : null;
  };
  return {
    githubUrl: pick(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9-_.]+/i),
    linkedinUrl: pick(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9-_%]+/i),
    xUrl: pick(/(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9-_]+/i),
    websiteUrl: pick(
      /(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9-]+\.(?:dev|io|me|blog|substack\.com|medium\.com)(?:\/[A-Za-z0-9-_/.]*)?/i,
    ),
  };
}

/** Deterministic experience band score — auditable, never AI-guessed. */
export function experienceScore(years: number, min: number, max: number) {
  if (years >= min && years <= max) return 100;
  if (years < min) return clamp(100 - (min - years) * 22);
  return clamp(100 - (years - max) * 10);
}

/**
 * Score one CV against one JD. Shared by the single-candidate server fn and the
 * bulk pipeline run so both produce byte-identical, auditable numbers.
 */
export async function scoreCandidate(opts: {
  jd: JdInputShape;
  candidate: CandidateInputShape;
  weights: Weights;
  includeSocial: boolean;
  /** Org context for AI credential resolution. */
  orgId?: string | null | undefined;
}): Promise<MatchResult> {
  const { jd, candidate, weights } = opts;

  // The employer's approved profile (O2): what the organisation actually does,
  // so domain experience is judged against the employer's real world, not a
  // generic one. Fenced as data; it never replaces the stated requirements.
  let organisationContext: string | null = null;
  if (opts.orgId) {
    const { orgContextFor } = await import("./org-context.server");
    organisationContext = (
      await orgContextFor({ orgId: opts.orgId, audience: "internal", purpose: "scoring" })
    ).blocks;
  }

  /* 1 — AI extraction + semantic assessment (skills, education, history, impact). */
  const ai = await aiJson<{
    skills_score: number;
    education_score: number;
    matched_skills: string[];
    missing_skills: string[];
    transferable_skills: string[];
    risk_flags: string[];
    rationale: string;
    employment_history: EmploymentRow[];
    skill_recency_years: number | null;
    impact_score: number;
    innovation_score: number;
    impact_highlights: string[];
    innovation_signals: string[];
    impact_rationale: string;
  }>({
    feature: "candidate_score",
    system:
      INJECTION_RULES +
      "\nYou are a rigorous technical recruiter mapping a CV against a job description. " +
      "Judge semantic equivalence (e.g. 'EKS' evidences 'Kubernetes'), require evidence from the resume text, " +
      "and never credit a must-have skill that is only listed but never demonstrated — flag that instead. " +
      "skills_score weights must-have coverage far above good-to-have. " +
      "education_score reflects fit against the stated qualification requirement (return 70 if no requirement is stated). " +
      (organisationContext
        ? "organisation_context is approved fact about the employer — weigh domain experience against it (a project or stack that looks unusual elsewhere may be standard there) and cite the matching line in the rationale when it changes your judgement. It never replaces the stated requirements.\n"
        : "") +
      "ALSO extract, never invent:\n" +
      "• employment_history: every role as {company, title, start, end, level_hint}. Use YYYY-MM (or YYYY) for " +
      "start/end; use null for end when the role is current. Omit a role entirely only if neither company nor title " +
      "is stated. Keep chronological order.\n" +
      "• skill_recency_years: how many years ago the JD's core must-have skills were last used in a role " +
      "(0 if used in the current role, null if it cannot be told).\n" +
      "• impact_score (0-100): reward quantified outcomes (metrics, %, scale, revenue/cost/latency/users), " +
      "genuine ownership ('built/owned/led' with scope, team size, budget) and complexity (greenfield, migrations, " +
      "incident ownership). Punish pure task-listing and responsibility copy-paste with no outcome.\n" +
      "• innovation_score (0-100): patents, publications, conference talks, open-source work, hackathons, dated " +
      "certifications, self-taught pivots, new technology adopted per year, side projects, and evidence of " +
      "inventing a process or product rather than only executing one. 0 only when there is no such evidence at all.\n" +
      "• impact_highlights and innovation_signals: 2-5 short strings each, quoting the CV evidence.\n" +
      "Return ONLY JSON with keys: skills_score, education_score, matched_skills, missing_skills, " +
      "transferable_skills, risk_flags (short strings), rationale (3-4 sentences, cite evidence), " +
      "employment_history, skill_recency_years, impact_score, innovation_score, impact_highlights, " +
      "innovation_signals, impact_rationale (2-3 sentences).",
    prompt: untrusted(
      "job_description_and_candidate",
      JSON.stringify({
        job_description: jd,
        candidate: { ...candidate, cachedSocial: undefined },
        ...(organisationContext ? { organisation_context: organisationContext } : {}),
      }),
    ),
    orgId: opts.orgId,
  });
  if (!ai.ok) throw new Error(ai.message);

  /* 2 — Social profiling: reuse cached signals when the recruiter has them. */
  const harvested = harvestProfileLinks(candidate.resumeText);
  const links = {
    githubUrl: candidate.githubUrl || harvested.githubUrl,
    linkedinUrl: candidate.linkedinUrl || harvested.linkedinUrl,
    websiteUrl: candidate.websiteUrl || harvested.websiteUrl,
    xUrl: candidate.xUrl || harvested.xUrl,
  };
  const discovered = (Object.keys(links) as (keyof typeof links)[])
    .filter((k) => !candidate[k] && links[k])
    .map((k) => `${k.replace("Url", "")}: ${links[k]}`);

  let signals: SocialSignal[] = [];
  let cached = false;
  if (opts.includeSocial) {
    if (candidate.cachedSocial?.length) {
      signals = candidate.cachedSocial;
      cached = true;
    } else {
      const jdSkills = [...jd.mustHave, ...jd.goodToHave];
      const settled = await Promise.all([
        fetchGithubSignal(links.githubUrl ?? null, jdSkills),
        fetchLinkedinSignal({
          orgId: opts.orgId,
          url: links.linkedinUrl ?? null,
          jobTitle: jd.title,
          jdSkills,
          resumeText: candidate.resumeText ?? null,
          profileText: candidate.linkedinProfileText ?? null,
        }),
        fetchWritingSignal({
          orgId: opts.orgId,
          urls: [links.websiteUrl ?? "", links.xUrl ?? ""].filter(Boolean),
          jobTitle: jd.title,
          jdSkills,
        }),
      ]);
      signals = settled.filter((s): s is SocialSignal => s !== null);
    }
  }

  const social = blendSocial(signals);

  /* 3 — Career history: AI extracts the roles, TypeScript does the maths. */
  const history = (ai.data.employment_history ?? []).filter((r) => r && (r.company || r.title));
  const careerMetrics = computeCareerMetrics(history, {
    skillRecencyYears: ai.data.skill_recency_years ?? null,
  });
  const career = careerScore(careerMetrics);

  /* 4 — Impact & innovation, blended 60/40 into one scored dimension. */
  const impact = clamp(ai.data.impact_score);
  const innovation = clamp(ai.data.innovation_score);
  const impactInnovation = clamp(impact * 0.6 + innovation * 0.4);

  /* 5 — Logistics: flags and blockers only, never part of the score. */
  const logistics = jd.constraints
    ? logisticsCheck(
        {
          noticePeriodDays: candidate.noticePeriodDays ?? null,
          currentCtc: candidate.currentCtc ?? null,
          expectedCtc: candidate.expectedCtc ?? null,
          location: candidate.location ?? null,
          preferredLocations: candidate.preferredLocations ?? null,
          willingToRelocate: candidate.willingToRelocate ?? null,
          workAuthorization: candidate.workAuthorization ?? null,
        },
        jd.constraints,
      )
    : null;

  /* 6 — Deterministic weighted roll-up. */
  const skills = clamp(ai.data.skills_score);
  const education = clamp(ai.data.education_score);
  const experience = experienceScore(candidate.experienceYears, jd.experienceMin, jd.experienceMax);

  const parts = [
    { label: "Skills", raw: skills, weight: weights.skills },
    { label: "Experience", raw: experience, weight: weights.experience },
    { label: "Career history", raw: career.score, weight: weights.career },
    { label: "Impact & innovation", raw: impactInnovation, weight: weights.impact },
    { label: "Education", raw: education, weight: weights.education },
    { label: "Social profile", raw: social.score, weight: weights.social },
  ];
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0) || 100;
  const contributions = parts.map((p) => ({
    ...p,
    weighted: Math.round((p.raw * p.weight) / totalWeight),
  }));
  const overall = clamp(contributions.reduce((s, p) => s + p.weighted, 0));

  const riskFlags = [...(ai.data.risk_flags ?? []), ...career.flags];
  if (candidate.experienceYears < jd.experienceMin)
    riskFlags.push("Below requisition experience band");
  if (opts.includeSocial && !signals.some((s) => s.status === "ok"))
    riskFlags.push("No verifiable public profile signal — social score defaulted to 0");

  return {
    skills_score: skills,
    experience_score: experience,
    career_score: career.score,
    impact_score: impact,
    innovation_score: innovation,
    impact_innovation_score: impactInnovation,
    education_score: education,
    social_score: social.score,
    overall_score: overall,
    weights,
    matched_skills: ai.data.matched_skills ?? [],
    missing_skills: ai.data.missing_skills ?? [],
    transferable_skills: ai.data.transferable_skills ?? [],
    rationale: ai.data.rationale,
    risk_flags: [...new Set(riskFlags)],
    recommendation: overall >= 75 ? "select" : overall >= 60 ? "hold" : "reject",
    social: {
      blended: social.score,
      basis:
        discovered.length > 0
          ? `${social.basis} · auto-discovered from CV → ${discovered.join(", ")}`
          : social.basis,
      signals,
      cached,
    },
    career: { metrics: careerMetrics, assessment: career, history },
    impact: {
      highlights: ai.data.impact_highlights ?? [],
      innovation_signals: ai.data.innovation_signals ?? [],
      rationale: ai.data.impact_rationale ?? "",
    },
    logistics,
    contributions,
    model: ai.model,
  };
}

/** Run an async mapper over a list with a hard concurrency ceiling. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
