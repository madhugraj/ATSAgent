import { Link } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Brain,
  CircleHelp,
  Link2,
  RefreshCw,
  Search,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";

import { readTalentBrain, rebuildTalentBrain, type TalentBrain } from "@/lib/ontology.functions";
import { readOrgOntology } from "@/lib/org-ontology.functions";
import { OrgOntologyExplorer } from "@/components/OrgOntologyExplorer";
import { usePlatform } from "@/hooks/usePlatform";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { OntologyGraph } from "@/components/OntologyGraph";
// three / react-force-graph-3d touch `window` at module scope, so this module
// must never be evaluated during server rendering — load it lazily, client-side.
// The 3D view is the organisation ontology (domain → families → skills →
// roles, with emerging roles); it loads three lazily, client-side only.
function OrgOntology3DView() {
  const read = useServerFn(readOrgOntology);
  const q = useQuery({ queryKey: ["org-ontology"], queryFn: () => read() });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading the 3D map…</p>;
  if (!q.data)
    return (
      <p className="text-sm text-muted-foreground">
        The organisation ontology could not be loaded.
      </p>
    );
  return <OrgOntologyExplorer ont={q.data} queryKey={["org-ontology"]} />;
}

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

function TalentBrainPage() {
  const { isSuperUser } = usePlatform();
  const [scope, setScope] = useState<"org" | "platform">("org");
  const [view, setView] = useState<"3d" | "2d">("3d");
  const orgView3d = view === "3d" && scope === "org";
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const qc = useQueryClient();

  const read = useServerFn(readTalentBrain);
  const rebuild = useServerFn(rebuildTalentBrain);

  const brain = useQuery({
    queryKey: ["talent_brain", scope],
    queryFn: () => read({ data: { scope } }),
    retry: false,
  });

  const rebuilding = useMutation({
    mutationFn: () => rebuild({ data: {} }),
    onSuccess: (data: TalentBrain) => {
      qc.setQueryData(["talent_brain", "org"], data);
      toast.success(
        `Ontology rebuilt — ${data.stats.nodeCount} skills, ${data.diff.added.length} new, ${data.diff.retired.length} retired.`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const data = brain.data;
  const nodes = useMemo(() => {
    const list = data?.nodes ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (n) =>
        n.name.toLowerCase().includes(needle) ||
        n.category.toLowerCase().includes(needle) ||
        n.aliases.some((a) => a.toLowerCase().includes(needle)),
    );
  }, [data, q]);

  const node = data?.nodes.find((n) => n.slug === selected) ?? null;
  const neighbours = useMemo(() => {
    if (!data || !selected) return [] as Array<{ slug: string; name: string; weight: number }>;
    const map = new Map(data.nodes.map((n) => [n.slug, n.name]));
    return data.edges
      .filter((e) => e.from === selected || e.to === selected)
      .map((e) => {
        const other = e.from === selected ? e.to : e.from;
        return { slug: other, name: map.get(other) ?? other, weight: e.weight };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10);
  }, [data, selected]);

  if (brain.isError) {
    return (
      <div className="p-6">
        <h1 className="font-display text-xl">Talent Brain</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          {(brain.error as Error).message}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="dotted-canvas -mx-4 -mt-4 flex flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-6 sm:-mx-6 sm:-mt-6 sm:px-6">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-widest text-primary">
            Leadership intelligence
          </p>
          <h1 className="flex items-center gap-2 font-display text-2xl">
            <Brain className="size-6 text-primary" /> Talent Brain
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Every CV, requisition and hire feeds one skill ontology for{" "}
            {data?.orgName ?? "your organisation"}. It grows as new evidence arrives, and skills
            with no fresh evidence go dormant and then retire on their own.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isSuperUser ? (
            <div className="flex rounded-md border bg-card p-0.5 shadow-sm">
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
          ) : null}
          <Button
            onClick={() => rebuilding.mutate()}
            disabled={rebuilding.isPending || scope === "platform"}
          >
            <RefreshCw className={`mr-2 size-4 ${rebuilding.isPending ? "animate-spin" : ""}`} />
            {rebuilding.isPending ? "Learning…" : "Relearn ontology"}
          </Button>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Figure label="Skills mapped" value={data?.stats.nodeCount} />
        <Figure label="Skill links" value={data?.stats.edgeCount} />
        <Figure label="People as evidence" value={data?.stats.candidates} />
        <Figure label="Open roles" value={data?.stats.requisitions} />
        <Figure label="Scarce skills" value={data?.stats.scarce} tone="warn" />
        <Figure label="Role coverage" value={data ? `${data.stats.coverage}%` : undefined} />
      </div>

      {data?.narrative ? (
        <section className="panel-lift border-l-2 border-l-primary p-4">
          <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
            Executive reading
          </p>
          <p className="mt-2 text-sm leading-relaxed">{data.narrative}</p>
        </section>
      ) : null}

      <div className={orgView3d ? "grid gap-4" : "grid gap-4 lg:grid-cols-[1fr_320px]"}>
        <div className="space-y-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a skill or capability family"
              className="pl-9"
            />
          </div>
          <section className="panel-lift p-4">
            <div className="flex items-center gap-2">
              <CircleHelp className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">Read this map in 30 seconds</h2>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Guide
                icon={Users}
                title="Start with size"
                text="Large bubbles combine strong talent supply with open-role demand."
              />
              <Guide
                icon={Target}
                title="Check pressure"
                text="Red needs action, amber needs monitoring, violet has healthier coverage."
              />
              <Guide
                icon={Link2}
                title="Trace adjacencies"
                text="Select a skill to reveal capabilities commonly found alongside it."
              />
              <Guide
                icon={TrendingUp}
                title="Act on movement"
                text="Use emerging, fading and scarce signals to hire, build or redeploy talent."
              />
            </div>
          </section>
          <div className="mb-3 flex items-center justify-end gap-1.5">
            {(["3d", "2d"] as const).map((v) => (
              <Button
                key={v}
                type="button"
                size="sm"
                variant={view === v ? "default" : "ghost"}
                onClick={() => setView(v)}
                className="h-7 px-2.5 text-xs shadow-none"
              >
                {v.toUpperCase()}
              </Button>
            ))}
          </div>
          {brain.isLoading ? (
            <p className="text-sm text-muted-foreground">Reading the ontology…</p>
          ) : !nodes.length ? (
            <p className="panel-lift p-6 text-sm text-muted-foreground">
              No skill evidence yet. Add candidates or raise a requisition, then press “Relearn
              ontology”.
            </p>
          ) : mounted && view === "3d" && scope === "org" ? (
            <OrgOntology3DView />
          ) : (
            <OntologyGraph
              nodes={nodes}
              edges={data?.edges ?? []}
              selected={selected}
              onSelect={(slug) => setSelected((cur) => (cur === slug ? null : slug))}
            />
          )}
        </div>

        {/* the 3D explorer carries its own detail panel */}
        <aside className={orgView3d ? "hidden" : "space-y-4"}>
          <section className="panel-lift p-4">
            <h2 className="text-sm font-semibold">{node ? node.name : "Select a skill"}</h2>
            {node ? (
              <div className="mt-3 space-y-3 text-sm">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary">{node.category}</Badge>
                  <Badge variant={node.status === "active" ? "outline" : "secondary"}>
                    {node.status}
                  </Badge>
                  {node.scarcity >= 60 ? <Badge variant="destructive">scarce</Badge> : null}
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <Stat label="People in pool" value={node.supply} />
                  <Stat label="Weighted demand" value={node.demand} />
                  <Stat label="Proven by hires" value={node.validated} />
                  <Stat label="Live evidence weight" value={node.weight} />
                </dl>
                <p className="text-xs text-muted-foreground">
                  Known as: {node.aliases.slice(0, 6).join(", ") || node.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  First seen {new Date(node.firstSeenAt).toLocaleDateString()} · last evidence{" "}
                  {new Date(node.lastSeenAt).toLocaleDateString()}
                </p>
                {neighbours.length ? (
                  <div>
                    <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
                      Pairs with
                    </p>
                    <ul className="mt-1 space-y-1 text-xs">
                      {neighbours.map((n) => (
                        <li key={n.slug}>
                          <Button
                            className="text-left hover:text-primary"
                            type="button"
                            variant="link"
                            size="sm"
                            onClick={() => setSelected(n.slug)}
                          >
                            {n.name} · {Math.round(n.weight * 100)}%
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                Click a bubble to see its evidence, adjacent skills and hiring pressure.
              </p>
            )}
          </section>

          <section className="panel-lift p-4">
            <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
              How the graph moved
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              <li className="flex items-center gap-2 text-emerald-600">
                <TrendingUp className="size-3.5" /> {data?.diff.added.length ?? 0} new skills ·{" "}
                {data?.diff.grown.length ?? 0} grew
              </li>
              <li className="flex items-center gap-2 text-amber-600">
                <TrendingDown className="size-3.5" /> {data?.diff.dormant.length ?? 0} went dormant
                · {data?.diff.retired.length ?? 0} retired
              </li>
            </ul>
            {data?.history.length ? (
              <div className="mt-3 flex h-16 items-end gap-1">
                {data.history.map((h) => {
                  const max = Math.max(...data.history.map((x) => x.nodes), 1);
                  return (
                    <div
                      key={h.at}
                      title={`${new Date(h.at).toLocaleDateString()} — ${h.nodes} skills, +${h.added} new, -${h.retired} retired`}
                      className="flex-1 rounded-t bg-primary/70"
                      style={{ height: `${Math.max(6, (h.nodes / max) * 100)}%` }}
                    />
                  );
                })}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                History appears after the first relearn.
              </p>
            )}
          </section>
        </aside>
      </div>

      <section className="space-y-3">
        <h2 className="font-display text-lg">Decisions & prescriptions</h2>
        {data?.insights.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {data.insights.map((i) => (
              <article key={i.kind} className="panel-lift p-4 hover:panel-lift-hover">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{i.title}</h3>
                  <Badge
                    variant={
                      i.severity === "high"
                        ? "destructive"
                        : i.severity === "medium"
                          ? "default"
                          : "secondary"
                    }
                  >
                    {i.severity}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{i.detail}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {i.skills.slice(0, 8).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSelected(s)}
                      className="rounded-full border px-2 py-0.5 text-[11px] hover:border-primary hover:text-primary"
                    >
                      {data.nodes.find((n) => n.slug === s)?.name ?? s}
                    </button>
                  ))}
                </div>
                {i.actionTo ? (
                  <Link
                    to={i.actionTo}
                    className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    {i.actionLabel ?? "Act on this"} →
                  </Link>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Prescriptions appear once the pool and open roles share enough skill evidence.
          </p>
        )}
      </section>
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value?: number | string | undefined;
  tone?: "warn" | undefined;
}) {
  return (
    <div className="panel-lift hover:panel-lift-hover p-4">
      <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p
        className={`num mt-1.5 text-2xl font-semibold leading-none tracking-tight ${
          tone === "warn" ? "text-warning" : ""
        }`}
      >
        {value ?? "—"}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-2">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function Guide({ icon: Icon, title, text }: { icon: typeof Users; title: string; text: string }) {
  return (
    <div className="flex gap-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
        <Icon className="size-3.5" />
      </span>
      <div>
        <p className="text-xs font-semibold">{title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
