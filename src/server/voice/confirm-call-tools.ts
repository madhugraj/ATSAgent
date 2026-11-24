/**
 * In-call tools of the two answer-collecting calls (migration 0092): the
 * candidate's attendance confirmation the day before a booked round, and a
 * panelist's time check. One contract (zod v4) used three ways — the live
 * call's function declarations, the agent registry (so the agents lock covers
 * them) and the text-mode evals. Pure: no database. The answer itself is
 * recorded by the caller through the same core as the e-mailed confirm link.
 */
import { z } from "zod";

import { disclosureMissing } from "./call-tools";
import { UNCLEAR } from "./scheduling-call-tools";

const permission = z.object({
  granted: z.boolean(),
  /** What they said, as heard. */
  their_words: z.string().trim().min(1).max(300),
});

export const CONFIRMATION_END_REASONS = [
  "confirmed",
  "cannot_attend",
  "not_now",
  "opt_out",
  "wrong_person",
  "voicemail",
  "candidate_left",
  "other",
] as const;
export type ConfirmationEndReason = (typeof CONFIRMATION_END_REASONS)[number];

export const CONFIRMATION_TOOL_INPUTS = {
  record_attendance_go_ahead: permission,
  will_attend: z.object({
    /** Exactly what the candidate said to confirm. */
    their_words: z.string().trim().min(1).max(300),
  }),
  cannot_attend: z.object({
    /** Why they cannot make it, or what they need, in their words. */
    their_words: z.string().trim().min(1).max(300),
  }),
  end_confirmation_call: z.object({ reason: z.enum(CONFIRMATION_END_REASONS) }),
} as const;
export type ConfirmationToolName = keyof typeof CONFIRMATION_TOOL_INPUTS;
export const CONFIRMATION_TOOL_NAMES = Object.keys(
  CONFIRMATION_TOOL_INPUTS,
) as ConfirmationToolName[];

export const CONFIRMATION_TOOL_DESCRIPTIONS: Record<ConfirmationToolName, string> = {
  record_attendance_go_ahead:
    "Record whether the candidate has a moment now to confirm their interview: granted true only if they clearly agreed; their_words is exactly what they said.",
  will_attend:
    "The candidate clearly said they will attend at the booked time: their_words is exactly what they said. The result says what to tell them.",
  cannot_attend:
    "The candidate cannot make the booked time, or is not sure they can: their_words is why, or what they need, in their words. It goes to the hiring team, who re-schedule with them. Never offer or agree another time yourself.",
  end_confirmation_call:
    "Hang up after saying goodbye out loud, with why the call ended: confirmed, cannot_attend, not_now (the invite e-mail and its reminder stand), opt_out (they asked not to be called by the AI assistant again), wrong_person, voicemail, candidate_left, other.",
};

export const PANEL_END_REASONS = [
  "answered",
  "not_now",
  "opt_out",
  "wrong_person",
  "voicemail",
  "left",
  "other",
] as const;
export type PanelEndReason = (typeof PANEL_END_REASONS)[number];

/** At most this many times on a panel time check (an offer's times, or one booked time). */
export const MAX_PANEL_TIMES = 8;

export const PANEL_TOOL_INPUTS = {
  record_panel_go_ahead: permission,
  answer_times: z.object({
    /** The numbers of the times in your list they said they can do (empty: none). */
    can_do: z.array(z.number().int().min(1).max(MAX_PANEL_TIMES)).max(MAX_PANEL_TIMES),
    /** What they said, in their words (a reason, another time they suggest). */
    their_words: z.string().trim().min(1).max(300),
  }),
  end_panel_call: z.object({ reason: z.enum(PANEL_END_REASONS) }),
} as const;
export type PanelToolName = keyof typeof PANEL_TOOL_INPUTS;
export const PANEL_TOOL_NAMES = Object.keys(PANEL_TOOL_INPUTS) as PanelToolName[];

