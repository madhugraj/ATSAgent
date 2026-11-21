import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { CalendarCheck, CheckCircle2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChangeTime, ScorecardChange } from "@/components/interviews/PanelChanges";
import { answerTime, getConfirmation } from "@/lib/interview-confirmations.functions";

export const Route = createFileRoute("/confirm/$token")({
  validateSearch: (s: Record<string, unknown>): { change?: true } =>
    [1, "1", true, "true"].includes(s["change"] as never) ? { change: true } : {},
  head: () => ({
    meta: [{ title: "Interview time" }, { name: "robots", content: "noindex" }],
  }),
  component: ConfirmPage,
});

/** In the reader's own time zone, with the organisation's beside it. */
function fmt(iso: string, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid min-h-screen max-w-lg place-items-center px-6 py-12">
      <div className="panel w-full p-8">{children}</div>
    </main>
  );
}

function ConfirmPage() {
  const { token } = Route.useParams();
  const { change } = Route.useSearch();
  const load = useServerFn(getConfirmation);
  const answer = useServerFn(answerTime);
  const [busy, setBusy] = useState(false);
  const [noOpen, setNoOpen] = useState(change === true);
  const [note, setNote] = useState("");
  /** Offer times NOT ticked (all are ticked to start). */
  const [unticked, setUnticked] = useState<string[]>([]);
  const [suggest, setSuggest] = useState("");
  const q = useQuery({
    queryKey: ["confirmation", token],
    queryFn: () => load({ data: { token } }),
    retry: false,
  });

  if (q.isLoading)
    return (
      <main className="grid min-h-screen place-items-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  if (q.isError || !q.data)
    return (
      <Shell>
        <p className="text-center text-sm text-muted-foreground">
          {q.error instanceof Error ? q.error.message : "This link is not valid."}
        </p>
      </Shell>
    );
  const c = q.data;
  const panelist = c.party === "panelist";
  const offer = c.kind === "offer";
  const ticked = c.times.filter((t) => !unticked.includes(t));

  if (c.state === "accepted" || c.state === "declined")
    return (
      <Shell>
        <div className="text-center">
          <CheckCircle2 className="mx-auto size-8 text-primary" />
          <h1 className="mt-3 text-lg font-semibold">
            {c.state === "accepted"
              ? offer
                ? "Thanks, we have your times"
                : "Thanks, you're confirmed"
              : "Thanks, we've told the team"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {c.state === "accepted"
              ? panelist
                ? "The candidate is told once the whole panel has agreed."
                : "See you then."
              : panelist
                ? "Thanks — the team works out a time that suits the whole panel."
                : "The hiring team will be in touch about another time."}
          </p>
        </div>
        {panelist && !offer && c.state === "accepted" && !c.closed ? (
          <div className="mt-6 space-y-3 border-t border-border pt-4">
            <ChangeTime
              token={token}
              onDone={() => void q.refetch()}
              defaultOpen={change === true}
            />
            <ScorecardChange token={token} />
          </div>
        ) : null}
      </Shell>
    );
  if (c.closed)
    return (
      <Shell>
        <p className="text-center text-sm text-muted-foreground">
          This time no longer stands. The hiring team at {c.orgName} will be in touch.
        </p>
      </Shell>
    );

  async function send(accept: boolean) {
    setBusy(true);
    try {
      const suggestedAt = suggest ? new Date(suggest).toISOString() : null;
      const r = await answer({
        data: {
          token,
          accept,
          note: note.trim(),
          ...(offer ? { okSlots: accept ? ticked : [] } : {}),
          suggestedAt,
        },
      });
      if (!r.ok) toast.error(r.error);
      await q.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send your answer");
    } finally {
      setBusy(false);
    }
  }

  const suggestBox = (
    <div className="space-y-2">
      <label className="block text-xs text-muted-foreground">
        Another time that suits you (optional, your time zone)
        <input
          type="datetime-local"
          value={suggest}
          onChange={(e) => setSuggest(e.target.value)}
          className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
        />
      </label>
      <Textarea
        rows={2}
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Anything the team should know (optional)"
      />
    </div>
  );

  return (
    <Shell>
      <CalendarCheck className="size-7 text-primary" />
      <h1 className="mt-3 text-xl font-semibold">
        {panelist
          ? offer
            ? "Which of these times work for you?"
            : "Can you make this time?"
          : "Please confirm your interview"}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {panelist && c.candidateName ? `${c.candidateName}'s ` : ""}
        {c.roundLabel} for <strong>{c.jobTitle}</strong> at {c.orgName} · {c.durationMins} minutes
      </p>
      {offer ? (
        <>
          <div className="mt-5 space-y-2" role="group" aria-label="Interview times">
            {c.times.map((t) => (
              <label
                key={t}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={!unticked.includes(t)}
                  onChange={(e) =>
                    setUnticked((u) => (e.target.checked ? u.filter((x) => x !== t) : [...u, t]))
                  }
                />
                <span>
                  {fmt(t)}
                  {fmt(t, c.timeZone) !== fmt(t) ? (
                    <span className="block text-xs text-muted-foreground">
                      {fmt(t, c.timeZone)}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          <div className="mt-4">{suggestBox}</div>
          <Button
            className="mt-4 w-full"
            disabled={busy || (!ticked.length && !suggest)}
            onClick={() => void send(ticked.length > 0)}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {ticked.length
              ? `Send — ${ticked.length} of ${c.times.length} work`
              : "Send — none of these work"}
          </Button>
        </>
      ) : (
        <>
          <div className="mt-5 space-y-2">
            {c.times.map((t) => (
              <div key={t} className="rounded-md border border-border px-3 py-2.5 text-sm">
                {fmt(t)}
                {fmt(t, c.timeZone) !== fmt(t) ? (
                  <span className="block text-xs text-muted-foreground">{fmt(t, c.timeZone)}</span>
                ) : null}
              </div>
            ))}
          </div>
          {noOpen ? null : (
            <Button
              autoFocus
              size="lg"
              className="mt-4 w-full ring-4 ring-primary/20"
              disabled={busy}
              onClick={() => void send(true)}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {panelist ? "Accept" : "Confirm this time"}
            </Button>
          )}
          {noOpen ? (
            <div className="mt-4 space-y-2">
              {panelist ? (
                suggestBox
              ) : (
                <Textarea
                  rows={3}
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="When would suit you instead? (optional)"
                />
              )}
              <Button
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={() => void send(false)}
              >
                Send to the hiring team
              </Button>
              <button
                type="button"
                className="w-full text-center text-xs text-muted-foreground underline"
                onClick={() => setNoOpen(false)}
              >
                {panelist ? "Accept instead" : "Keep this time"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="mt-3 w-full text-center text-xs text-muted-foreground underline"
              onClick={() => setNoOpen(true)}
            >
              {panelist ? "I can't make it or need another time" : "This time doesn't work for me"}
            </button>
          )}
        </>
      )}
    </Shell>
  );
}
