/**
 * Weight advice: how the 100 scoring points are split for one role. The model
 * proposes; this pure module makes the proposal safe to apply — six built-in
 * weights plus at most two proposed custom dimensions, whole numbers that
 * always total exactly 100 (unit-tested in scripts/weight-advice.test.ts).
 */

export const WEIGHT_KEYS = [
  "skills",
  "experience",
  "career",
  "impact",
  "education",
  "social",
] as const;
export type WeightKey = (typeof WEIGHT_KEYS)[number];

export type ProposedDimension = { key: string; label: string; hint: string; weight: number };

export type WeightAdvice = Record<WeightKey, number> & {
  rationale: string;
  notes: string[];
  /** Organisation-specific dimensions the advice proposes (0–2); a person adds them. */
  customDimensions: ProposedDimension[];
  /** The knowledge the advice was based on, in plain words. */
  basis: string[];
};

export const MAX_PROPOSED_DIMENSIONS = 2;

const toInt = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function dimensionKey(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "custom"
  );
}

/** Raw model output → advice that validates under `weightsProblem`. */
export function normaliseAdvice(
  raw: Record<string, unknown>,
  basis: string[] = [],
): WeightAdvice {
  const rawDims = Array.isArray(raw["custom_dimensions"]) ? raw["custom_dimensions"] : [];
  const seen = new Set<string>();
  const dims: ProposedDimension[] = [];
  for (const d of rawDims as Record<string, unknown>[]) {
    if (dims.length >= MAX_PROPOSED_DIMENSIONS || !d || typeof d !== "object") continue;
    const label = String(d["label"] ?? "").trim().slice(0, 60);
    const hint = String(d["hint"] ?? "").trim().slice(0, 300);
    const weight = toInt(d["weight"]);
    if (!label || hint.length < 10 || weight === 0) continue;
    let key = dimensionKey(label);
    if (seen.has(key) || (WEIGHT_KEYS as readonly string[]).includes(key)) key = `${key}_2`.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    dims.push({ key, label, hint, weight });
  }

  const builtIn = Object.fromEntries(WEIGHT_KEYS.map((k) => [k, toInt(raw[k])])) as Record<
    WeightKey,
    number
  >;
  const total =
    WEIGHT_KEYS.reduce((s, k) => s + builtIn[k], 0) + dims.reduce((s, d) => s + d.weight, 0);
  if (total === 0) {
    // Nothing usable: fall back to an even-handed split.
    Object.assign(builtIn, { skills: 35, experience: 25, career: 10, impact: 10, education: 10, social: 10 });
    dims.length = 0;
  } else {
    for (const k of WEIGHT_KEYS) builtIn[k] = Math.round((builtIn[k] / total) * 100);
    for (const d of dims) d.weight = Math.max(1, Math.round((d.weight / total) * 100));
  }
  // Push any rounding drift onto the largest built-in bucket so the total is exactly 100.
  const sum =
    WEIGHT_KEYS.reduce((s, k) => s + builtIn[k], 0) + dims.reduce((s, d) => s + d.weight, 0);
  const biggest = WEIGHT_KEYS.reduce((a, b) => (builtIn[a] >= builtIn[b] ? a : b));
  builtIn[biggest] += 100 - sum;

  const notes = Array.isArray(raw["notes"])
    ? (raw["notes"] as unknown[]).map((n) => String(n).slice(0, 300)).slice(0, 5)
    : [];
  return {
    ...builtIn,
    rationale: String(raw["rationale"] ?? "").slice(0, 800),
    notes,
    customDimensions: dims,
    basis,
  };
}
