import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { CalendarCheck, CheckCircle2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { chooseSlotOffer, declineSlotOffer, getSlotOffer } from "@/lib/slot-offers.functions";

export const Route = createFileRoute("/schedule/$token")({
  head: () => ({
    meta: [
      { title: "Choose your interview time" },
      { name: "description", content: "Pick the interview time that suits you." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SchedulePage,
});

/** Shown in the candidate's own time zone, with the organisation's beside it. */
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

function SchedulePage() {
  const { token } = Route.useParams();
  const load = useServerFn(getSlotOffer);
  const choose = useServerFn(chooseSlotOffer);
  const decline = useServerFn(declineSlotOffer);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<string | null>(null);
  const [noneOpen, setNoneOpen] = useState(false);
  const [note, setNote] = useState("");
  const [declined, setDeclined] = useState(false);
  const q = useQuery({
    queryKey: ["slot_offer", token],
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
  const o = q.data;

  if (booked || o.status === "booked")
    return (
      <Shell>
        <div className="text-center">
          <CheckCircle2 className="mx-auto size-8 text-primary" />
          <h1 className="mt-3 text-lg font-semibold">You are booked</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {o.roundLabel} for {o.jobTitle} with {o.orgName}
            {booked || o.bookedAt ? ` — ${fmt((booked ?? o.bookedAt)!)}` : ""}. Your invite, with a
            calendar file{o.mode === "online" ? " and the meeting link" : ""}, is on its way by
            email.
          </p>
        </div>
      </Shell>
    );
  if (declined || o.status === "declined")
    return (
      <Shell>
        <p className="text-center text-sm text-muted-foreground">
          Thanks — we have told the hiring team none of these times work. They will be in touch with
          other options.
        </p>
      </Shell>
    );
  if (o.status !== "offered" || !o.slots.length)
    return (
      <Shell>
        <p className="text-center text-sm text-muted-foreground">
          This link is no longer open. The hiring team at {o.orgName} will be in touch about your
          interview.
        </p>
      </Shell>
    );

  async function confirm() {
    if (!picked) return;
    setBusy(true);
    try {
      const r = await choose({ data: { token, slot: picked } });
      if (r.booked) setBooked(r.at);
      else {
        toast.error(r.reason);
        await q.refetch();
        setPicked(null);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not book this time");
    } finally {
      setBusy(false);
    }
  }
  async function noneWork() {
    setBusy(true);
    try {
      await decline({ data: { token, note: note.trim() } });
      setDeclined(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send this");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <CalendarCheck className="size-7 text-primary" />
      <h1 className="mt-3 text-xl font-semibold">Choose your interview time</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {o.roundLabel} for <strong>{o.jobTitle}</strong> with {o.orgName}
        {o.interviewerName ? ` (with ${o.interviewerName})` : ""} · {o.durationMins} minutes ·{" "}
        {o.mode}. Times are shown in your time zone.
      </p>
      <div className="mt-5 space-y-2" role="radiogroup" aria-label="Interview times">
        {o.slots.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={picked === s}
            onClick={() => setPicked(s)}
            className={`w-full rounded-md border px-3 py-2.5 text-left text-sm ${
              picked === s
                ? "border-primary bg-primary/5 font-medium"
                : "border-border hover:bg-muted"
            }`}
          >
            {fmt(s)}
            <span className="block text-xs text-muted-foreground">{fmt(s, o.timeZone)}</span>
          </button>
        ))}
      </div>
      <Button className="mt-4 w-full" disabled={!picked || busy} onClick={confirm}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        Confirm this time
      </Button>
      {noneOpen ? (
        <div className="mt-4 space-y-2">
          <Textarea
            rows={3}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional: when would suit you instead?"
          />
          <Button variant="outline" className="w-full" disabled={busy} onClick={noneWork}>
            Send to the hiring team
          </Button>
        </div>
      ) : (
        <button
          type="button"
          className="mt-3 w-full text-center text-xs text-muted-foreground underline"
          onClick={() => setNoneOpen(true)}
        >
          None of these times work
        </button>
      )}
    </Shell>
  );
}