export const PANEL_TOOL_DESCRIPTIONS: Record<PanelToolName, string> = {
  record_panel_go_ahead:
    "Record whether the panel member has a moment now to answer the interview time: granted true only if they clearly agreed; their_words is exactly what they said.",
  answer_times:
    "Record which of the times in your list they can do, by number (can_do), with what they said (their_words). An empty can_do means none of them work — their words go to the hiring team. Only times they clearly said they can do.",
  end_panel_call:
    "Hang up after saying goodbye out loud, with why the call ended: answered, not_now (the e-mail with their confirm link stands), opt_out (they asked not to be called by the AI assistant again), wrong_person, voicemail, left, other.",
};

function parametersOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

export const CONFIRMATION_TOOLS = CONFIRMATION_TOOL_NAMES.map((name) => ({
  name,
  description: CONFIRMATION_TOOL_DESCRIPTIONS[name],
  parameters: parametersOf(CONFIRMATION_TOOL_INPUTS[name]),
}));

export const PANEL_TOOLS = PANEL_TOOL_NAMES.map((name) => ({
  name,
  description: PANEL_TOOL_DESCRIPTIONS[name],
  parameters: parametersOf(PANEL_TOOL_INPUTS[name]),
}));

/** What both calls know of their go-ahead. */
export type PermissionState = {
  permission: boolean | null;
  permissionWords?: string;
  askedAgain?: boolean;
};

/**
 * The go-ahead, shared by both calls (pure): counts only after the AI and
 * note disclosure, only from an answer to the question, and an unclear "no"
 * is sent back once with `explain` (the one-line reason for the call).
 */
export function applyPermission(
  state: PermissionState,
  granted: boolean,
  theirWords: string,
  explain: string,
  aiSaid?: string,
  heardAfterAsk?: string,
): { ok: true } | { ok: false; error: string } {
  const missing = granted && aiSaid !== undefined ? disclosureMissing(aiSaid) : null;
  if (missing)
    return {
      ok: false,
      error: `Not recorded: first tell them ${missing}, then ask again whether they have a moment.`,
    };
  if (heardAfterAsk !== undefined && !heardAfterAsk.trim())
    return {
      ok: false,
      error:
        "Not recorded: ask whether they have a moment now and wait for their answer — record what they say to that question.",
    };
  if (!granted && !state.askedAgain && UNCLEAR.test(theirWords)) {
    state.askedAgain = true;
    return {
      ok: false,
      error: `Not recorded: that is not a clear no. In one plain sentence, say ${explain}, then ask again whether they have a moment.`,
    };
  }
  state.permission = granted;
  state.permissionWords = heardAfterAsk?.trim() ? heardAfterAsk.trim().slice(0, 300) : theirWords;
  return { ok: true };
}

/* ------------------------------------------------ the confirmation call */

export type ConfirmationState = PermissionState & {
  answer: { attend: boolean; words: string } | null;
  endReason: ConfirmationEndReason | null;
};

export const freshConfirmationState = (): ConfirmationState => ({
  permission: null,
  answer: null,
  endReason: null,
});

/** Validate and apply one confirmation-call tool (pure; unit-tested). */
export function applyConfirmationTool(
  state: ConfirmationState,
  name: string,
  args: unknown,
  aiSaid?: string,
  heardAfterAsk?: string,
): { ok: true; answer?: { attend: boolean; words: string } } | { ok: false; error: string } {
  if (!(name in CONFIRMATION_TOOL_INPUTS)) return { ok: false, error: "Unknown tool." };
  const parsed = CONFIRMATION_TOOL_INPUTS[name as ConfirmationToolName].safeParse(args);
  if (!parsed.success) return { ok: false, error: "Those arguments are not valid." };
  if ((name === "will_attend" || name === "cannot_attend") && state.permission !== true)
    return { ok: false, error: "Ask whether they have a moment and record their answer first." };
  switch (name as ConfirmationToolName) {
    case "record_attendance_go_ahead": {
      const d = parsed.data as { granted: boolean; their_words: string };
      return applyPermission(
        state,
        d.granted,
        d.their_words,
        "you are calling only to confirm their interview time",
        aiSaid,
        heardAfterAsk,
      );
    }
    case "will_attend":
    case "cannot_attend": {
      if (state.answer) return { ok: false, error: "Their answer is already recorded." };
      const words = (parsed.data as { their_words: string }).their_words;
      state.answer = { attend: name === "will_attend", words };
      return { ok: true, answer: state.answer };
    }
    case "end_confirmation_call":
      state.endReason = (parsed.data as { reason: ConfirmationEndReason }).reason;
      return { ok: true };
  }
  return { ok: false, error: "Unknown tool." };
}

