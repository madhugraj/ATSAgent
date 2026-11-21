import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import SpriteText from "three-spritetext";

import type { ForceGraphMethods } from "react-force-graph-3d";

import type { OntologyEdge, OntologyNode } from "@/lib/ontology.server";

const ForceGraph3D = lazy(() => import("react-force-graph-3d"));

/** Same pressure palette the 2D constellation paints with. */
const COLOR = {
  healthy: "#5b4ee6",
  tightening: "#d99a2b",
  scarce: "#d64545",
  dormant: "#9a9aa5",
  selected: "#0f172a",
};

function colorOf(n: OntologyNode) {
  if (n.status === "dormant") return COLOR.dormant;
  if (n.scarcity >= 70) return COLOR.scarce;
  if (n.scarcity >= 45) return COLOR.tightening;
  return COLOR.healthy;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The skill ontology as an interactive 3D force graph. Drag to rotate, scroll to
 * zoom, drag a node to pull the layout; click a node to select it (drives the
 * detail panel beside the map).
 */
export function OntologyGraph3D({
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [width, setWidth] = useState(960);
  const [ready, setReady] = useState(false);

  useEffect(() => setReady(true), []);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { graphData, maxMass } = useMemo(() => {
    const top = nodes.slice(0, limit);
    const slugs = new Set(top.map((n) => n.slug));
    const links = edges
      .filter((e) => slugs.has(e.from) && slugs.has(e.to))
      .slice(0, 220)
      .map((e) => ({ source: e.from, target: e.to, weight: e.weight, count: e.count }));
    return {
      graphData: {
        nodes: top.map((n) => ({
          ...n,
          id: n.slug,
          mass: n.supply + n.demand,
        })),
        links,
      },
      maxMass: Math.max(1, ...top.map((n) => n.supply + n.demand)),
    };
  }, [nodes, edges, limit]);

  const maxMassRef = useRef(maxMass);
  maxMassRef.current = maxMass;

  function nodeThreeObject(node: Record<string, unknown>) {
    const n = node as unknown as OntologyNode & { id: string; mass: number };
    const isSel = n.id === selected;
    const r = 2.5 + 9 * Math.sqrt(n.mass / Math.max(1, maxMassRef.current));
    const group = new THREE.Group();

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(isSel ? r * 1.25 : r, 24, 18),
      new THREE.MeshLambertMaterial({ color: isSel ? COLOR.selected : colorOf(n) }),
    );
    group.add(sphere);

    const label = new SpriteText(n.name, 4, isSel ? "#0f172a" : "#475569");
    label.position.set(0, r + 3, 0);
    label.fontWeight = isSel ? "700" : "500";
    group.add(label);

    return group;
  }

  function nodeTooltip(n: Record<string, unknown>) {
    const node = n as unknown as OntologyNode;
    return `<div style="font:500 12px/1.5 system-ui;padding:6px 9px;border-radius:8px;background:#0f172a;color:#f8fafc">
      ${escapeHtml(node.name)} · ${escapeHtml(node.category)}<br/>
      <span style="opacity:.75">supply ${node.supply} · demand ${node.demand} · scarcity ${node.scarcity}%${node.status === "dormant" ? " · dormant" : ""}</span>
    </div>`;
  }

  const height = 520;

  return (
    <div
      ref={wrapRef}
      className="relative overflow-hidden rounded-lg border bg-card"
      style={{ height }}
    >
      {ready ? (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading the 3D graph…
            </div>
          }
        >
          <ForceGraph3D
            width={width}
            height={height}
            graphData={graphData as never}
            backgroundColor="rgba(0,0,0,0)"
            showNavInfo={false}
            nodeRelSize={1}
            nodeThreeObject={nodeThreeObject as never}
            nodeLabel={nodeTooltip as never}
            linkColor={() => "rgba(148,163,184,0.35)"}
            linkWidth={(l: unknown) => 0.6 + ((l as { weight?: number }).weight ?? 0) * 1.5}
            linkOpacity={0.6}
            onNodeClick={(n: unknown) => onSelect((n as { id: string }).id)}
            ref={fgRef}
            onEngineStop={() => fgRef.current?.zoomToFit(600, 40)}
            warmupTicks={40}
            cooldownTicks={160}
          />
        </Suspense>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Preparing the 3D map…
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-3 text-[0.6875rem] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <i className="inline-block size-2.5 rounded-full" style={{ background: COLOR.healthy }} />{" "}
          healthy supply
        </span>
        <span className="flex items-center gap-1.5">
          <i
            className="inline-block size-2.5 rounded-full"
            style={{ background: COLOR.tightening }}
          />{" "}
          tightening
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block size-2.5 rounded-full" style={{ background: COLOR.scarce }} />{" "}
          scarce
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block size-2.5 rounded-full" style={{ background: COLOR.dormant }} />{" "}
          dormant
        </span>
        <span>drag to rotate · scroll to zoom · click a skill</span>
      </div>
    </div>
  );
}
