import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Lock } from "lucide-react";

import { getCompensationForm, submitCompensationForm } from "@/lib/compensation.functions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { lakhsToRupees } from "@/lib/money";

export const Route = createFileRoute("/pay/$token")({
  head: () => ({
    meta: [
      { title: "Your pay and availability" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: PayPage,
});

function PayPage() {
  const { token } = Route.useParams();
  const load = useServerFn(getCompensationForm);
  const submit = useServerFn(submitCompensationForm);
  const q = useQuery({
    queryKey: ["pay-form", token],
    queryFn: () => load({ data: { token } }),
    retry: false,
  });
  const [f, setF] = useState({
    currentFixed: "",
    currentVariable: "",
    expectedCtc: "",
    noticePeriodDays: "",
    earliestJoining: "",
    competingOffers: false,
    competingNote: "",
    currentLocation: "",
    openToRelocate: false,
    note: "",
    consent: false,
  });
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

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

  const data = q.data!;
  if (done || data.status === "completed")
    return (
      <main className="mx-auto grid min-h-screen max-w-lg place-items-center px-6">
        <div className="panel p-8 text-center">
          <CheckCircle2 className="mx-auto size-8 text-primary" />
          <h1 className="mt-3 text-lg font-semibold">Thank you</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your details are with the HR team at {data.orgName}. Someone will be in touch about the
            next step.
          </p>
        </div>
      </main>
    );

  const fixed = lakhsToRupees(f.currentFixed);
  const variable = lakhsToRupees(f.currentVariable);
  const expected = lakhsToRupees(f.expectedCtc);
  const notice = f.noticePeriodDays.trim() === "" ? null : Number(f.noticePeriodDays);
  const bad = (x: number | null) => x != null && Number.isNaN(x);
  const ready =
    expected != null &&
    !bad(expected) &&
    expected > 0 &&
    !bad(fixed) &&
    !bad(variable) &&
    notice != null &&
    Number.isInteger(notice) &&
    notice >= 0 &&
    notice <= 365 &&
    f.consent;

  async function send() {
    setSending(true);
    try {
      await submit({
        data: {
          token,
          answers: {
            currentFixed: fixed,
            currentVariable: variable,
            expectedCtc: expected,
            noticePeriodDays: notice,
            earliestJoining: f.earliestJoining || null,
            competingOffers: f.competingOffers,
            competingNote: f.competingOffers ? f.competingNote.trim() || null : null,
            currentLocation: f.currentLocation.trim() || null,
            openToRelocate: f.openToRelocate,
            note: f.note.trim() || null,
            consent: true,
          },
        },
      });
      setDone(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send your details");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-xl font-semibold">Your pay and availability</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {data.candidateName ? `Hi ${data.candidateName}. ` : ""}
        For <strong>{data.jobTitle}</strong> at <strong>{data.orgName}</strong>. It takes about two
        minutes{data.due ? ` — please send it by ${data.due}` : ""}.
      </p>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="size-3.5" /> Only the HR team sees your answers. Amounts are in lakhs per
        annum (₹ LPA), e.g. 18.5.
      </p>

      <div className="panel mt-6 space-y-5 p-5">
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Current pay (per year)</legend>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="fixed">Fixed (₹ LPA)</Label>
              <Input
                id="fixed"
                inputMode="decimal"
                value={f.currentFixed}
                onChange={set("currentFixed")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="variable">Variable / bonus (₹ LPA)</Label>
              <Input
                id="variable"
                inputMode="decimal"
                value={f.currentVariable}
                onChange={set("currentVariable")}
              />
            </div>
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="expected">Expected CTC (₹ LPA) *</Label>
            <Input
              id="expected"
              inputMode="decimal"
              value={f.expectedCtc}
              onChange={set("expectedCtc")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="notice">Notice period (days) *</Label>
            <Input
              id="notice"
              inputMode="numeric"
              value={f.noticePeriodDays}
              onChange={set("noticePeriodDays")}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="joining">Earliest you could join</Label>
            <Input
              id="joining"
              type="date"
              value={f.earliestJoining}
              onChange={set("earliestJoining")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="location">Where you are based</Label>
            <Input
              id="location"
              maxLength={120}
              value={f.currentLocation}
              onChange={set("currentLocation")}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={f.openToRelocate}
            onCheckedChange={(v) => setF((p) => ({ ...p, openToRelocate: v === true }))}
          />
          I am open to relocating for this role
        </label>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={f.competingOffers}
              onCheckedChange={(v) => setF((p) => ({ ...p, competingOffers: v === true }))}
            />
            I have other offers in hand
          </label>
          {f.competingOffers ? (
            <Textarea
              rows={2}
              maxLength={500}
              placeholder="Optional: anything you'd like us to know (e.g. a decision date)"
              value={f.competingNote}
              onChange={set("competingNote")}
            />
          ) : null}
        </div>

        <div className="space-y-1">
          <Label htmlFor="note">Anything else (optional)</Label>
          <Textarea id="note" rows={2} maxLength={1000} value={f.note} onChange={set("note")} />
        </div>

        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={f.consent}
            onCheckedChange={(v) => setF((p) => ({ ...p, consent: v === true }))}
          />
          <span>
            I agree that {data.orgName}&apos;s HR team may use these details to prepare an offer for
            this role. *
          </span>
        </label>

        <Button className="w-full" disabled={!ready || sending} onClick={() => void send()}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : null} Send my details
        </Button>
      </div>
    </main>
  );
}
