/**
 * The screening result as the hiring desk shows it: a one-line summary (score,
 * what it rests on, the recommendation) and a "Why this score" pop-up with each
 * question's verdict, evidence and reason, the questions a call did not reach,
 * and how the score is put together.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ScoreChip } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getScreeningRationale,
  type ScreeningRationale,
} from "@/lib/screening-rationale.functions";

type Ref = { runId?: string; applicationId?: string };

const VERDICT: Record<string, { label: string; tone: string }> = {
  strong: { label: "Strong", tone: "text-emerald-600" },
  partial: { label: "Partial", tone: "text-amber-600" },
  weak: { label: "Weak", tone: "text-destructive" },
  not_answered: { label: "Not answered", tone: "text-muted-foreground" },
};

const FOCUS: Record<string, string> = {
  must_have_skill: "Must-have skill",
  experience_depth: "Experience depth",
  ownership: "Ownership & impact",
  stability: "Stability & tenure",
  logistics: "Logistics & offer fit",
  culture_mindset: "Mindset & culture",
};

function useRationale(ref: Ref, enabled = true) {
  return useQuery({
    queryKey: ["screening_rationale", ref.runId ?? null, ref.applicationId ?? null],
    queryFn: () => getScreeningRationale({ data: ref }),
    enabled: enabled && Boolean(ref.runId || ref.applicationId),
    staleTime: 30_000,
  });
}

/** Score, coverage and recommendation in one block, with the "Why this score" button. */
export function ScreeningResultSummary(props: Ref & { compact?: boolean }) {
  const q = useRationale(props);
  const r = q.data;
  if (!r) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted/40 p-2 text-xs">
      <ScoreChip score={r.score} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {r.kind === "phone" ? "AI phone screen" : "Written screening"}
          {r.recommendation ? (
            <>
              {" · "}
              <span
                className={r.recommendation === "Proceed" ? "text-emerald-600" : "text-amber-600"}
              >
                {r.recommendation}
              </span>
            </>
          ) : null}
        </p>
        {r.coverage ? (
          <p className="text-muted-foreground">
            {r.coverage.words} · {r.coverage.confidence} confidence
          </p>
        ) : null}
      </div>
      <WhyThisScore {...props} />
    </div>
  );
}

/** The button and its pop-up. */
export function WhyThisScore(props: Ref & { label?: string; link?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {props.link ? (
        <button
          type="button"
          className="font-medium text-primary underline"
          onClick={() => setOpen(true)}
        >
          {props.label ?? "Why this score"}
        </button>
      ) : (
        <Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(true)}>
          {props.label ?? "Why this score"}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {open ? <RationaleBody {...props} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function RationaleBody(props: Ref) {
  const q = useRationale(props);
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading the reasons…</p>;
  const r = q.data;
  if (!r)
    return <p className="text-sm text-muted-foreground">No screening result is on record yet.</p>;
  return <Rationale r={r} />;
}

function Rationale({ r }: { r: ScreeningRationale }) {
  const weighted = r.questions.some((x) => x.weight != null);
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Why {r.name} scored {r.score}/100
        </DialogTitle>
        <DialogDescription>
          {r.kind === "phone" ? "AI phone screen" : "Written screening"}
          {r.role ? ` for ${r.role}` : ""} ·{" "}
          {new Date(r.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="Screening score" value={r.score} />
        <Stat label="CV match" value={r.matchScore} />
        <Stat label="Combined fit" value={r.combinedScore} />
      </div>

      {r.recommendation ? (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5 text-sm">
          <p className="font-semibold">{r.recommendation}</p>
          {r.recommendationReason ? (
            <p className="text-xs text-muted-foreground">{r.recommendationReason}</p>
          ) : null}
        </div>
      ) : null}

      {r.coverage ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">What it rests on: </span>
          {r.coverage.words} · {r.coverage.confidence} confidence. Only the questions answered are
          graded — a question not reached or skipped never lowers the score.
        </p>
      ) : null}

      <ol className="space-y-2">
        {r.questions.map((x, i) => {
          const v = VERDICT[x.verdict] ?? { label: x.verdict, tone: "" };
          return (
            <li key={i} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="num text-xs text-muted-foreground">Q{i + 1}</span>
                {x.focus ? (
                  <Badge variant="outline" className="text-[10px]">
                    {FOCUS[x.focus] ?? x.focus}
                  </Badge>
                ) : null}
                <span className={`ml-auto text-xs font-semibold ${v.tone}`}>
                  {v.label} · <span className="num">{x.score}</span>
                  {x.weight != null ? (
                    <span className="font-normal text-muted-foreground"> (weight {x.weight})</span>
                  ) : null}
                </span>
              </div>
              <p className="mt-1 font-medium">{x.question}</p>
              <p className="mt-1 text-xs">
                <span className="text-muted-foreground">What they said: </span>
                {x.evidence || "—"}
              </p>
              <p className="mt-0.5 text-xs">
                <span className="text-muted-foreground">Why: </span>
                {x.rationale}
              </p>
            </li>
          );
        })}
      </ol>

      {r.notReached.length ? (
        <div className="text-xs">
          <p className="font-medium">
            Not reached on the call (not graded — probe in the interview)
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
            {r.notReached.map((x, i) => (
              <li key={i}>
                {x.question}
                {x.focus ? ` (${FOCUS[x.focus] ?? x.focus})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {r.redFlags.length ? (
        <div className="text-xs">
          <p className="font-medium">Points to check</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {r.redFlags.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        How the score is built: {weighted ? "the weighted average" : "the average"} of the answered
        questions&apos; scores. The grader saw the answers without the candidate&apos;s name and
        never their pay or personal details.{" "}
        <Link
          to="/candidates/$id"
          params={{ id: r.candidateId }}
          className="text-primary underline"
        >
          Open the candidate page
        </Link>{" "}
        for the answers in full and the transcript.
      </p>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="num text-lg font-semibold">{value ?? "—"}</p>
    </div>
  );
}
