/**
 * Phase 2 agent tools (docs/agentic-plan.md §4.4, §4.5, §4.11): intake &
 * matching, screening and follow-up. Same rules as Phase 1: every tool runs
 * as the run's principal through the shared cores; rejecting candidates is a
 * human decision (request_approval with a rejection subject), never a tool.
 */
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { db } from "../db";
import {
  agentTasks,
  applications,
  candidateAssessments,
  candidates,
  jobDescriptions,
  matchScores,
  orgMembers,
  organizations,
  requisitions,
  screeningKits,
  screeningRuns,
} from "@db/schema";
import { env } from "../env";
import { registerTool, type ToolContext } from "./registry";

const actor = async (ctx: ToolContext) => {
  const { actorFor } = await import("@/lib/requisitions.server");
  return actorFor(ctx.orgId, ctx.principalUserId);
};

const clip = (s: string | null | undefined, n: number) =>
  s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null;

async function loadApplication(orgId: string, id: string) {
  const [row] = await db
    .select({
      id: applications.id,
      stage: applications.stage,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
      candidateName: candidates.fullName,
      candidateEmail: candidates.email,
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

async function orgName(orgId: string) {
  const [o] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return o?.name ?? "the hiring team";
}

const AppId = z.object({ applicationId: z.string().uuid() });
const ReqId = z.object({ requisitionId: z.string().uuid() });

/** Stages an agent may move a candidate to on its own (never reject, never offer). */
const AGENT_STAGES = ["shortlisted", "on_hold", "reserve"] as const;

export function registerPhase2Tools(): void {
  /* --------------------------------------------------------- intake */

  registerTool({
    name: "pipeline_summary",
    description:
      "Counts of applications per stage for a requisition, how many are still unscored, and the average match score.",
    input: ReqId,
    risk: "read",
    run: async (ctx, i) => {
      const stages = await db
        .select({ stage: applications.stage, n: sql<number>`count(*)::int` })
        .from(applications)
        .where(
          and(eq(applications.orgId, ctx.orgId), eq(applications.requisitionId, i.requisitionId)),
        )
        .groupBy(applications.stage);
      const [scored] = await db
        .select({
          scored: sql<number>`count(${matchScores.id})::int`,
          avg: sql<number | null>`round(avg(${matchScores.overallScore}))::int`,
        })
        .from(applications)
        .leftJoin(matchScores, eq(matchScores.applicationId, applications.id))
        .where(
          and(eq(applications.orgId, ctx.orgId), eq(applications.requisitionId, i.requisitionId)),
        );
      const total = stages.reduce((s, r) => s + Number(r.n), 0);
      return {
        total,
        byStage: Object.fromEntries(stages.map((r) => [r.stage, Number(r.n)])),
        unscored: total - Number(scored?.scored ?? 0),
        averageScore: scored?.avg ?? null,
      };
    },
  });

  registerTool({
    name: "list_applications",
    description:
      "List applications for a requisition (optionally one stage) with match score, recommendation, missing skills and risk flags. Highest score first.",
    input: ReqId.extend({
      stage: z.string().max(40).optional(),
      limit: z.number().int().min(1).max(50).default(25),
    }),
    risk: "read",
    untrustedOutput: true,
    run: async (ctx, i) => {
      const rows = await db
        .select({
          applicationId: applications.id,
          candidateId: candidates.id,
          name: candidates.fullName,
          stage: applications.stage,
          experienceYears: candidates.experienceYears,
          score: matchScores.overallScore,
          recommendation: matchScores.recommendation,
          missingSkills: matchScores.missingSkills,
          riskFlags: matchScores.riskFlags,
          rationale: matchScores.rationale,
          injectionFlag: candidates.suspectedPromptInjection,
        })
        .from(applications)
        .innerJoin(candidates, eq(candidates.id, applications.candidateId))
        .leftJoin(matchScores, eq(matchScores.applicationId, applications.id))
        .where(
          and(
            eq(applications.orgId, ctx.orgId),
            eq(applications.requisitionId, i.requisitionId),
            i.stage ? eq(applications.stage, i.stage as never) : undefined,
          ),
        )
        .orderBy(desc(sql`coalesce(${matchScores.overallScore}, -1)`))
        .limit(i.limit);
      return rows.map((r) => ({ ...r, rationale: clip(r.rationale, 300) }));
    },
  });

  registerTool({
    name: "score_new_applications",
    description:
      "Score every unscored application for a requisition against its JD (up to 25 per call). Strong matches are shortlisted automatically, the rest are held at ai_screened for a person to review.",
    input: ReqId,
    risk: "write",
    skills: ["candidate_score", "linkedin_signal", "writing_signal"],
    describe: () => "Score new applications against the JD",
    run: async (ctx, i) => {
      const { scoreUnscored } = await import("@/lib/autoscore.server");
      const r = await scoreUnscored({
        orgId: ctx.orgId,
        requisitionId: i.requisitionId,
        limit: 25,
      });
      return { scored: r.scored, errors: r.errors };
    },
  });

  registerTool({
    name: "move_candidate",
    description:
      "Move a candidate to shortlisted, on_hold or reserve, with a reason. Rejections are never done with this tool — propose them with request_approval.",
    input: AppId.extend({ toStage: z.enum(AGENT_STAGES), reason: z.string().min(3).max(500) }),
    risk: "write",
    describe: (i) => `Move a candidate to ${i.toStage}: ${i.reason}`,
    run: async (ctx, i) => {
      const { moveStageCore } = await import("@/lib/pipeline.server");
      return moveStageCore(await actor(ctx), {
        applicationId: i.applicationId,
        toStage: i.toStage,
        reason: i.reason,
      });
    },
  });

  registerTool({
    name: "search_talent_pool",
    description:
      "Find people already in the organisation's talent pool who match the requisition's must-haves by meaning (equivalent terms, e.g. LLM = large language models), in their skills or CV text, and who are not yet in its pipeline. Ranked by evidence, experience band and location; each result says why it matched.",
    input: ReqId.extend({ limit: z.number().int().min(1).max(20).default(15) }),
    risk: "read",
    untrustedOutput: true,
    skills: ["talent_search"],
    run: async (ctx, i) => {
      const { searchTalentPool } = await import("../agents/talent-search.server");
      const r = await searchTalentPool(ctx.orgId, i.requisitionId, i.limit);
      return {
        searchedFor: r.searchedFor.map((g) => `${g.skill}: ${g.terms.join(", ")}`),
        matches: r.matches,
      };
    },
  });

  registerTool({
    name: "add_to_pipeline",
    description: "Add talent-pool candidates to a requisition's pipeline (they are then scored).",
    input: ReqId.extend({ candidateIds: z.array(z.string().uuid()).min(1).max(20) }),
    risk: "write",
    describe: (i) => `Add ${i.candidateIds.length} talent-pool candidate(s) to the pipeline`,
    run: async (ctx, i) => {
      const { addApplicationsCore } = await import("@/lib/pipeline.server");
      return addApplicationsCore(await actor(ctx), {
        requisitionId: i.requisitionId,
        candidateIds: i.candidateIds,
        source: "agent_talent_pool",
      });
    },
  });

  registerTool({
    name: "add_candidate_note",
    description: "Add a note to a candidate's record that the hiring team will see.",
    input: z.object({ candidateId: z.string().uuid(), note: z.string().min(3).max(4000) }),
    risk: "write",
    describe: () => "Add a note to the candidate's record",
    run: async (ctx, i) => {
      const { addCandidateNoteCore } = await import("@/lib/pipeline.server");
      return addCandidateNoteCore(await actor(ctx), { candidateId: i.candidateId, body: i.note });
    },
  });

  /* ------------------------------------------------------- screening */

  registerTool({
    name: "get_screening_status",
    description:
      "For one application: whether a screening kit is ready, the latest screening-call result, and the latest assessment (status, score, completed).",
    input: AppId,
    risk: "read",
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      const [kit] = await db
        .select({ id: screeningKits.id, createdAt: screeningKits.createdAt })
        .from(screeningKits)
        .where(
          and(
            eq(screeningKits.orgId, ctx.orgId),
            eq(screeningKits.candidateId, app.candidateId),
            eq(screeningKits.requisitionId, app.requisitionId),
          ),
        )
        .orderBy(desc(screeningKits.createdAt))
        .limit(1);
      const [run] = await db
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
          status: candidateAssessments.status,
          mindsetScore: candidateAssessments.mindsetScore,
          createdAt: candidateAssessments.createdAt,
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
      return {
        candidate: app.candidateName,
        stage: app.stage,
        kitReady: Boolean(kit),
        screeningCall: run ?? null,
        assessment: assessment ?? null,
      };
    },
  });

  registerTool({
    name: "prepare_screening_kit",
    description:
      "Build the screening-call kit (questions and focus areas) for a shortlisted candidate if it is missing.",
    input: AppId,
    risk: "write",
    skills: ["screening_kit"],
    describe: () => "Prepare the screening-call kit",
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      const { prepareScreeningKitForPairing } = await import("@/lib/screening.functions");
      const kit = await prepareScreeningKitForPairing({
        orgId: ctx.orgId,
        candidateId: app.candidateId,
        requisitionId: app.requisitionId,
        createdBy: ctx.principalUserId,
      });
      return { kitId: kit.kitId, questions: kit.questions.length, focus: kit.focus_summary };
    },
  });

  registerTool({
    name: "send_assessment",
    description:
      "Create a role-specific written assessment for a shortlisted candidate and email them the private link. Leaves the organisation, so a person approves it unless the assessment email is pre-approved.",
    input: AppId.extend({ dueInDays: z.number().int().min(1).max(14).default(3) }),
    risk: "external",
    skills: ["assessment_generate"],
    templateOf: () => "assessment_invite",
    describe: (i) => `Send a written assessment (due in ${i.dueInDays} days)`,
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      if (!app.candidateEmail) throw new Error("The candidate has no email address.");
      if (app.stage !== "shortlisted") {
        throw new Error(`Assessments go to shortlisted candidates; this one is ${app.stage}.`);
      }
      const { createAssessmentCore } = await import("@/lib/assessment.functions");
      const a = await createAssessmentCore(ctx.orgId, {
        candidateId: app.candidateId,
        requisitionId: app.requisitionId,
        count: 6,
      });
      const due = new Date(Date.now() + i.dueInDays * 864e5);
      const { enqueueEmail } = await import("@/lib/email-outbox.server");
      await enqueueEmail({
        orgId: ctx.orgId,
        kind: "assessment_invite",
        templateName: "assessment_invite",
        toEmail: app.candidateEmail,
        applicationId: app.id,
        idempotencyKey: `assessment:${a.id}`,
        templateData: {
          candidateName: app.candidateName ?? undefined,
          orgName: await orgName(ctx.orgId),
          jobTitle: app.jobTitle,
          assessmentUrl: `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/assess/${a.token}`,
          dueDate: due.toDateString(),
        },
      });
      return { assessmentId: a.id, emailed: true, due: due.toISOString().slice(0, 10) };
    },
  });

  registerTool({
    name: "remind_assessment",
    description:
      "Email a candidate a reminder about an assessment they have not completed yet (once per day at most).",
    input: AppId,
    risk: "external",
    templateOf: () => "assessment_invite",
    describe: () => "Send an assessment reminder to the candidate",
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      const [a] = await db
        .select({
          id: candidateAssessments.id,
          token: candidateAssessments.token,
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
      if (!a) throw new Error("No assessment was sent to this candidate.");
      if (a.completedAt) throw new Error("The candidate already completed the assessment.");
      if (!app.candidateEmail) throw new Error("The candidate has no email address.");
      const { enqueueEmail } = await import("@/lib/email-outbox.server");
      await enqueueEmail({
        orgId: ctx.orgId,
        kind: "assessment_invite",
        templateName: "assessment_invite",
        toEmail: app.candidateEmail,
        applicationId: app.id,
        idempotencyKey: `assessment-reminder:${a.id}:${new Date().toISOString().slice(0, 10)}`,
        templateData: {
          candidateName: app.candidateName ?? undefined,
          orgName: await orgName(ctx.orgId),
          jobTitle: app.jobTitle,
          assessmentUrl: `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/assess/${a.token}`,
          reminder: "yes",
        },
      });
      return { reminded: true };
    },
  });

  /* -------------------------------------------------------- follow-up */

  registerTool({
    name: "list_overdue",
    description:
      "Everything overdue in the organisation: requisitions and JDs waiting for approval longer than the SLA, agent requests nobody answered, and assessments candidates have not completed.",
    input: z.object({ slaDays: z.number().int().min(1).max(30).default(2) }),
    risk: "read",
    run: async (ctx, i) => {
      const cutoff = new Date(Date.now() - i.slaDays * 864e5);
      const { APPROVER_ROLE } = await import("@/lib/requisitions.server");
      const reqs = await db
        .select({
          id: requisitions.id,
          code: requisitions.code,
          title: requisitions.title,
          status: requisitions.status,
          trail: requisitions.approvalTrail,
          createdAt: requisitions.createdAt,
        })
        .from(requisitions)
        .where(
          and(
            eq(requisitions.orgId, ctx.orgId),
            inArray(requisitions.status, ["pending_dh", "pending_hr", "pending_cbo"]),
          ),
        );
      const waitingSince = (r: (typeof reqs)[number]) => {
        const t = Array.isArray(r.trail) ? (r.trail as { at?: string }[]) : [];
        return new Date(t.at(-1)?.at ?? r.createdAt);
      };
      const requisitionApprovals = reqs
        .filter((r) => waitingSince(r) < cutoff)
        .map((r) => ({
          requisitionId: r.id,
          code: r.code,
          title: r.title,
          waitingFor: APPROVER_ROLE[r.status],
          days: Math.floor((Date.now() - waitingSince(r).getTime()) / 864e5),
        }));
      const jds = await db
        .select({
          jdId: jobDescriptions.id,
          requisitionId: jobDescriptions.requisitionId,
          version: jobDescriptions.version,
          createdAt: jobDescriptions.createdAt,
        })
        .from(jobDescriptions)
        .where(
          and(
            eq(jobDescriptions.orgId, ctx.orgId),
            eq(jobDescriptions.status, "pending_dh"),
            lt(jobDescriptions.createdAt, cutoff),
          ),
        );
      const tasks = await db
        .select({
          taskId: agentTasks.id,
          title: agentTasks.title,
          assigneeRole: agentTasks.assigneeRole,
          assigneeUserId: agentTasks.assigneeUserId,
          createdAt: agentTasks.createdAt,
        })
        .from(agentTasks)
        .where(
          and(
            eq(agentTasks.orgId, ctx.orgId),
            eq(agentTasks.status, "open"),
            lt(agentTasks.createdAt, cutoff),
          ),
        );
      const assessments = await db
        .select({
          candidateId: candidateAssessments.candidateId,
          requisitionId: candidateAssessments.requisitionId,
          sentAt: candidateAssessments.createdAt,
        })
        .from(candidateAssessments)
        .where(
          and(
            eq(candidateAssessments.orgId, ctx.orgId),
            isNull(candidateAssessments.completedAt),
            lt(candidateAssessments.createdAt, cutoff),
          ),
        );
      return { requisitionApprovals, jdReviews: jds, agentRequests: tasks, assessments };
    },
  });

  registerTool({
    name: "list_members",
    description: "List the organisation's active members with their roles (to address reminders).",
    input: z.object({}),
    risk: "read",
    run: async (ctx) => {
      const { userRoles } = await import("@db/schema");
      const members = await db
        .select({
          userId: orgMembers.userId,
          name: orgMembers.fullName,
          isOwner: orgMembers.isOwner,
        })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.status, "active")));
      const roles = await db
        .select({ userId: userRoles.userId, role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.orgId, ctx.orgId));
      return members.map((m) => ({
        ...m,
        roles: roles.filter((r) => r.userId === m.userId).map((r) => r.role),
      }));
    },
  });

  registerTool({
    name: "remind_member",
    description:
      "Email a member of the organisation a short reminder about something waiting for them, with a link to it. Internal only; at most one reminder per member per topic per day.",
    input: z.object({
      userId: z.string().uuid(),
      heading: z.string().min(5).max(140),
      message: z.string().min(5).max(1000),
      path: z
        .string()
        .regex(/^\/[A-Za-z0-9/_\-?=&.]*$/)
        .max(200)
        .describe("App path to open, e.g. /requisitions/<id> or /agents"),
    }),
    risk: "write",
    describe: (i) => `Email a reminder: ${i.heading}`,
    run: async (ctx, i) => {
      const [m] = await db
        .select({ email: orgMembers.email, name: orgMembers.fullName })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.orgId, ctx.orgId),
            eq(orgMembers.userId, i.userId),
            eq(orgMembers.status, "active"),
          ),
        )
        .limit(1);
      if (!m?.email) throw new Error("That person is not an active member of this organisation.");
      const { enqueueEmail } = await import("@/lib/email-outbox.server");
      const day = new Date().toISOString().slice(0, 10);
      await enqueueEmail({
        orgId: ctx.orgId,
        kind: "member_reminder",
        templateName: "member_reminder",
        toEmail: m.email,
        idempotencyKey: `reminder:${i.userId}:${i.heading.toLowerCase().slice(0, 60)}:${day}`,
        templateData: {
          memberName: m.name ?? undefined,
          orgName: await orgName(ctx.orgId),
          heading: i.heading,
          message: i.message,
          actionUrl: `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}${i.path}`,
        },
      });
      return { reminded: true };
    },
  });
}
