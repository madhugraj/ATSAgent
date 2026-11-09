/**
 * Agent governance page body: a verdict with five check pills, a fix list of
 * only what needs action, the hand-off map (lifecycle events routed by the
 * orchestrator and direct start_agent delegation) and an agent × check matrix.
 */
import { Fragment, useState } from "react";

import { Dot, FixList, Panel, Verdict, type Pill, type Status } from "@/components/ops-layout";

import type {
  CheckKey,
  CheckTone,
  Harness,
  HarnessHandoffEdge,
  HarnessHandoffNode,
} from "@/lib/agent-governance.functions";

const nice = (s: string) => s.replace(/_/g, " ");

/* ---- hand-off map: what started each agent (left) → agent started (right) */
const PILL_W = 230,
  PILL_H = 40,
  ROW = 50,
  HEAD = 30,
  VB_W = 860;

const COL_X = [10, 315, 620];
const COL_TITLE = ["PUBLISHED BY", "EVENT", "AGENT STARTED"];
const COL_OF: Record<HarnessHandoffNode["type"], number> = { publisher: 0, event: 1, agent: 2 };
const EDGE_COLOR: Record<HarnessHandoffEdge["k"], string> = {
  publish: "#b6b4ab",
  start: "#9a988f",
  delegate: "#7c5cff",
};

function nodeSub(n: HarnessHandoffNode) {
  if (n.type === "publisher")
    return `${n.count} hand-off${n.count === 1 ? "" : "s"} out${n.failed ? ` · ${n.failed} failed` : ""}`;
  if (n.type === "event") return `published ${n.count}×${n.failed ? ` · ${n.failed} failed` : ""}`;
  return `${n.count} run${n.count === 1 ? "" : "s"} started${n.failed ? ` · ${n.failed} failed` : ""}`;
}

