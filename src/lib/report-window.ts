/**
 * The reporting window shared by Agent intelligence, Agent governance and
 * Skill ontology: a period (from/to, inclusive), an optional agent and a
 * voice/text filter. One
 * window drives both what the page shows and what its downloadable report
 * contains, so the two always agree.
 */
import { z } from "zod";

import { modalityFilterSchema, type ModalityFilter } from "./agent-modality";

export const reportWindowSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  agent: z.string().min(1).max(64).nullable().optional(),
  modality: modalityFilterSchema.optional(),
});
export type ReportWindowInput = z.infer<typeof reportWindowSchema>;
export type ReportWindow = {
  from: Date;
  to: Date;
  agent: string | null;
  modality: ModalityFilter;
};

export const DEFAULT_DAYS = 30;

/** Resolve the input to concrete bounds: default last 30 days, `to` = now. */
export function resolveWindow(input: ReportWindowInput | undefined): ReportWindow {
  const to = input?.to ? new Date(input.to) : new Date();
  const from = input?.from ? new Date(input.from) : new Date(to.getTime() - DEFAULT_DAYS * 864e5);
  return { from, to, agent: input?.agent ?? null, modality: input?.modality ?? "all" };
}

export type PeriodKey = "7d" | "30d" | "90d" | "month" | "all" | "custom";
export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "month", label: "This month" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom…" },
];

/** Bounds for a period key (client side); custom uses the given dates (yyyy-mm-dd). */
export function periodBounds(
  key: PeriodKey,
  custom?: { from: string; to: string },
): { from: string; to: string } {
  const now = new Date();
  const days = (n: number) => new Date(now.getTime() - n * 864e5);
  switch (key) {
    case "7d":
      return { from: days(7).toISOString(), to: now.toISOString() };
    case "90d":
      return { from: days(90).toISOString(), to: now.toISOString() };
    case "month":
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        to: now.toISOString(),
      };
    case "all":
      return { from: new Date(2020, 0, 1).toISOString(), to: now.toISOString() };
    case "custom": {
      const f = custom?.from ? new Date(`${custom.from}T00:00:00`) : days(DEFAULT_DAYS);
      const t = custom?.to ? new Date(`${custom.to}T23:59:59.999`) : now;
      return { from: f.toISOString(), to: t.toISOString() };
    }
    default:
      return { from: days(DEFAULT_DAYS).toISOString(), to: now.toISOString() };
  }
}

export function windowLabel(from: string | Date, to: string | Date): string {
  const f = new Date(from),
    t = new Date(to);
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return `${fmt(f)} – ${fmt(t)}`;
}
