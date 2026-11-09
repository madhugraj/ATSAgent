import { and, eq, inArray, sql } from "drizzle-orm";
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { applications, matchScores, socialProfiles, sourceIntegrations } from "@db/schema";
import { requireIdentity, requireOrg } from "./auth.middleware";
import { aiJson, INJECTION_RULES, untrusted, type AiConfig } from "./ai-gateway.server";
import { normaliseAdvice, type WeightAdvice } from "./weight-advice";
import {
  buildTemplateSystemPrompt,
  resolveTemplate,
  stripUnreplacedPlaceholders,
} from "./templates.server";
import {
  DIRECTION_MISMATCH_FLAG,
  gatedRecommendation,
  INJECTION_HOLD_FLAG,
  LEVEL_MISMATCH_FLAG,
  mapWithConcurrency,
  scoreCandidate,
  type MatchResult,
  type MatchWire,
} from "./matching.server";
import { CTC_CEILING_BLOCKER } from "./logistics";
import { type SocialSignal } from "./social.server";

export type { MatchWire };

/* ------------------------------------------------------------------ JD gen */

const JdInput = z.object({
  title: z.string().min(1),
  department: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  experienceMin: z.number(),
  experienceMax: z.number(),
  mustHave: z.array(z.string()),
  goodToHave: z.array(z.string()),
  responsibilities: z.string().optional().nullable(),
  education: z.string().optional().nullable(),
  reportingTo: z.string().optional().nullable(),
  templateId: z.string().uuid().optional().nullable(),
});

const BASE_JD_SYSTEM =
  "You are an expert talent-acquisition writer. Draft a complete, specific job description that a strong " +
  "candidate would recognise as written by someone who understands the role. Calibrate depth to seniority: " +
  "for senior and leadership roles (10+ years, Director, VP, Head, Principal) cover strategy, scope " +
  "(teams, budget, stakeholders), the decisions the person owns and how success is measured; for other roles " +
  "focus on the work, the stack and the standards. Build on the responsibilities, reporting line, success " +
  "measures and education given in the data — keep their substance, make them concrete; where the data asks " +
  "you to draft them from typical market practice, do so for this exact role and seniority. Never invent " +
  "company facts (products, revenue, team names) or a salary. " +
  "The data may carry organisation_context: the employer's approved profile. Write the “About us” section " +
  "only from its candidate-visible lines — never from your own knowledge and never from an internal-only " +
  "line — and keep its never-say rules. When it says there is no approved profile, write no company " +
  "claims at all beyond the role itself. " +
  "Return ONLY JSON with keys: purpose (2-3 sentences: why the role exists and its impact), " +
  "responsibilities (markdown bullet list — 8 to 12 specific bullets for senior roles, 6 to 8 otherwise), " +
  "must_have (string array), good_to_have (string array), qualifications, " +
  "success_factors (what good looks like at 6 and 12 months), reporting_to, " +
  "full_text (the full JD as markdown with sections: About us, About the role, What you will do, " +
  "What you will bring, Nice to have, What success looks like, Reporting line). No fluff, no buzzwords, no emojis.";

const stripAll = <T>(value: T): T => {
  if (typeof value === "string") return stripUnreplacedPlaceholders(value) as T;
  if (Array.isArray(value)) return value.map((v) => stripAll(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripAll(v)])) as T;
  }
  return value;
};

export type GeneratedJd = {
  purpose: string;
  responsibilities: string;
  must_have: string[];
  good_to_have: string[];
  qualifications: string;
  success_factors: string;
  reporting_to: string;
  full_text: string;
};

/** Draft a JD with the org's template; shared by the server fn and the JD agent. */
export const generateJdCore = createServerOnlyFn(async function generateJdCore(
  orgId: string,
  data: z.infer<typeof JdInput>,
): Promise<GeneratedJd> {
  const template = await resolveTemplate(orgId, "jd", data.templateId);
  // The employer's approved profile feeds the “About us” section (O2); it is
  // third-party-derived text, so it enters the prompt fenced as data.
  const { orgContextFor, NO_PROFILE_LINE } = await import("./org-context.server");
  const org = await orgContextFor({ orgId, audience: "candidate", purpose: "jd" });
  const result = await aiJson<GeneratedJd>({
    orgId,
    feature: "jd_generate",
    system: buildTemplateSystemPrompt({ base: BASE_JD_SYSTEM, template }),
    prompt: JSON.stringify({
      ...data,
      organisation_context: untrusted(
        "organisation_profile",
        org.versionId ? org.blocks : `${NO_PROFILE_LINE} (write no company claims)`,
      ),
    }),
  });
  if (!result.ok) throw new Error(result.message);
  return stripAll(result.data);
});

