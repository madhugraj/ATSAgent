/**
 * Downloadable reports for Agent intelligence (behaviour), Agent governance and
 * Skill ontology, built in the browser from the same read models the pages
 * show, for the chosen period and agent. One section list renders as a PDF
 * (landscape, a summary then one table per section) and as an Excel workbook
 * (one sheet per section, full row-level detail). Vendor- and model-neutral.
 */
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";

import type { FixRow } from "@/components/ops-layout";
import type { ReportKind, Window } from "@/components/report-bar";
import type { AgentIntelligence } from "@/lib/agent-intelligence.functions";
import type { ActivityReport, Harness } from "@/lib/agent-governance.functions";
import type { TalentBrain } from "@/lib/ontology.functions";
import type { OrgOntology } from "@/lib/org-ontology.functions";
import { windowLabel } from "@/lib/report-window";

type Cell = string | number;
type Section = { title: string; note?: string; head: string[]; rows: Cell[][] };
type Report = {
  title: string;
  /** false when the report is not about agents (no agent filter line). */
  agents?: boolean;
  file: string;
  window: Window;
  summary: [string, Cell][];
  sections: Section[];
};

const INK: [number, number, number] = [17, 17, 20];
const VIOLET: [number, number, number] = [88, 77, 255];

/** jsPDF's built-in fonts cover WinAnsi only — swap the glyphs they cannot draw. */
function pdfText(v: Cell): string {
  return String(v)
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/↔/g, "<->")
    .replace(/[✓✔]/g, "ok")
    .replace(/[✗✘]/g, "x")
    .replace(/[⚠◈]/g, "!")
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/•/g, "·")
    .replace(/[^ -\u00FF]/g, "?");
}
const nice = (s: string) => s.replace(/_/g, " ");
const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");
const dt = (iso: string | null) =>
  iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") : "";
const stamp = () => new Date().toISOString().slice(0, 10);

function fixSection(fixes: FixRow[]): Section {
  return {
    title: "Fix list",
    note: "Only what needs action, most severe first.",
    head: ["Severity", "What", "Why", "Agent / skill", "Next step"],
    rows: fixes.map((f) => [
      f.severity === "act" ? "Act" : "Watch",
      f.what,
      f.why,
      f.agents.map(nice).join(", "),
      f.next.label,
    ]),
  };
}

function windowRows(w: Window): [string, Cell][] {
  return [
    ["Period", windowLabel(w.from, w.to)],
    ["Agent", w.agent ? nice(w.agent) : "All agents"],
    ["Generated", new Date().toUTCString()],
  ];
}

/* ------------------------------------------------------------- renderers */

