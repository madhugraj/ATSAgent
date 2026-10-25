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
  screeningRuns,
  type ScreeningCallAnswer,
  type ScreeningCallDetails,
  type ScreeningCoverage,
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
import { type BriefFacts, callSystemPrompt, loadBriefFacts } from "./call-brief.server";
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
  /** Wait this long for the candidate's hello before the assistant greets them. */
  callerFirstMs: number;
};

/** No assistant audio this long after a cue → give it once more. */
export const GREETING_NUDGE_MS = 6_000;
/**
 * After the candidate stops talking, the assistant should answer within this
 * (the voice model waits ~1 s of silence, then thinks; nudging sooner talks over it).
 */
export const REPLY_NUDGE_MS = 4_000;

/**
 * The candidate speaks first (they say "hello" when they pick up); the
 * assistant answers them. If they say nothing for `callerFirstMs`, the
 * assistant greets them; if the assistant stays silent after either, it gets
 * one nudge (seen on a real call: the model never answered). Real clock.
 * Returns a stop function.
 */
export function openingWatch(o: {
  session: { sendText(text: string): void };
  /** When the candidate's voice was last heard (ms), or null if never. */
  lastHeard: () => number | null;
  aiSpoke: () => boolean;
  callerFirstMs: number;
  /** After they stop talking, cue the assistant if it has not begun by then. */
  replyNudgeMs?: number;
  tag: string;
  callId: string;
}): () => void {
  const t0 = Date.now();
  let cuedAt: number | null = null;
  let done = false;
  const nudge = (text: string) => {
    done = true;
    log.warn(`${o.tag}.no_greeting`, { call_id: o.callId });
    o.session.sendText(text);
  };
  const timer = setInterval(() => {
    if (done || o.aiSpoke()) {
      clearInterval(timer);
      return;
    }
    const t = Date.now();
    const heard = o.lastHeard();
    if (heard !== null) {
      // Counted from when they stopped talking, not from their first word.
      if (t - heard > (o.replyNudgeMs ?? REPLY_NUDGE_MS))
        nudge("(The person has answered the phone. Reply to them now.)");
      return;
    }
    if (cuedAt === null && t - t0 >= o.callerFirstMs) {
      cuedAt = t;
      o.session.sendText("(The person picked up but has not said anything yet. Greet them now.)");
    } else if (cuedAt !== null && t - cuedAt > GREETING_NUDGE_MS) {
      nudge("(The person is on the line and waiting. Speak now.)");
    }
  }, 100);
  return () => clearInterval(timer);
}

export const DEFAULT_LIMITS: CallLimits = {
  ringMs: 45_000,
  silenceMs: 20_000,
  firstWordsMs: 25_000,
  callerFirstMs: 5_000,
};

export {
  applyCallTool,
  disclosureMissing,
  CALL_TOOL_INPUTS,
  CALL_TOOLS,
  callOutcome,
  END_REASONS,
  freshCallState,
  type CallToolName,
  type EndReason,
} from "./call-tools";

