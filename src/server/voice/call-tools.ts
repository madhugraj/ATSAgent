/**
 * The Screening call agent's in-call tools (docs/voice-screening-agent.md,
 * docs/voice-screening-stage1.1-plan.md): one contract (zod v4, like every
 * agent tool) used three ways — the live call's function declarations, the
 * agent registry (so the agents lock covers them) and the text-mode evals.
 * Pure: no database.
 */
import { z } from "zod";

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

/**
 * The details every completed screening call must leave with: recorded, or
 * noted as not given (they would rather not say; current pay only — they are
 * not working now). Checked in code when the call ends.
 */
export const MANDATORY_DETAILS = ["joining_date", "current_pay", "expected_pay"] as const;
export type MandatoryDetail = (typeof MANDATORY_DETAILS)[number];
const MANDATORY_WORDS: Record<MandatoryDetail, string> = {
  joining_date: "joining date",
  current_pay: "current CTC",
  expected_pay: "expected CTC",
};
/** "…the hiring team cannot consider your application" / "…cannot be considered". */
export const SAYS_CONSEQUENCE =
  /\b(cannot|can't|can not|won't be able to|will not be able to|is unable to|are unable to)\s+(be\s+)?consider(ed)?\b/i;

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
    /**
     * A required detail they did not give: "declined" (they would rather not say —
     * their words in pay_note or candidate_note) or "not_working" (current pay only).
     */
    not_given: z
      .array(
        z.object({
          item: z.enum(MANDATORY_DETAILS),
          why: z.enum(["declined", "not_working"]),
        }),
      )
      .max(3)
      .optional(),
  }),
  record_answer: z.object({
    question_id: z.string().min(1).max(20),
    summary: z.string().trim().min(1).max(600),
    /** They chose not to answer: asked, never graded and never held against them. */
    declined: z.boolean().optional(),
    /**
     * They only agreed with or repeated something you said (an example, a tool, a
     * yes/no) and gave no specifics of their own: not evidence, never counted as answered.
     */
    prompted: z.boolean().optional(),
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
    "Record whether the candidate agreed to the screening call now (and to notes for the hiring team and the quality check): granted true only if they clearly agreed in their answer to your latest question; their_words is exactly what they said. Refused when that answer raised a concern (they did not apply, how you got their details, not sure…): answer it, ask again, and record their answer to that.",
  record_details:
    "Record the practical details the candidate told you, as they said them: current job title and company, total years of experience, where they live now, whether they are open to relocating (only a yes or no they actually said — a question back is not an answer), notice period in days, earliest joining date (YYYY-MM-DD), and current fixed pay, current variable pay and expected pay as rupees per year (e.g. 18 lakhs = 1800000; a range such as \"95 lakhs to 1 crore\" is its lower end, with the range in pay_note) — only figures they actually stated; never calculate one. Anything about pay that is not a figure (a percentage hike, shares, bonuses) goes in pay_note in their words; anything else the hiring team should know (a time limit they set, skills they said are new to them) in candidate_note. Call it again as more details come; leave out anything they did not say. Never comment on the figures. The earliest joining date, current pay and expected pay are required before the call can end as completed: if they would rather not say one, list it in not_given with why 'declined' (their words in pay_note, or in candidate_note for the joining date); if they are not working now, list current_pay with why 'not_working'. A decline is taken only after you have told them, since your last record_details, that without it the hiring team cannot consider their application — otherwise it is refused and you ask once more with that sentence.",
  record_answer:
    'After you ask one of the listed screening questions: the question\'s id and a faithful one or two sentence summary of what the candidate said. If they chose not to answer it, set declined true and say so in the summary — it is never held against them. Saying they have not done it or lack the experience is an answer: declined false. The summary holds only what the candidate said in their own words — never a tool, method or detail that you said first. If they only agreed with or repeated something you said ("yes, I used that") and gave no specifics of their own, set prompted true and say so in the summary.',
  book_slot:
    "The candidate cannot talk now and agreed a time for the call: when_local is that time as YYYY-MM-DDTHH:mm in the organisation's local time (see the current local time and the calling hours). A confirmation is e-mailed to them.",
  end_call:
    "Hang up after saying goodbye out loud, with why the call ended: completed (refused until the earliest joining date, current pay and expected pay are each recorded or listed in not_given), booked (a later time was agreed), declined, prefers_written (they chose the written assessment), prefers_human (they want a person to call), not_interested (in the role), wrong_person, voicemail, candidate_left, other.",
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
  answers: {
    question_id: string;
    summary: string;
    at: string;
    declined?: boolean;
    prompted?: boolean;
  }[];
  booking: { whenLocal: string } | null;
  endReason: EndReason | null;
  /** How many more times the call may be moved to another time (undefined: no limit known). */
  reschedulesLeft?: number;
  /** Length of the assistant's spoken lines at the last record_details (live call). */
  saidAtDetails?: number;
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
 * consent: that it is an AI, that it makes notes for the hiring team, and that
 * the call is checked for quality (the Voice Guard reviews it afterwards).
 * Checked against its own spoken lines on a live call (pure; unit-tested).
 */
export function disclosureMissing(
  aiSaid: string,
  /** false: AI and notes only — graders of calls made before the quality line (pay before disclosure). */
  opts: { quality?: boolean } = {},
): string | null {
  const missing = [
    /\bAI\b|artificial intelligence/i.test(aiSaid)
      ? null
      : "that you are an AI recruiting assistant",
    /\bnotes?\b|transcri/i.test(aiSaid)
      ? null
      : "that you make notes of the conversation for the hiring team",
    opts.quality === false || /\bquality\b/i.test(aiSaid)
      ? null
      : "that the call is checked for quality",
  ].filter(Boolean);
  return missing.length ? missing.join(" and ") : null;
}

/** Spoken names of the required details, for the refusal the model hears. */
const MANDATORY_SPOKEN: Record<MandatoryDetail, string> = {
  joining_date: "the earliest date they could join",
  current_pay: "their current pay (fixed and variable)",
  expected_pay: "their expected pay",
};

/**
 * The required details a completed call still lacks (pure; unit-tested): each
 * is a recorded value or a not_given entry. "not_working" excuses current pay
 * only; "declined" for pay needs their words in pay_note, and for the joining
 * date in candidate_note — the hiring team sees what was said.
 */
export function mandatoryMissing(d: CallDetailsInput | null): MandatoryDetail[] {
  const notGiven = new Map((d?.not_given ?? []).map((n) => [n.item, n.why]));
  const excused = (item: MandatoryDetail): boolean => {
    const why = notGiven.get(item);
    if (why === "not_working") return item === "current_pay";
    if (why === "declined")
      return Boolean(item === "joining_date" ? d?.candidate_note : d?.pay_note);
    return false;
  };
  const has: Record<MandatoryDetail, boolean> = {
    joining_date: Boolean(d?.earliest_joining),
    current_pay: d?.current_ctc_fixed != null,
    expected_pay: d?.expected_ctc != null,
  };
  return MANDATORY_DETAILS.filter((item) => !has[item] && !excused(item));
}

export type RequiredStatus = "recorded" | "declined" | "not_working" | "missing";

/** Where each required detail stands (pure; stored on the call, no figures). */
export function requiredDetailStatus(
  d: CallDetailsInput | null,
): Record<MandatoryDetail, RequiredStatus> {
  const missing = new Set(mandatoryMissing(d));
  const why = new Map((d?.not_given ?? []).map((n) => [n.item, n.why]));
  const has: Record<MandatoryDetail, boolean> = {
    joining_date: Boolean(d?.earliest_joining),
    current_pay: d?.current_ctc_fixed != null,
    expected_pay: d?.expected_ctc != null,
  };
  const of = (item: MandatoryDetail): RequiredStatus =>
    has[item] ? "recorded" : missing.has(item) ? "missing" : (why.get(item) ?? "missing");
  return {
    joining_date: of("joining_date"),
    current_pay: of("current_pay"),
    expected_pay: of("expected_pay"),
  };
}

/**
 * A reply that raises a concern (pure; unit-tested): consent cannot come from
 * it — the concern is answered and they are asked again. A real call on
 * 10 November took "It is okay, but I have never applied for this post" as
 * consent before the concern was answered.
 */
/**
 * A pay figure in the candidate's words ("67 lakhs", "95 lakhs to 1 crore", "18 LPA").
 * A test call on 11 November heard "between 95 lakhs to 1 crore" after a decline
 * and kept "declined": a range had no field (pure; unit-tested).
 */
export const STATES_AMOUNT =
  /\b\d[\d,.]*\s*(lakhs?|lacs?|lpa|crores?|cr|k|thousand|million)\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[a-z]+teen|[a-z]+ty|hundred)\b[\w\s-]{0,30}\b(lakhs?|lacs?|crores?)\b|₹\s*\d/i;

export const RAISES_CONCERN =
  /\b(never|not|didn'?t|did not|haven'?t|have not)\s+(applied|apply)\b|\bhow did you (get|find|have)\b|\bwhere did you get\b|\bwho (gave|are you|is this)\b|\bwhat is this (about|for)\b|\bnot interested\b|\bdon'?t want\b|\bwrong (number|person)\b|\bnot sure\b/i;

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
  /**
   * What the candidate said since the assistant's latest question (live call):
   * consent is their answer to it, in these words, and never a reply that
   * raised a concern.
   */
  reply?: string,
  /**
   * What the assistant had said when it asked the question `reply` answers (live
   * call). Consent counts only if the disclosure came before that question: a test
   * call on 11 November recorded the "Yes" to "am I speaking with …?" as consent and
   * went on without waiting for an answer to "is now a good time?".
   */
  saidBeforeReply?: string,
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
      if (granted && reply !== undefined && !reply.trim())
        return {
          ok: false,
          error:
            "Not recorded: they have not answered yet. Stop and wait for their answer to whether they are happy to continue; record that.",
        };
      const heardBefore = saidBeforeReply ?? aiSaid;
      const missing = granted && heardBefore !== undefined ? disclosureMissing(heardBefore) : null;
      if (missing)
        return {
          ok: false,
          error: `Not recorded: first tell them ${missing}, then ask again whether they are happy to continue.`,
        };
      if (granted && reply !== undefined && RAISES_CONCERN.test(reply))
        return {
          ok: false,
          error: `Not recorded: their reply raised a concern ("${reply.trim().slice(0, 120)}"). Answer it first, then ask again whether they are happy to continue, and record their answer to that.`,
        };
      state.consent = granted;
      // The words actually heard, not the model's paraphrase.
      state.consentWords = reply?.trim() ? reply.trim().slice(0, 300) : their_words;
      if (granted) state.consentAt = now;
      return { ok: true };
    }
    case "record_details": {
      const input = { ...(parsed.data as CallDetailsInput) };
      // A required detail is taken as declined only once the candidate has been told,
      // since the last record_details, that without it the application cannot be
      // considered — that is the second ask (live call; screening 1.6.2). A test call
      // on 10 November skipped that sentence and took "I will talk to the HR" for both
      // pays at once.
      let refusedDecline: MandatoryDetail[] = [];
      if (aiSaid !== undefined) {
        const since = aiSaid.slice(state.saidAtDetails ?? 0);
        state.saidAtDetails = aiSaid.length;
        const already = new Set(
          (state.details?.not_given ?? []).filter((n) => n.why === "declined").map((n) => n.item),
        );
        if (!SAYS_CONSEQUENCE.test(since))
          refusedDecline = (input.not_given ?? [])
            .filter((n) => n.why === "declined" && !already.has(n.item))
            .map((n) => n.item);
        if (refusedDecline.length) {
          input.not_given = input.not_given!.filter((n) => !refusedDecline.includes(n.item));
          if (!input.not_given.length) delete input.not_given;
        }
      }
      // They just stated a figure for a pay detail on record as declined: record it,
      // never leave the decline standing.
      const payFields = { current_pay: "current_ctc_fixed", expected_pay: "expected_ctc" } as const;
      if (reply !== undefined && STATES_AMOUNT.test(reply)) {
        const stillDeclined = (["current_pay", "expected_pay"] as const).filter(
          (item) =>
            (input as Record<string, unknown>)[payFields[item]] == null &&
            [...(state.details?.not_given ?? []), ...(input.not_given ?? [])].some(
              (n) => n.item === item && n.why === "declined",
            ),
        );
        if (stillDeclined.length) {
          state.details = { ...state.details, ...input, not_given: state.details?.not_given };
          if (!state.details.not_given) delete state.details.not_given;
          return {
            ok: false,
            error: `They just gave a figure ("${reply.trim().slice(0, 80)}"). Call record_details again with ${stillDeclined.map((i) => payFields[i]).join(" and ")} as rupees per year — for a range, the lower end, with the whole range in pay_note in their words. Do not ask again.`,
          };
        }
      }
      // not_given merges by item (the latest word wins), and a value recorded
      // later clears its not_given entry.
      const merged = { ...state.details, ...input };
      const notGiven = new Map(
        [...(state.details?.not_given ?? []), ...(input.not_given ?? [])].map((n) => [n.item, n]),
      );
      if (merged.earliest_joining) notGiven.delete("joining_date");
      if (merged.current_ctc_fixed != null) notGiven.delete("current_pay");
      if (merged.expected_ctc != null) notGiven.delete("expected_pay");
      if (notGiven.size) merged.not_given = [...notGiven.values()];
      else delete merged.not_given;
      state.details = merged;
      if (refusedDecline.length)
        return {
          ok: false,
          recorded: Object.keys(input).filter((k) => k !== "not_given"),
          error: `Not yet recorded as declined: ${refusedDecline.map((i) => MANDATORY_WORDS[i]).join(", ")}. Ask once more, and in the same breath tell them plainly: "Without your ${refusedDecline.map((i) => MANDATORY_WORDS[i]).join(" and ")}, the hiring team cannot consider your application." If they still will not give it, call record_details again with it in not_given — then move on, and never ask a third time.`,
        };
      return { ok: true, recorded: Object.keys(parsed.data as object) };
    }
    case "record_answer": {
      const a = parsed.data as {
        question_id: string;
        summary: string;
        declined?: boolean;
        prompted?: boolean;
      };
      if (!questionIds.has(a.question_id))
        return { ok: false, error: "That is not one of the listed question ids." };
      state.answers = state.answers.filter((x) => x.question_id !== a.question_id);
      state.answers.push({
        question_id: a.question_id,
        summary: a.summary,
        at: new Date(now).toISOString(),
        ...(a.declined ? { declined: true } : {}),
        ...(a.prompted && !a.declined ? { prompted: true } : {}),
      });
      return { ok: true, asked: state.answers.length };
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
      const reason = (parsed.data as { reason: EndReason }).reason;
      // A completed screen must leave with the joining date and pay (checked in
      // code): recorded, or noted as not given. Ending early for another reason
      // (a later time, a person, not interested) is unaffected.
      if (state.consent === true && (reason === "completed" || reason === "other")) {
        const missing = mandatoryMissing(state.details);
        if (missing.length)
          return {
            ok: false,
            error: `Not ended: before you close, ask ${missing.map((m) => MANDATORY_SPOKEN[m]).join(", ")} — one at a time, plainly — and call record_details with what they say. If they would rather not say, reply "Of course", put their words in pay_note (candidate_note for the joining date) and list it in not_given with why "declined"; if they are not working now, list current_pay with why "not_working". Then say goodbye and end the call.`,
            missing,
          };
      }
      state.endReason = reason;
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
  if (s.consent === true && (s.answers.some((a) => !a.declined) || s.endReason === "completed"))
    return "completed";
  // Voicemail, silence, or they hung up before agreeing: try again later.
  return "no_answer";
}
