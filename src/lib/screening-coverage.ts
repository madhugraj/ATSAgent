/**
 * What a phone screen's grade rests on, in words — one wording for the hiring
 * desk, the candidate page and the thread posts (pure; unit-tested).
 */
import type { ScreeningCoverage } from "@db/schema";

/** "2 asked of 4 planned · both answered · 2 not reached on the call". */
export function coverageWords(c: ScreeningCoverage): string {
  // Older runs did not record what was asked.
  if (c.asked == null) return `${c.answered} of ${c.planned} planned questions answered`;
  const skipped = Math.max(0, c.asked - c.answered);
  const unreached = Math.max(0, c.planned - c.asked);
  const parts = [`${c.asked} asked of ${c.planned} planned`];
  parts.push(
    skipped
      ? `${c.answered} answered, ${skipped} skipped by the candidate`
      : c.asked === 1
        ? "answered"
        : c.asked === 2
          ? "both answered"
          : "all answered",
  );
  if (unreached) parts.push(`${unreached} not reached on the call`);
  return parts.join(" · ");
}

/** The questions the call planned but never asked (ids), in plan order. */
export function notReached(c: ScreeningCoverage): string[] {
  if (!c.askedIds) return [];
  const asked = new Set(c.askedIds);
  return (c.plannedIds ?? []).filter((id) => !asked.has(id));
}
