/**
 * Talent Brain (leadership and governance roles): the organisation's skill and
 * role ontology on one page — verdict and fix list (sourcing gaps, scarce,
 * emerging skills, new roles forming), the 3D role map with new-role
 * emergence (full screen, record), the skill graph with search, what changed
 * in the period, the skills table and PDF / Excel reports. Relearn rebuilds
 * the ontology (the model curates families and aliases through the gateway);
 * the product super admin can switch to all organisations. /skill-ontology
 * redirects here.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { OntologyGraph } from "@/components/OntologyGraph";
import { PageHeader } from "@/components/ats";
import { FixList, Panel, Verdict, type FixRow, type Pill } from "@/components/ops-layout";
import { ReportBar, useReportWindow } from "@/components/report-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePlatform } from "@/hooks/usePlatform";
import { readTalentBrain, rebuildTalentBrain, type TalentBrain } from "@/lib/ontology.functions";
import { readOrgOntology, type OrgOntology } from "@/lib/org-ontology.functions";
import { OrgOntologyExplorer } from "@/components/OrgOntologyExplorer";
import { downloadOntologyReport } from "@/lib/agent-reports";

export const Route = createFileRoute("/brain")({
  head: () => ({
    meta: [
      { title: "Talent Brain — your organisation's living skill ontology" },
      {
        name: "description",
        content:
          "A graphical talent ontology for the CHRO: canonical skills, evidence, supply against demand, reskilling paths and how the graph grows or retires over time.",
      },
      { property: "og:title", content: "ATSIQ Talent Brain" },
      {
        property: "og:description",
        content:
          "Evidence-linked skill graph with executive prescriptions, growth history and cross-organisation view.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TalentBrainPage,
});

type Node = TalentBrain["nodes"][number];

export function ontologyFixes(d: TalentBrain, org?: OrgOntology): FixRow[] {
  const fixes: FixRow[] = [];
  for (const e of org?.emerging ?? []) {
    if (e.confirmed || e.status === "signal") continue;
    const parents = e.parents.map(
      (p) => [...org!.roles, ...org!.emerging].find((r) => r.id === p)?.name ?? p,
    );
    fixes.push({
      severity: e.status === "established" ? "act" : "watch",
      what: `New role forming: ${e.name}`,
      why: `Born from ${parents.join(" + ")} — ${e.requisitions} requisitions so far, ${e.supply} in your pool. Confirm it into job architecture so it can be hired against.`,
      agents: [e.name],
      next: { label: "Review and confirm", to: "#roles" },
    });
  }
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

function TalentBrainPage() {
  const rw = useReportWindow({ withAgent: false });
  const { isSuperUser } = usePlatform();
  const [scope, setScope] = useState<"org" | "platform">("org");
  const [search, setSearch] = useState("");
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["talent_brain", scope],
    queryFn: () => readTalentBrain({ data: { scope } }),
    staleTime: 60_000,
    retry: false,
  });
  const rebuilding = useMutation({
    mutationFn: () => rebuildTalentBrain({ data: {} }),
    onSuccess: (data: TalentBrain) => {
      qc.setQueryData(["talent_brain", "org"], data);
      void qc.invalidateQueries({ queryKey: ["org-ontology"] });
      toast.success(
        `Ontology relearned — ${data.stats.nodeCount} skills, ${data.diff.added.length} new, ${data.diff.retired.length} retired.`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const org = useQuery({
    queryKey: ["org-ontology"],
    queryFn: () => readOrgOntology(),
    staleTime: 60_000,
    retry: false,
    enabled: scope === "org",
  });
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
  const needle = search.trim().toLowerCase();
  const matches = (n: Node) =>
    !needle ||
    n.name.toLowerCase().includes(needle) ||
    n.category.toLowerCase().includes(needle) ||
    n.aliases.some((a) => a.toLowerCase().includes(needle));
  const shown = sorted.filter(matches);
  const rows = showAll || needle ? shown : shown.slice(0, 20);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Leadership intelligence"
        title="Talent Brain"
        description={`Every CV, requisition and hire feeds one skill and role ontology for ${d?.orgName ?? "your organisation"} — capability families, the skills in them, the roles they form, and what your pool holds against what you ask for. Skills with no fresh evidence go dormant and then retire on their own.`}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {isSuperUser && (
              <div className="flex rounded-md border bg-card p-0.5">
                {(["org", "platform"] as const).map((s) => (
                  <Button
                    key={s}
                    type="button"
                    size="sm"
                    variant={scope === s ? "default" : "ghost"}
                    onClick={() => {
                      setScope(s);
                      setSelected(null);
                    }}
                    className="h-7 px-3 text-xs shadow-none"
                  >
                    {s === "org" ? "My organisation" : "All organisations"}
                  </Button>
                ))}
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => rebuilding.mutate()}
              disabled={rebuilding.isPending || scope === "platform"}
            >
              <RefreshCw
                className={`mr-1.5 size-3.5 ${rebuilding.isPending ? "animate-spin" : ""}`}
              />
              {rebuilding.isPending ? "Learning…" : "Relearn ontology"}
            </Button>
            <ReportBar
              rw={rw}
              disabled={!d}
              onDownload={(kind) =>
                d &&
                downloadOntologyReport(kind, d, rw.window, ontologyFixes(d, org.data), org.data)
              }
            />
          </div>
        }
      />
      {q.isError && (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          {(q.error as Error | null)?.message ?? "The Talent Brain could not be loaded."}
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
            rows={ontologyFixes(d, org.data)}
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

          {d.narrative && (
            <section className="rounded-xl border border-border border-l-2 border-l-primary bg-card p-4">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Executive reading
              </p>
              <p className="mt-1 text-sm leading-relaxed">{d.narrative}</p>
            </section>
          )}

          <details className="rounded-xl border border-border bg-card px-4 py-3 text-[13px]">
            <summary className="cursor-pointer font-semibold">Read this page in 30 seconds</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Bigger bubbles carry more people and more open-role demand.</li>
              <li>
                Colour is pressure: comfortable, tightening, scarce, dormant. Red needs action.
              </li>
              <li>Click a skill to see the skills found alongside it — paths for reskilling.</li>
              <li>
                New roles glow in the 3D map; press play to watch them form, click one to name and
                confirm it.
              </li>
            </ul>
          </details>

          {scope === "org" && (
            <div id="roles" className="scroll-mt-4">
              <Panel
                title={`Roles and how new ones are forming${org.data ? ` · ${org.data.domain.name}` : ""}`}
                hint="Press play to watch roles form month by month · click a new role to name and confirm it"
              >
                <div className="p-3">
                  {org.data ? (
                    <OrgOntologyExplorer ont={org.data} queryKey={["org-ontology"]} />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {org.isError
                        ? "The role map is available to the HR head and CBO."
                        : "Loading…"}
                    </p>
                  )}
                </div>
              </Panel>
            </div>
          )}

          <Panel
            title="Skill graph"
            hint={`${d.stats.nodeCount} skills · ${d.stats.edgeCount} co-occurrence links · click a skill for detail`}
          >
            <div className="relative mx-4 mt-2 max-w-sm">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find a skill or capability family"
                className="h-8 pl-9 text-[13px]"
              />
            </div>
            {d.nodes.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                No skills yet — this fills in as CVs and requisitions arrive.
              </p>
            ) : (
              <div className="px-2 py-2">
                <OntologyGraph
                  nodes={view.active.filter(matches)}
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
              {!needle && sorted.length > 20 && (
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
