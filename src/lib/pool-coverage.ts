/**
 * Talent-pool coverage: for each open requisition and each role in the
 * organisation's ontology, how many people already in the pool fit it
 * against how many are needed. Deterministic — no AI in the numbers; the
 * copilot only explains them.
 *
 * A person fits strongly when they cover 80%+ of the must-have skills, partly
 * at 50–79%. Coverage = strong fits per opening: green at 3+, amber at 1–3,
 * red below 1. A profile is fresh when it was created or synced within a year.
 */
export type PoolPerson = {
  id: string;
  skills: string[];
  isInternal: boolean;
  /** Last time the profile was created or synced. */
  seenAt: Date;
};

export type CoverageDemand = {
  key: string;
  kind: "requisition" | "role";
  label: string;
  skills: string[];
  /** Openings (requisition) or requisitions raised (role). */
  demand: number;
};

export type CoverageStatus = "green" | "amber" | "red";

export type CoverageRow = {
  key: string;
  kind: "requisition" | "role";
  label: string;
  demand: number;
  strong: number;
  partial: number;
  internal: number;
  /** Share of the strong and partial fits whose profile is fresh. */
  freshShare: number;
  /** Strong fits per unit of demand. */
  ratio: number;
  status: CoverageStatus;
  /** Must-have skills nobody (or almost nobody) in the pool has. */
  missingSkills: string[];
};

export const COVERAGE = { strong: 0.8, partial: 0.5, green: 3, amber: 1, freshDays: 365 };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .trim();

/** Whether a person's skill satisfies a wanted skill (either contains the other). */
export function skillMatches(have: string, want: string): boolean {
  const h = norm(have);
  const w = norm(want);
  if (!h || !w) return false;
  if (h === w) return true;
  // short tokens ("c", "r", "go") must match whole words
  if (w.length <= 2 || h.length <= 2) return h.split(" ").includes(w) || w.split(" ").includes(h);
  return h.includes(w) || w.includes(h);
}

export function statusOf(ratio: number): CoverageStatus {
  return ratio >= COVERAGE.green ? "green" : ratio >= COVERAGE.amber ? "amber" : "red";
}

export function computeCoverage(
  demands: CoverageDemand[],
  pool: PoolPerson[],
  now = new Date(),
): CoverageRow[] {
  const freshSince = now.getTime() - COVERAGE.freshDays * 86_400_000;
  return demands
    .filter((d) => d.skills.length > 0)
    .map((d) => {
      const skills = [...new Set(d.skills.map((s) => s.trim()).filter(Boolean))].slice(0, 15);
      const holders = new Map<string, number>(skills.map((s) => [s, 0]));
      let strong = 0;
      let partial = 0;
      let internal = 0;
      let fresh = 0;
      for (const p of pool) {
        let hits = 0;
        for (const want of skills) {
          if (p.skills.some((have) => skillMatches(have, want))) {
            hits++;
            holders.set(want, (holders.get(want) ?? 0) + 1);
          }
        }
        const cov = hits / skills.length;
        if (cov < COVERAGE.partial) continue;
        if (cov >= COVERAGE.strong) strong++;
        else partial++;
        if (p.isInternal) internal++;
        if (p.seenAt.getTime() >= freshSince) fresh++;
      }
      const demand = Math.max(d.demand, 1);
      const ratio = Math.round((strong / demand) * 10) / 10;
      const fits = strong + partial;
      return {
        key: d.key,
        kind: d.kind,
        label: d.label,
        demand: d.demand,
        strong,
        partial,
        internal,
        freshShare: fits ? Math.round((fresh / fits) * 100) / 100 : 0,
        ratio,
        status: statusOf(ratio),
        missingSkills: skills.filter((s) => (holders.get(s) ?? 0) <= 1),
      };
    })
    .sort((a, b) => a.ratio - b.ratio || b.demand - a.demand);
}

/** Organisation-wide summary of coverage rows. */
export function summariseCoverage(rows: CoverageRow[]) {
  const count = (s: CoverageStatus) => rows.filter((r) => r.status === s).length;
  const gaps = new Map<string, number>();
  for (const r of rows) for (const s of r.missingSkills) gaps.set(s, (gaps.get(s) ?? 0) + 1);
  return {
    green: count("green"),
    amber: count("amber"),
    red: count("red"),
    topSkillGaps: [...gaps.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([skill, roles]) => ({ skill, roles })),
  };
}
