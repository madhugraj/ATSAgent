/**
 * The Screening call agent's in-call tools (docs/voice-screening-agent.md,
 * docs/voice-screening-stage1.1-plan.md): one contract (zod v4, like every
 * agent tool) used three ways — the live call's function declarations, the
 * agent registry (so the agents lock covers them) and the text-mode evals.
 * Pure: no database.
 */
import { z } from "zod/v4";

export const END_REASONS = [
  "completed",
  "booked",
  "declined",
  "prefers_written",
  "prefers_human",
  "not_interested",
  "wrong_person",
  "voicemail",
  "candidate_left",
  "other",
] as const;
export type EndReason = (typeof END_REASONS)[number];

const rupees = z.number().min(0).max(500_000_000);

export const CALL_TOOL_INPUTS = {
  record_consent: z.object({
    granted: z.boolean(),
    /** What the candidate said, as heard — the consent's own evidence. */
    their_words: z.string().trim().min(1).max(300),
  }),
  record_details: z.object({
    current_title: z.string().trim().max(120).optional(),
    current_company: z.string().trim().max(120).optional(),
    total_experience_years: z.number().min(0).max(60).optional(),
    current_location: z.string().trim().max(120).optional(),
    open_to_relocate: z.boolean().optional(),
    notice_period_days: z.number().int().min(0).max(365).optional(),
    earliest_joining: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    // Pay, in rupees per year, only as the candidate stated it — recorded for the
    // HR team only, never discussed and never calculated.
    current_ctc_fixed: rupees.optional(),
    current_ctc_variable: rupees.optional(),
    expected_ctc: rupees.optional(),
    /** Anything about pay not stated as a figure, in their words ("a 30% hike", "plus ₹10L in shares"). */
    pay_note: z.string().trim().max(300).optional(),
    /** Anything else the hiring team should know, in their words ("the core skills are new to me"). */
    candidate_note: z.string().trim().max(300).optional(),
  }),
  record_answer: z.object({
    question_id: z.string().min(1).max(20),
    summary: z.string().trim().min(1).max(600),
  }),
  book_slot: z.object({
    when_local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    their_words: z.string().trim().max(200).optional(),
  }),
  end_call: z.object({ reason: z.enum(END_REASONS) }),
} as const;
export type CallToolName = keyof typeof CALL_TOOL_INPUTS;
export const CALL_TOOL_NAMES = Object.keys(CALL_TOOL_INPUTS) as CallToolName[];

