import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  acknowledgeCallReview,
  getCallReview,
  listCallReviews,
  reviewCallAgain,
  type CallReviewDetail,
  type CallReviewRow,
} from "@/lib/call-reviews.functions";

const UUID = /^[0-9a-f-]{36}$/;
const PAGE = 25;

export const Route = createFileRoute("/agents/call-reviews")({
  validateSearch: (s: Record<string, unknown>) => ({
    ...(typeof s["review"] === "string" && UUID.test(s["review"]) ? { review: s["review"] } : {}),
  }),
  head: () => ({
    meta: [
      { title: "Call reviews — ATSIQ" },
      {
        name: "description",
        content: "The Voice Guard's review of every answered AI phone call.",
      },
    ],
  }),
  component: CallReviewsPage,
});

const PURPOSE: Record<string, string> = {
  screening: "Screening",
  scheduling: "Scheduling",
  negotiation: "Pay discussion",
};

export function VerdictBadge({ verdict, status }: { verdict: string | null; status: string }) {
  if (status === "failed") return <Badge variant="destructive">Review failed</Badge>;
  if (status !== "done")
    return <Badge variant="outline">{status === "due" ? "Queued" : "Reviewing"}</Badge>;
  if (verdict === "breach") return <Badge variant="destructive">Breach</Badge>;
  if (verdict === "attention") return <Badge variant="secondary">Attention</Badge>;
  return <Badge variant="outline">Pass</Badge>;
}

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const mins = (s: number | null) =>
  s == null ? "—" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function CallReviewsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/agents/call-reviews" });
  const [purpose, setPurpose] = useState<string>("all");
  const [verdict, setVerdict] = useState<string>("all");
  const [unread, setUnread] = useState(false);
  const [page, setPage] = useState(0);
  const filters = {
    ...(purpose !== "all" ? { purpose: purpose as "screening" } : {}),
    ...(verdict !== "all" ? { verdict: verdict as "breach" } : {}),
    ...(unread ? { unread: true } : {}),
  };
  const q = useQuery({
    queryKey: ["call_reviews", filters, page],
    queryFn: () => listCallReviews({ data: { ...filters, limit: PAGE, offset: page * PAGE } }),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
    retry: false,
  });
  const reset = (f: () => void) => {
    f();
    setPage(0);
  };

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Call reviews"
        description="The Voice Guard reviews every answered AI phone call after it ends: what was said against the call's rules and facts, what was recorded against what the candidate said, and how the call went on the line. It changes nothing — you decide what to do."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/agents/observability">Agent observability</Link>
          </Button>
        }
      />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select value={purpose} onValueChange={(v) => reset(() => setPurpose(v))}>
          <SelectTrigger className="h-8 w-44" aria-label="Call type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All calls</SelectItem>
            <SelectItem value="screening">Screening</SelectItem>
            <SelectItem value="scheduling">Scheduling</SelectItem>
            <SelectItem value="negotiation">Pay discussion</SelectItem>
          </SelectContent>
        </Select>
        <Select value={verdict} onValueChange={(v) => reset(() => setVerdict(v))}>
          <SelectTrigger className="h-8 w-40" aria-label="Verdict">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any verdict</SelectItem>
            <SelectItem value="breach">Breach</SelectItem>
            <SelectItem value="attention">Attention</SelectItem>
            <SelectItem value="pass">Pass</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant={unread ? "default" : "outline"}
          onClick={() => reset(() => setUnread((u) => !u))}
        >
          Not yet read
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {q.data ? `${q.data.total} review${q.data.total === 1 ? "" : "s"}` : ""}
        </span>
      </div>

      {q.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : q.error || !q.data ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {q.error instanceof Error ? q.error.message : "Not available."}
        </p>
      ) : q.data.rows.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No reviews yet. Every answered AI phone call is reviewed shortly after it ends.
        </p>
      ) : (
        <section className="panel mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Call</th>
                <th className="px-4 py-2 font-medium">Candidate</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Ended</th>
                <th className="px-4 py-2 font-medium">Verdict</th>
                <th className="px-4 py-2 text-right font-medium">Findings</th>
                <th className="px-4 py-2 text-right font-medium">Quality</th>
                <th className="px-4 py-2 font-medium">Read</th>
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((r) => (
                <ReviewRow
                  key={r.id}
                  r={r}
                  onOpen={() => void navigate({ search: { review: r.id }, replace: true })}
                />
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={(page + 1) * PAGE >= q.data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </section>
      )}

      <ReviewSheet
        id={search.review ?? null}
        onClose={() => void navigate({ search: {}, replace: true })}
      />
    </>
  );
}

