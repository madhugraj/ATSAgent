/** Shortlist evaluation (C3): pure scoring of a ranking against ground truth. */

export type EvaluationResult = {
  truth: number;
  found: number;
  atK: { k: number; precision: number; recall: number }[];
  positions: { entry: string; rank: number | null; name: string | null }[];
};

/** Pure: precision/recall at k and each ground-truth person's rank. */
export function evaluateRanking(
  ranked: { name: string; email: string }[],
  entries: string[],
): EvaluationResult {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const positions = entries.map((entry) => {
    const e = norm(entry);
    const i = ranked.findIndex((r) => norm(r.email) === e || norm(r.name) === e);
    return { entry, rank: i >= 0 ? i + 1 : null, name: i >= 0 ? ranked[i]!.name : null };
  });
  const ranks = positions.map((p) => p.rank).filter((r): r is number => r !== null);
  const atK = [5, 10, 20, 50].map((k) => {
    const hit = ranks.filter((r) => r <= k).length;
    return {
      k,
      precision: Math.round((hit / Math.min(k, Math.max(ranked.length, 1))) * 100) / 100,
      recall: Math.round((hit / entries.length) * 100) / 100,
    };
  });
  return { truth: entries.length, found: ranks.length, atK, positions };
}
