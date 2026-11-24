/**
 * The answer-collecting calls (migration 0092; docs/voice-scheduling-call-plan.md,
 * "Confirmation and reminder calls"):
 *
 * - **Attendance confirmation** (`confirmation`, Confirmation call agent): a
 *   booked round 4–30 hours away whose candidate has not confirmed it is
 *   phoned once inside the calling window. A yes and a no go through the
 *   invite's own confirm link (`answerConfirmation`), so a no reaches the
 *   hiring desk to re-schedule exactly as from the e-mail.
 * - **Panel time check** (`panel_check`, Panel time-check call agent): a
 *   panelist who has not answered a time within the reminder window, with a
 *   mobile in the panel directory, is phoned alongside the reminder e-mail;
 *   which times they can do goes through their confirm link's answer.
 *
 * Every rule is the system's: the organisation's calls and scheduling calls
 * switched on, the agent switched on, a dialable Indian mobile, no opt-out,
 * one call per answer row, at most two attempts. Run by the agent tick.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  applications,
  candidates,
  interviewConfirmations,
  interviews,
  orgMembers,
  organizations,
  panelists,
  requisitions,
  screeningCalls,
  type ScreeningCallStatus,
  userRoles,
} from "@db/schema";
import { agentRunScope, withAiSubject } from "../agents/context";
import { writeAudit } from "../audit";
import { db } from "../db";
import { log } from "../log";
import {
  type CallDeps,
  type CallResult,
  closeCallRun,
  openCallRun,
  setCall,
} from "./call-session.server";
import {
  applyConfirmationTool,
  applyPanelTool,
  CONFIRMATION_TOOLS,
  confirmationOutcome,
  freshConfirmationState,
  freshPanelCheckState,
  MAX_PANEL_TIMES,
  PANEL_TOOLS,
  panelCheckOutcome,
} from "./confirm-call-tools";
import {
  confirmationFirstWords,
  confirmationSystemPrompt,
  type ConfirmationFacts,
  panelFirstWords,
  panelSystemPrompt,
  type PanelCheckFacts,
} from "./confirm-call-prompts";
import { dialNumber } from "./phone";
import { localNow, nextWindowStart } from "./schedule";
import { FORMAT, ROUND, spokenWhen } from "./scheduling-brief.server";
import { phoneScreeningPolicyOf, phoneScreeningReadiness } from "./settings.server";
import { runShortCall } from "./short-call.server";

type Call = typeof screeningCalls.$inferSelect;
type ConfirmationRow = typeof interviewConfirmations.$inferSelect;

const HOUR = 3600_000;

export const CONFIRMATION_CALL = {
  /** Called once the round is this close… */
  withinHours: 30,
  /** …and only while it is at least this far away (time to re-schedule on a no). */
  minLeadHours: 4,
  /** A second try after no answer, this much later. */
  retryMs: HOUR,
} as const;

export const PANEL_CALL = {
  /** A second try after no answer (the panel answer window is two hours). */
  retryMs: 20 * 60_000,
} as const;

/** Both calls are tried at most twice (dispatcher.server.ts). */
export const ANSWER_CALL_MAX_ATTEMPTS = 2;

/* ----------------------------------------------------------- arranging */

/** Organisation-level readiness for an answer call, or why not. */
async function orgReady(
  orgId: string,
  agentType: "confirmation_call" | "panel_check_call",
): Promise<string | null> {
  const policy = await phoneScreeningPolicyOf(orgId);
  if (!policy.schedulingEnabled) return "Scheduling calls are switched off for this organisation.";
  const ready = await phoneScreeningReadiness(orgId);
  if (!ready.enabled) return "Phone calls are switched off for this organisation.";
  if (!ready.phoneLine) return "The voice worker with its phone line is not running right now.";
  if (!ready.voice) return "The organisation has not stored an AI voice key yet.";
  const { loadPolicy } = await import("../agents/policy");
  const p = await loadPolicy(orgId, agentType);
  if (!p.enabled) return "This call agent is switched off for this organisation.";
  return null;
}

/**
 * Who the run acts for: the organisation's HR head, else its owner (the call
 * is arranged by the system, so its AI use is attributed to a person who
 * governs it).
 */
