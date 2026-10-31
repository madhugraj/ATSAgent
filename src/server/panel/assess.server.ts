/**
 * Silent panel agents, S2 (docs/silent-panel-agent-plan.md): what the L1 / L2
 * / L3 panel agents' tools do. The agent itself never sees the transcript or
 * its own score — the tools read the transcript, call the AI gateway with it
 * fenced as untrusted data, check and store the result, and hand the agent
 * back counts only. So nothing the agent says, no approval card and no run
 * log can show the score before the panel has scored.
 */
import { and, eq } from "drizzle-orm";

import {
  applications,
  candidates,
  interviews,
  interviewTranscripts,
  organizations,
  panelAssessments,
  requisitions,
} from "@db/schema";
import { aiJson } from "@/lib/ai-gateway.server";
import {
  AssessOutput,
  SummaryOutput,
  buildAssessment,
  scrubSummary,
  speakersOf,
} from "@/lib/panel-assessment";
import { assessPrompt, summaryPrompt } from "./prompts";
import { db } from "../db";
import { env } from "../env";

export type PanelLevel = 1 | 2 | 3;

/** panel_l2 → 2. */
export function levelOfAgent(agentType: string): PanelLevel | null {
  const m = /^panel_l([123])$/.exec(agentType);
  return m ? (Number(m[1]) as PanelLevel) : null;
}

/** The round, its candidate and role, its plan round and its transcript — level-checked. */
async function loadRound(orgId: string, interviewId: string, level: PanelLevel) {
  const [r] = await db
    .select({
      id: interviews.id,
      level: interviews.level,
      status: interviews.status,
      scheduledAt: interviews.scheduledAt,
      transcription: interviews.transcription,
      interviewer: interviews.interviewer,
      interviewerEmail: interviews.interviewerEmail,
      panel: interviews.panel,
      applicationId: applications.id,
      candidateId: candidates.id,
      candidateName: candidates.fullName,
      requisitionId: requisitions.id,
      jobTitle: requisitions.title,
      orgName: organizations.name,
    })
    .from(interviews)
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, interviews.orgId))
    .where(and(eq(interviews.orgId, orgId), eq(interviews.id, interviewId)))
    .limit(1);
  if (!r) throw new Error("Interview round not found.");
  // Each level's agent reads only its own level's rounds.
  if (r.level !== level)
    throw new Error(
      `This is an L${r.level} round; the L${level} panel agent reads L${level} rounds only.`,
    );
  const [t] = await db
    .select({ segments: interviewTranscripts.segments })
    .from(interviewTranscripts)
    .where(
      and(eq(interviewTranscripts.orgId, orgId), eq(interviewTranscripts.interviewId, interviewId)),
    )
    .limit(1);
  const { progressOf } = await import("@/lib/interview-plan.server");
  const { roundOf } = await import("@/lib/interview-plan");
  const plan = roundOf((await progressOf(orgId, r.applicationId)).plan, level);
  const [a] = await db
    .select({
      assessedAt: panelAssessments.assessedAt,
      summarySentAt: panelAssessments.summarySentAt,
      outcome: panelAssessments.outcome,
      reviewDecision: panelAssessments.reviewDecision,
    })
    .from(panelAssessments)
    .where(and(eq(panelAssessments.orgId, orgId), eq(panelAssessments.interviewId, interviewId)))
    .limit(1);
  return {
    ...r,
    segments: r.transcription === "ready" ? (t?.segments ?? []) : [],
    roundName: plan?.name ?? `L${level} interview`,
    roundFocus: plan?.focus ?? null,
    competencies: plan?.competencies ?? [],
    assessedAt: a?.assessedAt ?? null,
    summarySentAt: a?.summarySentAt ?? null,
    // The panel has scored, the views differ and the HR head has not reviewed it yet.
    reviewDue: Boolean(a?.outcome && a.outcome !== "agree" && !a.reviewDecision),
  };
}

type Round = Awaited<ReturnType<typeof loadRound>>;

