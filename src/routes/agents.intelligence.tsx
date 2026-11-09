/**
 * Agent Intelligence (governance roles only): the knowledge-graph view of the
 * hiring fleet, computed live from agent_runs / agent_steps / agent_tasks /
 * stage_events / raw skills. Three views — behavior, governance, vocabulary —
 * each with descriptive (graph + tiles) and prescriptive (system read) layers.
 * Deterministic: no model calls; vendor- and model-neutral.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentIntelligence, type AgentIntelligence, type Chip, type GNode, type Oversight, type Pri, type SkillGap, type Tone } from "@/lib/agent-intelligence.functions";

export const Route = createFileRoute("/agents/intelligence")({
  head: () => ({
    meta: [
      { title: "Agent intelligence — ATSIQ" },
      {
        name: "description",
        content:
          "Knowledge-graph view of the hiring fleet: agents, person gates, decision chains and the emerging skill vocabulary, with a prescriptive system read.",
      },
    ],
  }),
  component: IntelligencePage,
});

const TABS = [
  { key: "behavior", label: "Agent behavior" },
  { key: "governance", label: "Governance" },
  { key: "vocabulary", label: "Vocabulary" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const NODE_STYLE: Record<string, Record<string, { color: string; r: number; label: string }>> = {
  behavior: {
    agent: { color: "#2a78d6", r: 15, label: "Agent" },
    norm: { color: "#eb6834", r: 14, label: "Person gate" },
    failure: { color: "#d03b3b", r: 9, label: "Failing tool" },
    hub: { color: "#898781", r: 13, label: "Group (click for members)" },
  },
  governance: {
    norm: { color: "#eb6834", r: 14, label: "Person gate" },
    dOk: { color: "#0ca30c", r: 11, label: "Approved" },
    dBad: { color: "#d03b3b", r: 12, label: "Declined" },
    dOpen: { color: "#fab219", r: 10, label: "Open card" },
    dMut: { color: "#898781", r: 9, label: "Cancelled" },
  },
  vocabulary: {
    family: { color: "#2a78d6", r: 14, label: "Department" },
    skill: { color: "#1baf7a", r: 9, label: "Skill" },
  },
};
const EDGE_STYLE: Record<string, Record<string, { color: string; width: number; dash?: string; opacity?: number }>> = {
  behavior: {
    gated: { color: "#c3c2b7", width: 1.8 },
    errored: { color: "#d03b3b", width: 1.6, dash: "6 4" },
    awaits: { color: "#fab219", width: 1.6, dash: "3 3" },
    idle: { color: "#c3c2b7", width: 1.2, dash: "2 3", opacity: 0.7 },
    gap: { color: "#fab219", width: 1.6, dash: "3 3" },
  },
  governance: { decided: { color: "#c3c2b7", width: 1.7 } },
  vocabulary: {
    asks_for: { color: "#c3c2b7", width: 1.8 },
    cooccurs: { color: "#c3c2b7", width: 1.4, dash: "2 3", opacity: 0.85 },
  },
};
const EDGE_LABEL: Record<string, Record<string, string>> = {
  behavior: { gated: "gated by", errored: "errors in", awaits: "awaits", idle: "idle —", gap: "trace gap:" },
  governance: { decided: "decided under" },
  vocabulary: { asks_for: "asks for", cooccurs: "co-occurs" },
};

const nodeStyle = (vk: string, t: string) => NODE_STYLE[vk]?.[t] ?? { color: "#898781", r: 10, label: t };
const edgeStyle = (vk: string, k: string) => EDGE_STYLE[vk]?.[k] ?? { color: "#c3c2b7", width: 1.4 };
const TAB_TITLE: Record<TabKey, string> = {
  behavior: "Each agent, the person checkpoints it passes through, and where it fails",
  governance: "Every decision a person made on an agent proposal, and the rule it was made under",
  vocabulary: "",
};

const PRI_BADGE: Record<Pri, { cls: string; icon: string; label: string }> = {
  high: { cls: "bg-red-500/10 text-red-600 dark:text-red-400", icon: "⚠", label: "high" },
  medium: { cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400", icon: "◈", label: "plan" },
  ok: { cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", icon: "✓", label: "ok" },
};

function PriBadge({ pri }: { pri: Pri }) {
  const b = PRI_BADGE[pri];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${b.cls}`}>
      {b.icon} {b.label}
    </span>
  );
}

/* ------------------------------------------------------------- graph */

