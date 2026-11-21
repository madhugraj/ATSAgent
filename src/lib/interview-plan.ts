/**
 * A role's interview plan (client-safe): how many rounds, what each round is
 * for, the competencies interviewers rate (built from the role's must-haves so
 * scores line up across interviewers), how many people sit on each panel, and
 * what an interviewer's verdict does.
 *
 * verdictPolicy:
 * - "recommend" (default): a round advances only when every panel member
 *   selects; a hold or reject is a recommendation the hiring manager decides.
 * - "immediate": the round's verdict moves the candidate at once (the
 *   earlier behaviour) — select only when everyone selects, otherwise the
 *   most cautious verdict (reject over hold).
 * The hiring decision itself (select → offer) always comes after the final
 * round, from the hiring manager.
 *
 * Rubric (per round, keyed by competency name so every reader of the plain
 * `competencies` list keeps working):
 * - weights: how much each competency counts toward the overall (×1–×5,
 *   or a percent split from an approved panel change; default 1 = all equal). The overall is always the weighted average of
 *   the competency ratings, computed on the server (`overallRating`).
 * - anchors: what a 1, a 3 and a 5 look like for that competency in this
 *   role, shown on the scorecard so interviewers read the scale the same way.
 */
import { z } from "zod";

export const Anchor = z.object({
  low: z.string().trim().max(200).default(""),
  mid: z.string().trim().max(200).default(""),
  high: z.string().trim().max(200).default(""),
});

export const PlanRound = z.object({
  level: z.number().int().min(1).max(3),
  name: z.string().trim().min(2).max(60),
  focus: z.string().trim().max(300).default(""),
  competencies: z.array(z.string().trim().min(2).max(60)).min(1).max(8),
  panelSize: z.number().int().min(1).max(3).default(1),
  /**
   * Competency → weight; missing = 1. The hiring team picks ×1–×5; a panel
   * change approved by the hiring manager stores the split in percent (1–100).
   * Only the ratios count.
   */
  weights: z.record(z.string(), z.number().int().min(1).max(100)).optional(),
  /** Competency → what a 1, 3 and 5 look like in this role. */
  anchors: z.record(z.string(), Anchor).optional(),
});

export const InterviewPlanSchema = z
  .object({
    rounds: z.array(PlanRound).min(1).max(3),
    verdictPolicy: z.enum(["recommend", "immediate"]).default("recommend"),
  })
  .refine((p) => p.rounds.every((r, i) => r.level === i + 1), {
    message: "Rounds must be numbered 1, 2, 3 in order.",
  });

export type InterviewPlan = z.infer<typeof InterviewPlanSchema>;
export type PlanRoundT = z.infer<typeof PlanRound>;
export type AnchorT = z.infer<typeof Anchor>;

/**
 * Drop weights and anchors for competencies the round no longer lists, and
 * empty anchors, so a renamed or removed competency leaves nothing behind.
 */
export function pruneRubric(plan: InterviewPlan): InterviewPlan {
  return {
    ...plan,
    rounds: plan.rounds.map((r) => {
      const keep = new Set(r.competencies);
      const weights = Object.fromEntries(
        Object.entries(r.weights ?? {}).filter(([k, w]) => keep.has(k) && w > 1),
      );
      const anchors = Object.fromEntries(
        Object.entries(r.anchors ?? {}).filter(
          ([k, a]) => keep.has(k) && (a.low || a.mid || a.high),
        ),
      );
      const { weights: _w, anchors: _a, ...rest } = r;
      return {
        ...rest,
        ...(Object.keys(weights).length ? { weights } : {}),
        ...(Object.keys(anchors).length ? { anchors } : {}),
      };
    }),
  };
}

/** A competency's weight in a round: 1 unless the plan says otherwise. */
export function weightOf(round: Pick<PlanRoundT, "weights"> | null | undefined, name: string) {
  const w = round?.weights?.[name];
  return typeof w === "number" && w >= 1 ? w : 1;
}

/**
 * The scorecard's overall rating: the weighted average of the competency
 * ratings, rounded to the 1–5 scale. One rule for every way of scoring.
 */