/** Above this RMS (int16) a 20 ms frame is speech, not line noise. */
export const SPEECH_RMS = 600;
export function rms(pcm: Int16Array): number {
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

export async function setCall(
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
  // A call to pick an interview time is the Scheduling call agent's (same line, same worker).
  if (call.purpose === "scheduling") {
    const { runSchedulingCall } = await import("./scheduling-session.server");
    return runSchedulingCall(orgId, call, deps);
  }
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
export async function openCallRun(
  orgId: string,
  call: typeof screeningCalls.$inferSelect,
  agentType: "screening_call" | "scheduling_call" = "screening_call",
  goal = `Phone screening call, attempt ${call.attempt}.`,
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
  const def = getAgent(agentType);
  if (!def) return null;
  const definition = await ensureDefinition(def);
  const now = new Date();
  const [run] = await db
    .insert(agentRuns)
    .values({
      orgId,
      agentType,
      status: "running",
      principalUserId: principal,
      subjectType: "application",
      subjectId: call.applicationId,
      definitionId: definition.id,
      definitionVersion: definition.version,
      definitionHash: definition.hash,
      goal,
      startedAt: now,
      leaseUntil: null,
    })
    .returning({ id: agentRuns.id });
  await setCall(call.id, orgId, { agentRunId: run!.id });
  return run!.id;
}

/** Close the attempt's run with what happened (in plain words). */
export async function closeCallRun(runId: string, ok: boolean, result: string) {
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
  callback: "The candidate agreed a time for the call; a confirmation was e-mailed.",
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
    .select({
      phone: candidates.phone,
      stage: applications.stage,
      optedOut: candidates.aiCallOptOutAt,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.id, call.applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  const number = dialNumber(app?.phone);
  if (!app || !number)
    return finish(orgId, call, { status: "fell_back", endReason: "no_number", now: now() });
  // Last check before dialling: they asked not to be called by the AI assistant.
  if (app.optedOut)
    return finish(orgId, call, { status: "fell_back", endReason: "opted_out", now: now() });

  const policy = await phoneScreeningPolicyOf(orgId);
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const facts = await loadBriefFacts({
    orgId,
    applicationId: call.applicationId,
    kitId: call.kitId,
    policy,
    booked: call.bookedByCandidate,
    reschedulesLeft: Math.max(0, policy.maxReschedules - call.reschedules),
  });
  const questionIds = new Set(facts.questions.map((q) => q.id));
  const system = `Current local time: ${localNow(now(), tz)} (${tz}).\n\n${callSystemPrompt(facts)}`;

  const state: CallState = {
    ...freshCallState(),
    reschedulesLeft: Math.max(0, policy.maxReschedules - call.reschedules),
  };
  const line = deps.line();
  const up = new Resampler(2, 1); // 8 kHz phone → 16 kHz model
  const down = new Resampler(1, 3); // 24 kHz model → 8 kHz phone
  let lastActivity = now();
  let candidateSpoke = false;
  let aiSpoke = false;
  // Real clock (not the injectable one): when the candidate's voice was last heard.
  let lastHeardAt: number | null = null;
  // Transcript lines so far, and how many there were when the practical
  // details were last recorded: grading reads only what came after.
  let turns = 0;
  let detailsUpToTurn = 0;
  let bookedAt: Date | null = null;
  // What the assistant has said so far: consent counts only after the disclosure.
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
      turns++;
      if (t.who === "ai") aiSaid += ` ${t.text}`;
      lastActivity = now();
      if (t.who === "caller") {
        candidateSpoke = true;
        lastHeardAt = Date.now();
      }
    },
    onToolCall: async (c) => {
      const out = applyCallTool(state, c.name, c.args, questionIds, now(), aiSaid);
      if (c.name === "record_details" && out["ok"]) detailsUpToTurn = turns;
      if (c.name === "book_slot" && out["ok"] && state.booking) {
        // The time actually booked (moved into the calling hours if needed) — the
        // assistant reads this back, never its own arithmetic.
        bookedAt = callbackAt(state.booking.whenLocal, now(), policy, tz);
        out["booked_for"] = spokenTime(bookedAt, tz);
        out["say"] = `Repeat back exactly this time: ${out["booked_for"]}.`;
      }
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
    voice: policy.voice,
    // Wait through a thinking pause instead of jumping in.
    turnTaking: { silenceMs: 1000, endOfSpeech: "low", prefixPaddingMs: 300 },
    // Indian English, so short replies ("yes", "okay") are not heard as another language.
    languageCode: "en-IN",
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
      lastHeardAt = Date.now();
      lastActivity = now();
      if (++voicedFrames >= 10) candidateSpoke = true;
    }
    session.sendAudio(up.process(pcm));
  });
  lastActivity = now();
  // They speak first; the assistant answers (or greets them if they stay quiet).
  const stopOpening = openingWatch({
    session,
    lastHeard: () => lastHeardAt,
    aiSpoke: () => aiSpoke,
    callerFirstMs: limits.callerFirstMs,
    tag: "screening_call",
    callId: call.id,
  });

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
  stopOpening();
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
    details: state.consent === true ? publicDetails(state.details) : {},
  };

  // What they said about pay, notice and availability goes to the HR-only record.
  if (state.consent === true && state.details && call.applicationId) {
    const d = state.details;
    const { recordCallDetails } = await import("@/lib/compensation.server");
    await recordCallDetails(orgId, call.applicationId, {
      currentFixed: d.current_ctc_fixed ?? null,
      currentVariable: d.current_ctc_variable ?? null,
      expectedCtc: d.expected_ctc ? d.expected_ctc : null,
      noticePeriodDays: d.notice_period_days ?? null,
      earliestJoining: d.earliest_joining ?? null,
      currentLocation: d.current_location ?? null,
      openToRelocate: d.open_to_relocate ?? null,
      note: d.pay_note ?? null,
    }).catch((e) =>
      log.warn("screening_call.details_failed", { call_id: call.id, error: e as Error }),
    );
  }

  switch (outcome) {
    case "booked": {
      const dueAt = bookedAt ?? callbackAt(state.booking?.whenLocal, endedAt, policy, tz);
      await confirmBooking(orgId, call, facts, policy, dueAt, tz);
      return finish(orgId, call, {
        status: "callback",
        endReason: "booked",
        now: endedAt,
        policy,
        tz,
        dueAt,
        extra: { ...base, bookedByCandidate: true, reschedules: call.reschedules + 1 },
      });
    }
    case "wrong_person":
    case "prefers_written":
    case "prefers_human":
      // No AI call: the Screening agent sends the written assessment, or tells a person.
      return finish(orgId, call, {
        status: "fell_back",
        endReason: outcome,
        now: endedAt,
        extra: base,
      });
    case "consent_declined":
      return finish(orgId, call, {
        status: "consent_declined",
        endReason: why,
        now: endedAt,
        extra: base,
      });
    case "not_interested":
      return finish(orgId, call, {
        status: "completed",
        endReason: "not_interested",
        now: endedAt,
        extra: base,
      });
    case "no_answer":
      return finish(orgId, call, {
        status: "no_answer",
        endReason: why,
        now: endedAt,
        policy,
        tz,
        extra: base,
      });
    case "completed":
      break;
  }

  // Completed: grade the screening questions against the kit — only the part
  // of the call after the practical details, so pay, location and personal
  // details never reach the grader.
  const screeningRunId = await gradeCallAnswers({
    orgId,
    call,
    answers: state.answers,
    transcript: transcript.slice(detailsUpToTurn),
    planned: facts.questions.map((q) => q.id),
  });
  return finish(orgId, call, {
    status: "completed",
    endReason: why,
    now: endedAt,
    extra: { ...base, screeningRunId },
  });
}

