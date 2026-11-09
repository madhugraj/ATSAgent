/**
 * Agent governance panel (Agent intelligence → Governance): five answers on
 * whether the harness is holding, a hand-off map of how agents start one
 * another (lifecycle events routed by the orchestrator, and direct
 * delegation via start_agent), and the evidence tables behind each answer.
 */
import { useState } from "react";

import type {
  Harness,
  HarnessHandoffEdge,
  HarnessHandoffNode,
  Tone,
} from "@/lib/agent-intelligence.functions";

const TONE: Record<Tone, { dot: string; ring: string; word: string }> = {
  good: { dot: "bg-emerald-500", ring: "border-emerald-500/30", word: "OK" },
  warn: { dot: "bg-amber-500", ring: "border-amber-500/40", word: "Watch" },
  bad: { dot: "bg-red-500", ring: "border-red-500/40", word: "Act" },
};
const nice = (s: string) => s.replace(/_/g, " ");
const RISK_CLS: Record<string, string> = {
  low: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  medium: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  high: "bg-red-500/10 text-red-700 dark:text-red-400",
};
const AUTONOMY_WORD: Record<string, string> = {
  suggest: "asks first",
  act_and_notify: "acts, then tells",
  autonomous: "fully autonomous",
};

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function Flag({ text }: { text: string | null }) {
  if (!text) return <span className="text-muted-foreground">—</span>;
  return <span className="font-medium text-red-600 dark:text-red-400">{text}</span>;
}

/* ---- hand-off map: what started each agent (left) → agent started (right) */
const PILL_W = 230,
  PILL_H = 40,
  ROW = 50,
  HEAD = 30,
  VB_W = 860;

