import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Copy,
  Download,
  Github,
  Linkedin,
  Merge,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Sparkles,
  Upload,
  Filter,
} from "lucide-react";

import {
  applicationsQuery,
  candidatesQuery,
  latestScores,
  latestVerifications,
  matchScoresQuery,
  requisitionsQuery,
  verificationsQuery,
  type Application,
  type Candidate,
} from "@/lib/data";
import { parseResume } from "@/lib/matching.functions";
import { verifyCandidates } from "@/lib/verification.functions";
import { getResumeDownloadUrl } from "@/lib/resume.functions";
import { downloadResume } from "@/lib/resume-download";
import { createCandidate, deleteCandidates } from "@/lib/candidates.functions";
import { sourceLabel as channelSourceLabel, UPLOAD_SOURCES } from "@/lib/job-channels";
import { intakeCvs, type IntakeStatus } from "@/lib/cv-intake";
import { normalizeExternalUrl } from "@/lib/external-links";
import { canonical, nextAction, stalledDays, STAGE_LABEL, type Stage } from "@/lib/lifecycle";
import { computeCareerMetrics, type EmploymentRow } from "@/lib/career";
import { duplicateIndex, findDuplicateGroups, freshness, mergeCandidates } from "@/lib/dedupe";

import { EmptyState, PageHeader, ScoreChip, StageBadge } from "@/components/ats";
import { StageMover } from "@/components/StageMover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useMe } from "@/hooks/useMe";
import { poolTeam, setCandidateOwner } from "@/lib/collaboration.functions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export const Route = createFileRoute("/candidates/")({
  head: () => ({
    meta: [
      { title: "Talent Pool — pipeline states, match scores & authenticity" },
      {
        name: "description",
        content:
          "Searchable candidate database in a dense table: current pipeline stage, next action, match score, authenticity verdict and stalled-candidate flags.",
      },
      {
        property: "og:title",
        content: "Talent Pool — pipeline states, match scores & authenticity",
      },
      {
        property: "og:description",
        content:
          "Filter thousands of candidates by stage, source, experience and score; move stages with an audited reason and re-verify claims in bulk.",
      },
    ],
  }),
  component: Candidates,
});

const SAVED_VIEWS = [
  { id: "all", label: "All" },
  { id: "new", label: "New this week" },
  { id: "screening", label: "In screening" },
  { id: "interview", label: "In interview" },
  { id: "offer", label: "Offer stage" },
  { id: "joined", label: "Joined" },
  { id: "closed", label: "Closed / rejected" },
  { id: "reserve", label: "Reserve & on hold" },
  { id: "unpooled", label: "Not in any pipeline" },
  { id: "stalled", label: "Stalled" },
  { id: "flagged", label: "Authenticity flags" },
  { id: "incomplete", label: "Incomplete parsing" },
  { id: "duplicates", label: "Possible duplicates" },
  { id: "stale", label: "Stale CVs (1yr+)" },
] as const;

type ViewId = (typeof SAVED_VIEWS)[number]["id"];

const VIEW_STAGES: Partial<Record<ViewId, Stage[]>> = {
  screening: ["sourced", "applied", "ai_screened", "shortlisted"],
  interview: ["l1", "l2", "l3"],
  offer: ["offer_pending", "offer_released", "offer_accepted", "joining_deferred"],
  joined: ["joined"],
  closed: ["rejected", "withdrawn", "offer_declined", "no_show"],
  reserve: ["reserve", "on_hold"],
};

const EXP_BANDS = [
  { id: "all", label: "Any experience" },
  { id: "0-2", label: "0–2 yrs" },
  { id: "3-5", label: "3–5 yrs" },
  { id: "6-9", label: "6–9 yrs" },
  { id: "10-14", label: "10–14 yrs" },
  { id: "15-60", label: "15+ yrs" },
];

/** What the CV parser could not fill in — surfaced so nobody schedules blind. */
function gaps(c: Candidate) {
  const out: string[] = [];
  if (!c.email?.trim()) out.push("email");
  if (!c.phone?.trim()) out.push("phone");
  if (!c.location?.trim()) out.push("location");
  if (!c.skills?.length) out.push("skills");
  if (!Number(c.experience_years)) out.push("experience");
  if (!c.education?.trim()) out.push("education");
  if (!c.current_employer?.trim()) out.push("employer");
  if (!c.resume_text?.trim()) out.push("resume text");
  if (!(Array.isArray(c.employment_history) ? c.employment_history.length : 0))
    out.push("work history");
  return out;
}

function money(v: number | null) {
  if (v === null || v === undefined) return "—";
  return v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v.toLocaleString();
}

/** Human-friendly label for how the candidate entered the talent pool. */
const sourceLabel = channelSourceLabel;

/** Experience bucket used for the Excel-style column filter. */
function expBucket(years: number) {
  if (years <= 2) return "0–2 yrs";
  if (years <= 5) return "3–5 yrs";
  if (years <= 10) return "6–10 yrs";
  return "10+ yrs";
}

/**
 * Excel-style column filter: a funnel icon on the header opens a checklist of
 * every distinct value in that column. Ticking values narrows the table;
 * an active filter tints the icon so it is visible at a glance.
 */