/**
 * How much a phone screen's grade rests on (pure; unit-tested): planned, asked
 * and answered. Confidence is answered / planned — high ≥ 75 %, medium ≥ 50 %.
 * Questions not reached or declined are never graded, so they never lower the
 * score; they only mean there is less evidence.
 */
export function callCoverage(
  planned: string[],
  asked: string[],
  answered: number,
): ScreeningCoverage {
  const share = planned.length > 0 ? answered / planned.length : 0;
  return {
    planned: planned.length,
    asked: asked.length,
    answered,
    plannedIds: planned,
    askedIds: asked,
    confidence: share >= 0.75 ? "high" : share >= 0.5 ? "medium" : "low",
  };
}

/**
 * Grade a phone screen fairly: only the screening questions the candidate
 * answered (never one that was not asked, never pay or logistics), with the
 * spoken-answer rubric, and the coverage stored beside the score. Nothing is
 * graded when nothing was answered. Returns the run id, or null.
 */
export async function gradeCallAnswers(input: {
  orgId: string;
  call: typeof screeningCalls.$inferSelect;
  answers: { question_id: string; summary: string; declined?: boolean }[];
  /** The screening part of the call (after the practical details). */
  transcript: ScreeningCallTurn[];
  /** The screening questions the call planned to ask. */
  planned: string[];
}): Promise<string | null> {
  const { orgId, call } = input;
  const plannedSet = new Set(input.planned);
  const asked = input.answers.filter((a) => plannedSet.has(a.question_id));
  const answered = asked.filter((a) => !a.declined);
  if (!answered.length || !call.kitId) return null;
  const [kit] = await db
    .select()
    .from(screeningKits)
    .where(and(eq(screeningKits.id, call.kitId), eq(screeningKits.orgId, orgId)))
    .limit(1);
  if (!kit) return null;
  try {
    const { gradeScreeningForKit } = await import("@/lib/screening.functions");
    const graded = await gradeScreeningForKit({
      orgId,
      kit,
      answers: answered.map((a) => ({ question_id: a.question_id, answer: a.summary })),
      transcript: input.transcript.map(lineFor).join("\n") || null,
      inputKind: "phone_ai",
      createdBy: null,
      onlyQuestionIds: answered.map((a) => a.question_id),
      mode: "spoken",
      coverage: callCoverage(
        input.planned,
        asked.map((a) => a.question_id),
        answered.length,
      ),
    });
    return graded.run.id;
  } catch (e) {
    log.warn("screening_call.grading_failed", { call_id: call.id, error: e as Error });
    return null;
  }
}

