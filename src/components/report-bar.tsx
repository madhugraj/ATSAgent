/**
 * Period + agent selector and the PDF / Excel download buttons shared by
 * Agent intelligence, Agent governance and Skill ontology. The chosen window
 * drives both the page and its report, so they always agree.
 */
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PERIODS, periodBounds, windowLabel, type PeriodKey } from "@/lib/report-window";

export type ReportKind = "pdf" | "xlsx";
export type Window = { from: string; to: string; agent: string | null };

export function useReportWindow({ withAgent }: { withAgent: boolean }) {
  const [period, setPeriodKey] = useState<PeriodKey>("30d");
  const [custom, setCustom] = useState(() => {
    const t = new Date();
    const f = new Date(t.getTime() - 30 * 864e5);
    return { from: f.toISOString().slice(0, 10), to: t.toISOString().slice(0, 10) };
  });
  // bounds are frozen when the period changes, so the query key is stable between renders
  const [bounds, setBounds] = useState(() => periodBounds("30d"));
  const [agent, setAgent] = useState<string | null>(null);
  const setPeriod = (k: PeriodKey) => {
    setPeriodKey(k);
    setBounds(periodBounds(k, custom));
  };
  const setCustomDates = (c: { from: string; to: string }) => {
    setCustom(c);
    if (c.from && c.to && c.from <= c.to) setBounds(periodBounds("custom", c));
  };
  const window: Window = { ...bounds, agent: withAgent ? agent : null };
  return {
    period,
    setPeriod,
    custom,
    setCustomDates,
    agent,
    setAgent,
    withAgent,
    window,
    label: windowLabel(bounds.from, bounds.to),
  };
}
export type ReportWindowState = ReturnType<typeof useReportWindow>;

const nice = (s: string) => s.replace(/_/g, " ");
const selectCls =
  "h-8 rounded-md border border-border bg-card px-2 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30";

export function ReportBar({
  rw,
  agents = [],
  onDownload,
  disabled,
}: {
  rw: ReportWindowState;
  agents?: string[];
  onDownload: (kind: ReportKind) => void | Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<ReportKind | null>(null);
  const run = async (kind: ReportKind) => {
    setBusy(kind);
    try {
      await onDownload(kind);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Period"
        className={selectCls}
        value={rw.period}
        onChange={(e) => rw.setPeriod(e.target.value as PeriodKey)}
      >
        {PERIODS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
      {rw.period === "custom" && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="date"
            aria-label="From"
            className={selectCls}
            value={rw.custom.from}
            max={rw.custom.to}
            onChange={(e) => rw.setCustomDates({ ...rw.custom, from: e.target.value })}
          />
          to
          <input
            type="date"
            aria-label="To"
            className={selectCls}
            value={rw.custom.to}
            min={rw.custom.from}
            onChange={(e) => rw.setCustomDates({ ...rw.custom, to: e.target.value })}
          />
        </span>
      )}
      {rw.withAgent && (
        <select
          aria-label="Agent"
          className={selectCls}
          value={rw.agent ?? ""}
          onChange={(e) => rw.setAgent(e.target.value || null)}
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {nice(a)}
            </option>
          ))}
        </select>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || busy !== null}
        onClick={() => run("pdf")}
      >
        {busy === "pdf" ? (
          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
        ) : (
          <Download className="mr-1.5 size-3.5" />
        )}
        PDF
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || busy !== null}
        onClick={() => run("xlsx")}
      >
        {busy === "xlsx" ? (
          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
        ) : (
          <Download className="mr-1.5 size-3.5" />
        )}
        Excel
      </Button>
    </div>
  );
}
