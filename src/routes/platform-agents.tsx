import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { KeyRound } from "lucide-react";

import { PageHeader, StatCard } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePlatform } from "@/hooks/usePlatform";
import { AGENT_LABEL } from "@/lib/agents.catalog";
import { platformAgentConsole } from "@/lib/platform-agents.functions";

export const Route = createFileRoute("/platform-agents")({
  head: () => ({
    meta: [
      { title: "Platform console — Agents" },
      {
        name: "description",
        content:
          "Super-user view of hiring agents across tenants: runs, failures, latency, spend and open issues.",
      },
    ],
  }),
  component: PlatformAgents,
});

const RANGES = [1, 7, 30] as const;

const fmt = (n: number) =>
  Math.abs(n) >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : Math.abs(n) >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : String(Math.round(n));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const secs = (s: number | null) =>
  s == null ? "—" : s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`;
const ms = (v: number | null) =>
  v == null ? "—" : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`;

function Table({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            {head.map((h, i) => (
              <th key={h} className={`px-3 py-2 font-medium ${i ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r, i) => (
              <tr key={i} className="border-b border-border/60 last:border-0">
                {r.map((c, j) => (
                  <td key={j} className={`num px-3 py-2 ${j ? "text-right" : ""}`}>
                    {c}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={head.length} className="px-3 py-4 text-center text-muted-foreground">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function PlatformAgents() {
  const { isSuperUser, isLoading } = usePlatform();
  const fetchConsole = useServerFn(platformAgentConsole);
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const q = useQuery({
    queryKey: ["platform_agents", days],
    queryFn: () => fetchConsole({ data: { days } }),
    enabled: isSuperUser,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Checking platform access…</p>;
  if (!isSuperUser) {
    return (
      <>
        <PageHeader
          eyebrow="Platform"
          title="Agents"
          description="Cross-tenant agent operations."
        />
        <section className="panel max-w-lg space-y-3 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4 text-muted-foreground" /> Super-user access only
          </h2>
          <p className="text-sm text-muted-foreground">
            Cross-tenant agent operations are limited to the platform console&apos;s super users.
          </p>
        </section>
      </>
    );
  }

  const d = q.data;
  const t = d?.totals;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Platform"
        title="Agents"
        description="Hiring agents across every organisation — throughput, failures, latency and spend. Aggregates only: no goals, prompts or candidate content leave a tenant."
        actions={
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <Button
                key={r}
                size="sm"
                variant={days === r ? "default" : "outline"}
                onClick={() => setDays(r)}
              >
                {r === 1 ? "24 h" : `${r} days`}
              </Button>
            ))}
          </div>
        }
      />

      {!d || !t ? (
        <p className="text-sm text-muted-foreground">
          {q.error ? (q.error as Error).message : "Loading…"}
        </p>
      ) : (
        <>
          <section className="panel flex flex-wrap items-center gap-3 p-4 text-sm">
            <span className="font-medium">Scheduler</span>
            {d.scheduler.healthy ? (
              <Badge>Running</Badge>
            ) : (
              <Badge variant="destructive">Not running</Badge>
            )}
            <span className="text-muted-foreground">
              {d.scheduler.lastTickAt
                ? `Last tick ${d.scheduler.minutesSinceTick} min ago`
                : "No tick recorded yet — register /api/public/agent-tick with the scheduler."}
            </span>
            <span className="ml-auto text-muted-foreground">
              Trace export: {t.exportOrgs} org(s)
              {t.exportErrors ? `, ${t.exportErrors} failing` : ""}
            </span>
          </section>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Organisations with agents on" value={t.orgsWithAgents} />
            <StatCard
              label="Runs"
              value={fmt(t.runs)}
              hint={`${t.done} done · ${t.failed} failed · ${t.replays} replays`}
            />
            <StatCard
              label="Failure rate"
              value={pct(t.failed, t.done + t.failed)}
              tone={
                t.failed && t.failed / Math.max(1, t.done + t.failed) > 0.1 ? "warning" : "default"
              }
            />
            <StatCard
              label="Agent tokens"
              value={fmt(t.tokens)}
              hint="model turns and AI inside tools"
            />
            <StatCard
              label="Waiting on people"
              value={t.openTasks}
              hint="open human-in-the-loop requests"
            />
            <StatCard
              label="Open critical issues"
              value={t.openCritical}
              tone={t.openCritical ? "destructive" : "default"}
            />
            <StatCard
              label="Open serious issues"
              value={t.openSerious}
              tone={t.openSerious ? "warning" : "default"}
            />
          </div>

          <section className="panel">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
              By organisation
            </h2>
            <Table
              head={[
                "Organisation",
                "Agents on",
                "Runs",
                "Failed",
                "Waiting",
                "Critical",
                "Serious",
                "Tokens",
                "p95 run",
              ]}
              empty="No agent activity in this period."
              rows={d.byOrg.map((o) => [
                o.name,
                o.agentsOn,
                o.runs,
                o.failed ? <span className="text-destructive">{o.failed}</span> : 0,
                o.openTasks,
                o.openCritical ? <span className="text-destructive">{o.openCritical}</span> : 0,
                o.openSerious,
                fmt(o.tokens),
                secs(o.p95RunSeconds),
              ])}
            />
          </section>

          <section className="panel">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
              By agent — cost and latency
            </h2>
            <Table
              head={[
                "Agent",
                "Orgs",
                "Runs",
                "Failed",
                "Avg steps",
                "Avg tokens / run",
                "Run p50 / p95",
                "Model turn p50 / p95",
                "Tool errors",
                "Edited / rejected",
              ]}
              empty="No runs in this period."
              rows={d.byAgent.map((a) => [
                AGENT_LABEL[a.agentType] ?? a.agentType,
                a.orgs,
                a.runs,
                `${a.failed} (${pct(a.failed, a.runs)})`,
                a.avgSteps,
                fmt(a.avgTokens),
                `${secs(a.p50RunSeconds)} / ${secs(a.p95RunSeconds)}`,
                `${ms(a.p50ModelMs)} / ${ms(a.p95ModelMs)}`,
                `${a.toolErrors} / ${a.toolCalls} (${pct(a.toolErrors, a.toolCalls)})`,
                `${pct(a.edited, a.decided)} / ${pct(a.rejected, a.decided)}`,
              ])}
            />
          </section>

          <section className="panel">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
              By model (agent requests only)
            </h2>
            <Table
              head={["Provider · model", "Requests", "Errors", "Tokens", "p50", "p95"]}
              empty="No agent AI requests in this period."
              rows={d.byModel.map((m) => [
                `${m.provider} · ${m.model}`,
                fmt(m.requests),
                `${m.errors} (${pct(m.errors, m.requests)})`,
                fmt(m.tokens),
                ms(m.p50Ms),
                ms(m.p95Ms),
              ])}
            />
          </section>

          <section className="panel">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
              Recent failed runs
            </h2>
            <Table
              head={["When", "Organisation", "Agent", "Error"]}
              empty="No failed runs in this period."
              rows={d.failures.map((f) => [
                new Date(f.at).toLocaleString(),
                f.orgName,
                AGENT_LABEL[f.agentType] ?? f.agentType,
                <span key={f.runId} className="block max-w-md truncate text-left" title={f.error}>
                  {f.error || "—"}
                </span>,
              ])}
            />
          </section>
        </>
      )}
    </div>
  );
}