export async function principalOf(orgId: string): Promise<string | null> {
  const [hr] = await db
    .select({ id: userRoles.userId })
    .from(userRoles)
    .where(and(eq(userRoles.orgId, orgId), eq(userRoles.role, "hr_head")))
    .limit(1);
  if (hr) return hr.id;
  const [owner] = await db
    .select({ id: orgMembers.userId })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.isOwner, true),
        sql`${orgMembers.userId} is not null`,
      ),
    )
    .limit(1);
  return owner?.id ?? null;
}

const TERMINAL = ["rejected", "hired", "joined", "withdrawn", "no_show"];

/**
 * Arrange attendance confirmation calls: booked rounds 4–30 hours away whose
 * candidate's confirmation is still pending, with no confirmation call yet.
 * Returns how many were arranged.
 */
export async function requestConfirmationCalls(orgId?: string, now = Date.now()): Promise<number> {
  const rows = await db
    .select({
      row: interviewConfirmations,
      interviewId: interviews.id,
      applicationId: interviews.applicationId,
      scheduledAt: interviews.scheduledAt,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
      stage: applications.stage,
      phone: candidates.phone,
      optedOut: candidates.aiCallOptOutAt,
    })
    .from(interviewConfirmations)
    .innerJoin(
      interviews,
      and(
        eq(interviews.id, interviewConfirmations.interviewId),
        eq(interviews.orgId, interviewConfirmations.orgId),
      ),
    )
    .innerJoin(
      applications,
      and(eq(applications.id, interviews.applicationId), eq(applications.orgId, interviews.orgId)),
    )
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(
      and(
        orgId ? eq(interviewConfirmations.orgId, orgId) : sql`true`,
        eq(interviewConfirmations.party, "candidate"),
        eq(interviewConfirmations.state, "pending"),
        inArray(interviews.status, ["scheduled", "rescheduled"]),
        // The answer is for the round's current time.
        sql`${interviewConfirmations.scheduledAt} = ${interviews.scheduledAt}`,
        sql`${interviews.scheduledAt} > ${new Date(now + CONFIRMATION_CALL.minLeadHours * HOUR).toISOString()}::timestamptz`,
        sql`${interviews.scheduledAt} <= ${new Date(now + CONFIRMATION_CALL.withinHours * HOUR).toISOString()}::timestamptz`,
        sql`not exists (select 1 from screening_calls c where c.confirmation_id = ${interviewConfirmations.id})`,
      ),
    )
    .limit(100);
  let arranged = 0;
  const readyByOrg = new Map<string, string | null>();
  for (const r of rows) {
    try {
      const org = r.row.orgId;
      if (!readyByOrg.has(org)) readyByOrg.set(org, await orgReady(org, "confirmation_call"));
      if (readyByOrg.get(org)) continue;
      if (TERMINAL.includes(r.stage) || r.optedOut || !dialNumber(r.phone)) continue;
      const policy = await phoneScreeningPolicyOf(org);
      const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
      const tz = (await getOrgEmailSettings(org)).timezone;
      const dueAt = nextWindowStart(now, policy, tz);
      // Not in time to be of use (the window opens too close to the round).
      if (dueAt.getTime() > r.scheduledAt!.getTime() - CONFIRMATION_CALL.minLeadHours * HOUR)
        continue;
      const [row] = await db
        .insert(screeningCalls)
        .values({
          orgId: org,
          candidateId: r.candidateId,
          applicationId: r.applicationId,
          requisitionId: r.requisitionId,
          purpose: "confirmation",
          confirmationId: r.row.id,
          requestedBy: await principalOf(org),
          status: "approved",
          dueAt,
        })
        .returning({ id: screeningCalls.id });
      await writeAudit({
        actor: "system:confirmation-call",
        orgId: org,
        action: "confirmation_call.requested",
        entityType: "screening_call",
        entityId: row!.id,
        detail: {
          applicationId: r.applicationId,
          interviewId: r.interviewId,
          scheduledAt: r.scheduledAt!.toISOString(),
          dueAt: dueAt.toISOString(),
        },
      });
      arranged++;
    } catch (e) {
      log.warn("confirmation_call.request_failed", { error: e as Error });
    }
  }
  return arranged;
}