/**
 * Tell the role's hiring-desk thread how the call went, in plain words, so the
 * team sees it where they follow the hiring journey.
 */
export async function postCallToThread(
  orgId: string,
  call: typeof screeningCalls.$inferSelect,
  status: ScreeningCallStatus,
  endReason: string,
  screeningRunId: string | null,
  dueAt: Date | null,
) {
  if (!call.applicationId) return;
  const desk = await import("../desk/desk.server");
  const convId = await desk.conversationForSubject(orgId, "application", call.applicationId);
  if (!convId) return;
  const [row] = await db
    .select({ name: candidates.fullName, durationS: screeningCalls.durationS })
    .from(screeningCalls)
    .innerJoin(candidates, eq(candidates.id, screeningCalls.candidateId))
    .where(eq(screeningCalls.id, call.id))
    .limit(1);
  const name = row?.name ?? "The candidate";
  const mins = row?.durationS ? Math.max(1, Math.round(row.durationS / 60)) : null;
  let body: string;
  let card: { type: "screening_result"; runId: string; applicationId: string } | undefined;
  if (status === "callback") {
    const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
    const tz = (await getOrgEmailSettings(orgId)).timezone;
    body = `Called ${name}: now was not a good time, so we agreed to talk on ${dueAt ? spokenTime(dueAt, tz) : "a later time"}. A confirmation was e-mailed to them.`;
  } else if (status === "completed" && endReason !== "not_interested") {
    let graded = "There was not enough to grade.";
    if (screeningRunId) {
      const [r] = await db
        .select({
          score: screeningRuns.screeningScore,
          coverage: screeningRuns.coverage,
          rec: screeningRuns.recommendation,
        })
        .from(screeningRuns)
        .where(and(eq(screeningRuns.id, screeningRunId), eq(screeningRuns.orgId, orgId)))
        .limit(1);
      if (r) {
        const { coverageWords } = await import("@/lib/screening-coverage");
        graded = `Screening score ${r.score}/100${r.coverage ? ` (${coverageWords(r.coverage)}; ${r.coverage.confidence} confidence)` : ""}${r.rec === "hold" ? " — probe further in the interview" : ""}.`;
        card = {
          type: "screening_result",
          runId: screeningRunId,
          applicationId: call.applicationId,
        };
      }
    }
    body = `Had the AI screening call with ${name}${mins ? ` (${mins} min)` : ""}. ${graded} Practical details and pay are recorded for the HR team only. The Screening agent reviews it and asks you to decide who moves on.`;
  } else {
    const how: Record<string, string> = {
      not_interested: `${name} is not interested in the role.`,
      prefers_human: `${name} asked for a person from the team to call them.`,
      prefers_written: `${name} chose the written assessment instead of the call.`,
      wrong_person: `The number on ${name}'s profile reached someone else.`,
      no_number: `${name} has no mobile number we can call.`,
      opted_out: `${name} asked not to be called by the AI assistant.`,
      declined: `${name} preferred not to do the screening call.`,
    };
    body = `AI screening call: ${how[endReason] ?? (status === "consent_declined" ? how["declined"] : `${name} could not be reached after every attempt.`)} The Screening agent takes it from here.`;
  }
  await desk.postMessage(
    { id: convId, orgId },
    { role: "agent", agentType: "screening_call", body, ...(card ? { card } : {}) },
  );
}

