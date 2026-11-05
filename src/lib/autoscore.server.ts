/**
 * Background scoring: every application that arrived on its own (apply link,
 * careers mailbox, LinkedIn) is scored against its requisition's JD without
 * anyone pressing anything, so HR opens the pipeline and already sees ranks.
 *
 * AI-driven stage transitions are journaled in stage_events with actor "ai"
 * so the pipeline history stays complete and auditable.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "../server/db";
import {
  applications,
  candidates,
  jobDescriptions,
  matchScores,
  requisitions,
  socialProfiles,
} from "@db/schema";
import {
  DEFAULT_WEIGHTS,
  EXPERIENCE_BAND_GATE,
  harvestProfileLinks,
  scoreCandidate,
} from "./matching.server";
import { CTC_CEILING_BLOCKER } from "./logistics";
import { recordStageTransition } from "./stage-events.server";

export type AutoScoreOutcome = {
  candidate: string;
  requisition: string;
  score: number | null;
  status: "scored" | "error" | "deferred";
  detail: string;
};

const AUTO_STAGE_ACTOR = "ai";
const AUTO_STAGES = ["applied", "sourced"] as const;

export async function scoreUnscored(opts: {
  orgId: string;
  requisitionId?: string | null;
  limit?: number;
}): Promise<{ scored: number; errors: number; deferred?: number; outcomes: AutoScoreOutcome[] }> {
  const limit = Math.min(opts.limit ?? 25, 50);

  const where = opts.requisitionId
    ? and(eq(applications.orgId, opts.orgId), eq(applications.requisitionId, opts.requisitionId))
    : eq(applications.orgId, opts.orgId);
  const rows = await db
    .select({
      id: applications.id,
      stage: applications.stage,
      requisitionId: applications.requisitionId,
      candidateId: applications.candidateId,
    })
    .from(applications)
    .where(where)
    .orderBy(desc(applications.appliedAt))
    .limit(200);
  if (!rows.length) return { scored: 0, errors: 0, outcomes: [] };

  const scored = await db
    .select({ applicationId: matchScores.applicationId })
    .from(matchScores)
    .where(
      inArray(
        matchScores.applicationId,
        rows.map((r) => r.id),
      ),
    );
  const already = new Set(scored.map((s) => s.applicationId));
  const pending = rows.filter((r) => !already.has(r.id)).slice(0, limit);
  if (!pending.length) return { scored: 0, errors: 0, outcomes: [] };

  const outcomes: AutoScoreOutcome[] = [];
  let ok = 0;
  let deferred = 0;

  // Denial-of-wallet guard (migration 0064): at most N automatic scorings per
  // requisition per day; the rest stay unscored and are picked up tomorrow.
  const { loadCaps, scoresToday } = await import("../server/ai-spend-cap");
  const { dailyScoresPerRequisition: dailyCap } = await loadCaps(opts.orgId);
  const usedToday = new Map<string, number>();

  const { withAiSubject } = await import("../server/agents/context");
  for (const app of pending) {
    if (dailyCap) {
      const used =
        usedToday.get(app.requisitionId) ?? (await scoresToday(opts.orgId, app.requisitionId));
      if (used >= dailyCap) {
        usedToday.set(app.requisitionId, used);
        deferred += 1;
        outcomes.push({
          candidate: "Candidate",
          requisition: "requisition",
          score: null,
          status: "deferred",
          detail: `Daily scoring limit (${dailyCap}) reached for this role — scored tomorrow.`,
        });
        continue;
      }
      usedToday.set(app.requisitionId, used + 1);
    }
    // Every AI call while scoring this candidate counts towards their cost.
    await withAiSubject(
      { applicationId: app.id, candidateId: app.candidateId, requisitionId: app.requisitionId },
      async () => {
        let label = "Candidate";
        let reqTitle = "requisition";
        try {
          const [req] = await db
            .select()
            .from(requisitions)
            .where(and(eq(requisitions.id, app.requisitionId), eq(requisitions.orgId, opts.orgId)))
            .limit(1);
          const [cand] = await db
            .select()
            .from(candidates)
            .where(and(eq(candidates.id, app.candidateId), eq(candidates.orgId, opts.orgId)))
            .limit(1);
          if (!req || !cand) throw new Error("Requisition or candidate missing");
          reqTitle = req.title;
          label = cand.fullName;

          const [jd] = await db
            .select({
              fullText: jobDescriptions.fullText,
              mustHave: jobDescriptions.mustHave,
              goodToHave: jobDescriptions.goodToHave,
              responsibilities: jobDescriptions.responsibilities,
              qualifications: jobDescriptions.qualifications,
            })
            .from(jobDescriptions)
            .where(
              and(eq(jobDescriptions.requisitionId, req.id), eq(jobDescriptions.orgId, opts.orgId)),
            )
            .orderBy(desc(jobDescriptions.version))
            .limit(1);

          const links = harvestProfileLinks(cand.resumeText);
          const result = await scoreCandidate({
            jd: {
              title: req.title,
              mustHave: jd?.mustHave?.length ? jd.mustHave : req.mustHaveSkills,
              goodToHave: jd?.goodToHave?.length ? jd.goodToHave : req.goodToHaveSkills,
              responsibilities: jd?.responsibilities ?? req.responsibilities,
              education: jd?.qualifications ?? req.educationRequirement,
              experienceMin: req.experienceMin,
              experienceMax: req.experienceMax,
              jdText: jd?.fullText ?? null,
              constraints: {
                locations: req.location ? [req.location] : null,
                ctcBandMin: req.ctcBandMin != null ? Number(req.ctcBandMin) : null,
                ctcBandMax: req.ctcBandMax != null ? Number(req.ctcBandMax) : null,
                maxNoticePeriodDays: req.maxNoticePeriodDays,
                workAuthorizationRequired: req.workAuthorizationRequired,
              },
            },
            candidate: {
              name: cand.fullName,
              skills: cand.skills,
              experienceYears: Number(cand.experienceYears ?? 0),
              education: cand.education,
              resumeText: cand.resumeText,
              linkedinUrl: cand.linkedinUrl ?? links.linkedinUrl,
              githubUrl: cand.githubUrl ?? links.githubUrl,
              websiteUrl: cand.websiteUrl ?? links.websiteUrl,
              xUrl: cand.xUrl ?? links.xUrl,
              noticePeriodDays: cand.noticePeriodDays,
              currentCtc: cand.currentCtc ? Number(cand.currentCtc) : null,
              expectedCtc: cand.expectedCtc ? Number(cand.expectedCtc) : null,
              location: cand.location,
              preferredLocations: cand.preferredLocations,
              willingToRelocate: cand.willingToRelocate,
              workAuthorization: cand.workAuthorization,
            },
            weights: {
              skills: req.weightSkills ?? DEFAULT_WEIGHTS.skills,
              experience: req.weightExperience ?? DEFAULT_WEIGHTS.experience,
              career: req.weightCareer ?? DEFAULT_WEIGHTS.career,
              impact: req.weightImpact ?? DEFAULT_WEIGHTS.impact,
              education: req.weightEducation ?? DEFAULT_WEIGHTS.education,
              social: req.weightSocial ?? DEFAULT_WEIGHTS.social,
            },
            includeSocial: true,
            orgId: opts.orgId,
          });

          await db.insert(matchScores).values({
            applicationId: app.id,
            orgId: opts.orgId,
            skillsScore: result.skills_score,
            experienceScore: result.experience_score,
            careerScore: result.career_score,
            impactScore: result.impact_score,
            innovationScore: result.innovation_score,
            careerMetrics: result.career.metrics,
            careerFlags: result.career.assessment.flags,
            logisticsFlags: [
              ...(result.logistics?.flags ?? []),
              ...(result.logistics?.blockers ?? []),
            ],
            impactHighlights: result.impact.highlights,
            innovationSignals: result.impact.innovation_signals,
            educationScore: result.education_score,
            socialScore: result.social_score,
            overallScore: result.overall_score,
            weights: result.weights,
            matchedSkills: result.matched_skills,
            missingSkills: result.missing_skills,
            rationale: result.rationale,
            riskFlags: result.risk_flags,
            recommendation: result.recommendation,
            model: result.model,
          });

          const now = new Date();
          for (const s of result.social.signals) {
            await db
              .insert(socialProfiles)
              .values({
                candidateId: app.candidateId,
                orgId: opts.orgId,
                provider: s.provider,
                profileUrl: s.profile_url,
                handle: s.handle,
                score: s.score,
                signals: s.signals,
                rationale: s.rationale,
                status: s.status,
                fetchedAt: now,
              })
              .onConflictDoUpdate({
                target: [socialProfiles.candidateId, socialProfiles.provider],
                set: {
                  orgId: opts.orgId,
                  profileUrl: s.profile_url,
                  handle: s.handle,
                  score: s.score,
                  signals: s.signals,
                  rationale: s.rationale,
                  status: s.status,
                  fetchedAt: now,
                },
              });
          }

          // The scorer saw an injection attempt the intake parse missed: remember
          // it on the candidate so every later step (agents, autoscore) sees it.
          const injection = cand.suspectedPromptInjection || result.injection_suspected;
          if (result.injection_suspected && !cand.suspectedPromptInjection) {
            await db
              .update(candidates)
              .set({ suspectedPromptInjection: true })
              .where(and(eq(candidates.id, cand.id), eq(candidates.orgId, opts.orgId)));
          }

          if ((AUTO_STAGES as readonly string[]).includes(app.stage)) {
            // A candidate whose CV tripped the injection detector, or whom the
            // scorer gated (level mismatch, far outside the experience band),
            // never advances automatically — the score is recorded, a human
            // decides the stage.
            const held = injection || result.recommendation !== "select";
            const nextStage = held ? "ai_screened" : "shortlisted";
            await db
              .update(applications)
              .set({ stage: nextStage, lastActivityAt: now })
              .where(eq(applications.id, app.id));
            // Journal the AI transition so the pipeline history stays complete.
            const gatedWhy = !injection
              ? result.experience_fit !== "within"
                ? " — career level does not match the role, held at ai_screened"
                : result.direction_fit !== "aligned"
                  ? " — the CV points at a different kind of role, held at ai_screened"
                  : result.logistics?.blockers.includes(CTC_CEILING_BLOCKER)
                    ? " — expected CTC above the approved band, held at ai_screened"
                    : result.experience_score <= EXPERIENCE_BAND_GATE
                      ? " — far outside the experience band, held at ai_screened"
                      : ""
              : injection
                ? " — prompt-injection flag held at ai_screened"
                : "";
            await recordStageTransition({
              orgId: opts.orgId,
              applicationId: app.id,
              fromStage: app.stage,
              toStage: nextStage,
              actor: AUTO_STAGE_ACTOR,
              reason: `Auto-${nextStage === "shortlisted" ? "shortlisted" : "screened"} by matching score ${result.overall_score}/100${gatedWhy}`,
              source: "ai",
            });
          }

          ok += 1;
          outcomes.push({
            candidate: label,
            requisition: reqTitle,
            score: result.overall_score,
            status: "scored",
            detail: result.recommendation,
          });
        } catch (e) {
          outcomes.push({
            candidate: label,
            requisition: reqTitle,
            score: null,
            status: "error",
            detail: e instanceof Error ? e.message : "Scoring failed",
          });
        }
      },
    );
  }

  return { scored: ok, errors: outcomes.length - ok - deferred, deferred, outcomes };
}
