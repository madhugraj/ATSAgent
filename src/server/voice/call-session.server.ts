/**
 * One phone screening call (docs/voice-screening-agent.md): dial the
 * candidate, let the Screening call agent talk through the AI gateway, enforce
 * the limits in code, and record what happened — the transcript only once the
 * candidate consented, answers only to the kit's questions, availability never
 * pay — then grade the answers and tell the Screening agent.
 *
 * The phone line and the voice session are injected so a whole call can be
 * tested without a phone (scripts/screening-call.test.ts).
 */
import { and, eq } from "drizzle-orm";

import {
  agentRuns,
  applications,
  candidates,
  screeningCalls,
  screeningKits,
  type ScreeningCallAnswer,
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
import { callSystemPrompt, loadBriefFacts } from "./call-brief.server";
import {
  applyCallTool,
  CALL_TOOLS,
  callOutcome,
  type CallState,
  freshCallState,
} from "./call-tools";
import { dialNumber } from "./phone";
import { Resampler } from "./resample";
import { afterAttempt, callbackAt, localNow } from "./schedule";
import { phoneScreeningPolicyOf } from "./settings.server";

/* ------------------------------------------------------------- the line */

/** A phone line the call runs on (SIP in production, a fake in tests). */
export interface PhoneLine {
  /** Resolves when answered; throws with a short reason ("no answer", "486 Busy Here", …). */
  dial(number: string, ringTimeoutMs: number): Promise<void>;
  /** 8 kHz audio from the candidate. */
  onAudio(cb: (pcm8k: Int16Array) => void): void;
  play(pcm8k: Int16Array): void;
  clear(): void;
  pendingSeconds(): number;
  /** Resolves when the other side hangs up. */
  readonly ended: Promise<void>;
  hangup(): Promise<void>;
  close(): void;
}

export type OpenVoice = typeof aiVoiceSession;

export type CallDeps = {
  line: () => PhoneLine;
  voice?: OpenVoice;
  now?: () => number;
  /** Test hook: shorter limits. */
  limits?: Partial<CallLimits>;
};

export type CallLimits = {
  ringMs: number;
  /** No one speaks for this long → end. */
  silenceMs: number;
  /** The candidate has not said anything this long after answering → voicemail / no one. */
  firstWordsMs: number;
};

const DEFAULT_LIMITS: CallLimits = { ringMs: 45_000, silenceMs: 20_000, firstWordsMs: 25_000 };

export {
  applyCallTool,
  CALL_TOOL_INPUTS,
  CALL_TOOLS,
  callOutcome,
  END_REASONS,
  type CallToolName,
  type EndReason,
} from "./call-tools";

/** Above this RMS (int16) a 20 ms frame is speech, not line noise. */
const SPEECH_RMS = 600;
function rms(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

const lineFor = (t: ScreeningCallTurn) =>
  `${t.who === "ai" ? "Assistant" : "Candidate"}: ${t.text}`;

/* ------------------------------------------------------------- one call */

export type CallResult = {
  status: ScreeningCallStatus;
  endReason: string;
  screeningRunId: string | null;
};

async function setCall(
  id: string,
  orgId: string,
  values: Partial<typeof screeningCalls.$inferInsert>,
) {
  await db
    .update(screeningCalls)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(screeningCalls.id, id), eq(screeningCalls.orgId, orgId)));
}

/**
 * Place the call `callId` (already claimed by the dispatcher: status
 * "dialling", attempt counted). Never throws for an ordinary failure — the
 * call row says what happened.
 */
