/**
 * Skill supply vs demand (Intelligence, governance roles): the skills your
 * requisitions ask for against the skills your candidate pool holds — verdict,
 * fix list of sourcing gaps, and a diverging bar list. Deterministic.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "@/components/ats";
import { FixList, Panel, Verdict, type Pill } from "@/components/ops-layout";
import { skillSupplyDemand, type SkillGap } from "@/lib/skill-supply.functions";

export const Route = createFileRoute("/skill-supply")({
  head: () => ({
    meta: [
      { title: "Skill supply vs demand — ATSIQ" },
      {
        name: "description",
        content:
          "The skills your requisitions ask for against the skills your candidate pool holds.",
      },
    ],
  }),
  component: SkillSupplyPage,
});

function SkillSupplyPage() {
  const q = useQuery({
    queryKey: ["skill-supply"],
    queryFn: () => skillSupplyDemand(),
    staleTime: 60_000,
  });
  const d = q.data;
  const pills: Pill[] = d
    ? [
        {
          key: "listed",
          label: "Requisition skills",
          status:
            d.counts.requisitions === 0
              ? "none"
              : d.counts.reqsWithSkills === 0
                ? "bad"
                : d.counts.reqsWithSkills < d.counts.requisitions
                  ? "warn"
                  : "good",
        },
        {
          key: "sourcing",
          label: "Sourcing gaps",
          status: d.counts.sourcing ? "bad" : d.counts.reqsWithSkills ? "good" : "none",
        },
        {
          key: "short",
          label: "Thin cover",
          status: d.counts.short ? "warn" : d.counts.reqsWithSkills ? "good" : "none",
        },
      ]
    : [];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Skill supply vs demand"
        description="Which skills your requisitions ask for that your talent pool doesn't have — and the reverse."
      />
      {q.isError && (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          Skill supply vs demand is available to the HR head and CBO.
        </p>
      )}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {d && (
        <>
          <Verdict pills={pills} okText="Your pool covers what you ask for" />
          <FixList
            rows={d.fixes}
            subjectHeader="Skill"
            passing={{
              count: d.counts.covered,
              summary: d.counts.covered
                ? [
                    `${d.counts.covered} skill${d.counts.covered === 1 ? "" : "s"} fully covered by your pool`,
                  ]
                : [],
            }}
          />
          <GapPanel gaps={d.gaps} noRequisitions={d.counts.requisitions === 0} />
          <p className="text-xs text-muted-foreground">
            {d.counts.skills} skills across {d.counts.candidates} candidates and{" "}
            {d.counts.requisitions} requisitions ({d.counts.reqsWithSkills} list their skills).
          </p>
        </>
      )}
    </div>
  );
}

function GapPanel({ gaps, noRequisitions }: { gaps: SkillGap[]; noRequisitions: boolean }) {
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
    <Panel
      title="Skills you ask for vs skills you have"
      hint="Left: requisitions asking · right: candidates holding it · biggest gaps first"
    >
      {gaps.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No skills yet — this fills in as requisitions list skills and CVs arrive.
        </p>
      ) : (
        <div className="px-4 py-3">
          {gaps.every((g) => g.demand === 0) && (
            <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {noRequisitions
                ? "You have no requisitions yet, so there is no demand to compare your pool against."
                : "None of your requisitions list must-have or good-to-have skills yet, so there is nothing to compare against. Add skills to your requisitions to see where you need to source."}
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
                <li
                  key={g.skill}
                  className="grid grid-cols-[1fr_140px_1fr_96px] items-center gap-3 text-xs"
                >
                  <div className="flex items-center justify-end gap-2">
                    <span className="tabular-nums text-muted-foreground">{g.demand || ""}</span>
                    <div
                      className="h-3 rounded-sm bg-blue-500/80"
                      style={{ width: `${(g.demand / peak) * 100}%` }}
                    />
                  </div>
                  <span className="truncate text-center font-medium" title={g.skill}>
                    {g.skill}
                  </span>
                  <div className="flex items-center gap-2">
                    <div
                      className="h-3 rounded-sm bg-emerald-500/80"
                      style={{ width: `${(g.supply / peak) * 100}%` }}
                    />
                    <span className="tabular-nums text-muted-foreground">{g.supply || ""}</span>
                  </div>
                  <span
                    className={`justify-self-start rounded px-1.5 py-0.5 text-[10px] font-semibold ${st.cls}`}
                  >
                    {st.word}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}
