import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  OctagonX,
} from "lucide-react";

import { PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  acknowledgeAgentIssue,
  agentObservability,
  type AgentObservability,
  type IssueView,
  type ObservabilityView,
} from "@/lib/agents-observability.functions";
import { AGENT_LABEL } from "@/lib/agents.catalog";
import { AgentDetailDrawer, type DrawerTab } from "@/components/AgentDetailDrawer";

export const Route = createFileRoute("/agents/observability")({
  head: () => ({
    meta: [
      { title: "Agent observability — ATSIQ" },
      {
        name: "description",
        content:
          "Activity, performance and health of every hiring agent, element by element, with detected issues.",
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
        description="How every hiring agent is behaving and performing, element by element — identity and definition, tools, AI skills, evals, harness, human-in-the-loop, budget and audit — with the issues the health engine has detected."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/agents/register">Agent register</Link>
          </Button>
        }
      />

      {q.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : q.error || !d ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {q.error instanceof Error ? q.error.message : "Not available."}
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          <SchedulerBanner s={d.scheduler} />
          <KpiRow d={d} />
          <IssuesPanel
            issues={[...d.orgIssues, ...d.agents.flatMap((a) => a.issues)]}
            rules={d.rules}
          />
          {d.agents.map((a) => (
            <AgentPanel
              key={a.type}
              a={a}
              slaHours={d.slaHours}
              onOpen={(tab) => setOpen({ agent: a.type, tab })}
            />
          ))}
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

function SchedulerBanner({
  s,
}: {
  s: { lastTickAt: string | null; minutesSinceTick: number | null; healthy: boolean };
}) {
  return (
    <section className="panel flex flex-wrap items-center gap-3 p-4">
      <Activity className="size-4 text-muted-foreground" aria-hidden />
      <span className="text-sm font-medium">Agent scheduler</span>
      <StatusPill
        status={s.healthy ? "good" : "critical"}
        label={s.healthy ? "Running" : s.lastTickAt ? "Stopped" : "Never ran"}
      />
      <span className="num text-xs text-muted-foreground">
        {s.lastTickAt
          ? `last tick ${s.minutesSinceTick} min ago (${new Date(s.lastTickAt).toLocaleString()})`
          : "no tick recorded — register /api/public/agent-tick in the scheduler"}
      </span>
      <span className="ml-auto text-xs text-muted-foreground">
        Health rules are evaluated every 5 minutes by the scheduler.
      </span>
    </section>
  );
}

function Tile({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="panel p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num mt-1 text-2xl font-semibold">{value}</p>
      {children}
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function KpiRow({ d }: { d: ObservabilityView }) {
  const t = d.totals;
  const issueCount = t.issues.critical + t.issues.serious + t.issues.warning;
  return (
    <section>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        All agents · last 7 days
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Tile label="Runs" value={t.runs7d.toLocaleString()} />
        <Tile
          label="Success rate"
          value={t.successRate == null ? "—" : `${Math.round(t.successRate * 100)}%`}
          hint="Finished runs that completed"
        />
        <Tile label="Tokens" value={t.tokens7d.toLocaleString()} hint="Incl. AI inside tools" />
        <Tile
          label="Waiting on people"
          value={String(t.openRequests)}
          hint={`${t.overdueRequests} past the ${d.slaHours} h SLA`}
        />
        <Tile label="Median wait for a person" value={mins(t.medianWaitMinutes)} />
        <Tile label="Open issues" value={String(issueCount)}>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            <StatusPill status="critical" label={`${t.issues.critical} critical`} />
            <StatusPill status="serious" label={`${t.issues.serious} serious`} />
            <StatusPill status="warning" label={`${t.issues.warning} warning`} />
          </div>
        </Tile>
      </div>
    </section>
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

/* -------------------------------------------------------- agent panel */

function ElementCell({
  name,
  status,
  lines,
  onClick,
}: {
  name: string;
  status: Status;
  lines: string[];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-border p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-primary"
      aria-label={`${name} details`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {name}
        </p>
        <StatusPill status={status} />
      </div>
      {lines.map((l) => (
        <p key={l} className="num mt-1 text-xs">
          {l}
        </p>
      ))}
    </button>
  );
}

function RunsChart({ daily }: { daily: { day: string; runs: number; failed: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!daily.length) {
    return <p className="text-xs text-muted-foreground">No runs in the last 14 days.</p>;
  }
  const max = Math.max(1, ...daily.map((d) => d.runs));
  const W = 280;
  const H = 72;
  const gap = 2;
  const bw = (W - gap * (daily.length - 1)) / daily.length;
  const h = hover != null ? daily[hover] : null;
  return (
    <div className="relative">
      <p className="mb-1 text-xs text-muted-foreground">Runs started per day · 14 days</p>
      <svg
        viewBox={`0 0 ${W} ${H + 14}`}
        className="w-full max-w-[320px]"
        role="img"
        aria-label="Runs per day"
      >
        <line x1={0} x2={W} y1={H} y2={H} stroke="currentColor" strokeOpacity={0.15} />
        {daily.map((d, i) => {
          const bh = d.runs ? Math.max(3, (d.runs / max) * (H - 4)) : 0;
          const x = i * (bw + gap);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={0} width={bw} height={H} fill="transparent" />
              {bh ? (
                <path
                  d={`M${x},${H} V${H - bh + 2} Q${x},${H - bh} ${x + 2},${H - bh} H${x + bw - 2} Q${x + bw},${H - bh} ${x + bw},${H - bh + 2} V${H} Z`}
                  fill="var(--primary)"
                  opacity={hover == null || hover === i ? 1 : 0.45}
                />
              ) : null}
            </g>
          );
        })}
        <text x={0} y={H + 12} fontSize={9} fill="currentColor" opacity={0.6}>
          {daily[0]!.day.slice(5)}
        </text>
        <text x={W} y={H + 12} fontSize={9} fill="currentColor" opacity={0.6} textAnchor="end">
          {daily[daily.length - 1]!.day.slice(5)}
        </text>
      </svg>
      {h ? (
        <div className="num pointer-events-none absolute right-0 top-0 rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-sm">
          {h.day}: {h.runs} run(s){h.failed ? ` · ${h.failed} failed` : ""}
        </div>
      ) : null}
    </div>
  );
}

function AgentPanel({
  a,
  slaHours,
  onOpen,
}: {
  a: AgentObservability;
  slaHours: number;
  onOpen: (tab: DrawerTab) => void;
}) {
  const activity = a.harness.runs7d + a.hitl.open + a.tools.calls7d + a.skills.requests7d;
  const base: Status = activity ? "good" : "idle";
  const budgetShare = a.budget.cap ? a.budget.monthTokens / a.budget.cap : null;
  const budgetStatus: Status = worst(
    a.issues,
    "budget",
    budgetShare == null ? base : budgetShare >= 0.8 ? "warning" : "good",
  );
  const toolRate = a.tools.calls7d ? a.tools.errors7d / a.tools.calls7d : 0;
  const aiRate = a.skills.requests7d ? a.skills.errors7d / a.skills.requests7d : 0;
  const overall = a.issues.reduce<Status>(
    (w, i) => (RANK[i.severity] > RANK[w] ? i.severity : w),
    activity ? "good" : "idle",
  );

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{a.name}</h2>
        <Badge variant="outline" className="num">
          v{a.version}
        </Badge>
        <Badge variant="outline">{a.riskTier} risk</Badge>
        <Badge variant={a.enabled ? "default" : "outline"}>
          {a.enabled ? `On · ${a.autonomy.replace(/_/g, " ")}` : "Off"}
        </Badge>
        <span className="ml-auto flex items-center gap-3">
          <StatusPill status={overall} label={overall === "idle" ? "No activity yet" : undefined} />
          <Button size="sm" variant="outline" onClick={() => onOpen("identity")}>
            Details
          </Button>
        </span>
      </div>

      <div className="mt-4 grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <ElementCell
            name="Identity & definition"
            onClick={() => onOpen("identity")}
            status={worst(a.issues, "definition", "good")}
            lines={[
              `owner ${a.owner.replace(/_/g, " ")} · hash ${a.hash.slice(0, 10)}`,
              `${a.definition.versionsSeen} version(s) used · ${a.definition.changes30d} mid-run change(s) / 30 d`,
            ]}
          />
          <ElementCell
            name="Harness"
            onClick={() => onOpen("harness")}
            status={worst(a.issues, "harness", base)}
            lines={[
              `${a.harness.runs7d} runs · ${a.harness.done7d} done · ${a.harness.failed7d} failed`,
              `${a.harness.active} active · avg ${a.harness.avgSteps ?? "—"} steps · p95 ${a.harness.p95RunMinutes ?? "—"} min`,
            ]}
          />
          <ElementCell
            name="Human-in-the-loop"
            onClick={() => onOpen("hitl")}
            status={worst(a.issues, "hitl", base)}
            lines={[
              `${a.hitl.open} open · ${a.hitl.overdue} past ${slaHours} h SLA`,
              `${a.hitl.decided7d} decided · ${pct(a.hitl.declined7d, a.hitl.decided7d)} declined · ${pct(a.hitl.edited7d, a.hitl.approved7d)} edited · median ${mins(a.hitl.medianWaitMinutes)}`,
            ]}
          />
          <ElementCell
            name="Tools"
            onClick={() => onOpen("tools")}
            status={worst(a.issues, "tools", base)}
            lines={[
              `${a.tools.declared} assigned · ${a.tools.calls7d} calls`,
              `${a.tools.errors7d} errors (${pct(a.tools.errors7d, a.tools.calls7d)})${toolRate > 0.2 ? " — high" : ""}`,
            ]}
          />
          <ElementCell
            name="AI skills"
            onClick={() => onOpen("skills")}
            status={worst(a.issues, "skills", base)}
            lines={[
              `${a.skills.declared.length} skills · ${a.skills.requests7d} requests · ${a.skills.tokens7d.toLocaleString()} tokens`,
              `${pct(a.skills.errors7d, a.skills.requests7d)} errors${aiRate > 0.2 ? " — high" : ""} · p95 ${a.skills.p95Ms == null ? "—" : `${(a.skills.p95Ms / 1000).toFixed(1)} s`}`,
            ]}
          />
          <ElementCell
            name="Evals"
            onClick={() => onOpen("evals")}
            status={a.evals.declared.length ? "good" : "critical"}
            lines={[
              `${a.evals.declared.length} scenario(s) run in CI on every change`,
              a.evals.declared[0] ? a.evals.declared[0].slice(0, 60) : "none — CI blocks this",
            ]}
          />
          <ElementCell
            name="Budget"
            onClick={() => onOpen("harness")}
            status={budgetStatus}
            lines={[
              `${a.budget.monthTokens.toLocaleString()} tokens this month`,
              a.budget.cap
                ? `${pct(a.budget.monthTokens, a.budget.cap)} of ${a.budget.cap.toLocaleString()} cap`
                : "no cap set",
            ]}
          />
          <ElementCell
            name="Audit"
            onClick={() => onOpen("audit")}
            status={worst(a.issues, "audit", base)}
            lines={[
              `${a.audit.events7d} agent audit events / 7 d`,
              a.audit.byAction
                .sort((x, y) => y.n - x.n)
                .slice(0, 2)
                .map((x) => `${x.action.replace("agent.", "")} ${x.n}`)
                .join(" · ") || "—",
            ]}
          />
          <ElementCell
            name="Orchestration"
            onClick={() => onOpen("issues")}
            status={base}
            lines={[
              `${a.harness.budgetPaused} paused at budget`,
              `${a.issues.length} open issue(s)`,
            ]}
          />
        </div>

        <div className="space-y-4">
          <RunsChart daily={a.harness.daily} />
          {a.tools.byTool.length ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">
                Busiest tools · 7 days ·{" "}
                <button type="button" className="underline" onClick={() => onOpen("tools")}>
                  all {a.tools.declared} assigned tools
                </button>
              </p>
              <table className="w-full text-xs">
                <tbody>
                  {a.tools.byTool.map((t) => (
                    <tr key={t.tool} className="border-t border-border">
                      <td className="py-1 pr-2">
                        <code>{t.tool}</code>
                      </td>
                      <td className="num py-1 pr-2 text-right">{t.calls} calls</td>
                      <td className="num py-1 text-right">
                        {t.errors ? (
                          <StatusPill status="serious" label={`${t.errors} errors`} />
                        ) : (
                          "0 errors"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {a.issues.length ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Open issues</p>
              <ul className="space-y-1">
                {a.issues.map((i) => (
                  <li key={i.id} className="text-xs">
                    <StatusPill status={i.severity} /> {i.title}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