export const generateJd = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => JdInput.parse(data))
  .handler(async ({ data, context }) => generateJdCore(context.orgId, data));

/* ------------------------------------------------- Existing JD import */

const JdImportInput = z.object({
  jdText: z.string().min(30),
  title: z.string().optional().nullable(),
});

/**
 * Structure a recruiter's existing JD (pasted or extracted from PDF/DOCX) into the
 * same shape as an AI-drafted JD so scoring, must-have coverage and audit stay identical.
 */
export const importJd = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => JdImportInput.parse(data))
  .handler(async ({ data, context }) => {
    const result = await aiJson<
      GeneratedJd & { experience_min: number; experience_max: number; detected_title: string }
    >({
      orgId: context.orgId,
      feature: "jd_import",
      system:
        "You are parsing an EXISTING job description supplied by a recruiter. Extract, never invent. " +
        "Keep the original wording where possible; only normalise structure. " +
        "Return ONLY JSON with keys: detected_title, purpose, responsibilities (markdown bullets), " +
        "must_have (string array of concrete skills), good_to_have (string array), qualifications, " +
        "success_factors, reporting_to, experience_min (number, 0 if absent), experience_max (number, 0 if absent), " +
        "full_text (the JD cleaned up as markdown).",
      prompt: JSON.stringify(data),
    });
    if (!result.ok) throw new Error(result.message);
    return result.data;
  });

/* ------------------------------------------- JD-aware weight intelligence */

const WeightAdviceInput = z.object({
  /** When given, the requisition's saved fields, location and work mode are read server-side. */
  requisitionId: z.string().uuid().optional().nullable(),
  title: z.string(),
  seniorityHint: z.string().optional().nullable(),
  mustHave: z.array(z.string()),
  goodToHave: z.array(z.string()),
  education: z.string().optional().nullable(),
  experienceMin: z.number(),
  experienceMax: z.number(),
  jdText: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  workMode: z.enum(["onsite", "hybrid", "remote"]).optional().nullable(),
});

export type { WeightAdvice } from "./weight-advice";

const WeightAdviceSchema = z
  .object({
    skills: z.coerce.number(),
    experience: z.coerce.number(),
    career: z.coerce.number(),
    impact: z.coerce.number(),
    education: z.coerce.number(),
    social: z.coerce.number(),
    rationale: z.string().optional().default(""),
    notes: z.array(z.string()).optional().default([]),
    custom_dimensions: z
      .array(
        z.object({
          label: z.string(),
          hint: z.string(),
          weight: z.coerce.number(),
        }),
      )
      .optional()
      .default([]),
  })
  .passthrough();

