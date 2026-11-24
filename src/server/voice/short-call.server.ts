/**
 * The live part of a short AI call (scheduling, attendance confirmation, a
 * panelist's time check): dial, open the voice session through the AI gateway,
 * play the ready greeting on the callee's hello, run the turn-taking and the
 * limits, and hang up. What the call is *for* — its instructions, tools and
 * what a tool does — comes from the caller's `ShortCallSpec`; everything here
 * was the scheduling call's own plumbing (src/server/voice/scheduling-session.server.ts)
 * and is shared unchanged so every short call keeps the timing real calls tuned.
 */
import type { ScreeningCallTurn } from "@db/schema";
import {
  aiVoiceSession,
  type VoiceSession,
  type VoiceSessionEvents,
} from "@/lib/ai-gateway.server";
import { log } from "../log";
import {
  type CallDeps,
  DEFAULT_LIMITS,
  OPENING_REPLY_CUE_MS,
  openingWatch,
  setCall,
} from "./call-session.server";
import { disclosureMissing } from "./call-tools";
import { CallStatsTracker } from "./call-stats";
import { voiceDebug } from "./debug";
import { GREETING_WAIT_MS, greetingCue, ReadyGreeting } from "./greeting";
import { Resampler } from "./resample";
import { readsOutWorkings, WORKINGS_CORRECTION } from "./spoken-guard";
import { ECHO_TAIL_MS, TurnDetector } from "./turn-detector";
import { TURN_TIMING, TurnKeeper } from "./turns";
import { rms, Vad } from "./vad";

/** Turn-taking for a short call: end of speech after half a second, high sensitivity. */
export const SHORT_CALL_TURN_TAKING = {
  // Our line decides the turns (turn-detector.ts); the rest is kept for the record.
  manual: true,
  silenceMs: 500,
  endOfSpeech: "high" as const,
  prefixPaddingMs: 300,
};

/** After the callee's hello ends, cue the assistant if it has not begun by then. */
export const SHORT_CALL_REPLY_CUE_MS = OPENING_REPLY_CUE_MS;

/** What the call can see of itself when a tool is called. */
export type LiveCall = {
  /** The assistant's own lines so far (a "yes" counts only after its disclosure). */
  aiSaid: string;
  /** What the callee said since the assistant's latest question after its disclosure. */
  heardAfterAsk: string | null;
  /** Tell the turn manager whether the tool went through. */
  noteTool: (name: string, ok: boolean) => void;
  /** Let the queued goodbye play out, then end the call. */
  endAfterGoodbye: () => Promise<void>;
};

export type ShortCallSpec = {
  orgId: string;
  callId: string;
  /** Log prefix and the opening watch's tag, e.g. "scheduling_call". */
  tag: string;
  /** AI_FEATURES slug the gateway attributes the session to. */
  feature: string;
  system: string;
  firstWords: string;
  tools: { name: string; description: string; parameters: Record<string, unknown> }[];
  voice: string | null | undefined;
  maxMinutes: number;
  dial: { dial: string; last4: string };
  recordTools: string[];
  endTools: string[];
  onTool: (c: { name: string; args: unknown }, live: LiveCall) => Promise<Record<string, unknown>>;
  /** The transcript is kept only when this says so at the end (consent). */
  keepTranscript: () => boolean;
};

export type ShortCallRun =
  | { kind: "voice_unavailable"; message: string }
  | { kind: "dial_failed"; unanswered: boolean; reason: string }
  | {
      kind: "answered";
      /** Why the call ended on the line (the agent's own reason is the caller's state). */
      why: string;
      answeredAt: number;
      endedAt: number;
      extra: {
        startedAt: Date;
        endedAt: Date;
        callStats: ReturnType<CallStatsTracker["finish"]>;
        durationS: number;
        transcript: ScreeningCallTurn[];
      };
    };

