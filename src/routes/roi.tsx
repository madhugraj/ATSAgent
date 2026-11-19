import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Building2,
  ChevronRight,
  Gauge,
  Layers,
  Rocket,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";

import { readReturnOnIndividual, type RoiView } from "@/lib/roi.functions";
import { usePlatform } from "@/hooks/usePlatform";
import { inr } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/roi")({
  head: () => ({
    meta: [
      { title: "Return on Individual — what the organisation got for every hire" },
      {
        name: "description",
        content:
          "The CHRO view of hiring value: capability returned per individual, the programmes the hired talent can staff today, and where the organisation is strong or exposed.",
      },
      { property: "og:title", content: "ATSIQ Return on Individual" },
      {
        property: "og:description",
        content:
          "Evidence-linked return per hire, capability-to-goal readiness and organisation strength and weakness from your own hiring data.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RoiPage,
});

function RoiPage() {
  const { isSuperUser } = usePlatform();
  const [orgId, setOrgId] = useState<string | undefined>(undefined);
  const read = useServerFn(readReturnOnIndividual);

  const q = useQuery({
    queryKey: ["return_on_individual", orgId ?? "mine"],
    queryFn: () => read({ data: orgId ? { orgId } : {} }),
    retry: false,
  });

  const data = q.data as RoiView | undefined;
  const money = (n: number | null) => (n === null || !n ? "—" : inr(n));

  const verdictTone = (v: string) =>
    v === "compounding"
      ? "bg-primary/10 text-primary"
      : v === "solid"
        ? "bg-success/10 text-success"
        : "bg-warning/15 text-warning";

  const goals = useMemo(() => data?.goals ?? [], [data]);

  return (
    <div className="space-y-5 p-5 sm:p-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[0.6875rem] font-mono uppercase tracking-[0.2em] text-primary">
            • Semantic layer
          </p>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">Return on Individual</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            What every hire returned for the money committed — read from hiring evidence.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSuperUser && data?.orgOptions?.length ? (
            <label className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs">
              <Building2 className="size-4 text-primary" />
              <span className="text-muted-foreground">Organisation</span>
              <select
                value={orgId ?? data.orgId}
                onChange={(e) => setOrgId(e.target.value)}
                className="bg-transparent text-xs font-medium outline-none"
              >
                {data.orgOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.status !== "active" ? ` · ${o.status}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <Link to="/brain">
              Talent Brain <ArrowUpRight />
            </Link>
          </Button>
        </div>
      </header>

      {q.isLoading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          Reading hiring evidence and the capability graph…
        </p>
      ) : q.error ? (
        <p className="rounded-xl border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      ) : !data ? null : (
        <>
          <section className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Figure
              label="Portfolio RoI"
              value={`${data.totals.portfolioRoi}`}
              note="100 = value of the median-cost hire"
              accent
            />
            <Figure
              label="Capability returned"
              value={`${data.totals.avgCapability}`}
              note={`${data.totals.joined} joined · ${data.totals.committed} committed`}
            />
            <Figure
              label="Cost committed"
              value={money(data.totals.committedCost)}
              note={
                data.totals.costBasis === "offer"
                  ? "Released offers"
                  : data.totals.costBasis === "budget"
                    ? "Requisition budgets (indicative)"
                    : "Offers where released, budget elsewhere"
              }
            />
            <Figure
              label="Cost per capability point"
              value={money(data.totals.costPerCapabilityPoint)}
              note="Lower is better value"
            />
            <Figure
              label="Compounding hires"
              value={`${data.totals.compounding}`}
              note={`${data.totals.watch} to watch`}
            />
            <Figure
              label="Scarce skills covered"
              value={`${data.totals.scarceCovered}`}
              note={`${data.totals.soleSource} single-person dependencies`}
              tone={data.totals.soleSource > 0 ? "warn" : undefined}
            />
          </section>

          <section className="panel-lift flex flex-wrap items-center gap-x-8 gap-y-4 border-l-4 border-l-primary p-5">
            <p className="max-w-3xl text-base font-medium leading-snug">
              {data.totals.joined + data.totals.committed === 0
                ? "No hire has reached offer yet — release an offer and this page starts reading value automatically."
                : `Every ₹ committed to hiring is currently returning ${data.totals.portfolioRoi} index points of capability, with ${data.totals.goalsReady} programme${data.totals.goalsReady === 1 ? "" : "s"} fully staffable today and ${data.totals.soleSource} single-person dependenc${data.totals.soleSource === 1 ? "y" : "ies"} to protect.`}
            </p>
            <div className="flex items-center gap-2">
              <Bar
                label="Compounding"
                value={data.totals.compounding}
                total={data.totals.joined + data.totals.committed}
                tone="primary"
              />
              <Bar
                label="To watch"
                value={data.totals.watch}
                total={data.totals.joined + data.totals.committed}
                tone="warn"
              />
            </div>
          </section>

          <details className="panel-lift px-5 py-3 text-sm [&[open]>summary>svg]:rotate-90">
            <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
              <ChevronRight className="size-4 text-primary transition-transform" />
              How these numbers are calculated
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Hint
                title="Return on Individual"
                body="Capability the person brings, divided by what they cost relative to your own median hire. 120 means 20% more capability per rupee."
              />
              <Hint
                title="Capability"
                body="Weighted blend of JD ↔ CV match, scarce capability, delivered impact, innovation signal, trajectory and breadth."
              />
              <Hint
                title="What we can do now"
                body="Programmes the hired talent can staff today, with the people behind each one and the capabilities still missing."
              />
              <Hint
                title="Strength & exposure"
                body="Where the bench is deep, and where demand, dormancy or a single-person dependency puts delivery at risk."
              />
            </div>
            <ul className="mt-4 space-y-1 border-t pt-3 text-xs text-muted-foreground">
              {data.basis.map((b) => (
                <li key={b}>· {b}</li>
              ))}
            </ul>
          </details>

          <section className="panel-lift">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-gradient-to-r from-primary/[0.06] to-transparent px-5 py-4">
              <div className="flex items-center gap-2">
                <Rocket className="size-4 text-primary" />
                <div>
                  <h2 className="text-sm font-semibold">
                    What this organisation can go and do now
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {data.totals.goalsReady} fully staffable from the team ·{" "}
                    {data.totals.goalsPartial} startable with one lead hire
                  </p>
                </div>
              </div>
            </header>
            <div className="grid gap-0 sm:grid-cols-2 xl:grid-cols-3">
              {goals.map((g) => (
                <article key={g.id} className="border-b border-r p-5 last:border-r-0">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-sm font-semibold">{g.title}</h3>
                    <Badge
                      variant="outline"
                      className={
                        g.status === "ready"
                          ? "border-success/40 text-success"
                          : g.status === "partial"
                            ? "border-warning/50 text-warning"
                            : "border-border text-muted-foreground"
                      }
                    >
                      {g.readiness}% staffable
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{g.outcome}</p>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-accent">
                    <div
                      className={`h-full rounded-full ${
                        g.status === "ready"
                          ? "bg-success"
                          : g.status === "partial"
                            ? "bg-warning"
                            : "bg-muted-foreground/40"
                      }`}
                      style={{ width: `${g.readiness}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">
                    Team {g.readiness}% · with the talent pool {g.poolReadiness}%
                  </p>
                  {g.covered.length ? (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {g.covered.slice(0, 6).map((s) => (
                        <Chip key={s} tone="ok">
                          {s}
                        </Chip>
                      ))}
                    </div>
                  ) : null}
                  {g.missing.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {g.missing.slice(0, 5).map((s) => (
                        <Chip key={s} tone="gap">
                          {s}
                        </Chip>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-3 flex items-center justify-between text-[0.6875rem] text-muted-foreground">
                    <span>
                      {g.contributors.length
                        ? `${g.contributors.length} can staff it`
                        : "No internal staffing yet"}
                    </span>
                    <span className="font-mono uppercase tracking-widest">{g.horizon}</span>
                  </div>
                  {g.note ? (
                    <details className="mt-2 text-[0.6875rem] text-muted-foreground">
                      <summary className="cursor-pointer list-none text-primary">Detail</summary>
                      <p className="mt-1.5">{g.note}</p>
                      {g.contributors.length ? (
                        <p className="mt-1.5">{g.contributors.map((c) => c.name).join(", ")}</p>
                      ) : null}
                    </details>
                  ) : null}
                </article>
              ))}
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="panel-lift">
              <header className="flex items-center gap-2 border-b bg-gradient-to-r from-success/[0.08] to-transparent px-5 py-4">
                <TrendingUp className="size-4 text-success" />
                <h2 className="text-sm font-semibold">Organisational strength</h2>
              </header>
              <div className="divide-y">
                {data.readings
                  .filter((r) => r.kind === "strength")
                  .map((r) => (
                    <Reading key={r.title} reading={r} />
                  ))}
                {data.readings.filter((r) => r.kind === "strength").length === 0 ? (
                  <p className="p-5 text-sm text-muted-foreground">
                    Not enough validated capability yet to call a strength.
                  </p>
                ) : null}
              </div>
            </section>
            <section className="panel-lift">
              <header className="flex items-center gap-2 border-b bg-gradient-to-r from-destructive/[0.07] to-transparent px-5 py-4">
                <ShieldAlert className="size-4 text-destructive" />
                <h2 className="text-sm font-semibold">Where it is exposed</h2>
              </header>
              <div className="divide-y">
                {data.readings
                  .filter((r) => r.kind === "weakness")
                  .map((r) => (
                    <Reading key={r.title} reading={r} />
                  ))}
                {data.readings.filter((r) => r.kind === "weakness").length === 0 ? (
                  <p className="p-5 text-sm text-muted-foreground">
                    No structural exposure detected in the current graph.
                  </p>
                ) : null}
              </div>
            </section>
          </div>

          {data.departments.length ? (
            <section className="panel-lift">
              <header className="flex items-center gap-2 border-b bg-gradient-to-r from-primary/[0.06] to-transparent px-5 py-4">
                <Layers className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">Return by department</h2>
              </header>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                    <tr className="border-b">
                      <th className="px-5 py-3 font-medium">Department</th>
                      <th className="px-5 py-3 font-medium">Hires</th>
                      <th className="px-5 py-3 font-medium">Capability</th>
                      <th className="px-5 py-3 font-medium">RoI index</th>
                      <th className="px-5 py-3 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.departments.map((d) => (
                      <tr key={d.name} className="hover:bg-accent/40">
                        <td className="px-5 py-3 font-medium">{d.name}</td>
                        <td className="num px-5 py-3">{d.hires}</td>
                        <td className="num px-5 py-3">{d.capability}</td>
                        <td className="num px-5 py-3 font-semibold">{d.roiIndex}</td>
                        <td className="num px-5 py-3">{money(d.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="panel-lift">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-gradient-to-r from-primary/[0.06] to-transparent px-5 py-4">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-primary" />
                <div>
                  <h2 className="text-sm font-semibold">Individual by individual</h2>
                  <p className="text-xs text-muted-foreground">
                    Every hire, what they returned and the evidence behind it
                  </p>
                </div>
              </div>
              {data.totals.avgDaysToHire !== null ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Gauge className="size-3.5" /> {data.totals.avgDaysToHire} days average to close
                </span>
              ) : null}
            </header>
            <div className="divide-y">
              {data.hires.map((h) => (
                <article key={h.applicationId} className="p-5 transition-colors hover:bg-accent/30">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">{h.name}</h3>
                        <span className="rounded bg-accent px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
                          {h.cohort === "joined" ? "Joined" : "Offer committed"}
                        </span>
                        <span
                          className={`rounded px-2 py-0.5 text-[0.6875rem] ${verdictTone(h.verdict)}`}
                        >
                          {h.verdict === "compounding"
                            ? "Compounding"
                            : h.verdict === "solid"
                              ? "Solid"
                              : "Watch"}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {h.requisitionTitle ?? "Role"}
                        {h.department ? ` · ${h.department}` : ""}
                        {h.cost ? ` · ${money(h.cost)}` : ""}
                        {h.costBasis === "budget" ? " (budget)" : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-6">
                      <Metric label="Capability" value={`${h.capability}`} />
                      <Metric label="RoI index" value={`${h.roiIndex}`} accent />
                    </div>
                  </div>

                  <details className="mt-2 [&[open]>summary>svg]:rotate-90">
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.6875rem] font-medium text-primary">
                      <ChevronRight className="size-3.5 transition-transform" /> Evidence &
                      contribution
                    </summary>
                    <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <div className="space-y-1.5">
                        {h.contribution.map((c) => (
                          <div key={c.label} className="flex items-center gap-2">
                            <span className="w-44 shrink-0 text-[0.6875rem] text-muted-foreground">
                              {c.label}
                            </span>
                            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-accent">
                              <span
                                className="block h-full rounded-full bg-primary/70"
                                style={{ width: `${c.value}%` }}
                              />
                            </span>
                            <span className="num w-8 text-right text-[0.6875rem]">{c.value}</span>
                          </div>
                        ))}
                      </div>
                      <div className="space-y-2">
                        {h.scarceSkills.length ? (
                          <p className="text-xs">
                            <Sparkles className="mr-1 inline size-3.5 text-primary" />
                            <span className="font-medium">Scarce capability added: </span>
                            {h.scarceSkills.join(", ")}
                          </p>
                        ) : null}
                        {h.soleSourceSkills.length ? (
                          <p className="text-xs text-warning">
                            <ShieldAlert className="mr-1 inline size-3.5" />
                            Only source for {h.soleSourceSkills.join(", ")}
                          </p>
                        ) : null}
                        <ul className="space-y-0.5 text-[0.6875rem] text-muted-foreground">
                          {h.evidence.map((e) => (
                            <li key={e}>· {e}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </details>
                </article>
              ))}
              {data.hires.length === 0 ? (
                <p className="p-8 text-sm text-muted-foreground">
                  Nobody has reached offer yet, so there is no committed value to read. Release an
                  offer and this fills in automatically.
                </p>
              ) : null}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  note,
  accent,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  accent?: boolean;
  tone?: "warn" | undefined;
}) {
  return (
    <div className="panel-lift hover:panel-lift-hover p-4">
      <p className="text-[0.6875rem] font-mono uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p
        className={`num mt-1.5 text-2xl font-semibold leading-none tracking-tight ${
          tone === "warn" ? "text-warning" : accent ? "text-primary" : ""
        }`}
      >
        {value}
      </p>
      {note ? <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="text-right">
      <p className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p className={`num text-xl font-semibold leading-none ${accent ? "text-primary" : ""}`}>
        {value}
      </p>
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone: "ok" | "gap" }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${
        tone === "ok" ? "bg-success/10 text-success" : "bg-warning/15 text-warning"
      }`}
    >
      {children}
    </span>
  );
}

function Bar({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: "primary" | "warn";
}) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="w-32">
      <div className="flex items-baseline justify-between text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground">
        <span>{label}</span>
        <span className="num text-foreground">{value}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-accent">
        <div
          className={`h-full rounded-full ${tone === "primary" ? "bg-primary" : "bg-warning"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Hint({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border bg-accent/30 p-3">
      <p className="text-xs font-semibold">{title}</p>
      <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

function Reading({
  reading,
}: {
  reading: { title: string; detail: string; severity: string; skills: string[] };
}) {
  return (
    <div className="p-5">
      <p className="text-sm font-semibold">{reading.title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{reading.detail}</p>
      {reading.skills.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {reading.skills.slice(0, 8).map((s) => (
            <span key={s} className="rounded bg-accent px-2 py-0.5 text-[0.6875rem]">
              {s}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
