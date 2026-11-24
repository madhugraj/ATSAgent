/**
 * One live scheduling call (docs/voice-scheduling-call-plan.md, step S2): dial
 * the candidate, let the Scheduling call agent talk through the AI gateway,
 * enforce the limits in code, and act on what happened through the same cores
 * as the e-mailed link — a chosen option is booked by `chooseSlotByOffer`,
 * "none of these work" goes down the offer's decline path, "don't call me" is
 * recorded for every AI call. Same line, worker and dispatcher as the
 * screening call (src/server/voice/call-session.server.ts).
 */
import { and, eq } from "drizzle-orm";

import {
  candidates,
  interviewSlotOffers,
  screeningCalls,
  type ScreeningCallStatus,
} from "@db/schema";
import { agentRunScope, withAiSubject } from "../agents/context";
import { db } from "../db";
import { log } from "../log";
import {
  type CallDeps,
  type CallResult,
  closeCallRun,
  openCallRun,
  setCall,
} from "./call-session.server";
import { runShortCall, SHORT_CALL_REPLY_CUE_MS, SHORT_CALL_TURN_TAKING } from "./short-call.server";
import { dialNumber } from "./phone";
import { localNow, nextWindowStart } from "./schedule";
import {
  applySchedulingTool,
  freshSchedulingState,
  schedulingOutcome,
  SCHEDULING_TOOLS,
  type Availability,
  type SchedulingOutcome,
} from "./scheduling-call-tools";
import { loadSchedulingBrief, spokenWhen } from "./scheduling-brief.server";
import {
  bookByPhone,
  callbackTime,
  noteAvailability,
  saveCallback,
  SCHEDULING_MAX_ATTEMPTS,
  SCHEDULING_RETRY_MS,
} from "./scheduling-outcome.server";
import { schedulingSystemPrompt, schedulingFirstWords } from "./scheduling-prompt";
import { phoneScreeningPolicyOf } from "./settings.server";

type Call = typeof screeningCalls.$inferSelect;

/** After the candidate's hello ends, cue the assistant if it has not begun by then. */
export const SCHEDULING_REPLY_CUE_MS = SHORT_CALL_REPLY_CUE_MS;

/** Turn-taking for a scheduling call: end of speech after half a second, high sensitivity. */
export const SCHEDULING_TURN_TAKING = SHORT_CALL_TURN_TAKING;

const WORDS: Record<string, string> = {
  booked: "The candidate picked an interview time on the call; it is booked.",
  callback: "The candidate asked to be called back shortly to pick a time.",
  availability_noted: "None of the times worked; the candidate's availability went to the team.",
  not_now: "Not a good time for the candidate; the times go to them by e-mail with a link.",
  declined:
    "The candidate did not want to pick a time on the call; the times go to them by e-mail with a link.",
  opt_out:
    "The candidate asked not to be called by the AI assistant; the times go to them by e-mail with a link.",
  wrong_person: "The number reached someone else; the times go to them by e-mail with a link.",
  no_answer: "Nobody answered; the times went by e-mail and the call will be tried once more.",
  gave_up: "The candidate could not be reached; the times go to them by e-mail with a link.",
};

/** Place a claimed scheduling call. Never throws for an ordinary failure. */
export async function runSchedulingCall(
  orgId: string,
  call: Call,
  deps: CallDeps,
): Promise<CallResult> {
  const now = deps.now ?? Date.now;
  const runId = await openCallRun(
    orgId,
    call,
    "scheduling_call",
    `Interview scheduling call, attempt ${call.attempt}.`,
  ).catch((e) => {
    log.warn("scheduling_call.run_open_failed", { call_id: call.id, error: e as Error });
    return null;
  });
  if (runId) call.agentRunId = runId;
  const scoped = <T>(fn: () => Promise<T>) =>
    withAiSubject(
      {
        candidateId: call.candidateId,
        applicationId: call.applicationId,
        requisitionId: call.requisitionId,
      },
      () => (runId ? agentRunScope.run({ runId, orgId, agentType: "scheduling_call" }, fn) : fn()),
    );
  try {
    return await scoped(() => place(orgId, call, deps, now));
  } catch (e) {
    log.error("scheduling_call.failed", { org_id: orgId, call_id: call.id, error: e as Error });
    return settle(orgId, call, "no_answer", now(), {
      lastError: (e as Error).message.slice(0, 200),
    });
  }
}

