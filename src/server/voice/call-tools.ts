/**
 * The Screening call agent's in-call tools (docs/voice-screening-agent.md):
 * one contract (zod v4, like every agent tool) used three ways — the live
 * call's function declarations, the agent registry (so the agents lock covers
 * them) and the text-mode evals. Pure: no database.
 */
import { z } from "zod/v4";

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
  record_consent: z.object({
    granted: z.boolean(),
    /** What the candidate said, as heard — the consent's own evidence. */
    their_words: z.string().trim().min(1).max(300),
  }),
  record_answer: z.object({
    question_id: z.string().min(1).max(20),
    summary: z.string().trim().min(1).max(600),
  }),
  // No pay field exists here, so pay can never be recorded through the call.
  record_availability: z.object({
    notice_period_days: z.number().int().min(0).max(365).optional(),
    earliest_joining: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    current_location: z.string().trim().max(120).optional(),
    open_to_relocate: z.boolean().optional(),
  }),
  request_callback: z.object({
    when_local: z.string().max(40).optional(),
    their_words: z.string().max(200).optional(),
  }),
  end_call: z.object({ reason: z.enum(END_REASONS) }),
} as const;
export type CallToolName = keyof typeof CALL_TOOL_INPUTS;
export const CALL_TOOL_NAMES = Object.keys(CALL_TOOL_INPUTS) as CallToolName[];

export const CALL_TOOL_DESCRIPTIONS: Record<CallToolName, string> = {
  record_consent:
    "Record whether the candidate agreed to the screening call now and to it being transcribed: granted true only if they clearly agreed to both; their_words is exactly what they said.",
  record_answer:
    "After the candidate answers one of the listed questions: the question's id and a faithful one or two sentence summary of what they said.",
  record_availability:
    "What the candidate said about their notice period (in days), the earliest date they could join (YYYY-MM-DD), where they live now, and whether they are open to relocating. Leave out anything they did not say. Never pay.",
  request_callback:
    "The candidate wants to be called later. when_local: the time they asked for as YYYY-MM-DDTHH:mm in local time (see the current local time); omit if they gave none. their_words: what they said.",
  end_call: "Hang up. Say goodbye out loud first, then call this with why the call ended.",
};

/** JSON Schema of a tool's arguments, as providers want it (no `$schema`). */
export function callToolParameters(name: CallToolName): Record<string, unknown> {
  const json = z.toJSONSchema(CALL_TOOL_INPUTS[name]) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

/** The live model's function declarations, generated from the contracts above. */
export const CALL_TOOLS = CALL_TOOL_NAMES.map((name) => ({
  name,
  description: CALL_TOOL_DESCRIPTIONS[name],
  parameters: callToolParameters(name),
}));

export type CallAvailabilityInput = z.infer<typeof CALL_TOOL_INPUTS.record_availability>;

export type CallState = {
  consent: boolean | null;
  consentAt?: number;
  consentWords?: string;
  answers: { question_id: string; summary: string; at: string }[];
  availability: CallAvailabilityInput | null;
  callback: { whenLocal: string | null } | null;
  endReason: EndReason | null;
};

export const freshCallState = (): CallState => ({
  consent: null,
  answers: [],
  availability: null,
  callback: null,
  endReason: null,
});

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
      const { granted, their_words } = parsed.data as { granted: boolean; their_words: string };
      state.consent = granted;
      state.consentWords = their_words;
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
      state.availability = { ...state.availability, ...(parsed.data as CallAvailabilityInput) };
      return { ok: true };
    }
    case "request_callback": {
      const c = parsed.data as { when_local?: string };
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
): "completed" | "callback" | "consent_declined" | "no_answer" | "wrong_person" {
  if (s.endReason === "wrong_person") return "wrong_person";
  if (s.callback) return "callback";
  if (s.consent === false || s.endReason === "declined") return "consent_declined";
  if (s.consent === true && (s.answers.length > 0 || s.endReason === "completed"))
    return "completed";
  // Voicemail, silence, or they hung up before agreeing: try again later.
  return "no_answer";
}
