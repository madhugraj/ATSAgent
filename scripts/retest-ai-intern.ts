/**
 * One-off retest of REQ-2026-002 (AI Intern) under the gated scoring:
 * resets the requisition's weights to the organisation defaults (audit-logged —
 * they were education 30 / experience 5 when the overqualified shortlist
 * happened), then dry-runs every existing application through scoreCandidate
 * exactly as autoscore builds it. NO writes to match_scores or stages; social
 * crawling is off for the preview (the social dimension reads 0; the real run
 * reuses cached signals).
 * Run: DATABASE_URL=... SESSION_SECRET=... bun scripts/retest-ai-intern.ts
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../src/server/db";
import { applications, candidates, jobDescriptions, matchScores, requisitions } from "@db/schema";
import { DEFAULT_WEIGHTS, harvestProfileLinks, scoreCandidate } from "../src/lib/matching.server";

const requisitionId = "afe735e0-1d6b-4dec-8b21-ab964112676b"; // REQ-2026-002, AI Intern

const [req] = await db
  .select()
  .from(requisitions)
  .where(eq(requisitions.id, requisitionId))
  .limit(1);
if (!req) throw new Error("Requisition not found");
const orgId = req.orgId;

/* 1 — reset the weights (same columns and audit shape as updateRequisitionWeights). */
const before = {
  skills: req.weightSkills,
  experience: req.weightExperience,
  career: req.weightCareer,
  impact: req.weightImpact,
  education: req.weightEducation,
  social: req.weightSocial,
};
const w = DEFAULT_WEIGHTS;
if (
  before.skills !== w.skills ||
  before.experience !== w.experience ||
  before.career !== w.career ||
  before.impact !== w.impact ||
  before.education !== w.education ||
  before.social !== w.social
) {
  await db
    .update(requisitions)
    .set({
      weightSkills: w.skills,
      weightExperience: w.experience,
      weightCareer: w.career,
      weightImpact: w.impact,
      weightEducation: w.education,
      weightSocial: w.social,
    })
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)));
  const { writeAudit } = await import("../src/server/audit");
  await writeAudit({
    actor: "retest-script",
    orgId,
    action: "requisition.weights_changed",
    entityType: "requisition",
    entityId: requisitionId,
    detail: { code: req.code, status: req.status, before, after: w },
  });
  console.log(`weights reset: ${JSON.stringify(before)} -> ${JSON.stringify(w)}`);
} else {
  console.log("weights already at defaults");
}

/* 2 — the stored verdict each application's current stage came from. */
const apps = await db
  .select({
    appId: applications.id,
    stage: applications.stage,
    candidateId: applications.candidateId,
    name: candidates.fullName,
    years: candidates.experienceYears,
  })
  .from(applications)
  .innerJoin(candidates, eq(candidates.id, applications.candidateId))
  .where(and(eq(applications.requisitionId, requisitionId), eq(applications.orgId, orgId)));

const stored = apps.length
  ? await db
      .selectDistinctOn([matchScores.applicationId], {
        applicationId: matchScores.applicationId,
        overallScore: matchScores.overallScore,
        recommendation: matchScores.recommendation,
      })
      .from(matchScores)
      .where(
        inArray(
          matchScores.applicationId,
          apps.map((a) => a.appId),
        ),
      )
      .orderBy(matchScores.applicationId, desc(matchScores.computedAt))
  : [];
const oldByApp = new Map(stored.map((s) => [s.applicationId, s]));

const [jd] = await db
  .select({
    fullText: jobDescriptions.fullText,
    mustHave: jobDescriptions.mustHave,
    goodToHave: jobDescriptions.goodToHave,
    responsibilities: jobDescriptions.responsibilities,
    qualifications: jobDescriptions.qualifications,
  })
  .from(jobDescriptions)
  .where(and(eq(jobDescriptions.requisitionId, requisitionId), eq(jobDescriptions.orgId, orgId)))
  .orderBy(desc(jobDescriptions.version))
  .limit(1);

/* 3 — dry-run rescore, mirroring autoscore's inputs. */
const header = "name · yrs · stage · old score/rec -> new score (exp, fit) -> gated rec";
console.log(`\n${header}\n${"-".repeat(header.length)}`);
const tally = { select: 0, hold: 0, reject: 0, error: 0 };
for (const app of apps) {
  const [cand] = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.id, app.candidateId), eq(candidates.orgId, orgId)))
    .limit(1);
  if (!cand) continue;
  const links = harvestProfileLinks(cand.resumeText);
  const old = oldByApp.get(app.appId);
  try {
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
        skills: cand.skills ?? [],
        experienceYears: Number(cand.experienceYears ?? 0),
        education: cand.education ?? null,
        resumeText: cand.resumeText,
        linkedinUrl: cand.linkedinUrl ?? links.linkedinUrl,
        githubUrl: cand.githubUrl ?? links.githubUrl,
        websiteUrl: cand.websiteUrl ?? links.websiteUrl,
        xUrl: cand.xUrl ?? links.xUrl,
        noticePeriodDays: cand.noticePeriodDays ?? null,
        currentCtc: cand.currentCtc != null ? Number(cand.currentCtc) : null,
        expectedCtc: cand.expectedCtc != null ? Number(cand.expectedCtc) : null,
        location: cand.location ?? null,
      },
      weights: w,
      includeSocial: false,
      orgId,
    });
    tally[result.recommendation] += 1;
    const changed =
      old && (old.recommendation !== result.recommendation || result.recommendation !== "select");
    console.log(
      `${changed ? "* " : "  "}${cand.fullName} · ${Number(cand.experienceYears ?? 0)}y · ${app.stage} · ` +
        `${old ? `${old.overallScore}/${old.recommendation}` : "unscored"} -> ` +
        `${result.overall_score} (exp ${result.experience_score}, fit ${result.experience_fit}) -> ${result.recommendation}`,
    );
  } catch (e) {
    tally.error += 1;
    console.log(`  ${cand.fullName} · ERROR ${e instanceof Error ? e.message.slice(0, 140) : e}`);
  }
}
console.log(
  `\nsummary: ${tally.select} select, ${tally.hold} hold, ${tally.reject} reject, ${tally.error} error (${apps.length} applications; * = verdict differs from stored)`,
);
void sql; // keep the import list identical to autoscore's for easy diffing
