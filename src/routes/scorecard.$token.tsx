import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, ClipboardCheck, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getPanelistScorecard, submitPanelistScorecard } from "@/lib/panelist-links.functions";

export const Route = createFileRoute("/scorecard/$token")({
  head: () => ({
    meta: [
      { title: "Interview scorecard" },
      { name: "description", content: "Score the interview you took part in." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ScorecardPage,
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid min-h-screen max-w-lg place-items-center px-6 py-12">
      <div className="panel w-full p-8">{children}</div>
    </main>
  );
}

function Stars(props: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span>{props.label}</span>
      <div className="flex gap-1" role="radiogroup" aria-label={props.label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={props.value === n}
            className={`h-7 w-7 rounded border text-xs ${props.value === n ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
            onClick={() => props.onChange(n)}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

function ScorecardPage() {
  const { token } = Route.useParams();
  const load = useServerFn(getPanelistScorecard);
  const submit = useServerFn(submitPanelistScorecard);
  const q = useQuery({
    queryKey: ["panelist_scorecard", token],
    queryFn: () => load({ data: { token } }),
    retry: false,
  });
  const [rating, setRating] = useState(0);
  const [verdict, setVerdict] = useState<"select" | "hold" | "reject" | null>(null);
  const [comments, setComments] = useState("");
  const [reason, setReason] = useState("");
  const [scores, setScores] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (q.isLoading)
    return (
      <Shell>
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
      </Shell>
    );
  if (q.isError || !q.data)
    return (
      <Shell>
        <p className="text-sm">This link is not valid. Please contact the hiring team.</p>
      </Shell>
    );
  const c = q.data;
  if (done || c.state === "submitted")
    return (
      <Shell>
        <CheckCircle2 className="mx-auto h-8 w-8 text-primary" />
        <p className="mt-3 text-center text-sm">
          Thank you — your scorecard for {c.candidateName} is with the {c.orgName} hiring team.
          Scorecards are final.
        </p>
      </Shell>
    );
  if (c.state === "expired")
    return (
      <Shell>
        <p className="text-sm">
          This scorecard link has expired. Please contact the {c.orgName} hiring team.
        </p>
      </Shell>
    );
  if (c.state === "not_yet")
    return (
      <Shell>
        <p className="text-sm">
          The scorecard opens once the interview has started. Please come back after it.
        </p>
      </Shell>
    );

  const needsReason = verdict !== null && verdict !== "select";
  const ready =
    rating > 0 &&
    verdict !== null &&
    c.competencies.every((x) => (scores[x] ?? 0) > 0) &&
    (!needsReason || reason.trim().length > 0);

  const send = async () => {
    if (!verdict) return;
    setBusy(true);
    try {
      await submit({
        data: {
          token,
          rating,
          verdict,
          comments: comments.trim() || null,
          reason: reason.trim() || null,
          competencies: c.competencies.map((name) => ({ name, rating: scores[name]! })),
        },
      });
      setDone(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not submit the scorecard.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div className="flex items-center gap-2">
        <ClipboardCheck className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">L{c.level} interview scorecard</h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {c.candidateName} · {c.jobTitle} · {c.orgName}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Scoring as {c.panelistName}. Judge only what the candidate showed in the interview.
      </p>

      <div className="mt-5 space-y-2">
        {c.competencies.map((name) => (
          <Stars
            key={name}
            label={name}
            value={scores[name] ?? 0}
            onChange={(n) => setScores((s) => ({ ...s, [name]: n }))}
          />
        ))}
        <Stars label="Overall" value={rating} onChange={setRating} />
      </div>

      <div className="mt-5 flex gap-2">
        {(["select", "hold", "reject"] as const).map((v) => (
          <Button
            key={v}
            size="sm"
            variant={verdict === v ? "default" : "outline"}
            onClick={() => setVerdict(v)}
          >
            {v === "select" ? "Select" : v === "hold" ? "Hold" : "Reject"}
          </Button>
        ))}
      </div>
      {needsReason ? (
        <Textarea
          className="mt-3"
          placeholder="Why — the job-relevant reason (required)"
          value={reason}
          maxLength={2000}
          onChange={(e) => setReason(e.target.value)}
        />
      ) : null}
      <Textarea
        className="mt-3"
        placeholder="Evidence and comments (optional)"
        value={comments}
        maxLength={4000}
        onChange={(e) => setComments(e.target.value)}
      />
      <Button className="mt-4 w-full" disabled={!ready || busy} onClick={send}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit scorecard (final)"}
      </Button>
    </Shell>
  );
}