export function overallRating(
  ratings: { name: string; rating: number }[],
  round: Pick<PlanRoundT, "weights"> | null | undefined,
): number {
  let sum = 0;
  let total = 0;
  for (const r of ratings) {
    const w = weightOf(round, r.name);
    sum += r.rating * w;
    total += w;
  }
  if (!total) throw new Error("Rate at least one competency.");
  return Math.max(1, Math.min(5, Math.round(sum / total)));
}

const uniq = (xs: string[]) =>
  xs.filter((x, i) => xs.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);

/** At least three competencies a round: the role's own first, generic ones only to fill. */
const MIN_COMPETENCIES = 3;
function topUp(own: string[], generic: string[]) {
  const out = uniq(own);
  for (const g of generic) if (out.length < MIN_COMPETENCIES) out.push(g);
  return uniq(out).slice(0, 6);
}

/**
 * The default plan for a role: rounds and rubric from its own must-haves.
 * Generic competencies only fill a round the role's skills leave short; the
 * L3 round is a starting suggestion the hiring plan confirmation lets a
 * person change before the role opens.
 */
export function defaultPlan(mustHave: string[] | null | undefined): InterviewPlan {
  const skills = uniq((mustHave ?? []).map((s) => s.trim()).filter((s) => s.length >= 2));
  const first = skills.slice(0, 4);
  const rest = skills.slice(4, 7);
  return {
    verdictPolicy: "recommend",
    rounds: [
      {
        level: 1,
        name: "Skills",
        focus: first.length
          ? `Depth in ${first.join(", ")} — ask for real work they did, not definitions.`
          : "Core skills for the role — ask for real work they did.",
        competencies: topUp(first, ["Problem solving"]),
        panelSize: 1,
      },
      {
        level: 2,
        name: "Role and ownership",
        focus: rest.length
          ? `${rest.join(", ")}, and how they own outcomes and work with others.`
          : "How they own outcomes, handle trade-offs and work with others.",
        competencies: topUp(rest, ["Ownership", "Collaboration", "Communication"]),
        panelSize: 1,
      },
      {
        level: 3,
        name: "Fit and growth",
        focus: "Judgement, motivation and how they will grow in the team.",
        competencies: ["Judgement", "Motivation", "Growth potential", "Team fit"],
        panelSize: 1,
      },
    ],
  };
}

export function finalLevel(plan: InterviewPlan): number {
  return plan.rounds.length;
}

export function roundOf(plan: InterviewPlan, level: number): PlanRoundT | null {
  return plan.rounds.find((r) => r.level === level) ?? null;
}

export type Verdict = "select" | "hold" | "reject";

/** The round's combined verdict: select only if everyone selects; else the most cautious. */
export function roundVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.includes("reject")) return "reject";
  if (verdicts.includes("hold")) return "hold";
  return "select";
}

/* ------------------------------------------- a panelist's proposed change */

/** How far a panelist may move any existing competency's share of the overall. */
export const PANEL_SHARE_LIMIT = 0.1;

/** The AI's review of a proposed change (stored; shown to the approver). */
export const PlanReviewSchema = z.object({
  verdict: z.enum(["fits", "concerns"]).catch("concerns"),
  summary: z
    .string()
    .trim()
    .transform((t) => t.slice(0, 600)),
  findings: z
    .array(
      z.object({
        kind: z.enum(["coverage", "relevance", "fairness", "clarity"]).catch("relevance"),
        text: z
          .string()
          .trim()
          .transform((t) => t.slice(0, 300)),
      }),
    )
    .default([])
    .transform((f) => f.slice(0, 8)),
});
export type PlanReview = z.infer<typeof PlanReviewSchema>;

const norm = (s: string) => s.trim().toLowerCase();

/** The round's competencies that come from the role's must-haves: these stay. */
export function lockedCompetencies(round: PlanRoundT, mustHave: string[] | null | undefined) {
  const must = new Set((mustHave ?? []).map(norm));
  return round.competencies.filter((c) => must.has(norm(c)));
}

