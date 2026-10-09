import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { EmptyState, PageHeader } from "@/components/ats";
import { CostFigure, PricingNote } from "@/components/HiringCost";
import { fmtMoney, fmtTokens } from "@/lib/cost-format";
import { getOrgHiringCost } from "@/lib/hiring-cost.functions";

export const Route = createFileRoute("/hiring-cost")({
  head: () => ({
    meta: [
      { title: "Hiring cost — AI spend per hire, per role and per candidate" },
      {
        name: "description",
        content:
          "What hiring costs in AI across every role: month by month, cost per hire, each role, each hiring stage and where candidate spend ended up.",
      },
    ],
  }),
  component: HiringCostPage,
});

const WINDOWS = [3, 6, 12] as const;
const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

function HiringCostPage() {
  const [months, setMonths] = useState<number>(6);
  const q = useQuery({
    queryKey: ["org_hiring_cost", months],
    queryFn: () => getOrgHiringCost({ data: { months } }),
  });
  const c = q.data;
  // Bars measure money when it is known, else tokens — one scale per chart.
  const measure = (l: { cost: number | null; tokens: number }) =>
    c?.currency && l.cost != null ? l.cost : l.tokens;
  const label = (l: { cost: number | null; tokens: number }) =>
    fmtMoney(l.cost, c?.currency ?? null) ?? `${fmtTokens(l.tokens)} tokens`;

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Hiring cost"
        description="What hiring costs in AI across every role: month by month, per hire, per role, per hiring stage, and how much went on candidates who were not hired."
        actions={
          <div className="flex gap-1" role="group" aria-label="Period">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setMonths(w)}
                className={`rounded-md border px-3 py-1.5 text-xs ${
                  months === w
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-muted"
                }`}
              >
                {w} months
              </button>
            ))}
          </div>
        }
      />

      {q.isLoading ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <p className="mt-6 text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load hiring cost."}
        </p>
      ) : !c || c.total.requests === 0 ? (
        <div className="mt-6">
          <EmptyState title="No AI spend in this period" hint="Pick a longer period above." />
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {/* Headline numbers */}
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile title="Spent on hiring" sub={`${c.total.requests} AI requests`}>
              <CostFigure line={c.total} currency={c.currency} />
            </Tile>
            <Tile title="Cost per hire" sub={`${c.hires} offer(s) accepted in the period`}>
              {c.costPerHire ? (
                <CostFigure line={c.costPerHire} currency={c.currency} />
              ) : (
                <span className="text-muted-foreground">— no hire yet</span>
              )}
            </Tile>
            <Tile title="Spent on candidates not hired" sub="rejected, withdrawn or declined">
              <CostFigure line={c.outcomes.notHired} currency={c.currency} />
            </Tile>
            <Tile title="Not tied to a role" sub="talent pool, copilot, set-up">
              <CostFigure line={c.notTiedToRole} currency={c.currency} />
            </Tile>
          </section>

          {/* Month by month */}
          <section className="panel p-5">
            <h2 className="font-semibold">Month by month</h2>
            <p className="text-xs text-muted-foreground">
              Spend in the month, offers accepted in the month, and the month's cost per hire (its
              spend ÷ its accepted offers — a hire's work often spans months).
            </p>
            <Bars
              rows={c.months.map((m) => ({
                key: m.month,
                name: monthLabel(m.month),
                value: measure(m),
                text: label(m),
                extra: `${m.hires} hire(s)${m.costPerHire ? ` · ${label(m.costPerHire)} per hire` : ""}`,
              }))}
            />
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            {/* By hiring stage */}
            <section className="panel p-5">
              <h2 className="font-semibold">Where candidate spend goes</h2>
              <p className="text-xs text-muted-foreground">
                Direct candidate cost by hiring stage, across every role.
              </p>
              <Bars
                rows={c.stages.map((s) => ({
                  key: s.stage,
                  name: s.stage,
                  value: measure(s),
                  text: label(s),
                  extra: `${s.requests} requests`,
                }))}
              />
            </section>

            {/* By outcome */}
            <section className="panel p-5">
              <h2 className="font-semibold">Candidate spend by outcome</h2>
              <p className="text-xs text-muted-foreground">
                Direct cost of candidates by where they ended up. A high share on candidates not
                hired means screening and interviews reach too many people.
              </p>
              <Bars
                rows={[
                  ["Hired", c.outcomes.hired],
                  ["Not hired", c.outcomes.notHired],
                  ["Still in progress", c.outcomes.inProgress],
                ].map(([name, l]) => ({
                  key: String(name),
                  name: String(name),
                  value: measure(l as typeof c.total),
                  text: label(l as typeof c.total),
                  extra: `${(l as typeof c.total).requests} requests`,
                }))}
              />
            </section>
          </div>

          {/* Each role */}
          <section className="panel p-5">
            <h2 className="font-semibold">By role</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-2 py-2 font-medium">Role</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 text-right font-medium">Candidates</th>
                    <th className="px-2 py-2 text-right font-medium">Hires</th>
                    <th className="px-2 py-2 text-right font-medium">Spent</th>
                    <th className="px-2 py-2 text-right font-medium">Shared</th>
                    <th className="px-2 py-2 text-right font-medium">Per candidate</th>
                    <th className="px-2 py-2 text-right font-medium">Per hire</th>
                  </tr>
                </thead>
                <tbody>
                  {c.roles.map((r) => (
                    <tr key={r.id} className="border-b border-border/60">
                      <td className="px-2 py-2">
                        <Link
                          to="/requisitions/$id"
                          params={{ id: r.id }}
                          className="font-medium hover:underline"
                        >
                          {r.code}
                        </Link>{" "}
                        <span className="text-muted-foreground">{r.title}</span>
                      </td>
                      <td className="px-2 py-2 text-xs">{r.status.replace(/_/g, " ")}</td>
                      <td className="num px-2 py-2 text-right">{r.candidates}</td>
                      <td className="num px-2 py-2 text-right">{r.hires}</td>
                      <td className="num px-2 py-2 text-right">{label(r.total)}</td>
                      <td className="num px-2 py-2 text-right text-muted-foreground">
                        {label(r.shared)}
                      </td>
                      <td className="num px-2 py-2 text-right">
                        {r.perCandidate ? label(r.perCandidate) : "—"}
                      </td>
                      <td className="num px-2 py-2 text-right">
                        {r.costPerHire ? label(r.costPerHire) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-1">
            <PricingNote
              basis={c.basis}
              checkedOn={c.checkedOn}
              unpricedTokens={c.total.unpricedTokens}
            />
            {c.grounding.requests ? (
              <p className="text-xs text-muted-foreground">
                Web-search grounded requests: {c.grounding.requests} ({c.grounding.billable} beyond
                the monthly free allowance
                {c.grounding.cost != null && c.currency
                  ? `, ${fmtMoney(c.grounding.cost, c.currency)}`
                  : ""}
                ) — billed by your AI provider on top of tokens, not included above.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Per role and per candidate detail is on each requisition and candidate page.
            </p>
          </section>
        </div>
      )}
    </>
  );
}

function Tile({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="panel p-4">
      <p className="text-xs text-muted-foreground">{title}</p>
      <div className="mt-1 text-lg">{children}</div>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

/** Horizontal bars, one series, labelled directly; the label is also the text view. */
function Bars({
  rows,
}: {
  rows: { key: string; name: string; value: number; text: string; extra?: string }[];
}) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (!rows.length) return <p className="mt-3 text-xs text-muted-foreground">Nothing yet.</p>;
  return (
    <ul className="mt-3 space-y-2">
      {rows.map((r) => (
        <li
          key={r.key}
          className="grid grid-cols-[10.5rem_1fr] items-center gap-3 text-sm"
          title={`${r.name}: ${r.text}${r.extra ? ` — ${r.extra}` : ""}`}
        >
          <span className="truncate text-xs text-muted-foreground">{r.name}</span>
          <div className="min-w-0">
            <div className="h-2.5 w-full rounded-sm bg-muted">
              <div
                className="h-2.5 rounded-r-[4px] bg-primary"
                style={{ width: `${max ? Math.max((r.value / max) * 100, r.value ? 1 : 0) : 0}%` }}
              />
            </div>
            <p className="num mt-0.5 text-xs">
              {r.text}
              {r.extra ? <span className="text-muted-foreground"> · {r.extra}</span> : null}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
