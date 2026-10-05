import { and, eq, inArray, sql } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { applications, matchScores, socialProfiles, sourceIntegrations } from "@db/schema";
import { requireIdentity, requireOrg } from "./auth.middleware";
import { aiJson } from "./ai-gateway.server";
import {
  buildTemplateSystemPrompt,
  resolveTemplate,
  stripUnreplacedPlaceholders,
} from "./templates.server";
import {
  mapWithConcurrency,
  scoreCandidate,
  type MatchResult,
  type MatchWire,
} from "./matching.server";
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
  "You are an expert talent-acquisition writer. Draft a complete, specific job description. " +
  "Return ONLY JSON with keys: purpose (2 sentences), responsibilities (markdown bullet list), " +
  "must_have (string array), good_to_have (string array), qualifications, success_factors, " +
  "reporting_to, full_text (the full JD as markdown). No fluff, no buzzwords, no emojis.";

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

export const generateJd = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => JdInput.parse(data))
  .handler(async ({ data, context }) => {
    const template = await resolveTemplate(context.orgId, "jd", data.templateId);
    const result = await aiJson<GeneratedJd>({
      orgId: context.orgId,
      feature: "jd_generate",
      system: buildTemplateSystemPrompt({ base: BASE_JD_SYSTEM, template }),
      prompt: JSON.stringify(data),
    });
    if (!result.ok) throw new Error(result.message);
    return stripAll(result.data);
  });

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
  .inputValidator((data: unknown) => JdImportInput.parse(data))
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
  title: z.string(),
  seniorityHint: z.string().optional().nullable(),
  mustHave: z.array(z.string()),
  goodToHave: z.array(z.string()),
  education: z.string().optional().nullable(),
  experienceMin: z.number(),
  experienceMax: z.number(),
  jdText: z.string().optional().nullable(),
});

export type WeightAdvice = {
  skills: number;
  experience: number;
  career: number;
  impact: number;
  education: number;
  social: number;
  rationale: string;
  notes: string[];
};

/**
 * Ask the model to distribute the 100 scoring points across the six dimensions
 * for THIS job, then hard-normalise server-side so the total is always exactly 100.
 */
export const suggestWeights = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => WeightAdviceInput.parse(data))
  .handler(async ({ data, context }): Promise<WeightAdvice> => {
    const result = await aiJson<WeightAdvice>({
      orgId: context.orgId,
      feature: "weight_suggest",
      system:
        "You tune the scoring model for one specific job description. Distribute exactly 100 points across " +
        "six dimensions: skills, experience (years vs band), career (tenure stability, progression, gaps), " +
        "impact (quantified outcomes, ownership, innovation evidence), education and social (public-profile " +
        "evidence). Reason about the role: deep technical/IC roles weight skills highest; leadership and " +
        "regulated roles weight experience and career higher; high-churn or business-critical roles raise " +
        "career; product, founding, R&D and growth roles raise impact; research, medical, academic or " +
        "licence-bound roles raise education; developer-relations, design, content and open-source-heavy " +
        "roles raise social. Keep career and impact between 5 and 25 each, and social between 5 and 30 and " +
        "never 0 unless the role has no public footprint at all. Return ONLY JSON with keys: skills, " +
        "experience, career, impact, education, social (integers summing to 100), rationale (2-3 sentences), " +
        "notes (2-4 short bullet strings).",
      prompt: JSON.stringify(data),
    });
    if (!result.ok) throw new Error(result.message);

    const keys = ["skills", "experience", "career", "impact", "education", "social"] as const;
    const raw = Object.fromEntries(
      keys.map((k) => [
        k,
        Math.max(0, Math.round(Number((result.data as never as Record<string, unknown>)[k]) || 0)),
      ]),
    ) as Record<(typeof keys)[number], number>;
    const total = keys.reduce((s, k) => s + raw[k], 0) || 1;
    const scaled = Object.fromEntries(
      keys.map((k) => [k, Math.round((raw[k] / total) * 100)]),
    ) as Record<(typeof keys)[number], number>;
    // Push any rounding drift onto the largest bucket so the total is exactly 100.
    const drift = 100 - keys.reduce((s, k) => s + scaled[k], 0);
    const biggest = keys.reduce((a, b) => (scaled[a] >= scaled[b] ? a : b));
    scaled[biggest] += drift;

    return {
      ...scaled,
      rationale: result.data.rationale ?? "",
      notes: result.data.notes ?? [],
    };
  });

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
export const draftLinkedinPost = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => PostInput.parse(data))
  .handler(async ({ data, context }) => {
    const template = await resolveTemplate(context.orgId, "linkedin_post", data.templateId);
    const result = await aiJson<SocialJobPost>({
      orgId: context.orgId,
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
  .inputValidator((data: unknown) => MatchInput.parse(data))
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
  .inputValidator((data: unknown) => PipelineInput.parse(data))
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
  .inputValidator((data: unknown) => ParseInput.parse(data))
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
  .inputValidator((data: unknown) => AiInterviewInput.parse(data))
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
  .inputValidator((data: unknown) => PersistInput.parse(data))
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
      matchedSkills: s.matchedSkills,
      missingSkills: s.missingSkills,
      rationale: s.rationale ?? null,
      riskFlags: s.riskFlags,
      recommendation: s.recommendation ?? null,
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

    if (data.autoShortlist && application.stage === "applied") {
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
  .inputValidator((data: unknown) =>
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
