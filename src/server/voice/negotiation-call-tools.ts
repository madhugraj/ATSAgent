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

import type { NegotiationCallBrief, NegotiationCallNotes, NegotiationLevers } from "@db/schema";
import { disclosureMissing } from "./call-tools";
import { amountsIn } from "./negotiation-graders";
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

/**
 * accepts · declines · wants_more (a higher total) · restructure (the same total,
 * a different split or terms — never more money) · unsure.
 */
export const STANCES = ["accepts", "declines", "wants_more", "restructure", "unsure"] as const;
export type Stance = (typeof STANCES)[number];

export const HAND_OFF_WHY = ["wants_more", "wants_person", "needs_time", "other"] as const;

export type Which = "proposal" | "improved";

/** What the call may explain about the package — only as the person who arranged it approved. */
export const EXPLAIN_TOPICS = [
  "package",
  "split",
  "joining_bonus",
  "review",
  "esop",
  "benefits",
  "why_you",
  "rationale",
  "reporting",
] as const;
export type ExplainTopic = (typeof EXPLAIN_TOPICS)[number];

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
  explain_offer: z.object({
    /** What they asked about. */
    topic: z.enum(EXPLAIN_TOPICS),
  }),
  submit_agreed_terms: z.object({
    /** Their clear yes to the figure you just read out, as they said it. */
    their_words: z.string().trim().min(1).max(300),
  }),
  request_human_call: z.object({
    why: z.enum(HAND_OFF_WHY),
    their_words: z.string().trim().min(1).max(400),
  }),
  record_call_notes: z.object({
    /** How they feel about the offer overall. */
    feeling: z.enum(["positive", "mixed", "negative"]),
    /** What matters most to them, in their words. */
    priorities: z.string().trim().min(2).max(300),
    /** What holds them back, in their words ("none" if nothing). */
    concerns: z.string().trim().min(2).max(300),
    /** Where the call landed, in two or three sentences for the hiring team. */
    summary: z.string().trim().min(10).max(500),
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
    "Record the candidate's answer to the figure you read out: stance accepts (a clear yes), declines, wants_more (they want a HIGHER total), restructure (they are fine with the total but want a different split of fixed and variable, or other terms such as the joining date — this is NOT more money), or unsure; their_words exactly as they said it, including any figure they named. The result says what you may do next.",
  explain_offer:
    "Get the approved words about part of the offer, then say them: package (the whole offer), split (fixed and variable), joining_bonus, review (how the pay review works), esop, benefits, why_you (why the team wants them), rationale (how the figure was set — when they ask why this figure or about market research), or reporting (who the role reports to, by job title). Use it whenever they ask about the package, and to build the offer's value. Never describe the package any other way; if the result says a detail is not shared, say the hiring team will share it.",
  submit_agreed_terms:
    "They clearly said yes to the figure you just read out: pass it to the hiring team, who confirm it with them. It does not agree anything itself. their_words is their yes, as said.",
  request_human_call:
    "Hand to a person (allowed at any point — a request for a person is never refused): they want more than you may offer (wants_more), want to speak to someone (wants_person), want time to think (needs_time), or other. Say the hiring team will come back to them.",
  record_call_notes:
    "Before you say goodbye on a call where you talked about the offer: notes for the hiring team — how they feel about the offer (positive, mixed or negative), what matters most to them and what holds them back, in their words, and where the call landed in two or three sentences. Required before ending such a call.",
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
  /** What the person arranging the call approved it to explain. */
  brief?: NegotiationCallBrief | null;
};

/** Every amount the call may say right now (pure): the guard allows only these. */
export function allowedAmounts(f: NegotiationFigures, improvedGiven: boolean): number[] {
  const b = f.brief ?? {};
  return [
    f.proposalCtc,
    ...(improvedGiven && f.stepCtc != null ? [f.stepCtc] : []),
    ...[f.levers.joiningBonus, b.fixedCtc, b.variableCtc, b.esopValue].filter(
      (x): x is number => typeof x === "number" && x > 0,
    ),
  ];
}

/**
 * Why a call brief cannot be approved, or null (pure; unit-tested): the split
 * adds up to the proposal, amounts are positive and within it, the words
 * carry no amounts, at most three short "why you" points.
 */
export function callBriefProblem(
  b: NegotiationCallBrief,
  n: { proposedCtc: number; ceiling: number },
): string | null {
  const { fixedCtc: fx, variableCtc: vr, esopValue } = b;
  for (const x of [fx, vr, esopValue])
    if (x != null && !(x > 0)) return "Amounts must be positive.";
  if ((fx != null) !== (vr != null))
    return "Give both the fixed and the variable part, or neither.";
  if (fx != null && vr != null && Math.abs(fx + vr - n.proposedCtc) > 1)
    return "Fixed and variable must add up to the proposal.";
  if (esopValue != null && esopValue > n.ceiling)
    return "The ESOP value cannot be above the approved ceiling.";
  if (b.reportsTo != null) {
    const r = b.reportsTo.trim();
    if (r.length < 2 || r.length > 80) return "Give the reporting line as a job title.";
    if (/@|\d{3,}/.test(r)) return "The reporting line is a job title — no e-mails or numbers.";
  }
  for (const t of [b.esop, b.review, b.benefits, b.rationale, ...(b.whyYou ?? [])])
    if (t && /\d[\d,.]*\s*(lakh|lac|crore|cr|lpa|k\b|%|rupees|₹|rs\b)|₹\s*\d/i.test(t))
      return "Keep amounts out of the words — use the amount fields.";
  if ((b.whyYou ?? []).length > 3) return "At most three reasons why the team wants them.";
  if ((b.whyYou ?? []).some((w) => w.length > 200)) return "Keep each reason under 200 characters.";
  for (const t of [b.esop, b.review, b.benefits, b.rationale])
    if (t && t.length > 300) return "Keep each description under 300 characters.";
  return null;
}

const NOT_SHARED =
  "That detail is not shared for this call: say the hiring team will share it with them.";

/** The approved words for one part of the offer (pure; unit-tested). */
export function explainOffer(
  topic: ExplainTopic,
  f: NegotiationFigures,
  improved: boolean,
): string {
  const b = f.brief ?? {};
  const split =
    b.fixedCtc != null && b.variableCtc != null
      ? `Of the ${spokenRupees(f.proposalCtc)} a year, ${spokenRupees(b.fixedCtc)} is fixed pay and ${spokenRupees(b.variableCtc)} is variable pay.${improved ? " That split is for the first figure; the hiring team will confirm the split for the improved one." : ""}`
      : null;
  const bonus = f.levers.joiningBonus
    ? `There is a one-time joining bonus of ${spokenRupees(f.levers.joiningBonus)}.`
    : null;
  const review =
    b.review?.trim() ||
    (f.levers.reviewMonths
      ? `Your pay is reviewed after ${f.levers.reviewMonths} months, as part of the hiring team's review process.`
      : null);
  const esop = b.esop?.trim()
    ? `${b.esop.trim().replace(/\.$/, "")}${b.esopValue ? `, valued at ${spokenRupees(b.esopValue)}` : ""}.`
    : null;
  const benefits = b.benefits?.trim() || null;
  const whyYou = b.whyYou?.length ? b.whyYou.join(" ") : null;
  const by: Record<ExplainTopic, string | null> = {
    package:
      [
        split ??
          `The annual cost to company is ${spokenRupees(improved && f.stepCtc ? f.stepCtc : f.proposalCtc)}.`,
        bonus,
        review,
        esop,
        benefits,
      ]
        .filter(Boolean)
        .join(" ") || null,
    split,
    joining_bonus: bonus,
    review,
    esop,
    benefits,
    why_you: whyYou,
    rationale: b.rationale?.trim() || null,
    reporting: b.reportsTo?.trim()
      ? `The role reports to ${/^(the|a|an)\s/i.test(b.reportsTo.trim()) ? "" : "the "}${b.reportsTo.trim().replace(/\.$/, "")}.`
      : null,
  };
  return by[topic] ?? NOT_SHARED;
}

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

/** The rest of the package in words — ESOPs and benefits — as one sentence, or "" (pure). */
function packageExtras(f: NegotiationFigures): string {
  const b = f.brief ?? {};
  const items = [
    b.esop?.trim()
      ? `${b.esop.trim().replace(/\.$/, "")}${b.esopValue ? ` valued at ${spokenRupees(b.esopValue)}` : ""}`
      : "",
    b.benefits?.trim() ? b.benefits.trim().replace(/\.$/, "") : "",
  ].filter(Boolean);
  return items.length ? ` You would also have ${items.join(", and ")}.` : "";
}

/**
 * The exact words for one approved figure — the whole package at once, so the
 * candidate hears every part up front (a real call: "you did not tell me about
 * the ESOPs first hand") (pure).
 */
export function offerSentence(which: Which, f: NegotiationFigures): string {
  const ctc = which === "improved" ? f.stepCtc! : f.proposalCtc;
  const b = f.brief ?? {};
  const split =
    which === "proposal" && b.fixedCtc != null && b.variableCtc != null
      ? ` — ${spokenRupees(b.fixedCtc)} fixed and ${spokenRupees(b.variableCtc)} variable`
      : "";
  const lead =
    which === "improved"
      ? `Having heard you, the hiring team can offer ${spokenRupees(ctc)} a year as the annual cost to company.`
      : `The hiring team would like to offer you ${spokenRupees(ctc)} a year as the annual cost to company${split}.`;
  // The proposal invites how they feel; the improved figure asks for their answer.
  const ask = which === "proposal" ? "How do you feel about it?" : "Would that work for you?";
  return `${lead}${leverSentence(f.levers)}${packageExtras(f)} ${ask}`;
}

/** A clear yes: yes-like words and no "no / but / not" (pure; unit-tested). */
const AFFIRM =
  /\b(yes|yeah|yep|yup|ok|okay|sure|agreed?|fine|deal|done|accept\w*|go ahead|works for me|sounds good|haan|han|theek|thik|ji)\b/i;
const NEGATE =
  /\b(no|not|don'?t|can'?t|won'?t|but|however|nahi|nahin|unless|if|provided|providing|only|depends|condition)\b/i;
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
  /**
   * The improved figure's words were handed to the assistant (after a no), so it
   * need never invent one; once it says them the call counts them as offered.
   */
  improvedRevealed?: boolean;
  /**
   * The conditional question was asked ("if the team could improve it, would you
   * go ahead?") — a concession is traded for a commitment, never given away.
   */
  conditionalAsked?: boolean;
  /** …and their answer: true = they would go ahead (the move is earned), false = not even then. */
  conditionalYes?: boolean | null;
  /** The conditional question was asked again once after an answer that was not a yes. */
  conditionalReasked?: boolean;
  /** A different split or terms they asked for at the same total, in their words (for the team). */
  structureAsk?: string | null;
  /** The notes for the team (required before a call about the offer ends). */
  notes?: NegotiationCallNotes | null;
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
    // Why the team wants them is appreciation, not pay: it may come with the greeting.
    (name === "explain_offer" && (parsed.data as { topic?: string }).topic !== "why_you") ||
    name === "record_call_notes";
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
            "Not recorded: they have not answered yet. Say nothing more and do not repeat the question — wait in silence for their answer, then record what they say.",
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
        if (!state.conditionalAsked || state.conditionalYes == null)
          return {
            ok: false,
            error:
              "Not yet: never give the improvement away. Ask first whether, if the hiring team could improve the offer, they would be ready to go ahead with us — and record their answer with record_their_position.",
          };
        if (state.conditionalYes === false)
          return {
            ok: false,
            error:
              "They said they would not go ahead even with more: keep the improvement for the hiring team. Summarise what would make it work for them and use request_human_call.",
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
      // A different split or terms at the same total is not a request for more money:
      // the improvement stays put (a real call revealed it for "46 + 4 instead of 42 + 8").
      if (stance === "restructure") {
        state.structureAsk = words;
        // Never their numbers back: a rehearsal said "46 lakh fixed and 4 lakh variable" and
        // the guard (rightly) stopped a happy candidate's yes.
        const noted =
          'They are not asking for more money — do not offer or mention any improvement. Tell them warmly you have noted the split they described (say "the split you described" — never say their numbers back) and that the hiring team will look at it with them.';
        return {
          ok: true,
          next: state.stated.proposal
            ? `${noted} Then ask plainly whether, on that basis, they are happy to go ahead at this offer. A clear yes → submit_agreed_terms (the team sees their preferred structure with it).`
            : // They raised it before hearing the offer: the yes must follow the offer's words.
              `${noted} Then read the offer: state_offer with which "proposal", and ask whether, with the split they described noted, they are happy to go ahead. A clear yes → submit_agreed_terms.`,
        };
      }
      const canMove =
        figures.stepCtc != null && state.stated.proposal && !state.stated.improved && !state.halted;
      if (canMove && state.conditionalAsked && state.conditionalYes == null) {
        // Their answer to the conditional question.
        // Only a clear, unconditional yes earns the move ("yes, provided it is much better" is
        // not one — a rehearsal revealed the improvement for it).
        const said = heard ?? their_words;
        const committed = stance === "accepts" && clearYes(said);
        // Their own figure is far beyond the improvement: it cannot close the gap, so keep it
        // for the hiring team (who may take it further) instead of spending it on the call.
        const theirAsk = Math.max(
          0,
          ...amountsIn([said, ...state.positions.map((p) => p.words)].join(" ")),
        );
        if (figures.stepCtc != null && theirAsk > figures.stepCtc * 1.25) {
          state.conditionalYes = false;
          next =
            "Their expectation is well beyond anything you can offer on this call: keep the improvement for the hiring team, who may take it further. Acknowledge warmly how far apart you are, sum up in words what would make it work for them, say the hiring team will come back to them, and use request_human_call with wants_more.";
        } else if (!committed && stance !== "declines" && !state.conditionalReasked) {
          // "I'll think about it" or "how much?" is not a yes: one plain re-ask.
          state.conditionalReasked = true;
          next =
            'That is not a yes yet — do not reveal anything. If they ask how much: "I can share it as soon as I know you\'d be ready to move forward with us." Then ask once more, plainly and warmly, whether they would go ahead if the hiring team improves the offer, and record_their_position with their answer.';
        } else if (!committed) {
          state.conditionalYes = false;
          next =
            "They did not say they would go ahead if it improved: keep the improvement. Ask what would make it work for them, sum it up in words (no figures), say the hiring team will come back to them, and use request_human_call with wants_more.";
        } else {
          state.conditionalYes = true;
          // Hand it the exact words: real calls invented their own "improved" figure.
          state.improvedRevealed = true;
          next = `They would go ahead if it improved. Tell them the hiring team has heard them, then call state_offer with which "improved" — or say exactly these words and nothing else about pay: "${offerSentence("improved", figures)}" No other figure exists; any other number ends the call.`;
        }
      } else if (stance === "accepts")
        next = "If they clearly said yes to the figure you just read out, use submit_agreed_terms.";
      else if (stance === "unsure")
        next =
          "Ask what would help them decide — use explain_offer for the parts of the package they are unsure about. If they want time, use request_human_call with needs_time.";
      else if (canMove && state.lastStated === "proposal" && !state.conditionalAsked) {
        state.conditionalAsked = true;
        next =
          'Do not offer anything yet. Explore first: acknowledge their view in words (never their numbers), ask what is behind it (their current package, another offer, what matters most), and use explain_offer to show the whole package and why the team wants them. If they still want more, ask the conditional question in your own words — "If the hiring team could improve the offer, would you be ready to go ahead with us?" — and record_their_position with their answer.';
      } else
        next =
          "You have no other figure. Thank them warmly, sum up in words what would make it work for them, say the hiring team will come back to them, and use request_human_call with wants_more.";
      return { ok: true, next };
    }
    case "explain_offer": {
      const { topic } = parsed.data as { topic: ExplainTopic };
      return { ok: true, say: explainOffer(topic, figures, state.stated.improved) };
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
        next: "Say those words, then record_call_notes for the hiring team, sum up warmly, say goodbye and end_negotiation_call (verbal_agreement).",
      };
    }
    case "request_human_call": {
      const { why, their_words } = parsed.data as {
        why: (typeof HAND_OFF_WHY)[number];
        their_words: string;
      };
      state.handOff = { why, words: their_words };
      return {
        ok: true,
        next:
          state.permission === true
            ? "Now record_call_notes for the hiring team, then sum up warmly, say goodbye and end_negotiation_call (handed_off)."
            : // No go-ahead, so nothing may be noted: just a kind close (a rehearsal went silent here).
              "Tell them kindly that the hiring team will call them, thank them, say goodbye out loud, then end_negotiation_call (handed_off).",
      };
    }
    case "record_call_notes": {
      state.notes = parsed.data as NegotiationCallNotes;
      return { ok: true };
    }
    case "end_negotiation_call": {
      const reason = (parsed.data as { reason: NegotiationEndReason }).reason;
      // Never hang up on them: a goodbye is said out loud first (a rehearsal ended silently).
      if (
        aiSaid !== undefined &&
        !["voicemail", "candidate_left"].includes(reason) &&
        !/\b(good\s?bye|bye|take care)\b/i.test(aiSaid.slice(-300))
      )
        return {
          ok: false,
          error: "Not yet: thank them and say goodbye out loud first, then end the call.",
        };
      // Update the records: a call that talked about the offer leaves notes for the team.
      if (
        state.permission === true &&
        state.stated.proposal &&
        !state.notes &&
        !["opt_out", "wrong_person", "voicemail", "candidate_left"].includes(reason)
      )
        return {
          ok: false,
          error:
            "Not yet: first record_call_notes for the hiring team (how they feel, what matters, their concerns, where it landed), then say goodbye and end.",
        };
      state.endReason = reason;
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
