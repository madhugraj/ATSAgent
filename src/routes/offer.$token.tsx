import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, FileText, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getOfferForResponse, respondToOfferLink } from "@/lib/offer-response.functions";

export const Route = createFileRoute("/offer/$token")({
  head: () => ({
    meta: [
      { title: "Your offer" },
      { name: "description", content: "Review your offer and reply." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: OfferPage,
});

const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);

type Answer =
  | { action: "accept" }
  | { action: "decline"; reason: string }
  | { action: "ask_changes"; expectedCtc: number | null; joiningDate: string | null; note: string };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid min-h-screen max-w-2xl place-items-center px-6 py-12">
      <div className="panel w-full p-8">{children}</div>
    </main>
  );
}

function OfferPage() {
  const { token } = Route.useParams();
  const load = useServerFn(getOfferForResponse);
  const respond = useServerFn(respondToOfferLink);
  const q = useQuery({
    queryKey: ["offer_response", token],
    queryFn: () => load({ data: { token } }),
    retry: false,
  });
  const [mode, setMode] = useState<null | "accept" | "decline" | "changes">(null);
  const [reason, setReason] = useState("");
  const [ctc, setCtc] = useState("");
  const [joining, setJoining] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

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
  const o = q.data;
  const status = done ?? o.status;

  async function send(answer: Answer) {
    setBusy(true);
    try {
      const r = await respond({ data: { token, answer } });
      if (r.ok) setDone(r.status);
      else toast.error(r.reason);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send your answer");
    } finally {
      setBusy(false);
    }
  }

  if (status !== "released")
    return (
      <Shell>
        <div className="text-center">
          <CheckCircle2 className="mx-auto size-8 text-primary" />
          <h1 className="mt-3 text-lg font-semibold">
            {status === "accepted"
              ? "Offer accepted — welcome aboard!"
              : status === "declined"
                ? "Thank you for letting us know"
                : status === "countered"
                  ? "Thanks — your request is with the team"
                  : "This offer is no longer open"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {status === "accepted"
              ? `${o.orgName} will be in touch about your joining.`
              : status === "countered"
                ? `${o.orgName} will review your request and send you a revised offer.`
                : `The hiring team at ${o.orgName} has your answer.`}
          </p>
        </div>
      </Shell>
    );

  return (
    <Shell>
      <FileText className="size-7 text-primary" />
      <h1 className="mt-3 text-xl font-semibold">
        {o.candidateFirstName}, your {o.revision > 1 ? "revised " : ""}offer from {o.orgName}
      </h1>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Role</dt>
          <dd className="font-medium">{o.jobTitle}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Annual CTC</dt>
          <dd className="num font-medium">{inr(o.offeredCtc)}</dd>
        </div>
        {o.joiningDate ? (
          <div>
            <dt className="text-xs text-muted-foreground">Joining date</dt>
            <dd className="font-medium">{o.joiningDate}</dd>
          </div>
        ) : null}
      </dl>
      {o.letter ? (
        <details className="mt-4 rounded-md border border-border p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            {o.letter.subject || "Offer letter"}
          </summary>
          <p className="mt-2 whitespace-pre-wrap">{o.letter.opening}</p>
          {o.letter.sections.map((s) => (
            <div key={s.heading} className="mt-2">
              <p className="font-medium">{s.heading}</p>
              <p className="whitespace-pre-wrap text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </details>
      ) : null}

      {mode === null ? (
        <div className="mt-6 flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => setMode("accept")}>
            Accept the offer
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => setMode("changes")}>
            Ask for changes
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setMode("decline")}>
            Decline
          </Button>
        </div>
      ) : mode === "accept" ? (
        <div className="mt-6 space-y-3 rounded-md border border-border p-3 text-sm">
          <p>
            You are accepting the offer for <span className="font-medium">{o.jobTitle}</span> at{" "}
            <span className="num font-medium">{inr(o.offeredCtc)}</span> a year
            {o.joiningDate ? `, joining on ${o.joiningDate}` : ""}. This is your final answer to
            this offer.
          </p>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void send({ action: "accept" })}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null} Yes, accept the offer
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setMode(null)}>
              Back
            </Button>
          </div>
        </div>
      ) : mode === "decline" ? (
        <div className="mt-6 space-y-2">
          <Textarea
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="May we ask why? (required)"
          />
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={busy || reason.trim().length < 3}
              onClick={() => void send({ action: "decline", reason: reason.trim() })}
            >
              Decline the offer
            </Button>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-muted-foreground">
              Expected annual CTC (₹)
              <Input
                className="mt-1"
                inputMode="numeric"
                value={ctc}
                onChange={(e) => setCtc(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="e.g. 11000000"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Preferred joining date
              <Input
                className="mt-1"
                type="date"
                value={joining}
                onChange={(e) => setJoining(e.target.value)}
              />
            </label>
          </div>
          <Textarea
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything else you would like changed, and why"
          />
          <div className="flex gap-2">
            <Button
              disabled={busy || (!ctc && !joining && note.trim().length < 3)}
              onClick={() =>
                void send({
                  action: "ask_changes",
                  expectedCtc: ctc ? Number(ctc) : null,
                  joiningDate: joining || null,
                  note: note.trim(),
                })
              }
            >
              Send my request
            </Button>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </Shell>
  );
}
