/**
 * Agent intelligence (governance roles only): how the hiring agents behave —
 * a verdict, a fix list of only what needs action, a map of each agent's
 * failing tools and person checkpoints, and the per-agent table. Harness
 * governance is on /agents/governance; skill supply vs demand on
 * /skill-supply. Deterministic: no model calls; vendor- and model-neutral.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { PageHeader } from "@/components/ats";
import {
  Chip,
  FixList,
  Panel,
  Verdict,
  type FixRow,
  type Pill,
  type Status,
} from "@/components/ops-layout";
import { ReportBar, useReportWindow } from "@/components/report-bar";
import { agentActivityReport } from "@/lib/agent-governance.functions";
import { downloadBehaviourReport } from "@/lib/agent-reports";
import {
  agentIntelligence,
  type ActionPlanRow,
  type GEdge,
  type GNode,
} from "@/lib/agent-intelligence.functions";

export const Route = createFileRoute("/agents/intelligence")({
  head: () => ({
    meta: [
      { title: "Agent intelligence — ATSIQ" },
      {
        name: "description",
        content:
          "Which hiring agents are working, where people overrule them, and which tools fail.",
      },
    ],
  }),
  component: IntelligencePage,
});

/* ------------------------------------------------------------- map */

const COLUMNS = [
  { title: "Where it fails", types: ["failure"] },
  { title: "Agents that ran", types: ["agent", "hub"] },
  { title: "Person checkpoints", types: ["norm"] },
];
const NODE_COLOR: Record<string, string> = {
  agent: "#2a78d6",
  norm: "#eb6834",
  failure: "#d03b3b",
  hub: "#898781",
};
const EDGE_STYLE: Record<string, { color: string; width: number; dash?: string }> = {
  gated: { color: "#b6b4ab", width: 1.8 },
  errored: { color: "#d03b3b", width: 1.6, dash: "6 4" },
  gap: { color: "#e3a21a", width: 1.6, dash: "3 3" },
};
const PILL_W = 230,
  PILL_H = 40,
  ROW = 50,
  HEAD = 30,
  VB_W = 900;

const nice = (s: string) => s.replace(/_/g, " ");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function nodeSub(n: GNode): string {
  switch (n.type) {
    case "agent":
      return `${n.runs ?? 0} run${n.runs === 1 ? "" : "s"}${n.awaiting ? ` · ${n.awaiting} waiting` : ""}`;
    case "norm":
      return `${n.stops ?? 0} check${n.stops === 1 ? "" : "s"}${n.rejected ? ` · ${n.rejected} declined` : ""}`;
    case "hub":
      return `${n.members?.length ?? 0} agents`;
    case "failure":
      return "failed tool calls";
    default:
      return "";
  }
}

