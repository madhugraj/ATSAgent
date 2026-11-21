/**
 * One competency on a scorecard — its weight, what a 1, 3 and 5 look like in
 * this role, and the 1–5 choice — plus the overall the server will record
 * (weighted average). Shared by My interviews and the private scorecard link
 * so both read the role's rubric the same way.
 */
import { overallRating, weightOf, type AnchorT } from "@/lib/interview-plan";

export type Rubric = {
  weights?: Record<string, number>;
  anchors?: Record<string, AnchorT>;
};

export function CompetencyRating({
  name,
  rubric,
  value,
  onChange,
}: {
  name: string;
  rubric: Rubric;
  value: number;
  onChange: (n: number) => void;
}) {
  const weight = weightOf(rubric, name);
  const a = rubric.anchors?.[name];
  const anchors = a
    ? (
        [
          [1, a.low],
          [3, a.mid],
          [5, a.high],
        ] as const
      ).filter(([, t]) => t)
    : [];
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span>
          {name}
          {weight > 1 ? (
            <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              ×{weight}
            </span>
          ) : null}
        </span>
        <div className="flex gap-1" role="radiogroup" aria-label={name}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              title={anchors.find(([k]) => k === n)?.[1]}
              className={`h-7 w-7 rounded border text-xs ${value === n ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
              onClick={() => onChange(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      {anchors.length ? (
        <dl className="grid gap-0.5 text-xs text-muted-foreground">
          {anchors.map(([k, t]) => (
            <div key={k} className={`flex gap-2 ${value === k ? "text-foreground" : ""}`}>
              <dt className="w-3 shrink-0 font-medium">{k}</dt>
              <dd>{t}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/** The overall the server will record: weighted average of what is rated so far. */
export function OverallReadout({
  ratings,
  rubric,
}: {
  ratings: Record<string, number>;
  rubric: Rubric;
}) {
  const rated = Object.entries(ratings)
    .filter(([, v]) => v > 0)
    .map(([name, rating]) => ({ name, rating }));
  return (
    <div className="flex items-center justify-between border-t border-border pt-2 text-sm font-medium">
      <span>Overall</span>
      <span aria-live="polite">{rated.length ? overallRating(rated, rubric) : "—"}</span>
    </div>
  );
}
