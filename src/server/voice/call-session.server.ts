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
import { z } from "zod";

import {
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
  type VoiceToolSpec,
} from "@/lib/ai-gateway.server";
import { agentRunScope, withAiSubject } from "../agents/context";
import { db } from "../db";
import { log } from "../log";
import { callSystemPrompt, loadBriefFacts } from "./call-brief.server";
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

/* ------------------------------------------------------ in-call tools */

export const END_REASONS = [
  "completed",
  "callback",
  "declined",
  "wrong_person",
  "voicemail",
  "candidate_left",
  "other",
] as const;
export type EndReason = (typeof END_REASONS)[number];

export const CALL_TOOL_INPUTS = {
  record_consent: z.object({ granted: z.boolean() }),
  record_answer: z.object({
    question_id: z.string().min(1).max(20),
    summary: z.string().trim().min(1).max(600),
  }),
  record_availability: z.object({
    notice_period_days: z.number().int().min(0).max(365).nullable().optional(),
    earliest_joining: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    current_location: z.string().trim().max(120).nullable().optional(),
    open_to_relocate: z.boolean().nullable().optional(),
  }),
  request_callback: z.object({
    when_local: z.string().max(40).nullable().optional(),
    their_words: z.string().max(200).optional(),
  }),
  end_call: z.object({ reason: z.enum(END_REASONS) }),
} as const;
export type CallToolName = keyof typeof CALL_TOOL_INPUTS;

/** What the live model is told about each tool (JSON Schema arguments). */
export const CALL_TOOLS: VoiceToolSpec[] = [
  {
    name: "record_consent",
    description:
      "Record whether the candidate agreed to the screening call now and to it being transcribed. granted true only if they clearly agreed to both.",
    parameters: {
      type: "object",
      properties: { granted: { type: "boolean" } },
      required: ["granted"],
    },
  },
  {
    name: "record_answer",
    description:
      "After the candidate answers one of the listed questions: the question's id and a faithful one or two sentence summary of what they said.",
    parameters: {
      type: "object",
      properties: { question_id: { type: "string" }, summary: { type: "string" } },
      required: ["question_id", "summary"],
    },
  },
  {
    name: "record_availability",
    description:
      "What the candidate said about their notice period (in days), the earliest date they could join (YYYY-MM-DD), where they live now, and whether they are open to relocating. Leave out anything they did not say. Never pay.",
    parameters: {
      type: "object",
      properties: {
        notice_period_days: { type: "integer" },
        earliest_joining: { type: "string" },
        current_location: { type: "string" },
        open_to_relocate: { type: "boolean" },
      },
    },
  },
  {
    name: "request_callback",
    description:
      "The candidate wants to be called later. when_local: the time they asked for as YYYY-MM-DDTHH:mm in local time (see the current local time); omit if they gave none. their_words: what they said.",
    parameters: {
      type: "object",
      properties: { when_local: { type: "string" }, their_words: { type: "string" } },
    },
  },
  {
    name: "end_call",
    description: "Hang up. Say goodbye out loud first, then call this with why the call ended.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", enum: [...END_REASONS] } },
      required: ["reason"],
    },
  },
];

/* ---------------------------------------------------------------- state */

type CallState = {
  consent: boolean | null;
  consentAt?: number;
  answers: ScreeningCallAnswer[];
  availability: z.infer<typeof CALL_TOOL_INPUTS.record_availability> | null;
  callback: { whenLocal: string | null } | null;
  endReason: EndReason | null;
};

/**
 * Validate and apply one in-call tool call (pure over the state; unit-tested).
 * Returns what the model is told back.
 */
export function applyCallTool(
  state: CallState,
  name: string,
  args: unknown,
  questionIds: Set<string>,
  now: number,
): Record<string, unknown> {
  if (!(name in CALL_TOOL_INPUTS)) return { ok: false, error: "Unknown tool." };
  const parsed = CALL_TOOL_INPUTS[name as CallToolName].safeParse(args);
  if (!parsed.success) return { ok: false, error: "Those arguments are not valid." };
  const needsConsent = name === "record_answer" || name === "record_availability";
  if (needsConsent && state.consent !== true)
    return { ok: false, error: "Ask for and record the candidate's consent first." };
  switch (name as CallToolName) {
    case "record_consent": {
      const { granted } = parsed.data as { granted: boolean };
      state.consent = granted;
      if (granted) state.consentAt = now;
      return { ok: true };
    }
    case "record_answer": {
      const a = parsed.data as { question_id: string; summary: string };
      if (!questionIds.has(a.question_id))
        return { ok: false, error: "That is not one of the listed question ids." };
      state.answers = state.answers.filter((x) => x.question_id !== a.question_id);
      state.answers.push({
        question_id: a.question_id,
        summary: a.summary,
        at: new Date(now).toISOString(),
      });
      return { ok: true, answered: state.answers.length };
    }
    case "record_availability": {
      state.availability = {
        ...state.availability,
        ...(parsed.data as CallState["availability"]),
      };
      return { ok: true };
    }
    case "request_callback": {
      const c = parsed.data as { when_local?: string | null };
      state.callback = { whenLocal: c.when_local ?? null };
      return { ok: true };
    }
    case "end_call": {
      state.endReason = (parsed.data as { reason: EndReason }).reason;
      return { ok: true };
    }
  }
  return { ok: false, error: "Unknown tool." };
}

/** Where a finished conversation leaves the call (pure; unit-tested). */
export function callOutcome(
  s: Pick<CallState, "consent" | "answers" | "callback" | "endReason">,
  hungUpBy: "agent" | "candidate" | "limit",
): "completed" | "callback" | "consent_declined" | "no_answer" | "wrong_person" {
  if (s.endReason === "wrong_person") return "wrong_person";
  if (s.callback) return "callback";
  if (s.consent === false || s.endReason === "declined") return "consent_declined";
  if (s.consent === true && (s.answers.length > 0 || s.endReason === "completed"))
    return "completed";
  // Voicemail, silence, or they hung up before agreeing: try again later.
  void hungUpBy;
  return "no_answer";
}

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
  const runId = call.agentRunId ?? call.requestedRunId;
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

  const state: CallState = {
    consent: null,
    answers: [],
    availability: null,
    callback: null,
    endReason: null,
  };
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

  let hungUpBy: "agent" | "candidate" | "limit" = "limit";
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
    agentEnd.then(() => ((hungUpBy = "agent"), state.endReason ?? "completed")),
    line.ended.then(() => ((hungUpBy = "candidate"), "candidate_hung_up")),
    session.done.then((s) => ((hungUpBy = "limit"), s.error ? "voice_closed" : "voice_ended")),
    limitHit,
  ]);
  if (watchdog) clearInterval(watchdog);
  await line.hangup().catch(() => undefined);
  line.close();
  const summary = await session.close();

  const outcome = callOutcome(state, hungUpBy);
  // The transcript is kept only when the candidate consented.
  const transcript: ScreeningCallTurn[] =
    state.consent === true ? (summary.transcript as ScreeningCallTurn[]) : [];
  const endedAt = now();
  const base = {
    startedAt: new Date(answeredAt),
    endedAt: new Date(endedAt),
    durationS: Math.round((endedAt - answeredAt) / 1000),
    consentAt: state.consent === true ? new Date(state.consentAt ?? answeredAt) : null,
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