function ColumnFilter({
  title,
  options,
  selected,
  onChange,
}: {
  title: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [search, setSearch] = useState("");
  const active = selected.size > 0;
  const shown = options.filter((o) => o.toLowerCase().includes(search.toLowerCase().trim()));

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={active ? `Filtered by ${title} — click to change` : `Filter by ${title}`}
          className={`inline-flex size-5 items-center justify-center rounded transition-colors ${
            active
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <Filter className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-2">
        <div className="mb-1 flex items-center justify-between px-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Filter: {title}
          </p>
          {active && (
            <button
              type="button"
              className="text-[11px] font-medium text-primary hover:underline"
              onClick={() => onChange(new Set())}
            >
              Clear
            </button>
          )}
        </div>
        {options.length > 8 && (
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search values…"
            className="mb-1 h-7 text-xs"
          />
        )}
        <div className="max-h-56 overflow-y-auto">
          {shown.length === 0 && (
            <p className="px-1 py-2 text-xs text-muted-foreground">No values match.</p>
          )}
          {shown.map((value) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted"
            >
              <Checkbox
                checked={selected.has(value)}
                onCheckedChange={() => toggle(value)}
                className="size-3.5"
              />
              <span className="truncate">{value}</span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Education arrives either as prose or as raw parsed JSON — always show readable text. */
function educationLabel(raw: string | null | undefined) {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (!(value.startsWith("[") || value.startsWith("{"))) return value;
  try {
    const parsed = JSON.parse(value);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const parts = rows
      .map((r: Record<string, unknown>) =>
        [r?.["degree"], r?.["institution"], r?.["end_date"] ?? r?.["year"]]
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .join(", "),
      )
      .filter((s) => s.length > 0);
    return parts.join(" · ");
  } catch {
    return value;
  }
}

function Candidates() {
  const qc = useQueryClient();
  const cands = useQuery(candidatesQuery);
  const apps = useQuery(applicationsQuery);
  const reqs = useQuery(requisitionsQuery);
  const scores = useQuery(matchScoresQuery);
  const verifs = useQuery(verificationsQuery);
  const parse = useServerFn(parseResume);
  const reverify = useServerFn(verifyCandidates);
  const getResumeUrl = useServerFn(getResumeDownloadUrl);
  const removeCandidates = useServerFn(deleteCandidates);
  const assignOwner = useServerFn(setCandidateOwner);
  const fetchTeam = useServerFn(poolTeam);
  const me = useMe();
  const team = useQuery({
    queryKey: ["pool_team"],
    queryFn: () => fetchTeam({}),
    staleTime: 300_000,
  });

  const [q, setQ] = useState("");
  const [view, setView] = useState<ViewId>("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [reqFilter, setReqFilter] = useState("all");
  const [minScore, setMinScore] = useState("0");
  const [expBand, setExpBand] = useState("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<"all" | "mine" | "unassigned">("all");
  // Excel-style column filters — empty set means "no filter".
  const [fSource, setFSource] = useState<Set<string>>(new Set());
  const [fEmployer, setFEmployer] = useState<Set<string>>(new Set());
  const [fExp, setFExp] = useState<Set<string>>(new Set());
  const [fStage, setFStage] = useState<Set<string>>(new Set());

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moverIds, setMoverIds] = useState<string[] | null>(null);
  const [moverStage, setMoverStage] = useState<Stage | undefined>(undefined);
  const [syncing, setSyncing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resume, setResume] = useState("");
  const [reqId, setReqId] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkReqId, setBulkReqId] = useState("");
  const [bulkSource, setBulkSource] = useState("direct");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkLog, setBulkLog] = useState<IntakeStatus[]>([]);
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    location: "",
    experience_years: "0",
    education: "",
    skills: "",
    linkedin_url: "",
    github_url: "",
    website_url: "",
    x_url: "",
    current_employer: "",
    notice_period_days: "",
    current_ctc: "",
    expected_ctc: "",
    work_authorization: "",
    source: "direct",
  });
  const [willingToRelocate, setWillingToRelocate] = useState<"yes" | "no" | "unknown">("unknown");

  /** Bulk CV intake: read each file locally, AI-parse it, then upsert the candidate. */
  async function bulkUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setBulkBusy(true);
    setBulkLog(list.map((f) => ({ file: f.name, state: "pending" as const, message: "Queued" })));
    try {
      const summary = await intakeCvs({
        files: list,
        parse,
        source: bulkSource,
        requisitionId: bulkReqId || null,
        onUpdate: (i, patch) =>
          setBulkLog((l) => l.map((row, idx) => (idx === i ? { ...row, ...patch } : row))),
      });
      await qc.invalidateQueries({ queryKey: ["candidates"] });
      await qc.invalidateQueries({ queryKey: ["applications"] });
      if (summary.failed === 0)
        toast.success(`${summary.ok} CV${summary.ok === 1 ? "" : "s"} added to the talent pool`);
      else toast.warning(`${summary.ok} parsed · ${summary.failed} failed — see the list`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk upload failed");
    } finally {
      setBulkBusy(false);
    }
  }

  // Pool hygiene is computed client-side and is fully explainable: which two rows
  // look like the same person, and why.
  const dupGroups = useMemo(() => findDuplicateGroups(cands.data ?? []), [cands.data]);
  const dupMap = useMemo(() => duplicateIndex(dupGroups), [dupGroups]);

  const scoreMap = latestScores(scores.data ?? []);
  const verifMap = latestVerifications(verifs.data ?? []);

  /**
   * One row per candidate. The "primary" application is the most advanced /
   * best-scoring pipeline the candidate sits in, so the table shows real state
   * rather than a card with no lifecycle at all.
   */
  type Row = {
    candidate: Candidate;
    apps: Application[];
    primary: Application | null;
    stage: Stage | null;
    score: number | null;
    stalled: number | null;
  };

  const rows = useMemo<Row[]>(() => {
    const byCandidate = new Map<string, Application[]>();
    for (const a of apps.data ?? []) {
      const list = byCandidate.get(a.candidate_id) ?? [];
      list.push(a);
      byCandidate.set(a.candidate_id, list);
    }
    const order = [
      "joined",
      "offer_accepted",
      "offer_released",
      "offer_pending",
      "l3",
      "l2",
      "l1",
      "shortlisted",
      "ai_screened",
      "applied",
      "sourced",
      "joining_deferred",
      "on_hold",
      "reserve",
      "offer_declined",
      "no_show",
      "withdrawn",
      "rejected",
    ];
    const rank = (s: string) => {
      const i = order.indexOf(canonical(s as Stage));
      return i === -1 ? order.length : i;
    };

    return (cands.data ?? []).map((c) => {
      const list = (byCandidate.get(c.id) ?? [])
        .slice()
        .sort((a, b) => rank(a.stage) - rank(b.stage));
      const primary = list[0] ?? null;
      const best = list.reduce<number | null>((acc, a) => {
        const s = scoreMap.get(a.id)?.overall_score;
        return s === undefined ? acc : Math.max(acc ?? 0, s);
      }, null);
      return {
        candidate: c,
        apps: list,
        primary,
        stage: primary ? (primary.stage as Stage) : null,
        score: best,
        stalled: primary ? stalledDays(primary.stage as Stage, primary.last_activity_at) : null,
      };
    });
  }, [cands.data, apps.data, scoreMap]);

  /** Distinct values per filterable column, built from the current pool. */
  const colOptions = useMemo(() => {
    const sources = new Set<string>();
    const employers = new Set<string>();
    const exps = new Set<string>();
    const stages = new Set<string>();
    for (const r of rows) {
      sources.add(sourceLabel(r.candidate.source));
      employers.add((r.candidate.current_employer ?? "").trim() || "Unknown");
      exps.add(expBucket(Number(r.candidate.experience_years) || 0));
      stages.add(r.stage ? STAGE_LABEL[canonical(r.stage)] : "Not in pipeline");
    }
    const sort = (s: Set<string>) => Array.from(s).sort((a, b) => a.localeCompare(b));
    return {
      sources: sort(sources),
      employers: sort(employers),
      exps: sort(exps),
      stages: sort(stages),
    };
  }, [rows]);

  const filtered = useMemo(() => {
    const t = q.toLowerCase().trim();
    const weekAgo = Date.now() - 7 * 86_400_000;
    const floor = Number(minScore) || 0;

    return rows.filter((r) => {
      const c = r.candidate;
      if (t) {
        const hit =
          c.full_name.toLowerCase().includes(t) ||
          c.email.toLowerCase().includes(t) ||
          (c.phone ?? "").toLowerCase().includes(t) ||
          (c.current_employer ?? "").toLowerCase().includes(t) ||
          (c.education ?? "").toLowerCase().includes(t) ||
          (c.location ?? "").toLowerCase().includes(t) ||
          c.skills.some((s) => s.toLowerCase().includes(t));
        if (!hit) return false;
      }
      if (sourceFilter !== "all" && c.source !== sourceFilter) return false;
      if (ownerFilter === "mine" && c.owner_id !== me.userId) return false;
      if (ownerFilter === "unassigned" && c.owner_id) return false;
      if (reqFilter !== "all" && !r.apps.some((a) => a.requisition_id === reqFilter)) return false;
      // Excel-style column filters
      if (fSource.size > 0 && !fSource.has(sourceLabel(c.source))) return false;
      if (fEmployer.size > 0 && !fEmployer.has((c.current_employer ?? "").trim() || "Unknown"))
        return false;
      if (fExp.size > 0 && !fExp.has(expBucket(Number(c.experience_years) || 0))) return false;
      if (
        fStage.size > 0 &&
        !fStage.has(r.stage ? STAGE_LABEL[canonical(r.stage)] : "Not in pipeline")
      )
        return false;
      if (floor > 0 && (r.score ?? 0) < floor) return false;
      if (expBand !== "all") {
        const y = Number(c.experience_years) || 0;
        const [lo, hi] = expBand.split("-").map(Number) as [number, number];
        if (y < lo || y > hi) return false;
      }

      const stages = VIEW_STAGES[view];
      if (stages) return r.stage ? stages.includes(canonical(r.stage)) : false;
      if (view === "new") return new Date(c.created_at).getTime() >= weekAgo;
      if (view === "unpooled") return r.apps.length === 0;
      if (view === "stalled") return r.stalled !== null;
      if (view === "incomplete") return gaps(c).length > 0;
      if (view === "duplicates") return dupMap.has(c.id);
      if (view === "stale") return freshness(c).tier === "stale";
      if (view === "flagged") {
        const v = verifMap.get(c.id);
        return !!v && (v.authenticity_score < 60 || (v.red_flags ?? []).length > 0);
      }
      return true;
    });
  }, [
    rows,
    q,
    sourceFilter,
    ownerFilter,
    me.userId,
    reqFilter,
    minScore,
    expBand,
    view,
    verifMap,
    dupMap,
    fSource,
    fEmployer,
    fExp,
    fStage,
  ]);

  const selectedRows = filtered.filter((r) => selected.has(r.candidate.id));
  const selectedAppIds = selectedRows.flatMap((r) => (r.primary ? [r.primary.id] : []));
  const allChecked = filtered.length > 0 && filtered.every((r) => selected.has(r.candidate.id));

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(filtered.map((r) => r.candidate.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function resyncSelected() {
    if (selectedRows.length === 0) return;
    setSyncing(true);
    try {
      const out = await reverify({
        data: { candidateIds: selectedRows.slice(0, 50).map((r) => r.candidate.id) },
      });
      await qc.invalidateQueries({ queryKey: ["candidate_verifications"] });
      await qc.invalidateQueries({ queryKey: ["candidates"] });
      if (out.failed) toast.warning(`${out.ok} verified · ${out.failed} failed`);
      else toast.success(`${out.ok} candidate${out.ok === 1 ? "" : "s"} re-verified`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Re-verification failed");
    } finally {
      setSyncing(false);
    }
  }

  /** Merge the selected rows into the oldest record, keeping every field and application. */
  async function mergeSelected() {
    if (selectedRows.length < 2) return;
    const members = selectedRows
      .map((r) => r.candidate)
      .slice()
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const survivor = members[0]!;
    setMerging(true);
    try {
      const out = await mergeCandidates(survivor, members.slice(1));
      await qc.invalidateQueries({ queryKey: ["candidates"] });
      await qc.invalidateQueries({ queryKey: ["applications"] });
      setSelected(new Set());
      toast.success(
        `Merged ${out.merged} duplicate${out.merged === 1 ? "" : "s"} into ${survivor.full_name}` +
          (out.movedApplications ? ` · ${out.movedApplications} application(s) moved` : ""),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setMerging(false);
    }
  }

  /** Permanent removal: the candidate and every application, score and file attached. */
  async function removeSelected() {
    if (selectedRows.length === 0) return;
    setDeleting(true);
    try {
      const out = await removeCandidates({
        data: { candidateIds: selectedRows.slice(0, 100).map((r) => r.candidate.id) },
      });
      await qc.invalidateQueries();
      setSelected(new Set());
      setDeleteOpen(false);
      toast.success(`Deleted ${out.deleted} candidate${out.deleted === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  async function autofill() {
    if (resume.trim().length < 20) {
      toast.error("Paste the resume text first");
      return;
    }
    setBusy(true);
    try {
      const p = await parse({ data: { resumeText: resume } });
      setForm((prev) => ({
        ...prev,
        full_name: p.full_name ?? "",
        email: p.email ?? "",
        location: p.location ?? "",
        experience_years: String(p.experience_years ?? 0),
        education: p.education ?? "",
        skills: (p.skills ?? []).join(", "),
        linkedin_url: p.linkedin_url ?? "",
        github_url: p.github_url ?? "",
        website_url: p.website_url ?? "",
        x_url: "",
        source: "direct",
      }));

      toast.success("Resume parsed — review the extracted fields");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Parsing failed");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!form.full_name.trim() || !form.email.trim()) {
      toast.error("Name and email are required");
      return;
    }
    setBusy(true);
    try {
      await createCandidate({
        data: {
          fullName: form.full_name,
          email: form.email,
          location: form.location,
          experienceYears: form.experience_years,
          education: form.education,
          skills: form.skills,
          linkedinUrl: form.linkedin_url,
          githubUrl: form.github_url,
          websiteUrl: form.website_url,
          xUrl: form.x_url,
          source: form.source,
          currentEmployer: form.current_employer,
          noticePeriodDays: form.notice_period_days,
          currentCtc: form.current_ctc,
          expectedCtc: form.expected_ctc,
          workAuthorization: form.work_authorization,
          willingToRelocate,
          resumeText: resume,
          requisitionId: reqId || null,
        },
      });
    } catch (e) {
      setBusy(false);
      toast.error(e instanceof Error ? e.message : "Could not save candidate");
      return;
    }
    setBusy(false);
    setOpen(false);
    setResume("");
    toast.success("Candidate added to the talent pool");
    qc.invalidateQueries({ queryKey: ["candidates"] });
    qc.invalidateQueries({ queryKey: ["applications"] });
  }

  const sources = [...new Set((cands.data ?? []).map((c) => c.source))].sort();

  /** Master-detail: the dossier follows the selected row, defaulting to the first match. */
  const activeRow = filtered.find((r) => r.candidate.id === activeId) ?? filtered[0] ?? null;

  /** Download the current filtered view as CSV for offline slicing. */
  function exportCsv() {
    const head = [
      "Name",
      "Email",
      "Phone",
      "Location",
      "Source",
      "Added",
      "Stage",
      "Match score",
      "Authenticity",
      "Experience (yrs)",
      "Employer",
      "Skills",
    ];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = filtered.map((r) => {
      const c = r.candidate;
      const v = verifMap.get(c.id);
      return [
        c.full_name,
        c.email,
        c.phone ?? "",
        c.location ?? "",
        sourceLabel(c.source),
        new Date(c.created_at).toLocaleDateString(),
        r.stage ? STAGE_LABEL[canonical(r.stage)] : "Pool only",
        r.score ?? "",
        v ? v.authenticity_score : "",
        c.experience_years,
        c.current_employer ?? "",
        c.skills.join("; "),
      ]
        .map(cell)
        .join(",");
    });
    const blob = new Blob([[head.map(cell).join(","), ...lines].join("\n")], {
      type: "text/csv",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "talent-pool.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        eyebrow="Candidate database"
        title="Talent pool"
        description="Every candidate, their live pipeline state, next action, match score and authenticity verdict — one table that scales past thousands of rows."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="size-4" /> Export CSV
            </Button>
            <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <Upload className="size-4" /> Bulk upload CVs
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                  <DialogTitle>Bulk upload CVs</DialogTitle>
                  <DialogDescription>
                    Drop in up to a few dozen PDF, DOCX or TXT resumes — each one is read, AI-parsed
                    and added to the talent pool automatically. No typing.
                  </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">
                      Open to relocation
                    </Label>
                    <Select
                      value={willingToRelocate}
                      onValueChange={(v) => setWillingToRelocate(v as "yes" | "no" | "unknown")}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unknown">Not asked yet</SelectItem>
                        <SelectItem value="yes">Yes</SelectItem>
                        <SelectItem value="no">No</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">Source</Label>
                    <Select value={bulkSource} onValueChange={setBulkSource}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {UPLOAD_SOURCES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {sourceLabel(s)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">
                      Apply all to requisition
                    </Label>
                    <Select value={bulkReqId} onValueChange={setBulkReqId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Optional" />
                      </SelectTrigger>
                      <SelectContent>
                        {(reqs.data ?? []).map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.code} — {r.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Resume files</Label>
                  <Input
                    type="file"
                    multiple
                    disabled={bulkBusy}
                    accept=".pdf,.docx,.txt,.md"
                    onChange={(e) => {
                      bulkUpload(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Text-based PDF, DOCX, TXT or MD. Scanned/image-only PDFs cannot be read — export
                    a text PDF.
                  </p>
                </div>

                {bulkLog.length > 0 && (
                  <>
                    <p className="num text-xs text-muted-foreground">
                      {bulkLog.filter((l) => l.state === "ok").length} parsed ·{" "}
                      {bulkLog.filter((l) => l.state === "error").length} failed · {bulkLog.length}{" "}
                      total
                    </p>
                    <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
                      {bulkLog.map((l, i) => (
                        <li
                          key={i}
                          className={
                            l.state === "error"
                              ? "text-destructive"
                              : l.state === "ok"
                                ? "text-muted-foreground"
                                : "text-foreground"
                          }
                        >
                          <span className="font-medium">{l.file}</span> — {l.message}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                <DialogFooter>
                  <Button variant="outline" onClick={() => setBulkOpen(false)}>
                    Done
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button>Add candidate</Button>
              </DialogTrigger>

              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Add candidate</DialogTitle>
                  <DialogDescription>
                    Paste a resume and let AI extract the structured fields, then attach the
                    candidate to a requisition.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Resume text</Label>
                  <Textarea rows={6} value={resume} onChange={(e) => setResume(e.target.value)} />
                  <Button variant="outline" size="sm" onClick={autofill} disabled={busy}>
                    <Sparkles className="size-4" /> Parse with AI
                  </Button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      ["full_name", "Full name"],
                      ["email", "Email"],
                      ["location", "Location"],
                      ["experience_years", "Experience (yrs)"],
                      ["education", "Education"],
                      ["skills", "Skills (comma separated)"],
                      ["linkedin_url", "LinkedIn URL"],
                      ["github_url", "GitHub URL"],
                      ["website_url", "Portfolio / blog URL"],
                      ["x_url", "X profile URL"],
                      ["current_employer", "Current employer"],
                      ["notice_period_days", "Notice period (days)"],
                      ["current_ctc", "Current CTC (₹)"],
                      ["expected_ctc", "Expected CTC (₹)"],
                      ["work_authorization", "Work authorisation"],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} className={key === "skills" ? "sm:col-span-2" : undefined}>
                      <Label className="mb-1.5 block text-xs text-muted-foreground">{label}</Label>
                      <Input
                        value={form[key]}
                        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      />
                    </div>
                  ))}
                  <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">Source</Label>
                    <Select
                      value={form.source}
                      onValueChange={(v) => setForm({ ...form, source: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {UPLOAD_SOURCES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {sourceLabel(s)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">
                      Apply to requisition
                    </Label>
                    <Select value={reqId} onValueChange={setReqId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Optional" />
                      </SelectTrigger>
                      <SelectContent>
                        {(reqs.data ?? []).map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.code} — {r.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={save} disabled={busy}>
                    {busy ? "Saving…" : "Save candidate"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        }
      />

      {/* Saved views */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {SAVED_VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            className={
              "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors " +
              (view === v.id
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:text-foreground")
            }
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="num text-muted-foreground">
          {filtered.length} of {rows.length} candidates
          {selected.size > 0 ? ` · ${selected.size} selected` : ""}
        </span>
        {selected.size > 0 ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={selectedAppIds.length === 0}
              onClick={() => {
                setMoverStage(undefined);
                setMoverIds(selectedAppIds);
              }}
            >
              Move stage ({selectedAppIds.length})
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={selectedRows.length < 2 || merging}
              onClick={mergeSelected}
              title="Merge the selected rows into the oldest record"
            >
              <Merge className="size-4" /> Merge ({selectedRows.length})
            </Button>
            <Button size="sm" variant="outline" onClick={resyncSelected} disabled={syncing}>
              <RefreshCw className={"size-4" + (syncing ? " animate-spin" : "")} /> Re-verify
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              title="Permanently delete the selected candidates"
            >
              <Trash2 className="size-4" /> Delete ({selectedRows.length})
            </Button>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value=""
              onChange={async (e) => {
                const v = e.target.value;
                if (!v) return;
                try {
                  await assignOwner({
                    data: {
                      candidateIds: selectedRows.map((r) => r.candidate.id),
                      ownerId: v === "none" ? null : v,
                      reason: "Bulk assignment from the talent pool",
                    },
                  });
                  toast.success("Ownership updated");
                  qc.invalidateQueries({ queryKey: ["candidates"] });
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Could not change ownership");
                }
              }}
            >
              <option value="">Assign owner…</option>
              <option value="none">Unassign (shared pool)</option>
              {(team.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                  {m.userId === me.userId ? " (you)" : ""}
                </option>
              ))}
            </select>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No candidates match" hint="Change the view or clear the filters." />
      ) : (
        <div className="panel flex flex-col overflow-hidden lg:h-[calc(100dvh-15rem)] lg:min-h-[540px] lg:flex-row">
          {/* Left: focused candidate list */}
          <div className="flex w-full flex-col border-b border-border bg-muted/30 lg:w-96 lg:shrink-0 lg:border-b-0 lg:border-r">
            <div className="space-y-2 border-b border-border bg-card p-3">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, email, skill or location…"
                className="h-8 text-sm"
              />
              <div className="grid grid-cols-2 gap-2">
                <Select value={sourceFilter} onValueChange={setSourceFilter}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sources</SelectItem>
                    {sources.map((s) => (
                      <SelectItem key={s} value={s}>
                        {sourceLabel(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={minScore} onValueChange={setMinScore}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["0", "50", "60", "70", "80"].map((s) => (
                      <SelectItem key={s} value={s}>
                        {s === "0" ? "Any score" : `Score ${s}+`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={reqFilter} onValueChange={setReqFilter}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Any requisition" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any requisition</SelectItem>
                    {(reqs.data ?? []).map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.code} — {r.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={expBand} onValueChange={setExpBand}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXP_BANDS.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Filter className="size-3" />
                <span>Value filters:</span>
                <ColumnFilter
                  title="Source"
                  options={colOptions.sources}
                  selected={fSource}
                  onChange={setFSource}
                />
                <ColumnFilter
                  title="Employer"
                  options={colOptions.employers}
                  selected={fEmployer}
                  onChange={setFEmployer}
                />
                <ColumnFilter
                  title="Experience"
                  options={colOptions.exps}
                  selected={fExp}
                  onChange={setFExp}
                />
                <ColumnFilter
                  title="Stage"
                  options={colOptions.stages}
                  selected={fStage}
                  onChange={setFStage}
                />
              </div>
            </div>

            <div className="max-h-96 flex-1 overflow-y-auto lg:max-h-none">
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                <Checkbox
                  checked={allChecked}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                  className="size-3.5"
                />
                <span className="num">
                  {filtered.length} of {rows.length} candidates
                </span>
              </div>
              {filtered.slice(0, 300).map((r) => {
                const c = r.candidate;
                const v = verifMap.get(c.id);
                const isActive = activeRow?.candidate.id === c.id;
                const dup = dupMap.get(c.id);
                return (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setActiveId(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setActiveId(c.id);
                    }}
                    className={
                      "w-full cursor-pointer border-b border-border py-3 pl-3 pr-3 text-left transition-colors hover:bg-card " +
                      (isActive
                        ? "border-l-4 border-l-primary bg-card"
                        : "border-l-4 border-l-transparent")
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Checkbox
                          checked={selected.has(c.id)}
                          onCheckedChange={() => toggleOne(c.id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Select ${c.full_name}`}
                          className="size-3.5 shrink-0"
                        />
                        <span className="truncate text-sm font-semibold">{c.full_name}</span>
                      </div>
                      {r.score !== null ? (
                        <ScoreChip score={r.score} size="sm" />
                      ) : (
                        <span className="num text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate pl-6 text-xs text-muted-foreground">
                      {c.current_employer || "employer unknown"} ·{" "}
                      <span className="num">{c.experience_years} yrs</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
                      {r.stage ? (
                        <StageBadge stage={r.stage} />
                      ) : (
                        <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Pool only
                        </span>
                      )}
                      <span className="text-[11px] text-muted-foreground">
                        {sourceLabel(c.source)}
                      </span>
                      {v ? (
                        <span
                          className={
                            "num inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold " +
                            (v.authenticity_score >= 70
                              ? "bg-emerald-500/10 text-emerald-600"
                              : v.authenticity_score >= 45
                                ? "bg-amber-500/10 text-amber-600"
                                : "bg-destructive/10 text-destructive")
                          }
                        >
                          <ShieldCheck className="size-3" /> {v.authenticity_score}
                        </span>
                      ) : null}
                      {dup ? (
                        <span
                          className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400"
                          title={`Possible duplicate (${dup.confidence}) — matched on ${dup.reasons.join(", ")}`}
                        >
                          <Copy className="size-3" /> dup ×{dup.members.length}
                        </span>
                      ) : null}
                      {r.stalled !== null ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-amber-600">
                          <AlertTriangle className="size-3" /> stalled {r.stalled}d
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {filtered.length > 300 ? (
                <p className="num p-3 text-center text-xs text-muted-foreground">
                  Showing the first 300 of {filtered.length} matches — narrow the filters to see the
                  rest.
                </p>
              ) : null}
            </div>
          </div>

          {/* Right: candidate dossier */}
          <div className="flex-1 overflow-y-auto">
            {activeRow ? (
              (() => {
                const c = activeRow.candidate;
                const v = verifMap.get(c.id);
                const flags = (v?.red_flags ?? []).length;
                const missing = gaps(c);
                const history = (
                  Array.isArray(c.employment_history) ? c.employment_history : []
                ) as EmploymentRow[];
                const metrics = history.length ? computeCareerMetrics(history) : null;
                const fresh = freshness(c);
                const linkedInUrl = normalizeExternalUrl(c.linkedin_url);
                const githubUrl = normalizeExternalUrl(c.github_url);
                return (
                  <div className="mx-auto max-w-3xl p-6 lg:p-8">
                    {/* Dossier header */}
                    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
                      <div className="min-w-0">
                        <h2 className="text-2xl font-semibold tracking-tight">{c.full_name}</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {history[0]?.title || "Role unknown"} · {c.location || "location unknown"}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                          {linkedInUrl ? (
                            <a
                              href={linkedInUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                            >
                              <Linkedin className="size-3.5" /> LinkedIn profile
                            </a>
                          ) : null}
                          {githubUrl ? (
                            <a
                              href={githubUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                            >
                              <Github className="size-3.5" /> GitHub
                            </a>
                          ) : null}
                          <span className="text-muted-foreground">
                            Added via{" "}
                            <span className="font-medium text-foreground">
                              {sourceLabel(c.source)}
                            </span>{" "}
                            on {new Date(c.created_at).toLocaleDateString()}
                          </span>
                          {c.pool_use === "role_only" ? (
                            <span
                              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                              title={`${sourceLabel(c.pool_use_source)}'s terms limit this CV to the role it came for: it is not offered for other roles or shared, and it is erased (with the HR head's approval) once that role is over.`}
                            >
                              Role only
                            </span>
                          ) : null}
                          <span
                            className={
                              fresh.tier === "stale"
                                ? "text-destructive"
                                : fresh.tier === "aging"
                                  ? "text-amber-600"
                                  : "text-muted-foreground"
                            }
                            title={`Profile data last refreshed ${fresh.days} days ago`}
                          >
                            CV {fresh.label}
                          </span>
                          <span className="text-muted-foreground">
                            Owner:{" "}
                            <span className="font-medium text-foreground">
                              {c.owner_id
                                ? c.owner_id === me.userId
                                  ? "you"
                                  : ((team.data ?? []).find((m) => m.userId === c.owner_id)?.name ??
                                    "a colleague")
                                : "unassigned"}
                            </span>
                          </span>
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Link to="/candidates/$id" params={{ id: c.id }}>
                            <Button size="sm">Full profile</Button>
                          </Link>
                          {activeRow.primary ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setMoverStage(activeRow.stage ?? undefined);
                                if (activeRow.primary) setMoverIds([activeRow.primary.id]);
                              }}
                            >
                              Move stage
                            </Button>
                          ) : (
                            <Link to="/matching">
                              <Button size="sm" variant="outline">
                                Match against a role
                              </Button>
                            </Link>
                          )}
                          {c.resume_file_path ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={async () => {
                                const out = await getResumeUrl({ data: { candidateId: c.id } });
                                if (out.ok) downloadResume(out);
                                else toast.error(out.error);
                              }}
                            >
                              <Download className="size-4" /> Open CV
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Match
                          </span>
                          {activeRow.score !== null ? (
                            <span className="num text-3xl font-bold text-primary">
                              {activeRow.score}%
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground">not scored</span>
                          )}
                        </div>
                        {v ? (
                          <span
                            className={
                              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold " +
                              (v.authenticity_score >= 70
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                                : v.authenticity_score >= 45
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-600"
                                  : "border-destructive/30 bg-destructive/10 text-destructive")
                            }
                          >
                            <ShieldCheck className="size-3.5" /> Authenticity {v.authenticity_score}
                            {flags ? ` · ${flags} flag${flags === 1 ? "" : "s"}` : ""}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            verification not run
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="mt-6 grid gap-x-10 gap-y-8 sm:grid-cols-2">
                      {/* Experience */}
                      <section>
                        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Experience
                        </h3>
                        {history.length ? (
                          <ul className="space-y-3">
                            {history.map((h, i) => (
                              <li
                                key={`${h.company}-${i}`}
                                className="border-l-2 border-border pl-3"
                              >
                                <div className="text-sm font-medium">
                                  {h.title || "role"} · {h.company || "employer"}
                                </div>
                                <div className="num text-xs text-muted-foreground">
                                  {h.start ?? "?"} – {h.end ?? "present"}
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            No work history parsed — run matching to extract it from the CV.
                          </p>
                        )}
                        {metrics ? (
                          <p className="num mt-3 text-xs text-muted-foreground">
                            {metrics.current_tenure_years !== null
                              ? `${metrics.current_tenure_years.toFixed(1)}y in current role`
                              : "tenure n/a"}{" "}
                            · {metrics.employers} employers · avg{" "}
                            {metrics.avg_tenure_years.toFixed(1)}y
                            {metrics.jobs_last_5y > 2 ? ` · ${metrics.jobs_last_5y} jobs / 5y` : ""}
                            {metrics.longest_gap_months >= 6
                              ? ` · ${metrics.longest_gap_months}m gap`
                              : ""}
                          </p>
                        ) : null}
                      </section>

                      {/* Skills & education */}
                      <section>
                        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Skills &amp; education
                        </h3>
                        <div className="flex flex-wrap gap-1.5">
                          {c.skills.length ? (
                            c.skills.map((s) => (
                              <span
                                key={s}
                                className="rounded-md border border-border bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
                              >
                                {s}
                              </span>
                            ))
                          ) : (
                            <span className="text-sm text-muted-foreground">no skills parsed</span>
                          )}
                        </div>
                        <p className="mt-3 text-sm text-muted-foreground">
                          {educationLabel(c.education) || "education unknown"}
                        </p>
                        {(c.preferred_locations ?? []).length ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Prefers: {(c.preferred_locations ?? []).join(" · ")}
                          </p>
                        ) : null}
                      </section>

                      {/* Compensation & availability */}
                      <section>
                        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Compensation &amp; availability
                        </h3>
                        <dl className="grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <dt className="text-[11px] uppercase text-muted-foreground">
                              Current CTC
                            </dt>
                            <dd className="num">{money(c.current_ctc as number | null)}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] uppercase text-muted-foreground">
                              Expected
                            </dt>
                            <dd className="num">{money(c.expected_ctc as number | null)}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] uppercase text-muted-foreground">Notice</dt>
                            <dd className="num">
                              {c.notice_period_days !== null ? `${c.notice_period_days} days` : "—"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[11px] uppercase text-muted-foreground">
                              Relocation
                            </dt>
                            <dd>
                              {c.willing_to_relocate === null
                                ? "not asked"
                                : c.willing_to_relocate
                                  ? "yes"
                                  : "no"}
                            </dd>
                          </div>
                        </dl>
                        {c.work_authorization ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Work authorisation: {c.work_authorization}
                          </p>
                        ) : null}
                      </section>

                      {/* Contact & record health */}
                      <section>
                        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Contact &amp; record
                        </h3>
                        <div className="space-y-1.5 text-sm">
                          {c.email ? (
                            <a
                              href={`mailto:${c.email}`}
                              className="block break-all hover:underline"
                            >
                              {c.email}
                            </a>
                          ) : (
                            <span className="block text-destructive">no email parsed</span>
                          )}
                          <span className="num block text-muted-foreground">
                            {c.phone || "no phone"}
                          </span>
                          <span className="block text-muted-foreground">
                            {c.location || "location unknown"}
                          </span>
                        </div>
                        <p className="mt-3 text-xs">
                          {missing.length === 0 ? (
                            <span className="text-emerald-600">Parse complete</span>
                          ) : (
                            <span className="text-amber-600">Missing: {missing.join(", ")}</span>
                          )}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {c.resume_file_path
                            ? "Original CV secured in the vault"
                            : c.resume_text
                              ? "text only — no original file"
                              : "no CV on file"}
                        </p>
                      </section>
                    </div>

                    {/* Pipeline */}
                    <section className="mt-8 rounded-md border border-border bg-muted/30 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Pipeline
                          </h3>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {activeRow.stage ? (
                              <StageBadge stage={activeRow.stage} />
                            ) : (
                              <span className="text-sm text-muted-foreground">
                                Pool only — not attached to a requisition
                              </span>
                            )}
                            {activeRow.apps.length > 1 ? (
                              <span className="num text-xs text-muted-foreground">
                                +{activeRow.apps.length - 1} more pipeline
                                {activeRow.apps.length === 2 ? "" : "s"}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1.5 text-sm text-muted-foreground">
                            Next:{" "}
                            {activeRow.stage
                              ? nextAction(activeRow.stage)
                              : "match against an open requisition"}
                            {activeRow.primary ? (
                              <span className="num">
                                {" "}
                                · last activity{" "}
                                {new Date(activeRow.primary.last_activity_at).toLocaleDateString()}
                              </span>
                            ) : null}
                          </p>
                        </div>
                        {activeRow.primary ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setMoverStage(activeRow.stage ?? undefined);
                              if (activeRow.primary) setMoverIds([activeRow.primary.id]);
                            }}
                          >
                            Move stage
                          </Button>
                        ) : null}
                      </div>
                    </section>

                    {/* Authenticity verdict */}
                    <section className="mt-6">
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Authenticity verdict
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {v
                          ? v.summary || `Authenticity ${v.authenticity_score}/100`
                          : "not run yet — select the candidate and use Re-verify"}
                      </p>
                    </section>
                  </div>
                );
              })()
            ) : (
              <div className="flex h-full items-center justify-center p-10 text-sm text-muted-foreground">
                Select a candidate from the list.
              </div>
            )}
          </div>
        </div>
      )}

      <StageMover
        open={moverIds !== null}
        onOpenChange={(v) => !v && setMoverIds(null)}
        applicationIds={moverIds ?? []}
        {...(moverStage ? { currentStage: moverStage } : {})}
        onDone={() => {
          setSelected(new Set());
          qc.invalidateQueries({ queryKey: ["applications"] });
          qc.invalidateQueries({ queryKey: ["stage_events"] });
        }}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedRows.length} candidate(s)?</DialogTitle>
            <DialogDescription>
              This permanently removes the candidate records along with their applications,
              interviews, scores, assessments and stored CVs. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-40 overflow-y-auto text-sm text-muted-foreground">
            {selectedRows.slice(0, 20).map((r) => (
              <li key={r.candidate.id}>{r.candidate.full_name}</li>
            ))}
            {selectedRows.length > 20 ? <li>+{selectedRows.length - 20} more</li> : null}
          </ul>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={removeSelected} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="text-xs text-muted-foreground">
        Stage labels come from the pipeline state machine, so only legal transitions are offered and
        every change is written to the audit trail with a reason. Authenticity is produced by the
        verification agent — an <span className="font-medium">unverified</span> claim means no
        public trace was found, not that the claim is false.
      </p>
    </>
  );
}