function HandoffMap({
  nodes,
  edges,
}: {
  nodes: HarnessHandoffNode[];
  edges: HarnessHandoffEdge[];
}) {
  const [active, setActive] = useState<string | null>(null);
  if (edges.length === 0)
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        No agent has been started by an event or by another agent yet.
      </p>
    );
  const left = nodes
    .filter((n) => n.type !== "agent")
    .sort((a, b) => Number(a.type === "event") - Number(b.type === "event") || b.count - a.count);
  const right = nodes.filter((n) => n.type === "agent").sort((a, b) => b.count - a.count);
  const rows = Math.max(left.length, right.length);
  const H = HEAD + rows * ROW;
  const pos = new Map<string, { x: number; y: number }>();
  left.forEach((n, i) =>
    pos.set(n.id, { x: 10, y: HEAD + ((rows - left.length) * ROW) / 2 + i * ROW }),
  );
  right.forEach((n, i) =>
    pos.set(n.id, { x: VB_W - 10 - PILL_W, y: HEAD + ((rows - right.length) * ROW) / 2 + i * ROW }),
  );
  const peak = Math.max(...edges.map((e) => e.runs));
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
      <text x={10} y={16} fontSize={11} fontWeight={600} className="fill-muted-foreground">
        WHAT STARTED IT
      </text>
      <text
        x={VB_W - 10}
        y={16}
        fontSize={11}
        fontWeight={600}
        textAnchor="end"
        className="fill-muted-foreground"
      >
        AGENT STARTED
      </text>
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
          <g key={`${e.s}>${e.t}`} opacity={on(e) ? 1 : 0.1}>
            <path
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
              stroke={bad ? "#d03b3b" : e.s.startsWith("dl-") ? "#7c5cff" : "#9a988f"}
              strokeWidth={1.2 + (e.runs / peak) * 4}
              strokeDasharray={e.s.startsWith("dl-") ? "6 4" : undefined}
            />
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
          </g>
        );
      })}
      {[...left, ...right].map((n) => {
        const p = pos.get(n.id)!;
        const color =
          n.type === "delegator" ? "#7c5cff" : n.type === "event" ? "#9a988f" : "#2a78d6";
        const sub =
          n.type === "event"
            ? `event · started ${n.count} run${n.count === 1 ? "" : "s"}`
            : n.type === "delegator"
              ? `agent → agent · ${n.count} delegation${n.count === 1 ? "" : "s"}`
              : `${n.count} run${n.count === 1 ? "" : "s"} started by others${n.failed ? ` · ${n.failed} failed` : ""}`;
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
              {n.type === "event" ? n.name : nice(n.name)}
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

export function AgentGovernancePanel({ h }: { h: Harness }) {
  const [allAgents, setAllAgents] = useState(false);
  const ev = h.handoffs.events;
  const autonomyRows = allAgents ? h.autonomy : h.autonomy.filter((a) => a.enabled || a.flag);
  const defRows = allAgents ? h.definitions : h.definitions.filter((d) => d.runs > 0 || d.flag);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {h.questions.map((q) => (
          <a
            key={q.key}
            href={`#gov-${q.key}`}
            className={`rounded-lg border bg-card p-4 transition-colors hover:bg-muted/40 ${TONE[q.tone].ring}`}
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {q.question}
            </p>
            <p className="mt-2 flex items-center gap-2 text-sm font-semibold">
              <span
                className={`inline-block size-2.5 shrink-0 rounded-full ${TONE[q.tone].dot}`}
                aria-label={TONE[q.tone].word}
              />
              {q.title}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{q.detail}</p>
          </a>
        ))}
      </div>

      <div id="gov-handoffs" className="scroll-mt-4">
        <Section
          title="How agents start each other"
          hint="Grey: a lifecycle event the orchestrator routed to an agent. Purple, dashed: one agent delegating to another (start_agent). Red: hand-offs whose run failed. Hover to trace."
        >
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground">
            <span>
              <b className="text-foreground">{ev.total}</b> events
            </span>
            <span>
              <b className="text-foreground">{ev.done}</b> routed
            </span>
            <span className={ev.pending ? "text-amber-600" : ""}>
              <b>{ev.pending}</b> waiting
              {ev.oldestPendingMins != null
                ? ` (oldest ${ev.oldestPendingMins < 120 ? `${ev.oldestPendingMins} min` : `${Math.round(ev.oldestPendingMins / 60)} h`})`
                : ""}
            </span>
            <span className={ev.failed ? "text-red-600" : ""}>
              <b>{ev.failed}</b> failed · {ev.dead} gave up
            </span>
            <span className={h.handoffs.principalShifts ? "text-amber-600" : ""}>
              <b>{h.handoffs.principalShifts}</b> acted for a different person than the one who
              caused it
            </span>
          </div>
          <HandoffMap nodes={h.handoffs.nodes} edges={h.handoffs.edges} />
          {h.handoffs.lineageGap && (
            <p className="border-t border-border bg-amber-500/5 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
              Gap: an event does not yet record which agent run published it, so a chain can be
              followed one hop (event → agent) but not end to end, and loops cannot be detected.
            </p>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section
          title="Direct delegations (agent → agent)"
          hint="Every start_agent call: who handed what to whom. Flagged when the delegating run had already seen a suspected injected instruction."
        >
          {h.handoffs.delegations.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              No agent has delegated to another yet — this channel is untested in your organisation.
            </p>
          ) : (
            <ul className="divide-y divide-border text-xs">
              {h.handoffs.delegations.map((d, i) => (
                <li key={i} className="px-4 py-2">
                  <p>
                    <b className="capitalize">{nice(d.from)}</b> →{" "}
                    <b className="capitalize">{nice(d.to)}</b>
                    <span className="ml-2 text-muted-foreground">{d.status}</span>
                    {d.afterInjectionFlag && (
                      <span className="ml-2 font-semibold text-red-600">after injection flag</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-muted-foreground">“{d.goal}”</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section
          title="Events no agent picked up, and duplicated work"
          hint="Routed events that started nothing, and the same agent running twice on the same work at once."
        >
          <div className="space-y-3 px-4 py-3 text-xs">
            {h.handoffs.unrouted.length === 0 && h.handoffs.overlaps.length === 0 && (
              <p className="text-sm text-muted-foreground">None.</p>
            )}
            {h.handoffs.unrouted.length > 0 && (
              <div>
                <p className="mb-1 font-medium">Events that started no agent</p>
                <p className="text-muted-foreground">
                  {h.handoffs.unrouted.map((u) => `${u.type} ×${u.n}`).join(" · ")}
                </p>
                <p className="mt-1 text-muted-foreground">
                  Fine if no agent is meant to react; otherwise an agent is switched off or a route
                  is missing.
                </p>
              </div>
            )}
            {h.handoffs.overlaps.length > 0 && (
              <div>
                <p className="mb-1 font-medium text-red-600">Overlapping runs on the same work</p>
                {h.handoffs.overlaps.map((o) => (
                  <p key={`${o.agent}-${o.subject}`} className="text-muted-foreground">
                    <b className="capitalize text-foreground">{nice(o.agent)}</b> ran {o.runs}× at
                    once on {o.subject}…
                  </p>
                ))}
              </div>
            )}
          </div>
        </Section>
      </div>

      <div id="gov-limits" className="scroll-mt-4">
        <Section
          title="Limits: refused calls and injection flags"
          hint="Tool calls the harness refused because they fell outside the agent's permissions, and steps where untrusted text looked like instructions."
        >
          {h.limits.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              No refusals and no injection flags.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Agent</th>
                  <th className="px-4 py-2 font-medium">Refused calls</th>
                  <th className="px-4 py-2 font-medium">Tools refused</th>
                  <th className="px-4 py-2 font-medium">Injection flags</th>
                </tr>
              </thead>
              <tbody>
                {h.limits.map((l) => (
                  <tr key={l.agent} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-medium capitalize">{nice(l.agent)}</td>
                    <td className="px-4 py-2 tabular-nums">{l.refused}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {l.refusedTools.join(", ") || "—"}
                    </td>
                    <td
                      className={`px-4 py-2 tabular-nums ${l.injection ? "font-semibold text-red-600" : ""}`}
                    >
                      {l.injection}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          className="text-xs font-medium text-primary hover:underline"
          onClick={() => setAllAgents((v) => !v)}
        >
          {allAgents
            ? "Show only active or flagged agents"
            : `Show all ${h.autonomy.length} agents`}
        </button>
      </div>

      <div id="gov-autonomy" className="scroll-mt-4">
        <Section
          title="Autonomy vs risk"
          hint="How much each agent may do on its own (Agent settings) against the risk tier in its definition, and what it actually did."
        >
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">Switched on</th>
                <th className="px-4 py-2 font-medium">Autonomy</th>
                <th className="px-4 py-2 font-medium">Risk tier</th>
                <th className="px-4 py-2 font-medium">Changes it made</th>
                <th className="px-4 py-2 font-medium">Times it asked first</th>
                <th className="px-4 py-2 font-medium">With no approval card</th>
                <th className="px-4 py-2 font-medium">Flag</th>
              </tr>
            </thead>
            <tbody>
              {autonomyRows.map((a) => (
                <tr key={a.agent} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-medium capitalize">{nice(a.agent)}</td>
                  <td className="px-4 py-2">
                    {a.enabled ? "yes" : <span className="text-muted-foreground">no</span>}
                  </td>
                  <td className="px-4 py-2">{AUTONOMY_WORD[a.autonomy] ?? a.autonomy}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${RISK_CLS[a.risk]}`}
                    >
                      {a.risk}
                    </span>
                  </td>
                  <td className="px-4 py-2 tabular-nums">{a.writesRun}</td>
                  <td className="px-4 py-2 tabular-nums">{a.askedFirst}</td>
                  <td
                    className={`px-4 py-2 tabular-nums ${a.withoutApproval ? "font-semibold text-amber-600" : ""}`}
                  >
                    {a.withoutApproval}
                  </td>
                  <td className="px-4 py-2">
                    <Flag text={a.flag} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>

      <div id="gov-definitions" className="scroll-mt-4">
        <Section
          title="Definitions"
          hint="The approved version of each agent's rulebook, its accountable owner and eval coverage — and runs that executed anything else."
        >
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">Approved version</th>
                <th className="px-4 py-2 font-medium">Owner</th>
                <th className="px-4 py-2 font-medium">Evals</th>
                <th className="px-4 py-2 font-medium">Runs</th>
                <th className="px-4 py-2 font-medium">Ran on other versions</th>
                <th className="px-4 py-2 font-medium">Flag</th>
              </tr>
            </thead>
            <tbody>
              {defRows.map((d) => (
                <tr key={d.agent} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-medium capitalize">{nice(d.agent)}</td>
                  <td className="px-4 py-2 tabular-nums">{d.current}</td>
                  <td className="px-4 py-2">{nice(d.owner)}</td>
                  <td
                    className={`px-4 py-2 tabular-nums ${d.evals === 0 ? "font-semibold text-red-600" : ""}`}
                  >
                    {d.evals}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{d.runs}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {d.offVersion.map((o) => `${o.version} ×${o.runs}`).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2">
                    <Flag text={d.flag} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>

      <div id="gov-budget" className="scroll-mt-4">
        <Section
          title="Budget and run limits"
          hint="Tokens used this month against the monthly budget set in Agent settings, and runs stopped at their step or token ceiling."
        >
          {h.budget.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No usage this month.</p>
          ) : (
            <ul className="space-y-2 px-4 py-3 text-xs">
              {h.budget.map((b) => {
                const pct = b.budget ? Math.min(100, (b.tokensMonth / b.budget) * 100) : null;
                return (
                  <li key={b.agent} className="grid grid-cols-[140px_1fr_220px] items-center gap-3">
                    <span className="truncate font-medium capitalize">{nice(b.agent)}</span>
                    <div className="h-2.5 overflow-hidden rounded-sm bg-muted">
                      {pct !== null && (
                        <div
                          className={
                            pct >= 100
                              ? "h-full bg-red-500"
                              : pct >= 80
                                ? "h-full bg-amber-500"
                                : "h-full bg-emerald-500"
                          }
                          style={{ width: `${pct}%` }}
                        />
                      )}
                    </div>
                    <span className="tabular-nums text-muted-foreground">
                      {b.tokensMonth.toLocaleString()} tokens
                      {b.budget ? ` of ${b.budget.toLocaleString()}` : " · no budget set"}
                      {b.limitStops ? (
                        <b className="ml-2 text-amber-600">{b.limitStops} stopped at limit</b>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
