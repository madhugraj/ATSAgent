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
  type ScreeningCallTurn,
} from "@db/schema";
import {
  aiVoiceSession,
  type VoiceSession,
  type VoiceSessionEvents,
} from "@/lib/ai-gateway.server";
import { agentRunScope, withAiSubject } from "../agents/context";
import { db } from "../db";
import { log } from "../log";
import {
  type CallDeps,
  type CallResult,
  closeCallRun,
  DEFAULT_LIMITS,
  openCallRun,
  openingWatch,
  rms,
  setCall,
  SPEECH_RMS,
} from "./call-session.server";
import { dialNumber } from "./phone";
import { Resampler } from "./resample";
import { localNow, retryAt } from "./schedule";
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
} from "./scheduling-outcome.server";
import { schedulingSystemPrompt } from "./scheduling-prompt";
import { phoneScreeningPolicyOf } from "./settings.server";

type Call = typeof screeningCalls.$inferSelect;

const WORDS: Record<string, string> = {
  booked: "The candidate picked an interview time on the call; it is booked.",
  callback: "The candidate asked to be called back shortly to pick a time.",
  availability_noted: "None of the times worked; the candidate's availability went to the team.",
  not_now: "Not a good time for the candidate; the e-mailed link stands.",
  declined: "The candidate did not want to pick a time on the call; the e-mailed link stands.",
  opt_out: "The candidate asked not to be called by the AI assistant; the e-mailed link stands.",
  wrong_person: "The number reached someone else; the e-mailed link stands.",
  no_answer: "Nobody answered; the call will be tried again.",
  gave_up: "The candidate could not be reached; the e-mailed link stands.",
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
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
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
  const line = deps.line();
  const up = new Resampler(2, 1); // 8 kHz phone → 16 kHz model
  const down = new Resampler(1, 3); // 24 kHz model → 8 kHz phone
  let lastActivity = now();
  let candidateSpoke = false;
  let aiSpoke = false;
  // What the assistant has said so far: a "yes" counts only after the disclosure.
  let aiSaid = "";
  let agentEnded!: () => void;
  const agentEnd = new Promise<void>((r) => (agentEnded = r));

  const events: VoiceSessionEvents = {
    onAudio: (pcm) => {
      aiSpoke = true;
      lastActivity = now();
      line.play(down.process(pcm));
    },
    onInterrupted: () => line.clear(),
    onTurn: (t) => {
      if (t.who === "ai") aiSaid += ` ${t.text}`;
      lastActivity = now();
      if (t.who === "caller") candidateSpoke = true;
    },
    onToolCall: async (c) => {
      const out = applySchedulingTool(state, c.name, c.args, brief.options, aiSaid);
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
      if (c.name === "end_scheduling_call") {
        // The goodbye is queued; let it play out before hanging up.
        for (let i = 0; i < 100 && line.pendingSeconds() > 0; i++)
          await new Promise((r) => setTimeout(r, 100));
        agentEnded();
      }
      return out;
    },
  };

  const open = deps.voice ?? aiVoiceSession;
  const opened = await open({
    orgId,
    feature: "scheduling_call",
    system,
    tools: SCHEDULING_TOOLS,
    voice: policy.voice,
    turnTaking: { silenceMs: 1000, endOfSpeech: "low", prefixPaddingMs: 300 },
    languageCode: "en-IN",
    events,
  });
  if (!opened.ok)
    return settle(orgId, call, "no_answer", now(), {
      endReason: "voice_unavailable",
      lastError: opened.message,
    });
  const session: VoiceSession = opened.session;
  await setCall(call.id, orgId, { phoneLast4: number.last4 });

  try {
    await line.dial(number.dial, limits.ringMs);
  } catch (e) {
    await session.close();
    line.close();
    const reason = (e as Error).message.slice(0, 120);
    const unanswered = /no answer|busy|486|480|408|487|603|declin/i.test(reason);
    return settle(orgId, call, "no_answer", now(), {
      endReason: unanswered ? "no_answer" : "dial_failed",
      lastError: unanswered ? null : reason,
    });
  }

  const answeredAt = now();
  await setCall(call.id, orgId, { status: "in_progress", startedAt: new Date(answeredAt) });
  let voicedFrames = 0;
  line.onAudio((pcm) => {
    if (rms(pcm) > SPEECH_RMS) {
      lastActivity = now();
      if (++voicedFrames >= 10) candidateSpoke = true;
    }
    session.sendAudio(up.process(pcm));
  });
  lastActivity = now();
  // They speak first; the assistant answers (or greets them if they stay quiet).
  const stopOpening = openingWatch({
    session,
    heard: () => candidateSpoke,
    aiSpoke: () => aiSpoke,
    callerFirstMs: limits.callerFirstMs,
    tag: "scheduling_call",
    callId: call.id,
  });

  let watchdog: ReturnType<typeof setInterval> | null = null;
  const limitHit = new Promise<string>((resolve) => {
    watchdog = setInterval(() => {
      const t = now();
      if (t - answeredAt > brief.facts.maxMinutes * 60_000) resolve("time_limit");
      else if (!candidateSpoke && t - answeredAt > limits.firstWordsMs) resolve("no_response");
      else if (t - lastActivity > limits.silenceMs) resolve("silence");
    }, 250);
  });
  const why = await Promise.race([
    agentEnd.then(() => state.endReason ?? "completed"),
    line.ended.then(() => "candidate_hung_up"),
    session.done.then((s) => (s.error ? "voice_closed" : "voice_ended")),
    limitHit,
  ]);
  if (watchdog) clearInterval(watchdog);
  stopOpening();
  await line.hangup().catch(() => undefined);
  line.close();
  const summary = await session.close();

  const result = schedulingOutcome(state);
  const endedAt = now();
  return settle(orgId, call, result, endedAt, {
    callBackAt,
    endReason: state.endReason ?? (result === "no_answer" ? why : result),
    extra: {
      startedAt: new Date(answeredAt),
      endedAt: new Date(endedAt),
      durationS: Math.round((endedAt - answeredAt) / 1000),
      // The transcript is kept only when they agreed to a note of the call.
      transcript: state.permission === true ? (summary.transcript as ScreeningCallTurn[]) : [],
    },
  });
}

/**
 * Record how the call ended, close its run and tell the role's thread. A
 * booking or "none of these work" already told the thread (the link's core
 * does that); everything else is said here. Unanswered calls are tried once
 * more inside the calling window, then the e-mailed link stands.
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
      dueAt = retryAt(at, call.attempt, policy, (await getOrgEmailSettings(orgId)).timezone);
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
    not_now: `${name} could not talk when the assistant called about their ${round} time; the e-mailed link still stands.`,
    declined: `${name} preferred not to pick their ${round} time on the call; the e-mailed link still stands.`,
    opt_out: `${name} asked not to be called by the AI assistant. No AI call will dial them again; the e-mailed link for their ${round} still stands.`,
    wrong_person: `The scheduling call for ${name}'s ${round} reached someone else; the e-mailed link still stands.`,
    already_chosen: `${name} picked their ${round} time from the e-mail before the call, so no call was needed.`,
    callback: `${name} asked the assistant to call back${at ? ` at ${at}` : " shortly"} to pick their ${round} time.`,
  };
  await desk.postMessage(
    { id: convId, orgId },
    {
      role: "agent",
      agentType: "scheduling_call",
      body:
        said[how] ??
        `The assistant could not reach ${name} to pick their ${round} time; the e-mailed link still stands.`,
    },
  );
}

export { spokenWhen };