/**
 * Arrange panel time checks: a panelist's answer still pending past the
 * reminder point (the reminder e-mail goes then too), not lapsed, the round
 * or offer still open, a mobile in the panel directory and no opt-out — one
 * call per answer row.
 */
export async function requestPanelCheckCalls(orgId?: string, now = Date.now()): Promise<number> {
  const { PANEL_ANSWER, contextOf } = await import("@/lib/interview-confirmations.server");
  const rows = await db
    .select({ row: interviewConfirmations, panelist: panelists })
    .from(interviewConfirmations)
    .innerJoin(
      panelists,
      and(
        eq(panelists.orgId, interviewConfirmations.orgId),
        sql`lower(${panelists.email}) = lower(${interviewConfirmations.email})`,
      ),
    )
    .where(
      and(
        orgId ? eq(interviewConfirmations.orgId, orgId) : sql`true`,
        eq(interviewConfirmations.party, "panelist"),
        eq(interviewConfirmations.state, "pending"),
        sql`${interviewConfirmations.lapsedAt} is null`,
        sql`${interviewConfirmations.createdAt} <= ${new Date(now - PANEL_ANSWER.remindAfterHours * HOUR).toISOString()}::timestamptz`,
        sql`${interviewConfirmations.createdAt} > ${new Date(now - PANEL_ANSWER.windowHours * HOUR).toISOString()}::timestamptz`,
        sql`${panelists.phone} is not null`,
        sql`${panelists.aiCallOptOutAt} is null`,
        eq(panelists.active, true),
        sql`not exists (select 1 from screening_calls c where c.confirmation_id = ${interviewConfirmations.id})`,
      ),
    )
    .limit(100);
  let arranged = 0;
  const readyByOrg = new Map<string, string | null>();
  for (const { row: r, panelist: p } of rows) {
    try {
      if (!readyByOrg.has(r.orgId))
        readyByOrg.set(r.orgId, await orgReady(r.orgId, "panel_check_call"));
      if (readyByOrg.get(r.orgId)) continue;
      if (!dialNumber(p.phone)) continue;
      const c = await contextOf(r);
      if (!c || c.closed || !c.times.length) continue;
      const [app] = await db
        .select({
          candidateId: applications.candidateId,
          requisitionId: applications.requisitionId,
        })
        .from(applications)
        .where(and(eq(applications.id, c.applicationId), eq(applications.orgId, r.orgId)))
        .limit(1);
      if (!app) continue;
      const policy = await phoneScreeningPolicyOf(r.orgId);
      const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
      const tz = (await getOrgEmailSettings(r.orgId)).timezone;
      const dueAt = nextWindowStart(now, policy, tz);
      const [row] = await db
        .insert(screeningCalls)
        .values({
          orgId: r.orgId,
          candidateId: app.candidateId,
          applicationId: c.applicationId,
          requisitionId: app.requisitionId,
          purpose: "panel_check",
          confirmationId: r.id,
          panelistId: p.id,
          requestedBy: await principalOf(r.orgId),
          status: "approved",
          dueAt,
        })
        .returning({ id: screeningCalls.id });
      await writeAudit({
        actor: "system:panel-check-call",
        orgId: r.orgId,
        action: "panel_check_call.requested",
        entityType: "screening_call",
        entityId: row!.id,
        detail: { applicationId: c.applicationId, panelistId: p.id, dueAt: dueAt.toISOString() },
      });
      arranged++;
    } catch (e) {
      log.warn("panel_check_call.request_failed", { error: e as Error });
    }
  }
  return arranged;
}

/* ----------------------------------------------------------- the briefs */

export type ConfirmationBrief = { facts: ConfirmationFacts; row: ConfirmationRow };