function HandoffMap({
  nodes,
  edges,
}: {
  nodes: HarnessHandoffNode[];
  edges: HarnessHandoffEdge[];
}) {
  const [active, setActive] = useState<string | null>(null);
  if (nodes.length === 0)
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        No events have been published and no agent has started another yet.
      </p>
    );
  const cols = [0, 1, 2].map((c) =>
    nodes
      .filter((n) => COL_OF[n.type] === c)
      .sort(
        (a, b) =>
          Number(a.id === "pub-unrecorded") - Number(b.id === "pub-unrecorded") ||
          b.count - a.count,
      ),
  );
  const rows = Math.max(...cols.map((c) => c.length));
  const H = HEAD + rows * ROW;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((list, c) =>
    list.forEach((n, i) =>
      pos.set(n.id, { x: COL_X[c]!, y: HEAD + ((rows - list.length) * ROW) / 2 + i * ROW }),
    ),
  );
  const peak = Math.max(1, ...edges.map((e) => e.runs));
  const on = (e: HarnessHandoffEdge) => !active || e.s === active || e.t === active;
  const lit = (id: string) =>
    !active || id === active || edges.some((e) => on(e) && (e.s === id || e.t === id));
  return (
    <svg
      viewBox={`0 0 ${VB_W} ${H}`}
      className="block w-full"
      role="img"
      aria-label="Agent hand-off map"
    >
      {COL_TITLE.map((t, c) => (
        <text
          key={t}
          x={COL_X[c]}
          y={16}
          fontSize={11}
          fontWeight={600}
          className="fill-muted-foreground"
        >
          {t}
        </text>
      ))}
      {edges.map((e) => {
        const a = pos.get(e.s),
          b = pos.get(e.t);
        if (!a || !b) return null;
        const x1 = a.x + PILL_W,
          y1 = a.y + PILL_H / 2,
          x2 = b.x,
          y2 = b.y + PILL_H / 2,
          mx = (x1 + x2) / 2;
        const bad = e.failed > 0;
        return (
          <g key={`${e.s}>${e.t}`} opacity={on(e) ? 1 : 0.08}>
            <path
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
              stroke={bad ? "#d03b3b" : EDGE_COLOR[e.k]}
              strokeWidth={1.2 + (e.runs / peak) * 4}
              strokeDasharray={e.k === "delegate" ? "6 4" : undefined}
            />
            {(active || e.k !== "publish") && (
              <text
                x={mx}
                y={(y1 + y2) / 2 - 5}
                fontSize={10.5}
                fontWeight={600}
                textAnchor="middle"
                fill={bad ? "#d03b3b" : "#66655e"}
                paintOrder="stroke"
                stroke="var(--background, #fff)"
                strokeWidth={3}
              >
                ×{e.runs}
                {bad ? ` · ${e.failed} failed` : ""}
              </text>
            )}
          </g>
        );
      })}
      {cols.flat().map((n) => {
        const p = pos.get(n.id)!;
        const color =
          n.type === "event"
            ? "#9a988f"
            : n.type === "agent"
              ? "#2a78d6"
              : n.id.startsWith("pub-") && !["pub-person", "pub-unrecorded"].includes(n.id)
                ? "#7c5cff"
                : "#c3c2b7";
        const sub = nodeSub(n);
        return (
          <g
            key={n.id}
            transform={`translate(${p.x},${p.y})`}
            opacity={lit(n.id) ? 1 : 0.3}
            className="cursor-pointer"
            onMouseEnter={() => setActive(n.id)}
            onMouseLeave={() => setActive(null)}
            tabIndex={0}
            onFocus={() => setActive(n.id)}
            onBlur={() => setActive(null)}
            role="button"
            aria-label={`${nice(n.name)}: ${sub}`}
          >
            <rect width={PILL_W} height={PILL_H} rx={8} className="fill-card stroke-border" />
            <rect width={4} height={PILL_H - 12} x={6} y={6} rx={2} fill={color} />
            <text x={18} y={17} fontSize={12} fontWeight={600} className="fill-foreground">
              {n.type === "event" ? n.name.replace(/[._]/g, " ") : nice(n.name)}
            </text>
            <text
              x={18}
              y={31}
              fontSize={10.5}
              className={n.failed ? "fill-red-600" : "fill-muted-foreground"}
            >
              {sub}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const CHECKS: { key: CheckKey; label: string; q: string }[] = [
  { key: "limits", label: "Limits", q: "limits" },
  { key: "autonomy", label: "Autonomy", q: "autonomy" },
  { key: "definition", label: "Definitions", q: "definitions" },
  { key: "handoffs", label: "Hand-offs", q: "handoffs" },
  { key: "budget", label: "Budget", q: "budget" },
];
const TONE_STATUS: Record<CheckTone, Status> = {
  bad: "bad",
  warn: "warn",
  good: "good",
  none: "none",
};
const AUTONOMY_WORD: Record<string, string> = {
  suggest: "asks first",
  act_and_notify: "acts, then tells",
  autonomous: "fully autonomous",
};

export function AgentGovernancePanel({ h }: { h: Harness }) {
  const [check, setCheck] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showOff, setShowOff] = useState(false);
  const pills: Pill[] = CHECKS.map((c) => ({
    key: c.key,
    label: c.label,
    status: TONE_STATUS[h.questions.find((q) => q.key === c.q)?.tone ?? "none"],
  }));
  const fixes = check ? h.fixes.filter((f) => f.check === check) : h.fixes;
  const rows = showOff ? h.agents : h.agents.filter((a) => a.enabled || a.runs > 0);
  const hidden = h.agents.length - rows.length;
  const ho = h.handoffs;
  return (
    <div className="space-y-4">
      <Verdict pills={pills} active={check} onPick={setCheck} okText="The harness is holding" />

      <FixList
        rows={fixes}
        passing={h.passing}
        filterLabel={check ? CHECKS.find((c) => c.key === check)?.label.toLowerCase() : null}
        onClearFilter={() => setCheck(null)}
      />

      <Panel title="How agents hand work to each other" hint="Hover a box to trace its path">
        <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 pt-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block w-4 border-t-2 border-[#b6b4ab]" />
            publishes
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block w-4 border-t-2 border-[#9a988f]" />
            starts
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block w-4 border-t-2 border-dashed border-[#7c5cff]" />
            delegates (agent → agent)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block w-4 border-t-2 border-red-500" />
            failed
          </span>
        </div>
        <HandoffMap nodes={ho.nodes} edges={ho.edges} />
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
          <span>
            <b className="text-foreground">{ho.chainedRuns}</b> run{ho.chainedRuns === 1 ? "" : "s"}{" "}
            started by another agent
          </span>
          {ho.longest && ho.longest.depth > 1 && (
            <span>
              Longest chain:{" "}
              <b className="capitalize text-foreground">{ho.longest.path.map(nice).join(" → ")}</b>
            </span>
          )}
          <span className={ho.loops.length ? "text-red-600" : ""}>
            <b className={ho.loops.length ? "" : "text-foreground"}>{ho.loops.length}</b> loop
            {ho.loops.length === 1 ? "" : "s"}
          </span>
          <span className={ho.events.dead ? "text-red-600" : ""}>
            <b className={ho.events.dead ? "" : "text-foreground"}>{ho.events.dead}</b> event
            {ho.events.dead === 1 ? "" : "s"} lost
          </span>
          {ho.events.pending > 0 && (
            <span>
              <b className="text-foreground">{ho.events.pending}</b> waiting
            </span>
          )}
        </div>
      </Panel>

      <Panel
        title="Agents"
        hint={`${rows.length} shown${hidden ? ` · ${hidden} switched off and never run (hidden)` : ""} · click a row for details`}
      >
        <table className="mt-2 w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Agent</th>
              {CHECKS.map((c) => (
                <th key={c.key} className="px-2 py-2 text-center font-medium">
                  {c.label}
                </th>
              ))}
              <th className="hidden px-4 py-2 text-left font-medium lg:table-cell">
                Setting · risk · owner
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <Fragment key={a.agent}>
                <tr
                  className="cursor-pointer border-b border-border hover:bg-muted/40"
                  onClick={() => setOpen(open === a.agent ? null : a.agent)}
                >
                  <td className="px-4 py-2.5 font-semibold capitalize">
                    {nice(a.agent)}{" "}
                    <span className="text-[10px] text-muted-foreground">
                      {open === a.agent ? "▴" : "▾"}
                    </span>
                  </td>
                  {CHECKS.map((c) => (
                    <td key={c.key} className="px-2 py-2.5 text-center" title={a.detail[c.key]}>
                      <Dot status={TONE_STATUS[a.checks[c.key]]} />
                    </td>
                  ))}
                  <td className="hidden px-4 py-2.5 text-xs text-muted-foreground lg:table-cell">
                    {a.enabled ? (AUTONOMY_WORD[a.autonomy] ?? a.autonomy) : "off"} · {a.risk} ·{" "}
                    {nice(a.owner)}
                  </td>
                </tr>
                {open === a.agent && (
                  <tr className="border-b border-border bg-muted/30">
                    <td colSpan={7} className="px-4 py-3">
                      <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-5">
                        {CHECKS.map((c) => (
                          <div key={c.key}>
                            <p className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                              <Dot status={TONE_STATUS[a.checks[c.key]]} />
                              {c.label}
                            </p>
                            <p>{a.detail[c.key]}</p>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {hidden > 0 || showOff ? (
          <button
            type="button"
            onClick={() => setShowOff((v) => !v)}
            className="w-full border-t border-border px-4 py-2 text-left text-xs font-medium text-primary hover:bg-muted/40"
          >
            {showOff ? "Hide switched-off agents" : `Show ${hidden} switched-off agents`}
          </button>
        ) : null}
      </Panel>
    </div>
  );
}