const WEIGHT_SYSTEM = [
  "You tune the candidate-scoring model for one specific role at one specific organisation. Distribute",
  "exactly 100 points across six built-in dimensions — skills, experience (years vs band), career (tenure",
  "stability, progression, gaps), impact (quantified outcomes, ownership, innovation), education (degrees,",
  "licences, certifications) and social (public-profile evidence: GitHub, publications, portfolio) — plus",
  "up to two organisation-specific custom dimensions when the knowledge below calls for them.",
  "",
  "Decide from four kinds of knowledge, and name in the rationale which of them moved the split:",
  "1. The role itself (title, skills, experience band, responsibilities).",
  "2. The organisation profile (its domain, regulators, hiring norms, culture, locations and work modes).",
  "3. Demand and supply from the organisation's role ontology: how often it hires this role and how many",
  "   people in its pool already fit. Scarce supply → weight transferable skills and career trajectory a",
  "   little more and do not over-weight rare credentials; abundant supply → be stricter on the",
  "   differentiators (impact, certifications).",
  "4. Location and work mode. For an onsite or hybrid role with a stated location, propose a custom",
  "   'Location fit' dimension (5–15 points) scoring the candidate's current or preferred location and",
  "   stated willingness to relocate against the role's location and work mode. Never for remote roles.",
  "",
  "Role archetypes (adapt, do not copy):",
  "- Licence- or regulation-bound technical roles (lab technician, pharmacist, nurse, radiographer):",
  "  education/certification high (25–35), experience with the specific procedures and equipment high,",
  "  social low (0–5). Consider a custom 'Regulatory & safety compliance' dimension (GLP, NABL, ISO,",
  "  biosafety) when the domain or regulators call for it.",
  "- Skilled trades and hands-on roles (mechanic, electrician, technician, operator): skills and hands-on",
  "  experience dominate (together 60–75), trade certifications count under education, impact and social",
  "  low (social 0–5 — trades rarely have a public footprint). Consider a custom 'Equipment / platform",
  "  expertise' dimension for the specific machines, vehicles or systems named.",
  "- Deep technical and research roles (AI/ML engineer, data scientist, platform engineer): skills",
  "  highest (30–40), impact high (shipped models, measured outcomes), social meaningful (10–20 — GitHub,",
  "  papers, Kaggle), education moderate. Consider 'Production ML / shipped systems' when the role ships.",
  "- Leadership, client-facing and regulated business roles: experience and career higher; impact for",
  "  growth and founding roles; social for developer-relations, design and content roles.",
  "",
  "Keep career and impact between 5 and 25 each. Social may be 0–5 only for roles with no public",
  "footprint; otherwise 5–30. A custom dimension needs a concrete scoring hint (what CV evidence earns",
  "high and low scores, 20–300 characters) and must not duplicate a built-in dimension.",
  "Return ONLY JSON with keys: skills, experience, career, impact, education, social (integers),",
  "custom_dimensions (array of {label, hint, weight}, may be empty), rationale (2-4 sentences naming the",
  "knowledge used), notes (2-4 short bullet strings). All weights together sum to 100.",
].join("\n");

/** Distribute the 100 scoring points for one role; shared by the server fn and agents. */
export const suggestWeightsCore = createServerOnlyFn(async function suggestWeightsCore(
  orgId: string,
  input: z.infer<typeof WeightAdviceInput>,
  /** Evals pass a test key explicitly; product calls use the organisation's configured key. */
  opts: { config?: AiConfig } = {},
): Promise<WeightAdvice> {
  const data = { ...input };
  if (input.requisitionId) {
    // The saved requisition is the source of truth for location and work mode.
    const { requisitions } = await import("@db/schema");
    const [r] = await db
      .select({
        title: requisitions.title,
        location: requisitions.location,
        workMode: requisitions.workMode,
        mustHave: requisitions.mustHaveSkills,
        goodToHave: requisitions.goodToHaveSkills,
      })
      .from(requisitions)
      .where(and(eq(requisitions.id, input.requisitionId), eq(requisitions.orgId, orgId)))
      .limit(1);
    if (!r) throw new Error("Requisition not found.");
    data.location = data.location ?? r.location;
    data.workMode = data.workMode ?? r.workMode;
    if (!data.mustHave.length) data.mustHave = (r.mustHave as string[] | null) ?? [];
    if (!data.goodToHave.length) data.goodToHave = (r.goodToHave as string[] | null) ?? [];
  }

  const basis: string[] = ["The role's skills, experience band and responsibilities"];

  const { orgContextFor } = await import("./org-context.server");
  const org = await orgContextFor({ orgId, audience: "internal", purpose: "scoring" });
  basis.push(
    org.version ? `Organisation profile (version ${org.version})` : "No approved organisation profile yet",
  );

  let demand = "No matching role in the organisation's ontology.";
  try {
    const [{ loadOntology }, { findRoleProfile }] = await Promise.all([
      import("../server/org-ontology.server"),
      import("./org-ontology"),
    ]);
    const ont = await loadOntology(orgId);
    const found = findRoleProfile(ont, data.title);
    // A shared generic word ("engineer", "manager") is not the same role.
    const GENERIC = /^(senior|junior|lead|engineer|manager|specialist|executive|associate|analyst|officer|technician|developer|consultant|head|staff|and|of)$/;
    const words = (t: string) =>
      new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !GENERIC.test(w)));
    const mine = words(data.title);
    const role =
      found && [found.name, ...found.titles].some((t) => [...words(t)].some((w) => mine.has(w)))
        ? found
        : null;
    if (role) {
      demand =
        `Ontology role: ${role.name} (${role.kind}${role.status ? `, ${role.status}` : ""}) in ${role.domain}. ` +
        `Requisitions raised for it in the last 18 months: ${role.requisitions}. ` +
        `People in the pool who already cover most of its skills: ${role.inPool}.`;
      basis.push(
        `Demand and supply: ${role.name} — ${role.requisitions} requisition(s), ${role.inPool} in the pool`,
      );
    } else {
      basis.push(`Domain: ${ont.domain.name} (no matching role in the ontology yet)`);
    }
  } catch {
    // The ontology is advisory: advice still works from the role and profile.
  }

  const where = data.workMode === "remote"
    ? "Remote role."
    : data.location
      ? `${data.location}${data.workMode ? `, ${data.workMode}` : ""}.`
      : "No location stated.";
  basis.push(`Location: ${where.replace(/\.$/, "")}`);

  const result = await aiJson<z.infer<typeof WeightAdviceSchema>>({
    orgId,
    feature: "weight_suggest",
    schema: WeightAdviceSchema,
    ...(opts.config ? { config: opts.config } : {}),
    system: `${INJECTION_RULES}\n\n${WEIGHT_SYSTEM}`,
    prompt: [
      `Location and work mode: ${where}`,
      `Demand and supply: ${demand}`,
      untrusted("organisation_profile", org.blocks),
      untrusted(
        "role",
        JSON.stringify({
          title: data.title,
          seniority: data.seniorityHint ?? null,
          must_have: data.mustHave,
          good_to_have: data.goodToHave,
          education: data.education ?? null,
          experience_years: [data.experienceMin, data.experienceMax],
        }),
      ),
      untrusted("job_description", (data.jdText ?? "").slice(0, 8000)),
    ].join("\n\n"),
  });
  if (!result.ok) throw new Error(result.message);
  const advice = normaliseAdvice(result.data as Record<string, unknown>, basis);
  // Location fit only makes sense when the work happens somewhere.
  if (data.workMode === "remote" || !data.location) {
    const loc = advice.customDimensions.findIndex((d) => /location/i.test(d.label));
    if (loc >= 0) {
      const [dropped] = advice.customDimensions.splice(loc, 1);
      advice.skills += dropped!.weight;
    }
  }
  return advice;
});