/** Each competency's share of the overall (pure). */
export function sharesOf(round: Pick<PlanRoundT, "competencies" | "weights">) {
  const total = round.competencies.reduce((s, c) => s + weightOf(round, c), 0) || 1;
  return Object.fromEntries(round.competencies.map((c) => [norm(c), weightOf(round, c) / total]));
}

/**
 * Shares before the change among the competencies that stay (pure): dropping
 * one spreads its share over the rest in proportion, so that alone moves
 * nothing.
 */
export function keptShares(
  before: Pick<PlanRoundT, "competencies" | "weights">,
  proposed: Pick<PlanRoundT, "competencies">,
): Record<string, number> {
  const now = new Set(proposed.competencies.map(norm));
  const kept = before.competencies.filter((c) => now.has(norm(c)));
  return sharesOf({ competencies: kept, weights: before.weights });
}

/**
 * The competencies a panelist's split moves too far (pure). Each one that
 * stays is judged by its share among the competencies that stay, before and
 * after, so dropping one or adding new ones alone moves nothing; a move of
 * more than PANEL_SHARE_LIMIT is too far.
 */
export function movedTooFar(
  before: Pick<PlanRoundT, "competencies" | "weights">,
  proposed: Pick<PlanRoundT, "competencies" | "weights">,
): { name: string; was: number; is: number }[] {
  const was = keptShares(before, proposed);
  const keptNow = proposed.competencies.filter((c) => norm(c) in was);
  const is = sharesOf({ competencies: keptNow, weights: proposed.weights });
  return keptNow
    .filter((c) => Math.abs((is[norm(c)] ?? 0) - (was[norm(c)] ?? 0)) > PANEL_SHARE_LIMIT + 1e-9)
    .map((c) => ({ name: c, was: was[norm(c)] ?? 0, is: is[norm(c)] ?? 0 }));
}

/** Competencies that would outweigh one of the role's must-haves (pure). */
export function outweighMustHaves(
  proposed: Pick<PlanRoundT, "competencies" | "weights">,
  mustHave: string[] | null | undefined,
): string[] {
  const must = new Set((mustHave ?? []).map(norm));
  const musts = proposed.competencies.filter((c) => must.has(norm(c)));
  if (!musts.length) return [];
  const floor = Math.min(...musts.map((c) => weightOf(proposed, c)));
  return proposed.competencies.filter((c) => !must.has(norm(c)) && weightOf(proposed, c) > floor);
}

/**
 * What a panelist's change breaks (pure; empty = within the rules). The level,
 * name and panel size are the hiring team's and are kept by the caller; the
 * role's must-haves stay on the scorecard and nothing else outweighs them,
 * and no competency that stays moves by more than PANEL_SHARE_LIMIT among
 * the competencies that stay.
 */
export function panelChangeViolations(
  before: PlanRoundT,
  proposed: Pick<PlanRoundT, "competencies" | "weights">,
  mustHave: string[] | null | undefined,
): string[] {
  const out: string[] = [];
  const now = new Set(proposed.competencies.map(norm));
  for (const c of lockedCompetencies(before, mustHave))
    if (!now.has(norm(c)))
      out.push(`"${c}" is a must-have for the role and stays on the scorecard.`);
  for (const m of movedTooFar(before, proposed))
    out.push(
      `"${m.name}" would move from ${Math.round(m.was * 100)}% to ${Math.round(m.is * 100)}% of the original competencies; a panel change can move it by ${PANEL_SHARE_LIMIT * 100} points at most.`,
    );
  for (const c of outweighMustHaves(proposed, mustHave))
    out.push(`"${c}" would weigh more than one of the role's must-haves.`);
  if (!proposed.competencies.length) out.push("Keep at least one competency.");
  return out;
}

/** Whole percents that add up to 100 (pure; largest remainder). */
export function percentSplit(shares: Record<string, number>): Record<string, number> {
  const keys = Object.keys(shares);
  const raw = keys.map((k) => (shares[k] ?? 0) * 100);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return Object.fromEntries(keys.map((k, i) => [k, out[i]!]));
}
