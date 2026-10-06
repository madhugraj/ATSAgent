import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  Clock,
  Copy,
  FileSignature,
  PhoneCall,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";

import {
  allScreeningRunsQuery,
  applicationsQuery,
  candidatesQuery,
  departmentsQuery,
  interviewsQuery,
  latestScores,
  matchScoresQuery,
  offersQuery,
  requisitionsQuery,
  screeningQueueCountsQuery,
  type Candidate,
  type Requisition,
} from "@/lib/data";
import { canonical, stalledDays, STAGE_LABEL, type Stage } from "@/lib/lifecycle";
import { findDuplicateGroups, freshness } from "@/lib/dedupe";
import { rankPool } from "@/lib/shortlist";
import { ScoreChip, StageBadge, StatusBadge, inr } from "@/components/ats";
import { RolePeek } from "@/components/RolePeek";
import { useRoles } from "@/hooks/useRoles";
import { useOrg } from "@/hooks/useOrg";
import { Bot, Brain } from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform";
import { listAgentTasks } from "@/lib/agents.functions";
import { attachApplication } from "@/lib/candidates.functions";
import { getHrPerformance } from "@/lib/hr-performance.functions";
import { readReturnOnIndividual } from "@/lib/roi.functions";
import { listAllOrganizations } from "@/lib/platform.functions";
import { Button } from "@/components/ui/button";
import { useServerFn } from "@tanstack/react-start";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "TA Command Centre — pipeline, match quality & pool health" },
      {
        name: "description",
        content:
          "Live analytics across requisitions, funnel conversion, JD↔CV match quality, talent-pool freshness, duplicate hygiene and AI-suggested candidates from history.",
      },
      {
        property: "og:title",
        content: "TA Command Centre — pipeline, match quality & pool health",
      },
      {
        property: "og:description",
        content:
          "Funnel conversion, offer health, interviewer load, pool freshness and automatic historic matches for every open requisition.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

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

/** Compact horizontal bar used across the analytics panels. */
function Bar({
  label,
  value,
  max,
  hint,
  tone = "primary",
}: {
  label: string;
  value: number;
  max: number;
  hint?: string;
  tone?: "primary" | "accent" | "warning" | "destructive";
}) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  const bg =
    tone === "destructive"
      ? "bg-destructive"
      : tone === "warning"
        ? "bg-amber-500"
        : tone === "accent"
          ? "bg-accent"
          : "bg-primary";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate" title={label}>
          {label}
        </span>
        <span className="num shrink-0 text-muted-foreground">{hint ?? value}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${bg}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel-lift hover:panel-lift-hover overflow-hidden ${className}`}>
      <div className="flex items-start justify-between gap-3 border-b border-border bg-gradient-to-r from-accent/45 via-card to-card px-4 py-3.5">
        <div>
          <h2 className="font-semibold tracking-tight">{title}</h2>
          {subtitle ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Dashboard() {
  const qc = useQueryClient();
  const { roles, isAdmin, canApprove } = useRoles();
  const { org, isOwner } = useOrg();
  const { isSuperUser } = usePlatform();
  const roleLabel = isOwner
    ? "Organisation owner"
    : isAdmin
      ? "CHRO"
      : roles.includes("hr_head")
        ? "HR head"
        : roles.includes("department_head")
          ? "Department head"
          : roles.includes("hiring_manager")
            ? "Hiring manager"
            : "Recruiter";
  const isExecutive = isAdmin || roles.includes("hr_head");
  const canBrain = isOwner || isExecutive || isSuperUser;
  const [queueView, setQueueView] = useState<"priority" | "matches" | "recent">("priority");
  const [queueSearch, setQueueSearch] = useState("");
  const reqs = useQuery(requisitionsQuery);
  const apps = useQuery(applicationsQuery);
  const scores = useQuery(matchScoresQuery);
  const cands = useQuery(candidatesQuery);
  const depts = useQuery(departmentsQuery);
  const offers = useQuery(offersQuery);
  const interviews = useQuery(interviewsQuery);
  const runs = useQuery(allScreeningRunsQuery);

  const requisitions = reqs.data ?? [];
  const applications = apps.data ?? [];
  const candidates = cands.data ?? [];
  const scoreMap = latestScores(scores.data ?? []);

  const open = requisitions.filter((r) => r.status === "approved");
  const pending = requisitions.filter((r) => r.status.startsWith("pending"));
  const scored = applications.filter((a) => scoreMap.has(a.id));
  const avgMatch = scored.length
    ? Math.round(
        scored.reduce((s, a) => s + (scoreMap.get(a.id)?.overall_score ?? 0), 0) / scored.length,
      )
    : 0;
  const budgeted = (depts.data ?? []).reduce((s, d) => s + Number(d.budgeted_cost), 0);
  const committed = requisitions.reduce((s, r) => s + Number(r.budget_ctc) * r.openings, 0);

  /* ---------- funnel ---------- */
  const stageCount = useMemo(() => {
    const m = new Map<Stage, number>();
    for (const a of applications) {
      const st = canonical(a.stage as Stage);
      m.set(st, (m.get(st) ?? 0) + 1);
    }
    return m;
  }, [applications]);

  const funnel = useMemo(() => {
    return FUNNEL.map((stage, i) => {
      const reached = FUNNEL.slice(i).reduce((s, st) => s + (stageCount.get(st) ?? 0), 0);
      return { stage, reached, here: stageCount.get(stage) ?? 0 };
    }).filter((row) => row.reached > 0 || row.here > 0);
  }, [stageCount]);
  const funnelTop = funnel[0]?.reached ?? 0;

  /* ---------- pool health ---------- */
  const poolHealth = useMemo(() => {
    let fresh = 0;
    let aging = 0;
    let stale = 0;
    for (const c of candidates) {
      const t = freshness(c).tier;
      if (t === "fresh") fresh++;
      else if (t === "aging") aging++;
      else stale++;
    }
    const groups = findDuplicateGroups(candidates);
    const dupRows = groups.reduce((s, g) => s + g.members.length, 0);
    const noEmail = candidates.filter((c) => !c.email || c.email.endsWith("@import.local")).length;
    const noSkills = candidates.filter((c) => (c.skills ?? []).length === 0).length;
    const pooledIds = new Set(applications.map((a) => a.candidate_id));
    const untapped = candidates.filter((c) => !pooledIds.has(c.id)).length;
    return { fresh, aging, stale, groups: groups.length, dupRows, noEmail, noSkills, untapped };
  }, [candidates, applications]);

  /* ---------- historic matching: who in the pool fits an open requisition ---------- */
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const addToPipeline = useMutation({
    mutationFn: async (v: { requisitionId: string; candidateId: string }) => {
      await attachApplication({ data: { ...v, source: "talent_pool" } });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["applications"] });
      toast.success("Added to the requisition pipeline");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const suggestions = useMemo(() => {
    if (open.length === 0 || candidates.length === 0) return [];
    const appliedTo = new Map<string, Set<string>>();
    for (const a of applications) {
      const set = appliedTo.get(a.requisition_id) ?? new Set<string>();
      set.add(a.candidate_id);
      appliedTo.set(a.requisition_id, set);
    }
    return open
      .slice(0, 4)
      .map((req) => {
        const taken = appliedTo.get(req.id) ?? new Set<string>();
        const pool = candidates.filter((c) => !taken.has(c.id));
        // Always show the best three the history has; weak fits are labelled
        // rather than hidden, so the recruiter knows the pool was checked.
        const ranked = rankPool(pool, req).slice(0, 3);
        return { req, ranked };
      })
      .filter((row) => row.ranked.length > 0);
  }, [open, candidates, applications]);

  /* ---------- offers & attention ---------- */
  const offerRows = offers.data ?? [];
  const accepted = offerRows.filter((o) => ["accepted", "released"].includes(o.status)).length;
  const acceptRate = offerRows.length
    ? Math.round((offerRows.filter((o) => o.status === "accepted").length / offerRows.length) * 100)
    : 0;

  const stalled = useMemo(
    () =>
      applications
        .map((a) => ({ app: a, days: stalledDays(a.stage as Stage, a.last_activity_at) }))
        .filter((r): r is { app: (typeof applications)[number]; days: number } => r.days !== null)
        .sort((a, b) => b.days - a.days)
        .slice(0, 6),
    [applications],
  );

  const upcoming = useMemo(() => {
    const now = Date.now();
    return (interviews.data ?? [])
      .filter(
        (i) =>
          i.scheduled_at && new Date(i.scheduled_at).getTime() >= now && i.status !== "cancelled",
      )
      .slice(0, 5);
  }, [interviews.data]);

  /* ---------- needs you today ---------- */
  const countsQ = useQuery({ ...screeningQueueCountsQuery, enabled: Boolean(org) });
  const agentTasksQ = useQuery({
    queryKey: ["agent_tasks"],
    queryFn: () => listAgentTasks(),
    enabled: Boolean(org),
  });
  const agentAsks = agentTasksQ.data?.length ?? 0;
  // Strictly "yours": canApprove mirrors the server's approval-role map, so a
  // recruiter sees only their drafts and a DH only the DH hop. Deliberately not
  // myNotifications — those approval items are org-wide, not role-filtered.
  const pendingMine = useMemo(
    () => pending.filter((r) => canApprove(r.status)),
    [pending, canApprove],
  );
  // Status literal written by scheduleInterview's auto-queue
  // (interviews.functions.ts) — a rename there must land here too.
  const pendingScheduling = useMemo(
    () => (interviews.data ?? []).filter((i) => i.status === "pending_scheduling"),
    [interviews.data],
  );
  const stalledTotal = useMemo(
    () =>
      applications.filter((a) => stalledDays(a.stage as Stage, a.last_activity_at) !== null).length,
    [applications],
  );
  const offersAwaiting = offerRows.filter(
    (o) => o.status === "pending_hr" || o.status === "pending_cbo",
  ).length;
  const toCall = countsQ.data?.to_call ?? 0;

  const sourceMix = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of candidates) m.set(c.source, (m.get(c.source) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [candidates]);

  const scarceSkills = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of scores.data ?? [])
      for (const skill of s.missing_skills ?? []) m.set(skill, (m.get(skill) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [scores.data]);

  const topCandidates = applications
    .map((a) => ({ app: a, score: scoreMap.get(a.id) }))
    .filter((row) => row.score)
    .sort((a, b) => (b.score!.overall_score ?? 0) - (a.score!.overall_score ?? 0))
    .slice(0, 5);

  const candidateName = (id: string) => candidates.find((c) => c.id === id)?.full_name ?? "Unknown";
  const reqTitle = (id: string) => requisitions.find((r) => r.id === id)?.title ?? "—";

  const queueRows = useMemo(() => {
    const rows = applications
      .map((app) => {
        const candidate = candidates.find((c) => c.id === app.candidate_id);
        const requisition = requisitions.find((r) => r.id === app.requisition_id);
        const score = scoreMap.get(app.id)?.overall_score ?? 0;
        return candidate && requisition ? { app, candidate, requisition, score } : null;
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    const term = queueSearch.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (
          term &&
          !`${row.candidate.full_name} ${row.requisition.title} ${row.candidate.current_employer ?? ""}`
            .toLowerCase()
            .includes(term)
        )
          return false;
        if (queueView === "matches") return row.score >= 70;
        if (queueView === "recent")
          return Date.now() - new Date(row.app.last_activity_at).getTime() < 7 * 86_400_000;
        return !["joined", "rejected", "withdrawn"].includes(canonical(row.app.stage as Stage));
      })
      .sort((a, b) => {
        if (queueView === "recent")
          return (
            new Date(b.app.last_activity_at).getTime() - new Date(a.app.last_activity_at).getTime()
          );
        return b.score - a.score;
      })
      .slice(0, 8);
  }, [applications, candidates, requisitions, scoreMap, queueSearch, queueView]);

  /* ---------- executive analytics: drop-off, coverage, prescriptions ---------- */

  /** The stage pair that loses the largest share of the candidates reaching it. */
  const worstDrop = useMemo(() => {
    let worst: { from: Stage; to: Stage; reached: number; lost: number; lossPct: number } | null =
      null;
    for (let i = 0; i < funnel.length - 1; i += 1) {
      const from = funnel[i]!;
      const to = funnel[i + 1]!;
      if (from.reached < 3) continue;
      const lost = from.reached - to.reached;
      const lossPct = Math.round((lost / from.reached) * 100);
      if (lost > 0 && (!worst || lossPct > worst.lossPct)) {
        worst = { from: from.stage, to: to.stage, reached: from.reached, lost, lossPct };
      }
    }
    return worst;
  }, [funnel]);

  const SHORTLISTED_ON = new Set<Stage>(["shortlisted", "l1", "l2", "l3", "offer", "hired"]);
  const shortlistedApps = applications.filter((a) =>
    SHORTLISTED_ON.has(canonical(a.stage as Stage)),
  );
  const gradedAppIds = new Set(
    (runs.data ?? []).map((r) => r.application_id).filter((id): id is string => Boolean(id)),
  );
  const screeningCoverage = shortlistedApps.length
    ? Math.round(
        (shortlistedApps.filter((a) => gradedAppIds.has(a.id)).length / shortlistedApps.length) *
          100,
      )
    : 0;

  const prescriptions = useMemo(() => {
    const out: {
      title: string;
      evidence: string;
      action: string;
      cta: string;
      to:
        | "/requisitions"
        | "/candidates"
        | "/interviews"
        | "/offers"
        | "/matching"
        | "/screening"
        | "/brain";
      tone: "risk" | "watch" | "opportunity";
      icon: React.ComponentType<{ className?: string }>;
    }[] = [];

    if (pending.length) {
      const oldest = pending.reduce(
        (d, r) =>
          Math.max(d, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86_400_000)),
        0,
      );
      out.push({
        title: `${pending.length} requisition${pending.length > 1 ? "s" : ""} waiting on approval`,
        evidence: `Oldest has waited ${oldest} day${oldest === 1 ? "" : "s"}. Nothing can be sourced until these clear.`,
        action: "Approve, return with comments, or reassign the approval to the department head.",
        cta: "Review",
        to: "/requisitions",
        tone: oldest > 3 ? "risk" : "watch",
        icon: CheckCircle2,
      });
    }

    const emptyRoles = open.filter(
      (r) => !applications.some((a) => a.requisition_id === r.id),
    ).length;
    if (emptyRoles) {
      out.push({
        title: `${emptyRoles} approved role${emptyRoles > 1 ? "s have" : " has"} no candidate yet`,
        evidence: `${open.length} roles are open and ${poolHealth.untapped} pool profiles have never been put against a role.`,
        action:
          "Post internally, publish externally, or pull the best historic fits from the pool.",
        cta: "Source",
        to: "/matching",
        tone: "risk",
        icon: BriefcaseBusiness,
      });
    }

    if (stalled.length) {
      out.push({
        title: `${stalled.length} candidate${stalled.length > 1 ? "s are" : " is"} past the stage SLA`,
        evidence: `Longest wait is ${stalled[0]?.days ?? 0} days without any movement.`,
        action: "Hold the recruiter accountable in the weekly review or reassign the candidate.",
        cta: "Open",
        to: "/candidates",
        tone: (stalled[0]?.days ?? 0) > 10 ? "risk" : "watch",
        icon: Clock,
      });
    }

    if (shortlistedApps.length && screeningCoverage < 70) {
      out.push({
        title: `Only ${screeningCoverage}% of shortlisted candidates were screened properly`,
        evidence: `${shortlistedApps.length - shortlistedApps.filter((a) => gradedAppIds.has(a.id)).length} shortlisted candidates reached interviews without a graded screening call.`,
        action: "Make the screening call mandatory before an interview slot is booked.",
        cta: "Screening",
        to: "/screening",
        tone: "watch",
        icon: ShieldCheck,
      });
    }

    if (offerRows.length && acceptRate < 70) {
      out.push({
        title: `Offer acceptance is ${acceptRate}%`,
        evidence: `${offerRows.filter((o) => o.status === "declined").length} declined out of ${offerRows.length} offers made.`,
        action: "Check the offered range against the market band before the next release.",
        cta: "Offers",
        to: "/offers",
        tone: acceptRate < 50 ? "risk" : "watch",
        icon: TrendingUp,
      });
    }

    if (scored.length >= 5 && avgMatch < 60) {
      out.push({
        title: `Average fit is only ${avgMatch}%`,
        evidence: scarceSkills.length
          ? `"${scarceSkills[0]?.[0]}" is missing on ${scarceSkills[0]?.[1]} scored candidates.`
          : `${scored.length} candidates scored and few clear the bar.`,
        action:
          "Either soften the must-have list to what the market actually has, or budget for training.",
        cta: "Matching",
        to: "/matching",
        tone: "watch",
        icon: AlertTriangle,
      });
    }

    if (candidates.length && poolHealth.stale / candidates.length > 0.3) {
      out.push({
        title: `${Math.round((poolHealth.stale / candidates.length) * 100)}% of the talent pool is stale`,
        evidence: `${poolHealth.stale} profiles are over a year old and ${poolHealth.groups} duplicate sets are still unmerged.`,
        action: "Run a refresh campaign and merge duplicates before the next sourcing push.",
        cta: "Talent pool",
        to: "/candidates",
        tone: "watch",
        icon: Users,
      });
    }

    if (budgeted > 0 && committed > budgeted) {
      out.push({
        title: "Committed salary is above the workforce budget",
        evidence: `${inr(committed)} committed against ${inr(budgeted)} budgeted.`,
        action:
          "Re-sequence lower-priority roles into the next quarter, or get the budget revised.",
        cta: "Requisitions",
        to: "/requisitions",
        tone: "risk",
        icon: AlertTriangle,
      });
    }

    if (worstDrop && worstDrop.lossPct >= 40) {
      out.push({
        title: `${worstDrop.lossPct}% of candidates are lost at one step`,
        evidence: `${worstDrop.lost} of ${worstDrop.reached} candidates stop between ${STAGE_LABEL[worstDrop.from]} and ${STAGE_LABEL[worstDrop.to]}.`,
        action: "Review interviewer feedback and the screening bar for that step.",
        cta: "Interviews",
        to: "/interviews",
        tone: "watch",
        icon: Sparkles,
      });
    }

    // Leadership only: the skill-gap read belongs to the Talent Brain's ontology.
    if (canBrain && scarceSkills.length) {
      out.push({
        title: `"${scarceSkills[0]?.[0]}" is scarce in your pool`,
        evidence: `Missing on ${scarceSkills[0]?.[1]} scored candidates — the org-wide gap is larger still.`,
        action:
          "Open Talent Brain for the skill heatmap, then close the gap through training or targeted sourcing.",
        cta: "Talent Brain",
        to: "/brain",
        tone: "opportunity",
        icon: Brain,
      });
    }

    const order = { risk: 0, watch: 1, opportunity: 2 } as const;
    return out.sort((a, b) => order[a.tone] - order[b.tone]).slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pending,
    open,
    applications,
    stalled,
    offerRows,
    acceptRate,
    scored.length,
    avgMatch,
    scarceSkills,
    canBrain,
    candidates.length,
    poolHealth,
    budgeted,
    committed,
    worstDrop,
    screeningCoverage,
  ]);

  return (
    <div className="panel-lift overflow-hidden rounded-2xl">
      <header className="relative flex flex-col gap-4 overflow-hidden border-b border-border bg-gradient-to-br from-accent/55 via-card to-card px-5 py-6 sm:px-7 lg:flex-row lg:items-center lg:justify-between">
        <div className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground">
            <span className="uppercase">Talent acquisition</span>
            <span aria-hidden="true" className="size-1 rounded-full bg-border" />
            <span>Command centre</span>
          </div>
          <h1 className="truncate text-2xl font-bold">{org?.name ?? "Organisation"}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="size-3.5 text-primary" />
              {roleLabel} view
            </span>
            <span>Organisation-scoped access</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/candidates">
              <Users />
              Talent pool
            </Link>
          </Button>
          <Button asChild>
            <Link to="/requisitions">Raise requisition</Link>
          </Button>
        </div>
      </header>

      {(() => {
        // "Bring it to closure": every row lands where the action completes.
        const oldestPendingMine = [...pendingMine].sort((a, b) => {
          const last = (r: Requisition) => {
            const trail = Array.isArray(r.approval_trail)
              ? (r.approval_trail as { at?: string }[])
              : [];
            return new Date(trail[trail.length - 1]?.at ?? r.created_at).getTime();
          };
          return last(a) - last(b);
        });
        const strip: {
          icon: React.ComponentType<{ className?: string }>;
          label: string;
          value: number;
          to:
            | "/requisitions"
            | "/requisitions/$id"
            | "/candidates"
            | "/interviews"
            | "/screening"
            | "/offers"
            | "/agents";
          tone?: "default" | "warning";
          params?: { id: string };
        }[] = [];
        if (pendingMine.length)
          strip.push({
            icon: ShieldCheck,
            label: "Requisitions awaiting your approval",
            value: pendingMine.length,
            to: pendingMine.length === 1 ? "/requisitions/$id" : "/requisitions",
            tone: "warning",
            ...(pendingMine.length === 1 && oldestPendingMine[0]
              ? { params: { id: oldestPendingMine[0].id } }
              : {}),
          });
        if (pendingScheduling.length)
          strip.push({
            icon: CalendarClock,
            label: "Interview rounds awaiting scheduling",
            value: pendingScheduling.length,
            to: "/interviews",
          });
        if (toCall)
          strip.push({
            icon: PhoneCall,
            label: "Screening calls ready — best matches first",
            value: toCall,
            to: "/screening",
            tone: "warning",
          });
        if (stalledTotal)
          strip.push({
            icon: Clock,
            label: "Candidates past their stage SLA",
            value: stalledTotal,
            to: "/candidates",
            tone: "warning",
          });
        if (agentAsks)
          strip.push({
            icon: Bot,
            label: "Agent requests waiting for you",
            value: agentAsks,
            to: "/agents",
            tone: "warning",
          });
        if (isExecutive && offersAwaiting)
          strip.push({
            icon: FileSignature,
            label: "Offers awaiting approval",
            value: offersAwaiting,
            to: "/offers",
          });

        const needsYou = strip.reduce((s, r) => s + r.value, 0);
        return (
          <section
            className="border-b border-border bg-card px-5 py-3 sm:px-7"
            data-testid="needs-you"
          >
            <div className="mb-1 flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Needs you today
              </p>
              {countsQ.isLoading && org ? (
                <p className="num text-xs text-muted-foreground">Checking…</p>
              ) : (
                <p className="num text-xs text-muted-foreground">
                  {needsYou ? `${needsYou} thing${needsYou === 1 ? "" : "s"}` : "all clear"}
                </p>
              )}
            </div>
            {strip.length ? (
              <div className="grid sm:grid-cols-2 sm:gap-x-8">
                {strip.map((row) => (
                  <ActionRow
                    key={row.label}
                    icon={row.icon}
                    label={row.label}
                    value={row.value}
                    to={row.to}
                    {...(row.tone ? { tone: row.tone } : {})}
                    {...(row.params ? { params: row.params } : {})}
                  />
                ))}
              </div>
            ) : countsQ.isLoading && org ? null : (
              <p className="flex items-center gap-2 py-2.5 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-emerald-600" />
                Approvals, screening calls, scheduling and SLAs are all clear.
              </p>
            )}
          </section>
        );
      })()}

      <section className="grid border-b border-border bg-surface-2/50 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Open requisitions",
            value: open.length,
            note: `${pending.length} awaiting approval`,
            to: "/requisitions",
          },
          {
            label: "Candidates in play",
            value: applications.filter(
              (a) => !["joined", "rejected", "withdrawn"].includes(canonical(a.stage as Stage)),
            ).length,
            note: `${candidates.length} in talent pool`,
            to: "/candidates",
          },
          {
            label: "Average match",
            value: `${avgMatch}%`,
            note: `${scored.length} of ${applications.length} scored`,
            to: "/matching",
          },
          isExecutive
            ? {
                label: "Salary committed",
                value: inr(committed),
                note: `${inr(budgeted)} budgeted`,
                to: "/reports",
              }
            : {
                label: "Upcoming interviews",
                value: upcoming.length,
                note: `${stalled.length} candidates need attention`,
                to: "/interviews",
              },
        ].map((metric) => (
          <Link
            key={metric.label}
            to={metric.to}
            className="group relative block border-b border-border px-5 py-4 transition-colors last:border-b-0 hover:bg-card sm:[&:nth-child(odd)]:border-r xl:border-b-0 xl:border-r xl:last:border-r-0"
          >
            <span className="absolute inset-x-5 top-0 h-px scale-x-0 bg-primary/70 transition-transform duration-300 group-hover:scale-x-100" />
            <ArrowUpRight className="absolute right-4 top-3.5 size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {metric.label}
            </p>
            <p className="num mt-1.5 text-[1.7rem] font-bold leading-none tracking-tight">
              {metric.value}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">{metric.note}</p>
          </Link>
        ))}
      </section>

      {isExecutive ? (
        <>
          <RoiBand />
          <div className="grid lg:grid-cols-[minmax(0,1.65fr)_minmax(280px,0.75fr)]">
            <section className="border-b border-border p-5 sm:p-7 lg:border-b-0 lg:border-r">
              <div className="mb-5 flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Decisions & prescriptions</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    What the numbers say you should act on, with the evidence behind each call.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {canBrain ? (
                    <>
                      <Button asChild variant="outline" size="sm">
                        <Link to="/roi">
                          Return on Individual <ArrowUpRight />
                        </Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                        <Link to="/brain">
                          Talent Brain <ArrowUpRight />
                        </Link>
                      </Button>
                    </>
                  ) : null}
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/reports">
                      Full reports <ArrowUpRight />
                    </Link>
                  </Button>
                </div>
              </div>
              <div className="divide-y divide-border border-y border-border">
                {prescriptions.map((p) => (
                  <div key={p.title} className="flex flex-wrap items-start gap-3 py-4">
                    <span
                      className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${
                        p.tone === "risk"
                          ? "bg-destructive/10 text-destructive"
                          : p.tone === "watch"
                            ? "bg-warning/15 text-warning"
                            : "bg-primary/10 text-primary"
                      }`}
                    >
                      <p.icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{p.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{p.evidence}</p>
                      <p className="mt-1 text-xs">
                        <span className="font-medium text-primary">Do next: </span>
                        {p.action}
                      </p>
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <Link to={p.to}>
                        {p.cta} <ArrowRight />
                      </Link>
                    </Button>
                  </div>
                ))}
                {prescriptions.length === 0 ? (
                  <p className="py-8 text-sm text-muted-foreground">
                    Nothing needs an executive decision right now — approvals, SLAs, offers and pool
                    hygiene are all clear.
                  </p>
                ) : null}
              </div>
            </section>

            <aside className="p-5 sm:p-7">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">Conversion</h2>
                <span className="text-xs text-muted-foreground">All active stages</span>
              </div>
              <div className="space-y-3">
                {funnel.slice(0, 7).map((row) => (
                  <Bar
                    key={row.stage}
                    label={STAGE_LABEL[row.stage] ?? row.stage}
                    value={row.reached}
                    max={funnelTop}
                  />
                ))}
                {funnel.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No applications yet.</p>
                ) : null}
              </div>
              <div className="mt-6 rounded-md border border-border p-4">
                <p className="text-xs font-medium text-muted-foreground">Biggest drop-off</p>
                <p className="mt-1 text-sm font-semibold">
                  {worstDrop
                    ? `${STAGE_LABEL[worstDrop.from] ?? worstDrop.from} → ${STAGE_LABEL[worstDrop.to] ?? worstDrop.to}`
                    : "Not enough movement yet"}
                </p>
                {worstDrop ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {worstDrop.lost} of {worstDrop.reached} candidates stop here (
                    {worstDrop.lossPct}%). Ask the team what is failing at this step.
                  </p>
                ) : null}
              </div>
              <div className="mt-4 rounded-md border border-border p-4">
                <p className="text-xs font-medium text-muted-foreground">Screening coverage</p>
                <p className="num mt-1 text-xl font-bold">{screeningCoverage}%</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  of shortlisted candidates have a graded screening call.
                </p>
              </div>
            </aside>
          </div>

          <section className="grid border-t border-border md:grid-cols-2">
            <div className="border-b border-border p-5 sm:p-7 md:border-b-0 md:border-r">
              <h2 className="font-semibold">Where candidates come from</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Volume by channel — spend and effort should follow this.
              </p>
              <div className="mt-4 space-y-3">
                {sourceMix.map(([source, count]) => (
                  <Bar
                    key={source}
                    label={source.replace(/_/g, " ")}
                    value={count}
                    max={sourceMix[0]?.[1] ?? 1}
                  />
                ))}
                {sourceMix.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No candidates in the pool yet.</p>
                ) : null}
              </div>
            </div>
            <div className="p-5 sm:p-7">
              <h2 className="font-semibold">Skills the market is not giving us</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Most frequently missing must-haves across scored candidates.
              </p>
              <div className="mt-4 space-y-3">
                {scarceSkills.map(([skill, count]) => (
                  <Bar key={skill} label={skill} value={count} max={scarceSkills[0]?.[1] ?? 1} />
                ))}
                {scarceSkills.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing scarce yet — run matching to build this picture.
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        </>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1.65fr)_minmax(280px,0.75fr)]">
          <section className="border-b border-border p-5 sm:p-7 lg:border-b-0 lg:border-r">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">Priority workspace</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The next candidates and decisions for your role.
                </p>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link to="/matching">
                  Matching engine <ArrowUpRight />
                </Link>
              </Button>
            </div>

            <div className="mb-4 flex flex-col gap-3 xl:flex-row">
              <label className="relative min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <span className="sr-only">Search candidates or roles</span>
                <input
                  value={queueSearch}
                  onChange={(event) => setQueueSearch(event.target.value)}
                  placeholder="Search candidates or roles"
                  className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-ring/30"
                />
              </label>
              <div className="flex rounded-md bg-secondary p-1" aria-label="Queue view">
                {(
                  [
                    ["priority", "Priority"],
                    ["matches", "Top matches"],
                    ["recent", "Recent"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={queueView === value ? "outline" : "ghost"}
                    onClick={() => setQueueView(value)}
                    className="flex-1 shadow-none xl:flex-none"
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="border-b border-border bg-surface-2/70 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Candidate</th>
                    <th className="px-4 py-3 font-semibold">Role</th>
                    <th className="px-4 py-3 font-semibold">Fit</th>
                    <th className="px-4 py-3 font-semibold">Stage</th>
                    <th className="px-4 py-3 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {queueRows.map(({ app, candidate, requisition, score }) => (
                    <tr key={app.id} className="transition-colors hover:bg-surface-2/70">
                      <td className="px-4 py-3">
                        <div className="font-semibold">{candidate.full_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {candidate.current_employer || candidate.location || "Profile available"}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <RolePeek requisition={requisition} />
                      </td>
                      <td className="px-4 py-3">
                        {score ? (
                          <ScoreChip score={score} size="sm" />
                        ) : (
                          <span className="text-xs text-muted-foreground">Not scored</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StageBadge stage={app.stage} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button asChild variant="ghost" size="sm">
                          <Link to="/candidates/$id" params={{ id: candidate.id }}>
                            Review <ArrowRight />
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {queueRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                        No candidates match this view.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="p-5 sm:p-7">
            <h2 className="font-semibold">Action queue</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Only actions available to {roleLabel.toLowerCase()}.
            </p>
            <div className="mt-5 divide-y divide-border border-y border-border">
              {pending.length > 0 && (isExecutive || roles.includes("department_head")) ? (
                <ActionRow
                  icon={CheckCircle2}
                  label="Requisitions awaiting approval"
                  value={pending.length}
                  to="/requisitions"
                />
              ) : null}
              <ActionRow
                icon={Clock}
                label="Candidates past stage SLA"
                value={stalled.length}
                to="/candidates"
                tone={stalled.length ? "warning" : "default"}
              />
              <ActionRow
                icon={CalendarClock}
                label="Upcoming interviews"
                value={upcoming.length}
                to="/interviews"
              />
              <ActionRow
                icon={BriefcaseBusiness}
                label="Open requisitions"
                value={open.length}
                to="/requisitions"
              />
            </div>
            <div className="mt-6">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Pipeline movement</h3>
                <span className="text-xs text-muted-foreground">All active stages</span>
              </div>
              <div className="space-y-3">
                {funnel.slice(0, 6).map((row) => (
                  <Bar
                    key={row.stage}
                    label={STAGE_LABEL[row.stage] ?? row.stage}
                    value={row.reached}
                    max={funnelTop}
                  />
                ))}
                {funnel.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No applications yet.</p>
                ) : null}
              </div>
            </div>
          </aside>
        </div>
      )}

      {isExecutive ? (
        <section className="border-t border-border p-5 sm:p-7">
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <h2 className="font-semibold">Organisation health</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Executive demand, quality and cost signals.
              </p>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/reports">
                Full reports <ArrowUpRight />
              </Link>
            </Button>
          </div>
          <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-4">
            <Signal
              label="Offer acceptance"
              value={offerRows.length ? `${acceptRate}%` : "—"}
              note={`${accepted} accepted or released`}
            />
            <Signal
              label="Pool freshness"
              value={
                candidates.length
                  ? `${Math.round((poolHealth.fresh / candidates.length) * 100)}%`
                  : "—"
              }
              note={`${poolHealth.stale} stale profiles`}
            />
            <Signal
              label="Incomplete profiles"
              value={poolHealth.noSkills + poolHealth.noEmail}
              note={`${poolHealth.groups} duplicate sets`}
            />
            <Signal
              label="Budget position"
              value={budgeted ? `${Math.round((committed / budgeted) * 100)}%` : "—"}
              note="of workforce budget committed"
            />
          </div>
        </section>
      ) : null}

      {isExecutive ? <TeamGovernance /> : null}
      <PlatformOverview />
    </div>
  );
}

/** CHRO / HR-head governance: how the recruiting team is actually performing. */
/**
 * The one question a CHRO opens with: what return did we get on the individuals
 * we hired, and what can the organisation now go and do with them?
 */
function RoiBand() {
  const read = useServerFn(readReturnOnIndividual);
  const q = useQuery({
    queryKey: ["return_on_individual", "mine"],
    queryFn: () => read({ data: {} }),
    retry: false,
  });
  const d = q.data;
  if (q.isLoading || q.error || !d) return null;

  const cells = [
    {
      label: "Return on Individual",
      value: `${d.totals.portfolioRoi}`,
      note: "100 = your median hire",
      accent: true,
    },
    {
      label: "Capability returned",
      value: `${d.totals.avgCapability}`,
      note: `${d.totals.hires} hires read`,
    },
    {
      label: "Cost per capability point",
      value: d.totals.costPerCapabilityPoint ? inr(d.totals.costPerCapabilityPoint) : "—",
      note:
        d.totals.costBasis === "offer"
          ? "Committed offers"
          : "Offer where released, budget elsewhere",
    },
    {
      label: "Programmes staffable now",
      value: `${d.totals.goalsReady}`,
      note: `${d.totals.goalsPartial} need one lead hire`,
    },
    {
      label: "Succession exposure",
      value: `${d.totals.soleSource}`,
      note: "In-demand skills resting on one person",
      warn: d.totals.soleSource > 0,
    },
  ];

  return (
    <section className="border-b border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 sm:px-7">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-primary">
            • Return on Individual
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            What your hiring returned, and what the organisation can staff from it today.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/roi">
            Open the full reading <ArrowUpRight />
          </Link>
        </Button>
      </div>
      <div className="grid sm:grid-cols-2 xl:grid-cols-5">
        {cells.map((c) => (
          <div
            key={c.label}
            className="group relative border-b border-border px-5 py-4 last:border-b-0 sm:[&:nth-child(odd)]:border-r xl:border-b-0 xl:border-r xl:last:border-r-0"
          >
            <span className="absolute inset-x-5 top-0 h-px scale-x-0 bg-primary/70 transition-transform duration-300 group-hover:scale-x-100" />
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {c.label}
            </p>
            <p
              className={`num mt-1.5 text-[1.6rem] font-bold leading-none tracking-tight ${
                c.warn ? "text-warning" : c.accent ? "text-primary" : ""
              }`}
            >
              {c.value}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">{c.note}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function TeamGovernance() {
  const fetchPerf = useServerFn(getHrPerformance);
  const perf = useQuery({
    queryKey: ["hr_performance", "dashboard", 90],
    queryFn: () => fetchPerf({ data: { days: 90 } }),
    staleTime: 120_000,
    retry: 1,
  });

  const rows = perf.data?.rows ?? [];
  const top = rows.slice(0, 5);
  const avgQuality = rows.filter((r) => r.quality_score !== null);
  const currency = perf.data?.scheme.currency ?? "INR";

  return (
    <section className="panel p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">HR team governance</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Last 90 days — delivery, quality of the candidates moved forward, and incentive
            position.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/reports">
            Team performance <ArrowUpRight />
          </Link>
        </Button>
      </div>

      {perf.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading team performance…</p>
      ) : perf.isError ? (
        <p className="text-sm text-muted-foreground">
          Team performance is available to the CHRO, HR head and organisation owner.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No recruiter activity recorded in this window yet.
        </p>
      ) : (
        <>
          <div className="mb-4 grid gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-4">
            <Signal
              label="Recruiters active"
              value={rows.length}
              note={`${perf.data?.unattributed ?? 0} moves unattributed`}
            />
            <Signal
              label="Closures"
              value={perf.data?.totals.closures ?? 0}
              note={`target ${perf.data?.scheme.target_closures_per_month ?? 0}/month each`}
            />
            <Signal
              label="Average quality"
              value={
                avgQuality.length
                  ? Math.round(
                      avgQuality.reduce((s, r) => s + (r.quality_score ?? 0), 0) /
                        avgQuality.length,
                    )
                  : "—"
              }
              note="fit score of candidates advanced"
            />
            <Signal
              label="Incentive position"
              value={`${currency} ${Math.round(perf.data?.totals.payout ?? 0).toLocaleString("en-IN")}`}
              note="earned on current scheme"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-border text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 font-semibold">Recruiter</th>
                  <th className="py-2 font-semibold">Closures</th>
                  <th className="py-2 font-semibold">Quality</th>
                  <th className="py-2 font-semibold">Attainment</th>
                  <th className="py-2 text-right font-semibold">Performance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {top.map((r) => (
                  <tr key={r.recruiter}>
                    <td className="py-2.5 font-medium">{r.recruiter}</td>
                    <td className="num py-2.5">{r.joined || r.offers_accepted}</td>
                    <td className="num py-2.5">{r.quality_score ?? "—"}</td>
                    <td className="num py-2.5">{r.attainment_pct}%</td>
                    <td className="py-2.5 text-right">
                      <ScoreChip score={r.performance_score} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** Cross-organisation totals, visible only to the platform super admin. */
function PlatformOverview() {
  const { isSuperUser } = usePlatform();
  const fetchOrgs = useServerFn(listAllOrganizations);
  const orgs = useQuery({
    queryKey: ["platform_orgs", "dashboard"],
    queryFn: () => fetchOrgs({}),
    enabled: isSuperUser,
    staleTime: 120_000,
    retry: 1,
  });

  if (!isSuperUser) return null;
  const all = orgs.data ?? [];
  const sum = (pick: (o: (typeof all)[number]) => number) => all.reduce((s, o) => s + pick(o), 0);

  return (
    <section className="panel p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-primary">
            Platform super admin
          </div>
          <h2 className="mt-0.5 font-semibold">All organisations</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every tenant on ATSIQ. Your own organisation's data stays in the panels above.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/platform">
            Platform console <ArrowUpRight />
          </Link>
        </Button>
      </div>
      {orgs.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading organisations…</p>
      ) : (
        <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-5">
          <Signal
            label="Organisations"
            value={all.length}
            note={`${all.filter((o) => o.status === "pending").length} awaiting approval`}
          />
          <Signal label="Users" value={sum((o) => o.members)} note="across all tenants" />
          <Signal label="Requisitions" value={sum((o) => o.requisitions)} note="raised to date" />
          <Signal label="Candidates" value={sum((o) => o.candidates)} note="in all talent pools" />
          <Signal label="Hires" value={sum((o) => o.hires)} note="joined across tenants" />
        </div>
      )}
    </section>
  );
}

function ActionRow({
  icon: Icon,
  label,
  value,
  to,
  tone = "default",
  params,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  to:
    | "/requisitions"
    | "/requisitions/$id"
    | "/candidates"
    | "/interviews"
    | "/screening"
    | "/offers"
    | "/agents";
  tone?: "default" | "warning";
  params?: { id: string };
}) {
  return (
    <Link to={to} {...(params ? { params } : {})} className="group flex items-center gap-3 py-2.5">
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-md ${tone === "warning" ? "bg-warning/15 text-warning" : "bg-secondary text-muted-foreground"}`}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 text-sm font-medium">{label}</span>
      <span className="num text-sm font-semibold">{value}</span>
      <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function Signal({ label, value, note }: { label: string; value: string | number; note: string }) {
  return (
    <div className="bg-card p-4 transition-colors hover:bg-accent/30">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="num mt-1.5 text-xl font-bold leading-none tracking-tight">{value}</p>
      <p className="mt-1.5 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

/** Kept for type-narrowing of the pool candidates in suggestions. */
export type PoolCandidate = Candidate;