/**
 * Deterministic flow map: nodes sit in fixed columns (left → right reads as
 * cause → checkpoint → outcome), edges are curves between columns. No physics,
 * so the same data always draws the same picture and nothing overlaps.
 */
const COLUMNS: Record<TabKey, { title: string; types: string[] }[]> = {
  behavior: [
    { title: "Where it fails", types: ["failure"] },
    { title: "Agents that ran", types: ["agent", "hub"] },
    { title: "Person checkpoints", types: ["norm"] },
  ],
  governance: [
    { title: "Checkpoint", types: ["norm"] },
    { title: "What the person decided", types: ["dOk", "dBad", "dOpen", "dMut"] },
  ],
  vocabulary: [
    { title: "Department asking", types: ["family"] },
    { title: "Skill asked for · in your pool", types: ["skill"] },
  ],
};
const TYPE_ORDER = ["dBad", "dOpen", "dOk", "dMut"];
const VOCAB_MAX = 30;
const PILL_W = 210, PILL_H = 40, ROW = 52, HEAD = 34, VB_W = 900;

function nodeSub(n: GNode): string {
  switch (n.type) {
    case "agent": return `${n.runs ?? 0} run${n.runs === 1 ? "" : "s"}${n.awaiting ? ` · ${n.awaiting} waiting` : ""}`;
    case "norm": return `${n.stops ?? 0} check${n.stops === 1 ? "" : "s"}${n.rejected ? ` · ${n.rejected} declined` : ""}`;
    case "hub": return `${n.members?.length ?? 0} agents — click to list`;
    case "failure": return "failed tool calls";
    case "dOk": case "dBad": return `${n.count ?? 0} decision${n.count === 1 ? "" : "s"}`;
    case "dOpen": return "waiting for a person";
    case "dMut": return "closed without a decision";
    case "skill": return `${n.demand ? `asked for ${n.demand}×` : "not asked for"} · ${n.supply ?? 0} in pool`;
    case "family": return "department";
    default: return "";
  }
}
const pretty = (s: string) => s.replace(/^[✓✗]\s*/, "").replace(/_/g, " ");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function GraphCanvas({
  viewKey,
  nodes,
  edges,
  onSelect,
}: {
  viewKey: TabKey;
  nodes: GNode[];
  edges: { s: string; t: string; k: string; label?: string | undefined }[];
  onSelect: (n: GNode | null) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => setActive(null), [viewKey]);

  const hasFamilies = nodes.some((n) => n.type === "family");
  const cols = viewKey === "vocabulary" && !hasFamilies ? [{ title: "Skills seen most · asked for · in your pool", types: ["skill"] }] : COLUMNS[viewKey];
  // vocabulary: only skills a department asks for (co-occurrence lives in the inspector), capped
  let pool = nodes.filter((n) => !n.idle);
  if (viewKey === "vocabulary") {
    const asked = new Set(edges.filter((e) => e.k === "asks_for").map((e) => e.t));
    // no department asks yet → fall back to the most-evidenced skills so the map is never blank
    const all = pool.filter((n) => n.type === "skill");
    const skills = (asked.size ? all.filter((n) => asked.has(n.id)) : all)
      .sort((a, b) => (b.demand ?? 0) - (a.demand ?? 0) || (b.ev ?? 0) - (a.ev ?? 0))
      .slice(0, VOCAB_MAX);
    pool = [...pool.filter((n) => n.type === "family"), ...skills];
  }
  const weight = (n: GNode) => n.runs ?? n.count ?? n.stops ?? n.demand ?? 0;
  const columns = cols.map((c) =>
    pool
      .filter((n) => (n.id === "hub-gap" ? c.types.includes("failure") : c.types.includes(n.type)))
      .sort((a, b) =>
        (a.type === "hub" ? 1 : 0) - (b.type === "hub" ? 1 : 0) ||
        TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
        weight(b) - weight(a) ||
        a.name.localeCompare(b.name),
      ),
  );
  const rows = cols.length === 1 ? Math.ceil((columns[0]?.length ?? 0) / 4) || 1 : Math.max(1, ...columns.map((c) => c.length));
  const H = HEAD + rows * ROW + 12;
  const gap = cols.length > 1 ? (VB_W - 20 - PILL_W) / (cols.length - 1) : 0;
  const single = cols.length === 1;
  const pos = new Map<string, { x: number; y: number; col: number }>();
  columns.forEach((list, ci) => {
    const offset = ((rows - list.length) * ROW) / 2; // centre short columns
    // a single column wraps into a grid of boxes instead of one tall list
    if (single) list.forEach((n, ri) => pos.set(n.id, { x: 10 + (ri % 4) * (PILL_W + 12), y: HEAD + Math.floor(ri / 4) * ROW, col: 0 }));
    else list.forEach((n, ri) => pos.set(n.id, { x: 10 + ci * gap, y: HEAD + offset + ri * ROW, col: ci }));
  });
  const links = edges.filter((e) => pos.has(e.s) && pos.has(e.t) && pos.get(e.s)!.col !== pos.get(e.t)!.col);
  const touches = (id: string) => !active || id === active || links.some((l) => (l.s === active && l.t === id) || (l.t === active && l.s === id));

  if (pool.length === 0)
    return <p className="p-6 text-sm text-muted-foreground">Nothing to show yet — this fills in as agents run, people decide and candidates arrive.</p>;

  return (
    <svg viewBox={`0 0 ${VB_W} ${H}`} className="block w-full" role="img" aria-label="Agent intelligence map">
      {cols.map((c, ci) => (
        <text key={c.title} x={10 + ci * gap + (ci === cols.length - 1 && ci > 0 ? PILL_W : 0)} y={16} fontSize={11}
          textAnchor={ci === cols.length - 1 && ci > 0 ? "end" : "start"} className="fill-muted-foreground" fontWeight={600}>
          {c.title.toUpperCase()}
        </text>
      ))}
      {links.map((l, i) => {
        let a = pos.get(l.s)!, b = pos.get(l.t)!;
        if (a.col > b.col) [a, b] = [b, a];
        const x1 = a.x + PILL_W, y1 = a.y + PILL_H / 2, x2 = b.x, y2 = b.y + PILL_H / 2, mx = (x1 + x2) / 2;
        const st = edgeStyle(viewKey, l.k);
        const on = !active || l.s === active || l.t === active;
        return (
          <g key={i} opacity={on ? (st.opacity ?? 1) : 0.12}>
            <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={st.color}
              strokeWidth={on && active ? st.width + 1 : st.width} strokeDasharray={st.dash} />
            {l.label && (on || !active) && (
              <text x={mx} y={(y1 + y2) / 2 - 4} fontSize={10} textAnchor="middle" fill={st.color === "#c3c2b7" ? "#77766f" : st.color}
                fontWeight={600} paintOrder="stroke" stroke="var(--background, #fff)" strokeWidth={3}>
                {l.label}
              </text>
            )}
          </g>
        );
      })}
      {[...pos.entries()].map(([id, p]) => {
        const n = pool.find((x) => x.id === id)!;
        const color = nodeStyle(viewKey, n.type).color;
        return (
          <g key={id} transform={`translate(${p.x},${p.y})`} opacity={touches(id) ? (n.dormant ? 0.55 : 1) : 0.3}
            className="cursor-pointer" role="button" tabIndex={0} aria-label={`${pretty(n.name)}: ${nodeSub(n)}`}
            onMouseEnter={() => setActive(id)} onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(id)} onBlur={() => setActive(null)}
            onClick={() => onSelect(n)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(n); }}>
            <rect width={PILL_W} height={PILL_H} rx={8} className="fill-card stroke-border" strokeWidth={1}
              strokeDasharray={n.type === "hub" || n.type === "dMut" ? "4 3" : undefined} />
            <rect width={4} height={PILL_H - 12} x={6} y={6} rx={2} fill={color} />
            <text x={18} y={17} fontSize={12} fontWeight={600} className="fill-foreground">{clip(pretty(n.name), 28)}</text>
            <text x={18} y={31} fontSize={10.5} className="fill-muted-foreground">{clip(nodeSub(n), 34)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------- governance + vocabulary panels */

const TONE: Record<Tone, { dot: string; ring: string; word: string }> = {
  good: { dot: "bg-emerald-500", ring: "border-emerald-500/30", word: "OK" },
  warn: { dot: "bg-amber-500", ring: "border-amber-500/40", word: "Watch" },
  bad: { dot: "bg-red-500", ring: "border-red-500/40", word: "Act" },
};
const QUESTIONS = ["Are people really deciding?", "Where do people disagree?", "Is anything skipping a person?"];
const stageWord = (s: string) => s.replace(/_/g, " ");

function OversightPanel({ o }: { o: Oversight }) {
  const peak = Math.max(1, ...o.weekly.map((w) => w.approved + w.declined));
  const movePeak = Math.max(1, ...o.stageMoves.map((m) => m.agent + m.person));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {o.headline.map((h, i) => (
          <div key={i} className={`rounded-lg border bg-card p-4 ${TONE[h.tone].ring}`}>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{QUESTIONS[i]}</p>
            <p className="mt-2 flex items-center gap-2 text-base font-semibold">
              <span className={`inline-block size-2.5 rounded-full ${TONE[h.tone].dot}`} aria-label={TONE[h.tone].word} />
              {h.title}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{h.detail}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Decisions per week</h3>
          <p className="text-xs text-muted-foreground">A rising red share means agents and your people are drifting apart; all green for weeks may mean rubber-stamping.</p>
          <div className="mt-4 flex h-36 items-end gap-2">
            {o.weekly.map((w) => (
              <div key={w.week} className="flex flex-1 flex-col items-center gap-1" title={`Week of ${w.week}: ${w.approved} approved, ${w.declined} declined`}>
                <span className="text-[10px] tabular-nums text-muted-foreground">{w.approved + w.declined || ""}</span>
                <div className="flex w-full max-w-8 flex-col-reverse overflow-hidden rounded-sm" style={{ height: `${((w.approved + w.declined) / peak) * 100}px` }}>
                  <div className="bg-emerald-500/80" style={{ height: `${(w.approved / Math.max(w.approved + w.declined, 1)) * 100}%` }} />
                  <div className="bg-red-500/80" style={{ height: `${(w.declined / Math.max(w.approved + w.declined, 1)) * 100}%` }} />
                </div>
                <span className="text-[10px] text-muted-foreground">{new Date(w.week).toLocaleDateString([], { day: "numeric", month: "short" })}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-4 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-emerald-500/80" />approved</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-red-500/80" />declined</span>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Who moves candidates between stages</h3>
          <p className="text-xs text-muted-foreground">Stages that only an agent ever moves candidates into have no person in the loop.</p>
          {o.stageMoves.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No stage moves recorded yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {o.stageMoves.map((m) => (
                <li key={m.stage} className="grid grid-cols-[120px_1fr_auto] items-center gap-2 text-xs">
                  <span className="truncate capitalize">{stageWord(m.stage)}</span>
                  <div className="flex h-3 overflow-hidden rounded-sm bg-muted">
                    <div className="bg-blue-500/80" style={{ width: `${(m.agent / movePeak) * 100}%` }} />
                    <div className="bg-slate-400/80" style={{ width: `${(m.person / movePeak) * 100}%` }} />
                  </div>
                  <span className={`tabular-nums ${m.person === 0 ? "font-semibold text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
                    {m.agent} agent · {m.person} person
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-4 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-blue-500/80" />by an agent</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-slate-400/80" />by a person</span>
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Where people disagree with agents</h3>
          <p className="text-xs text-muted-foreground">The proposals people declined, and the reasons they gave — this is what to retune.</p>
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
                <tr key={`${d.agent}-${d.proposal}`} className="border-b border-border align-top last:border-0">
                  <td className="px-4 py-2 font-medium capitalize">{stageWord(d.agent)}</td>
                  <td className="px-4 py-2">{d.proposal}</td>
                  <td className="px-4 py-2 tabular-nums">
                    <b>{d.declined}</b> of {d.total}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {d.reasons.length ? d.reasons.map((r) => <p key={r}>“{r}”</p>) : <span>No reason recorded — ask reviewers to add one.</span>}
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
          Cards open more than 48 hours{o.closedUndecided ? ` · ${o.closedUndecided} more were closed before anyone decided` : ""}.
        </p>
        {o.staleOpen.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nothing has been waiting more than 48 hours.</p>
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

function GapPanel({ gaps }: { gaps: SkillGap[] }) {
  const peak = Math.max(1, ...gaps.map((g) => Math.max(g.demand, g.supply)));
  const status = (g: SkillGap) =>
    g.demand > 0 && g.supply === 0
      ? { word: "needs sourcing", cls: "bg-red-500/10 text-red-600 dark:text-red-400" }
      : g.supply < g.demand
        ? { word: "short", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" }
        : g.demand === 0
          ? { word: "not asked for", cls: "bg-muted text-muted-foreground" }
          : { word: "covered", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold">Skills you ask for vs skills you have</h3>
        <p className="text-xs text-muted-foreground">
          Left: how many requisitions ask for the skill. Right: how many candidates in your pool have it. Biggest gaps first.
        </p>
      </div>
      {gaps.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">No skills yet — this fills in as requisitions list skills and CVs arrive.</p>
      ) : (
        <div className="px-4 py-3">
          {gaps.every((g) => g.demand === 0) && (
            <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              None of your requisitions list must-have or good-to-have skills yet, so there is nothing to compare against. Add skills to your requisitions to see where you need to source.
            </p>
          )}
          <div className="mb-2 grid grid-cols-[1fr_140px_1fr_96px] gap-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span className="text-right">Asked for</span>
            <span className="text-center">Skill</span>
            <span>In your pool</span>
            <span />
          </div>
          <ul className="space-y-1.5">
            {gaps.map((g) => {
              const st = status(g);
              return (
                <li key={g.skill} className="grid grid-cols-[1fr_140px_1fr_96px] items-center gap-3 text-xs">
                  <div className="flex items-center justify-end gap-2">
                    <span className="tabular-nums text-muted-foreground">{g.demand || ""}</span>
                    <div className="h-3 rounded-sm bg-blue-500/80" style={{ width: `${(g.demand / peak) * 100}%` }} />
                  </div>
                  <span className="truncate text-center font-medium" title={g.skill}>{g.skill}</span>
                  <div className="flex items-center gap-2">
                    <div className="h-3 rounded-sm bg-emerald-500/80" style={{ width: `${(g.supply / peak) * 100}%` }} />
                    <span className="tabular-nums text-muted-foreground">{g.supply || ""}</span>
                  </div>
                  <span className={`justify-self-start rounded px-1.5 py-0.5 text-[10px] font-semibold ${st.cls}`}>{st.word}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- page */

function ChipCard({ chip, onSelect, selected }: { chip: Chip; onSelect: () => void; selected: boolean }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-lg border p-2 text-left transition-colors hover:bg-muted/50 ${
        selected ? "border-primary bg-primary/5" : "border-border"
      }`}
    >
      <span className="flex items-center gap-2">
        <PriBadge pri={chip.pri} />
        <span className="line-clamp-2 text-xs font-semibold leading-snug" title={chip.title.replace(/^[⚠✓◈]\s*/, "")}>
          {chip.short}
        </span>
      </span>
      <span className="mt-1 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">{chip.action}</span>
    </button>
  );
}

function Inspector({ node, chip, tabKey }: { node: GNode | null; chip: Chip | null; tabKey: TabKey }) {
  if (node) {
    const ts = nodeStyle(tabKey, node.type);
    return (
      <div className="space-y-3 text-sm">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{ts?.label ?? node.type}</p>
          <h3 className="text-sm font-semibold">{node.name}</h3>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {node.type === "agent" && (
            <>
              {node.ver != null && <><dt className="text-muted-foreground">version</dt><dd>{node.ver}</dd></>}
              <dt className="text-muted-foreground">runs</dt><dd>{node.runs}</dd>
              <dt className="text-muted-foreground">steps</dt><dd>{node.steps}</dd>
              {!node.idle && <><dt className="text-muted-foreground">avg steps/run</dt><dd>{node.avg}</dd></>}
              {node.awaiting ? <><dt className="text-muted-foreground">awaiting a person</dt><dd>{node.awaiting}</dd></> : null}
            </>
          )}
          {node.type === "norm" && (
            <>
              <dt className="text-muted-foreground">what it is</dt><dd>{node.what ?? ""}</dd>
              <dt className="text-muted-foreground">stops</dt><dd>{node.stops}</dd>
              <dt className="text-muted-foreground">overturned</dt><dd>{node.rejected}</dd>
            </>
          )}
          {node.type === "skill" && (
            <>
              <dt className="text-muted-foreground">slug</dt><dd>{node.slug}</dd>
              <dt className="text-muted-foreground">category</dt><dd>{node.cat}</dd>
              <dt className="text-muted-foreground">aliases</dt><dd>{node.aliases || "—"}</dd>
              <dt className="text-muted-foreground">supply / demand</dt><dd>{node.supply} / {node.demand}</dd>
              <dt className="text-muted-foreground">evidence</dt><dd>{node.ev}</dd>
              <dt className="text-muted-foreground">status</dt><dd>{node.dormant ? "dormant" : "active"}</dd>
            </>
          )}
          {node.members && node.members.length > 0 && (
            <>
              <dt className="text-muted-foreground">members</dt>
              <dd><ul className="list-disc pl-4">{node.members.map((m) => <li key={m}>{m}</li>)}</ul></dd>
            </>
          )}
          {node.count != null && (
            <>
              <dt className="text-muted-foreground">on agent</dt><dd>{node.agent}</dd>
              <dt className="text-muted-foreground">decisions</dt><dd>{node.count}</dd>
            </>
          )}
          {node.tool != null && (
            <>
              <dt className="text-muted-foreground">tool</dt><dd>{node.tool}</dd>
            </>
          )}
        </dl>
        {node.cause && (
          <div className="rounded border-l-2 border-blue-500 bg-muted/40 p-2 text-xs">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">◈ Cause</p>
            {node.cause}
          </div>
        )}
        {node.effect && (
          <div className="rounded border-l-2 border-amber-500 bg-muted/40 p-2 text-xs">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">⚠ Effect</p>
            {node.effect}
          </div>
        )}
        {node.action && (
          <div className="rounded border-l-2 border-emerald-500 bg-muted/40 p-2 text-xs">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">→ Next best action</p>
            {node.action}
          </div>
        )}
      </div>
    );
  }
  if (chip) {
    return (
      <div className="space-y-3 text-sm">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">System read · {chip.pri}</p>
          <h3 className="text-sm font-semibold">{chip.title.replace(/^[⚠✓◈]\s*/, "")}</h3>
        </div>
        <div className="rounded border-l-2 border-blue-500 bg-muted/40 p-2 text-xs"><p className="text-[10px] font-semibold uppercase text-muted-foreground">◈ Cause</p>{chip.cause}</div>
        <div className="rounded border-l-2 border-amber-500 bg-muted/40 p-2 text-xs"><p className="text-[10px] font-semibold uppercase text-amber-600 dark:text-amber-400">⚠ Effect</p>{chip.effect}</div>
        <div className="rounded border-l-2 border-emerald-500 bg-muted/40 p-2 text-xs"><p className="text-[10px] font-semibold uppercase text-emerald-600 dark:text-emerald-400">→ Next best action</p>{chip.action}</div>
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Inspector</p>
      <h3 className="text-sm font-semibold">Nothing selected</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Click a box in the map or a card under "What needs attention" to see its numbers, why it matters and what
        to do next. Every number comes from your organisation's own agent activity.
      </p>
    </div>
  );
}

function IntelligencePage() {
  const [tab, setTab] = useState<TabKey>("behavior");
  const [selectedNode, setSelectedNode] = useState<GNode | null>(null);
  const [selectedChip, setSelectedChip] = useState<Chip | null>(null);
  const q = useQuery({
    queryKey: ["agent-intelligence"],
    queryFn: () => agentIntelligence(),
    refetchInterval: 60_000,
  });
  const data: AgentIntelligence | undefined = q.data;
  const view = data?.views[tab];

  useEffect(() => {
    setSelectedNode(null);
    setSelectedChip(null);
  }, [tab]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Agent intelligence"
        description="Is your hiring-agent team doing work your people trust? See which agents are busy, where people overrule them, what is failing — and what to do next. Calculated from your organisation's own activity; no AI is used to produce this page."
        actions={
          <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`mr-1.5 size-3.5 ${q.isFetching ? "animate-spin" : ""}`} aria-hidden />
            {q.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      {!data && (
        <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
          {q.isError ? "Agent intelligence could not be loaded. The error has been logged." : "Computing the fleet graph…"}
        </div>
      )}

      {data && view && (
        <>
          <div className="flex items-center gap-1 rounded-lg border border-border p-1" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  tab === t.key ? "bg-primary/10 font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
              </button>
            ))}
            <span className="ml-auto pr-2 text-[11px] text-muted-foreground">updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · refreshes every minute</span>
          </div>

          <div className={tab === "governance" ? "hidden" : "grid grid-cols-2 gap-2 lg:grid-cols-4"}>
            {view.tiles.map(([k, v, s]) => (
              <div key={k} className="rounded-lg border border-border bg-card p-3">
                <p className="text-[11px] text-muted-foreground">{k}</p>
                <p className="mt-0.5 text-xl font-semibold tabular-nums">{v}</p>
                <p className="text-[11px] text-muted-foreground">{s}</p>
              </div>
            ))}
          </div>

          {tab !== "governance" && (
          <div className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
              <span>
                What needs attention — <b className="text-foreground">{view.sysreadSummary}</b>
              </span>
              <span>click a card for the cause, the effect and the next step</span>
            </div>
            <div className="grid grid-cols-2 gap-2 p-3 lg:grid-cols-4">
              {view.systemRead.map((chip) => (
                <ChipCard
                  key={chip.title}
                  chip={chip}
                  selected={selectedChip?.title === chip.title}
                  onSelect={() => {
                    setSelectedNode(null);
                    setSelectedChip(selectedChip?.title === chip.title ? null : chip);
                  }}
                />
              ))}
            </div>
          </div>
          )}

          {tab !== "governance" && (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_320px]">
            {tab === "behavior" ? (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
                <span>{TAB_TITLE[tab]}</span>
                <span>hover to trace · click for details</span>
              </div>
              <GraphCanvas
                viewKey={tab}
                nodes={view.nodes}
                edges={view.edges}
                onSelect={(n) => {
                  setSelectedChip(null);
                  setSelectedNode(n);
                }}
              />
              <div className="flex flex-wrap gap-4 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                {Object.entries(NODE_STYLE[tab] ?? {}).map(([t, st]) => (
                  <span key={t} className="inline-flex items-center gap-1.5">
                    <span className="inline-block size-2.5 rounded-full" style={{ background: st.color }} />
                    {st.label}
                  </span>
                ))}
                <span>line labels = real counts</span>
              </div>
            </div>
            ) : (
              <GapPanel gaps={data.views.vocabulary.gaps} />
            )}
            <div className="min-h-[300px] max-h-[652px] overflow-y-auto rounded-lg border border-border bg-card p-3">
              <Inspector node={selectedNode} chip={selectedChip} tabKey={tab} />
            </div>
          </div>
          )}

          {tab === "governance" && <OversightPanel o={data.views.governance.oversight} />}

          {tab === "behavior" && data.views.behavior.plan.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                Action plan — all {data.views.behavior.fleet.registered} agents, most urgent first
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Priority</th>
                      <th className="px-3 py-2 font-medium">Agent</th>
                      <th className="px-3 py-2 font-medium">Ver</th>
                      <th className="px-3 py-2 font-medium">State</th>
                      <th className="px-3 py-2 font-medium">Runs</th>
                      <th className="px-3 py-2 font-medium">Person checks</th>
                      <th className="px-3 py-2 font-medium">Declined</th>
                      <th className="px-3 py-2 font-medium">Failed calls</th>
                      <th className="px-3 py-2 font-medium">Next best action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.views.behavior.plan.map((p) => (
                      <tr key={p.name} className="border-b border-border last:border-0">
                        <td className="px-3 py-2"><PriBadge pri={p.pri} /></td>
                        <td className="px-3 py-2 font-medium">{p.name}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.ver}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.state}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.runs}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.stops}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.overturned}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.errors}</td>
                        <td className="px-3 py-2">{p.action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "behavior" && data.views.behavior.rejects.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                Declined proposals — what people said no to, grouped
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Agent</th>
                      <th className="px-3 py-2 font-medium">Kind</th>
                      <th className="px-3 py-2 font-medium">Rejected proposal</th>
                      <th className="px-3 py-2 font-medium">Tool</th>
                      <th className="px-3 py-2 font-medium">Times</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.views.behavior.rejects.map((r, i) => (
                      <tr key={`${r.agentType}-${r.kind}-${i}`} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 font-medium">{r.agentType}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.kind}</td>
                        <td className="px-3 py-2">{r.title}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.tool ?? "—"}</td>
                        <td className="px-3 py-2 font-medium">×{r.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
