/**
 * The Negotiation call agent's in-call tools (docs/negotiator-voice-agent.md):
 * one contract (zod v4) used three ways — the live call's function
 * declarations, the agent registry (so the agents lock covers them) and the
 * evals. Pure: no database.
 *
 * No tool takes an amount. `state_offer` hands back the sentence to read out,
 * so the only figures the assistant can say are the approved proposal and at
 * most one improved figure — and the ceiling never reaches it at all. A clear
 * yes becomes a verbal agreement for a person to confirm; nothing here agrees.
 */
import { z } from "zod";

import type { NegotiationLevers } from "@db/schema";
import { disclosureMissing } from "./call-tools";
import { UNCLEAR } from "./scheduling-call-tools";

export const NEGOTIATION_END_REASONS = [
  "verbal_agreement",
  "handed_off",
  "declined",
  "not_now",
  "opt_out",
  "wrong_person",
  "voicemail",
  "candidate_left",
  "other",
] as const;
export type NegotiationEndReason = (typeof NEGOTIATION_END_REASONS)[number];

export const STANCES = ["accepts", "declines", "wants_more", "unsure"] as const;
export type Stance = (typeof STANCES)[number];

export const HAND_OFF_WHY = ["wants_more", "wants_person", "needs_time", "other"] as const;

export type Which = "proposal" | "improved";

export const NEGOTIATION_TOOL_INPUTS = {
  record_permission: z.object({
    granted: z.boolean(),
    /** What the candidate said, as heard. */
    their_words: z.string().trim().min(1).max(300),
  }),
  state_offer: z.object({
    /** proposal = the approved figure; improved = the one improved figure, after the first was turned down. */
    which: z.enum(["proposal", "improved"]),
  }),
  record_their_position: z.object({
    stance: z.enum(STANCES),
    /** Exactly what they said — any figure they name stays in their words. */
    their_words: z.string().trim().min(1).max(400),
  }),
  submit_agreed_terms: z.object({
    /** Their clear yes to the figure you just read out, as they said it. */
    their_words: z.string().trim().min(1).max(300),
  }),
  request_human_call: z.object({
    why: z.enum(HAND_OFF_WHY),
    their_words: z.string().trim().min(1).max(400),
  }),
  end_negotiation_call: z.object({ reason: z.enum(NEGOTIATION_END_REASONS) }),
} as const;
export type NegotiationToolName = keyof typeof NEGOTIATION_TOOL_INPUTS;
export const NEGOTIATION_TOOL_NAMES = Object.keys(NEGOTIATION_TOOL_INPUTS) as NegotiationToolName[];

export const NEGOTIATION_TOOL_DESCRIPTIONS: Record<NegotiationToolName, string> = {
  record_permission:
    "Record whether the candidate has a few minutes now to talk about the pay for their offer (and agreed to notes for the hiring team): granted true only if they clearly agreed; their_words is exactly what they said.",
  state_offer:
    'Get the exact words for a figure, then say them out loud word for word. which "proposal" first; "improved" only after they turned the proposal down, and only if the result of record_their_position said you may. You never say any other figure.',
  record_their_position:
    "Record the candidate's answer to the figure you read out: stance accepts, declines, wants_more (they want more) or unsure; their_words exactly as they said it, including any figure they named. The result says what you may do next.",
  submit_agreed_terms:
    "They clearly said yes to the figure you just read out: pass it to the hiring team, who confirm it with them. It does not agree anything itself. their_words is their yes, as said.",
  request_human_call:
    "Hand to a person: they want more than you may offer (wants_more), want to speak to someone (wants_person), want time to think (needs_time), or other. Say the hiring team will come back to them.",
  end_negotiation_call:
    "Hang up after saying goodbye out loud, with why the call ended: verbal_agreement, handed_off, declined (they do not want to discuss pay), not_now, opt_out (they asked not to be called by the AI assistant again), wrong_person, voicemail, candidate_left, other.",
};