function ReviewRow({ r, onOpen }: { r: CallReviewRow; onOpen: () => void }) {
  return (
    <tr className="cursor-pointer border-t border-border hover:bg-muted/40" onClick={onOpen}>
      <td className="px-4 py-2">
        {PURPOSE[r.purpose] ?? r.purpose}
        {r.scope === "timing_only" ? (
          <span className="ml-1 text-xs text-muted-foreground">(line only)</span>
        ) : null}
      </td>
      <td className="px-4 py-2">{r.candidateName ?? "—"}</td>
      <td className="px-4 py-2 text-muted-foreground">{r.role ?? "—"}</td>
      <td className="px-4 py-2 text-muted-foreground">{when(r.endedAt)}</td>
      <td className="px-4 py-2">
        <VerdictBadge verdict={r.verdict} status={r.status} />
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        {r.status === "done" ? r.findings : "—"}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        {r.qualityScore != null ? `${r.qualityScore}/5` : "—"}
      </td>
      <td className="px-4 py-2 text-xs text-muted-foreground">
        {r.ackOutcome === "confirmed" ? "Confirmed" : r.ackOutcome === "disputed" ? "Disputed" : ""}
      </td>
    </tr>
  );
}

const SEVERITY_ORDER = { critical: 0, high: 1, low: 2 } as const;

function ReviewSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["call_review", id],
    queryFn: () => getCallReview({ data: { id: id! } }),
    enabled: Boolean(id),
    retry: false,
  });
  const d = q.data;
  return (
    <Sheet open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        {!d ? (
          <p className="mt-6 text-sm text-muted-foreground">
            {q.error instanceof Error ? q.error.message : "Loading…"}
          </p>
        ) : (
          <ReviewBody
            d={d}
            onChanged={() => {
              void qc.invalidateQueries({ queryKey: ["call_review", id] });
              void qc.invalidateQueries({ queryKey: ["call_reviews"] });
              void qc.invalidateQueries({ queryKey: ["call_review_summary"] });
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ReviewBody({ d, onChanged }: { d: CallReviewDetail; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const quoted = new Set(d.findingList.flatMap((f) => f.evidence.map((e) => e.turn)));
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  const findings = [...d.findingList].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  return (
    <div className="space-y-5">
      <SheetHeader>
        <SheetTitle className="flex flex-wrap items-center gap-2">
          {PURPOSE[d.purpose] ?? d.purpose} call — {d.candidateName ?? "candidate"}
          <VerdictBadge verdict={d.verdict} status={d.status} />
        </SheetTitle>
        <SheetDescription>
          {d.role ?? "—"} · ended {when(d.endedAt)} · {mins(d.durationS)} · {d.endReason ?? "—"}
          {d.qualityScore != null ? ` · quality ${d.qualityScore}/5` : ""}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/candidates/$id" params={{ id: d.candidateId }}>
            Open candidate
          </Link>
        </Button>
        {d.status === "done" || d.status === "failed" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(() => reviewCallAgain({ data: { id: d.id } }), "Queued for review")
            }
          >
            Review again
          </Button>
        ) : null}
      </div>

      {d.summary ? <p className="text-sm">{d.summary}</p> : null}
      {d.lastError ? <p className="text-sm text-destructive">{d.lastError}</p> : null}
      {d.scope === "timing_only" ? (
        <p className="text-xs text-muted-foreground">
          The candidate did not consent to notes and the quality check, so nothing they said was
          kept — only the line was reviewed.
        </p>
      ) : null}

      {findings.length ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Findings</h3>
          {findings.map((f, i) => (
            <div key={i} className="rounded-md border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={f.severity === "low" ? "secondary" : "destructive"}>
                  {f.severity}
                </Badge>
                <span className="font-medium">{d.checkTitles[f.check]?.title ?? f.check}</span>
                <span className="text-xs text-muted-foreground">
                  {f.source === "code" ? "checked by the system" : "Voice Guard"}
                </span>
              </div>
              <p className="mt-1">{f.summary}</p>
              {f.evidence.map((e, j) => (
                <blockquote
                  key={j}
                  className="mt-1 border-l-2 border-border pl-2 text-xs text-muted-foreground"
                >
                  {e.turn != null ? <a href={`#turn-${e.turn}`}>Turn {e.turn}</a> : null} “{e.quote}
                  ”
                </blockquote>
              ))}
            </div>
          ))}
        </section>
      ) : d.status === "done" ? (
        <p className="text-sm text-muted-foreground">No findings.</p>
      ) : null}

      {d.checks.length ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Checks</h3>
          <ul className="space-y-1 text-sm">
            {d.checks.map((c) => (
              <li
                key={c.check}
                className="flex items-start gap-2"
                title={d.checkTitles[c.check]?.question}
              >
                <span
                  className={
                    c.verdict === "breach"
                      ? "text-destructive"
                      : c.verdict === "pass"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground"
                  }
                >
                  {c.verdict === "breach" ? "✕" : c.verdict === "pass" ? "✓" : "–"}
                </span>
                <span>
                  {d.checkTitles[c.check]?.title ?? c.check}
                  {c.note ? <span className="text-muted-foreground"> — {c.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.stats ? (
        <section className="text-sm">
          <h3 className="mb-2 text-sm font-semibold">On the line</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Spoke first</dt>
            <dd>{d.stats.aiSpokeFirst ? "The assistant" : "The candidate"}</dd>
            <dt className="text-muted-foreground">Talked over the candidate</dt>
            <dd>{d.stats.talkOver}</dd>
            <dt className="text-muted-foreground">Candidate cut in</dt>
            <dd>{d.stats.bargeIns}</dd>
            <dt className="text-muted-foreground">Reply time (median / slowest)</dt>
            <dd>
              {d.stats.replyMs.p50 != null
                ? `${(d.stats.replyMs.p50 / 1000).toFixed(1)} s / ${((d.stats.replyMs.max ?? 0) / 1000).toFixed(1)} s`
                : "—"}
            </dd>
            <dt className="text-muted-foreground">Voice broke up</dt>
            <dd>{d.stats.audio ? d.stats.audio.gaps : "—"}</dd>
            <dt className="text-muted-foreground">Language</dt>
            <dd>{d.stats.languageCode}</dd>
          </dl>
        </section>
      ) : null}

      {d.transcript.length ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Transcript</h3>
          <ol className="space-y-1 text-sm">
            {d.transcript.map((t, i) => (
              <li
                key={i}
                id={`turn-${i}`}
                className={`rounded px-2 py-1 ${quoted.has(i) ? "bg-amber-100/60 dark:bg-amber-900/30" : ""}`}
              >
                <span className="mr-2 text-xs tabular-nums text-muted-foreground">{i}</span>
                <span className="font-medium">
                  {t.who === "ai" ? "Assistant" : "Candidate"}:
                </span>{" "}
                {t.text}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {d.status === "done" ? (
        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-sm font-semibold">Your reading</h3>
          {d.ackOutcome ? (
            <p className="text-sm text-muted-foreground">
              Marked {d.ackOutcome} on {when(d.acknowledgedAt)}
              {d.ackNote ? ` — “${d.ackNote}”` : ""}
            </p>
          ) : null}
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What you found, or why the findings do not hold (optional)"
            maxLength={1000}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    acknowledgeCallReview({
                      data: { id: d.id, outcome: "confirmed", ...(note ? { note } : {}) },
                    }),
                  "Marked: the findings hold",
                )
              }
            >
              Findings hold
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    acknowledgeCallReview({
                      data: { id: d.id, outcome: "disputed", ...(note ? { note } : {}) },
                    }),
                  "Marked: the findings do not hold",
                )
              }
            >
              Findings do not hold
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
