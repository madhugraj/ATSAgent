import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Search } from "lucide-react";
import { z } from "zod";

import {
  screeningCandidateQuery,
  screeningKitsQuery,
  screeningRunsQuery,
  requisitionsQuery,
  type ScreeningBucket,
  type ScreeningQueueRow,
} from "@/lib/data";
import { listScreeningQueue } from "@/lib/screening-queue.functions";
import { canonical, type Stage } from "@/lib/lifecycle";
import { ScreeningPanel } from "@/components/ScreeningPanel";
import { StageMover } from "@/components/StageMover";
import { EmptyState, PageHeader, ScoreChip, SkillPills, StageBadge } from "@/components/ats";
import { getResumeDownloadUrl } from "@/lib/resume.functions";
import { downloadResume } from "@/lib/resume-download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/screening")({
  head: () => ({
    meta: [
      { title: "Screening call support — questions, answers & second-level score" },
      {
        name: "description",
        content:
          "A triage queue per role: the best matches first, screening questions already prepared in the background, and everything about one candidate on one screen.",
      },
      {
        property: "og:title",
        content: "Screening call support — questions, answers & second-level score",
      },
      {
        property: "og:description",
        content:
          "Work the screening queue: JD- and CV-specific questions ready before the call, answers captured live, and an explainable second-level score.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  validateSearch: z.object({ req: z.string().optional() }),
  component: ScreeningWorkspace,
});

const PAGE_SIZE = 50;

const BUCKETS: { key: ScreeningBucket; label: string; empty: string }[] = [
  { key: "to_call", label: "To call", empty: "Nobody is waiting for a screening call." },
  { key: "ready", label: "Questions ready", empty: "No prepared calls right now." },
  { key: "graded", label: "Screened", empty: "No graded screening calls yet." },
  { key: "all", label: "All", empty: "No active applications yet." },
];

type Selection = { candidateId: string; applicationId: string } | null;

function ScreeningWorkspace() {
  const { req } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();

  const [bucket, setBucket] = useState<ScreeningBucket>("to_call");
  const [term, setTerm] = useState("");
  const [termDebounced, setTermDebounced] = useState("");
  const [selected, setSelected] = useState<Selection>(null);
  const [mover, setMover] = useState<{ preset: Stage | null } | null>(null);

  const reqs = useQuery(requisitionsQuery);

  useEffect(() => {
    const t = setTimeout(() => setTermDebounced(term), 300);
    return () => clearTimeout(t);
  }, [term]);

  const requisitionId = req ?? null;
  const queue = useInfiniteQuery({
    queryKey: ["screening_queue", { requisitionId, bucket, term: termDebounced }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      listScreeningQueue({
        data: {
          requisitionId,
          bucket,
          ...(termDebounced ? { term: termDebounced } : {}),
          offset: pageParam as number,
          limit: PAGE_SIZE,
        },
      }),
    getNextPageParam: (last, _pages, lastPageParam) =>
      last.rows.length < PAGE_SIZE ? undefined : (lastPageParam as number) + PAGE_SIZE,
    // Quietly converge while the background prep is mid-flight, so a row the
    // recruiter is watching flips from "preparing" to "questions ready" on its
    // own — never poll otherwise.
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) =>
        p.rows.some((r) => r.prep_status === "pending" || r.prep_status === "running"),
      )
        ? 5000
        : false,
  });

  const flat = useMemo<ScreeningQueueRow[]>(
    () => queue.data?.pages.flatMap((p) => p.rows) ?? [],
    [queue.data],
  );
  const counts = queue.data?.pages[0]?.counts;

  // Keep a selection anchored to its application; when it leaves the bucket
  // (moved on, rejected) land on the next row instead of an empty pane.
  useEffect(() => {
    if (!flat.length) return;
    if (!selected || !flat.some((r) => r.application_id === selected.applicationId)) {
      const first = flat[0]!;
      setSelected({ candidateId: first.candidate_id, applicationId: first.application_id });
    }
  }, [flat, selected]);

  /* -------------------------------------------------- seamless scrolling */

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((e) => e.isIntersecting) &&
          queue.hasNextPage &&
          !queue.isFetchingNextPage
        ) {
          void queue.fetchNextPage();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // Field-level deps: the observer only re-wires when the paging state moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.hasNextPage, queue.isFetchingNextPage, queue.fetchNextPage]);

  /* ------------------------------------------------------- keyboard flow */

  const selectIndex = (idx: number) => {
    const row = flat[idx];
    if (row) setSelected({ candidateId: row.candidate_id, applicationId: row.application_id });
  };
  const selectedIndex = selected
    ? flat.findIndex((r) => r.application_id === selected.applicationId)
    : -1;

  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (mover) return; // the stage dialog owns the keys while it is open
      if (!flat.length) return;
      switch (e.key) {
        case "j":
        case "ArrowDown": {
          e.preventDefault();
          const next = Math.min(selectedIndex + 1, flat.length - 1);
          if (selectedIndex === flat.length - 1 && queue.hasNextPage) void queue.fetchNextPage();
          selectIndex(next);
          break;
        }
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          selectIndex(Math.max(selectedIndex - 1, 0));
          break;
        }
        case "a":
        case "s":
        case "r":
          if (selected) {
            e.preventDefault();
            setMover({
              preset: e.key === "a" ? "l1" : e.key === "s" ? "shortlisted" : "rejected",
            });
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, selectedIndex, selected, mover, queue.hasNextPage]);

  const invalidateQueue = () => {
    void qc.invalidateQueries({ queryKey: ["screening_queue"] });
    void qc.invalidateQueries({ queryKey: ["applications"] });
  };

  const onMoveDone = () => {
    // Land on the next row so triage continues without touching the mouse.
    if (selectedIndex >= 0 && flat.length > 1) {
      selectIndex(Math.min(selectedIndex + 1, flat.length - 1));
    }
    invalidateQueue();
  };

  const activeReq = (reqs.data ?? []).find((r) => r.id === requisitionId);
  const selectedRow = selected
    ? flat.find((r) => r.application_id === selected.applicationId)
    : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Screening call support"
        title={activeReq ? `Screening — ${activeReq.title}` : "Screening queue"}
        description="The best matches first, questions already prepared in the background. Work the stack: open a candidate, run the call, move them on — without ever leaving the page."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
        {/* ---------------------------------------------------- the stack */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          <div className="flex items-center gap-2">
            <Select
              value={requisitionId ?? "all"}
              onValueChange={(v) =>
                navigate({ search: { req: v === "all" ? undefined : v } }).then(() => {
                  setBucket("to_call");
                })
              }
            >
              <SelectTrigger aria-label="Requisition">
                <SelectValue placeholder="All requisitions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All requisitions</SelectItem>
                {(reqs.data ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div
            className="flex flex-wrap gap-1 rounded-lg bg-secondary p-1"
            role="tablist"
            aria-label="Screening buckets"
          >
            {BUCKETS.map((b) => (
              <button
                key={b.key}
                role="tab"
                aria-selected={bucket === b.key}
                onClick={() => setBucket(b.key)}
                className={
                  "flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors " +
                  (bucket === b.key
                    ? "bg-background shadow-sm"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {b.label}
                <span className="num ml-1.5 text-[0.6875rem]">{counts ? counts[b.key] : "—"}</span>
              </button>
            ))}
          </div>

          <label className="relative block">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search name, email or role…"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
          </label>

          <div className="space-y-1.5">
            {queue.isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                </div>
              ))
            ) : queue.isError ? (
              <div className="rounded-lg border border-destructive/30 p-4 text-sm">
                Could not load the queue.
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-3"
                  onClick={() => void queue.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : flat.length === 0 ? (
              <EmptyState
                title={BUCKETS.find((b) => b.key === bucket)?.empty ?? "Nothing here yet."}
                {...(bucket === "to_call"
                  ? {
                      hint: "Candidates land here the moment they are shortlisted — questions are prepared automatically in the background.",
                    }
                  : counts && counts.all === 0
                    ? { hint: "Add candidates to a role first, then run the matching engine." }
                    : {})}
              />
            ) : (
              flat.map((row) => (
                <QueueRowButton
                  key={row.application_id}
                  row={row}
                  selected={selected?.applicationId === row.application_id}
                  onSelect={() =>
                    setSelected({
                      candidateId: row.candidate_id,
                      applicationId: row.application_id,
                    })
                  }
                />
              ))
            )}
            {/* Sentinel — scrolling near the end quietly pulls the next page. */}
            <div ref={sentinelRef} className="h-px" />
            {queue.isFetchingNextPage ? (
              <p className="py-2 text-center text-xs text-muted-foreground">Loading more…</p>
            ) : null}
          </div>

          {flat.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              j / k move · a advance · s shortlist · r reject
            </p>
          ) : null}
        </aside>

        {/* --------------------------------------------------- the pane */}
        <section className="min-w-0">
          {selected ? (
            <ScreeningTriagePane
              key={selected.applicationId}
              candidateId={selected.candidateId}
              applicationId={selected.applicationId}
              onStageMove={(preset) => setMover({ preset })}
              onQueueChanged={invalidateQueue}
            />
          ) : (
            <EmptyState title="Pick a candidate from the queue." />
          )}
        </section>
      </div>

      {selected ? (
        <StageMover
          open={mover !== null}
          onOpenChange={(v) => !v && setMover(null)}
          applicationIds={[selected.applicationId]}
          {...(selectedRow ? { currentStage: canonical(selectedRow.stage as Stage) } : {})}
          presetToStage={mover?.preset ?? null}
          onDone={onMoveDone}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------ queue row */

function QueueRowButton({
  row,
  selected,
  onSelect,
}: {
  row: ScreeningQueueRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const prepping = row.prep_status === "pending" || row.prep_status === "running";
  return (
    <button
      type="button"
      aria-selected={selected}
      onClick={onSelect}
      className={
        "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors " +
        (selected ? "bg-surface-2 ring-1 ring-ring/30" : "hover:bg-surface-2/60")
      }
    >
      {row.match_score !== null ? (
        <ScoreChip score={row.match_score} size="sm" />
      ) : (
        <span className="num w-9 text-center text-xs text-muted-foreground">—</span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{row.candidate_name}</span>
          {row.red_flag_count > 0 ? (
            <span className="num shrink-0 rounded border border-destructive/30 px-1 text-[0.625rem] text-destructive">
              {row.red_flag_count} flag{row.red_flag_count === 1 ? "" : "s"}
            </span>
          ) : null}
          {row.screening_score !== null ? (
            <span className="num shrink-0 text-[0.6875rem] text-muted-foreground">
              screen {row.screening_score}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          {prepping ? (
            <>
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
              </span>
              Preparing questions…
            </>
          ) : (
            <span className="truncate">
              {row.requisition_title} · {row.experience_years ?? "?"} yrs
              {row.location ? ` · ${row.location}` : ""}
            </span>
          )}
          <StageBadge stage={row.stage} />
        </span>
      </span>
    </button>
  );
}

/* ---------------------------------------------------------- triage pane */

function ScreeningTriagePane({
  candidateId,
  applicationId,
  onStageMove,
  onQueueChanged,
}: {
  candidateId: string;
  applicationId: string;
  onStageMove: (preset: Stage | null) => void;
  /** Called when something inside the pane changed the queue's inputs. */
  onQueueChanged: () => void;
}) {
  const qc = useQueryClient();
  const detail = useQuery(screeningCandidateQuery(candidateId, applicationId));
  const getResumeUrl = useServerFn(getResumeDownloadUrl);
  const [downloading, setDownloading] = useState(false);

  // Same query keys ScreeningPanel uses, so these read the shared cache for
  // free — and their dataUpdatedAt is the signal that a grade or kit change
  // happened inside the panel and the queue should refresh its buckets.
  const kitsAt = useQuery(screeningKitsQuery(candidateId)).dataUpdatedAt;
  const runsAt = useQuery(screeningRunsQuery(candidateId)).dataUpdatedAt;
  const changedAt = Math.max(kitsAt, runsAt);
  useEffect(() => {
    if (!changedAt) return;
    void qc.invalidateQueries({ queryKey: ["screening_queue"] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedAt]);

  if (detail.isLoading) {
    return (
      <div className="space-y-4 rounded-lg border p-5">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <EmptyState title="Could not load this candidate." hint="Pick another row from the queue." />
    );
  }

  const { candidate, application, match, roles } = detail.data;
  // The snake_case shape the wire delivers (resume_text never rides along).
  const c = candidate as {
    full_name: string | null;
    email: string | null;
    location: string | null;
    experience_years: number | string | null;
    resume_file_path: string | null;
  };

  async function downloadCv() {
    setDownloading(true);
    try {
      const out = await getResumeUrl({ data: { candidateId } });
      if (out.ok) downloadResume(out);
      else toast.error(out.error);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold">{c.full_name}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {[c.email, c.location, `${c.experience_years ?? "?"} yrs`]
                .filter(Boolean)
                .join(" · ")}
              {" · "}
              {application.requisition_title}
              {application.requisition_code ? ` (${application.requisition_code})` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {match?.overall_score != null ? <ScoreChip score={match.overall_score} /> : null}
            <StageBadge stage={application.stage} />
            <Button size="sm" variant="outline" onClick={() => onStageMove(null)}>
              Move stage
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
          {c.resume_file_path ? (
            <Button size="sm" variant="ghost" disabled={downloading} onClick={downloadCv}>
              <Download className="size-3.5" /> {downloading ? "Opening…" : "Download original CV"}
            </Button>
          ) : null}
        </div>

        {match ? (
          <div className="mt-4 space-y-3 rounded-lg bg-surface-2/60 p-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">Why here</span>
              {match.recommendation ? (
                <span className="rounded-full border px-2 py-0.5 text-xs capitalize text-muted-foreground">
                  {match.recommendation}
                </span>
              ) : null}
            </div>
            {match.rationale ? <p className="text-sm">{match.rationale}</p> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs text-muted-foreground">Evidenced</Label>
                <div className="mt-1.5">
                  <SkillPills skills={match.matched_skills} tone="match" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Gaps</Label>
                <div className="mt-1.5">
                  <SkillPills skills={match.missing_skills} tone="miss" />
                </div>
              </div>
            </div>
            {match.risk_flags?.length ? (
              <ul className="list-inside list-disc text-xs text-destructive">
                {match.risk_flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            No JD↔CV score yet — run the matching engine to see the evidence behind this candidate.
          </p>
        )}
      </div>

      <ScreeningPanel
        candidateId={candidateId}
        candidateName={c.full_name ?? "Candidate"}
        roles={roles.map((r) => ({ requisitionId: r.requisition_id, title: r.title }))}
      />
    </div>
  );
}