/** JSON Schema of a tool's arguments, as providers want it (no `$schema`). */
export function negotiationToolParameters(name: NegotiationToolName): Record<string, unknown> {
  const json = z.toJSONSchema(NEGOTIATION_TOOL_INPUTS[name]) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

/** The live model's function declarations, generated from the contracts above. */
export const NEGOTIATION_TOOLS = NEGOTIATION_TOOL_NAMES.map((name) => ({
  name,
  description: NEGOTIATION_TOOL_DESCRIPTIONS[name],
  parameters: negotiationToolParameters(name),
}));

/** The figures a call may say — held by the code, never put in the prompt. */
export type NegotiationFigures = {
  proposalCtc: number;
  /** The one improved figure (above the proposal, ≤ ceiling); null = hold. */
  stepCtc: number | null;
  levers: NegotiationLevers;
};

/** A yearly rupee amount as it is spoken in India: "18 lakh 50 thousand rupees a year" (pure). */
export function spokenRupees(n: number): string {
  const r = Math.round(n);
  const crore = Math.floor(r / 1e7);
  const lakh = Math.floor((r % 1e7) / 1e5);
  const thousand = Math.floor((r % 1e5) / 1e3);
  const parts = [
    crore ? `${crore} crore` : "",
    lakh ? `${lakh} lakh` : "",
    thousand ? `${thousand} thousand` : "",
  ].filter(Boolean);
  return `${parts.join(" ") || r} rupees`;
}

/** The approved extras as one spoken sentence, or "" (pure). */
export function leverSentence(l: NegotiationLevers): string {
  const items = [
    l.joiningBonus ? `a one-time joining bonus of ${spokenRupees(l.joiningBonus)}` : "",
    l.reviewMonths ? `a pay review after ${l.reviewMonths} months` : "",
    l.other?.trim() ? l.other.trim().replace(/\.$/, "") : "",
  ].filter(Boolean);
  if (!items.length) return "";
  const list =
    items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  return ` Along with that, the offer includes ${list}.`;
}

/** The exact words for one approved figure (pure). */
export function offerSentence(which: Which, f: NegotiationFigures): string {
  const ctc = which === "improved" ? f.stepCtc! : f.proposalCtc;
  const lead =
    which === "improved"
      ? `Having heard you, the hiring team can offer ${spokenRupees(ctc)} a year as the annual cost to company.`
      : `The hiring team would like to offer you ${spokenRupees(ctc)} a year as the annual cost to company.`;
  return `${lead}${leverSentence(f.levers)} Would that work for you?`;
}

/** A clear yes: yes-like words and no "no / but / not" (pure; unit-tested). */
const AFFIRM =
  /\b(yes|yeah|yep|yup|ok|okay|sure|agreed?|fine|deal|done|accept\w*|go ahead|works for me|sounds good|haan|han|theek|thik|ji)\b/i;
const NEGATE = /\b(no|not|don'?t|can'?t|won'?t|but|however|nahi|nahin|unless|if)\b/i;
const NOT_A_NO = /\bno (problem|issues?|worries)\b|\bnot a problem\b/gi;
export const clearYes = (s: string): boolean =>
  AFFIRM.test(s) && !NEGATE.test(s.replace(NOT_A_NO, ""));

/** A yes that names a number other than the figure read out ("yes, 40") is not a yes to it (pure). */
export function namesOtherFigure(words: string, ctc: number): boolean {
  const said = new Set(spokenRupees(ctc).match(/\d+/g) ?? []);
  return (words.match(/\d+(?:\.\d+)?/g) ?? []).some((n) => !said.has(n));
}

export type NegotiationCallState = {
  permission: boolean | null;
  askedAgain?: boolean;
  permissionWords?: string;
  /** Figures read out so far, and the last one (an agreement binds only to it). */
  stated: { proposal: boolean; improved: boolean };
  lastStated: Which | null;
  /** They turned the proposal down — the one move is open (if there is a step). */
  proposalDeclined: boolean;
  positions: { stance: Stance; words: string; after: Which | null }[];
  agreement: { which: Which; ctc: number; words: string } | null;
  handOff: { why: (typeof HAND_OFF_WHY)[number]; words: string } | null;
  endReason: NegotiationEndReason | null;
  /**
   * The live guard stopped the assistant (it said a figure it was not given): no
   * more figures and no yes is passed on — a person takes it from here.
   */
  halted?: boolean;
};

export const freshNegotiationState = (): NegotiationCallState => ({
  permission: null,
  stated: { proposal: false, improved: false },
  lastStated: null,
  proposalDeclined: false,
  positions: [],
  agreement: null,
  handOff: null,
  endReason: null,
});

type Result = { ok: true; [k: string]: unknown } | { ok: false; error: string };

/**
 * Validate and apply one in-call tool (pure over the state; unit-tested).
 * `aiSaid` — the assistant's own lines so far, on a live call — lets the code
 * refuse a go-ahead given before the disclosure; `heardAfterAsk` — what the
 * candidate said since the assistant last asked a question — is what a
 * go-ahead or a yes must come from (not the model's version of it).
 */
export function applyNegotiationTool(
  state: NegotiationCallState,
  name: string,
  args: unknown,
  figures: NegotiationFigures,
  aiSaid?: string,
  heardAfterAsk?: string,
): Result {
  if (!(name in NEGOTIATION_TOOL_INPUTS)) return { ok: false, error: "Unknown tool." };
  const parsed = NEGOTIATION_TOOL_INPUTS[name as NegotiationToolName].safeParse(args);
  if (!parsed.success) return { ok: false, error: "Those arguments are not valid." };
  const needsPermission =
    name === "state_offer" ||
    name === "record_their_position" ||
    name === "submit_agreed_terms" ||
    name === "request_human_call";
  if (needsPermission && state.permission !== true)
    return {
      ok: false,
      error:
        "Ask whether they have a few minutes to talk about the pay, and record their answer first.",
    };
  const heard = heardAfterAsk?.trim();
  if (state.halted && (name === "state_offer" || name === "submit_agreed_terms"))
    return {
      ok: false,
      error:
        "Stopped: you said a figure you were not given. Correct yourself, say the hiring team will come back to them, request_human_call and end the call.",
    };
  switch (name as NegotiationToolName) {
    case "record_permission": {
      const { granted, their_words } = parsed.data as { granted: boolean; their_words: string };
      const missing = granted && aiSaid !== undefined ? disclosureMissing(aiSaid) : null;
      if (missing)
        return {
          ok: false,
          error: `Not recorded: first tell them ${missing}, then ask again whether they have a few minutes.`,
        };
      if (heardAfterAsk !== undefined && !heard)
        return {
          ok: false,
          error:
            "Not recorded: ask whether they have a few minutes now and wait for their answer — record what they say to that question.",
        };
      if (!granted && !state.askedAgain && UNCLEAR.test(their_words)) {
        state.askedAgain = true;
        return {
          ok: false,
          error:
            "Not recorded: that is not a clear no. In one plain sentence, say you are calling only about the pay for the role they were offered, then ask again whether they have a few minutes.",
        };
      }
      state.permission = granted;
      state.permissionWords = heard ? heard.slice(0, 300) : their_words;
      return { ok: true };
    }
    case "state_offer": {
      const { which } = parsed.data as { which: Which };
      if (which === "improved") {
        if (figures.stepCtc == null)
          return {
            ok: false,
            error:
              "There is no other figure you may offer. Say the hiring team will come back to them, and use request_human_call.",
          };
        if (!state.stated.proposal || !state.proposalDeclined)
          return {
            ok: false,
            error:
              'Not yet: read out the proposal first (which "proposal") and record their answer with record_their_position.',
          };
      }
      state.stated[which] = true;
      state.lastStated = which;
      return { ok: true, say: offerSentence(which, figures) };
    }
    case "record_their_position": {
      const { stance, their_words } = parsed.data as { stance: Stance; their_words: string };
      const words = heard ? heard.slice(0, 400) : their_words;
      state.positions.push({ stance, words, after: state.lastStated });
      const turnedDown = stance === "declines" || stance === "wants_more";
      if (turnedDown && state.lastStated === "proposal") state.proposalDeclined = true;
      let next: string;
      if (stance === "accepts")
        next = "If they clearly said yes to the figure you just read out, use submit_agreed_terms.";
      else if (stance === "unsure")
        next =
          "Ask once, gently, what would help them decide. If they want time, use request_human_call with needs_time.";
      else if (state.lastStated === "proposal" && figures.stepCtc != null && !state.stated.improved)
        next = 'You may offer the improved figure, once: state_offer with which "improved".';
      else
        next =
          "You have no other figure. Thank them, say the hiring team will come back to them, and use request_human_call with wants_more.";
      return { ok: true, next };
    }
    case "submit_agreed_terms": {
      if (state.agreement) return { ok: false, error: "Their answer is already passed on." };
      const which = state.lastStated;
      if (!which)
        return {
          ok: false,
          error: "Read out the figure first (state_offer), then ask whether it works for them.",
        };
      const { their_words } = parsed.data as { their_words: string };
      if (heardAfterAsk !== undefined && !heard)
        return {
          ok: false,
          error: "Not recorded: ask whether the figure works for them and wait for their answer.",
        };
      const ctc = which === "improved" ? figures.stepCtc! : figures.proposalCtc;
      if (!clearYes(heard ?? their_words) || namesOtherFigure(heard ?? their_words, ctc))
        return {
          ok: false,
          error:
            "Not recorded: that is not a clear yes to the figure you read out. Record their answer with record_their_position instead.",
        };
      state.agreement = { which, ctc, words: (heard ?? their_words).slice(0, 300) };
      return {
        ok: true,
        say: "Thank you. I will pass your answer to the hiring team, who will confirm it with you.",
      };
    }
    case "request_human_call": {
      const { why, their_words } = parsed.data as {
        why: (typeof HAND_OFF_WHY)[number];
        their_words: string;
      };
      state.handOff = { why, words: their_words };
      return { ok: true };
    }
    case "end_negotiation_call": {
      state.endReason = (parsed.data as { reason: NegotiationEndReason }).reason;
      return { ok: true };
    }
  }
  return { ok: false, error: "Unknown tool." };
}

export type NegotiationCallOutcomeKind =
  | "verbal_agreement"
  | "handed_off"
  | "declined"
  | "not_now"
  | "opt_out"
  | "wrong_person"
  | "no_answer";

/** Where a finished negotiation call leaves things (pure; unit-tested). */
export function negotiationOutcome(
  s: Pick<NegotiationCallState, "permission" | "agreement" | "handOff" | "endReason" | "positions">,
): NegotiationCallOutcomeKind {
  if (s.endReason === "opt_out") return "opt_out";
  if (s.endReason === "wrong_person") return "wrong_person";
  if (s.agreement) return "verbal_agreement";
  if (s.handOff || s.positions.length) return "handed_off";
  if (s.endReason === "declined") return "declined";
  if (s.permission === false || s.endReason === "not_now") return "not_now";
  return "no_answer";
}