/** Dial and hold one short call to its end. Never settles the call row's outcome. */
export async function runShortCall(
  spec: ShortCallSpec,
  deps: CallDeps,
  now: () => number,
): Promise<ShortCallRun> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const { orgId, tag } = spec;
  const line = deps.line();
  const up = new Resampler(2, 1); // 8 kHz phone → 16 kHz model
  const down = new Resampler(1, 3); // 24 kHz model → 8 kHz phone
  let lastActivity = now();
  let calleeSpoke = false;
  let aiSpoke = false;
  /** When the line's voice detection last heard them (not the transcript). */
  let lineHeardAt: number | null = null;
  /** When the line last heard them after the greeting finished — their reply to it. */
  let answerHeardAt: number | null = null;
  let aiSaid = "";
  const stats = new CallStatsTracker(now);
  let heardAfterAsk: string | null = null;
  let keeper: TurnKeeper | null = null;
  let agentEnded!: () => void;
  const agentEnd = new Promise<void>((r) => (agentEnded = r));

  // The first words, ready while the phone rings (src/server/voice/greeting.ts).
  const greeting = new ReadyGreeting({
    play: (pcm) => {
      aiSpoke = true;
      lastActivity = now();
      stats.aiAudio();
      keeper?.aiAudio();
      line.play(down.process(pcm));
    },
  });
  let stopWorkings: (() => void) | null = null;
  let workingsStopped = false;
  const live: LiveCall = {
    get aiSaid() {
      return aiSaid;
    },
    get heardAfterAsk() {
      return heardAfterAsk;
    },
    noteTool: (name, ok) => keeper?.tool(name, ok),
    endAfterGoodbye: async () => {
      for (let i = 0; i < 100 && line.pendingSeconds() > 0; i++)
        await new Promise((r) => setTimeout(r, 100));
      agentEnded();
    },
  };
  const events: VoiceSessionEvents = {
    onAudio: (pcm) => greeting.audio(pcm),
    onHeard: () => keeper?.heard(),
    onSaying: (soFar) => {
      if (!workingsStopped && readsOutWorkings(soFar)) {
        workingsStopped = true;
        stopWorkings?.();
      }
    },
    onInterrupted: () => {
      stats.bargeIn();
      line.clear();
    },
    onTurn: (t) => {
      if (t.who === "ai") {
        greeting.turnDone();
        workingsStopped = false;
        aiSaid += ` ${t.text}`;
        keeper?.aiTurn(t.text);
        if (t.text.includes("?") && !disclosureMissing(aiSaid)) heardAfterAsk = "";
      } else if (heardAfterAsk !== null) heardAfterAsk += ` ${t.text}`;
      lastActivity = now();
      if (t.who === "caller") calleeSpoke = true;
    },
    onToolCall: async (c) => spec.onTool(c, live),
  };

  const opened = await (deps.voice ?? aiVoiceSession)({
    orgId,
    feature: spec.feature,
    system: spec.system,
    tools: spec.tools,
    voice: spec.voice,
    turnTaking: SHORT_CALL_TURN_TAKING,
    languageCode: "en-IN",
    events,
  } as Parameters<typeof aiVoiceSession>[0]);
  if (!opened.ok) return { kind: "voice_unavailable", message: opened.message };
  const session: VoiceSession = opened.session;
  stopWorkings = () => {
    line.clear();
    log.error(`${tag}.read_out_workings`, { call_id: spec.callId });
    voiceDebug({ kind: "workings_stopped" });
    session.sendText(WORKINGS_CORRECTION);
  };
  keeper = new TurnKeeper({
    send: (text) => session.sendText(text),
    onCue: (reason) => log.warn(`${tag}.cue`, { call_id: spec.callId, reason }),
    recordTools: new Set(spec.recordTools),
    endTools: new Set(spec.endTools),
    timing: { unheardMs: TURN_TIMING.replyMs },
  });
  await setCall(spec.callId, orgId, { phoneLast4: spec.dial.last4 });
  greeting.asked();
  session.sendText(greetingCue(spec.firstWords));

  try {
    await line.dial(spec.dial.dial, limits.ringMs);
  } catch (e) {
    await session.close();
    line.close();
    const reason = (e as Error).message.slice(0, 120);
    const unanswered = /no answer|busy|486|480|408|487|603|declin/i.test(reason);
    return { kind: "dial_failed", unanswered, reason };
  }

  const answeredAt = now();
  stats.answered();
  await setCall(spec.callId, orgId, {
    status: "in_progress",
    startedAt: new Date(answeredAt),
    brief: spec.system,
  });
  const vad = new Vad();
  let assistantUntil = 0;
  const detector = new TurnDetector({
    start: () => {
      session.activityStart?.();
      keeper?.caller("start", true);
    },
    audio: (p) => session.sendAudio(up.process(p)),
    end: () => {
      session.activityEnd?.();
      keeper?.caller("end", false);
    },
    bargeIn: () => line.clear(),
  });
  line.onAudio((pcm) => {
    const heard = vad.process(pcm);
    if (heard) voiceDebug({ kind: "caller", vad: heard });
    stats.caller(heard);
    if (heard === "start") calleeSpoke = true;
    if (vad.isActive()) {
      lineHeardAt = Date.now();
      lastActivity = now();
    }
    if (heard === "end") greeting.release("hello");
    if (!greeting.isReleased) return;
    if (greeting.played && vad.isActive() && line.pendingSeconds() === 0)
      answerHeardAt = Date.now();
    const playing = line.pendingSeconds() > 0;
    if (playing) assistantUntil = Date.now() + ECHO_TAIL_MS;
    detector.frame(pcm, rms(pcm), playing || Date.now() < assistantUntil);
  });
  lastActivity = now();
  const stopOpening = openingWatch({
    session,
    lastHeard: () => (greeting.played ? answerHeardAt : lineHeardAt),
    aiSpoke: () => (greeting.played ? greeting.repliedSince : aiSpoke),
    callerFirstMs: limits.callerFirstMs,
    replyNudgeMs: () => (greeting.played ? 60_000 : SHORT_CALL_REPLY_CUE_MS),
    wait: () =>
      !greeting.isReleased || greeting.preparing() || (greeting.played && answerHeardAt === null),
    tag,
    callId: spec.callId,
  });

  let watchdog: ReturnType<typeof setInterval> | null = null;
  const limitHit = new Promise<string>((resolve) => {
    watchdog = setInterval(() => {
      const t = now();
      if (
        !greeting.isReleased &&
        t - answeredAt >= (calleeSpoke ? GREETING_WAIT_MS : limits.callerFirstMs)
      )
        greeting.release("silence");
      if (t - answeredAt > spec.maxMinutes * 60_000) resolve("time_limit");
      else if (!calleeSpoke && t - answeredAt > limits.firstWordsMs) resolve("no_response");
      else if (t - lastActivity > limits.silenceMs) resolve("silence");
      keeper?.tick(line.pendingSeconds() > 0);
    }, 250);
  });
  const why = await Promise.race([
    agentEnd.then(() => "completed"),
    line.ended.then(() => "candidate_hung_up"),
    session.done.then((s) => (s.error ? "voice_closed" : "voice_ended")),
    limitHit,
  ]);
  if (watchdog) clearInterval(watchdog);
  keeper.end();
  stopOpening();
  await line.hangup().catch(() => undefined);
  log.info(`${tag}.vad`, { call_id: spec.callId, segments: vad.segments });
  const audio = line.audioStats?.() ?? null;
  line.close();
  const summary = await session.close();
  const endedAt = now();
  return {
    kind: "answered",
    why,
    answeredAt,
    endedAt,
    extra: {
      startedAt: new Date(answeredAt),
      endedAt: new Date(endedAt),
      callStats: stats.finish({ languageCode: "en-IN", audio, cues: keeper.counts }),
      durationS: Math.round((endedAt - answeredAt) / 1000),
      transcript: spec.keepTranscript() ? (summary.transcript as ScreeningCallTurn[]) : [],
    },
  };
}
