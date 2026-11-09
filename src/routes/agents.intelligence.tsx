/**
 * Agent Intelligence (governance roles only): the knowledge-graph view of the
 * hiring fleet, computed live from agent_runs / agent_steps / agent_tasks /
 * stage_events / raw skills. Three views — behavior, governance, vocabulary —
 * each with descriptive (graph + tiles) and prescriptive (system read) layers.
 * Deterministic: no model calls; vendor- and model-neutral.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentIntelligence, type AgentIntelligence, type Chip, type GNode, type Pri } from "@/lib/agent-intelligence.functions";

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
    failure: { color: "#898781", r: 9, label: "Failure cluster" },
    vocab: { color: "#1baf7a", r: 11, label: "Vocabulary" },
    hub: { color: "#898781", r: 13, label: "Diagnosis hub" },
  },
  governance: {
    norm: { color: "#eb6834", r: 14, label: "Person gate" },
    dOk: { color: "#0ca30c", r: 11, label: "Approved" },
    dBad: { color: "#d03b3b", r: 12, label: "Overturned" },
    dOpen: { color: "#fab219", r: 10, label: "Open card" },
    dMut: { color: "#898781", r: 9, label: "Cancelled" },
  },
  vocabulary: {
    family: { color: "#2a78d6", r: 14, label: "Role family (dept proxy)" },
    skill: { color: "#1baf7a", r: 9, label: "Skill (size = evidence)" },
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
const SPRING: Record<string, Record<string, number>> = {
  behavior: { gated: 185, errored: 150, awaits: 190, idle: 140, gap: 170 },
  governance: { decided: 175 },
  vocabulary: { asks_for: 165, cooccurs: 120 },
};

const nodeStyle = (vk: string, t: string) => NODE_STYLE[vk]?.[t] ?? { color: "#898781", r: 10, label: t };
const edgeStyle = (vk: string, k: string) => EDGE_STYLE[vk]?.[k] ?? { color: "#c3c2b7", width: 1.4 };
const springOf = (vk: string, k: string) => SPRING[vk]?.[k] ?? 150;
const TAB_TITLE: Record<TabKey, string> = {
  behavior: "Each agent, the person checkpoints it passes through, and where it fails",
  governance: "Every decision a person made on an agent proposal, and the rule it was made under",
  vocabulary: "The skills your candidates offer and your requisitions ask for, and how they cluster",
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

type SimNode = GNode & {
  x: number; y: number; vx: number; vy: number; fixed?: boolean | undefined; _r: number;
  group?: SVGGElement | undefined; circle?: SVGCircleElement | undefined; labelEl?: SVGTextElement | undefined;
};
type SimEdge = {
  s: SimNode; t: SimNode; k: string; label?: string | undefined;
  line?: SVGLineElement | undefined; tag?: SVGTextElement | undefined; off?: number | undefined; hidden?: boolean | undefined;
};

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
  const svgRef = useRef<SVGSVGElement | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.replaceChildren();
    const W = svg.clientWidth || 860;
    const H = 600;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const ns = "http://www.w3.org/2000/svg";
    const el = <T extends SVGElement>(tag: string, attrs: Record<string, string | number>): T => {
      const e = document.createElementNS(ns, tag) as T;
      for (const k in attrs) e.setAttribute(k, String(attrs[k]));
      return e;
    };

    const sim: SimNode[] = nodes.map((n, i) => {
      const ts = nodeStyle(viewKey, n.type);
      const r = n.idle ? 9 : viewKey === "vocabulary" && n.type === "skill" ? Math.min(14, 6 + Math.sqrt(n.ev ?? 4) * 1.3) : ts.r;
      const ang = (i / nodes.length) * Math.PI * 2;
      const rad = viewKey === "behavior" ? (n.type === "agent" ? 110 : 230) : viewKey === "vocabulary" ? (n.type === "family" ? 110 : 240) : 200;
      return {
        ...n, _r: r, vx: 0, vy: 0,
        x: W / 2 + Math.cos(ang) * rad,
        y: H / 2 + Math.sin(ang) * rad * 0.9,
      };
    });
    const byId = new Map(sim.map((n) => [n.id, n]));
    const links: SimEdge[] = [];
    for (const e of edges) {
      const s = byId.get(e.s), t = byId.get(e.t);
      if (s && t) links.push({ s, t, k: e.k, label: e.label });
    }

    const gE = el("g", {}), gN = el("g", {}), gL = el("g", {});
    svg.append(gE, gN, gL);
    let tagCount = 0;
    for (const l of links) {
      const st = edgeStyle(viewKey, l.k);
      l.line = el<SVGLineElement>("line", { stroke: st.color, "stroke-width": st.width, opacity: st.opacity ?? 1 });
      if (st.dash) l.line.setAttribute("stroke-dasharray", st.dash);
      gE.appendChild(l.line);
      if (l.label) {
        l.tag = el<SVGTextElement>("text", {
          "font-size": 10, fill: st.color, "text-anchor": "middle",
          "paint-order": "stroke", stroke: "var(--surface, #fcfcfb)", "stroke-width": 3, "font-weight": 600,
        });
        l.tag.textContent = l.label;
        l.off = [30, -30, 48, -48, 64][tagCount++ % 5];
        gE.appendChild(l.tag);
      }
    }
    for (const n of sim) {
      n.group = el<SVGGElement>("g", { tabindex: 0, role: "button", "aria-label": `${n.name}, ${nodeStyle(viewKey, n.type).label}` });
      const circle = el<SVGCircleElement>("circle", {
        r: n._r, fill: nodeStyle(viewKey, n.type).color,
        stroke: n.type === "hub" ? "#fab219" : "var(--surface, #fcfcfb)",
        "stroke-width": 2, "stroke-dasharray": n.type === "hub" ? "3 2" : "",
        opacity: n.idle ? 0.45 : n.dormant ? 0.4 : 1, cursor: "grab",
      });
      n.circle = circle;
      n.group.appendChild(circle);
      gN.appendChild(n.group);
      const label = el<SVGTextElement>("text", {
        "font-size": n.idle ? 10 : 11, fill: "currentColor", "text-anchor": "middle",
        "paint-order": "stroke", stroke: "var(--surface, #fcfcfb)", "stroke-width": 3,
        opacity: n.idle ? 0.7 : n.dormant ? 0.5 : 1,
      });
      label.textContent = n.name + (n.type === "agent" && !n.idle ? ` ×${n.runs}` : n.idle ? " (idle)" : "");
      n.labelEl = label;
      gL.appendChild(label);

      let drag: { id: number } | null = null;
      n.group.addEventListener("pointerdown", (ev) => {
        drag = { id: ev.pointerId };
        n.fixed = true;
        alpha = 1;
        n.group?.setPointerCapture(ev.pointerId);
      });
      n.group.addEventListener("pointermove", (ev) => {
        if (!drag) return;
        const rect = svg.getBoundingClientRect();
        n.x = (ev.clientX - rect.left) * (W / rect.width);
        n.y = (ev.clientY - rect.top) * (600 / rect.height);
        alpha = 1;
      });
      n.group.addEventListener("pointerup", () => {
        drag = null;
        n.fixed = false;
      });
      n.group.addEventListener("click", () => selectRef.current(n));
      n.group.addEventListener("focus", () => selectRef.current(n));
    }

    const REPULSION = 3800, FRICTION = 0.86, CENTER = 0.012;
    let alpha = 1;
    function tick() {
      for (let i = 0; i < sim.length; i++)
        for (let j = i + 1; j < sim.length; j++) {
          const a = sim[i]!, b = sim[j]!;
          const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy || 1;
          if (d2 > 300 * 300) continue;
          const f = REPULSION / d2, d = Math.sqrt(d2);
          a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
          b.vx += (dx / d) * f; b.vy += (dy / d) * f;
          const minD = Math.min(50 + Math.max(a.name.length, b.name.length) * 3.1, 140);
          if (d < minD) {
            const p = (minD - d) * 0.09;
            a.vx -= (dx / d) * p; a.vy -= (dy / d) * p;
            b.vx += (dx / d) * p; b.vy += (dy / d) * p;
          }
        }
      for (const l of links) {
        const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.hypot(dx, dy) || 1;
        const f = (d - springOf(viewKey, l.k)) * 0.012;
        l.s.vx += (dx / d) * f; l.s.vy += (dy / d) * f;
        l.t.vx -= (dx / d) * f; l.t.vy -= (dy / d) * f;
      }
      for (const n of sim) {
        if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
        n.vx += (W / 2 - n.x) * CENTER;
        n.vy += (H / 2 - n.y) * CENTER;
        n.vx *= FRICTION; n.vy *= FRICTION;
        n.x = Math.max(50, Math.min(W - 50, n.x + n.vx));
        n.y = Math.max(30, Math.min(H - 30, n.y + n.vy));
      }
    }
    function draw() {
      for (const l of links) {
        if (!l.line) continue;
        l.line.setAttribute("x1", String(l.s.x));
        l.line.setAttribute("y1", String(l.s.y));
        l.line.setAttribute("x2", String(l.t.x));
        l.line.setAttribute("y2", String(l.t.y));
        if (l.tag && l.off != null) {
          const mx = (l.s.x + l.t.x) / 2, my = (l.s.y + l.t.y) / 2;
          const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.hypot(dx, dy) || 1;
          l.tag.setAttribute("x", String(mx - (dy / d) * l.off));
          l.tag.setAttribute("y", String(my + (dx / d) * l.off + 3));
        }
      }
      for (const n of sim) {
        n.group?.setAttribute("transform", `translate(${n.x},${n.y})`);
        if (n.labelEl) {
          n.labelEl.setAttribute("x", String(n.x));
          n.labelEl.setAttribute("y", String(n.y + n._r + 13));
        }
      }
    }
    for (let i = 0; i < 900; i++) tick();
    let raf = 0;
    const loop = () => {
      if (alpha > 0.005) {
        for (let i = 0; i < 4; i++) tick();
        alpha *= 0.994;
      }
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [viewKey, nodes, edges]);

  return <svg ref={svgRef} className="block h-[600px] w-full" role="img" aria-label="Agent intelligence graph" />;
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
        Click any node for its numbers and its cause → effect → next best action, or a System read chip for the fleet-wide
        finding. Every number here is a live query over this organisation's runs, steps, tasks and stage transitions —
        deterministic, no model in the path.
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

          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {view.tiles.map(([k, v, s]) => (
              <div key={k} className="rounded-lg border border-border bg-card p-3">
                <p className="text-[11px] text-muted-foreground">{k}</p>
                <p className="mt-0.5 text-xl font-semibold tabular-nums">{v}</p>
                <p className="text-[11px] text-muted-foreground">{s}</p>
              </div>
            ))}
          </div>

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

          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_320px]">
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
                <span>{TAB_TITLE[tab]}</span>
                <span>drag · click to inspect</span>
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
                <span>faded = idle / dormant</span>
                <span>line labels = real counts</span>
              </div>
            </div>
            <div className="min-h-[300px] max-h-[652px] overflow-y-auto rounded-lg border border-border bg-card p-3">
              <Inspector node={selectedNode} chip={selectedChip} tabKey={tab} />
            </div>
          </div>

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