async function place(
  orgId: string,
  call: Call,
  deps: CallDeps,
  now: () => number,
): Promise<CallResult> {
  const brief = await loadSchedulingBrief(orgId, call.id, now());
  // Chosen by link in the meantime, withdrawn, or no time left to offer: no call.
  if (!brief || brief.offer.status !== "offered" || !brief.options.length)
    return settle(orgId, call, "gave_up", now(), {
      endReason: brief?.offer.status === "booked" ? "already_chosen" : "no_times",
    });
  const [cand] = await db
    .select({ phone: candidates.phone, optedOut: candidates.aiCallOptOutAt })
    .from(candidates)
    .where(and(eq(candidates.id, call.candidateId), eq(candidates.orgId, orgId)))
    .limit(1);
  if (cand?.optedOut) return settle(orgId, call, "gave_up", now(), { endReason: "opted_out" });
  const number = dialNumber(cand?.phone);
  if (!number) return settle(orgId, call, "gave_up", now(), { endReason: "no_number" });

  const policy = await phoneScreeningPolicyOf(orgId);
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const system = `Current local time: ${localNow(now(), tz)} (${tz}).\n\n${schedulingSystemPrompt(brief.facts)}`;

  const state = { ...freshSchedulingState(), callbackAllowed: call.reschedules < 1 };
  // The agreed call-back time; saved when the call ends (never while it is live).
  let callBackAt: Date | null = null;
  const run = await runShortCall(
    {
      orgId,
      callId: call.id,
      tag: "scheduling_call",
      feature: "scheduling_call",
      system,
      firstWords: schedulingFirstWords(brief.facts),
      tools: SCHEDULING_TOOLS,
      voice: policy.voice,
      maxMinutes: brief.facts.maxMinutes,
      dial: number,
      recordTools: ["record_availability", "record_permission"],
      endTools: ["end_scheduling_call"],
      keepTranscript: () => state.permission === true,
      onTool: async (c, live) => {
        const out = applySchedulingTool(
          state,
          c.name,
          c.args,
          brief.options,
          live.aiSaid,
          live.heardAfterAsk ?? "",
        );
        live.noteTool(c.name, out.ok);
        if (!out.ok) return out;
        if (c.name === "record_permission") {
          await setCall(call.id, orgId, {
            consentAt: state.permission ? new Date(now()) : null,
            consentWords: state.permissionWords ?? null,
          });
          return out;
        }
        if (c.name === "book_interview_time" && out.book) {
          const r = await bookByPhone(orgId, call, out.book);
          if (!r.ok) return { ok: false, error: `Not booked: ${r.error}` };
          state.booked = { option: (c.args as { option: number }).option, at: out.book };
          // The time actually booked — the assistant reads this back, never its own version.
          return {
            ok: true,
            booked_for: r.booked_for,
            say: `Repeat back exactly this time: ${r.booked_for}.`,
          };
        }
        if (c.name === "call_back_later") {
          const t = await callbackTime(orgId, call, (c.args as { minutes: number }).minutes, now());
          if (!t.ok) return { ok: false, error: t.error };
          state.callback = { minutes: (c.args as { minutes: number }).minutes };
          callBackAt = t.at;
          return {
            ok: true,
            back_at: t.back_at,
            say: `Repeat back exactly this time: ${t.back_at}.`,
          };
        }
        if (c.name === "record_availability") {
          await noteAvailability(orgId, call, c.args as Availability);
          return out;
        }
        if (c.name === "end_scheduling_call") await live.endAfterGoodbye();
        return out;
      },
    },
    deps,
    now,
  );
  if (run.kind === "voice_unavailable")
    return settle(orgId, call, "no_answer", now(), {
      endReason: "voice_unavailable",
      lastError: run.message,
    });
  if (run.kind === "dial_failed")
    return settle(orgId, call, "no_answer", now(), {
      endReason: run.unanswered ? "no_answer" : "dial_failed",
      lastError: run.unanswered ? null : run.reason,
    });
  const why = run.why === "completed" ? (state.endReason ?? "completed") : run.why;
  const result = schedulingOutcome(state);
  return settle(orgId, call, result, run.endedAt, {
    callBackAt,
    endReason: state.endReason ?? (result === "no_answer" ? why : result),
    extra: run.extra,
  });
}

/**
 * Record how the call ended, close its run and tell the role's thread. A
 * booking or "none of these work" already told the thread (the link's core
 * does that); everything else is said here. Unanswered calls are tried once
 * more inside the calling window; the held link is e-mailed after any call
 * that did not book.
 */
