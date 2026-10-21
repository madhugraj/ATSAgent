import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { sourceLabel } from "@/lib/job-channels";

import {
  applicationsQuery,
  candidatesQuery,
  departmentsQuery,
  interviewsQuery,
  latestScores,
  matchScoresQuery,
  offersQuery,
  requisitionsQuery,
} from "@/lib/data";
import { canonical, FLOW, isTerminal, stalledDays, STAGE_LABEL, type Stage } from "@/lib/lifecycle";
import { HrPerformance } from "@/components/HrPerformance";
import { EmptyState, PageHeader, ScoreBar, StatCard, inr } from "@/components/ats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/reports")({
  head: () => ({
    meta: [
      { title: "Hiring Analytics — funnel, SLA, offers & interview load" },
      {
        name: "description",
        content:
          "Enterprise hiring analytics: stage-to-stage conversion, ageing and SLA breaches, offer acceptance, department and skill breakdowns, interviewer load and drop-off reasons — filterable and exportable.",
      },
      { property: "og:title", content: "Hiring Analytics — funnel, SLA, offers & interview load" },
      {
        property: "og:description",
        content:
          "Filter by department, requisition, location and period; see conversion, ageing, offer outcomes, skill gaps and interviewer load.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Reports,
});

/** Funnel steps reported on, in order. */
const FUNNEL: Stage[] = [
  "sourced",
  "applied",
  "ai_screened",
  "shortlisted",
  "l1",
  "l2",
  "l3",
  "offer_pending",
  "offer_released",
  "offer_accepted",
  "joined",
];

const PERIODS = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 12 months" },
  { value: "all", label: "All time" },
];

function pct(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function median(values: number[]) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round(((s[mid - 1]! + s[mid]!) / 2) * 10) / 10;
}

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Reports() {
  const apps = useQuery(applicationsQuery);
  const reqs = useQuery(requisitionsQuery);
  const cands = useQuery(candidatesQuery);
  const scores = useQuery(matchScoresQuery);
  const depts = useQuery(departmentsQuery);
  const offers = useQuery(offersQuery);
  const ivs = useQuery(interviewsQuery);

  const [dept, setDept] = useState("all");
  const [reqId, setReqId] = useState("all");
  const [location, setLocation] = useState("all");
  const [period, setPeriod] = useState("90");
  const [search, setSearch] = useState("");

  const requisitions = reqs.data ?? [];
  const candidates = cands.data ?? [];
  const scoreMap = latestScores(scores.data ?? []);

  const locations = useMemo(
    () =>
      Array.from(
        new Set(requisitions.map((r) => r.location).filter((l): l is string => Boolean(l))),
      ).sort(),
    [requisitions],
  );

  const since = period === "all" ? null : Date.now() - Number(period) * 86_400_000;

  /** Requisitions inside the department / location / requisition filter. */
  const reqScope = useMemo(() => {
    const set = new Set(
      requisitions
        .filter(
          (r) =>
            (dept === "all" || r.department_id === dept) &&
            (location === "all" || r.location === location),
        )
        .filter((r) => reqId === "all" || r.id === reqId)
        .map((r) => r.id),
    );
    return set;
  }, [requisitions, dept, location, reqId]);

  const candById = useMemo(() => new Map(candidates.map((c) => [c.id, c])), [candidates]);
  const reqById = useMemo(() => new Map(requisitions.map((r) => [r.id, r])), [requisitions]);

  const applications = useMemo(
    () =>
      (apps.data ?? [])
        .filter((a) => reqScope.has(a.requisition_id))
        .filter((a) => !since || new Date(a.applied_at).getTime() >= since)
        .filter((a) => {
          if (!search.trim()) return true;
          const q = search.trim().toLowerCase();
          const c = candById.get(a.candidate_id);
          const r = reqById.get(a.requisition_id);
          return (
            (c?.full_name ?? "").toLowerCase().includes(q) ||
            (c?.skills ?? []).some((s) => s.toLowerCase().includes(q)) ||
            (r?.title ?? "").toLowerCase().includes(q)
          );
        }),
    [apps.data, reqScope, since, search, candById, reqById],
  );

  const appIds = new Set(applications.map((a) => a.id));
  const scopedOffers = (offers.data ?? []).filter((o) => appIds.has(o.application_id));
  const scopedInterviews = (ivs.data ?? []).filter((i) => appIds.has(i.application_id));

  const stageCount = (s: Stage) => applications.filter((a) => canonical(a.stage) === s).length;

  /** Cumulative funnel: how many reached each step, from stage plus everyone beyond it. */
  const reached = FUNNEL.map((s, i) => {
    const laterStages = new Set(FLOW.slice(i));
    const count = applications.filter((a) => {
      const c = canonical(a.stage);
      return laterStages.has(c);
    }).length;
    return { stage: s, count };
  });
  const top = Math.max(1, reached[0]?.count ?? 1);

  const active = applications.filter((a) => !isTerminal(canonical(a.stage)));
  const stalled = active.filter((a) => stalledDays(a.stage as Stage, a.last_activity_at) !== null);
  const joined = applications.filter((a) => canonical(a.stage) === "joined");
  const released = scopedOffers.filter((o) =>
    ["released", "accepted", "declined"].includes(o.status),
  );
  const accepted = scopedOffers.filter((o) => o.status === "accepted");

  const timeToHire = median(
    joined.map(
      (a) =>
        (new Date(a.last_activity_at).getTime() - new Date(a.applied_at).getTime()) / 86_400_000,
    ),
  );

  /** Drop-off reasons — the audited stage_reason on closed applications. */
  const dropOff = Object.entries(
    applications
      .filter((a) =>
        ["rejected", "withdrawn", "offer_declined", "no_show"].includes(canonical(a.stage)),
      )
      .reduce<Record<string, number>>((acc, a) => {
        const key =
          a.stage_reason?.trim() || `${STAGE_LABEL[canonical(a.stage)]} — no reason recorded`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
  ).sort((a, b) => b[1] - a[1]);

  /** Missing must-have skills across scored applications — where the market is tight. */
  const skillGaps = Object.entries(
    applications.reduce<Record<string, number>>((acc, a) => {
      for (const s of scoreMap.get(a.id)?.missing_skills ?? []) acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  /** Department scoreboard — the view a CHRO of a 100k-person org actually reads. */
  const deptRows = (depts.data ?? [])
    .map((d) => {
      const rs = requisitions.filter((r) => r.department_id === d.id);
      const ids = new Set(rs.map((r) => r.id));
      const as = applications.filter((a) => ids.has(a.requisition_id));
      const dj = as.filter((a) => canonical(a.stage) === "joined").length;
      const openings = rs.reduce((s, r) => s + r.openings, 0);
      return {
        id: d.id,
        name: d.name,
        reqs: rs.length,
        openings,
        pipeline: as.filter((a) => !isTerminal(canonical(a.stage))).length,
        interviewing: as.filter((a) => ["l1", "l2", "l3"].includes(canonical(a.stage))).length,
        offers: scopedOffers.filter((o) => as.some((a) => a.id === o.application_id)).length,
        joined: dj,
        fill: pct(dj, openings),
        committed: rs.reduce((s, r) => s + Number(r.budget_ctc) * r.openings, 0),
        budget: Number(d.budgeted_cost),
      };
    })
    .filter((r) => dept === "all" || r.id === dept)
    .sort((a, b) => b.openings - a.openings);

  /** Requisition hotlist — where hiring is at risk. */
  const reqRows = requisitions
    .filter((r) => reqScope.has(r.id))
    .map((r) => {
      const as = applications.filter((a) => a.requisition_id === r.id);
      const j = as.filter((a) => canonical(a.stage) === "joined").length;
      const scored = as.filter((a) => scoreMap.has(a.id));
      return {
        id: r.id,
        title: r.title,
        code: r.code,
        location: r.location ?? "—",
        openings: r.openings,
        pipeline: as.filter((a) => !isTerminal(canonical(a.stage))).length,
        interviews: scopedInterviews.filter((i) => as.some((a) => a.id === i.application_id))
          .length,
        joined: j,
        gap: r.openings - j,
        stalled: as.filter((a) => stalledDays(a.stage as Stage, a.last_activity_at) !== null)
          .length,
        avgScore: scored.length
          ? Math.round(
              scored.reduce((s, a) => s + scoreMap.get(a.id)!.overall_score, 0) / scored.length,
            )
          : null,
        ageDays: Math.floor((Date.now() - new Date(r.opened_at).getTime()) / 86_400_000),
      };
    })
    .sort((a, b) => b.gap - a.gap || b.stalled - a.stalled)
    .slice(0, 15);

  /** Interviewer load — who is over-committed this week. */
  const weekAhead = Date.now() + 7 * 86_400_000;
  const panelRows = Object.entries(
    scopedInterviews.reduce<Record<string, { total: number; upcoming: number; done: number }>>(
      (acc, i) => {
        const key = i.interviewer?.trim() || i.interviewer_email?.trim() || "Unassigned";
        const row = (acc[key] ??= { total: 0, upcoming: 0, done: 0 });
        row.total += 1;
        const at = i.scheduled_at ? new Date(i.scheduled_at).getTime() : null;
        if (at && at >= Date.now() && at <= weekAhead) row.upcoming += 1;
        if (i.status === "completed") row.done += 1;
        return acc;
      },
      {},
    ),
  )
    .sort((a, b) => b[1].upcoming - a[1].upcoming || b[1].total - a[1].total)
    .slice(0, 12);

  const scored = applications.filter((a) => scoreMap.has(a.id));
  const avg = (pick: (id: string) => number) =>
    scored.length ? Math.round(scored.reduce((s, a) => s + pick(a.id), 0) / scored.length) : 0;

  const sources = Object.entries(
    applications.reduce<Record<string, number>>((acc, a) => {
      acc[a.source] = (acc[a.source] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);

  function exportPipeline() {
    downloadCsv("pipeline", [
      [
        "Candidate",
        "Requisition",
        "Department",
        "Location",
        "Stage",
        "Match",
        "Source",
        "Applied",
        "Stalled days",
      ],
      ...applications.map((a) => {
        const c = candById.get(a.candidate_id);
        const r = reqById.get(a.requisition_id);
        const d = (depts.data ?? []).find((x) => x.id === r?.department_id);
        return [
          c?.full_name ?? "",
          r?.title ?? "",
          d?.name ?? "",
          r?.location ?? "",
          STAGE_LABEL[canonical(a.stage)],
          scoreMap.get(a.id)?.overall_score ?? "",
          sourceLabel(a.source),
          new Date(a.applied_at).toISOString().slice(0, 10),
          stalledDays(a.stage as Stage, a.last_activity_at) ?? "",
        ];
      }),
    ]);
  }

  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title="Hiring reports"
        description="Slice the whole pipeline by department, requisition, location and period: conversion at every stage, ageing against SLA, offer outcomes, skill scarcity, interviewer load and audited drop-off reasons."
        actions={
          <Button variant="outline" onClick={exportPipeline} disabled={applications.length === 0}>
            Export pipeline CSV
          </Button>
        }
      />

      <section className="panel grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">Department</Label>
          <Select value={dept} onValueChange={setDept}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {(depts.data ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">Requisition</Label>
          <Select value={reqId} onValueChange={setReqId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All requisitions</SelectItem>
              {requisitions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.code} — {r.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">Location</Label>
          <Select value={location} onValueChange={setLocation}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations</SelectItem>
              {locations.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">
            Period (applied date)
          </Label>
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">
            Candidate, skill or role
          </Label>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. Kubernetes"
          />
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Applications in scope"
          value={applications.length}
          hint={`${scored.length} AI scored`}
        />
        <StatCard
          label="Active pipeline"
          value={active.length}
          hint={`${stalled.length} breaching stage SLA`}
          tone={stalled.length > 0 ? "destructive" : "default"}
        />
        <StatCard
          label="Offer acceptance"
          value={released.length ? `${pct(accepted.length, released.length)}%` : "—"}
          hint={`${accepted.length} accepted of ${released.length} released`}
        />
        <StatCard
          label="Median time to join"
          value={timeToHire === null ? "—" : `${timeToHire} d`}
          hint={`${joined.length} joined in scope`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="panel p-4">
          <h2 className="font-semibold">Funnel conversion</h2>
          <p className="text-xs text-muted-foreground">
            Candidates who reached each step, with conversion from the step before.
          </p>
          <ul className="mt-4 space-y-3">
            {reached.map((f, i) => {
              const prev = i > 0 ? reached[i - 1]!.count : null;
              return (
                <li key={f.stage}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                    <span>{STAGE_LABEL[f.stage]}</span>
                    <span className="flex items-center gap-3">
                      {prev !== null ? (
                        <span className="text-xs text-muted-foreground">
                          {pct(f.count, prev)}% from previous
                        </span>
                      ) : null}
                      <span className="num font-semibold">{f.count}</span>
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(f.count / top) * 100}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {stageCount(f.stage)} sitting here right now
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <div className="space-y-4">
          <section className="panel p-4">
            <h2 className="font-semibold">Average score by dimension</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ScoreBar label="Skills" score={avg((id) => scoreMap.get(id)!.skills_score)} />
              <ScoreBar
                label="Experience"
                score={avg((id) => scoreMap.get(id)!.experience_score)}
              />
              <ScoreBar
                label="Career history"
                score={avg((id) => scoreMap.get(id)!.career_score ?? 0)}
              />
              <ScoreBar
                label="Impact & innovation"
                score={avg((id) => scoreMap.get(id)!.impact_score ?? 0)}
              />
              <ScoreBar label="Education" score={avg((id) => scoreMap.get(id)!.education_score)} />
              <ScoreBar
                label="Social profile"
                score={avg((id) => scoreMap.get(id)!.social_score)}
              />
            </div>
          </section>

          <section className="panel p-4">
            <h2 className="font-semibold">Scarcest skills (missing must-haves)</h2>
            {skillGaps.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Nothing scored in this scope yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {skillGaps.map(([skill, count]) => (
                  <li key={skill} className="flex items-center justify-between gap-3">
                    <span>{skill}</span>
                    <span className="num text-xs text-muted-foreground">
                      missing in {count} candidates
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel p-4">
            <h2 className="font-semibold">Source effectiveness</h2>
            {sources.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No applications in scope.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {sources.map(([source, count]) => (
                  <li key={source} className="flex items-center justify-between">
                    <span>{sourceLabel(source)}</span>
                    <span className="num font-semibold">{count}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <section className="panel">
        <div className="border-b border-border p-4">
          <h2 className="font-semibold">Department scoreboard</h2>
          <p className="text-xs text-muted-foreground">
            Demand, pipeline and fill rate against budgeted cost.
          </p>
        </div>
        {deptRows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No departments yet"
              hint="Create departments on the Master data page."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="p-3 text-left">Department</th>
                  <th className="p-3 text-right">Reqs</th>
                  <th className="p-3 text-right">Openings</th>
                  <th className="p-3 text-right">Pipeline</th>
                  <th className="p-3 text-right">Interviewing</th>
                  <th className="p-3 text-right">Offers</th>
                  <th className="p-3 text-right">Joined</th>
                  <th className="p-3 text-right">Fill</th>
                  <th className="p-3 text-right">Committed / budget</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {deptRows.map((d) => (
                  <tr key={d.id}>
                    <td className="p-3 font-medium">{d.name}</td>
                    <td className="num p-3 text-right">{d.reqs}</td>
                    <td className="num p-3 text-right">{d.openings}</td>
                    <td className="num p-3 text-right">{d.pipeline}</td>
                    <td className="num p-3 text-right">{d.interviewing}</td>
                    <td className="num p-3 text-right">{d.offers}</td>
                    <td className="num p-3 text-right">{d.joined}</td>
                    <td className="num p-3 text-right">{d.fill}%</td>
                    <td
                      className={`num p-3 text-right ${d.budget && d.committed > d.budget ? "text-destructive" : ""}`}
                    >
                      {inr(d.committed)} / {inr(d.budget)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="border-b border-border p-4">
          <h2 className="font-semibold">Requisitions needing attention</h2>
          <p className="text-xs text-muted-foreground">
            Largest open gap first, then stalled candidates.
          </p>
        </div>
        {reqRows.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No requisitions in scope" hint="Widen the filters above." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="p-3 text-left">Requisition</th>
                  <th className="p-3 text-left">Location</th>
                  <th className="p-3 text-right">Open age</th>
                  <th className="p-3 text-right">Openings</th>
                  <th className="p-3 text-right">Pipeline</th>
                  <th className="p-3 text-right">Interviews</th>
                  <th className="p-3 text-right">Joined</th>
                  <th className="p-3 text-right">Gap</th>
                  <th className="p-3 text-right">Stalled</th>
                  <th className="p-3 text-right">Avg match</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {reqRows.map((r) => (
                  <tr key={r.id}>
                    <td className="p-3">
                      <div className="font-medium">{r.title}</div>
                      <div className="text-xs text-muted-foreground">{r.code}</div>
                    </td>
                    <td className="p-3">{r.location}</td>
                    <td className="num p-3 text-right">{r.ageDays} d</td>
                    <td className="num p-3 text-right">{r.openings}</td>
                    <td className="num p-3 text-right">{r.pipeline}</td>
                    <td className="num p-3 text-right">{r.interviews}</td>
                    <td className="num p-3 text-right">{r.joined}</td>
                    <td
                      className={`num p-3 text-right ${r.gap > 0 ? "font-semibold text-destructive" : ""}`}
                    >
                      {r.gap}
                    </td>
                    <td className="num p-3 text-right">{r.stalled}</td>
                    <td className="num p-3 text-right">{r.avgScore ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="panel p-4">
          <h2 className="font-semibold">Interviewer load</h2>
          <p className="text-xs text-muted-foreground">
            Rounds owned, and how many land in the next seven days.
          </p>
          {panelRows.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No interviews scheduled in this scope.
            </p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {panelRows.map(([name, row]) => (
                <li key={name} className="flex items-center justify-between gap-3">
                  <span className="truncate">{name}</span>
                  <span className="num shrink-0 text-xs text-muted-foreground">
                    {row.upcoming} next 7 d · {row.done} done · {row.total} total
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel p-4">
          <h2 className="font-semibold">Why candidates dropped off</h2>
          <p className="text-xs text-muted-foreground">
            Audited reasons captured on every closing stage change.
          </p>
          {dropOff.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No closures in this scope.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {dropOff.map(([reason, count]) => (
                <li key={reason} className="flex items-center justify-between gap-3">
                  <span className="truncate">{reason}</span>
                  <span className="num shrink-0 font-semibold">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="mt-6">
        <HrPerformance />
      </div>
    </>
  );
}