/** What a confirmation call says, or null when there is nothing left to confirm. */
export async function loadConfirmationBrief(
  orgId: string,
  call: Pick<Call, "id" | "confirmationId">,
  now = Date.now(),
): Promise<ConfirmationBrief | null> {
  if (!call.confirmationId) return null;
  const [r] = await db
    .select({
      row: interviewConfirmations,
      level: interviews.level,
      at: interviews.scheduledAt,
      status: interviews.status,
      durationMins: interviews.durationMins,
      mode: interviews.mode,
      link: interviews.teamsLink,
      lead: interviews.interviewerEmail,
      leadName: interviews.interviewer,
      panel: interviews.panel,
      fullName: candidates.fullName,
      roleTitle: requisitions.title,
      orgName: organizations.name,
    })
    .from(interviewConfirmations)
    .innerJoin(interviews, eq(interviews.id, interviewConfirmations.interviewId))
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, interviewConfirmations.orgId))
    .where(
      and(
        eq(interviewConfirmations.id, call.confirmationId),
        eq(interviewConfirmations.orgId, orgId),
        eq(interviews.orgId, orgId),
      ),
    )
    .limit(1);
  if (!r || r.row.state !== "pending" || !r.at) return null;
  if (!["scheduled", "rescheduled"].includes(r.status)) return null;
  if (r.row.scheduledAt?.getTime() !== r.at.getTime() || r.at.getTime() <= now + HOUR) return null;
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const policy = await phoneScreeningPolicyOf(orgId);
  const panelSize = (r.lead || r.leadName ? 1 : 0) + (r.panel?.length ?? 0);
  return {
    row: r.row,
    facts: {
      assistantName: policy.assistantName,
      orgName: r.orgName,
      candidateFirstName: r.fullName.trim().split(/\s+/)[0] ?? r.fullName,
      roleTitle: r.roleTitle,
      roundLabel: `${ROUND[r.level - 1] ?? `round ${r.level}`} interview`,
      when: spokenWhen(r.at.toISOString(), tz),
      durationMins: r.durationMins,
      format: FORMAT[r.mode] ?? r.mode,
      joinHow:
        r.mode === "online"
          ? r.link
            ? "the meeting link in the invite e-mail"
            : "the details in the invite e-mail"
          : r.mode === "onsite"
            ? "the address in the invite e-mail"
            : "the team will phone them at that time",
      panelSize: Math.max(1, panelSize),
      maxMinutes: 3,
    },
  };
}

export type PanelBrief = {
  facts: PanelCheckFacts;
  row: ConfirmationRow;
  /** ISO, index = number − 1. */
  times: string[];
};

