/**
 * Shared layout for the operational read pages (Agent governance, Agent
 * intelligence, Skill supply vs demand): one verdict line with one-word
 * status pills, then a fix list of only what needs action, each with a
 * next-step link; what passes collapses to a single line.
 */
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

export type Status = "bad" | "warn" | "good" | "none";

export const STATUS: Record<Status, { dot: string; word: string; pill: string }> = {
  bad: { dot: "bg-red-500", word: "act", pill: "border-red-500/30 bg-red-500/10" },
  warn: { dot: "bg-amber-500", word: "watch", pill: "border-amber-500/30 bg-amber-500/10" },
  good: { dot: "bg-emerald-500", word: "ok", pill: "border-border bg-card" },
  none: { dot: "bg-muted-foreground/30", word: "—", pill: "border-border bg-card" },
};

export function Dot({ status, className = "" }: { status: Status; className?: string }) {
  return (
    <span
      className={`inline-block size-2.5 shrink-0 rounded-full ${STATUS[status].dot} ${className}`}
      aria-label={STATUS[status].word}
    />
  );
}

export type Pill = { key: string; label: string; status: Status };

export function Verdict({
  pills,
  active,
  onPick,
  okText = "Nothing needs you",
  neutral = false,
}: {
  pills: Pill[];
  active?: string | null;
  onPick?: (key: string | null) => void;
  okText?: string;
  /** Show okText in grey: there is nothing to judge yet. */
  neutral?: boolean;
}) {
  const need = pills.filter((p) => p.status === "bad").length;
  const watch = pills.filter((p) => p.status === "warn").length;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5 sm:flex-row sm:items-center sm:gap-5">
      <p className="shrink-0 text-lg font-semibold tracking-tight">
        {need > 0 ? (
          <>
            <span className="text-red-600 dark:text-red-400">
              {need} thing{need === 1 ? "" : "s"}
            </span>{" "}
            {need === 1 ? "needs" : "need"} you
          </>
        ) : watch > 0 ? (
          <>
            <span className="text-amber-600 dark:text-amber-400">{watch}</span> to watch
          </>
        ) : neutral || (pills.length > 0 && pills.every((p) => p.status === "none")) ? (
          <span className="text-muted-foreground">{neutral ? okText : "Not enough data yet"}</span>
        ) : (
          <span className="text-emerald-600 dark:text-emerald-400">{okText}</span>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {pills.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onPick?.(active === p.key ? null : p.key)}
            className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-[13px] transition-colors hover:border-foreground/30 ${STATUS[p.status].pill} ${
              active === p.key ? "ring-2 ring-primary/40" : ""
            }`}
          >
            <Dot status={p.status} />
            {p.label}
            <span className="text-muted-foreground">{STATUS[p.status].word}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export type FixRow = {
  severity: "act" | "watch";
  what: string;
  why: string;
  agents: string[];
  next: { label: string; to: string; search?: Record<string, string> | undefined };
};

const nice = (s: string) => s.replace(/_/g, " ");

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded bg-blue-500/10 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
      {children}
    </span>
  );
}

export function FixList({
  rows,
  passing,
  filterLabel,
  onClearFilter,
  subjectHeader = "Agent",
}: {
  rows: FixRow[];
  passing: { count: number; summary: string[] };
  filterLabel?: string | null | undefined;
  onClearFilter?: (() => void) | undefined;
  subjectHeader?: string | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, 8);
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
        <h2 className="text-sm font-semibold">Fix list</h2>
        <span className="text-xs text-muted-foreground">
          {filterLabel ? (
            <>
              Showing {filterLabel} ·{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={onClearFilter}
              >
                show all
              </button>
            </>
          ) : (
            "Only what needs action · most severe first"
          )}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">Nothing needs action.</p>
      ) : (
        <table className="mt-2 w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="w-20 px-4 py-2 font-medium">Severity</th>
              <th className="px-4 py-2 font-medium">What</th>
              <th className="hidden w-40 px-4 py-2 font-medium md:table-cell">{subjectHeader}</th>
              <th className="w-56 px-4 py-2 font-medium">Next step</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="border-b border-border align-top last:border-0">
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                      r.severity === "act"
                        ? "text-red-600 dark:text-red-400"
                        : "text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    <Dot status={r.severity === "act" ? "bad" : "warn"} />
                    {r.severity === "act" ? "Act" : "Watch"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {r.agents.length > 0 && (
                    <span className="mb-1 flex flex-wrap gap-1 md:hidden">
                      {r.agents.slice(0, 3).map((a) => (
                        <Chip key={a}>{nice(a)}</Chip>
                      ))}
                    </span>
                  )}
                  <p className="font-semibold">{r.what}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{r.why}</p>
                </td>
                <td className="hidden px-4 py-3 md:table-cell">
                  <span className="flex flex-wrap gap-1">
                    {r.agents.slice(0, 2).map((a) => (
                      <Chip key={a}>{nice(a)}</Chip>
                    ))}
                    {r.agents.length > 2 && <Chip>+{r.agents.length - 2}</Chip>}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {r.next.to.startsWith("#") ? (
                    <a href={r.next.to} className="font-medium text-primary hover:underline">
                      {r.next.label} →
                    </a>
                  ) : (
                    <Link
                      to={r.next.to as never}
                      search={r.next.search as never}
                      className="font-medium text-primary hover:underline"
                    >
                      {r.next.label} →
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 8 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="w-full border-t border-border px-4 py-2 text-left text-xs font-medium text-primary hover:bg-muted/40"
        >
          {showAll ? "Show fewer" : `Show ${rows.length - 8} more`}
        </button>
      )}
      {passing.count > 0 && (
        <p className="flex items-center gap-2 border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
          <Dot status="good" />
          <b className="font-semibold text-foreground">{passing.count} checks passing</b>
          {passing.summary.length > 0 && <span>· {passing.summary.join(" · ")}</span>}
        </p>
      )}
    </section>
  );
}

export function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint && <span className="text-right text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}
