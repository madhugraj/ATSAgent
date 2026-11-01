/**
 * The silent panel agent's view against the panel's, once every panellist has
 * scored (docs/silent-panel-agent-plan.md, S3). A fixed rule in code — never
 * the model — so the same scores always give the same answer:
 *
 *   agree     same verdict and ratings within 1
 *   disagree  select against reject, or ratings 3 or more apart
 *   partial   everything else (e.g. select against hold, or 2 apart)
 *
 * The panel's rating is the average of its panellists' ratings; its verdict is
 * the round's verdict (the most cautious one, as the round already uses).
 */
import type { Verdict } from "./interview-plan";

export type Outcome = "agree" | "partial" | "disagree";

export const RECONCILE_DEFAULTS = { agreeWithin: 1, disagreeFrom: 3 } as const;

export function panelRatingOf(ratings: (number | null | undefined)[]): number | null {
  const xs = ratings.filter((r): r is number => typeof r === "number");
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
}

const opposite = (a: Verdict, b: Verdict) =>
  (a === "select" && b === "reject") || (a === "reject" && b === "select");

export function reconcile(
  panel: { rating: number | null; verdict: Verdict },
  agent: { rating: number; verdict: Verdict },
  t: { agreeWithin: number; disagreeFrom: number } = RECONCILE_DEFAULTS,
): Outcome {
  const gap = panel.rating == null ? null : Math.abs(panel.rating - agent.rating);
  if (opposite(panel.verdict, agent.verdict) || (gap != null && gap >= t.disagreeFrom))
    return "disagree";
  if (panel.verdict === agent.verdict && (gap == null || gap <= t.agreeWithin)) return "agree";
  return "partial";
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  agree: "agrees with the panel",
  partial: "partly agrees with the panel",
  disagree: "disagrees with the panel",
};
