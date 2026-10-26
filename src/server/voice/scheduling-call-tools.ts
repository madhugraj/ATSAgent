/**
 * The Scheduling call agent's in-call tools (docs/voice-scheduling-call-plan.md):
 * one contract (zod v4) used three ways — the live call's function
 * declarations, the agent registry (so the agents lock covers them) and the
 * text-mode evals. Pure: no database. The assistant books by the number of an
 * option it was given — never a time it makes up.
 */
import { z } from "zod/v4";

import { disclosureMissing } from "./call-tools";

export const SCHEDULING_END_REASONS = [
  "booked",
  "callback",
  "availability_noted",
  "not_now",
  "declined",
  "opt_out",
  "wrong_person",
  "voicemail",
  "candidate_left",
  "other",
] as const;
export type SchedulingEndReason = (typeof SCHEDULING_END_REASONS)[number];

/** At most this many options on one call: the e-mailed times plus up to three alternates. */
export const MAX_OPTIONS = 8;

/** Words that sound like confusion, not a refusal (pure; unit-tested). */
export const UNCLEAR =
  /not (very |so |really |quite )?(sure|clear)|unclear|confus|don'?t understand|didn'?t (get|catch|understand)|pardon|sorry\?|what (is|was|do you|are you)|who is this|which|\?\s*$/i;

/** A call-back the candidate asks for: once per offer, within this many minutes. */
export const CALLBACK_MAX_MINUTES = 180;

export const SCHEDULING_TOOL_INPUTS = {
  record_permission: z.object({
    granted: z.boolean(),
    /** What the candidate said, as heard. */
    their_words: z.string().trim().min(1).max(300),
  }),
  book_interview_time: z.object({
    /** The number of the time in your list of options (1 = the first). */
    option: z.number().int().min(1).max(MAX_OPTIONS),
    their_words: z.string().trim().max(200).optional(),
  }),
  call_back_later: z.object({
    /** How many minutes from now they asked to be called back (e.g. "in 10 minutes" = 10). */
    minutes: z.number().int().min(5).max(CALLBACK_MAX_MINUTES),
    their_words: z.string().trim().min(1).max(200),
  }),
  record_availability: z.object({
    /** When they are free, in their words ("weekday mornings after 10"). */
    their_words: z.string().trim().min(1).max(300),
    days: z
      .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
      .max(7)
      .optional(),
    times_of_day: z
      .array(z.enum(["morning", "afternoon", "evening"]))
      .max(3)
      .optional(),
  }),
  end_scheduling_call: z.object({ reason: z.enum(SCHEDULING_END_REASONS) }),
} as const;
export type SchedulingToolName = keyof typeof SCHEDULING_TOOL_INPUTS;
export const SCHEDULING_TOOL_NAMES = Object.keys(SCHEDULING_TOOL_INPUTS) as SchedulingToolName[];

export const SCHEDULING_TOOL_DESCRIPTIONS: Record<SchedulingToolName, string> = {
  record_permission:
    "Record whether the candidate has a minute now to pick an interview time (and agreed to a note of the time they choose): granted true only if they clearly agreed; their_words is exactly what they said.",
  book_interview_time:
    "Book the interview at one of the times in your list of options: option is that time's number. Only after the candidate clearly chose it. The result says the booked time to read back, or why it could not be booked (then offer another option).",
  call_back_later:
    "The candidate asked to be called back shortly (for example to check their calendar): minutes is how long from now they asked for (5 to 180). Allowed once; the result gives the exact time to read back, or says it is not possible (then point them to the e-mail link).",
  record_availability:
    "None of the options work: record when the candidate is free, in their words (and, if they said, which days and times of day). The team offers matching times by e-mail.",
  end_scheduling_call:
    "Hang up after saying goodbye out loud, with why the call ended: booked, availability_noted, not_now (they will use the e-mail link), declined (they do not want to schedule), opt_out (they asked not to be called by the AI assistant again), wrong_person, voicemail, candidate_left, other.",
};

