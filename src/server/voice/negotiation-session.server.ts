/**
 * One live negotiation call (docs/negotiator-voice-agent.md, step N2): dial
 * the candidate, let the Negotiation call agent talk through the AI gateway,
 * enforce the limits in code, and bring back what was heard. Same line,
 * worker and dispatcher as the screening and scheduling calls.
 *
 * The call never changes the pay discussion's status, ceiling or figures. A
 * clear yes is written to `offer_negotiations.call_outcome` for TA / the HR
 * head to confirm (`recordNegotiationOutcome` stays the only writer of
 * "agreed"); amounts never reach the thread or the audit entry.
 */
import { and, eq } from "drizzle-orm";

import {
  candidates,
  offerNegotiations,
  screeningCalls,
  type NegotiationCallOutcome,
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
import { disclosureMissing } from "./call-tools";
import { loadNegotiationBrief, type NegotiationBrief } from "./negotiation-brief.server";
import {
  applyNegotiationTool,
  freshNegotiationState,
  NEGOTIATION_TOOLS,
  negotiationOutcome,
  type NegotiationCallOutcomeKind,
  type NegotiationCallState,
} from "./negotiation-call-tools";
import { negotiationSystemPrompt } from "./negotiation-prompt";
import { dialNumber } from "./phone";
import { Resampler } from "./resample";
import { localNow, retryAt } from "./schedule";
import { phoneScreeningPolicyOf } from "./settings.server";

type Call = typeof screeningCalls.$inferSelect;

/** A negotiation call is tried at most twice (the dispatcher holds the same cap). */
export const NEGOTIATION_MAX_ATTEMPTS = 2;

/** Cue the assistant this long after the candidate's hello if it has not begun. */
export const NEGOTIATION_REPLY_CUE_MS = 1_200;

/**
 * After a tool result the assistant should speak on (the offer's words, the next
 * step), cue it if no audio starts within this. A real call went silent after the
 * go-ahead until the candidate hung up.
 */
export const NEGOTIATION_TOOL_SILENCE_CUE_MS = 2_500;

/** Tools after which the assistant must say something (not end the call). */
const SPEAK_AFTER = new Set([
  "record_permission",
  "state_offer",
  "record_their_position",
  "submit_agreed_terms",
  "request_human_call",
]);

/** Turn-taking: people pause before answering about pay — a little more room than scheduling. */
export const NEGOTIATION_TURN_TAKING = {
  silenceMs: 800,
  endOfSpeech: "high" as const,
  prefixPaddingMs: 300,
};

const RUN_WORDS: Record<string, string> = {
  verbal_agreement: "The candidate said yes on the call; the hiring team confirms it.",
  handed_off: "The candidate's position went to the hiring team.",
  declined: "The candidate did not want to discuss pay on the call.",
  not_now: "Not a good time for the candidate.",
  opt_out: "The candidate asked not to be called by the AI assistant.",
  wrong_person: "The number reached someone else.",
  no_answer: "Nobody answered; the call will be tried again.",
  gave_up: "The candidate could not be reached by phone.",
};

/** Place a claimed negotiation call. Never throws for an ordinary failure. */
export async function runNegotiationCall(
  orgId: string,
  call: Call,
  deps: CallDeps,
): Promise<CallResult> {
  const now = deps.now ?? Date.now;
  const runId = await openCallRun(
    orgId,
    call,
    "negotiation_call",
    `Pay discussion call, attempt ${call.attempt}.`,
  ).catch((e) => {
    log.warn("negotiation_call.run_open_failed", { call_id: call.id, error: e as Error });
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
      () => (runId ? agentRunScope.run({ runId, orgId, agentType: "negotiation_call" }, fn) : fn()),
    );
  try {
    return await scoped(() => place(orgId, call, deps, now));
  } catch (e) {
    log.error("negotiation_call.failed", { org_id: orgId, call_id: call.id, error: e as Error });
    return settle(orgId, call, null, null, "no_answer", now(), {
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
  const brief = await loadNegotiationBrief(orgId, call.id);
  // Settled by the link or a person in the meantime: no call.
  if (!brief || !brief.open)
    return settle(orgId, call, brief, null, "gave_up", now(), {
      endReason: brief ? "already_settled" : "no_discussion",
    });
  const [cand] = await db
    .select({ phone: candidates.phone, optedOut: candidates.aiCallOptOutAt })
    .from(candidates)
    .where(and(eq(candidates.id, call.candidateId), eq(candidates.orgId, orgId)))
    .limit(1);
  if (cand?.optedOut)
    return settle(orgId, call, brief, null, "gave_up", now(), { endReason: "opted_out" });
  const number = dialNumber(cand?.phone);
  if (!number)
    return settle(orgId, call, brief, null, "gave_up", now(), { endReason: "no_number" });

  const policy = await phoneScreeningPolicyOf(orgId);
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const system = `Current local time: ${localNow(now(), tz)} (${tz}).\n\n${negotiationSystemPrompt(brief.facts)}`;

  const state = freshNegotiationState();
  const line = deps.line();
  const up = new Resampler(2, 1); // 8 kHz phone → 16 kHz model
  const down = new Resampler(1, 3); // 24 kHz model → 8 kHz phone
  let lastActivity = now();
  let candidateSpoke = false;
  let aiSpoke = false;
  let lastHeardAt: number | null = null;
  // The assistant's own lines: the go-ahead counts only after the disclosure.
  let aiSaid = "";
  // What the candidate said since the assistant's latest question after its
  // disclosure (null until it asked one) — a go-ahead or a yes comes from here.
  let heardAfterAsk: string | null = null;
  let agentEnded!: () => void;
  const agentEnd = new Promise<void>((r) => (agentEnded = r));
  // Real clock: when a tool result that needs a spoken follow-up came back with no audio since.
  let awaitingSpeechSince: number | null = null;
  let cue: (() => void) | null = null;

  const events: VoiceSessionEvents = {
    onAudio: (pcm) => {
      aiSpoke = true;
      awaitingSpeechSince = null;
      lastActivity = now();
      line.play(down.process(pcm));
    },
    onInterrupted: () => line.clear(),
    onTurn: (t) => {
      if (t.who === "ai") {
        awaitingSpeechSince = null;
        aiSaid += ` ${t.text}`;
        if (t.text.includes("?") && !disclosureMissing(aiSaid)) heardAfterAsk = "";
      } else if (heardAfterAsk !== null) heardAfterAsk += ` ${t.text}`;
      lastActivity = now();
      if (t.who === "caller") {
        candidateSpoke = true;
        lastHeardAt = Date.now();
      }
    },
    onToolCall: async (c) => {
      const out = applyNegotiationTool(
        state,
        c.name,
        c.args,
        brief.figures,
        aiSaid,
        heardAfterAsk ?? "",
      );
      // Which tool ran and whether it went through — never its arguments (amounts).
      log.info("negotiation_call.tool", {
        call_id: call.id,
        tool: c.name,
        ok: out.ok,
        ...(out.ok ? {} : { error: out.error }),
      });
      if (
        out.ok &&
        SPEAK_AFTER.has(c.name) &&
        !(c.name === "record_permission" && !state.permission)
      )
        awaitingSpeechSince = Date.now();
      if (!out.ok) return out;
      if (c.name === "record_permission") {
        await setCall(call.id, orgId, {
          consentAt: state.permission ? new Date(now()) : null,
          consentWords: state.permissionWords ?? null,
        });
        return out;
      }
      if (c.name === "state_offer")
        // The words the assistant reads out — its only source of a figure.
        return { ok: true, say: out["say"], note: "Say exactly these words, then listen." };
      if (c.name === "end_negotiation_call") {
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
    feature: "negotiation_call",
    system,
    tools: NEGOTIATION_TOOLS,
    voice: policy.voice,
    turnTaking: NEGOTIATION_TURN_TAKING,
    languageCode: "en-IN",
    events,
  });
  if (!opened.ok)
    return settle(orgId, call, brief, null, "no_answer", now(), {
      endReason: "voice_unavailable",
      lastError: opened.message,
    });
  const session: VoiceSession = opened.session;
  cue = () => {
    log.warn("negotiation_call.cue_after_tool", { call_id: call.id });
    session.sendText(
      "(The candidate is waiting in silence. Continue now, out loud: say what the last tool result gave you to say, or your next step.)",
    );
  };
  await setCall(call.id, orgId, { phoneLast4: number.last4 });

  try {
    await line.dial(number.dial, limits.ringMs);
  } catch (e) {
    await session.close();
    line.close();
    const reason = (e as Error).message.slice(0, 120);
    const unanswered = /no answer|busy|486|480|408|487|603|declin/i.test(reason);
    return settle(orgId, call, brief, null, "no_answer", now(), {
      endReason: unanswered ? "no_answer" : "dial_failed",
      lastError: unanswered ? null : reason,
    });
  }

  const answeredAt = now();
  await setCall(call.id, orgId, { status: "in_progress", startedAt: new Date(answeredAt) });
  let voicedFrames = 0;
  line.onAudio((pcm) => {
    if (rms(pcm) > SPEECH_RMS) {
      lastHeardAt = Date.now();
      lastActivity = now();
      if (++voicedFrames >= 10) candidateSpoke = true;
    }
    session.sendAudio(up.process(pcm));
  });
  lastActivity = now();
  const stopOpening = openingWatch({
    session,
    lastHeard: () => lastHeardAt,
    aiSpoke: () => aiSpoke,
    callerFirstMs: limits.callerFirstMs,
    replyNudgeMs: NEGOTIATION_REPLY_CUE_MS,
    tag: "negotiation_call",
    callId: call.id,
  });

  let watchdog: ReturnType<typeof setInterval> | null = null;
  const limitHit = new Promise<string>((resolve) => {
    watchdog = setInterval(() => {
      const t = now();
      if (t - answeredAt > brief.facts.maxMinutes * 60_000) resolve("time_limit");
      else if (!candidateSpoke && t - answeredAt > limits.firstWordsMs) resolve("no_response");
      else if (t - lastActivity > limits.silenceMs) resolve("silence");
      // Once per tool result: a quiet assistant after a result it should speak on.
      if (
        awaitingSpeechSince !== null &&
        Date.now() - awaitingSpeechSince > NEGOTIATION_TOOL_SILENCE_CUE_MS
      ) {
        awaitingSpeechSince = null;
        cue?.();
      }
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

  const result = negotiationOutcome(state);
  const endedAt = now();
  return settle(orgId, call, brief, state, result, endedAt, {
    endReason: state.endReason ?? (result === "no_answer" ? why : result),
    extra: {
      startedAt: new Date(answeredAt),
      endedAt: new Date(endedAt),
      durationS: Math.round((endedAt - answeredAt) / 1000),
      // Kept only when they agreed to notes of the call.
      transcript: state.permission === true ? (summary.transcript as ScreeningCallTurn[]) : [],
    },
  });
}

/** What the call heard, for the confirm form (pure; unit-tested). */
export function callOutcomeOf(
  callId: string,
  s: NegotiationCallState,
  at: Date,
): NegotiationCallOutcome | null {
  if (s.agreement)
    return {
      callId,
      agreed: true,
      which: s.agreement.which,
      agreedCtc: s.agreement.ctc,
      theirWords: s.agreement.words,
      at: at.toISOString(),
    };
  const words = s.handOff?.words ?? s.positions.at(-1)?.words;
  if (!words) return null;
  return {
    callId,
    agreed: false,
    which: s.lastStated,
    agreedCtc: null,
    theirWords: words.slice(0, 400),
    at: at.toISOString(),
  };
}

/**
 * Record how the call ended, write what was heard to the pay discussion (never
 * its status or figures), close the run, tell the role's thread without
 * amounts. Unanswered calls are tried once more inside the calling window.
 */
async function settle(
  orgId: string,
  call: Call,
  brief: NegotiationBrief | null,
  state: NegotiationCallState | null,
  result: NegotiationCallOutcomeKind | "gave_up",
  at: number,
  o: {
    endReason?: string;
    lastError?: string | null;
    extra?: Partial<typeof screeningCalls.$inferInsert>;
  } = {},
): Promise<CallResult> {
  let status: ScreeningCallStatus;
  let dueAt: Date | null = null;
  let words = RUN_WORDS[result] ?? `The call ended: ${result}.`;
  if (result === "no_answer") {
    if (call.attempt < NEGOTIATION_MAX_ATTEMPTS) {
      const policy = await phoneScreeningPolicyOf(orgId);
      const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
      dueAt = retryAt(at, call.attempt, policy, (await getOrgEmailSettings(orgId)).timezone);
      status = "no_answer";
    } else {
      status = "fell_back";
      words = RUN_WORDS["gave_up"]!;
    }
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
  const heard = brief && state ? callOutcomeOf(call.id, state, new Date(at)) : null;
  if (heard && brief)
    // Only what was heard — the status, ceiling and figures are a person's to change.
    await db
      .update(offerNegotiations)
      .set({ callOutcome: heard, updatedAt: new Date(at) })
      .where(
        and(eq(offerNegotiations.id, brief.negotiationId), eq(offerNegotiations.orgId, orgId)),
      );
  if (result === "opt_out") {
    const { recordAiCallOptOut } = await import("./opt-out.server");
    await recordAiCallOptOut({
      orgId,
      candidateId: call.candidateId,
      source: "call",
      actor: "agent:negotiation_call",
      callId: call.id,
    }).catch((e) => log.warn("negotiation_call.opt_out_failed", { call_id: call.id, error: e }));
  }
  if (brief && status !== "no_answer") {
    const { writeAudit } = await import("../audit");
    await writeAudit({
      actor: "agent:negotiation_call",
      actorUserId: null,
      orgId,
      action: "negotiation.voice_call_ended",
      entityType: "offer_negotiation",
      entityId: brief.negotiationId,
      // No amounts (the pay discussion's convention).
      detail: { callId: call.id, result, endReason, verbalYes: !!heard?.agreed },
    }).catch((e) => log.warn("negotiation_call.audit_failed", { call_id: call.id, error: e }));
  }
  if (call.agentRunId)
    await closeCallRun(call.agentRunId, !o.lastError, words).catch((e) =>
      log.warn("negotiation_call.run_close_failed", { call_id: call.id, error: e as Error }),
    );
  if (status !== "no_answer")
    await postToThread(orgId, call, brief, result === "gave_up" ? endReason : result).catch((e) =>
      log.warn("negotiation_call.thread_post_failed", { call_id: call.id, error: e as Error }),
    );
  return { status, endReason, screeningRunId: null };
}

/** What the role's hiring-desk thread hears — never an amount. */
async function postToThread(
  orgId: string,
  call: Call,
  brief: NegotiationBrief | null,
  how: string,
) {
  if (!call.applicationId) return;
  const desk = await import("../desk/desk.server");
  const convId = await desk.conversationForSubject(orgId, "application", call.applicationId);
  if (!convId) return;
  const name = brief?.candidateName ?? "The candidate";
  const said: Record<string, string> = {
    verbal_agreement: `${name} said yes on the pay call to an approved figure. Nothing is agreed until TA or the HR head confirms it — the pay discussion on their page is ready to confirm in one click.`,
    handed_off: `${name} talked through the offer on the pay call and wants the hiring team to come back to them. Their words are on the pay discussion.`,
    declined: `${name} did not want to discuss pay on the call; the pay discussion stays with the team.`,
    not_now: `${name} could not talk when the assistant called about pay; the pay discussion stays with the team.`,
    opt_out: `${name} asked not to be called by the AI assistant. No AI call will dial them again.`,
    wrong_person: `The pay call for ${name} reached someone else.`,
    already_settled: `The pay discussion with ${name} was settled before the call, so no call was needed.`,
  };
  await desk.postMessage(
    { id: convId, orgId },
    {
      role: "agent",
      agentType: "negotiation_call",
      body:
        said[how] ??
        `The assistant could not reach ${name} about pay; the pay discussion stays with the team.`,
    },
  );
}