/** What a panel time check says, or null when there is nothing left to answer. */
export async function loadPanelBrief(
  orgId: string,
  call: Pick<Call, "id" | "confirmationId" | "panelistId" | "applicationId">,
  now = Date.now(),
): Promise<PanelBrief | null> {
  if (!call.confirmationId || !call.panelistId || !call.applicationId) return null;
  const [r] = await db
    .select()
    .from(interviewConfirmations)
    .where(
      and(
        eq(interviewConfirmations.id, call.confirmationId),
        eq(interviewConfirmations.orgId, orgId),
      ),
    )
    .limit(1);
  if (!r || r.state !== "pending" || r.lapsedAt) return null;
  const { contextOf } = await import("@/lib/interview-confirmations.server");
  const c = await contextOf(r);
  if (!c || c.closed) return null;
  const times = c.times.filter((t) => new Date(t).getTime() > now).slice(0, MAX_PANEL_TIMES);
  if (!times.length) return null;
  const [ctx] = await db
    .select({
      panelist: panelists.fullName,
      candidate: candidates.fullName,
      roleTitle: requisitions.title,
      orgName: organizations.name,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, applications.orgId))
    .innerJoin(panelists, and(eq(panelists.id, call.panelistId), eq(panelists.orgId, orgId)))
    .where(and(eq(applications.id, call.applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!ctx) return null;
  const [mode] = r.interviewId
    ? await db
        .select({ mode: interviews.mode })
        .from(interviews)
        .where(and(eq(interviews.id, r.interviewId), eq(interviews.orgId, orgId)))
        .limit(1)
    : await db.execute<{ mode: string }>(
        sql`select mode from interview_slot_offers where id = ${r.offerId} and org_id = ${orgId}`,
      );
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const policy = await phoneScreeningPolicyOf(orgId);
  const m = (mode as { mode?: string } | undefined)?.mode ?? "online";
  return {
    row: r,
    times,
    facts: {
      assistantName: policy.assistantName,
      orgName: ctx.orgName,
      panelistFirstName: ctx.panelist.trim().split(/\s+/)[0] ?? ctx.panelist,
      candidateName: ctx.candidate,
      roleTitle: ctx.roleTitle,
      roundLabel: `L${c.level} interview`,
      durationMins: c.durationMins,
      format: FORMAT[m] ?? m,
      times: times.map((t) => spokenWhen(t, tz)),
      booked: Boolean(r.interviewId),
      maxMinutes: 3,
    },
  };
}

/* ----------------------------------------------------------- answers */

/** Record the candidate's answer through the invite's own confirm link. */
export async function answerAttendance(
  row: ConfirmationRow,
  attend: boolean,
  words: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { answerConfirmation } = await import("@/lib/interview-confirmations.server");
  const r = await answerConfirmation(row.token, {
    accept: attend,
    note: `On the AI confirmation call: ${words}`.slice(0, 500),
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** Record a panelist's times through their confirm link's answer. */
export async function answerPanelTimes(
  row: ConfirmationRow,
  canDo: string[],
  words: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { answerConfirmation } = await import("@/lib/interview-confirmations.server");
  const r = await answerConfirmation(row.token, {
    accept: canDo.length > 0,
    ...(row.offerId ? { okSlots: canDo } : {}),
    note: `On the AI time-check call: ${words}`.slice(0, 500),
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** A panelist asked not to be phoned by the AI assistant. Audited; cancels their waiting calls. */
export async function recordPanelistOptOut(
  orgId: string,
  panelistId: string,
  callId: string | null,
): Promise<void> {
  const now = new Date();
  await db
    .update(panelists)
    .set({ aiCallOptOutAt: now, updatedAt: now })
    .where(and(eq(panelists.id, panelistId), eq(panelists.orgId, orgId)));
  await db
    .update(screeningCalls)
    .set({
      status: "cancelled",
      lastError: "The panelist asked not to be called by the AI assistant.",
      updatedAt: now,
    })
    .where(
      and(
        eq(screeningCalls.orgId, orgId),
        eq(screeningCalls.panelistId, panelistId),
        inArray(screeningCalls.status, [
          "requested",
          "approved",
          "callback",
          "no_answer",
          "failed",
        ]),
      ),
    );
  await writeAudit({
    actor: "agent:panel_check_call",
    orgId,
    action: "panelist.ai_call_opt_out",
    entityType: "panelist",
    entityId: panelistId,
    detail: { callId },
  });
}

/* ----------------------------------------------------------- live calls */

function scoped<T>(
  orgId: string,
  call: Call,
  runId: string | null,
  agentType: "confirmation_call" | "panel_check_call",
  fn: () => Promise<T>,
): Promise<T> {
  return withAiSubject(
    {
      candidateId: call.candidateId,
      applicationId: call.applicationId,
      requisitionId: call.requisitionId,
    },
    () => (runId ? agentRunScope.run({ runId, orgId, agentType }, fn) : fn()),
  );
}

/** Place a claimed attendance confirmation call. Never throws for an ordinary failure. */
export async function runConfirmationCall(
  orgId: string,
  call: Call,
  deps: CallDeps,
): Promise<CallResult> {
  const now = deps.now ?? Date.now;
  const runId = await openCallRun(
    orgId,
    call,
    "confirmation_call",
    `Interview attendance confirmation call, attempt ${call.attempt}.`,
  ).catch(() => null);
  if (runId) call.agentRunId = runId;
  try {
    return await scoped(orgId, call, runId, "confirmation_call", () =>
      placeConfirmation(orgId, call, deps, now),
    );
  } catch (e) {
    log.error("confirmation_call.failed", { org_id: orgId, call_id: call.id, error: e as Error });
    return settleAnswerCall(orgId, call, "no_answer", now(), {
      lastError: (e as Error).message.slice(0, 200),
    });
  }
}

async function placeConfirmation(
  orgId: string,
  call: Call,
  deps: CallDeps,
  now: () => number,
): Promise<CallResult> {
  const brief = await loadConfirmationBrief(orgId, call, now());
  if (!brief)
    return settleAnswerCall(orgId, call, "gave_up", now(), { endReason: "nothing_to_confirm" });
  const [cand] = await db
    .select({ phone: candidates.phone, optedOut: candidates.aiCallOptOutAt })
    .from(candidates)
    .where(and(eq(candidates.id, call.candidateId), eq(candidates.orgId, orgId)))
    .limit(1);
  if (cand?.optedOut)
    return settleAnswerCall(orgId, call, "gave_up", now(), { endReason: "opted_out" });
  const number = dialNumber(cand?.phone);
  if (!number) return settleAnswerCall(orgId, call, "gave_up", now(), { endReason: "no_number" });
  const policy = await phoneScreeningPolicyOf(orgId);
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const system = `Current local time: ${localNow(now(), tz)} (${tz}).\n\n${confirmationSystemPrompt(brief.facts)}`;
  const state = freshConfirmationState();
  const run = await runShortCall(
    {
      orgId,
      callId: call.id,
      tag: "confirmation_call",
      feature: "confirmation_call",
      system,
      firstWords: confirmationFirstWords(brief.facts),
      tools: CONFIRMATION_TOOLS,
      voice: policy.voice,
      maxMinutes: brief.facts.maxMinutes,
      dial: number,
      recordTools: ["record_attendance_go_ahead", "will_attend", "cannot_attend"],
      endTools: ["end_confirmation_call"],
      keepTranscript: () => state.permission === true,
      onTool: async (c, live) => {
        const out = applyConfirmationTool(
          state,
          c.name,
          c.args,
          live.aiSaid,
          live.heardAfterAsk ?? "",
        );
        live.noteTool(c.name, out.ok);
        if (!out.ok) return out;
        if (c.name === "record_attendance_go_ahead") {
          await setCall(call.id, orgId, {
            consentAt: state.permission ? new Date(now()) : null,
            consentWords: state.permissionWords ?? null,
          });
          return { ok: true };
        }
        if (out.answer) {
          const r = await answerAttendance(brief.row, out.answer.attend, out.answer.words);
          if (!r.ok) {
            state.answer = null;
            return { ok: false, error: `Not recorded: ${r.error}` };
          }
          return out.answer.attend
            ? { ok: true, say: "It is confirmed. Remind them how to join, then say goodbye." }
            : { ok: true, say: "The hiring team will be in touch to find a time. Say goodbye." };
        }
        if (c.name === "end_confirmation_call") await live.endAfterGoodbye();
        return { ok: true };
      },
    },
    deps,
    now,
  );
  if (run.kind === "voice_unavailable")
    return settleAnswerCall(orgId, call, "no_answer", now(), {
      endReason: "voice_unavailable",
      lastError: run.message,
    });
  if (run.kind === "dial_failed")
    return settleAnswerCall(orgId, call, "no_answer", now(), {
      endReason: run.unanswered ? "no_answer" : "dial_failed",
      lastError: run.unanswered ? null : run.reason,
    });
  const result = confirmationOutcome(state);
  const why = run.why === "completed" ? (state.endReason ?? "completed") : run.why;
  return settleAnswerCall(orgId, call, result, run.endedAt, {
    endReason: state.endReason ?? (result === "no_answer" ? why : result),
    extra: run.extra,
  });
}

/** Place a claimed panel time check. Never throws for an ordinary failure. */
export async function runPanelCheckCall(
  orgId: string,
  call: Call,
  deps: CallDeps,
): Promise<CallResult> {
  const now = deps.now ?? Date.now;
  const runId = await openCallRun(
    orgId,
    call,
    "panel_check_call",
    `Panel interview time check call, attempt ${call.attempt}.`,
  ).catch(() => null);
  if (runId) call.agentRunId = runId;
  try {
    return await scoped(orgId, call, runId, "panel_check_call", () =>
      placePanelCheck(orgId, call, deps, now),
    );
  } catch (e) {
    log.error("panel_check_call.failed", { org_id: orgId, call_id: call.id, error: e as Error });
    return settleAnswerCall(orgId, call, "no_answer", now(), {
      lastError: (e as Error).message.slice(0, 200),
    });
  }
}

async function placePanelCheck(
  orgId: string,
  call: Call,
  deps: CallDeps,
  now: () => number,
): Promise<CallResult> {
  const brief = await loadPanelBrief(orgId, call, now());
  if (!brief)
    return settleAnswerCall(orgId, call, "gave_up", now(), { endReason: "nothing_to_answer" });
  const [p] = await db
    .select({ phone: panelists.phone, optedOut: panelists.aiCallOptOutAt })
    .from(panelists)
    .where(and(eq(panelists.id, call.panelistId!), eq(panelists.orgId, orgId)))
    .limit(1);
  if (p?.optedOut)
    return settleAnswerCall(orgId, call, "gave_up", now(), { endReason: "opted_out" });
  const number = dialNumber(p?.phone);
  if (!number) return settleAnswerCall(orgId, call, "gave_up", now(), { endReason: "no_number" });
  const policy = await phoneScreeningPolicyOf(orgId);
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const system = `Current local time: ${localNow(now(), tz)} (${tz}).\n\n${panelSystemPrompt(brief.facts)}`;
  const state = freshPanelCheckState();
  const run = await runShortCall(
    {
      orgId,
      callId: call.id,
      tag: "panel_check_call",
      feature: "panel_check_call",
      system,
      firstWords: panelFirstWords(brief.facts),
      tools: PANEL_TOOLS,
      voice: policy.voice,
      maxMinutes: brief.facts.maxMinutes,
      dial: number,
      recordTools: ["record_panel_go_ahead", "answer_times"],
      endTools: ["end_panel_call"],
      keepTranscript: () => state.permission === true,
      onTool: async (c, live) => {
        const out = applyPanelTool(
          state,
          c.name,
          c.args,
          brief.times,
          live.aiSaid,
          live.heardAfterAsk ?? "",
        );
        live.noteTool(c.name, out.ok);
        if (!out.ok) return out;
        if (c.name === "record_panel_go_ahead") {
          await setCall(call.id, orgId, {
            consentAt: state.permission ? new Date(now()) : null,
            consentWords: state.permissionWords ?? null,
          });
          return { ok: true };
        }
        if (out.answer) {
          const r = await answerPanelTimes(brief.row, out.answer.canDo, out.answer.words);
          if (!r.ok) {
            state.answer = null;
            return { ok: false, error: `Not recorded: ${r.error}` };
          }
          return { ok: true, say: "The hiring team has their answer. Thank them and say goodbye." };
        }
        if (c.name === "end_panel_call") await live.endAfterGoodbye();
        return { ok: true };
      },
    },
    deps,
    now,
  );
  if (run.kind === "voice_unavailable")
    return settleAnswerCall(orgId, call, "no_answer", now(), {
      endReason: "voice_unavailable",
      lastError: run.message,
    });
  if (run.kind === "dial_failed")
    return settleAnswerCall(orgId, call, "no_answer", now(), {
      endReason: run.unanswered ? "no_answer" : "dial_failed",
      lastError: run.unanswered ? null : run.reason,
    });
  const result = panelCheckOutcome(state);
  const why = run.why === "completed" ? (state.endReason ?? "completed") : run.why;
  return settleAnswerCall(orgId, call, result, run.endedAt, {
    endReason: state.endReason ?? (result === "no_answer" ? why : result),
    extra: run.extra,
  });
}

/* ----------------------------------------------------------- settling */

const WORDS: Record<string, string> = {
  confirmed: "The candidate confirmed they will attend the booked interview.",
  cannot_attend:
    "The candidate cannot make the booked time; the hiring team was told to re-schedule.",
  answered: "The panel member answered the interview time on the call.",
  not_now: "Not a good time; the e-mail with the confirm link stands.",
  opt_out: "They asked not to be called by the AI assistant; no AI call dials them again.",
  wrong_person: "The number reached someone else.",
  no_answer: "Nobody answered; the call will be tried once more.",
  gave_up: "The call could not happen; the e-mail with the confirm link stands.",
};

/**
 * Record how an answer call ended, retry once after no answer, honour an
 * opt-out, close its run and — when a candidate could not be reached about
 * tomorrow's round — ask the hiring desk to phone them.
 */
export async function settleAnswerCall(
  orgId: string,
  call: Call,
  result: string,
  at: number,
  o: {
    endReason?: string;
    lastError?: string | null;
    extra?: Partial<typeof screeningCalls.$inferInsert>;
  } = {},
): Promise<CallResult> {
  let status: ScreeningCallStatus;
  let dueAt: Date | null = null;
  let words = WORDS[result] ?? `The call ended: ${result}.`;
  const panel = call.purpose === "panel_check";
  if (result === "no_answer") {
    if (call.attempt < ANSWER_CALL_MAX_ATTEMPTS) {
      const policy = await phoneScreeningPolicyOf(orgId);
      const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
      dueAt = nextWindowStart(
        at + (panel ? PANEL_CALL.retryMs : CONFIRMATION_CALL.retryMs),
        policy,
        (await getOrgEmailSettings(orgId)).timezone,
      );
      status = "no_answer";
    } else {
      status = "fell_back";
      words = WORDS["gave_up"]!;
    }
  } else if (result === "gave_up" || result === "wrong_person") {
    status = "fell_back";
  } else {
    status = "completed";
  }
  const endReason = o.endReason ?? result;
  await setCall(call.id, orgId, {
    ...o.extra,
    status,
    endReason,
    dueAt,
    lastError: o.lastError ?? null,
  });
  if (result === "opt_out") {
    try {
      if (panel && call.panelistId) await recordPanelistOptOut(orgId, call.panelistId, call.id);
      else {
        const { recordAiCallOptOut } = await import("./opt-out.server");
        await recordAiCallOptOut({
          orgId,
          candidateId: call.candidateId,
          source: "call",
          actor: "agent:confirmation_call",
          callId: call.id,
        });
      }
    } catch (e) {
      log.warn("answer_call.opt_out_failed", { call_id: call.id, error: e as Error });
    }
  }
  if (call.agentRunId)
    await closeCallRun(call.agentRunId, !o.lastError, words).catch((e) =>
      log.warn("answer_call.run_close_failed", { call_id: call.id, error: e as Error }),
    );
  // A candidate not reached about a round in the next day: a person phones them.
  if (!panel && status === "fell_back" && endReason !== "nothing_to_confirm")
    await tellDeskUnreached(orgId, call).catch((e) =>
      log.warn("confirmation_call.desk_post_failed", { call_id: call.id, error: e as Error }),
    );
  return { status, endReason, screeningRunId: null };
}

async function tellDeskUnreached(orgId: string, call: Call) {
  if (!call.applicationId || !call.confirmationId) return;
  const [r] = await db
    .select({ name: candidates.fullName, level: interviews.level, at: interviews.scheduledAt })
    .from(interviewConfirmations)
    .innerJoin(interviews, eq(interviews.id, interviewConfirmations.interviewId))
    .innerJoin(candidates, eq(candidates.id, call.candidateId))
    .where(
      and(
        eq(interviewConfirmations.id, call.confirmationId),
        eq(interviewConfirmations.orgId, orgId),
      ),
    )
    .limit(1);
  if (!r?.at) return;
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const desk = await import("../desk/desk.server");
  const convId = await desk.conversationForSubject(orgId, "application", call.applicationId);
  if (!convId) return;
  await desk.postMessage(
    { id: convId, orgId },
    {
      role: "agent",
      agentType: "confirmation_call",
      body: `${r.name} has not confirmed their L${r.level} interview on ${spokenWhen(r.at.toISOString(), tz)}, and the assistant could not reach them after ${ANSWER_CALL_MAX_ATTEMPTS} calls. Please phone them today — a no-show costs the round.`,
    },
  );
}

/** Latest answer call for a confirmation row (Interviews page and tests). */
export async function answerCallFor(orgId: string, confirmationId: string) {
  const [c] = await db
    .select()
    .from(screeningCalls)
    .where(and(eq(screeningCalls.orgId, orgId), eq(screeningCalls.confirmationId, confirmationId)))
    .orderBy(desc(screeningCalls.createdAt))
    .limit(1);
  return c ?? null;
}
