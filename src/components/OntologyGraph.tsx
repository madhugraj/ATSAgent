import { useMemo, useState } from "react";
import { Focus, Network } from "lucide-react";

import type { OntologyEdge, OntologyNode } from "@/lib/ontology.server";

type Placed = OntologyNode & { x: number; y: number; r: number };

/** Colour by pressure: violet = comfortable, amber = tightening, red = scarce. */
function fill(n: OntologyNode) {
  if (n.status === "dormant") return "var(--ontology-dormant)";
  if (n.scarcity >= 70) return "var(--ontology-scarce)";
  if (n.scarcity >= 45) return "var(--ontology-tightening)";
  return "var(--ontology-healthy)";
}

/**
 * Capability-family constellation drawn as plain SVG. Each family owns a
 * neighbourhood; inside it, skills are packed in spiral rings with the heaviest
 * (most people plus openings) at the centre, and co-occurrence links are drawn
 * between them.
 */
export function OntologyGraph({
  nodes,
  edges,
  onSelect,
  selected,
  limit = 70,
}: {
  nodes: OntologyNode[];
  edges: OntologyEdge[];
  onSelect: (slug: string) => void;
  selected: string | null;
  limit?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const layout = useMemo(() => {
    const width = 960;
    const top = nodes.slice(0, limit);
    const slugs = new Set(top.map((n) => n.slug));

    const links = edges.filter((e) => slugs.has(e.from) && slugs.has(e.to)).slice(0, 220);

    // Families ordered by size so the biggest neighbourhoods get the roomiest slots.
    const families = new Map<string, OntologyNode[]>();
    for (const n of top) {
      const list = families.get(n.category) ?? [];
      list.push(n);
      families.set(n.category, list);
    }
    const ordered = [...families.entries()].sort((a, b) => b[1].length - a[1].length);

    const maxMass = Math.max(1, ...top.map((n) => n.supply + n.demand));
    const placed: Placed[] = [];
    const clusters: Array<{
      label: string;
      x: number;
      y: number;
      count: number;
      left: number;
      top: number;
      side: number;
    }> = [];

    // Each family gets a box sized by how many skills it holds, then boxes flow
    // left to right and wrap — big neighbourhoods stay legible, small ones stay tight.
    const gap = 18;
    const boxes = ordered.map(([label, list]) => {
      const side = Math.min(300, Math.max(124, 60 + Math.sqrt(list.length) * 46));
      return { label, list, side };
    });

    let cursorX = gap;
    let cursorY = gap;
    let rowH = 0;
    for (const box of boxes) {
      if (cursorX + box.side > width - gap && cursorX > gap) {
        cursorX = gap;
        cursorY += rowH + gap + 14;
        rowH = 0;
      }
      const cx = cursorX + box.side / 2;
      const cy = cursorY + box.side / 2 + 16;
      clusters.push({
        label: box.label,
        x: cx,
        y: cursorY + 18,
        count: box.list.length,
        left: cursorX,
        top: cursorY,
        side: box.side,
      });

      const sorted = box.list.slice().sort((a, b) => b.supply + b.demand - (a.supply + a.demand));
      const rings = Math.max(1, Math.ceil(Math.sqrt(sorted.length / 3)));
      sorted.forEach((n, i) => {
        const r = 5 + Math.round(((n.supply + n.demand) / maxMass) * 13);
        let ring = 0;
        let seen = 0;
        while (seen + Math.max(1, ring * 6) <= i) {
          seen += Math.max(1, ring * 6);
          ring += 1;
        }
        const inRing = i - seen;
        const slots = Math.max(1, ring * 6);
        const angle = (inRing / slots) * Math.PI * 2 + ring * 0.55;
        const radius = ring === 0 ? 0 : (ring / rings) * (box.side / 2 - 14);
        placed.push({
          ...n,
          r,
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
        });
      });

      rowH = Math.max(rowH, box.side + 12);
      cursorX += box.side + gap;
    }

    const contentHeight = Math.max(200, cursorY + rowH + gap);
    return { width, height: contentHeight, placed, links, clusters };
  }, [nodes, edges, limit]);

  const byslug = new Map(layout.placed.map((p) => [p.slug, p]));
  const focus = hover ?? selected;
  const connected = new Set<string>();
  if (focus) {
    connected.add(focus);
    for (const l of layout.links) {
      if (l.from === focus) connected.add(l.to);
      if (l.to === focus) connected.add(l.from);
    }
  }

  return (
    <div className="graph-shell overflow-hidden rounded-2xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-gradient-to-r from-accent/60 via-card to-card px-5 py-3.5">
        <div>
          <p className="text-sm font-semibold tracking-tight">Enterprise skill map</p>
          <p className="text-xs text-muted-foreground">
            {layout.placed.length} priority skills across {layout.clusters.length} capability
            families
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border/70 bg-card/80 px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
          {focus ? (
            <Focus className="size-3.5 text-primary" />
          ) : (
            <Network className="size-3.5 text-primary/70" />
          )}
          {focus ? "Related skills highlighted" : "Select a bubble to trace relationships"}
        </div>
      </div>
      <div className="dotted-canvas relative overflow-auto">
        <div className="graph-bloom pointer-events-none absolute inset-0" />
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="relative h-auto min-w-[760px] w-full"
          role="img"
          aria-label="Organisational skill ontology graph"
        >
          <defs>
            <radialGradient id="og-zone" cx="50%" cy="28%" r="78%">
              <stop offset="0%" stopColor="var(--card)" stopOpacity="0.95" />
              <stop offset="100%" stopColor="var(--ontology-zone)" stopOpacity="1" />
            </radialGradient>
            <filter id="og-soft" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="4" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="og-lift" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow
                dx="0"
                dy="1.4"
                stdDeviation="1.8"
                floodColor="#0b0b0f"
                floodOpacity="0.16"
              />
            </filter>
          </defs>

          <g>
            {layout.clusters.map((c) => (
              <rect
                key={`zone-${c.label}`}
                x={c.left}
                y={c.top}
                width={c.side}
                height={c.side + 12}
                rx="16"
                fill="url(#og-zone)"
                stroke="var(--border)"
                strokeWidth="1"
              />
            ))}
          </g>
          <g>
            {layout.clusters.map((c) => (
              <text
                key={c.label}
                x={c.x}
                y={c.y}
                textAnchor="middle"
                className="fill-muted-foreground font-semibold"
                style={{ fontSize: 9.5, letterSpacing: 0.9, textTransform: "uppercase" }}
              >
                {`${c.label.length > 16 ? `${c.label.slice(0, 15)}…` : c.label} · ${c.count}`}
              </text>
            ))}
          </g>
          <g>
            {layout.links.map((l, index) => {
              const a = byslug.get(l.from);
              const b = byslug.get(l.to);
              if (!a || !b) return null;
              const lit = focus ? connected.has(l.from) && connected.has(l.to) : false;
              // Gentle arc — reads as a relationship, not a wireframe.
              const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.09;
              const my = (a.y + b.y) / 2 + (a.x - b.x) * 0.09;
              return (
                <path
                  key={`${l.from}-${l.to}`}
                  d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
                  fill="none"
                  strokeLinecap="round"
                  stroke={lit ? "var(--primary)" : "var(--border)"}
                  strokeWidth={lit ? 1.9 : Math.min(1.3, 0.3 + l.weight)}
                  strokeOpacity={focus ? (lit ? 0.85 : 0.05) : 0.32}
                  className={focus ? undefined : "graph-link"}
                  style={{
                    transition: "stroke-opacity 220ms ease, stroke 220ms ease",
                    animationDelay: `${(index % 18) * 90}ms`,
                  }}
                />
              );
            })}
          </g>
          <g>
            {layout.placed.map((n, index) => {
              const dim = focus ? !connected.has(n.slug) : false;
              const isFocus = focus === n.slug;
              // Labels only where they can be read: big bubbles, the focus and its neighbours.
              const label =
                n.r >= 11 || focus === n.slug || (focus ? connected.has(n.slug) : false);
              const tone = fill(n);
              return (
                // Position on an outer group: the breathing animation sets a CSS
                // transform on .graph-node, which would replace a translate here.
                <g key={n.slug} transform={`translate(${n.x},${n.y})`}>
                  <g
                    opacity={dim ? 0.22 : 1}
                    onMouseEnter={() => setHover(n.slug)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onSelect(n.slug)}
                    className="graph-node cursor-pointer"
                    style={{
                      transition: "opacity 220ms ease",
                      animationDelay: `${(index % 14) * -170}ms`,
                    }}
                  >
                    <title>{`${n.name} — ${n.supply} in pool, ${n.demand} weighted demand`}</title>
                    {selected === n.slug ? (
                      <circle
                        className="graph-ring"
                        r={n.r + 7}
                        fill="none"
                        stroke={tone}
                        strokeWidth="1.2"
                      />
                    ) : null}
                    <circle r={n.r + 5} fill={tone} opacity={isFocus ? 0.2 : 0.11} />
                    <circle
                      r={n.r}
                      fill={tone}
                      stroke="var(--card)"
                      strokeWidth={selected === n.slug ? 2.4 : 1.6}
                      filter="url(#og-lift)"
                      style={{ transition: "r 200ms ease" }}
                    />
                    <circle r={Math.max(1.6, n.r * 0.32)} fill="var(--card)" opacity={0.55} />
                    {label ? (
                      <text
                        y={n.r + 12}
                        textAnchor="middle"
                        className="fill-foreground"
                        style={{
                          fontSize: 9.5,
                          pointerEvents: "none",
                          paintOrder: "stroke",
                          stroke: "var(--card)",
                          strokeWidth: 3,
                          strokeLinejoin: "round",
                          fontWeight: isFocus ? 600 : 500,
                        }}
                      >
                        {n.name.length > 18 ? `${n.name.slice(0, 17)}…` : n.name}
                      </text>
                    ) : null}
                  </g>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <div className="grid gap-3 border-t bg-surface-2/60 px-5 py-3 text-[11px] text-muted-foreground sm:grid-cols-[auto_1fr] sm:items-center">
        <div className="flex flex-wrap items-center gap-3">
          <Legend colour="var(--ontology-healthy)" label="Healthy" />
          <Legend colour="var(--ontology-tightening)" label="Tightening" />
          <Legend colour="var(--ontology-scarce)" label="Scarce" />
          <Legend colour="var(--ontology-dormant)" label="Dormant" />
        </div>
        <p className="sm:text-right">
          Larger bubbles carry more people and open-role demand. Lines show skills found together.
        </p>
      </div>
    </div>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block size-2.5 rounded-full" style={{ background: colour }} />
      {label}
    </span>
  );
}
