/**
 * Hiring oversight section for the HR dashboard: three plain answers on
 * whether people are really deciding on agent proposals, a weekly decisions
 * chart, who moves candidates between stages, disagreements with reasons and
 * cards waiting too long.
 */
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { hiringOversight, type Oversight, type Tone } from "@/lib/hiring-oversight.functions";

export function HiringOversightSection() {
  const q = useQuery({
    queryKey: ["hiring-oversight"],
    queryFn: () => hiringOversight(),
    staleTime: 60_000,
  });
  if (!q.data) return null;
  return (
    <section className="border-b border-border p-5 sm:p-7">
      <div className="mb-4">
        <h2 className="font-semibold tracking-tight">Oversight of agent proposals</h2>
        <p className="text-sm text-muted-foreground">
          Are your people really deciding what the agents propose — and is anything skipping them?
        </p>
      </div>
      <OversightPanel o={q.data} />
    </section>
  );
}

const TONE: Record<Tone, { dot: string; ring: string; word: string }> = {
  good: { dot: "bg-emerald-500", ring: "border-emerald-500/30", word: "OK" },
  warn: { dot: "bg-amber-500", ring: "border-amber-500/40", word: "Watch" },
  bad: { dot: "bg-red-500", ring: "border-red-500/40", word: "Act" },
};
const QUESTIONS = [
  "Are people really deciding?",
  "Where do people disagree?",
  "Is anything skipping a person?",
];
const stageWord = (s: string) => s.replace(/_/g, " ");

function OversightPanel({ o }: { o: Oversight }) {
  const peak = Math.max(1, ...o.weekly.map((w) => w.approved + w.declined));
  const movePeak = Math.max(1, ...o.stageMoves.map((m) => m.agent + m.person));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {o.headline.map((h, i) => (
          <div key={i} className={`rounded-lg border bg-card p-4 ${TONE[h.tone].ring}`}>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {QUESTIONS[i]}
            </p>
            <p className="mt-2 flex items-center gap-2 text-base font-semibold">
              <span
                className={`inline-block size-2.5 rounded-full ${TONE[h.tone].dot}`}
                aria-label={TONE[h.tone].word}
              />
              {h.title}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{h.detail}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Decisions per week</h3>
          <p className="text-xs text-muted-foreground">
            A rising red share means agents and your people are drifting apart; all green for weeks
            may mean rubber-stamping.
          </p>
          <div className="mt-4 flex h-36 items-end gap-2">
            {o.weekly.map((w) => (
              <div
                key={w.week}
                className="flex flex-1 flex-col items-center gap-1"
                title={`Week of ${w.week}: ${w.approved} approved, ${w.declined} declined`}
              >
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {w.approved + w.declined || ""}
                </span>
                <div
                  className="flex w-full max-w-8 flex-col-reverse overflow-hidden rounded-sm"
                  style={{ height: `${((w.approved + w.declined) / peak) * 100}px` }}
                >
                  <div
                    className="bg-emerald-500/80"
                    style={{
                      height: `${(w.approved / Math.max(w.approved + w.declined, 1)) * 100}%`,
                    }}
                  />
                  <div
                    className="bg-red-500/80"
                    style={{
                      height: `${(w.declined / Math.max(w.approved + w.declined, 1)) * 100}%`,
                    }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(w.week).toLocaleDateString([], { day: "numeric", month: "short" })}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-4 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-emerald-500/80" />
              approved
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-red-500/80" />
              declined
            </span>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Who moves candidates between stages</h3>
          <p className="text-xs text-muted-foreground">
            Stages that only an agent ever moves candidates into have no person in the loop.
          </p>
          {o.stageMoves.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No stage moves recorded yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {o.stageMoves.map((m) => (
                <li
                  key={m.stage}
                  className="grid grid-cols-[120px_1fr_auto] items-center gap-2 text-xs"
                >
                  <span className="truncate capitalize">{stageWord(m.stage)}</span>
                  <div className="flex h-3 overflow-hidden rounded-sm bg-muted">
                    <div
                      className="bg-blue-500/80"
                      style={{ width: `${(m.agent / movePeak) * 100}%` }}
                    />
                    <div
                      className="bg-slate-400/80"
                      style={{ width: `${(m.person / movePeak) * 100}%` }}
                    />
                  </div>
                  <span
                    className={`tabular-nums ${m.person === 0 ? "font-semibold text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
                  >
                    {m.agent} agent · {m.person} person
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-4 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-blue-500/80" />
              by an agent
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-slate-400/80" />
              by a person
            </span>
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Where people disagree with agents</h3>
          <p className="text-xs text-muted-foreground">
            The proposals people declined, and the reasons they gave — this is what to retune.
          </p>
        </div>
        {o.disagreements.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">No proposal has been declined.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">Proposal</th>
                <th className="px-4 py-2 font-medium">Declined</th>
                <th className="px-4 py-2 font-medium">Reasons given</th>
              </tr>
            </thead>
            <tbody>
              {o.disagreements.map((d) => (
                <tr
                  key={`${d.agent}-${d.proposal}`}
                  className="border-b border-border align-top last:border-0"
                >
                  <td className="px-4 py-2 font-medium capitalize">{stageWord(d.agent)}</td>
                  <td className="px-4 py-2">{d.proposal}</td>
                  <td className="px-4 py-2 tabular-nums">
                    <b>{d.declined}</b> of {d.total}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {d.reasons.length ? (
                      d.reasons.map((r) => <p key={r}>“{r}”</p>)
                    ) : (
                      <span>No reason recorded — ask reviewers to add one.</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Waiting too long</h3>
          <Link to="/agents" className="text-xs font-medium text-primary hover:underline">
            Open Waiting for you →
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          Cards open more than 48 hours
          {o.closedUndecided
            ? ` · ${o.closedUndecided} more were closed before anyone decided`
            : ""}
          .
        </p>
        {o.staleOpen.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Nothing has been waiting more than 48 hours.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border text-xs">
            {o.staleOpen.map((t, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <b className="capitalize">{stageWord(t.agent)}</b> — {t.title}
                </span>
                <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">
                  {t.ageHours >= 48 ? `${Math.floor(t.ageHours / 24)} days` : `${t.ageHours}h`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
