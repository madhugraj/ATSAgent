import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { CheckCircle2, ClipboardCheck, Loader2 } from "lucide-react";

import { EMPTY_SCORECARD, ScorecardFields, scorecardReady } from "@/components/CompetencyRating";
import { PanelBriefView } from "@/components/PanelBriefView";
import { Button } from "@/components/ui/button";
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

function ScorecardPage() {
  const { token } = Route.useParams();
  const load = useServerFn(getPanelistScorecard);
  const submit = useServerFn(submitPanelistScorecard);
  const q = useQuery({
    queryKey: ["panelist_scorecard", token],
    queryFn: () => load({ data: { token } }),
    retry: false,
  });
  const [card, setCard] = useState(EMPTY_SCORECARD);
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
        {c.brief ? (
          <div className="mt-5 border-t border-border pt-5">
            <p className="mb-3 text-sm text-muted-foreground">
              {c.candidateName} · {c.jobTitle} · {c.orgName}
            </p>
            <PanelBriefView brief={c.brief} />
          </div>
        ) : null}
      </Shell>
    );

  const ready = scorecardReady(card, c.competencies);

  const send = async () => {
    if (!card.verdict) return;
    setBusy(true);
    try {
      await submit({
        data: {
          token,
          verdict: card.verdict,
          comments: card.comments.trim() || null,
          reason: card.reason.trim() || null,
          competencies: c.competencies.map((name) => ({ name, rating: card.ratings[name]! })),
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
      {c.brief ? (
        <div className="mt-5 border-t border-border pt-5">
          <PanelBriefView brief={c.brief} />
        </div>
      ) : null}

      <div className="mt-5">
        <ScorecardFields competencies={c.competencies} rubric={c} value={card} onChange={setCard} />
      </div>
      <Button className="mt-4 w-full" disabled={!ready || busy} onClick={send}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit scorecard (final)"}
      </Button>
    </Shell>
  );
}
