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
import { modalityLabel } from "@/lib/agent-modality";
import { AGENT_LABEL } from "@/lib/agents.catalog";
import { windowLabel } from "@/lib/report-window";

type Cell = string | number;
type Section = { title: string; note?: string; head: string[]; rows: Cell[][] };
type Report = {
  title: string;
  /** false when the report is not about agents (no agent filter line). */
  agents?: boolean;
  file: string;
  window: Window;
  /** Plain-language findings, shown before the tables. */
  findings: string[];
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

function agentScope(w: Window): string {
  return w.agent ? nice(w.agent) : (modalityLabel(w.modality) ?? "All agents");
}

function windowRows(w: Window): [string, Cell][] {
  return [
    ["Period", windowLabel(w.from, w.to)],
    ["Agent", agentScope(w)],
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
        : `${windowLabel(r.window.from, r.window.to)} · ${agentScope(r.window)}`,
    ),
    margin,
    58,
  );
  doc.setTextColor(...INK);

  let top = 100;
  if (r.findings.length) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Key findings", margin, top);
    top += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    for (const f of r.findings) {
      const lines = doc.splitTextToSize(pdfText(f), width - margin * 2 - 12) as string[];
      if (top + lines.length * 12 > doc.internal.pageSize.getHeight() - 40) {
        doc.addPage();
        top = 48;
      }
      doc.text("·", margin, top);
      doc.text(lines, margin + 12, top);
      top += lines.length * 12 + 4;
    }
    top += 8;
  }

  autoTable(doc, {
    startY: top,
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
  const summary = XLSX.utils.aoa_to_sheet([
    [r.title],
    [],
    ...(r.findings.length ? [["Key findings"], ...r.findings.map((f) => ["", f]), []] : []),
    ...r.summary.map(([k, v]) => [k, v]),
  ]);
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

/* ------------------------------------------------------------- findings */

const n = (v: number) => v.toLocaleString("en-GB");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "0%");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

function topBy<T>(items: T[], key: (t: T) => string, val: (t: T) => number) {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + val(i));
  return [...m.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
}

/** Plain-language read of the period's runs, shared by both agent reports. */
function activityFindings(a: ActivityReport): string[] {
  const runs = a.runs;
  if (!runs.length) return ["No agent runs started in this period."];
  const out: string[] = [];
  const agents = new Set(runs.map((r) => r.agent)).size;
  const failed = runs.filter((r) => r.status === "failed").length;
  const cancelled = runs.filter((r) => r.status === "cancelled").length;
  const done = runs.filter((r) => r.status === "done").length;
  out.push(
    `${plural(runs.length, "run")} by ${plural(agents, "agent")}: ${n(done)} completed, ${n(failed)} failed (${pct(failed, runs.length)})${cancelled ? `, ${n(cancelled)} cancelled` : ""}, ${n(runs.length - done - failed - cancelled)} still open or waiting.`,
  );
  const tokens = runs.reduce((s, r) => s + r.tokens, 0);
  const byTokens = topBy(
    runs,
    (r) => r.agent,
    (r) => r.tokens,
  );
  if (tokens)
    out.push(
      `${n(tokens)} AI tokens used, ${n(Math.round(tokens / runs.length))} per run on average. Largest users: ${byTokens
        .slice(0, 3)
        .map(([k, v]) => `${nice(k)} ${n(v)} (${pct(v, tokens)})`)
        .join(", ")}.`,
    );
  else out.push("No AI token usage was recorded for these runs.");
  const busiest = topBy(
    runs,
    (r) => r.agent,
    () => 1,
  )[0];
  if (busiest) out.push(`Busiest agent: ${nice(busiest[0])} with ${plural(busiest[1], "run")}.`);
  const peak = topBy(
    a.days,
    (d) => d.day,
    (d) => d.runs,
  )[0];
  if (peak) out.push(`Busiest day: ${peak[0]} with ${plural(peak[1], "run")}.`);
  const timed = runs.filter((r) => r.durationMin !== null);
  if (timed.length) {
    const avg = timed.reduce((s, r) => s + (r.durationMin ?? 0), 0) / timed.length;
    const longest = timed.reduce((m, r) => ((r.durationMin ?? 0) > (m.durationMin ?? 0) ? r : m));
    out.push(
      `Finished runs took ${avg.toFixed(1)} minutes on average; the longest was ${nice(longest.agent)} at ${longest.durationMin} minutes.`,
    );
  }
  const failedCalls = runs.reduce((s, r) => s + r.failedCalls, 0);
  if (failedCalls) {
    const worst = topBy(
      runs,
      (r) => r.agent,
      (r) => r.failedCalls,
    )[0] ?? ["", 0];
    out.push(
      `${plural(failedCalls, "tool call")} failed, most in ${nice(worst[0])} (${n(worst[1])}).`,
    );
  }
  const asks = runs.reduce((s, r) => s + r.approvals, 0);
  const declined = runs.reduce((s, r) => s + r.declined, 0);
  if (asks)
    out.push(
      `Agents asked a person to decide ${plural(asks, "time")}; ${n(declined)} ${declined === 1 ? "was" : "were"} declined (${pct(declined, asks)}).`,
    );
  const byFail = topBy(
    runs,
    (r) => r.agent,
    (r) => (r.status === "failed" ? 1 : 0),
  );
  if (byFail.length)
    out.push(
      `Failures concentrate in ${byFail
        .slice(0, 3)
        .map(([k, v]) => `${nice(k)} (${n(v)})`)
        .join(", ")}.`,
    );
  return out;
}

function fixFindings(fixes: FixRow[]): string[] {
  const act = fixes.filter((f) => f.severity === "act");
  const watch = fixes.filter((f) => f.severity === "watch");
  if (!fixes.length) return ["Nothing needs action right now."];
  return [
    `${plural(act.length, "item")} need${act.length === 1 ? "s" : ""} action and ${n(watch.length)} to watch.`,
    ...[...act, ...watch]
      .slice(0, 5)
      .map((f) => `${f.severity === "act" ? "Act" : "Watch"}: ${f.what} — ${f.why}`),
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
    findings: [
      ...activityFindings(activity),
      ...b.rejects
        .slice(0, 1)
        .map(
          (r) =>
            `Most declined proposal: "${r.title}" from ${nice(r.agentType)} (${plural(r.count, "time")}).`,
        ),
      ...fixFindings(fixes),
    ],
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
    findings: [
      ...h.questions.map((q) => `${q.question} ${TONE_WORD[q.tone]} — ${q.title}. ${q.detail}`),
      ...activityFindings(activity),
      ...(ho.loops.length
        ? [`${plural(ho.loops.length, "hand-off loop")} found between agents.`]
        : []),
      ...h.budget
        .filter((b) => b.budget !== null && b.tokensMonth > b.budget)
        .map(
          (b) =>
            `${nice(b.agent)} is over its monthly token budget: ${n(b.tokensMonth)} of ${n(b.budget ?? 0)}.`,
        ),
      ...fixFindings(h.fixes),
    ],
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
    findings: fixFindings(fixes),
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

/* ------------------------------------------------------------- workflow run report */

/** One agent workflow run as a PDF or Excel report: the need, every step, agents and decisions. */
export function downloadWorkflowRunReport(
  kind: ReportKind,
  r: import("../server/agents/workflows.server").WorkflowRunReport,
) {
  const label = (t: string) => AGENT_LABEL[t] ?? nice(t);
  const findings: string[] = [
    `${r.workflow} (v${r.version}) in ${r.organisation} is ${r.status}${r.finished ? ` (finished ${dt(r.finished)})` : ""}.`,
    ...(r.need ? [`Hiring need: ${r.need}`] : []),
    `${plural(r.totals.agentRuns, "agent run")}, ${plural(r.totals.decisions, "decision")} by people, ${n(r.totals.tokens)} AI tokens${r.totals.minutes != null ? `, ${plural(r.totals.minutes, "minute")} end to end` : ""}.`,
    ...(r.error ? [`Stopped: ${r.error}`] : []),
  ];
  render(kind, {
    title: r.title,
    file: `workflow-${
      r.workflow
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "run"
    }`,
    agents: false,
    window: { from: r.started, to: r.finished ?? new Date().toISOString(), agent: null },
    findings,
    summary: [
      ["Workflow", `${r.workflow} · v${r.version}`],
      ["Organisation", r.organisation],
      ["Status", r.status],
      ["Started", dt(r.started)],
      ["Finished", r.finished ? dt(r.finished) : "—"],
      ["Started by", r.startedBy ?? (r.trigger === "manual" ? "—" : `event ${nice(r.trigger)}`)],
      ["Trigger", r.trigger === "manual" ? "Hiring need (manual)" : nice(r.trigger)],
      ["Agent runs", r.totals.agentRuns],
      ["Decisions by people", r.totals.decisions],
      ["AI tokens", r.totals.tokens],
    ],
    sections: [
      {
        title: "Steps",
        head: ["When", "Step", "What happened"],
        rows: r.steps.map((s) => [dt(s.at), s.step, s.note]),
      },
      {
        title: "Agents",
        head: ["Agent", "Status", "Started", "Finished", "Steps", "Tokens", "Result"],
        rows: r.agents.map((a) => [
          label(a.agent),
          a.status,
          dt(a.started),
          dt(a.finished),
          a.steps,
          a.tokens,
          a.result,
        ]),
      },
      {
        title: "Decisions",
        head: ["When", "Agent", "Request", "Kind", "Outcome", "By"],
        rows: r.decisions.map((d) => [
          dt(d.at),
          label(d.agent),
          d.request,
          d.kind,
          d.outcome,
          d.by ?? "—",
        ]),
      },
    ],
  });
}