/** The details kept on the call row — never pay (that is HR-only, elsewhere). */
function publicDetails(d: CallState["details"]): ScreeningCallDetails {
  if (!d) return {};
  const out: ScreeningCallDetails = {};
  if (d.current_title) out.currentTitle = d.current_title;
  if (d.current_company) out.currentCompany = d.current_company;
  if (d.total_experience_years != null) out.totalExperienceYears = d.total_experience_years;
  if (d.current_location) out.currentLocation = d.current_location;
  if (d.open_to_relocate != null) out.openToRelocate = d.open_to_relocate;
  if (d.notice_period_days != null) out.noticePeriodDays = d.notice_period_days;
  if (d.earliest_joining) out.earliestJoining = d.earliest_joining;
  if (d.candidate_note) out.note = d.candidate_note;
  return out;
}

/** "Saturday 24 October at 16:15" in the organisation's time zone — as the assistant says it. */
function spokenTime(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("weekday")} ${p("day")} ${p("month")} at ${p("hour")}:${p("minute")}`;
}

/** E-mail the candidate the time they agreed, at the address on their CV. */
async function confirmBooking(
  orgId: string,
  call: typeof screeningCalls.$inferSelect,
  facts: BriefFacts,
  policy: Awaited<ReturnType<typeof phoneScreeningPolicyOf>>,
  dueAt: Date,
  tz: string,
) {
  const [c] = await db
    .select({ email: candidates.email, name: candidates.fullName })
    .from(candidates)
    .where(and(eq(candidates.id, call.candidateId), eq(candidates.orgId, orgId)))
    .limit(1);
  if (!c?.email) return;
  const when = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: tz,
  }).format(dueAt);
  const { enqueueEmail } = await import("@/lib/email-outbox.server");
  await enqueueEmail({
    orgId,
    kind: "screening_call_booked",
    templateName: "screening_call_booked",
    toEmail: c.email,
    applicationId: call.applicationId,
    idempotencyKey: `screening_call_booked:${call.id}:${dueAt.toISOString()}`,
    templateData: {
      candidateName: facts.candidateFirstName,
      orgName: facts.orgName,
      jobTitle: facts.roleTitle,
      assistantName: policy.assistantName,
      when,
      minutes: String(policy.maxMinutes),
      contactEmail: facts.contactEmail ?? undefined,
    },
  }).catch((e) =>
    log.warn("screening_call.booking_email_failed", { call_id: call.id, error: e as Error }),
  );
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
  if (settled || (status === "callback" && o.endReason === "booked"))
    await postCallToThread(orgId, call, status, o.endReason, screeningRunId, dueAt).catch((e) =>
      log.warn("screening_call.thread_post_failed", { call_id: call.id, error: e as Error }),
    );
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
