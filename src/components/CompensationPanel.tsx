import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  getCandidateCompensation,
  recordCandidateCompensation,
  sendCandidateCompensationForm,
} from "@/lib/compensation.functions";
import { getNegotiation, recordNegotiationCall } from "@/lib/negotiation.functions";
import { lakhsToRupees } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const lpa = (n: number | null) =>
  n == null ? "—" : `₹${(n / 100_000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;

const SOURCE: Record<string, string> = {
  candidate_form: "the candidate's form",
  screening_call: "a screening call",
  recruiter: "TA",
  candidate_profile: "the candidate profile",
};

type AppPay = Extract<
  Awaited<ReturnType<typeof getCandidateCompensation>>,
  { allowed: true }
>["applications"][number];

/**
 * Pay & availability for TA, HR head, CBO and owners. The server returns
 * nothing to anyone else, and this panel then renders nothing.
 */
export function CompensationPanel({ candidateId }: { candidateId: string }) {
  const load = useServerFn(getCandidateCompensation);
  const q = useQuery({
    queryKey: ["compensation", candidateId],
    queryFn: () => load({ data: { candidateId } }),
  });
  if (!q.data?.allowed || q.data.applications.length === 0) return null;
  return (
    <section className="panel p-5">
      <h2 className="flex items-center gap-1.5 font-semibold">
        <Lock className="size-4 text-muted-foreground" /> Pay &amp; availability
      </h2>
      <p className="text-xs text-muted-foreground">
        Visible to TA, the HR head and the CBO only. Offers are drafted from this — never without
        the expected CTC and notice period.
      </p>
      <div className="mt-3 space-y-4">
        {q.data.applications.map((a) => (
          <AppPayRow key={a.applicationId} a={a} candidateId={candidateId} />
        ))}
      </div>
    </section>
  );
}

function AppPayRow({ a, candidateId }: { a: AppPay; candidateId: string }) {
  const qc = useQueryClient();
  const send = useServerFn(sendCandidateCompensationForm);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const d = a.details;
  const open = a.request?.status === "sent";
  const refresh = () => qc.invalidateQueries({ queryKey: ["compensation", candidateId] });

  async function act(
    data: { action: "send"; applicationId: string } | { action: "remind"; requestId: string },
    ok: string,
  ) {
    setBusy(true);
    try {
      await send({ data });
      toast.success(ok);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }

  const rows: [string, string][] = [
    [
      "Current CTC",
      d.currentFixed != null || d.currentVariable != null
        ? `${lpa(d.currentTotal)} (fixed ${lpa(d.currentFixed)} + variable ${lpa(d.currentVariable)})`
        : lpa(d.currentTotal),
    ],
    ["Expected CTC", lpa(d.expectedCtc)],
    ["Notice period", d.noticePeriodDays != null ? `${d.noticePeriodDays} days` : "—"],
    ["Earliest joining", d.earliestJoining ?? "—"],
    [
      "Other offers",
      d.competingOffers == null
        ? "—"
        : d.competingOffers
          ? `Yes${d.competingNote ? ` — ${d.competingNote}` : ""}`
          : "No",
    ],
    [
      "Location",
      `${d.currentLocation ?? "—"}${d.openToRelocate == null ? "" : d.openToRelocate ? " · open to relocate" : " · not relocating"}`,
    ],
  ];

  return (
    <div className="rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{a.title}</span>
        <span className={d.complete ? "text-xs text-primary" : "text-xs text-amber-600"}>
          {d.complete ? "Ready for an offer" : "Expected CTC / notice missing"}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="num break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {d.note ? <p className="mt-2 text-xs">Note: {d.note}</p> : null}
      <p className="mt-2 text-xs text-muted-foreground">
        {d.source ? `From ${SOURCE[d.source] ?? d.source}` : "Nothing recorded yet"}
        {a.request
          ? ` · Form ${a.request.status === "sent" ? `sent ${a.request.sentOn}, due ${a.request.due ?? "—"}${a.request.remindersSent ? `, ${a.request.remindersSent} reminder(s)` : ""}` : a.request.status === "completed" ? `answered ${a.request.completedOn ?? ""}` : a.request.status}`
          : ""}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {a.canAsk && !open && !d.complete ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(
                { action: "send", applicationId: a.applicationId },
                "Form sent to the candidate.",
              )
            }
          >
            Send the form
          </Button>
        ) : null}
        {open && a.request ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act({ action: "remind", requestId: a.request!.id }, "Reminder sent.")
            }
          >
            Send a reminder
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          {d.complete ? "Correct details" : "Enter from a call"}
        </Button>
      </div>
      <NegotiationSection applicationId={a.applicationId} />
      {editing ? (
        <EntryDialog
          applicationId={a.applicationId}
          title={a.title}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function EntryDialog({
  applicationId,
  title,
  onClose,
  onSaved,
}: {
  applicationId: string;
  title: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const save = useServerFn(recordCandidateCompensation);
  const [f, setF] = useState({
    currentFixed: "",
    currentVariable: "",
    expectedCtc: "",
    noticePeriodDays: "",
    earliestJoining: "",
    currentLocation: "",
    note: "",
    competingOffers: false,
    fromCall: true,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit() {
    const fixed = lakhsToRupees(f.currentFixed);
    const variable = lakhsToRupees(f.currentVariable);
    const expected = lakhsToRupees(f.expectedCtc);
    const notice = f.noticePeriodDays.trim() === "" ? null : Number(f.noticePeriodDays);
    if ([fixed, variable, expected, notice].some((x) => x != null && Number.isNaN(x))) {
      toast.error("Amounts are lakhs per annum (e.g. 18.5); notice is whole days.");
      return;
    }
    setBusy(true);
    try {
      await save({
        data: {
          applicationId,
          source: f.fromCall ? "screening_call" : "recruiter",
          details: {
            currentFixed: fixed,
            currentVariable: variable,
            expectedCtc: expected,
            noticePeriodDays: notice,
            earliestJoining: f.earliestJoining || null,
            currentLocation: f.currentLocation.trim() || null,
            competingOffers: f.competingOffers ? true : null,
            note: f.note.trim() || null,
          },
        },
      });
      toast.success("Saved.");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pay &amp; availability — {title}</DialogTitle>
          <DialogDescription>
            Lakhs per annum. Leave blank what you did not ask; blanks keep what is already on
            record.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ["currentFixed", "Current fixed (₹ L)"],
              ["currentVariable", "Current variable (₹ L)"],
              ["expectedCtc", "Expected CTC (₹ L)"],
              ["noticePeriodDays", "Notice period (days)"],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="space-y-1">
              <Label htmlFor={`pay-${k}`}>{label}</Label>
              <Input id={`pay-${k}`} inputMode="decimal" value={f[k]} onChange={set(k)} />
            </div>
          ))}
          <div className="space-y-1">
            <Label htmlFor="pay-joining">Earliest joining</Label>
            <Input
              id="pay-joining"
              type="date"
              value={f.earliestJoining}
              onChange={set("earliestJoining")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pay-loc">Location</Label>
            <Input
              id="pay-loc"
              maxLength={120}
              value={f.currentLocation}
              onChange={set("currentLocation")}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={f.competingOffers}
            onCheckedChange={(v) => setF((p) => ({ ...p, competingOffers: v === true }))}
          />
          Has other offers in hand
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={f.fromCall}
            onCheckedChange={(v) => setF((p) => ({ ...p, fromCall: v === true }))}
          />
          From the screening call
        </label>
        <Textarea
          rows={2}
          maxLength={1000}
          placeholder="Note (optional)"
          value={f.note}
          onChange={set("note")}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------ pay discussion */

const NEGOTIATION_LABEL: Record<string, string> = {
  open: "Prepared — the HR head approves the message; you may call instead",
  message_sent: "Message sent — waiting for the candidate",
  countered: "The candidate suggested another figure",
  call_requested: "The candidate asked for a call",
  agreed: "Agreed",
  no_agreement: "No agreement",
  expired: "No answer — the link closed",
  cancelled: "Cancelled",
};

/** The pay discussion for one application: the call brief, the answer, the outcome. */
export function NegotiationSection({ applicationId }: { applicationId: string }) {
  const load = useServerFn(getNegotiation);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["negotiation", applicationId],
    queryFn: () => load({ data: { applicationId } }),
  });
  const [briefOpen, setBriefOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const n = q.data;
  if (!n) return null;
  const canRecord = ["open", "message_sent", "countered", "call_requested", "expired"].includes(
    n.status,
  );
  return (
    <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-xs">
      <p className="font-semibold">Pay discussion · {NEGOTIATION_LABEL[n.status] ?? n.status}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">They expect</dt>
        <dd className="num">{lpa(n.expectedCtc)}</dd>
        <dt className="text-muted-foreground">Ceiling</dt>
        <dd className="num">
          {lpa(n.ceiling)} (approved by{" "}
          {n.ceilingApprovedBy === "president_cbo" ? "the CBO" : "the HR head"})
        </dd>
        <dt className="text-muted-foreground">Proposed</dt>
        <dd className="num">
          {lpa(n.proposedCtc)}
          {n.levers?.joiningBonus ? ` + ${lpa(n.levers.joiningBonus)} joining bonus` : ""}
          {n.levers?.reviewMonths ? ` · review after ${n.levers.reviewMonths} months` : ""}
        </dd>
        {n.answer ? (
          <>
            <dt className="text-muted-foreground">Their answer</dt>
            <dd>
              {n.answer.decision === "accept"
                ? "Accepted"
                : n.answer.decision === "propose"
                  ? `Suggests ${lpa(n.answer.amount ?? null)}`
                  : "Asked for a call"}
              {n.answer.note ? ` — "${n.answer.note}"` : ""}
            </dd>
          </>
        ) : null}
        {n.outcome ? (
          <>
            <dt className="text-muted-foreground">Outcome</dt>
            <dd>
              {n.outcome.agreedCtc != null ? `Agreed ${lpa(n.outcome.agreedCtc)}` : "No agreement"}
              {n.outcome.joiningBonus ? ` + ${lpa(n.outcome.joiningBonus)} joining bonus` : ""}
              {n.outcome.note ? ` — ${n.outcome.note}` : ""}
              {n.outcome.by ? ` (${n.outcome.by})` : ""}
            </dd>
          </>
        ) : null}
      </dl>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => setBriefOpen(!briefOpen)}
        >
          {briefOpen ? "Hide the call brief" : "Call brief"}
        </Button>
        {canRecord ? (
          <Button size="sm" className="h-7" onClick={() => setRecording(true)}>
            Record the call
          </Button>
        ) : null}
      </div>
      {briefOpen ? (
        <div className="mt-2 space-y-2 rounded border border-border bg-background p-2">
          <p className="whitespace-pre-wrap">{n.talkTrack}</p>
          {n.message ? (
            <>
              <p className="font-medium">The message to the candidate</p>
              <p className="whitespace-pre-wrap text-muted-foreground">{n.message}</p>
            </>
          ) : null}
        </div>
      ) : null}
      {recording ? (
        <NegotiationOutcomeDialog
          negotiationId={n.id}
          ceiling={n.ceiling}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            void qc.invalidateQueries({ queryKey: ["negotiation", applicationId] });
            void qc.invalidateQueries({ queryKey: ["notifications"] });
          }}
        />
      ) : null}
    </div>
  );
}

/** What was agreed on a call — or that nothing was. Used on the candidate page and in the pop-up. */
export function NegotiationOutcomeDialog({
  negotiationId,
  ceiling,
  onClose,
  onSaved,
}: {
  negotiationId: string;
  ceiling: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const save = useServerFn(recordNegotiationCall);
  const [agreed, setAgreed] = useState(true);
  const [f, setF] = useState({ agreedCtc: "", joiningBonus: "", joiningDate: "", note: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  async function submit() {
    setBusy(true);
    try {
      const ctc = lakhsToRupees(f.agreedCtc);
      const bonus = lakhsToRupees(f.joiningBonus);
      if (agreed && (ctc == null || Number.isNaN(ctc) || (bonus != null && Number.isNaN(bonus))))
        throw new Error("Amounts are lakhs per annum, e.g. 110.");
      await save({
        data: {
          negotiationId,
          outcome: agreed
            ? {
                agreed: true,
                agreedCtc: ctc,
                joiningBonus: bonus,
                joiningDate: f.joiningDate || null,
                note: f.note.trim() || undefined,
              }
            : { agreed: false, note: f.note.trim() },
        },
      });
      toast.success("Recorded.");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record the pay call</DialogTitle>
          <DialogDescription>
            {ceiling != null ? `The approved ceiling is ${lpa(ceiling)}. ` : ""}An agreed figure
            starts the Offer agent; it drafts at it for HR head and CBO approval.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={agreed} onChange={() => setAgreed(true)} /> We agreed a
            figure
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={!agreed} onChange={() => setAgreed(false)} /> No agreement
          </label>
        </div>
        {agreed ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="neg-ctc">Agreed CTC (₹ L)</Label>
              <Input
                id="neg-ctc"
                inputMode="decimal"
                value={f.agreedCtc}
                onChange={set("agreedCtc")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="neg-bonus">Joining bonus (₹ L)</Label>
              <Input
                id="neg-bonus"
                inputMode="decimal"
                value={f.joiningBonus}
                onChange={set("joiningBonus")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="neg-date">Joining date</Label>
              <Input
                id="neg-date"
                type="date"
                value={f.joiningDate}
                onChange={set("joiningDate")}
              />
            </div>
          </div>
        ) : null}
        <Textarea
          rows={2}
          maxLength={1000}
          placeholder={agreed ? "Notes (optional)" : "Why no figure was agreed (required)"}
          value={f.note}
          onChange={set("note")}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || (agreed ? !f.agreedCtc.trim() : f.note.trim().length < 3)}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