export const CALL_TOOL_DESCRIPTIONS: Record<CallToolName, string> = {
  record_consent:
    "Record whether the candidate agreed to the screening call now (and to notes for the hiring team): granted true only if they clearly agreed; their_words is exactly what they said.",
  record_details:
    "Record the practical details the candidate told you, as they said them: current job title and company, total years of experience, where they live now, whether they are open to relocating, notice period in days, earliest joining date (YYYY-MM-DD), and current fixed pay, current variable pay and expected pay as rupees per year (e.g. 18 lakhs = 1800000) — only figures they actually stated; never calculate one. Anything about pay that is not a figure (a percentage hike, shares, bonuses) goes in pay_note in their words; anything else the hiring team should know (a time limit they set, skills they said are new to them) in candidate_note. Call it again as more details come; leave out anything they did not say. Never comment on the figures.",
  record_answer:
    "After the candidate answers one of the listed screening questions: the question's id and a faithful one or two sentence summary of what the candidate said.",
  book_slot:
    "The candidate cannot talk now and agreed a time for the call: when_local is that time as YYYY-MM-DDTHH:mm in the organisation's local time (see the current local time and the calling hours). A confirmation is e-mailed to them.",
  end_call:
    "Hang up after saying goodbye out loud, with why the call ended: completed, booked (a later time was agreed), declined, prefers_written (they chose the written assessment), prefers_human (they want a person to call), not_interested (in the role), wrong_person, voicemail, candidate_left, other.",
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

export type CallDetailsInput = z.infer<typeof CALL_TOOL_INPUTS.record_details>;

export type CallState = {
  consent: boolean | null;
  consentAt?: number;
  consentWords?: string;
  details: CallDetailsInput | null;
  answers: { question_id: string; summary: string; at: string }[];
  booking: { whenLocal: string } | null;
  endReason: EndReason | null;
  /** How many more times the call may be moved to another time (undefined: no limit known). */
  reschedulesLeft?: number;
};

export const freshCallState = (): CallState => ({
  consent: null,
  details: null,
  answers: [],
  booking: null,
  endReason: null,
});

/**
 * What the assistant must have said out loud before a "yes" counts as
 * consent: that it is an AI, and that it makes notes for the hiring team.
 * Checked against its own spoken lines on a live call (pure; unit-tested).
 */
export function disclosureMissing(aiSaid: string): string | null {
  const missing = [
    /\bAI\b|artificial intelligence/i.test(aiSaid)
      ? null
      : "that you are an AI recruiting assistant",
    /\bnotes?\b|transcri/i.test(aiSaid)
      ? null
      : "that you make notes of the conversation for the hiring team",
  ].filter(Boolean);
  return missing.length ? missing.join(" and ") : null;
}

/**
 * Validate and apply one in-call tool call (pure over the state; unit-tested).
 * Returns what the model is told back — never the figures it recorded.
 * `aiSaid` (the assistant's own spoken lines so far, on a live call) lets the
 * code refuse a "yes" the candidate gave before hearing what they agree to.
 */
export function applyCallTool(
  state: CallState,
  name: string,
  args: unknown,
  questionIds: Set<string>,
  now: number,
  aiSaid?: string,
): Record<string, unknown> {
  if (!(name in CALL_TOOL_INPUTS)) return { ok: false, error: "Unknown tool." };
  const parsed = CALL_TOOL_INPUTS[name as CallToolName].safeParse(args);
  if (!parsed.success) return { ok: false, error: "Those arguments are not valid." };
  const needsConsent = name === "record_answer" || name === "record_details";
  if (needsConsent && state.consent !== true)
    return { ok: false, error: "Ask for and record the candidate's consent first." };
  switch (name as CallToolName) {
    case "record_consent": {
      const { granted, their_words } = parsed.data as { granted: boolean; their_words: string };
      const missing = granted && aiSaid !== undefined ? disclosureMissing(aiSaid) : null;
      if (missing)
        return {
          ok: false,
          error: `Not recorded: first tell them ${missing}, then ask again whether they are happy to continue.`,
        };
      state.consent = granted;
      state.consentWords = their_words;
      if (granted) state.consentAt = now;
      return { ok: true };
    }
    case "record_details": {
      state.details = { ...state.details, ...(parsed.data as CallDetailsInput) };
      return { ok: true, recorded: Object.keys(parsed.data as object) };
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
    case "book_slot": {
      if (state.reschedulesLeft !== undefined && state.reschedulesLeft <= 0)
        return {
          ok: false,
          error:
            "Not booked: this call has already been moved as many times as allowed. Apologise that a time could not be found, and offer the written assessment by e-mail or a call from a person on the team instead.",
        };
      state.booking = { whenLocal: (parsed.data as { when_local: string }).when_local };
      return { ok: true };
    }
    case "end_call": {
      state.endReason = (parsed.data as { reason: EndReason }).reason;
      return { ok: true };
    }
  }
  return { ok: false, error: "Unknown tool." };
}

export type CallOutcome =
  | "completed"
  | "booked"
  | "consent_declined"
  | "prefers_written"
  | "prefers_human"
  | "not_interested"
  | "no_answer"
  | "wrong_person";

/** Where a finished conversation leaves the call (pure; unit-tested). */
export function callOutcome(
  s: Pick<CallState, "consent" | "answers" | "booking" | "endReason">,
): CallOutcome {
  if (s.endReason === "wrong_person") return "wrong_person";
  if (s.booking) return "booked";
  if (s.endReason === "prefers_written") return "prefers_written";
  if (s.endReason === "prefers_human") return "prefers_human";
  if (s.consent === false || s.endReason === "declined") return "consent_declined";
  if (s.endReason === "not_interested") return "not_interested";
  if (s.consent === true && (s.answers.length > 0 || s.endReason === "completed"))
    return "completed";
  // Voicemail, silence, or they hung up before agreeing: try again later.
  return "no_answer";
}
