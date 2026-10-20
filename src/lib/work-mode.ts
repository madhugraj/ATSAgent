/** Where the work happens (migration 0041). */
export const WORK_MODES = ["onsite", "hybrid", "remote"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const WORK_MODE_LABEL: Record<WorkMode, string> = {
  onsite: "Onsite",
  hybrid: "Hybrid",
  remote: "Remote",
};

/** "Chennai (Hybrid)", "Remote", "Chennai" — the location as candidates read it (pure). */
export function placeLabel(
  location: string | null | undefined,
  mode: string | null | undefined,
): string {
  const loc = (location ?? "").trim();
  const m = mode && mode in WORK_MODE_LABEL ? WORK_MODE_LABEL[mode as WorkMode] : null;
  if (!m) return loc;
  if (!loc) return m;
  if (loc.toLowerCase().includes(m.toLowerCase())) return loc;
  return `${loc} (${m})`;
}