async function settle(
  orgId: string,
  call: Call,
  result: SchedulingOutcome | "gave_up",
  at: number,
  o: {
    endReason?: string;
    lastError?: string | null;
    callBackAt?: Date | null;
    extra?: Partial<typeof screeningCalls.$inferInsert>;
  } = {},
): Promise<CallResult> {
  let status: ScreeningCallStatus;
  let dueAt: Date | null = null;
  let words = WORDS[result] ?? `The call ended: ${result}.`;
  if (result === "no_answer") {
    if (call.attempt < SCHEDULING_MAX_ATTEMPTS) {
      const policy = await phoneScreeningPolicyOf(orgId);
      const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
      // Hourly the same day (hiring SLA), not the screening call's 2 h then next day.
      dueAt = nextWindowStart(
        at + SCHEDULING_RETRY_MS,
        policy,
        (await getOrgEmailSettings(orgId)).timezone,
      );
      status = "no_answer";
    } else {
      status = "fell_back";
      words = WORDS["gave_up"]!;
    }
  } else if (result === "callback" && o.callBackAt) {
    status = "callback";
    dueAt = o.callBackAt;
  } else if (result === "wrong_person" || result === "gave_up") {
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
  if (status === "callback" && dueAt) await saveCallback(orgId, call, dueAt);
  if (result === "opt_out") {
    const { recordAiCallOptOut } = await import("./opt-out.server");
    await recordAiCallOptOut({
      orgId,
      candidateId: call.candidateId,
      source: "call",
      actor: "agent:scheduling_call",
      callId: call.id,
    }).catch((e) => log.warn("scheduling_call.opt_out_failed", { call_id: call.id, error: e }));
  }
  // Voice went first and did not book: e-mail the held link now (also after a
  // missed first attempt — the retry still comes, and they have the link meanwhile).
  try {
    const { releaseOfferLinkAfterCall } = await import("@/lib/slot-offers.server");
    await releaseOfferLinkAfterCall(orgId, call.slotOfferId, status);
  } catch (e) {
    log.warn("scheduling_call.link_release_failed", { call_id: call.id, error: e as Error });
  }
  if (call.agentRunId)
    await closeCallRun(call.agentRunId, !o.lastError, words).catch((e) =>
      log.warn("scheduling_call.run_close_failed", { call_id: call.id, error: e as Error }),
    );
  if (status !== "no_answer" && result !== "booked" && result !== "availability_noted")
    await postToThread(orgId, call, result === "gave_up" ? endReason : result, dueAt).catch((e) =>
      log.warn("scheduling_call.thread_post_failed", { call_id: call.id, error: e as Error }),
    );
  return { status, endReason, screeningRunId: null };
}

/** What the role's hiring-desk thread hears when a scheduling call booked nothing. */
async function postToThread(orgId: string, call: Call, how: string, dueAt: Date | null = null) {
  if (!call.applicationId) return;
  const desk = await import("../desk/desk.server");
  const convId = await desk.conversationForSubject(orgId, "application", call.applicationId);
  if (!convId) return;
  const [row] = await db
    .select({ name: candidates.fullName, level: interviewSlotOffers.level })
    .from(screeningCalls)
    .innerJoin(candidates, eq(candidates.id, screeningCalls.candidateId))
    .leftJoin(interviewSlotOffers, eq(interviewSlotOffers.id, screeningCalls.slotOfferId))
    .where(eq(screeningCalls.id, call.id))
    .limit(1);
  const name = row?.name ?? "The candidate";
  const at = dueAt
    ? spokenWhen(
        dueAt.toISOString(),
        (await (await import("@/lib/email-outbox.server")).getOrgEmailSettings(orgId)).timezone,
      )
    : null;
  const round = row?.level ? `L${row.level} interview` : "interview";
  const said: Record<string, string> = {
    not_now: `${name} could not talk when the assistant called about their ${round} time; the times are e-mailed to them with a link.`,
    declined: `${name} preferred not to pick their ${round} time on the call; the times are e-mailed to them with a link.`,
    opt_out: `${name} asked not to be called by the AI assistant. No AI call will dial them again; the times for their ${round} are e-mailed to them with a link.`,
    wrong_person: `The scheduling call for ${name}'s ${round} reached someone else; the times are e-mailed to them with a link.`,
    already_chosen: `${name} picked their ${round} time from the link before the call, so no call was needed.`,
    callback: `${name} asked the assistant to call back${at ? ` at ${at}` : " shortly"} to pick their ${round} time.`,
  };
  await desk.postMessage(
    { id: convId, orgId },
    {
      role: "agent",
      agentType: "scheduling_call",
      body:
        said[how] ??
        `The assistant could not reach ${name} about their ${round} time after ${SCHEDULING_MAX_ATTEMPTS} calls; the times are e-mailed to them with a link. Please phone them today — the hiring SLA leaves no room for a missed day.`,
    },
  );
}

export { spokenWhen };