function AgentMap({
  nodes,
  edges,
  onSelect,
}: {
  nodes: GNode[];
  edges: GEdge[];
  onSelect: (n: GNode) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const pool = nodes.filter((n) => !n.idle && n.id !== "hub-idle");
  const columns = COLUMNS.map((c) =>
    pool
      .filter((n) => (n.id === "hub-gap" ? c.types.includes("failure") : c.types.includes(n.type)))
      .sort(
        (a, b) =>
          (b.runs ?? b.stops ?? 0) - (a.runs ?? a.stops ?? 0) || a.name.localeCompare(b.name),
      ),
  );
  const rows = Math.max(1, ...columns.map((c) => c.length));
  const H = HEAD + rows * ROW + 6;
  const gap = (VB_W - 20 - PILL_W) / (COLUMNS.length - 1);
  const pos = new Map<string, { x: number; y: number; col: number }>();
  columns.forEach((list, ci) => {
    const offset = ((rows - list.length) * ROW) / 2;
    list.forEach((n, ri) =>
      pos.set(n.id, { x: 10 + ci * gap, y: HEAD + offset + ri * ROW, col: ci }),
    );
  });
  const links = edges.filter(
    (e) => pos.has(e.s) && pos.has(e.t) && pos.get(e.s)!.col !== pos.get(e.t)!.col,
  );
  const touches = (id: string) =>
    !active ||
    id === active ||
    links.some((l) => (l.s === active && l.t === id) || (l.t === active && l.s === id));

  if (!pool.some((n) => n.type === "agent"))
    return <p className="px-4 py-6 text-sm text-muted-foreground">No agent ran in this period.</p>;

  return (
    <svg viewBox={`0 0 ${VB_W} ${H}`} className="block w-full" role="img" aria-label="Agent map">
      {COLUMNS.map((c, ci) => (
        <text
          key={c.title}
          x={10 + ci * gap}
          y={16}
          fontSize={11}
          fontWeight={600}
          className="fill-muted-foreground"
        >
          {c.title.toUpperCase()}
        </text>
      ))}
      {links.map((l, i) => {
        let a = pos.get(l.s)!,
          b = pos.get(l.t)!;
        if (a.col > b.col) [a, b] = [b, a];
        const x1 = a.x + PILL_W,
          y1 = a.y + PILL_H / 2,
          x2 = b.x,
          y2 = b.y + PILL_H / 2,
          mx = (x1 + x2) / 2;
        const st = EDGE_STYLE[l.k] ?? EDGE_STYLE["gated"]!;
        const on = !active || l.s === active || l.t === active;
        return (
          <g key={i} opacity={on ? 1 : 0.1}>
            <path
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
              stroke={st.color}
              strokeWidth={on && active ? st.width + 1 : st.width}
              strokeDasharray={st.dash}
            />
            {l.label && (
              <text
                x={mx}
                y={(y1 + y2) / 2 - 4}
                fontSize={10.5}
                textAnchor="middle"
                fontWeight={600}
                fill={st.color === "#b6b4ab" ? "#66655e" : st.color}
                paintOrder="stroke"
                stroke="var(--background, #fff)"
                strokeWidth={3}
              >
                {l.label}
              </text>
            )}
          </g>
        );
      })}
      {[...pos.entries()].map(([id, p]) => {
        const n = pool.find((x) => x.id === id)!;
        const sub = nodeSub(n);
        return (
          <g
            key={id}
            transform={`translate(${p.x},${p.y})`}
            opacity={touches(id) ? 1 : 0.3}
            className="cursor-pointer"
            role="button"
            tabIndex={0}
            aria-label={`${nice(n.name)}: ${sub}`}
            onMouseEnter={() => setActive(id)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(id)}
            onBlur={() => setActive(null)}
            onClick={() => onSelect(n)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelect(n);
            }}
          >
            <rect
              width={PILL_W}
              height={PILL_H}
              rx={8}
              className="fill-card stroke-border"
              strokeDasharray={n.type === "hub" ? "4 3" : undefined}
            />
            <rect
              width={4}
              height={PILL_H - 12}
              x={6}
              y={6}
              rx={2}
              fill={NODE_COLOR[n.type] ?? "#898781"}
            />
            <text x={18} y={17} fontSize={12} fontWeight={600} className="fill-foreground">
              {clip(n.type === "failure" ? nice(n.name) : nice(n.name), 30)}
            </text>
            <text x={18} y={31} fontSize={10.5} className="fill-muted-foreground">
              {clip(sub, 36)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------- verdict + fix list from the action plan */

const STATE_WORD: Record<string, string> = {
  "out of sync": "people overrule it",
  failing: "tools failing",
  flaky: "some tool failures",
  "no trace": "not step-traced",
  waiting: "waiting for a person",
  healthy: "healthy",
  clean: "clean",
  idle: "never run",
};

function fixFor(p: ActionPlanRow): FixRow | null {
  const agents = [p.name];
  switch (p.state) {
    case "out of sync":
      return {
        severity: "act",
        what: `People declined ${p.overturned} of ${p.stops} proposals`,
        why: "The agent's judgment is out of step with your reviewers — fix the proposal or the threshold, not the reviewer.",
        agents,
        next: { label: "See what was declined", to: "#declined" },
      };
    case "failing":
      return {
        severity: "act",
        what: `${p.errors} failed tool calls`,
        why: "Watch the next runs; if the count keeps rising, ask your admin to check that tool.",
        agents,
        next: { label: "See the runs", to: "/agents", search: { tab: "activity" } },
      };
    case "flaky":
      return {
        severity: "watch",
        what: `${p.errors} failed tool calls`,
        why: "Watch the next runs; if the count keeps rising, ask your admin to check that tool.",
        agents,
        next: { label: "See the runs", to: "/agents", search: { tab: "activity" } },
      };
    case "no trace":
      return {
        severity: "watch",
        what: "Runs as a live call — not step-traced",
        why: "The automatic checks cannot see inside the call; review its transcripts.",
        agents,
        next: { label: "See the runs", to: "/agents", search: { tab: "activity" } },
      };
    case "waiting":
      return {
        severity: "watch",
        what: `${p.awaiting} run${p.awaiting === 1 ? "" : "s"} waiting for a person`,
        why: "The agent is paused until someone decides.",
        agents,
        next: { label: "Open Waiting for you", to: "/agents" },
      };
    default:
      return null;
  }
}

function IntelligencePage() {
  const [selected, setSelected] = useState<GNode | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [showIdle, setShowIdle] = useState(false);
  const rw = useReportWindow({ withAgent: true });
  const q = useQuery({
    queryKey: ["agent-intelligence", rw.window],
    queryFn: () => agentIntelligence({ data: rw.window }),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  const b = q.data?.views.behavior;
  // the agent list stays complete while one agent is selected
  const allAgents = useRef<string[]>([]);
  if (q.data && !q.data.window.agent && q.data.window.modality === "all")
    allAgents.current = q.data.views.behavior.plan.map((p) => p.name).sort();

  const plan = b?.plan ?? [];
  const has = (...states: string[]) => plan.filter((p) => states.includes(p.state));
  const failRate = b ? b.fleet.failed / Math.max(b.fleet.runs, 1) : 0;
  const quiet = !!b && b.fleet.runs === 0;
  const pills: Pill[] = quiet
    ? ["Overruled", "Tools", "Runs", "Traced", "Waiting"].map((label) => ({
        key: label.toLowerCase(),
        label,
        status: "none" as const,
      }))
    : b
      ? [
          {
            key: "overruled",
            label: "Overruled",
            status: has("out of sync").length ? "bad" : "good",
          },
          {
            key: "tools",
            label: "Tools",
            status: has("failing").length ? "bad" : has("flaky").length ? "warn" : "good",
          },
          {
            key: "runs",
            label: "Runs",
            status: failRate >= 0.25 ? "bad" : failRate >= 0.1 ? "warn" : "good",
          },
          { key: "traced", label: "Traced", status: has("no trace").length ? "warn" : "good" },
          { key: "waiting", label: "Waiting", status: has("waiting").length ? "warn" : "good" },
        ]
      : [];
  const PILL_STATES: Record<string, string[]> = {
    overruled: ["out of sync"],
    tools: ["failing", "flaky"],
    traced: ["no trace"],
    waiting: ["waiting"],
  };
  const fixes: FixRow[] = (check && PILL_STATES[check] ? has(...PILL_STATES[check]!) : plan)
    .map(fixFor)
    .filter((f): f is FixRow => f !== null);
  if (b && failRate >= 0.1 && (!check || check === "runs"))
    fixes.push({
      severity: failRate >= 0.25 ? "act" : "watch",
      what: `${b.fleet.failed} of ${b.fleet.runs} runs failed`,
      why: `${b.fleet.cancelled} more ${b.fleet.cancelled === 1 ? "was" : "were"} cancelled. Look at the failed runs and retry or report them.`,
      agents: [],
      next: { label: "See the runs", to: "/agents", search: { tab: "activity" } },
    });
  fixes.sort((x, y) => Number(x.severity === "watch") - Number(y.severity === "watch"));
  const clean = plan.filter((p) => p.state === "clean" || p.state === "healthy");
  const idle = plan.filter((p) => p.state === "idle");
  const rows = showIdle ? plan : plan.filter((p) => p.state !== "idle");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Agent intelligence"
        description="Which agents are working, where your people overrule them, and which tools fail."
        actions={
          <ReportBar
            rw={rw}
            agents={allAgents.current}
            disabled={!b}
            onDownload={async (kind) => {
              if (!q.data) return;
              const activity = await agentActivityReport({ data: rw.window });
              downloadBehaviourReport(kind, q.data, activity, rw.window, fixes);
            }}
          />
        }
      />
      {!b && (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          {q.isError ? "Agent intelligence is available to the HR head and CBO." : "Loading…"}
        </p>
      )}
      {b && (
        <>
          <Verdict
            pills={pills}
            active={check}
            onPick={setCheck}
            okText={quiet ? "No agent activity in this period" : "Your agents are behaving"}
            neutral={quiet}
          />
          <FixList
            rows={fixes}
            filterLabel={check ? pills.find((p) => p.key === check)?.label.toLowerCase() : null}
            onClearFilter={() => setCheck(null)}
            passing={{
              count: clean.length,
              summary: [
                clean.length ? `${clean.length} agent${clean.length === 1 ? "" : "s"} clean` : "",
                idle.length ? `${idle.length} never run` : "",
              ].filter(Boolean),
            }}
          />

          <Panel
            title="Agents, their checkpoints and failures"
            hint="Hover to trace · click a box for details"
          >
            <div className="px-2 pt-2">
              <AgentMap nodes={b.nodes} edges={b.edges} onSelect={setSelected} />
            </div>
            {selected && (
              <div className="border-t border-border bg-muted/30 px-4 py-3 text-[13px]">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold capitalize">{nice(selected.name)}</p>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setSelected(null)}
                  >
                    Close
                  </button>
                </div>
                {selected.cause && <p className="mt-1 text-muted-foreground">{selected.cause}</p>}
                {selected.effect && <p className="mt-1 text-muted-foreground">{selected.effect}</p>}
                {selected.action && (
                  <p className="mt-1">
                    <b>Next:</b> {selected.action}
                  </p>
                )}
                {selected.members && selected.members.length > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    {selected.members.map(nice).join(", ")}
                  </p>
                )}
              </div>
            )}
          </Panel>

          <Panel
            title="Agents"
            hint={`${rows.length} shown${idle.length && !showIdle ? ` · ${idle.length} never run (hidden)` : ""}`}
          >
            <table className="mt-2 w-full text-[13px] tabular-nums">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Agent</th>
                  <th className="px-4 py-2 font-medium">State</th>
                  <th className="px-4 py-2 text-right font-medium">Runs</th>
                  <th className="px-4 py-2 text-right font-medium">Person checks</th>
                  <th className="px-4 py-2 text-right font-medium">Declined</th>
                  <th className="px-4 py-2 text-right font-medium">Failed calls</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const st: Status =
                    p.pri === "high"
                      ? "bad"
                      : p.pri === "medium"
                        ? "warn"
                        : p.state === "idle"
                          ? "none"
                          : "good";
                  return (
                    <tr key={p.name} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-semibold capitalize">{nice(p.name)}</td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className={`inline-block size-2.5 rounded-full ${st === "bad" ? "bg-red-500" : st === "warn" ? "bg-amber-500" : st === "good" ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
                          />
                          {STATE_WORD[p.state] ?? p.state}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">{p.runs}</td>
                      <td className="px-4 py-2.5 text-right">{p.stops}</td>
                      <td
                        className={`px-4 py-2.5 text-right ${p.overturned ? "font-semibold text-red-600" : ""}`}
                      >
                        {p.overturned}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right ${p.errors >= 3 ? "font-semibold text-amber-600" : ""}`}
                      >
                        {p.errors}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {idle.length > 0 && (
              <button
                type="button"
                onClick={() => setShowIdle((v) => !v)}
                className="w-full border-t border-border px-4 py-2 text-left text-xs font-medium text-primary hover:bg-muted/40"
              >
                {showIdle
                  ? "Hide agents that never ran"
                  : `Show ${idle.length} agent${idle.length === 1 ? "" : "s"} that never ran`}
              </button>
            )}
          </Panel>

          {b.rejects.length > 0 && (
            <div id="declined" className="scroll-mt-4">
              <Panel title="What people declined" hint="Grouped by proposal">
                <ul className="divide-y divide-border text-[13px]">
                  {b.rejects.map((r, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="flex items-center gap-2">
                        <Chip>{nice(r.agentType)}</Chip>
                        {r.title}
                      </span>
                      <b className="tabular-nums">×{r.count}</b>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          )}
        </>
      )}
    </div>
  );
}
