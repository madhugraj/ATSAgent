/**
 * What a panellist sees for one interview round they sit on: the candidate's
 * profile and CV, and the round's focus and rubric. Shared by the signed-in
 * panel view (My interviews) and the private scorecard link, so the two
 * cannot drift. Never pay, offers, notes, other candidates or other rounds'
 * scores. Match and screening highlights are internal material: only for a
 * signed-in member of the organisation. Every query is scoped to the org.
 */
import { and, desc, eq } from "drizzle-orm";

import {
  applications,
  candidates,
  interviews,
  matchScores,
  requisitions,
  screeningRuns,
} from "@db/schema";
import { db } from "../server/db";
import type { PanelBrief } from "./panel-brief";

export type { PanelBrief } from "./panel-brief";

const clip = (s: string | null | undefined, n: number) =>
  s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? null);

/** Long enough for a real CV; bounded so one round cannot ship a huge payload. */
const CV_MAX = 60_000;

/**
 * The brief for one round. The caller has already proved the viewer sits on
 * this round (signed-in: their email is on it; link: the token names it).
 */
export async function panelBrief(
  orgId: string,
  interviewId: string,
  opts: { internal: boolean },
): Promise<PanelBrief | null> {
  const [r] = await db
    .select({
      applicationId: interviews.applicationId,
      level: interviews.level,
      scheduledAt: interviews.scheduledAt,
      durationMins: interviews.durationMins,
      mode: interviews.mode,
      teamsLink: interviews.teamsLink,
      agenda: interviews.agenda,
      requisitionId: applications.requisitionId,
      jobTitle: requisitions.title,
      name: candidates.fullName,
      employer: candidates.currentEmployer,
      years: candidates.experienceYears,
      location: candidates.location,
      education: candidates.education,
      skills: candidates.skills,
      resumeText: candidates.resumeText,
    })
    .from(interviews)
    .innerJoin(
      applications,
      and(eq(applications.id, interviews.applicationId), eq(applications.orgId, orgId)),
    )
    .innerJoin(
      requisitions,
      and(eq(requisitions.id, applications.requisitionId), eq(requisitions.orgId, orgId)),
    )
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)))
    .limit(1);
  if (!r) return null;

  const { planFor } = await import("./interview-plan.server");
  const { roundOf } = await import("./interview-plan");
  const round = r.requisitionId
    ? roundOf((await planFor(orgId, r.requisitionId)).plan, r.level)
    : null;

  let match: string | null = null;
  let screening: string | null = null;
  if (opts.internal) {
    const [[score], [screen]] = await Promise.all([
      db
        .select({ overall: matchScores.overallScore, rationale: matchScores.rationale })
        .from(matchScores)
        .where(eq(matchScores.applicationId, r.applicationId))
        .orderBy(desc(matchScores.computedAt))
        .limit(1),
      db
        .select({
          recommendation: screeningRuns.recommendation,
          reason: screeningRuns.recommendationReason,
        })
        .from(screeningRuns)
        .where(
          and(eq(screeningRuns.applicationId, r.applicationId), eq(screeningRuns.orgId, orgId)),
        )
        .orderBy(desc(screeningRuns.createdAt))
        .limit(1),
    ]);
    match = score
      ? `${score.overall}/100${score.rationale ? ` — ${clip(score.rationale, 400)}` : ""}`
      : null;
    screening = screen?.recommendation
      ? `${screen.recommendation}${screen.reason ? ` — ${clip(screen.reason, 400)}` : ""}`
      : null;
  }

  const cv = r.resumeText?.trim() || null;
  return {
    candidateName: r.name,
    jobTitle: r.jobTitle,
    level: r.level,
    roundName: round?.name ?? null,
    roundFocus: round?.focus || null,
    competencies: round?.competencies ?? [],
    scheduledAt: r.scheduledAt?.toISOString() ?? null,
    durationMins: r.durationMins,
    mode: r.mode,
    meetingLink: r.teamsLink,
    agenda: r.agenda,
    profile: {
      employer: r.employer,
      years: r.years != null ? Number(r.years) : null,
      location: r.location,
      education: r.education,
      skills: (r.skills ?? []).slice(0, 20),
    },
    cv: cv ? (cv.length > CV_MAX ? `${cv.slice(0, CV_MAX)}…` : cv) : null,
    match,
    screening,
  };
}