export type ConfirmationOutcome =
  "confirmed" | "cannot_attend" | "not_now" | "opt_out" | "wrong_person" | "no_answer";

/** Where a finished confirmation call leaves things (pure; unit-tested). */
export function confirmationOutcome(
  s: Pick<ConfirmationState, "permission" | "answer" | "endReason">,
): ConfirmationOutcome {
  if (s.endReason === "opt_out") return "opt_out";
  if (s.endReason === "wrong_person") return "wrong_person";
  if (s.answer) return s.answer.attend ? "confirmed" : "cannot_attend";
  if (s.permission === false || s.endReason === "not_now") return "not_now";
  return "no_answer";
}

/* ------------------------------------------------ the panel time check */

export type PanelCheckState = PermissionState & {
  answer: { canDo: string[]; words: string } | null;
  endReason: PanelEndReason | null;
};

export const freshPanelCheckState = (): PanelCheckState => ({
  permission: null,
  answer: null,
  endReason: null,
});

/** Validate and apply one panel-call tool (pure; unit-tested). `times` are ISO, in list order. */
export function applyPanelTool(
  state: PanelCheckState,
  name: string,
  args: unknown,
  times: string[],
  aiSaid?: string,
  heardAfterAsk?: string,
): { ok: true; answer?: { canDo: string[]; words: string } } | { ok: false; error: string } {
  if (!(name in PANEL_TOOL_INPUTS)) return { ok: false, error: "Unknown tool." };
  const parsed = PANEL_TOOL_INPUTS[name as PanelToolName].safeParse(args);
  if (!parsed.success) return { ok: false, error: "Those arguments are not valid." };
  if (name === "answer_times" && state.permission !== true)
    return { ok: false, error: "Ask whether they have a moment and record their answer first." };
  switch (name as PanelToolName) {
    case "record_panel_go_ahead": {
      const d = parsed.data as { granted: boolean; their_words: string };
      return applyPermission(
        state,
        d.granted,
        d.their_words,
        "you are calling only to check which interview times they can do",
        aiSaid,
        heardAfterAsk,
      );
    }
    case "answer_times": {
      if (state.answer) return { ok: false, error: "Their answer is already recorded." };
      const d = parsed.data as { can_do: number[]; their_words: string };
      const bad = d.can_do.find((n) => !times[n - 1]);
      if (bad)
        return { ok: false, error: `There is no time ${bad}. Use only the numbers in your list.` };
      const canDo = [...new Set(d.can_do)].sort((a, b) => a - b).map((n) => times[n - 1]!);
      state.answer = { canDo, words: d.their_words };
      return { ok: true, answer: state.answer };
    }
    case "end_panel_call":
      state.endReason = (parsed.data as { reason: PanelEndReason }).reason;
      return { ok: true };
  }
  return { ok: false, error: "Unknown tool." };
}

export type PanelCheckOutcome = "answered" | "not_now" | "opt_out" | "wrong_person" | "no_answer";

/** Where a finished panel time check leaves things (pure; unit-tested). */
export function panelCheckOutcome(
  s: Pick<PanelCheckState, "permission" | "answer" | "endReason">,
): PanelCheckOutcome {
  if (s.endReason === "opt_out") return "opt_out";
  if (s.endReason === "wrong_person") return "wrong_person";
  if (s.answer) return "answered";
  if (s.permission === false || s.endReason === "not_now") return "not_now";
  return "no_answer";
}