export const suggestWeights = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => WeightAdviceInput.parse(data))
  .handler(async ({ data, context }): Promise<WeightAdvice> =>
    suggestWeightsCore(context.orgId, data),
  );

/* --------------------------------------------- LinkedIn job post designer */

const PostInput = z.object({
  title: z.string(),
  company: z.string().default("Yavar"),
  location: z.string().optional().nullable(),
  openings: z.number().default(1),
  experienceMin: z.number(),
  experienceMax: z.number(),
  mustHave: z.array(z.string()),
  goodToHave: z.array(z.string()),
  jdText: z.string().optional().nullable(),
  tone: z.enum(["professional", "warm", "bold"]).default("professional"),
  applyUrl: z.string().optional().nullable(),
  templateId: z.string().uuid().optional().nullable(),
});

const BASE_POST_SYSTEM =
  "You write high-performing LinkedIn hiring posts. Concrete, specific, no buzzwords, no emojis except at " +
  "most two, no 'rockstar/ninja'. Structure the body in short scannable lines with real detail on the role, " +
  "the stack and what success looks like. Under 1300 characters. Return ONLY JSON with keys: headline " +
  "(one line), body (the post text with line breaks), hashtags (5-8 strings without the # symbol), call_to_action.";

export type SocialJobPost = {
  headline: string;
  body: string;
  hashtags: string[];
  call_to_action: string;
};

/** Draft a ready-to-publish LinkedIn job post from the approved requisition + JD. */
/** Draft a LinkedIn job post; shared by the server fn and the Publishing agent. */
export const draftLinkedinPostCore = createServerOnlyFn(async function draftLinkedinPostCore(
  orgId: string,
  data: z.infer<typeof PostInput>,
): Promise<SocialJobPost> {
  const template = await resolveTemplate(orgId, "linkedin_post", data.templateId);
  const result = await aiJson<SocialJobPost>({
    orgId: orgId,
    feature: "linkedin_post",
    system: buildTemplateSystemPrompt({
      base: BASE_POST_SYSTEM,
      template,
      tone: data.tone,
    }),
    prompt: JSON.stringify(data),
  });
  if (!result.ok) throw new Error(result.message);
  return {
    ...result.data,
    headline: stripUnreplacedPlaceholders(result.data.headline ?? ""),
    body: stripUnreplacedPlaceholders(result.data.body ?? ""),
    hashtags: (result.data.hashtags ?? []).map((h) => stripUnreplacedPlaceholders(h)),
    call_to_action: stripUnreplacedPlaceholders(result.data.call_to_action ?? ""),
  };
});

