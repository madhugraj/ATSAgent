/**
 * Skill ontology (Intelligence, governance roles): your organisation's skill
 * graph — capability families, the skills inside them, how they co-occur, and
 * supply (talent pool) against demand (requisitions). Verdict, fix list, the
 * ontology graph, what changed in the period and the skills table; the same
 * period drives the downloadable report. Built on the Talent Brain read model
 * (deterministic; the model is only used when the Talent Brain is rebuilt).
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { OntologyGraph } from "@/components/OntologyGraph";
import { PageHeader } from "@/components/ats";
import { FixList, Panel, Verdict, type FixRow, type Pill } from "@/components/ops-layout";
import { ReportBar, useReportWindow } from "@/components/report-bar";
import { readTalentBrain, type TalentBrain } from "@/lib/ontology.functions";
import { downloadOntologyReport } from "@/lib/agent-reports";

export const Route = createFileRoute("/skill-ontology")({
  head: () => ({
    meta: [
      { title: "Skill ontology — ATSIQ" },
      {
        name: "description",
        content:
          "Your organisation's skill graph: families, skills, co-occurrence, and supply against demand.",
      },
    ],
  }),
  component: SkillOntologyPage,
});

type Node = TalentBrain["nodes"][number];

export function ontologyFixes(d: TalentBrain): FixRow[] {
  const fixes: FixRow[] = [];
  const active = d.nodes.filter((n) => n.status !== "retired");
  if (d.stats.requisitions > 0 && active.every((n) => n.demand === 0))
    fixes.push({
      severity: "act",
      what: "No requisition lists its skills",
      why: "Without must-have or good-to-have skills there is nothing to compare your pool against.",
      agents: [],
      next: { label: "Add skills to requisitions", to: "/requisitions" },
    });
  for (const n of active.filter((x) => x.demand > 0 && x.supply === 0).slice(0, 6))
    fixes.push({
      severity: "act",
      what: `${n.name}: asked for ${n.demand}×, nobody in your pool`,
      why: "Every requisition needing this skill depends on new sourcing.",
      agents: [n.name],
      next: { label: "Source candidates", to: "/candidates" },
    });
  for (const n of active
    .filter((x) => x.demand > 0 && x.supply > 0 && x.scarcity >= 70)
    .slice(0, 4))
    fixes.push({
      severity: "watch",
      what: `${n.name} is scarce (${n.supply} in pool for ${n.demand} asks)`,
      why: "Thin cover — one withdrawal leaves a requisition without a candidate.",
      agents: [n.name],
      next: { label: "Source candidates", to: "/candidates" },
    });
  for (const ins of d.insights.filter((i) => i.severity !== "low").slice(0, 5))
    fixes.push({
      severity: ins.severity === "high" ? "act" : "watch",
      what: ins.title,
      why: ins.detail,
      agents: ins.skills.slice(0, 3),
      next: { label: ins.actionLabel ?? "Open master data", to: ins.actionTo ?? "/masters" },
    });
  return fixes.sort((a, b) => Number(a.severity === "watch") - Number(b.severity === "watch"));
}

function SkillOntologyPage() {
  const rw = useReportWindow({ withAgent: false });
  const q = useQuery({
    queryKey: ["skill-ontology"],
    queryFn: () => readTalentBrain({ data: { scope: "org" } }),
    staleTime: 60_000,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const d = q.data;
  const from = new Date(rw.window.from),
    to = new Date(rw.window.to);
  const inPeriod = (iso: string) => {
    const t = new Date(iso);
    return t >= from && t <= to;
  };

  const view = useMemo(() => {
    if (!d) return null;
    const active = d.nodes.filter((n) => n.status !== "retired");
    const gaps = active.filter((n) => n.demand > 0 && n.supply === 0);
    const scarce = active.filter((n) => n.demand > 0 && n.supply > 0 && n.scarcity >= 70);
    const dormant = active.filter((n) => n.status === "dormant");
    const listed = active.some((n) => n.demand > 0);
    const pills: Pill[] = [
      {
        key: "listed",
        label: "Requisition skills",
        status: d.stats.requisitions === 0 ? "none" : listed ? "good" : "bad",
      },
      {
        key: "gaps",
        label: "Sourcing gaps",
        status: gaps.length ? "bad" : listed ? "good" : "none",
      },
      { key: "scarce", label: "Scarce", status: scarce.length ? "warn" : listed ? "good" : "none" },
      {
        key: "dormant",
        label: "Dormant",
        status: dormant.length ? "warn" : active.length ? "good" : "none",
      },
    ];
    const covered = active.filter((n) => n.demand > 0 && n.supply >= n.demand).length;
    return { active, pills, covered };
  }, [d]);

  const sel: Node | undefined = d?.nodes.find((n) => n.slug === selected);
  const neighbours = sel
    ? (d?.edges ?? [])
        .filter((e) => e.from === sel.slug || e.to === sel.slug)
        .sort((a, b) => b.count - a.count)
        .slice(0, 6)
        .map(
          (e) =>
            d!.nodes.find((n) => n.slug === (e.from === sel.slug ? e.to : e.from))?.name ?? "?",
        )
    : [];
  const newInPeriod = d ? d.nodes.filter((n) => inPeriod(n.firstSeenAt)) : [];
  const snapshots = d ? d.history.filter((h) => inPeriod(h.at)) : [];
  const sorted = view
    ? [...view.active].sort(
        (a, b) => b.scarcity - a.scarcity || b.demand - a.demand || b.supply - a.supply,
      )
    : [];
  const rows = showAll ? sorted : sorted.slice(0, 20);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Skill ontology"
        description="Your organisation's skill graph — capability families, the skills in them, how they co-occur, and what your pool holds against what you ask for."
        actions={
          <ReportBar
            rw={rw}
            disabled={!d}
            onDownload={(kind) => d && downloadOntologyReport(kind, d, rw.window, ontologyFixes(d))}
          />
        }
      />
      {q.isError && (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          The skill ontology could not be loaded.
        </p>
      )}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {d && view && (
        <>
          <Verdict
            pills={view.pills}
            okText={
              d.stats.requisitions === 0
                ? "No requisitions to compare yet"
                : "Your pool covers what you ask for"
            }
            neutral={d.stats.requisitions === 0}
          />
          <FixList
            rows={ontologyFixes(d)}
            subjectHeader="Skill"
            passing={{
              count: view.covered,
              summary: view.covered
                ? [
                    `${view.covered} skill${view.covered === 1 ? "" : "s"} fully covered by your pool`,
                  ]
                : [],
            }}
          />

          <Panel
            title="Ontology graph"
            hint={`${d.stats.nodeCount} skills · ${d.stats.edgeCount} co-occurrence links · click a skill for detail`}
          >
            <div className="flex justify-end px-4 pt-1 text-xs">
              <Link to="/brain" className="font-medium text-primary hover:underline">
                Open in 3D (Talent Brain) →
              </Link>
            </div>
            {d.nodes.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                No skills yet — this fills in as CVs and requisitions arrive.
              </p>
            ) : (
              <div className="px-2 py-2">
                <OntologyGraph
                  nodes={view.active}
                  edges={d.edges}
                  selected={selected}
                  onSelect={(slug) => setSelected((cur) => (cur === slug ? null : slug))}
                />
              </div>
            )}
            {sel && (
              <div className="border-t border-border bg-muted/30 px-4 py-3 text-[13px]">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold">
                    {sel.name}{" "}
                    <span className="font-normal text-muted-foreground">· {sel.category}</span>
                  </p>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setSelected(null)}
                  >
                    Close
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-3 text-xs md:grid-cols-6">
                  <p>
                    <span className="block text-muted-foreground">In pool</span>
                    {sel.supply}
                  </p>
                  <p>
                    <span className="block text-muted-foreground">Asked for</span>
                    {sel.demand}
                  </p>
                  <p>
                    <span className="block text-muted-foreground">Scarcity</span>
                    {sel.scarcity}/100
                  </p>
                  <p>
                    <span className="block text-muted-foreground">Evidence</span>
                    {sel.evidence}
                  </p>
                  <p>
                    <span className="block text-muted-foreground">First seen</span>
                    {new Date(sel.firstSeenAt).toLocaleDateString()}
                  </p>
                  <p>
                    <span className="block text-muted-foreground">Status</span>
                    {sel.status}
                  </p>
                </div>
                {sel.aliases.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Also written as: {sel.aliases.join(", ")}
                  </p>
                )}
                {neighbours.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Appears with: {neighbours.join(", ")}
                  </p>
                )}
              </div>
            )}
          </Panel>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Panel title="Changes in this period" hint={rw.label}>
              <div className="space-y-2 px-4 py-3 text-[13px]">
                <p>
                  <b>{newInPeriod.length}</b> skill{newInPeriod.length === 1 ? "" : "s"} first seen
                  {newInPeriod.length > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      —{" "}
                      {newInPeriod
                        .slice(0, 8)
                        .map((n) => n.name)
                        .join(", ")}
                      {newInPeriod.length > 8 ? "…" : ""}
                    </span>
                  )}
                </p>
                <p>
                  <b>{snapshots.length}</b> ontology rebuild{snapshots.length === 1 ? "" : "s"}
                  {snapshots.length > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      — {snapshots.reduce((s, h) => s + h.added, 0)} added ·{" "}
                      {snapshots.reduce((s, h) => s + h.grown, 0)} grown ·{" "}
                      {snapshots.reduce((s, h) => s + h.dormant, 0)} went dormant ·{" "}
                      {snapshots.reduce((s, h) => s + h.retired, 0)} retired
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Built from {d.stats.candidates} candidates and {d.stats.requisitions} requisitions
                  {d.builtAt
                    ? ` · last rebuilt ${new Date(d.builtAt).toLocaleDateString()}`
                    : " · not yet rebuilt (live build)"}
                  .
                </p>
              </div>
            </Panel>

            <Panel title="Skills" hint="Most pressured first">
              <table className="mt-2 w-full text-[13px] tabular-nums">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Skill</th>
                    <th className="px-4 py-2 font-medium">Family</th>
                    <th className="px-4 py-2 text-right font-medium">In pool</th>
                    <th className="px-4 py-2 text-right font-medium">Asked for</th>
                    <th className="px-4 py-2 text-right font-medium">Scarcity</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((n) => (
                    <tr
                      key={n.slug}
                      className={`cursor-pointer border-b border-border last:border-0 hover:bg-muted/40 ${selected === n.slug ? "bg-primary/5" : ""}`}
                      onClick={() => setSelected(n.slug)}
                    >
                      <td className="px-4 py-2 font-medium">
                        {n.name}
                        {n.status === "dormant" && (
                          <span className="ml-1.5 text-xs text-muted-foreground">dormant</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{n.category}</td>
                      <td className="px-4 py-2 text-right">{n.supply}</td>
                      <td className="px-4 py-2 text-right">{n.demand}</td>
                      <td
                        className={`px-4 py-2 text-right ${n.scarcity >= 70 ? "font-semibold text-red-600" : n.scarcity >= 45 ? "text-amber-600" : ""}`}
                      >
                        {n.scarcity}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sorted.length > 20 && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="w-full border-t border-border px-4 py-2 text-left text-xs font-medium text-primary hover:bg-muted/40"
                >
                  {showAll ? "Show fewer" : `Show all ${sorted.length} skills`}
                </button>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
