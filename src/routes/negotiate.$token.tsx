import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2 } from "lucide-react";

import { answerNegotiationPage, getNegotiationPage } from "@/lib/negotiation.functions";
import { lakhsToRupees, rupees } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/negotiate/$token")({
  head: () => ({
    meta: [{ title: "About your offer" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: NegotiatePage,
});

type Choice = "accept" | "propose" | "call";

function NegotiatePage() {
  const { token } = Route.useParams();
  const load = useServerFn(getNegotiationPage);
  const answer = useServerFn(answerNegotiationPage);
  const q = useQuery({
    queryKey: ["negotiate", token],
    queryFn: () => load({ data: { token } }),
    retry: false,
  });
  const [choice, setChoice] = useState<Choice | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<Choice | null>(null);

  if (q.isLoading)
    return (
      <main className="grid min-h-screen place-items-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  if (q.isError)
    return (
      <main className="mx-auto grid min-h-screen max-w-lg place-items-center px-6">
        <p className="text-center text-sm text-muted-foreground">
          {q.error instanceof Error ? q.error.message : "This link is no longer valid."}
        </p>
      </main>
    );
  const d = q.data!;
  if (done || d.status === "answered")
    return (
      <main className="mx-auto grid min-h-screen max-w-lg place-items-center px-6">
        <div className="panel p-8 text-center">
          <CheckCircle2 className="mx-auto size-8 text-primary" />
          <h1 className="mt-3 text-lg font-semibold">Thank you</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {done === "accept"
              ? `${d.orgName} will prepare your offer letter at this figure; it comes to you once it is approved.`
              : done === "call"
                ? `Someone from ${d.orgName}'s HR team will call you.`
                : `Your answer is with ${d.orgName}'s HR team. They will be in touch.`}
          </p>
        </div>
      </main>
    );

  const rupeesAsked = lakhsToRupees(amount);
  const ready =
    choice === "accept" ||
    choice === "call" ||
    (choice === "propose" && rupeesAsked != null && !Number.isNaN(rupeesAsked) && rupeesAsked > 0);

  async function send() {
    if (!choice) return;
    setSending(true);
    try {
      await answer({
        data: {
          token,
          answer:
            choice === "propose"
              ? { decision: "propose", amount: rupeesAsked, note: note.trim() || undefined }
              : { decision: choice, note: note.trim() || undefined },
        },
      });
      setDone(choice);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send your answer");
    } finally {
      setSending(false);
    }
  }

  const levers = d.levers ?? {};
  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-xl font-semibold">About your offer</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {d.jobTitle} at {d.orgName}
      </p>
      <div className="panel mt-6 space-y-3 p-5 text-sm">
        {d.message
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {p}
            </p>
          ))}
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <p className="font-medium">What we can offer</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>{rupees(d.proposedCtc)} a year (CTC)</li>
            {levers.joiningBonus ? <li>A {rupees(levers.joiningBonus)} joining bonus</li> : null}
            {levers.reviewMonths ? (
              <li>A pay review after {levers.reviewMonths} months, written into your letter</li>
            ) : null}
            {levers.other ? <li>{levers.other}</li> : null}
          </ul>
        </div>
      </div>

      <div className="panel mt-4 space-y-4 p-5">
        <fieldset className="space-y-2 text-sm">
          <legend className="font-semibold">Your answer</legend>
          {(
            [
              ["accept", "This works for me"],
              ["propose", "I would like to suggest another figure"],
              ["call", "I would rather talk it through on a call"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex items-center gap-2">
              <input
                type="radio"
                name="choice"
                checked={choice === v}
                onChange={() => setChoice(v)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {choice === "propose" ? (
          <div className="space-y-1">
            <Label htmlFor="amount">The CTC you would accept (₹ lakhs per annum)</Label>
            <Input
              id="amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="note">
            {choice === "call" ? "Good times to call (optional)" : "Anything else (optional)"}
          </Label>
          <Textarea
            id="note"
            rows={2}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button className="w-full" disabled={!ready || sending} onClick={() => void send()}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : null} Send my answer
        </Button>
      </div>
    </main>
  );
}