export const draftLinkedinPost = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => PostInput.parse(data))
  .handler(async ({ data, context }) => draftLinkedinPostCore(context.orgId, data));

/* -------------------------------------------------------------- JD vs CV */

const MatchInput = z.object({
  jd: z.object({
    title: z.string(),
    mustHave: z.array(z.string()),
    goodToHave: z.array(z.string()),
    responsibilities: z.string().optional().nullable(),
    education: z.string().optional().nullable(),
    experienceMin: z.number(),
    experienceMax: z.number(),
    jdText: z.string().optional().nullable(),
    constraints: z
      .object({
        ctcBandMin: z.number().optional().nullable(),
        ctcBandMax: z.number().optional().nullable(),
        budgetCtc: z.number().optional().nullable(),
        maxNoticePeriodDays: z.number().optional().nullable(),
        locations: z.array(z.string()).optional().nullable(),
        workAuthorizationRequired: z.string().optional().nullable(),
      })
      .optional()
      .nullable(),
  }),
  candidate: z.object({
    name: z.string(),
    skills: z.array(z.string()),
    experienceYears: z.number(),
    education: z.string().optional().nullable(),
    resumeText: z.string().optional().nullable(),
    linkedinUrl: z.string().optional().nullable(),
    githubUrl: z.string().optional().nullable(),
    websiteUrl: z.string().optional().nullable(),
    xUrl: z.string().optional().nullable(),
    linkedinProfileText: z.string().optional().nullable(),
    cachedSocial: z.array(z.any()).optional().nullable(),
    noticePeriodDays: z.number().optional().nullable(),
    currentCtc: z.number().optional().nullable(),
    expectedCtc: z.number().optional().nullable(),
    location: z.string().optional().nullable(),
    preferredLocations: z.array(z.string()).optional().nullable(),
    willingToRelocate: z.boolean().optional().nullable(),
    workAuthorization: z.string().optional().nullable(),
  }),
  weights: z.object({
    skills: z.number(),
    experience: z.number(),
    career: z.number(),
    impact: z.number(),
    education: z.number(),
    social: z.number(),
  }),
  includeSocial: z.boolean().default(true),
});

export const matchJdToCv = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => MatchInput.parse(data))
  .handler(async ({ data, context }) => {
    const { model: _model, ...wire } = await scoreCandidate({
      orgId: context.orgId,
      jd: data.jd,
      candidate: data.candidate as never,
      weights: data.weights,
      includeSocial: data.includeSocial,
    });
    return wire;
  });

/* ------------------------------------------- one JD vs many CVs (bulk run) */

const PipelineInput = z.object({
  jd: MatchInput.shape.jd,
  weights: MatchInput.shape.weights,
  includeSocial: z.boolean().default(true),
  /** Hard ceiling on parallel AI + provider calls so we never trip rate limits. */
  concurrency: z.number().min(1).max(6).default(3),
  rows: z
    .array(
      z.object({
        applicationId: z.string(),
        candidate: MatchInput.shape.candidate,
      }),
    )
    .min(1)
    .max(200),
});

export type PipelineRowResult =
  | { applicationId: string; ok: true; result: Omit<MatchResult, "model"> }
  | { applicationId: string; ok: false; message: string };

/**
 * Score one JD against many CVs in a single call: bounded concurrency, cached
 * social signals reused per candidate, and per-row failures isolated so one bad
 * resume never kills the whole run.
 */
export const matchPipeline = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => PipelineInput.parse(data))
  .handler(async ({ data, context }): Promise<PipelineRowResult[]> =>
    mapWithConcurrency(data.rows, data.concurrency, async (row) => {
      try {
        const { model: _model, ...wire } = await scoreCandidate({
          orgId: context.orgId,
          jd: data.jd,
          candidate: row.candidate as never,
          weights: data.weights,
          includeSocial: data.includeSocial,
        });
        return { applicationId: row.applicationId, ok: true as const, result: wire };
      } catch (e) {
        return {
          applicationId: row.applicationId,
          ok: false as const,
          message: e instanceof Error ? e.message : "Scoring failed",
        };
      }
    }),
  );

