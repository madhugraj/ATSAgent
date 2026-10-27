/**
 * Phase 3 agent tools (docs/agentic-plan.md §4.6, §4.7): interview
 * coordination and evaluation. Scheduling sends the candidate an invite, so
 * it is an external action (pre-approvable as "interview_invite"); panels are
 * limited to active members; the hiring decision is never a tool — the
 * Evaluation agent asks for it with request_approval (hiring_decision).
 */
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

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
import { assertRequisitionInOrg } from "../guards";
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

/** Agents offer and book times only with the round's approved panel (a reason, or null). */
async function panelRefusal(
  ctx: ToolContext,
  i: {
    applicationId: string;
    level: number;
    interviewerEmail: string;
    panelEmails?: string[] | undefined;
  },
): Promise<string | null> {
  const app = await loadApplication(ctx.orgId, i.applicationId);
  const { panelMismatch } = await import("@/lib/panels.server");
  return panelMismatch(ctx.orgId, app.id, i.level, [i.interviewerEmail, ...(i.panelEmails ?? [])]);
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
      panel: interviews.panel,
      outcomeNote: interviews.outcomeNote,
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
      evaluatorEmail: evaluations.evaluatorEmail,
    })
    .from(evaluations)
    .where(and(eq(evaluations.orgId, orgId), eq(evaluations.applicationId, applicationId)))
    .orderBy(asc(evaluations.level));
  return { rounds, cards };
}

export { localWhen } from "@/lib/local-time";
import { localWhen } from "@/lib/local-time";

const orgZone = async (orgId: string) =>
  (await (await import("@/lib/email-outbox.server")).getOrgEmailSettings(orgId)).timezone;

