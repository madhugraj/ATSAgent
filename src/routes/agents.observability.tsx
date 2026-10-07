import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  OctagonX,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import { PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  acknowledgeAgentIssue,
  agentObservability,
  type AgentObservability,
  type IssueView,
  type ObservabilityView,
  type TrendDay,
} from "@/lib/agents-observability.functions";
import { AGENT_LABEL, AUTONOMY_OPTIONS } from "@/lib/agents.catalog";
import { AgentDetailDrawer, type DrawerTab } from "@/components/AgentDetailDrawer";

export const Route = createFileRoute("/agents/observability")({
  head: () => ({
    meta: [
      { title: "Agent observability — ATSIQ" },
      {
        name: "description",
        content:
          "Activity, performance and health of every hiring agent, with 14-day trends and detected issues.",
      },
    ],
  }),
  component: ObservabilityPage,
});

/* ------------------------------------------------------------- status */

type Status = "good" | "warning" | "serious" | "critical" | "idle";

/** Reserved status colours, always paired with an icon and a label. */
const STATUS: Record<Status, { color: string; label: string; Icon: typeof CheckCircle2 }> = {
  good: { color: "#0ca30c", label: "Healthy", Icon: CheckCircle2 },
  warning: { color: "#fab219", label: "Warning", Icon: AlertTriangle },
  serious: { color: "#ec835a", label: "Serious", Icon: AlertOctagon },
  critical: { color: "#d03b3b", label: "Critical", Icon: OctagonX },
  idle: { color: "currentColor", label: "No activity", Icon: CircleDashed },
};
const RANK: Record<Status, number> = { idle: 0, good: 1, warning: 2, serious: 3, critical: 4 };

function StatusPill({ status, label }: { status: Status; label?: string | undefined }) {
  const s = STATUS[status];
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
      <s.Icon
        className={`size-3.5 ${status === "idle" ? "text-muted-foreground" : ""}`}
        style={status === "idle" ? undefined : { color: s.color }}
        aria-hidden
      />
      {label ?? s.label}
    </span>
  );
}