/* --------------------------------------------------- resume text parsing */

const ParseInput = z.object({ resumeText: z.string().min(20) });

export const parseResume = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => ParseInput.parse(data))
  .handler(async ({ data, context }) => {
    const result = await aiJson<{
      full_name: string;
      email: string;
      phone: string | null;
      location: string | null;
      experience_years: number;
      education: string | null;
      skills: string[];
      linkedin_url: string | null;
      github_url: string | null;
      website_url: string | null;
    }>({
      orgId: context.orgId,
      feature: "resume_parse",
      system:
        "Extract structured candidate data from a resume. Return ONLY JSON with keys: full_name, email, phone, " +
        "location, experience_years (number), education, skills (string array), linkedin_url, github_url, website_url. " +
        "Use null when a field is genuinely absent. Never invent values.",
      prompt: data.resumeText.slice(0, 20000),
    });
    if (!result.ok) throw new Error(result.message);
    return result.data;
  });

/* ---------------------------------------------- AI screening interview */

const AiInterviewInput = z.object({
  jobTitle: z.string(),
  jdText: z.string(),
  candidateName: z.string(),
  resumeText: z.string().optional().nullable(),
  matchRationale: z.string().optional().nullable(),
});

export const runAiScreening = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => AiInterviewInput.parse(data))
  .handler(async ({ data, context }) => {
    const result = await aiJson<{
      jd_match_score: number;
      skillset_score: number;
      summary: string;
      transcript: { question: string; expected_signal: string }[];
    }>({
      orgId: context.orgId,
      feature: "candidate_score",
      system:
        "You design and evaluate an AI first-round screening interview. Produce 6 role-specific questions with the " +
        "signal each one probes, and score the candidate on jd_match_score and skillset_score (0-100 each) based " +
        "on the evidence supplied. Never score 'culture fit' or personality proxies. Return ONLY JSON with keys: " +
        "jd_match_score, skillset_score, summary, transcript (array of {question, expected_signal}).",
      prompt: JSON.stringify(data),
    });
    if (!result.ok) throw new Error(result.message);
    return result.data;
  });

/* ------------------------------------------------- scoring persistence */

/** Enabled naukri/indeed boards for the caller's org, for the import picker. */
export const listEnabledJobBoards = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    return db
      .select({
        provider: sourceIntegrations.provider,
        label: sourceIntegrations.label,
        enabled: sourceIntegrations.enabled,
      })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.orgId, context.orgId),
          eq(sourceIntegrations.enabled, true),
          inArray(sourceIntegrations.provider, ["naukri", "indeed"]),
        ),
      );
  });

const PersistInput = z.object({
  applicationId: z.string().uuid(),
  /** Caller decides: overall ≥ 75 and the application sat on "applied". */
  autoShortlist: z.boolean().default(false),
  /** Fresh social signals to persist — omitted when they were served from cache. */
  socialSignals: z
    .array(
      z.object({
        provider: z.string(),
        profileUrl: z.string().nullish(),
        handle: z.string().nullish(),
        score: z.number(),
        signals: z.record(z.string(), z.unknown()),
        rationale: z.string().nullish(),
        status: z.string(),
      }),
    )
    .nullish(),
  score: z.object({
    skillsScore: z.number(),
    experienceScore: z.number(),
    careerScore: z.number(),
    impactScore: z.number(),
    innovationScore: z.number(),
    educationScore: z.number(),
    socialScore: z.number(),
    overallScore: z.number(),
    weights: z.record(z.string(), z.number()),
    customScores: z
      .array(z.object({ key: z.string(), score: z.number(), evidence: z.string() }))
      .nullish(),
    matchedSkills: z.array(z.string()),
    missingSkills: z.array(z.string()),
    rationale: z.string().nullish(),
    riskFlags: z.array(z.string()),
    recommendation: z.enum(["select", "reject", "hold"]).nullish(),
    careerMetrics: z.unknown(),
    careerFlags: z.array(z.string()),
    logisticsFlags: z.array(z.string()),
    impactHighlights: z.array(z.string()),
    innovationSignals: z.array(z.string()),
  }),
});

/**
 * Persist one scored candidate: the match_scores row (org-scoped via the
 * application row), a multi-row upsert of fresh social signals on the
 * (candidate_id, provider) unique index, and the optional applied →
 * shortlisted promotion. Single-score and bulk-pipeline runs share this.
 */