export function registerPhase3Tools(): void {
  /* ------------------------------------------------------ coordinator */

  registerTool({
    name: "get_interview_plan",
    description:
      "For one application: whether screening is on record (a shortlisted candidate is interviewed only after screening), the role's interview plan (rounds with name, focus, competencies and panel size; the verdict policy), every round so far (level, interviewers, time, status, who has and has not scored, the round's verdict, and rounds that did not happen), and which level to schedule next with how many interviewers.",
    input: AppId,
    risk: "read",
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      const { rounds } = await roundsOf(ctx.orgId, app.id);
      const { progressOf } = await import("@/lib/interview-plan.server");
      const p = await progressOf(ctx.orgId, app.id);
      const match = app.stage.match(/^l([123])$/);
      const { screeningOnRecord } = await import("@/lib/pipeline.server");
      // A shortlisted candidate is interviewed only after screening (a person can
      // still move them on with a reason).
      const screened = match ? true : await screeningOnRecord(ctx.orgId, app.id);
      const nextLevel = match
        ? Number(match[1])
        : app.stage === "shortlisted" && screened
          ? 1
          : null;
      const alreadyBooked = rounds.some(
        (r) =>
          r.level === nextLevel && ["scheduled", "rescheduled", "completed"].includes(r.status),
      );
      const next =
        nextLevel && !alreadyBooked && nextLevel <= p.finalLevel
          ? (p.plan.rounds.find((r) => r.level === nextLevel) ?? null)
          : null;
      return {
        candidate: app.candidateName,
        job: app.jobTitle,
        stage: app.stage,
        plan: p.plan,
        finalLevel: p.finalLevel,
        rounds: rounds.map((r) => {
          const pr = p.rounds.find((x) => x.interviewId === r.interviewId);
          return {
            ...r,
            interviewers: pr?.panel ?? [],
            scoredBy: pr?.submitted ?? [],
            waitingFor: pr?.missing ?? [],
            complete: pr?.complete ?? false,
            verdict: pr?.verdict ?? null,
          };
        }),
        nextLevelToSchedule: next ? next.level : null,
        nextRound: next,
        ...(!screened
          ? { waitingFor: "screening — no screening call, assessment or AI screen yet" }
          : {}),
      };
    },
  });

  registerTool({
    name: "list_panel_options",
    description:
      "Who can interview for one round of a requisition. `approved`: the round's approved panel (with applicationId: that candidate's panel, including approved stand-ins) — use exactly these people — or null. `waitingForDecision`: a proposed panel is waiting for a person. `eligible`: the people who may be proposed, best first — the round's competencies their registered areas cover, rounds they took for this role, then the lightest load (interviews in the next 7 days against their weekly limit). Only eligible people can be proposed.",
    input: z.object({
      requisitionId: z.string().uuid(),
      level: z.number().int().min(1).max(3),
      /** A candidate: `approved` is their panel, with any approved stand-ins. */
      applicationId: z.string().uuid().optional(),
    }),
    risk: "read",
    run: async (ctx, i) => {
      await assertRequisitionInOrg(i.requisitionId, ctx.orgId);
      const { approvedPanel, eligibleInterviewers, roundPanel } =
        await import("@/lib/panels.server");
      if (i.applicationId) {
        const app = await loadApplication(ctx.orgId, i.applicationId);
        if (app.requisitionId !== i.requisitionId)
          throw new Error("That candidate is not on this requisition.");
      }
      const approved = i.applicationId
        ? await roundPanel(ctx.orgId, i.applicationId, i.level)
        : await approvedPanel(ctx.orgId, i.requisitionId, i.level);
      const [waiting] = (await db.execute(sql`
        select 1 from agent_tasks where org_id = ${ctx.orgId} and status = 'open' and kind = 'gate'
          and proposed_action -> 'args' -> 'subject' ->> 'type' = 'panel_approval'
          and proposed_action -> 'args' -> 'subject' ->> 'requisitionId' = ${i.requisitionId}
          and (proposed_action -> 'args' -> 'subject' ->> 'level')::int = ${i.level}
        limit 1`)) as unknown as unknown[];
      const { registered, people, full } = await eligibleInterviewers(
        ctx.orgId,
        i.requisitionId,
        i.level,
      );
      return {
        level: i.level,
        approved: approved?.members ?? null,
        waitingForDecision: Boolean(waiting),
        eligible: people,
        ...(full.length ? { atWeeklyLimit: full } : {}),
        ...(registered
          ? {}
          : {
              note: "No interviewers are registered on the Team page; every active member is listed.",
            }),
      };
    },
  });

  registerTool({
    name: "propose_panel",
    description:
      "Propose who interviews for one round of a requisition — memberIds from list_panel_options' eligible list, at most the round's panel size, best fit first, with a one-line reason. A person (the role's hiring manager, else the HR head) approves it or changes the people; you are then told the approved panel. Approved panels are reused for every candidate of that role and round.",
    input: z.object({
      requisitionId: z.string().uuid(),
      level: z.number().int().min(1).max(3),
      memberIds: z.array(z.string().uuid()).min(1).max(3),
      reason: z.string().min(10).max(600),
    }),
    risk: "write",
    describe: (i) => `Interview panel for L${i.level}`,
    precheck: async (ctx, i) => {
      const { approvedPanel } = await import("@/lib/panels.server");
      const p = await approvedPanel(ctx.orgId, i.requisitionId, i.level);
      return p
        ? `Round L${i.level} already has an approved panel (${p.members.map((m) => m.name).join(", ")}); use it. A person changes it, not you.`
        : null;
    },
    proposes: async (ctx, i) => {
      await assertRequisitionInOrg(i.requisitionId, ctx.orgId);
      return {
        title: `Who interviews for L${i.level}?`,
        summary: i.reason,
        subject: {
          type: "panel_approval",
          requisitionId: i.requisitionId,
          level: i.level,
          memberIds: i.memberIds,
          reason: i.reason,
        },
      };
    },
    run: async () => {
      throw new Error("A panel is decided by a person.");
    },
  });

  registerTool({
    name: "list_substitutes",
    description:
      "Who could stand in for one panellist on one candidate's round (someone who cannot make it, or is away for the candidate's window): eligible interviewers for the round not already on it, best first. When the round is booked, `freeAtBookedTime` says whether each is free then — prefer someone who is, so the candidate's time stays.",
    input: AppId.extend({
      level: z.number().int().min(1).max(3),
      replaceMemberId: z.string().uuid(),
    }),
    risk: "read",
    run: async (ctx, i) => {
      await loadApplication(ctx.orgId, i.applicationId);
      const { substituteOptions } = await import("@/lib/panels.server");
      const r = await substituteOptions(ctx.orgId, i.applicationId, i.level, i.replaceMemberId);
      const tz = await orgZone(ctx.orgId);
      return { ...r, bookedLocal: r.bookedAt ? localWhen(r.bookedAt, tz) : null };
    },
  });

  registerTool({
    name: "propose_substitute",
    description:
      "Propose a stand-in for one panellist on one candidate's round only (the role's panel is unchanged) — withMemberId from list_substitutes, with a one-line reason. A person (the role's hiring manager, else the HR head) decides. If approved and the round is booked: when the stand-in is free at that time the booking stays; otherwise the booking is cancelled and you are asked to offer new times.",
    input: AppId.extend({
      level: z.number().int().min(1).max(3),
      replaceMemberId: z.string().uuid(),
      withMemberId: z.string().uuid(),
      reason: z.string().min(10).max(600),
    }),
    risk: "write",
    describe: (i) => `Stand-in for an L${i.level} interview`,
    proposes: async (ctx, i) => {
      await loadApplication(ctx.orgId, i.applicationId);
      return {
        title: `Stand-in for an L${i.level} interview`,
        summary: i.reason,
        subject: {
          type: "panel_substitute",
          applicationId: i.applicationId,
          level: i.level,
          replaceMemberId: i.replaceMemberId,
          withMemberId: i.withMemberId,
          reason: i.reason,
        },
      };
    },
    run: async () => {
      throw new Error("A stand-in is decided by a person.");
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
      /** Further interviewers on the panel (active members). */
      panelEmails: z.array(z.string().email()).max(2).optional(),
    }),
    risk: "external",
    templateOf: () => "interview_invite",
    describe: (i) => `Book L${i.level} with ${i.interviewerEmail} at ${i.scheduledAt}`,
    precheck: (ctx, i) => panelRefusal(ctx, i),
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
      const { assertAfterEarlierRounds } = await import("@/lib/calendar-availability.server");
      await assertAfterEarlierRounds(ctx.orgId, i.applicationId, i.level, [when]);

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
          panel: (i.panelEmails ?? []).map((email) => ({ email })),
        },
      );
      return {
        booked: true,
        level: i.level,
        at: when.toISOString(),
        atLocal: localWhen(when, await orgZone(ctx.orgId)),
        meetingLink,
        candidateEmailed: r.candidateEmail,
      };
    },
  });

  registerTool({
    name: "find_interview_slots",
    description:
      "Free interview times for an interviewer and the rest of the panel (times that suit everyone): weekdays 10:00–17:00 in the organisation's time zone, at least 18 hours ahead, spread over different days, avoiding their calendar's busy time (when Google or Microsoft 365 calendar is connected), rounds already booked in ATSIQ and times already offered to another candidate. slotsLocal gives each time in the organisation's time zone — quote those to people, never UTC. Pass the applicationId and level of the round being booked so its times start after the candidate's earlier rounds end. Says whether the calendar was actually checked.",
    input: z.object({
      /** The candidate's application and round: times start after their earlier rounds end. */
      applicationId: z.string().uuid().optional(),
      level: z.number().int().min(1).max(3).optional(),
      interviewerEmail: z.string().email(),
      /** The rest of the panel: times must suit everyone. */
      panelEmails: z.array(z.string().email()).max(2).optional(),
      durationMins: z.number().int().min(15).max(240).default(60),
      count: z.number().int().min(2).max(5).default(3),
    }),
    risk: "read",
    run: async (ctx, i) => {
      const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
      const { findFreeSlots, roundNotBefore } = await import("@/lib/calendar-availability.server");
      const timeZone = (await getOrgEmailSettings(ctx.orgId)).timezone;
      if (i.applicationId) await loadApplication(ctx.orgId, i.applicationId);
      const notBefore =
        i.applicationId && i.level
          ? await roundNotBefore(ctx.orgId, i.applicationId, i.level)
          : null;
      const r = await findFreeSlots(ctx.orgId, {
        notBefore,
        interviewerEmail: i.interviewerEmail,
        panelEmails: i.panelEmails ?? [],
        durationMins: i.durationMins,
        count: i.count,
        timeZone,
      });
      return { ...r, slotsLocal: r.slots.map((x) => localWhen(x, timeZone)), timeZone };
    },
  });

  registerTool({
    name: "offer_interview_slots",
    description:
      "Email the candidate 2–5 interview times (for the interviewer and any further panel members) to choose from, through a private link. Nothing is booked yet: when they pick a time, the round is booked with a meeting link (if a provider is given and connected) and both the candidate and the interviewer get their invites; if none work, the team is told. Every time is re-checked as free. Leaves the organisation, so a person approves it unless the interview time-choice email is pre-approved.",
    input: AppId.extend({
      level: z.number().int().min(1).max(3),
      interviewerEmail: z.string().email(),
      slots: z.array(z.string()).min(2).max(5),
      /** Further interviewers on the panel (active members). */
      panelEmails: z.array(z.string().email()).max(2).optional(),
      durationMins: z.number().int().min(15).max(240).default(60),
      mode: z.enum(["online", "onsite", "phone"]).default("online"),
      meetingProvider: z.enum(["zoom", "google_meet", "teams"]).optional(),
      agenda: z.string().max(2000).optional(),
    }),
    risk: "external",
    templateOf: () => "interview_slots",
    describe: (i) =>
      `Offer ${i.slots.length} L${i.level} interview times with ${i.interviewerEmail}`,
    // Only the round's approved panel; three offers not taken up: a person calls the candidate.
    precheck: async (ctx, i) => {
      const off = await panelRefusal(ctx, i);
      if (off) return off;
      const [r] = (await db.execute(sql`
        select count(*)::int n from interview_slot_offers
        where org_id = ${ctx.orgId} and application_id = ${i.applicationId}
          and level = ${i.level} and status in ('declined','expired')`)) as unknown as {
        n: number;
      }[];
      return (r?.n ?? 0) >= 3
        ? `${r!.n} offers of times for this L${i.level} round were not taken up. Do not offer again: ask_human so a person calls the candidate and books it.`
        : null;
    },
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      const { offerSlotsCore } = await import("@/lib/slot-offers.server");
      const r = await offerSlotsCore(
        ctx.orgId,
        { userId: ctx.principalUserId, runId: ctx.runId },
        {
          applicationId: app.id,
          level: i.level,
          interviewerEmail: i.interviewerEmail,
          slots: i.slots,
          durationMins: i.durationMins,
          mode: i.mode,
          meetingProvider: i.meetingProvider,
          agenda: i.agenda,
          panelEmails: i.panelEmails ?? [],
        },
      );
      const tz = await orgZone(ctx.orgId);
      return {
        offered: r.slots.length,
        slots: r.slots,
        slotsLocal: r.slots.map((x) => localWhen(x, tz)),
        expiresAt: r.expiresAt,
        expiresLocal: r.expiresAt ? localWhen(r.expiresAt, tz) : null,
      };
    },
  });

  registerTool({
    name: "list_pending_scorecards",
    description:
      "Interview rounds that finished at least two hours ago where an interviewer on the panel has not submitted their scorecard (optionally for one requisition) — one row per interviewer to chase.",
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
          panel: interviews.panel,
          scheduledAt: interviews.scheduledAt,
          candidate: candidates.fullName,
          requisitionId: applications.requisitionId,
        })
        .from(interviews)
        .innerJoin(applications, eq(applications.id, interviews.applicationId))
        .innerJoin(candidates, eq(candidates.id, applications.candidateId))
        .where(
          and(
            eq(interviews.orgId, ctx.orgId),
            i.requisitionId ? eq(applications.requisitionId, i.requisitionId) : undefined,
            inArray(interviews.status, ["scheduled", "rescheduled"]),
            lt(
              sql`${interviews.scheduledAt} + make_interval(mins => ${interviews.durationMins})`,
              sql`now() - interval '2 hours'`,
            ),
          ),
        )
        .orderBy(asc(interviews.scheduledAt))
        .limit(50);
      if (!rows.length) return [];
      const cards = await db
        .select({
          interviewId: evaluations.interviewId,
          by: sql<string>`lower(coalesce(${evaluations.evaluatorEmail}, ${evaluations.evaluator}, ''))`,
        })
        .from(evaluations)
        .where(
          and(
            eq(evaluations.orgId, ctx.orgId),
            inArray(
              evaluations.interviewId,
              rows.map((r) => r.interviewId),
            ),
          ),
        );
      const members = await db
        .select({ userId: orgMembers.userId, email: orgMembers.email, name: orgMembers.fullName })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.status, "active")));
      const { emailsOf } = await import("@/lib/interview-plan.server");
      return rows.flatMap((r) => {
        const scored = cards.filter((c) => c.interviewId === r.interviewId).map((c) => c.by);
        return emailsOf(r)
          .filter((e) => !scored.includes(e))
          .map((e) => {
            const m = members.find((x) => x.email.toLowerCase() === e);
            return {
              interviewId: r.interviewId,
              applicationId: r.applicationId,
              level: r.level,
              candidate: r.candidate,
              requisitionId: r.requisitionId,
              scheduledAt: r.scheduledAt,
              interviewer:
                m?.name ?? (e === r.interviewerEmail?.toLowerCase() ? r.interviewer : null),
              interviewerEmail: e,
              interviewerUserId: m?.userId ?? null,
            };
          });
      });
    },
  });

  /* ------------------------------------------------------- evaluation */

  registerTool({
    name: "get_candidate_dossier",
    description:
      "Everything the hiring team knows about one application: match score and gaps, screening-call and assessment results, the role's interview plan and rubric, every round (who interviewed, complete or still waiting for scorecards, the round's verdict, rounds that did not happen), every scorecard (interviewer, ratings per competency, comments, verdict), and whether the final round is complete — a hiring decision to select may only be requested then.",
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
      const { progressOf } = await import("@/lib/interview-plan.server");
      const p = await progressOf(ctx.orgId, app.id);
      return {
        candidateId: app.candidateId,
        candidate: app.candidateName,
        job: app.jobTitle,
        stage: app.stage,
        match: score ?? null,
        screening: screen ?? null,
        assessment: assessment ?? null,
        plan: p.plan,
        finalLevel: p.finalLevel,
        finalComplete: p.finalComplete,
        rounds: rounds.map((r) => {
          const pr = p.rounds.find((x) => x.interviewId === r.interviewId);
          return {
            ...r,
            complete: pr?.complete ?? false,
            waitingFor: pr?.missing ?? [],
            verdict: pr?.verdict ?? null,
          };
        }),
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
