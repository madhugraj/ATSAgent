/**
 * The silent panel agent's view of an interview call, in pure code
 * (docs/silent-panel-agent-plan.md, S2): the shapes it is stored in, the
 * schemas the model's JSON must match, and the checks the system makes on it.
 * The model reads the transcript; the system decides what is kept:
 *
 *   - evidence quotes are kept only if they are really in the transcript;
 *   - competencies are only the round's own;
 *   - talk-time share and the panel's questions are counted in code;
 *   - the panel's summary never carries a score, verdict or recommendation.
 */
import { z } from "zod";

import type { TranscriptSegment } from "./vtt";

export const PROTECTED_TOPICS = [
  "age",
  "marital_status",
  "family_plans",
  "pregnancy",
  "religion",
  "caste",
  "health",
  "disability",
  "nationality",
  "politics",
  "sexual_orientation",
  "gender",
  "other",
] as const;

const verdict = z.enum(["select", "hold", "reject"]);
const short = (n: number) => z.string().trim().min(1).max(n);

/** What the model returns for the assessment (feature panel_assess). */
export const AssessOutput = z.object({
  candidate_speaker: z.string().trim().max(120).nullable(),
  rating: z.number().int().min(1).max(5),
  verdict,
  competencies: z
    .array(
      z.object({
        name: short(120),
        /** null: the call did not cover it. */
        rating: z.number().int().min(1).max(5).nullable(),
        evidence: z.array(short(300)).max(3),
        note: short(400).nullable(),
      }),
    )
    .max(15),
  strengths: z.array(short(300)).max(5),
  gaps: z.array(short(300)).max(5),
  open_questions: z.array(short(300)).max(5),
  panel: z.object({
    covered: z.array(short(120)).max(15),
    missed: z.array(short(120)).max(15),
    off_limits: z.array(z.object({ quote: short(300), topic: z.enum(PROTECTED_TOPICS) })).max(10),
    notes: short(600).nullable(),
  }),
  suspected_prompt_injection: z.boolean(),
});
export type AssessOutput = z.infer<typeof AssessOutput>;

/** What the model returns for the panel's factual summary (feature panel_summary). */
export const SummaryOutput = z.object({
  overview: short(800),
  topics: z
    .array(z.object({ topic: short(120), asked: short(500), answered: short(800) }))
    .min(1)
    .max(10),
  suspected_prompt_injection: z.boolean(),
});
export type SummaryOutput = z.infer<typeof SummaryOutput>;

export type CandidateView = {
  competencies: {
    name: string;
    rating: number | null;
    evidence: string[];
    note: string | null;
  }[];
  strengths: string[];
  gaps: string[];
  openQuestions: string[];
};

export type PanelView = {
  covered: string[];
  missed: string[];
  /** Share of speaking time (0–1), null when the candidate's voice is not known. */
  candidateTalkShare: number | null;
  panelTalkShare: number | null;
  panelQuestions: number | null;
  offLimits: { quote: string; topic: (typeof PROTECTED_TOPICS)[number] }[];
  notes: string | null;
  /** The speaker label taken to be the candidate, when one was. */
  candidateSpeaker: string | null;
  minutes: number;
};

/* ------------------------------------------------------------ transcript */

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** One line per turn: `[mm:ss] Speaker: text` — what the model reads (inside untrusted()). */
export function formatTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => `[${mmss(s.startMs)}] ${s.speaker ?? "Unknown speaker"}: ${s.text}`)
    .join("\n");
}

