/**
 * Phase 3 agent tools (docs/agentic-plan.md §4.6, §4.7): interview
 * coordination and evaluation. Scheduling sends the candidate an invite, so
 * it is an external action (pre-approvable as "interview_invite"); panels are
 * limited to active members; the hiring decision is never a tool — the
 * Evaluation agent asks for it with request_approval (hiring_decision).
 */
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { db } from "../db";
import {
  applications,
  candidateAssessments,
  candidates,
  evaluations,
  interviews,
  matchScores,
  orgMembers,
  requisitions,
  screeningRuns,
  sourceIntegrations,
  userRoles,
} from "@db/schema";
import { registerTool, type ToolContext } from "./registry";

const AppId = z.object({ applicationId: z.string().uuid() });

const actorLabel = async (ctx: ToolContext) => {
  const { actorFor } = await import("@/lib/requisitions.server");
  const a = await actorFor(ctx.orgId, ctx.principalUserId);
  return `${a.memberEmail} (via agent)`;
};

async function loadApplication(orgId: string, id: string) {
  const [row] = await db
    .select({
      id: applications.id,
      stage: applications.stage,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
      candidateName: candidates.fullName,
      jobTitle: requisitions.title,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(and(eq(applications.id, id), eq(applications.orgId, orgId)))
    .limit(1);
  if (!row) throw new Error("Application not found.");
  return row;
}

async function roundsOf(orgId: string, applicationId: string) {
  const rounds = await db
    .select({
      interviewId: interviews.id,
      level: interviews.level,
      interviewer: interviews.interviewer,
      interviewerEmail: interviews.interviewerEmail,
      scheduledAt: interviews.scheduledAt,
      status: interviews.status,
    })
    .from(interviews)
    .where(and(eq(interviews.orgId, orgId), eq(interviews.applicationId, applicationId)))
    .orderBy(asc(interviews.level));
  const cards = await db
    .select({
      interviewId: evaluations.interviewId,
      level: evaluations.level,
      rating: evaluations.rating,
      verdict: evaluations.recommendation,
      competencies: evaluations.competencies,
      comments: evaluations.comments,
      evaluator: evaluations.evaluator,
    })
    .from(evaluations)
    .where(and(eq(evaluations.orgId, orgId), eq(evaluations.applicationId, applicationId)))
    .orderBy(asc(evaluations.level));
  return { rounds, cards };
}

export function registerPhase3Tools(): void {
  /* ------------------------------------------------------ coordinator */

  registerTool({
    name: "get_interview_plan",
    description:
      "For one application: current stage, every interview round so far (level, interviewer, time, status) with its scorecard verdict, and which level should be scheduled next.",
    input: AppId,
    risk: "read",
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      const { rounds, cards } = await roundsOf(ctx.orgId, app.id);
      const scored = new Set(cards.map((c) => c.interviewId));
      const match = app.stage.match(/^l([123])$/);
      const nextLevel = match ? Number(match[1]) : app.stage === "shortlisted" ? 1 : null;
      const alreadyBooked = rounds.some(
        (r) => r.level === nextLevel && ["scheduled", "rescheduled"].includes(r.status),
      );
      return {
        candidate: app.candidateName,
        job: app.jobTitle,
        stage: app.stage,
        rounds: rounds.map((r) => ({
          ...r,
          scored: scored.has(r.interviewId),
          verdict: cards.find((c) => c.interviewId === r.interviewId)?.verdict ?? null,
        })),
        nextLevelToSchedule: alreadyBooked ? null : nextLevel,
      };
    },
  });

  registerTool({
    name: "list_panel_options",
    description:
      "Who can interview for a requisition: active members holding hiring-manager or department-head roles, and members who interviewed for it before (with how many rounds).",
    input: z.object({ requisitionId: z.string().uuid() }),
    risk: "read",
    run: async (ctx, i) => {
      const members = await db
        .select({
          userId: orgMembers.userId,
          name: orgMembers.fullName,
          email: orgMembers.email,
          role: userRoles.role,
        })
        .from(orgMembers)
        .leftJoin(
          userRoles,
          and(eq(userRoles.userId, orgMembers.userId), eq(userRoles.orgId, orgMembers.orgId)),
        )
        .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.status, "active")));
      const past = await db
        .select({
          email: sql<string>`lower(${interviews.interviewerEmail})`,
          rounds: sql<number>`count(*)::int`,
        })
        .from(interviews)
        .innerJoin(applications, eq(applications.id, interviews.applicationId))
        .where(
          and(
            eq(interviews.orgId, ctx.orgId),
            eq(applications.requisitionId, i.requisitionId),
            sql`${interviews.interviewerEmail} is not null`,
          ),
        )
        .groupBy(sql`lower(${interviews.interviewerEmail})`);
      const byEmail = new Map<
        string,
        { userId: string; name: string | null; email: string; roles: string[] }
      >();
      for (const m of members) {
        const key = m.email.toLowerCase();
        const e = byEmail.get(key) ?? {
          userId: m.userId ?? "",
          name: m.name,
          email: m.email,
          roles: [] as string[],
        };
        if (m.role) e.roles.push(m.role);
        byEmail.set(key, e);
      }
      return [...byEmail.values()]
        .map((m) => ({
          ...m,
          pastRounds: past.find((p) => p.email === m.email.toLowerCase())?.rounds ?? 0,
        }))
        .filter(
          (m) =>
            m.pastRounds > 0 ||
            m.roles.some((r) => r === "hiring_manager" || r === "department_head"),
        )
        .sort((a, b) => b.pastRounds - a.pastRounds);
    },
  });

  registerTool({
    name: "schedule_interview",
    description:
      "Book an interview round and email the candidate the invite with a calendar file. The interviewer must be an active member of the organisation. Optionally creates a Zoom / Google Meet / Teams link when that integration is connected. There is no calendar free/busy check: propose a working-hours slot at least one day ahead; a person reviews it unless the interview invitation is pre-approved.",
    input: AppId.extend({
      level: z.number().int().min(1).max(3),
      interviewerEmail: z.string().email(),
      scheduledAt: z
        .string()
        .describe("ISO 8601 start time with offset, e.g. 2026-10-12T10:30:00+05:30"),
      durationMins: z.number().int().min(15).max(240).default(60),
      mode: z.enum(["online", "onsite", "phone"]).default("online"),
      meetingProvider: z.enum(["zoom", "google_meet", "teams"]).optional(),
      agenda: z.string().max(2000).optional(),
    }),
    risk: "external",
    templateOf: () => "interview_invite",
    describe: (i) => `Book L${i.level} with ${i.interviewerEmail} at ${i.scheduledAt}`,
    run: async (ctx, i) => {
      const when = new Date(i.scheduledAt);
      if (Number.isNaN(when.getTime())) throw new Error("scheduledAt is not a valid date-time.");
      if (when.getTime() < Date.now() + 12 * 3600_000)
        throw new Error("Schedule at least 12 hours ahead.");
      if (when.getTime() > Date.now() + 60 * 864e5)
        throw new Error("Schedule within the next 60 days.");
      const [member] = await db
        .select({ name: orgMembers.fullName, email: orgMembers.email })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.orgId, ctx.orgId),
            eq(orgMembers.status, "active"),
            sql`lower(${orgMembers.email}) = ${i.interviewerEmail.toLowerCase()}`,
          ),
        )
        .limit(1);
      if (!member) throw new Error("Interviewers must be active members of the organisation.");
      const app = await loadApplication(ctx.orgId, i.applicationId);

      let meetingLink: string | null = null;
      if (i.mode === "online" && i.meetingProvider) {
        const [integration] = await db
          .select({ enabled: sourceIntegrations.enabled, ready: sourceIntegrations.hasCredentials })
          .from(sourceIntegrations)
          .where(
            and(
              eq(sourceIntegrations.orgId, ctx.orgId),
              eq(sourceIntegrations.provider, i.meetingProvider),
            ),
          )
          .limit(1);
        if (!integration?.enabled || !integration.ready) {
          throw new Error(
            `${i.meetingProvider} is not connected; omit meetingProvider or connect it in Integrations.`,
          );
        }
        const { createMeetingLinkCore } = await import("@/lib/meetings.functions");
        const meeting = await createMeetingLinkCore(ctx.orgId, {
          provider: i.meetingProvider,
          topic: `L${i.level} interview: ${app.jobTitle}`,
          startIso: when.toISOString(),
          durationMins: i.durationMins,
          attendees: [member.email],
          agenda: i.agenda ?? null,
        });
        meetingLink = meeting.joinUrl;
      }

      const { scheduleInterviewCore } = await import("@/lib/interviews.functions");
      const r = await scheduleInterviewCore(
        { orgId: ctx.orgId, actor: await actorLabel(ctx) },
        {
          applicationId: app.id,
          level: i.level,
          interviewer: member.name ?? member.email,
          interviewerEmail: member.email,
          scheduledAt: when.toISOString(),
          durationMins: i.durationMins,
          mode: i.mode,
          meetingLink,
          agenda: i.agenda ?? null,
        },
      );
      return {
        booked: true,
        level: i.level,
        at: when.toISOString(),
        meetingLink,
        candidateEmailed: r.candidateEmail,
      };
    },
  });

  registerTool({
    name: "list_pending_scorecards",
    description:
      "Interview rounds that finished at least two hours ago without a scorecard (optionally for one requisition), with the interviewer to chase.",
    input: z.object({ requisitionId: z.string().uuid().optional() }),
    risk: "read",
    run: async (ctx, i) => {
      const rows = await db
        .select({
          interviewId: interviews.id,
          applicationId: interviews.applicationId,
          level: interviews.level,
          interviewer: interviews.interviewer,
          interviewerEmail: interviews.interviewerEmail,
          scheduledAt: interviews.scheduledAt,
          candidate: candidates.fullName,
          requisitionId: applications.requisitionId,
        })
        .from(interviews)
        .innerJoin(applications, eq(applications.id, interviews.applicationId))
        .innerJoin(candidates, eq(candidates.id, applications.candidateId))
        .leftJoin(evaluations, eq(evaluations.interviewId, interviews.id))
        .where(
          and(
            eq(interviews.orgId, ctx.orgId),
            i.requisitionId ? eq(applications.requisitionId, i.requisitionId) : undefined,
            isNull(evaluations.id),
            inArray(interviews.status, ["scheduled", "rescheduled", "completed"]),
            lt(
              sql`${interviews.scheduledAt} + make_interval(mins => ${interviews.durationMins})`,
              sql`now() - interval '2 hours'`,
            ),
          ),
        )
        .orderBy(asc(interviews.scheduledAt))
        .limit(50);
      const members = await db
        .select({ userId: orgMembers.userId, email: orgMembers.email })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.status, "active")));
      return rows.map((r) => ({
        ...r,
        interviewerUserId:
          members.find((m) => m.email.toLowerCase() === (r.interviewerEmail ?? "").toLowerCase())
            ?.userId ?? null,
      }));
    },
  });

  /* ------------------------------------------------------- evaluation */

  registerTool({
    name: "get_candidate_dossier",
    description:
      "Everything the hiring team knows about one application: match score and gaps, screening-call and assessment results, and every interview scorecard (ratings, competencies, comments, verdicts).",
    input: AppId,
    risk: "read",
    untrustedOutput: true,
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      const [score] = await db
        .select({
          overall: matchScores.overallScore,
          recommendation: matchScores.recommendation,
          matched: matchScores.matchedSkills,
          missing: matchScores.missingSkills,
          risks: matchScores.riskFlags,
        })
        .from(matchScores)
        .where(and(eq(matchScores.orgId, ctx.orgId), eq(matchScores.applicationId, app.id)))
        .limit(1);
      const [screen] = await db
        .select({
          screeningScore: screeningRuns.screeningScore,
          combinedScore: screeningRuns.combinedScore,
        })
        .from(screeningRuns)
        .where(and(eq(screeningRuns.orgId, ctx.orgId), eq(screeningRuns.applicationId, app.id)))
        .orderBy(desc(screeningRuns.createdAt))
        .limit(1);
      const [assessment] = await db
        .select({
          mindsetScore: candidateAssessments.mindsetScore,
          redFlags: candidateAssessments.redFlags,
          completedAt: candidateAssessments.completedAt,
        })
        .from(candidateAssessments)
        .where(
          and(
            eq(candidateAssessments.orgId, ctx.orgId),
            eq(candidateAssessments.candidateId, app.candidateId),
            eq(candidateAssessments.requisitionId, app.requisitionId),
          ),
        )
        .orderBy(desc(candidateAssessments.createdAt))
        .limit(1);
      const { rounds, cards } = await roundsOf(ctx.orgId, app.id);
      return {
        candidateId: app.candidateId,
        candidate: app.candidateName,
        job: app.jobTitle,
        stage: app.stage,
        match: score ?? null,
        screening: screen ?? null,
        assessment: assessment ?? null,
        rounds,
        scorecards: cards,
      };
    },
  });

  registerTool({
    name: "selection_parity",
    description:
      "Fairness check across the organisation: shortlist rate by application source and whether any source falls below four-fifths of the best (protected attributes are not collected).",
    input: z.object({}),
    risk: "read",
    run: async (ctx) => {
      const { selectionParity } = await import("@/lib/bias.server");
      const r = await selectionParity(ctx.orgId);
      return { rows: r.rows, breaches: r.breaches, enoughData: r.rows.length >= 2 };
    },
  });
}