function worst(issues: IssueView[], element: string, fallback: Status): Status {
  return issues
    .filter((i) => i.element === element)
    .reduce<Status>((w, i) => (RANK[i.severity] > RANK[w] ? i.severity : w), fallback);
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const mins = (m: number | null) =>
  m == null
    ? "—"
    : m < 60
      ? `${m} min`
      : m < 2880
        ? `${Math.round(m / 60)} h`
        : `${Math.round(m / 1440)} d`;

/* ---------------------------------------------------------- chart setup */

/**
 * Validated categorical slots (light / dark steps) and the fixed status
 * palette — status colours are used only for outcomes and always appear with
 * a legend label.
 */
const SERIES_1 = { light: "#2a78d6", dark: "#3987e5" };
const SERIES_2 = { light: "#eb6834", dark: "#d95926" };
const NEUTRAL = { light: "#a3a29c", dark: "#6b6a65" };
const GOOD = { light: "#0ca30c", dark: "#0ca30c" };
const CRITICAL = { light: "#d03b3b", dark: "#d03b3b" };

const runsConfig = {
  completed: { label: "Completed", theme: GOOD },
  failed: { label: "Failed", theme: CRITICAL },
  inProgress: { label: "In progress", theme: SERIES_1 },
  stopped: { label: "Stopped", theme: NEUTRAL },
} satisfies ChartConfig;
const tokensConfig = { tokens: { label: "Tokens", theme: SERIES_1 } } satisfies ChartConfig;
const hitlConfig = {
  hitlOpened: { label: "Requested", theme: SERIES_1 },
  hitlDecided: { label: "Decided", theme: SERIES_2 },
} satisfies ChartConfig;
const toolsConfig = {
  toolOk: { label: "Succeeded", theme: SERIES_1 },
  toolErrors: { label: "Failed", theme: CRITICAL },
} satisfies ChartConfig;
const waitConfig = {
  medianWaitHours: { label: "Median wait (h)", theme: SERIES_1 },
} satisfies ChartConfig;
const latencyConfig = {
  aiP95Seconds: { label: "p95 latency (s)", theme: SERIES_1 },
} satisfies ChartConfig;
const agentsConfig = {
  done: { label: "Completed", theme: GOOD },
  failed: { label: "Failed", theme: CRITICAL },
  active: { label: "Active now", theme: SERIES_1 },
} satisfies ChartConfig;

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const compact = (v: number) =>
  Math.abs(v) >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)}M`
    : Math.abs(v) >= 1_000
      ? `${(v / 1_000).toFixed(1)}K`
      : String(Math.round(v));

/* --------------------------------------------------------------- page */

function ObservabilityPage() {
  const [open, setOpen] = useState<{ agent: string; tab: DrawerTab } | null>(null);
  const q = useQuery({
    queryKey: ["agent_observability"],
    queryFn: () => agentObservability(),
    refetchInterval: 30_000,
    retry: false,
  });
  const d = q.data;

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Agent observability"
        description="How every hiring agent is behaving and performing — 14-day trends, the issues the health engine has detected, and each agent's identity, tools, AI skills, evals, harness, human-in-the-loop, budget and audit."
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/agents/settings">Agent settings</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/agents/register">Agent register</Link>
            </Button>
          </div>
        }
      />

      {q.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : q.error || !d ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {q.error instanceof Error ? q.error.message : "Not available."}
        </p>
      ) : (
        <div className="mt-4 space-y-6">
          <HealthSummary d={d} />
          <KpiRow d={d} />
          <Trends d={d} />
          <IssuesPanel
            issues={[...d.orgIssues, ...d.agents.flatMap((a) => a.issues)]}
            rules={d.rules}
          />
          <AgentGrid d={d} onOpen={(agent, tab) => setOpen({ agent, tab })} />
          <AgentDetailDrawer
            agentType={open?.agent ?? null}
            tab={open?.tab ?? "identity"}
            onTab={(tab) => setOpen((o) => (o ? { ...o, tab } : o))}
            onClose={() => setOpen(null)}
          />
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------- health summary */

function HealthSummary({ d }: { d: ObservabilityView }) {
  const all = [...d.orgIssues, ...d.agents.flatMap((a) => a.issues)];
  const overall: Status = !d.scheduler.healthy
    ? "critical"
    : all.reduce<Status>((w, i) => (RANK[i.severity] > RANK[w] ? i.severity : w), "good");
  const s = STATUS[overall];
  const on = d.agents.filter((a) => a.enabled).length;
  const headline =
    overall === "good"
      ? "All agents healthy"
      : !d.scheduler.healthy
        ? "Agents are not picking up work"
        : `${all.length} open issue${all.length === 1 ? "" : "s"} need attention`;
  return (
    <section
      className="panel flex flex-wrap items-center gap-x-6 gap-y-3 border-l-4 p-5"
      style={{ borderLeftColor: s.color }}
    >
      <div className="flex items-center gap-3">
        <s.Icon className="size-7" style={{ color: s.color }} aria-hidden />
        <div>
          <p className="text-lg font-semibold leading-tight">{headline}</p>
          <p className="text-xs text-muted-foreground">
            {on} of {d.agents.length} agents switched on · health rules evaluated every 5 minutes
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <StatusPill status="critical" label={`${d.totals.issues.critical} critical`} />
        <StatusPill status="serious" label={`${d.totals.issues.serious} serious`} />
        <StatusPill status="warning" label={`${d.totals.issues.warning} warning`} />
      </div>
      <div className="ml-auto flex items-center gap-2 text-xs">
        <Activity className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-medium">Scheduler</span>
        <StatusPill
          status={d.scheduler.healthy ? "good" : "critical"}
          label={d.scheduler.healthy ? "Running" : d.scheduler.lastTickAt ? "Stopped" : "Never ran"}
        />
        <span className="num text-muted-foreground">
          {d.scheduler.lastTickAt
            ? `last tick ${d.scheduler.minutesSinceTick} min ago`
            : "register /api/public/agent-tick"}
        </span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- KPI row */

function Sparkline({ values, color = "var(--primary)" }: { values: number[]; color?: string }) {
  if (values.length < 2 || values.every((v) => v === 0)) return <div className="h-8" />;
  const W = 120;
  const H = 32;
  const max = Math.max(...values, 1);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => [i * step, H - 2 - (v / max) * (H - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-8 w-full" preserveAspectRatio="none" aria-hidden>
      <path d={`${line}L${W},${H}L0,${H}Z`} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Tile({
  label,
  value,
  hint,
  spark,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  spark?: number[];
  children?: React.ReactNode;
}) {
  return (
    <div className="panel flex flex-col p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="num mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {children}
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      {spark ? (
        <div className="mt-auto pt-2">
          <Sparkline values={spark} />
        </div>
      ) : null}
    </div>
  );
}

function KpiRow({ d }: { d: ObservabilityView }) {
  const t = d.totals;
  const tr = d.trends;
  return (
    <section>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        All agents · last 7 days{" "}
        <span className="font-normal normal-case">(sparklines: 14 days)</span>
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="Runs"
          value={t.runs7d.toLocaleString()}
          spark={tr.map((x) => x.completed + x.failed + x.inProgress + x.stopped)}
        />
        <Tile
          label="Success rate"
          value={t.successRate == null ? "—" : `${Math.round(t.successRate * 100)}%`}
          hint="Finished runs that completed"
          spark={tr
            .filter((x) => x.completed + x.failed)
            .map((x) => (x.completed / (x.completed + x.failed)) * 100)}
        />
        <Tile
          label="Tokens"
          value={compact(t.tokens7d)}
          hint="Incl. AI inside tools"
          spark={tr.map((x) => x.tokens)}
        />
        <Tile
          label="Waiting on people"
          value={String(t.openRequests)}
          hint={`${t.overdueRequests} past the ${d.slaHours} h SLA`}
          spark={tr.map((x) => x.hitlOpened)}
        />
        <Tile
          label="Median wait for a person"
          value={mins(t.medianWaitMinutes)}
          spark={tr.flatMap((x) => (x.medianWaitHours == null ? [] : [x.medianWaitHours]))}
        />
        <Tile
          label="Open issues"
          value={String(t.issues.critical + t.issues.serious + t.issues.warning)}
        >
          <div className="mt-1 flex flex-col gap-0.5">
            <StatusPill status="critical" label={`${t.issues.critical} critical`} />
            <StatusPill status="serious" label={`${t.issues.serious} serious`} />
            <StatusPill status="warning" label={`${t.issues.warning} warning`} />
          </div>
        </Tile>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- trends */

function ChartPanel({
  title,
  subtitle,
  className = "",
  empty,
  children,
}: {
  title: string;
  subtitle: string;
  className?: string;
  /** Shown instead of the chart when there is nothing to plot. */
  empty?: string | false;
  children: React.ReactNode;
}) {
  return (
    <section className={`panel flex flex-col p-4 ${className}`}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
      {empty ? (
        <div className="mt-3 flex h-[220px] items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          {empty}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

const axisX = (
  <XAxis
    dataKey="day"
    tickLine={false}
    axisLine={false}
    tickMargin={6}
    minTickGap={28}
    tickFormatter={dayLabel}
  />
);
const yAxis = (fmt: (v: number) => string = compact, atLeast?: number) => (
  <YAxis
    tickLine={false}
    axisLine={false}
    width={40}
    allowDecimals={false}
    tickFormatter={fmt}
    // Keep a threshold line on the scale.
    {...(atLeast
      ? { domain: [0, (max: number) => Math.ceil(Math.max(max, atLeast * 1.1) / 10) * 10] }
      : {})}
  />
);
const tooltip = (
  <ChartTooltip
    cursor={{ fillOpacity: 0.4 }}
    content={<ChartTooltipContent labelFormatter={(v) => dayLabel(String(v))} />}
  />
);

function Trends({ d }: { d: ObservabilityView }) {
  const data: TrendDay[] = d.trends;
  const any = data.some(
    (x) => x.completed + x.failed + x.inProgress + x.stopped + x.tokens + x.hitlOpened > 0,
  );
  const byAgent = useMemo(
    () =>
      d.agents
        .filter((a) => a.harness.runs7d || a.harness.active)
        .map((a) => ({
          name: a.name.replace(/ agent$/i, ""),
          done: a.harness.done7d,
          failed: a.harness.failed7d,
          active: a.harness.active,
        }))
        .sort((x, y) => y.done + y.failed + y.active - (x.done + x.failed + x.active)),
    [d.agents],
  );
  if (!any) {
    return (
      <section className="panel p-6 text-center text-sm text-muted-foreground">
        No agent activity in the last 14 days — trends appear here once agents run.
      </section>
    );
  }
  const h = "mt-3 aspect-auto h-[220px] w-full";
  const maxLatency = Math.max(0, ...data.map((x) => x.aiP95Seconds ?? 0));
  return (
    <section>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Trends · last 14 days
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartPanel
          title="Runs by outcome"
          subtitle="Live runs started each day, by how they ended"
        >
          <ChartContainer config={runsConfig} className={h}>
            <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              {axisX}
              {yAxis()}
              {tooltip}
              <ChartLegend content={<ChartLegendContent />} />
              <Bar
                isAnimationActive={false}
                dataKey="completed"
                stackId="r"
                stroke="var(--card)"
                strokeWidth={2}
                fill="var(--color-completed)"
                maxBarSize={28}
              />
              <Bar
                isAnimationActive={false}
                dataKey="failed"
                stackId="r"
                stroke="var(--card)"
                strokeWidth={2}
                fill="var(--color-failed)"
                maxBarSize={28}
              />
              <Bar
                isAnimationActive={false}
                dataKey="inProgress"
                stackId="r"
                stroke="var(--card)"
                strokeWidth={2}
                fill="var(--color-inProgress)"
                maxBarSize={28}
              />
              <Bar
                isAnimationActive={false}
                dataKey="stopped"
                stackId="r"
                stroke="var(--card)"
                strokeWidth={2}
                fill="var(--color-stopped)"
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
              />
            </BarChart>
          </ChartContainer>
        </ChartPanel>

        <ChartPanel
          title="Token usage"
          subtitle="Model turns and AI calls inside tools, per day"
          empty={!data.some((x) => x.tokens) && "No tokens used in the last 14 days"}
        >
          <ChartContainer config={tokensConfig} className={h}>
            <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              {axisX}
              {yAxis()}
              {tooltip}
              <Area
                isAnimationActive={false}
                type="monotone"
                dataKey="tokens"
                stroke="var(--color-tokens)"
                strokeWidth={2}
                fill="var(--color-tokens)"
                fillOpacity={0.15}
              />
            </AreaChart>
          </ChartContainer>
        </ChartPanel>

        <ChartPanel
          title="Human-in-the-loop"
          subtitle="Approvals, decisions and questions requested vs decided, per day"
          empty={
            !data.some((x) => x.hitlOpened + x.hitlDecided) &&
            "No requests to people in the last 14 days"
          }
        >
          <ChartContainer config={hitlConfig} className={h}>
            <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }} barGap={2}>
              <CartesianGrid vertical={false} />
              {axisX}
              {yAxis()}
              {tooltip}
              <ChartLegend content={<ChartLegendContent />} />
              <Bar
                isAnimationActive={false}
                dataKey="hitlOpened"
                fill="var(--color-hitlOpened)"
                radius={[4, 4, 0, 0]}
                maxBarSize={14}
              />
              <Bar
                isAnimationActive={false}
                dataKey="hitlDecided"
                fill="var(--color-hitlDecided)"
                radius={[4, 4, 0, 0]}
                maxBarSize={14}
              />
            </BarChart>
          </ChartContainer>
        </ChartPanel>

        <ChartPanel
          title="Tool calls"
          subtitle="Tool calls per day, succeeded vs failed"
          empty={!data.some((x) => x.toolOk + x.toolErrors) && "No tool calls in the last 14 days"}
        >
          <ChartContainer config={toolsConfig} className={h}>
            <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              {axisX}
              {yAxis()}
              {tooltip}
              <ChartLegend content={<ChartLegendContent />} />
              <Bar
                isAnimationActive={false}
                dataKey="toolOk"
                stackId="t"
                stroke="var(--card)"
                strokeWidth={2}
                fill="var(--color-toolOk)"
                maxBarSize={28}
              />
              <Bar
                isAnimationActive={false}
                dataKey="toolErrors"
                stackId="t"
                stroke="var(--card)"
                strokeWidth={2}
                fill="var(--color-toolErrors)"
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
              />
            </BarChart>
          </ChartContainer>
        </ChartPanel>

        <ChartPanel
          title="Wait for a person"
          subtitle={`Median hours from request to decision, by decision day · dashed line: ${d.slaHours} h SLA`}
          empty={
            !data.some((x) => x.medianWaitHours != null) &&
            "No requests were decided in the last 14 days"
          }
        >
          <ChartContainer config={waitConfig} className={h}>
            <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              {axisX}
              {yAxis((v) => `${Math.round(v)} h`, d.slaHours)}
              {tooltip}
              <ReferenceLine
                y={d.slaHours}
                stroke="currentColor"
                strokeOpacity={0.4}
                strokeDasharray="4 4"
              />
              <Line
                isAnimationActive={false}
                type="monotone"
                dataKey="medianWaitHours"
                stroke="var(--color-medianWaitHours)"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            </LineChart>
          </ChartContainer>
        </ChartPanel>

        <ChartPanel
          title="AI latency"
          subtitle={
            maxLatency >= 30
              ? "p95 seconds of AI requests inside agent runs · dashed line: 60 s health threshold"
              : "p95 seconds of AI requests inside agent runs · well under the 60 s health threshold"
          }
          empty={!data.some((x) => x.aiP95Seconds != null) && "No AI requests in the last 14 days"}
        >
          <ChartContainer config={latencyConfig} className={h}>
            <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              {axisX}
              {yAxis((v) => `${Math.round(v)} s`, maxLatency >= 30 ? 60 : undefined)}
              {tooltip}
              {maxLatency >= 30 ? (
                <ReferenceLine
                  y={60}
                  stroke="currentColor"
                  strokeOpacity={0.4}
                  strokeDasharray="4 4"
                />
              ) : null}
              <Line
                isAnimationActive={false}
                type="monotone"
                dataKey="aiP95Seconds"
                stroke="var(--color-aiP95Seconds)"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            </LineChart>
          </ChartContainer>
        </ChartPanel>

        {byAgent.length ? (
          <ChartPanel
            title="Runs by agent"
            subtitle="Last 7 days, completed and failed; plus runs active now"
            className="lg:col-span-2"
          >
            <ChartContainer
              config={agentsConfig}
              className="mt-3 aspect-auto w-full"
              style={{ height: Math.max(140, byAgent.length * 34 + 60) }}
            >
              <BarChart data={byAgent} layout="vertical" margin={{ left: 8, right: 16, top: 4 }}>
                <CartesianGrid horizontal={false} />
                <XAxis type="number" tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  width={150}
                  tick={{ fontSize: 12 }}
                />
                <ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar
                  isAnimationActive={false}
                  dataKey="done"
                  stackId="a"
                  stroke="var(--card)"
                  strokeWidth={2}
                  fill="var(--color-done)"
                  barSize={16}
                />
                <Bar
                  isAnimationActive={false}
                  dataKey="failed"
                  stackId="a"
                  stroke="var(--card)"
                  strokeWidth={2}
                  fill="var(--color-failed)"
                  barSize={16}
                />
                <Bar
                  isAnimationActive={false}
                  dataKey="active"
                  stackId="a"
                  stroke="var(--card)"
                  strokeWidth={2}
                  fill="var(--color-active)"
                  radius={[0, 4, 4, 0]}
                  barSize={16}
                />
              </BarChart>
            </ChartContainer>
          </ChartPanel>
        ) : null}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- agent cards */

type Element = { name: string; tab: DrawerTab; status: Status; line: string };

function elementsOf(a: AgentObservability, slaHours: number): Element[] {
  const activity = a.harness.runs7d + a.hitl.open + a.tools.calls7d + a.skills.requests7d;
  const base: Status = activity ? "good" : "idle";
  const budgetShare = a.budget.cap ? a.budget.monthTokens / a.budget.cap : null;
  return [
    {
      name: "Identity",
      tab: "identity",
      status: worst(a.issues, "definition", "good"),
      line: `v${a.version} · ${a.definition.versionsSeen} version(s) used · ${a.definition.changes30d} mid-run change(s) / 30 d`,
    },
    {
      name: "Harness",
      tab: "harness",
      status: worst(a.issues, "harness", base),
      line: `${a.harness.runs7d} runs · ${a.harness.failed7d} failed · avg ${a.harness.avgSteps ?? "—"} steps · p95 ${a.harness.p95RunMinutes ?? "—"} min`,
    },
    {
      name: "Human-in-the-loop",
      tab: "hitl",
      status: worst(a.issues, "hitl", base),
      line: `${a.hitl.open} open · ${a.hitl.overdue} past ${slaHours} h · ${pct(a.hitl.declined7d, a.hitl.decided7d)} declined · median ${mins(a.hitl.medianWaitMinutes)}`,
    },
    {
      name: "Tools",
      tab: "tools",
      status: worst(a.issues, "tools", base),
      line: `${a.tools.declared} assigned · ${a.tools.calls7d} calls · ${pct(a.tools.errors7d, a.tools.calls7d)} errors`,
    },
    {
      name: "AI skills",
      tab: "skills",
      status: worst(a.issues, "skills", base),
      line: `${a.skills.declared.length} skills · ${a.skills.requests7d} requests · p95 ${a.skills.p95Ms == null ? "—" : `${(a.skills.p95Ms / 1000).toFixed(1)} s`}`,
    },
    {
      name: "Evals",
      tab: "evals",
      status: a.evals.declared.length ? "good" : "critical",
      line: `${a.evals.declared.length} scenario(s) in CI`,
    },
    {
      name: "Budget",
      tab: "harness",
      status: worst(
        a.issues,
        "budget",
        budgetShare == null ? base : budgetShare >= 0.8 ? "warning" : "good",
      ),
      line: a.budget.cap
        ? `${pct(a.budget.monthTokens, a.budget.cap)} of ${compact(a.budget.cap)} this month`
        : `${compact(a.budget.monthTokens)} tokens this month · no cap`,
    },
    {
      name: "Audit",
      tab: "audit",
      status: worst(a.issues, "audit", base),
      line: `${a.audit.events7d} audit events / 7 d`,
    },
  ];
}

function AgentGrid({
  d,
  onOpen,
}: {
  d: ObservabilityView;
  onOpen: (agent: string, tab: DrawerTab) => void;
}) {
  const sorted = [...d.agents].sort(
    (x, y) =>
      Number(y.enabled) - Number(x.enabled) ||
      RANK[overallOf(y)] - RANK[overallOf(x)] ||
      y.harness.runs7d - x.harness.runs7d,
  );
  return (
    <section>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Agents · click a card or an element for tools, harness, skills, evals and audit
      </p>
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {sorted.map((a) => (
          <AgentCard
            key={a.type}
            a={a}
            slaHours={d.slaHours}
            onOpen={(tab) => onOpen(a.type, tab)}
          />
        ))}
      </div>
    </section>
  );
}

function overallOf(a: AgentObservability): Status {
  const activity = a.harness.runs7d + a.hitl.open + a.tools.calls7d + a.skills.requests7d;
  return a.issues.reduce<Status>(
    (w, i) => (RANK[i.severity] > RANK[w] ? i.severity : w),
    activity ? "good" : "idle",
  );
}

const AUTONOMY_LABEL: Record<string, string> = Object.fromEntries(
  AUTONOMY_OPTIONS.map((o) => [o.value, o.label]),
);

function AgentCard({
  a,
  slaHours,
  onOpen,
}: {
  a: AgentObservability;
  slaHours: number;
  onOpen: (tab: DrawerTab) => void;
}) {
  const overall = overallOf(a);
  const finished = a.harness.done7d + a.harness.failed7d;
  const els = elementsOf(a, slaHours);
  const metrics: [string, string][] = [
    ["Runs · 7 d", String(a.harness.runs7d)],
    ["Success", finished ? `${Math.round((a.harness.done7d / finished) * 100)}%` : "—"],
    ["Waiting", String(a.hitl.open)],
    ["Tool errors", pct(a.tools.errors7d, a.tools.calls7d)],
  ];
  return (
    <article
      className={`panel flex flex-col p-4 ${a.enabled ? "" : "opacity-75"}`}
      style={{
        borderTop: `3px solid ${overall === "idle" ? "var(--border)" : STATUS[overall].color}`,
      }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onOpen("identity")}
            className="text-left font-semibold hover:underline"
          >
            {a.name}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant={a.enabled ? "default" : "outline"} className="text-[11px]">
              {a.enabled ? (AUTONOMY_LABEL[a.autonomy] ?? a.autonomy) : "Off"}
            </Badge>
            <Badge variant="outline" className="num text-[11px]">
              v{a.version}
            </Badge>
            <Badge variant="outline" className="text-[11px]">
              {a.riskTier} risk
            </Badge>
          </div>
        </div>
        <StatusPill status={overall} label={overall === "idle" ? "No activity" : undefined} />
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        {metrics.map(([k, v]) => (
          <div key={k}>
            <p className="text-[11px] text-muted-foreground">{k}</p>
            <p className="num text-base font-semibold">{v}</p>
          </div>
        ))}
      </div>

      <div className="mt-2">
        <p className="text-[11px] text-muted-foreground">Runs per day · 14 days</p>
        <Sparkline values={a.harness.daily.map((x) => x.runs)} />
      </div>

      <ul className="mt-2 divide-y divide-border rounded-md border border-border">
        {els.map((e) => (
          <li key={e.name}>
            <button
              type="button"
              onClick={() => onOpen(e.tab)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-primary"
              aria-label={`${e.name} details`}
            >
              <ElementDot status={e.status} />
              <span className="w-28 shrink-0 font-medium">{e.name}</span>
              <span className="num min-w-0 flex-1 truncate text-muted-foreground" title={e.line}>
                {e.line}
              </span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </li>
        ))}
      </ul>

      {a.issues.length ? (
        <button
          type="button"
          onClick={() => onOpen("issues")}
          className="mt-2 space-y-0.5 text-left"
        >
          {a.issues.slice(0, 3).map((i) => (
            <p key={i.id} className="text-xs">
              <StatusPill status={i.severity} />{" "}
              <span className="text-muted-foreground">{i.title}</span>
            </p>
          ))}
        </button>
      ) : null}
    </article>
  );
}

function ElementDot({ status }: { status: Status }) {
  const s = STATUS[status];
  return (
    <s.Icon
      className={`size-3.5 shrink-0 ${status === "idle" ? "text-muted-foreground" : ""}`}
      style={status === "idle" ? undefined : { color: s.color }}
      aria-label={s.label}
    />
  );
}

/* ------------------------------------------------------------- issues */

function IssuesPanel({
  issues,
  rules,
}: {
  issues: IssueView[];
  rules: { id: string; element: string; severity: string; description: string }[];
}) {
  const qc = useQueryClient();
  const [showRules, setShowRules] = useState(false);
  const sorted = [...issues].sort((a, b) => RANK[b.severity] - RANK[a.severity]);

  async function ack(id: string) {
    try {
      await acknowledgeAgentIssue({ data: { issueId: id } });
      toast.success("Acknowledged — it stays listed until the condition clears");
      qc.invalidateQueries({ queryKey: ["agent_observability"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not acknowledge");
    }
  }

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Detected issues</h2>
        <span className="text-xs text-muted-foreground">
          Opened and resolved automatically by the health engine; every change is in the audit log.
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => setShowRules((v) => !v)}
        >
          {showRules ? "Hide rules" : `How issues are detected (${rules.length} rules)`}
        </Button>
      </div>
      {showRules ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Element</th>
                <th className="py-1 pr-3 font-medium">Rule</th>
                <th className="py-1 pr-3 font-medium">Severity</th>
                <th className="py-1 font-medium">Fires when</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="py-1.5 pr-3 text-xs">{r.element}</td>
                  <td className="py-1.5 pr-3">
                    <code className="text-xs">{r.id}</code>
                  </td>
                  <td className="py-1.5 pr-3">
                    <StatusPill status={r.severity as Status} />
                  </td>
                  <td className="py-1.5 text-xs text-muted-foreground">{r.description}</td>
                </tr>
              ))}
              <tr className="border-t border-border align-top">
                <td className="py-1.5 pr-3 text-xs">harness</td>
                <td className="py-1.5 pr-3">
                  <code className="text-xs">scheduler.heartbeat</code>
                </td>
                <td className="py-1.5 pr-3">
                  <StatusPill status="critical" />
                </td>
                <td className="py-1.5 text-xs text-muted-foreground">
                  No scheduler tick for more than 5 minutes (checked when this page or the bell
                  loads, since a stopped scheduler cannot report itself).
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
      {sorted.length ? (
        <ul className="mt-3 divide-y divide-border">
          {sorted.map((i) => (
            <li key={i.id} className="flex flex-wrap items-start gap-3 py-3">
              <div className="w-24 shrink-0 pt-0.5">
                <StatusPill status={i.severity} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{i.title}</p>
                <p className="text-xs text-muted-foreground">
                  {i.agentType === "*" ? "Orchestrator" : (AGENT_LABEL[i.agentType] ?? i.agentType)}{" "}
                  · {i.element} · <code>{i.rule}</code> · since{" "}
                  {new Date(i.firstSeenAt).toLocaleString()} · seen {i.occurrences}×
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{i.description}</p>
              </div>
              {i.status === "acknowledged" ? (
                <Badge variant="outline">Acknowledged</Badge>
              ) : (
                <Button size="sm" variant="outline" onClick={() => ack(i.id)}>
                  Acknowledge
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          <StatusPill status="good" label="No open issues" /> — all health rules pass.
        </p>
      )}
    </section>
  );
}