export function speakersOf(segments: TranscriptSegment[]): string[] {
  return [...new Set(segments.map((s) => s.speaker).filter((x): x is string => Boolean(x)))];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * The speaker who is the candidate: the label the model named, when it is
 * really one of the transcript's speakers; else a label sharing a word of the
 * candidate's name. null when neither — talk time is then not counted.
 */
export function candidateSpeakerOf(
  segments: TranscriptSegment[],
  named: string | null,
  candidateName: string,
): string | null {
  const speakers = speakersOf(segments);
  const exact = named ? speakers.find((s) => norm(s) === norm(named)) : undefined;
  if (exact) return exact;
  const words = norm(candidateName)
    .split(" ")
    .filter((w) => w.length > 2);
  return (
    speakers.find((s) =>
      norm(s)
        .split(" ")
        .some((w) => words.includes(w)),
    ) ?? null
  );
}

/** Speaking-time shares and the panel's questions, counted from the transcript. */
export function talkStats(segments: TranscriptSegment[], candidateSpeaker: string | null) {
  const length = (s: TranscriptSegment) =>
    s.endMs > s.startMs ? s.endMs - s.startMs : s.text.split(/\s+/).length * 400;
  const total = segments.reduce((n, s) => n + length(s), 0);
  const last = segments[segments.length - 1];
  const minutes = Math.round((last?.endMs ?? 0) / 60_000);
  if (!candidateSpeaker || !total)
    return { candidateTalkShare: null, panelTalkShare: null, panelQuestions: null, minutes };
  const mine = segments.filter((s) => s.speaker === candidateSpeaker);
  const theirs = segments.filter((s) => s.speaker !== candidateSpeaker);
  const share = (xs: TranscriptSegment[]) =>
    Math.round((xs.reduce((n, s) => n + length(s), 0) / total) * 100) / 100;
  return {
    candidateTalkShare: share(mine),
    panelTalkShare: share(theirs),
    panelQuestions: theirs.reduce((n, s) => n + (s.text.match(/\?/g)?.length ?? 0), 0),
    minutes,
  };
}

/** Only quotes that are really in the transcript (ignoring case and punctuation). */
export function keepQuotes(quotes: string[], transcript: string): string[] {
  const body = norm(transcript);
  return quotes.filter((q) => {
    const n = norm(q);
    return n.length >= 8 && body.includes(n);
  });
}

/* ------------------------------------------------------------- the view */

/**
 * The stored view from the model's output: competencies limited to the
 * round's, evidence and off-limits quotes checked against the transcript,
 * talk time counted in code.
 */
export function buildAssessment(
  out: AssessOutput,
  segments: TranscriptSegment[],
  roundCompetencies: string[],
  candidateName: string,
): {
  rating: number;
  verdict: AssessOutput["verdict"];
  candidate: CandidateView;
  panel: PanelView;
  injectionSuspected: boolean;
} {
  const transcript = segments.map((s) => s.text).join("\n");
  const allowed = new Map(roundCompetencies.map((c) => [norm(c), c]));
  const own = (name: string) => (allowed.size ? allowed.get(norm(name)) : name);
  const candidateSpeaker = candidateSpeakerOf(segments, out.candidate_speaker, candidateName);
  const offLimits = out.panel.off_limits.filter((o) => keepQuotes([o.quote], transcript).length);
  return {
    rating: out.rating,
    verdict: out.verdict,
    candidate: {
      competencies: out.competencies
        .map((c) => ({ ...c, name: own(c.name) }))
        .filter((c): c is typeof c & { name: string } => Boolean(c.name))
        .map((c) => ({
          name: c.name,
          rating: c.rating,
          evidence: keepQuotes(c.evidence, transcript),
          note: c.note,
        })),
      strengths: out.strengths,
      gaps: out.gaps,
      openQuestions: out.open_questions,
    },
    panel: {
      covered: out.panel.covered.map(own).filter((x): x is string => Boolean(x)),
      missed: out.panel.missed.map(own).filter((x): x is string => Boolean(x)),
      offLimits,
      notes: out.panel.notes,
      candidateSpeaker,
      ...talkStats(segments, candidateSpeaker),
    },
    injectionSuspected: out.suspected_prompt_injection,
  };
}

/* -------------------------------------------------------------- summary */

/** Words that would carry a judgement into the panel's factual summary. */
const JUDGEMENT =
  /\b(scores?|scored|rating|rated|recommend\w*|verdict|reject\w*|shortlist\w*|hire|hiring decision|strong(est)? candidate|weak(est)? candidate|out of (five|5))\b|\b\d\s*\/\s*5\b/i;

/**
 * The summary the panel receives: sentences that carry a judgement are
 * dropped, so it can never anchor the panel before they score.
 */
export function scrubSummary(s: SummaryOutput): SummaryOutput {
  const clean = (text: string) =>
    text
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !JUDGEMENT.test(sentence))
      .join(" ")
      .trim();
  return {
    ...s,
    overview: clean(s.overview),
    topics: s.topics
      .map((t) => ({ topic: t.topic, asked: clean(t.asked), answered: clean(t.answered) }))
      .filter((t) => t.asked || t.answered),
  };
}