export async function runScreeningCall(
  orgId: string,
  callId: string,
  deps: CallDeps,
): Promise<CallResult> {
  const now = deps.now ?? Date.now;
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const [call] = await db
    .select()
    .from(screeningCalls)
    .where(and(eq(screeningCalls.id, callId), eq(screeningCalls.orgId, orgId)))
    .limit(1);
  if (!call) throw new Error("Screening call not found");
  // Each attempt is one run of the Screening call agent (its ledger, trace and outcome).
  const runId = await openCallRun(orgId, call).catch((e) => {
    log.warn("screening_call.run_open_failed", { call_id: callId, error: e as Error });
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
      () => (runId ? agentRunScope.run({ runId, orgId, agentType: "screening_call" }, fn) : fn()),
    );
  try {
    return await scoped(() => placeCall(orgId, call, deps, limits, now));
  } catch (e) {
    log.error("screening_call.failed", { org_id: orgId, call_id: callId, error: e as Error });
    return finish(orgId, call, {
      status: "failed",
      endReason: "error",
      lastError: (e as Error).message.slice(0, 200),
      now: now(),
    });
  }
}

/**
 * Open the Screening call agent's run for this attempt: "running" with no
 * lease, so the step-loop runner never claims it and the lease reclaimer
 * leaves it alone; its principal is the person who asked for (or approved)
 * the call. Null when nobody is on record.
 */
async function openCallRun(
  orgId: string,
  call: typeof screeningCalls.$inferSelect,
): Promise<string | null> {
  let principal = call.requestedBy;
  if (!principal && call.requestedRunId) {
    const [r] = await db
      .select({ principal: agentRuns.principalUserId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, call.requestedRunId), eq(agentRuns.orgId, orgId)))
      .limit(1);
    principal = r?.principal ?? null;
  }
  if (!principal) return null;
  await import("../agents");
  const { getAgent } = await import("../agents/registry");
  const { ensureDefinition } = await import("../agents/manifest.server");
  const def = getAgent("screening_call");
  if (!def) return null;
  const definition = await ensureDefinition(def);
  const now = new Date();
  const [run] = await db
    .insert(agentRuns)
    .values({
      orgId,
      agentType: "screening_call",
      status: "running",
      principalUserId: principal,
      subjectType: "application",
      subjectId: call.applicationId,
      definitionId: definition.id,
      definitionVersion: definition.version,
      definitionHash: definition.hash,
      goal: `Phone screening call, attempt ${call.attempt}.`,
      startedAt: now,
      leaseUntil: null,
    })
    .returning({ id: agentRuns.id });
  await setCall(call.id, orgId, { agentRunId: run!.id });
  return run!.id;
}