export const persistMatchResult = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => PersistInput.parse(data))
  .handler(async ({ data, context }) => {
    const [application] = await db
      .select({
        id: applications.id,
        candidateId: applications.candidateId,
        stage: applications.stage,
      })
      .from(applications)
      .where(and(eq(applications.id, data.applicationId), eq(applications.orgId, context.orgId)))
      .limit(1);
    if (!application) throw new Error("Application not found");

    const s = data.score;
    // The model id never travels through the client; resolve it here so the
    // score row still records which engine produced the result.
    const { resolveAiConfig } = await import("./ai-gateway.server");
    const cfg = await resolveAiConfig(context.orgId);
    // The recommendation is recomputed here from the deterministic dimensions —
    // the client's copy is display-only, never the basis for stage logic.
    const recommendation = gatedRecommendation(s.overallScore, {
      injectionSuspected: s.riskFlags.includes(INJECTION_HOLD_FLAG),
      experienceScore: s.experienceScore,
      levelMismatch: s.riskFlags.includes(LEVEL_MISMATCH_FLAG),
      directionMismatch: s.riskFlags.includes(DIRECTION_MISMATCH_FLAG),
      ctcOverBand: s.logisticsFlags.includes(CTC_CEILING_BLOCKER),
    });
    await db.insert(matchScores).values({
      applicationId: application.id,
      orgId: context.orgId,
      skillsScore: s.skillsScore,
      experienceScore: s.experienceScore,
      careerScore: s.careerScore,
      impactScore: s.impactScore,
      innovationScore: s.innovationScore,
      careerMetrics: s.careerMetrics,
      careerFlags: s.careerFlags,
      logisticsFlags: s.logisticsFlags,
      impactHighlights: s.impactHighlights,
      innovationSignals: s.innovationSignals,
      educationScore: s.educationScore,
      socialScore: s.socialScore,
      overallScore: s.overallScore,
      weights: s.weights,
      customScores: s.customScores ?? [],
      matchedSkills: s.matchedSkills,
      missingSkills: s.missingSkills,
      rationale: s.rationale ?? null,
      riskFlags: s.riskFlags,
      recommendation,
      model: cfg.model,
    });

    if (data.socialSignals?.length) {
      await db
        .insert(socialProfiles)
        .values(
          data.socialSignals.map((signal) => ({
            candidateId: application.candidateId,
            orgId: context.orgId,
            provider: signal.provider,
            profileUrl: signal.profileUrl ?? null,
            handle: signal.handle ?? null,
            score: signal.score,
            signals: signal.signals,
            rationale: signal.rationale ?? null,
            status: signal.status,
            fetchedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [socialProfiles.candidateId, socialProfiles.provider],
          set: {
            profileUrl: sql`excluded.profile_url`,
            handle: sql`excluded.handle`,
            score: sql`excluded.score`,
            signals: sql`excluded.signals`,
            rationale: sql`excluded.rationale`,
            status: sql`excluded.status`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
    }

    if (data.autoShortlist && application.stage === "applied" && recommendation === "select") {
      // Same shape as autoscore: write the stage, then journal the transition
      // (which also emails the candidate and enqueues background screening-kit
      // preparation). This path previously skipped the stage_events audit row.
      const now = new Date();
      await db
        .update(applications)
        .set({ stage: "shortlisted", lastActivityAt: now })
        .where(and(eq(applications.id, application.id), eq(applications.orgId, context.orgId)));
      const { recordStageTransition } = await import("./stage-events.server");
      await recordStageTransition({
        orgId: context.orgId,
        applicationId: application.id,
        fromStage: application.stage,
        toStage: "shortlisted",
        actor: "ai",
        reason: `Auto-shortlisted by matching score ${s.overallScore}/100`,
        source: "ai",
      });
    }

    return { ok: true as const };
  });

/** Record the recruiter's verdict over the AI recommendation, with a reason. */
export const saveRecruiterOverride = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        verdict: z.enum(["select", "reject", "hold"]),
        reason: z.string().nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    await db
      .update(matchScores)
      .set({ recruiterOverride: data.verdict, overrideReason: data.reason || null })
      .where(and(eq(matchScores.id, data.id), eq(matchScores.orgId, context.orgId)));
    return { ok: true as const };
  });