function toPdf(r: Report) {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const width = doc.internal.pageSize.getWidth();
  const margin = 36;
  doc.setFillColor(...INK);
  doc.rect(0, 0, width, 78, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(pdfText(r.title), margin, 38);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(
    pdfText(
      r.agents === false
        ? windowLabel(r.window.from, r.window.to)
        : `${windowLabel(r.window.from, r.window.to)} · ${r.window.agent ? nice(r.window.agent) : "All agents"}`,
    ),
    margin,
    58,
  );
  doc.setTextColor(...INK);

  autoTable(doc, {
    startY: 96,
    head: [["Summary", ""]],
    body: r.summary.map(([k, v]) => [pdfText(k), pdfText(v)]),
    theme: "grid",
    styles: { font: "helvetica", fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: VIOLET, textColor: 255 },
    columnStyles: { 0: { cellWidth: 180, fontStyle: "bold" } },
    margin: { left: margin, right: margin },
  });
  for (const s of r.sections) {
    const last =
      (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 96;
    let y = last + 26;
    if (y > doc.internal.pageSize.getHeight() - 80) {
      doc.addPage();
      y = 48;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(pdfText(s.title), margin, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    if (s.note) doc.text(pdfText(s.note), margin, y + 12);
    autoTable(doc, {
      startY: y + (s.note ? 18 : 8),
      head: [s.head.map(pdfText)],
      body: s.rows.length
        ? s.rows.map((row) => row.map(pdfText))
        : [[pdfText("None in this period."), ...s.head.slice(1).map(() => "")]],
      theme: "striped",
      styles: { font: "helvetica", fontSize: 7.5, cellPadding: 3, overflow: "linebreak" },
      headStyles: { fillColor: INK, textColor: 255, fontSize: 7.5 },
      margin: { left: margin, right: margin },
    });
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(
      `${pdfText(r.title)} · page ${i} of ${pages}`,
      margin,
      doc.internal.pageSize.getHeight() - 16,
    );
  }
  doc.save(`${r.file}-${stamp()}.pdf`);
}

function toXlsx(r: Report) {
  const wb = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([[r.title], [], ...r.summary.map(([k, v]) => [k, v])]);
  summary["!cols"] = [{ wch: 32 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, summary, "Summary");
  const used = new Set(["Summary"]);
  for (const s of r.sections) {
    let name = s.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
    for (let i = 2; used.has(name); i++) name = `${s.title.slice(0, 28)} ${i}`;
    used.add(name);
    const ws = XLSX.utils.aoa_to_sheet([s.head, ...s.rows]);
    ws["!cols"] = s.head.map((h, i) => ({
      wch: Math.min(
        60,
        Math.max(h.length, ...s.rows.slice(0, 200).map((row) => String(row[i] ?? "").length)) + 2,
      ),
    }));
    if (s.rows.length)
      ws["!autofilter"] = {
        ref: XLSX.utils.encode_range({
          s: { r: 0, c: 0 },
          e: { r: s.rows.length, c: s.head.length - 1 },
        }),
      };
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, `${r.file}-${stamp()}.xlsx`);
}

function render(kind: ReportKind, r: Report) {
  if (kind === "pdf") toPdf(r);
  else toXlsx(r);
}

/* ------------------------------------------------------------- shared activity sections */

function activitySections(a: ActivityReport): Section[] {
  return [
    {
      title: "Daily activity",
      note: "Runs started per day and agent.",
      head: ["Day", "Agent", "Runs", "Failed", "Steps", "Tokens"],
      rows: a.days.map((d) => [d.day, nice(d.agent), d.runs, d.failed, d.steps, d.tokens]),
    },
    {
      title: "Runs",
      note: "Every run started in the period.",
      head: [
        "Run",
        "Agent",
        "Status",
        "Started by",
        "Started",
        "Finished",
        "Minutes",
        "Steps",
        "Tokens",
        "Failed calls",
        "Approvals",
        "Declined",
        "Definition",
        "Error",
      ],
      rows: a.runs.map((r) => [
        r.id,
        nice(r.agent),
        r.status,
        r.startedBy,
        dt(r.createdAt),
        dt(r.finishedAt),
        r.durationMin ?? "",
        r.steps,
        r.tokens,
        r.failedCalls,
        r.approvals,
        r.declined,
        r.definitionVersion,
        r.error,
      ]),
    },
  ];
}

/* ------------------------------------------------------------- behaviour */

export function downloadBehaviourReport(
  kind: ReportKind,
  d: AgentIntelligence,
  activity: ActivityReport,
  window: Window,
  fixes: FixRow[],
) {
  const b = d.views.behavior;
  const plan = b.plan;
  const checks = plan.reduce((s, p) => s + p.stops, 0);
  const declined = plan.reduce((s, p) => s + p.overturned, 0);
  render(kind, {
    title: "Agent behaviour report",
    file: "agent-behaviour",
    window,
    summary: [
      ...windowRows(window),
      ["Runs", b.fleet.runs],
      ["Failed runs", b.fleet.failed],
      ["Cancelled runs", b.fleet.cancelled],
      ["Agents active", plan.filter((p) => p.runs > 0).length],
      ["Agents never run", plan.filter((p) => p.state === "idle").length],
      ["Person checks", checks],
      [
        "Declined by a person",
        `${declined}${checks ? ` (${Math.round((declined / checks) * 100)}%)` : ""}`,
      ],
      ["Needs action", fixes.filter((f) => f.severity === "act").length],
      ["To watch", fixes.filter((f) => f.severity === "watch").length],
    ],
    sections: [
      fixSection(fixes),
      {
        title: "Agents",
        head: [
          "Agent",
          "Version",
          "State",
          "Priority",
          "Runs",
          "Person checks",
          "Declined",
          "Failed calls",
          "Waiting",
          "Next action",
        ],
        rows: plan.map((p) => [
          nice(p.name),
          p.ver,
          p.state,
          p.pri,
          p.runs,
          p.stops,
          p.overturned,
          p.errors,
          p.awaiting,
          p.action,
        ]),
      },
      {
        title: "Declined proposals",
        head: ["Agent", "Kind", "Proposal", "Tool", "Times"],
        rows: b.rejects.map((r) => [nice(r.agentType), r.kind, r.title, r.tool ?? "", r.count]),
      },
      ...activitySections(activity),
    ],
  });
}

/* ------------------------------------------------------------- governance */

const TONE_WORD = { bad: "Act", warn: "Watch", good: "OK", none: "—" } as const;

export function downloadGovernanceReport(
  kind: ReportKind,
  h: Harness,
  activity: ActivityReport,
  window: Window,
) {
  const ho = h.handoffs;
  render(kind, {
    title: "Agent governance report",
    file: "agent-governance",
    window,
    summary: [
      ...windowRows(window),
      ...h.questions.map((q): [string, Cell] => [
        q.question,
        `${TONE_WORD[q.tone]} — ${q.title}. ${q.detail}`,
      ]),
      ["Checks passing", h.passing.count],
      [
        "Events",
        `${ho.events.total} (${ho.events.done} routed, ${ho.events.pending} waiting, ${ho.events.failed} failed, ${ho.events.dead} gave up)`,
      ],
      ["Runs started by another agent", ho.chainedRuns],
      [
        "Longest chain",
        ho.longest && ho.longest.depth > 1 ? ho.longest.path.map(nice).join(" → ") : "—",
      ],
      ["Loops", ho.loops.length],
    ],
    sections: [
      fixSection(h.fixes),
      {
        title: "Agent checks",
        head: [
          "Agent",
          "On",
          "Autonomy",
          "Risk",
          "Owner",
          "Runs",
          "Limits",
          "Autonomy check",
          "Definition",
          "Hand-offs",
          "Budget",
        ],
        rows: h.agents.map((a) => [
          nice(a.agent),
          a.enabled ? "yes" : "no",
          nice(a.autonomy),
          a.risk,
          nice(a.owner),
          a.runs,
          `${TONE_WORD[a.checks.limits]}: ${a.detail.limits}`,
          `${TONE_WORD[a.checks.autonomy]}: ${a.detail.autonomy}`,
          `${TONE_WORD[a.checks.definition]}: ${a.detail.definition}`,
          `${TONE_WORD[a.checks.handoffs]}: ${a.detail.handoffs}`,
          `${TONE_WORD[a.checks.budget]}: ${a.detail.budget}`,
        ]),
      },
      {
        title: "Limits",
        head: ["Agent", "Refused calls", "Tools refused", "Injection flags"],
        rows: h.limits.map((l) => [
          nice(l.agent),
          l.refused,
          l.refusedTools.join(", "),
          l.injection,
        ]),
      },
      {
        title: "Autonomy vs risk",
        head: [
          "Agent",
          "Switched on",
          "Autonomy",
          "Risk tier",
          "Changes made",
          "Asked first",
          "No approval card",
          "Flag",
        ],
        rows: h.autonomy.map((a) => [
          nice(a.agent),
          a.enabled ? "yes" : "no",
          nice(a.autonomy),
          a.risk,
          a.writesRun,
          a.askedFirst,
          a.withoutApproval,
          a.flag ?? "",
        ]),
      },
      {
        title: "Definitions",
        head: [
          "Agent",
          "Approved version",
          "Owner",
          "Evals",
          "Runs",
          "Ran on other versions",
          "Flag",
        ],
        rows: h.definitions.map((d) => [
          nice(d.agent),
          d.current,
          nice(d.owner),
          d.evals,
          d.runs,
          d.offVersion.map((o) => `${o.version} ×${o.runs}`).join(", "),
          d.flag ?? "",
        ]),
      },
      {
        title: "Hand-offs",
        note: "Publisher → event (publish), event → agent (start), agent → agent (delegate).",
        head: ["From", "To", "Kind", "Count", "Failed"],
        rows: ho.edges.map((e) => {
          const name = (id: string) => ho.nodes.find((n) => n.id === id)?.name ?? id;
          return [nice(name(e.s)), nice(name(e.t)), e.k, e.runs, e.failed];
        }),
      },
      {
        title: "Delegations",
        head: ["When", "From", "To", "Status", "After injection flag", "Goal"],
        rows: ho.delegations.map((d) => [
          dt(d.at),
          nice(d.from),
          nice(d.to),
          d.status,
          d.afterInjectionFlag ? "yes" : "no",
          d.goal,
        ]),
      },
      {
        title: "Loops and overlaps",
        head: ["Kind", "Agents", "On"],
        rows: [
          ...ho.loops.map((l): Cell[] => ["loop", l.path.map(nice).join(" → "), l.subject ?? ""]),
          ...ho.overlaps.map((o): Cell[] => [
            "overlapping runs",
            `${nice(o.agent)} ×${o.runs}`,
            o.subject,
          ]),
        ],
      },
      {
        title: "Budget",
        head: ["Agent", "Tokens this month", "Monthly budget", "Runs stopped at a limit"],
        rows: h.budget.map((b) => [
          nice(b.agent),
          b.tokensMonth,
          b.budget ?? "not set",
          b.limitStops,
        ]),
      },
      {
        title: "Events",
        note: "Every event published in the period, who published it and what it started.",
        head: ["When", "Event", "Status", "Attempts", "Published by", "Started"],
        rows: activity.events.map((e) => [
          dt(e.createdAt),
          e.type,
          e.status,
          e.attempts,
          e.publishedBy,
          e.startedAgents,
        ]),
      },
      ...activitySections(activity),
    ],
  });
}

/* ------------------------------------------------------------- ontology */

function orgSections(org: OrgOntology, window: Window): Section[] {
  const name = (id: string) => [...org.roles, ...org.emerging].find((r) => r.id === id)?.name ?? id;
  const month = (i: number | null) => (i === null ? "" : (org.months[i] ?? ""));
  const from = window.from.slice(0, 7),
    to = window.to.slice(0, 7);
  return [
    {
      title: "Emerging roles",
      note: `Roles forming from combinations of established ones (${org.domain.name}). Status as of today; "In period" marks a first signal inside the report period.`,
      head: [
        "Role",
        "Born from",
        "Status",
        "Confirmed",
        "Requisitions",
        "In pool",
        "First signal",
        "Emerging",
        "Established",
        "In period",
        "Skill bundle",
        "Titles seen",
      ],
      rows: org.emerging.map((e) => {
        const first = month(e.signal);
        return [
          e.name,
          e.parents.map(name).join(" + "),
          e.status,
          e.confirmed ? "yes" : "no",
          e.requisitions,
          e.supply,
          first,
          month(e.emerging),
          month(e.established),
          first >= from && first <= to ? "yes" : "",
          e.skills.join(", "),
          e.titles.join(" · "),
        ];
      }),
    },
    {
      title: "Role demand by month",
      note: "Cumulative requisitions asking for each emerging role's skill bundle.",
      head: ["Role", ...org.months],
      rows: org.emerging.map((e) => [e.name, ...e.demand]),
    },
    {
      title: "Established roles",
      head: ["Role", "Source", "Requisitions", "In pool", "Typical skills"],
      rows: org.roles.map((r) => [
        r.name,
        r.source === "seed" ? `${org.domain.name} starter role` : "learned",
        r.demand,
        r.supply,
        r.skills.join(", "),
      ]),
    },
  ];
}

export function downloadOntologyReport(
  kind: ReportKind,
  d: TalentBrain,
  window: Window,
  fixes: FixRow[],
  org?: OrgOntology,
) {
  const from = new Date(window.from),
    to = new Date(window.to);
  const inPeriod = (iso: string) => new Date(iso) >= from && new Date(iso) <= to;
  const active = d.nodes.filter((n) => n.status !== "retired");
  const name = (slug: string) => d.nodes.find((n) => n.slug === slug)?.name ?? slug;
  const families = new Map<
    string,
    { skills: number; supply: number; demand: number; scarce: number }
  >();
  for (const n of active) {
    const f = families.get(n.category) ?? { skills: 0, supply: 0, demand: 0, scarce: 0 };
    f.skills += 1;
    f.supply += n.supply;
    f.demand += n.demand;
    if (n.scarcity >= 70) f.scarce += 1;
    families.set(n.category, f);
  }
  const snapshots = d.history.filter((h) => inPeriod(h.at));
  render(kind, {
    title: "Skill ontology report",
    file: "skill-ontology",
    agents: false,
    window: { ...window, agent: null },
    summary: [
      ["Period", windowLabel(window.from, window.to)],
      ["Generated", new Date().toUTCString()],
      ["Skills", d.stats.nodeCount],
      ["Co-occurrence links", d.stats.edgeCount],
      ["Capability families", families.size],
      ["Candidates", d.stats.candidates],
      ["Requisitions", d.stats.requisitions],
      ["Scarce skills", d.stats.scarce],
      ["Dormant skills", d.stats.dormant],
      [
        "Demand covered by the pool",
        d.stats.requisitions ? `${d.stats.coverage}%` : "no requisitions yet",
      ],
      ["New skills in the period", d.nodes.filter((n) => inPeriod(n.firstSeenAt)).length],
      ["Ontology rebuilds in the period", snapshots.length],
      ["Last rebuilt", d.builtAt ? dt(d.builtAt) : "not yet (live build)"],
    ],
    sections: [
      fixSection(fixes),
      ...(org ? orgSections(org, window) : []),
      {
        title: "Skills",
        head: [
          "Skill",
          "Family",
          "Also written as",
          "In pool",
          "Asked for",
          "Validated",
          "Evidence",
          "Scarcity",
          "Status",
          "First seen",
          "Last seen",
          "New in period",
        ],
        rows: [...active]
          .sort((a, b) => b.scarcity - a.scarcity || b.demand - a.demand)
          .map((n) => [
            n.name,
            n.category,
            n.aliases.join(", "),
            n.supply,
            n.demand,
            n.validated,
            n.evidence,
            n.scarcity,
            n.status,
            day(n.firstSeenAt),
            day(n.lastSeenAt),
            inPeriod(n.firstSeenAt) ? "yes" : "",
          ]),
      },
      {
        title: "Capability families",
        head: ["Family", "Skills", "In pool (sum)", "Asked for (sum)", "Scarce skills"],
        rows: [...families.entries()]
          .sort((a, b) => b[1].skills - a[1].skills)
          .map(([f, v]) => [f, v.skills, v.supply, v.demand, v.scarce]),
      },
      {
        title: "Co-occurrence",
        note: "Skills that appear together on CVs, strongest first.",
        head: ["Skill", "Appears with", "Times together", "Weight"],
        rows: [...d.edges]
          .sort((a, b) => b.count - a.count)
          .slice(0, 1000)
          .map((e) => [name(e.from), name(e.to), e.count, Math.round(e.weight * 100) / 100]),
      },
      {
        title: "Insights",
        head: ["Kind", "Severity", "Title", "Detail", "Skills"],
        rows: d.insights.map((i) => [i.kind, i.severity, i.title, i.detail, i.skills.join(", ")]),
      },
      {
        title: "Changes over time",
        note: "Ontology rebuilds in the period.",
        head: ["When", "Skills", "Links", "Added", "Grown", "Dormant", "Retired"],
        rows: snapshots.map((h) => [
          dt(h.at),
          h.nodes,
          h.edges,
          h.added,
          h.grown,
          h.dormant,
          h.retired,
        ]),
      },
    ],
  });
}