/** Close the attempt's run with what happened (in plain words). */
async function closeCallRun(runId: string, ok: boolean, result: string) {
  const now = new Date();
  await db
    .update(agentRuns)
    .set({
      status: ok ? "done" : "failed",
      result,
      lastError: ok ? null : result,
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")));
}

const OUTCOME_WORDS: Record<string, string> = {
  completed: "The candidate took the screening call; the answers were sent for grading.",
  consent_declined: "The candidate declined the screening call; nothing was kept.",
  callback: "The candidate asked to be called back later.",
  no_answer: "Nobody answered; the call will be tried again.",
  failed: "The call could not be placed; it will be tried again.",
  fell_back: "The call could not happen; the Screening agent sends the written assessment instead.",
};

async function placeCall(
  orgId: string,
  call: typeof screeningCalls.$inferSelect,
  deps: CallDeps,
  limits: CallLimits,
  now: () => number,
): Promise<CallResult> {
  if (!call.applicationId || !call.kitId)
    return finish(orgId, call, { status: "fell_back", endReason: "no_kit", now: now() });

  const [app] = await db
    .select({ phone: candidates.phone, stage: applications.stage })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.id, call.applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  const number = dialNumber(app?.phone);
  if (!app || !number)
    return finish(orgId, call, { status: "fell_back", endReason: "no_number", now: now() });

  const policy = await phoneScreeningPolicyOf(orgId);
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const facts = await loadBriefFacts({
    orgId,
    applicationId: call.applicationId,
    kitId: call.kitId,
    policy,
  });
  const questionIds = new Set(facts.questions.map((q) => q.id));
  const system = `Current local time: ${localNow(now(), tz)} (${tz}).\n\n${callSystemPrompt(facts)}`;

  const state: CallState = freshCallState();
  const line = deps.line();
  const up = new Resampler(2, 1); // 8 kHz phone → 16 kHz model
  const down = new Resampler(1, 3); // 24 kHz model → 8 kHz phone
  let lastActivity = now();
  let candidateSpoke = false;
  let agentEnded!: () => void;
  const agentEnd = new Promise<void>((r) => (agentEnded = r));

  const events: VoiceSessionEvents = {
    onAudio: (pcm) => {
      lastActivity = now();
      line.play(down.process(pcm));
    },
    onInterrupted: () => line.clear(),
    onTurn: (t) => {
      lastActivity = now();
      if (t.who === "caller") candidateSpoke = true;
    },
    onToolCall: async (c) => {
      const out = applyCallTool(state, c.name, c.args, questionIds, now());
      if (c.name === "end_call" && out["ok"]) {
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
    feature: "screening_call",
    system,
    tools: CALL_TOOLS,
    events,
  });
  if (!opened.ok) {
    return finish(orgId, call, {
      status: "failed",
      endReason: "voice_unavailable",
      lastError: opened.message,
      now: now(),
      policy,
      tz,
    });
  }
  const session: VoiceSession = opened.session;
  await setCall(call.id, orgId, { phoneLast4: number.last4 });

  try {
    await line.dial(number.dial, limits.ringMs);
  } catch (e) {
    await session.close();
    line.close();
    const reason = (e as Error).message.slice(0, 120);
    const unanswered = /no answer|busy|486|480|408|487|603|declin/i.test(reason);
    return finish(orgId, call, {
      status: unanswered ? "no_answer" : "failed",
      endReason: unanswered ? "no_answer" : "dial_failed",
      lastError: unanswered ? null : reason,
      now: now(),
      policy,
      tz,
    });
  }

  const answeredAt = now();
  await setCall(call.id, orgId, { status: "in_progress", startedAt: new Date(answeredAt) });
  let voicedFrames = 0;
  line.onAudio((pcm) => {
    // The candidate talking counts as activity even before a transcript line arrives.
    if (rms(pcm) > SPEECH_RMS) {
      lastActivity = now();
      if (++voicedFrames >= 10) candidateSpoke = true;
    }
    session.sendAudio(up.process(pcm));
  });
  session.sendText("(The person has just picked up the phone. Begin.)");
  lastActivity = now();

  let watchdog: ReturnType<typeof setInterval> | null = null;
  const limitHit = new Promise<string>((resolve) => {
    watchdog = setInterval(() => {
      const t = now();
      if (t - answeredAt > policy.maxMinutes * 60_000) resolve("time_limit");
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
  await line.hangup().catch(() => undefined);
  line.close();
  const summary = await session.close();

  const outcome = callOutcome(state);
  // The transcript is kept only when the candidate consented.
  const transcript: ScreeningCallTurn[] =
    state.consent === true ? (summary.transcript as ScreeningCallTurn[]) : [];
  const endedAt = now();
  const base = {
    startedAt: new Date(answeredAt),
    endedAt: new Date(endedAt),
    durationS: Math.round((endedAt - answeredAt) / 1000),
    consentAt: state.consent === true ? new Date(state.consentAt ?? answeredAt) : null,
    consentWords: state.consentWords ?? null,
    transcript,
    answers: state.consent === true ? state.answers : [],
  };

  if (outcome === "callback")
    return finish(orgId, call, {
      status: "callback",
      endReason: why,
      now: endedAt,
      policy,
      tz,
      dueAt: callbackAt(state.callback?.whenLocal, endedAt, policy, tz),
      extra: base,
    });
  if (outcome === "wrong_person")
    return finish(orgId, call, {
      status: "fell_back",
      endReason: "wrong_person",
      now: endedAt,
      extra: base,
    });
  if (outcome === "consent_declined")
    return finish(orgId, call, {
      status: "consent_declined",
      endReason: why,
      now: endedAt,
      extra: base,
    });
  if (outcome === "no_answer")
    return finish(orgId, call, {
      status: "no_answer",
      endReason: why,
      now: endedAt,
      policy,
      tz,
      extra: base,
    });

  // Completed: availability (never pay), then grade against the kit.
  let screeningRunId: string | null = null;
  if (state.availability && call.applicationId) {
    const a = state.availability;
    const { recordCallAvailability } = await import("@/lib/compensation.server");
    await recordCallAvailability(orgId, call.applicationId, {
      noticePeriodDays: a.notice_period_days ?? null,
      earliestJoining: a.earliest_joining ?? null,
      currentLocation: a.current_location ?? null,
      openToRelocate: a.open_to_relocate ?? null,
    }).catch((e) =>
      log.warn("screening_call.availability_failed", { call_id: call.id, error: e as Error }),
    );
  }
  if (state.answers.length || transcript.length) {
    const [kit] = await db
      .select()
      .from(screeningKits)
      .where(and(eq(screeningKits.id, call.kitId), eq(screeningKits.orgId, orgId)))
      .limit(1);
    if (kit) {
      try {
        const { gradeScreeningForKit } = await import("@/lib/screening.functions");
        const graded = await gradeScreeningForKit({
          orgId,
          kit,
          answers: state.answers.map((a) => ({ question_id: a.question_id, answer: a.summary })),
          transcript: transcript.map(lineFor).join("\n") || null,
          inputKind: "phone_ai",
          createdBy: null,
        });
        screeningRunId = graded.run.id;
      } catch (e) {
        log.warn("screening_call.grading_failed", { call_id: call.id, error: e as Error });
      }
    }
  }
  return finish(orgId, call, {
    status: "completed",
    endReason: why,
    now: endedAt,
    extra: { ...base, screeningRunId },
  });
}

/**
 * Write where the call ended up — retries and the fall-back to the e-mailed
 * assessment included — and tell the Screening agent when it is settled.
 */
async function finish(
  orgId: string,
  call: typeof screeningCalls.$inferSelect,
  o: {
    status: ScreeningCallStatus;
    endReason: string;
    now: number;
    lastError?: string | null;
    policy?: Awaited<ReturnType<typeof phoneScreeningPolicyOf>>;
    tz?: string;
    dueAt?: Date;
    extra?: Partial<typeof screeningCalls.$inferInsert>;
  },
): Promise<CallResult> {
  let status = o.status;
  let dueAt: Date | null = o.dueAt ?? null;
  if ((status === "no_answer" || status === "failed") && o.policy && o.tz) {
    const next = afterAttempt(status, call.attempt, o.policy.maxAttempts, o.now, o.policy, o.tz);
    // Keep the outcome visible while waiting: the dispatcher picks up both.
    dueAt = next.dueAt;
    if (next.status === "fell_back") status = "fell_back";
  } else if (status === "failed") {
    status = "fell_back";
  }
  const screeningRunId = (o.extra?.screeningRunId as string | null | undefined) ?? null;
  await setCall(call.id, orgId, {
    ...o.extra,
    status,
    endReason: o.endReason,
    dueAt,
    callbackAt: status === "callback" ? dueAt : null,
    lastError: o.lastError ?? null,
  });
  if (call.agentRunId)
    await closeCallRun(
      call.agentRunId,
      o.endReason !== "error",
      OUTCOME_WORDS[status] ?? `The call ended: ${status}.`,
    ).catch((e) =>
      log.warn("screening_call.run_close_failed", { call_id: call.id, error: e as Error }),
    );
  const settled = status === "completed" || status === "consent_declined" || status === "fell_back";
  if (settled && call.applicationId) {
    const { emitAgentEvent } = await import("../agents/events");
    await emitAgentEvent({
      orgId,
      type: "screening_call.ended",
      subjectType: "application",
      subjectId: call.applicationId,
      actorUserId: null,
      payload: { callId: call.id, status, endReason: o.endReason, screeningRunId },
    });
  }
  return { status, endReason: o.endReason, screeningRunId };
}