const panelOf = (r: Round) => {
  const seen = new Set<string>();
  return [
    ...(r.interviewerEmail ? [{ name: r.interviewer, email: r.interviewerEmail }] : []),
    ...r.panel,
  ].filter((m) => {
    const k = m.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const unready = (r: Round): string | null =>
  r.transcription === "candidate_declined"
    ? "The candidate declined transcription for this round — there is nothing to read."
    : r.transcription !== "ready" || !r.segments.length
      ? "This round's transcript is not in."
      : null;

/** What the agent may know about a round: facts and progress, never the transcript or a score. */
export async function roundFacts(orgId: string, interviewId: string, level: PanelLevel) {
  const r = await loadRound(orgId, interviewId, level);
  const last = r.segments[r.segments.length - 1];
  return {
    interviewId: r.id,
    level: r.level,
    candidate: r.candidateName,
    role: r.jobTitle,
    round: r.roundName,
    competencies: r.competencies,
    panelMembers: panelOf(r).length,
    transcript:
      unready(r) ??
      `in — ${r.segments.length} turns, about ${Math.round((last?.endMs ?? 0) / 60_000)} minutes, ${speakersOf(r.segments).length} speakers`,
    assessed: Boolean(r.assessedAt),
    summarySent: Boolean(r.summarySentAt),
    reviewDue: r.reviewDue,
  };
}

export async function assessPrecheck(orgId: string, interviewId: string, level: PanelLevel) {
  const r = await loadRound(orgId, interviewId, level);
  return unready(r) ?? (r.assessedAt ? "This round is already assessed." : null);
}

const subjectOf = (r: Round) => ({
  applicationId: r.applicationId,
  candidateId: r.candidateId,
  requisitionId: r.requisitionId,
});

/**
 * The agent's own view of the call, stored hidden. Returns counts only —
 * never the rating, the verdict or the notes.
 */
export async function assessRound(
  ctx: { orgId: string; runId: string | null },
  interviewId: string,
  level: PanelLevel,
): Promise<{
  saved: true;
  /** The panel had already scored and its verdict differs: ask the HR head to review. */
  panelReviewDue?: true;
  competenciesAssessed: number;
  protectedGroundQuestions: number;
  injectionSuspected: boolean;
}> {
  const r = await loadRound(ctx.orgId, interviewId, level);
  const blocked = unready(r) ?? (r.assessedAt ? "This round is already assessed." : null);
  if (blocked) throw new Error(blocked);

  const panelNames = panelOf(r)
    .map((m) => m.name ?? m.email)
    .join(", ");
  const { system, prompt } = assessPrompt({
    jobTitle: r.jobTitle,
    level,
    roundName: r.roundName,
    roundFocus: r.roundFocus,
    competencies: r.competencies,
    candidateName: r.candidateName,
    panelNames,
    segments: r.segments,
  });

  const { withAiSubject } = await import("../agents/context");
  const res = await withAiSubject(subjectOf(r), () =>
    aiJson<AssessOutput>({
      orgId: ctx.orgId,
      feature: "panel_assess",
      system,
      prompt,
      schema: AssessOutput,
    }),
  );
  if (!res.ok) throw new Error(`The assessment could not be made: ${res.message}`);
  const view = buildAssessment(res.data, r.segments, r.competencies, r.candidateName);
  const values = {
    rating: view.rating,
    verdict: view.verdict,
    candidate: view.candidate,
    panel: view.panel,
    injectionSuspected: view.injectionSuspected,
    agentRunId: ctx.runId,
    assessedAt: new Date(),
  };
  await db
    .insert(panelAssessments)
    .values({ orgId: ctx.orgId, interviewId, applicationId: r.applicationId, level, ...values })
    .onConflictDoUpdate({ target: panelAssessments.interviewId, set: values });
  // The panel may have scored already (the transcript came late): compare now.
  const { reconcileAfterAssessment } = await import("./review.server");
  const late = await reconcileAfterAssessment(
    ctx.orgId,
    interviewId,
    level,
    ctx.runId ? `agent:panel_l${level}:${ctx.runId}` : `agent:panel_l${level}`,
  );
  return {
    saved: true,
    ...(late ? { panelReviewDue: true } : {}),
    competenciesAssessed: view.candidate.competencies.filter((c) => c.rating != null).length,
    protectedGroundQuestions: view.panel.offLimits.length,
    injectionSuspected: view.injectionSuspected,
  };
}

export async function summaryPrecheck(orgId: string, interviewId: string, level: PanelLevel) {
  const r = await loadRound(orgId, interviewId, level);
  return (
    unready(r) ??
    (r.summarySentAt ? "The panel already has this round's summary." : null) ??
    (panelOf(r).length ? null : "The round has nobody on its panel to send a summary to.")
  );
}

/**
 * A factual summary of the call — what was asked, how the candidate answered
 * — e-mailed to everyone on the round's panel. No score, verdict or judgement
 * (the model is told so, and the system drops any sentence that carries one).
 */
export async function sendPanelSummary(
  ctx: { orgId: string; runId: string | null },
  interviewId: string,
  level: PanelLevel,
): Promise<{ sentTo: number }> {
  const r = await loadRound(ctx.orgId, interviewId, level);
  const blocked =
    unready(r) ?? (r.summarySentAt ? "The panel already has this round's summary." : null);
  if (blocked) throw new Error(blocked);
  const members = panelOf(r);
  if (!members.length) throw new Error("The round has nobody on its panel to send a summary to.");

  const { system, prompt } = summaryPrompt({
    jobTitle: r.jobTitle,
    level,
    roundName: r.roundName,
    competencies: r.competencies,
    segments: r.segments,
  });
  const { withAiSubject } = await import("../agents/context");
  const res = await withAiSubject(subjectOf(r), () =>
    aiJson<SummaryOutput>({
      orgId: ctx.orgId,
      feature: "panel_summary",
      system,
      prompt,
      schema: SummaryOutput,
    }),
  );
  if (!res.ok) throw new Error(`The summary could not be written: ${res.message}`);
  const summary = scrubSummary(res.data);
  if (!summary.topics.length && !summary.overview)
    throw new Error("The summary came back empty once judgements were removed.");

  const { enqueueEmail, formatInOrgTZ, getOrgEmailSettings } =
    await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(ctx.orgId)).timezone;
  const site = env.PUBLIC_SITE_URL.replace(/\/$/, "");
  for (const m of members)
    await enqueueEmail({
      orgId: ctx.orgId,
      kind: "panel_summary",
      templateName: "panel_summary",
      toEmail: m.email,
      applicationId: r.applicationId,
      idempotencyKey: `panel-summary:${r.id}:${m.email.toLowerCase()}`,
      templateData: {
        memberName: m.name ?? undefined,
        orgName: r.orgName,
        candidateName: r.candidateName,
        jobTitle: r.jobTitle,
        roundLabel: `L${level} interview`,
        whenText: r.scheduledAt ? formatInOrgTZ(r.scheduledAt, tz) : undefined,
        overview: summary.overview || undefined,
        topicsJson: JSON.stringify(summary.topics),
        scorecardUrl: `${site}/interviews/mine`,
      },
    });
  await db
    .insert(panelAssessments)
    .values({
      orgId: ctx.orgId,
      interviewId,
      applicationId: r.applicationId,
      level,
      summarySentAt: new Date(),
    })
    .onConflictDoUpdate({
      target: panelAssessments.interviewId,
      set: { summarySentAt: new Date() },
    });
  return { sentTo: members.length };
}