/** JSON Schema of a tool's arguments, as providers want it (no `$schema`). */
export function schedulingToolParameters(name: SchedulingToolName): Record<string, unknown> {
  const json = z.toJSONSchema(SCHEDULING_TOOL_INPUTS[name]) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

/** The live model's function declarations, generated from the contracts above. */
export const SCHEDULING_TOOLS = SCHEDULING_TOOL_NAMES.map((name) => ({
  name,
  description: SCHEDULING_TOOL_DESCRIPTIONS[name],
  parameters: schedulingToolParameters(name),
}));

export type Availability = z.infer<typeof SCHEDULING_TOOL_INPUTS.record_availability>;

export type SchedulingCallState = {
  permission: boolean | null;
  /** An unclear "no" was already sent back once (then a second one is taken as said). */
  askedAgain?: boolean;
  permissionWords?: string;
  /** The option the candidate chose (1-based), once the booking went through. */
  booked: { option: number; at: string } | null;
  availability: Availability | null;
  /** The call-back they asked for (minutes from now), once accepted by the caller. */
  callback: { minutes: number } | null;
  /** Whether a call-back may still be offered on this offer (once per offer). */
  callbackAllowed?: boolean;
  endReason: SchedulingEndReason | null;
};

export const freshSchedulingState = (): SchedulingCallState => ({
  permission: null,
  booked: null,
  availability: null,
  callback: null,
  endReason: null,
});

/**
 * Validate and apply one in-call tool (pure over the state; unit-tested).
 * `options` are the ISO start times the call may book, in the order the
 * assistant was given them. For book_interview_time it returns `book` — the
 * time to book — and the caller does the booking (the same core as the
 * e-mailed link) and reports back. `aiSaid` (the assistant's own lines so
 * far, on a live call) lets the code refuse a "yes" given before the
 * candidate heard it is an AI.
 */
export function applySchedulingTool(
  state: SchedulingCallState,
  name: string,
  args: unknown,
  options: string[],
  aiSaid?: string,
  /**
   * On a live call: what the candidate said since the assistant last asked a
   * question after its disclosure — the go-ahead must come from there (a real
   * call recorded the answer to "am I speaking with …?" as the go-ahead).
   */
  heardAfterAsk?: string,
): { ok: true; book?: string; [k: string]: unknown } | { ok: false; error: string } {
  if (!(name in SCHEDULING_TOOL_INPUTS)) return { ok: false, error: "Unknown tool." };
  const parsed = SCHEDULING_TOOL_INPUTS[name as SchedulingToolName].safeParse(args);
  if (!parsed.success) return { ok: false, error: "Those arguments are not valid." };
  const needsPermission =
    name === "book_interview_time" || name === "record_availability" || name === "call_back_later";
  if (needsPermission && state.permission !== true)
    return { ok: false, error: "Ask whether they have a minute and record their answer first." };
  switch (name as SchedulingToolName) {
    case "record_permission": {
      const { granted, their_words } = parsed.data as { granted: boolean; their_words: string };
      const missing = granted && aiSaid !== undefined ? disclosureMissing(aiSaid) : null;
      if (missing)
        return {
          ok: false,
          error: `Not recorded: first tell them ${missing}, then ask again whether they have a minute.`,
        };
      if (heardAfterAsk !== undefined && !heardAfterAsk.trim())
        return {
          ok: false,
          error:
            "Not recorded: ask whether they have a minute now and wait for their answer — record what they say to that question.",
        };
      // Only a clear no is a no (real calls: "I'm not sure", "I am not very clear with
      // your ask" were taken as refusals): send an unclear one back once.
      if (!granted && !state.askedAgain && UNCLEAR.test(their_words)) {
        state.askedAgain = true;
        return {
          ok: false,
          error:
            "Not recorded: that is not a clear no. In one plain sentence, say you are calling only to help them pick a time for the interview they were e-mailed about, then ask again whether they have a minute.",
        };
      }
      state.permission = granted;
      // On a live call, the words actually heard in answer — not the model's version.
      state.permissionWords = heardAfterAsk?.trim()
        ? heardAfterAsk.trim().slice(0, 300)
        : their_words;
      return { ok: true };
    }
    case "book_interview_time": {
      if (state.booked) return { ok: false, error: "The interview is already booked." };
      const { option } = parsed.data as { option: number };
      const at = options[option - 1];
      if (!at)
        return {
          ok: false,
          error: `There is no option ${option}. Offer only the times in your list.`,
        };
      return { ok: true, book: at };
    }
    case "call_back_later": {
      if (state.callbackAllowed === false || state.callback)
        return {
          ok: false,
          error:
            "Not possible: a call-back was already arranged for these times. Point them to the link in their e-mail.",
        };
      const { minutes } = parsed.data as { minutes: number };
      return { ok: true, callBackIn: minutes };
    }
    case "record_availability": {
      state.availability = parsed.data as Availability;
      return { ok: true };
    }
    case "end_scheduling_call": {
      state.endReason = (parsed.data as { reason: SchedulingEndReason }).reason;
      return { ok: true };
    }
  }
  return { ok: false, error: "Unknown tool." };
}

export type SchedulingOutcome =
  | "booked"
  | "callback"
  | "availability_noted"
  | "not_now"
  | "declined"
  | "opt_out"
  | "wrong_person"
  | "no_answer";

/** Where a finished scheduling call leaves things (pure; unit-tested). */
export function schedulingOutcome(
  s: Pick<SchedulingCallState, "permission" | "booked" | "availability" | "endReason"> & {
    callback?: SchedulingCallState["callback"];
  },
): SchedulingOutcome {
  if (s.endReason === "opt_out") return "opt_out";
  if (s.endReason === "wrong_person") return "wrong_person";
  if (s.booked) return "booked";
  if (s.callback) return "callback";
  if (s.availability) return "availability_noted";
  if (s.endReason === "declined") return "declined";
  if (s.permission === false || s.endReason === "not_now") return "not_now";
  // Voicemail, silence, or they hung up before choosing: try again (attempts permitting).
  return "no_answer";
}
