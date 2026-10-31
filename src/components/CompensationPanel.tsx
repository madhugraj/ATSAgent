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
import {
  arrangeNegotiationCall,
  getNegotiation,
  recordNegotiationCall,
} from "@/lib/negotiation.functions";
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

/** Where the latest AI pay call stands, in plain words. */
function aiCallLine(
  c: { status: string; endReason: string | null; dueAt: string | null },
  settled: boolean,
) {
  const when = c.dueAt
    ? new Date(c.dueAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
    : null;
  if (["requested", "approved", "callback", "no_answer", "failed"].includes(c.status))
    return `Arranged${when ? ` — next try ${when}` : ""}`;
  if (c.status === "dialling" || c.status === "in_progress") return "On the line now";
  const said: Record<string, string> = {
    verbal_agreement: settled ? "Done — they said yes" : "Done — they said yes; confirm it below",
    handed_off: "Done — they want the team to come back to them",
    declined: "Done — they did not want to discuss pay on the call",
    not_now: "Done — not a good time for them",
    opt_out: "Done — they asked not to get AI calls",
    wrong_person: "Reached someone else",
    already_settled: "Not needed — settled before the call",
  };
  return said[c.endReason ?? ""] ?? "Could not reach them";
}

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
  const [arranging, setArranging] = useState(false);
  const save = useServerFn(recordNegotiationCall);
  const [confirming, setConfirming] = useState(false);
  const n = q.data;
  if (!n) return null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["negotiation", applicationId] });
    void qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const heard = n.callOutcome;
  const aiCallPending =
    !!n.aiCall &&
    [
      "requested",
      "approved",
      "callback",
      "no_answer",
      "failed",
      "dialling",
      "in_progress",
    ].includes(n.aiCall.status);
  async function confirmHeard() {
    if (!heard?.agreed || heard.agreedCtc == null) return;
    setConfirming(true);
    try {
      await save({
        data: {
          negotiationId: n!.id,
          outcome: {
            agreed: true,
            agreedCtc: heard.agreedCtc,
            joiningBonus: n!.levers?.joiningBonus ?? null,
            note: `Confirmed from the AI pay call: "${heard.theirWords}"`.slice(0, 1000),
          },
        },
      });
      toast.success("Confirmed — the Offer agent drafts at it.");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not confirm");
    } finally {
      setConfirming(false);
    }
  }
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
        {n.aiCall ? (
          <>
            <dt className="text-muted-foreground">AI pay call</dt>
            <dd>
              {aiCallLine(n.aiCall, !canRecord)}
              {n.callStepCtc != null ? ` · may move once to ${lpa(n.callStepCtc)}` : ""}
            </dd>
          </>
        ) : null}
        {heard && canRecord ? (
          <>
            <dt className="text-muted-foreground">Heard on the call</dt>
            <dd>
              {heard.agreed
                ? `Yes to ${lpa(heard.agreedCtc)} (${heard.which === "improved" ? "the improved figure" : "the proposal"})`
                : "No yes yet"}
              {` — "${heard.theirWords}"`}
            </dd>
            {heard.notes ? (
              <>
                <dt className="text-muted-foreground">How they feel</dt>
                <dd>
                  {heard.notes.feeling === "positive"
                    ? "Positive"
                    : heard.notes.feeling === "mixed"
                      ? "Mixed"
                      : "Negative"}
                  {` — matters most: ${heard.notes.priorities}; holding back: ${heard.notes.concerns}`}
                </dd>
                <dt className="text-muted-foreground">Call summary</dt>
                <dd>{heard.notes.summary}</dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      {heard?.agreed && canRecord ? (
        <p className="mt-2 rounded border border-primary/40 bg-background p-2">
          The assistant only passes a yes on — nothing is agreed until you confirm it.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {heard?.agreed && heard.agreedCtc != null && canRecord ? (
          <Button
            size="sm"
            className="h-7"
            disabled={confirming}
            onClick={() => void confirmHeard()}
          >
            Confirm {lpa(heard.agreedCtc)}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => setBriefOpen(!briefOpen)}
        >
          {briefOpen ? "Hide the call brief" : "Call brief"}
        </Button>
        {canRecord ? (
          <Button
            size="sm"
            variant={heard?.agreed ? "outline" : "default"}
            className="h-7"
            onClick={() => setRecording(true)}
          >
            {heard?.agreed ? "Record differently" : "Record the call"}
          </Button>
        ) : null}
        {canRecord ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={!!n.aiCallBlocked}
            title={n.aiCallBlocked ?? undefined}
            onClick={() => setArranging(true)}
          >
            Call to negotiate
          </Button>
        ) : null}
      </div>
      {canRecord && n.aiCallBlocked && !aiCallPending ? (
        <p className="mt-1 text-muted-foreground">AI pay call: {n.aiCallBlocked}</p>
      ) : null}
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
          applicationId={applicationId}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            refresh();
          }}
        />
      ) : null}
      {arranging ? (
        <ArrangeCallDialog
          negotiationId={n.id}
          proposedCtc={n.proposedCtc}
          ceiling={n.ceiling}
          onClose={() => setArranging(false)}
          onDone={() => {
            setArranging(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** Arrange the AI pay call: the proposal, and at most one improved figure (≤ the ceiling). */
function ArrangeCallDialog({
  negotiationId,
  proposedCtc,
  ceiling,
  onClose,
  onDone,
}: {
  negotiationId: string;
  proposedCtc: number;
  ceiling: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const arrange = useServerFn(arrangeNegotiationCall);
  const [step, setStep] = useState("");
  const [busy, setBusy] = useState(false);
  // What the call may explain, and why the team wants them (the negotiator's material).
  const [d, setD] = useState({
    fixed: "",
    variable: "",
    esop: "",
    esopValue: "",
    review: "",
    benefits: "",
    rationale: "",
    whyYou: "",
  });
  const setF = (k: keyof typeof d) => (e: { target: { value: string } }) =>
    setD((p) => ({ ...p, [k]: e.target.value }));
  const stepRupees = lakhsToRupees(step);
  const fixed = lakhsToRupees(d.fixed);
  const variable = lakhsToRupees(d.variable);
  const esopValue = lakhsToRupees(d.esopValue);
  const whyYou = d.whyYou
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const detailProblem = [fixed, variable, esopValue].some((x) => x != null && Number.isNaN(x))
    ? "Amounts are lakhs per annum, e.g. 42."
    : (fixed == null) !== (variable == null)
      ? "Give both the fixed and the variable part, or neither."
      : fixed != null && variable != null && Math.abs(fixed + variable - proposedCtc) > 1
        ? `Fixed and variable must add up to the proposal (${lpa(proposedCtc)}).`
        : whyYou.length > 3
          ? "At most three reasons."
          : null;
  const stepProblem =
    stepRupees == null
      ? null
      : Number.isNaN(stepRupees)
        ? "Lakhs per annum, e.g. 19.5."
        : stepRupees <= proposedCtc
          ? `Above the proposal (${lpa(proposedCtc)}), or leave it empty to hold.`
          : stepRupees > ceiling
            ? `At or under the approved ceiling (${lpa(ceiling)}).`
            : null;
  const problem = stepProblem ?? detailProblem;
  async function submit() {
    setBusy(true);
    try {
      const brief = {
        fixedCtc: fixed ?? null,
        variableCtc: variable ?? null,
        esop: d.esop.trim() || null,
        esopValue: esopValue ?? null,
        review: d.review.trim() || null,
        benefits: d.benefits.trim() || null,
        rationale: d.rationale.trim() || null,
        whyYou,
      };
      const r = await arrange({ data: { negotiationId, improvedCtc: stepRupees ?? null, brief } });
      toast.success(
        `Pay call arranged — first try ${new Date(r.dueAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}.`,
      );
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not arrange the call");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Call to negotiate</DialogTitle>
          <DialogDescription>
            The AI assistant phones the candidate in calling hours, says it is an AI, and reads out
            the proposal ({lpa(proposedCtc)}) with its extras. It never says the ceiling and never
            agrees anything — a yes comes back here for you to confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="neg-step">If they say no, it may offer once (₹ L, optional)</Label>
          <Input
            id="neg-step"
            inputMode="decimal"
            placeholder={`Between ${lpa(proposedCtc)} and ${lpa(ceiling)} — empty to hold`}
            value={step}
            onChange={(e) => setStep(e.target.value)}
          />
          {stepProblem ? <p className="text-xs text-destructive">{stepProblem}</p> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          What the assistant may explain if they ask — and why the team wants them. It says only
          what you write here; empty means "the hiring team will share it".
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="neg-fixed">Fixed (₹ L)</Label>
            <Input id="neg-fixed" inputMode="decimal" value={d.fixed} onChange={setF("fixed")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="neg-variable">Variable (₹ L)</Label>
            <Input
              id="neg-variable"
              inputMode="decimal"
              value={d.variable}
              onChange={setF("variable")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="neg-esop">ESOPs (in words)</Label>
            <Input
              id="neg-esop"
              maxLength={300}
              placeholder="e.g. ESOPs vesting over four years"
              value={d.esop}
              onChange={setF("esop")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="neg-esop-value">ESOP value (₹ L, optional)</Label>
            <Input
              id="neg-esop-value"
              inputMode="decimal"
              value={d.esopValue}
              onChange={setF("esopValue")}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="neg-review">How the pay review works</Label>
          <Input
            id="neg-review"
            maxLength={300}
            placeholder="e.g. A review at six months, then every April with the company"
            value={d.review}
            onChange={setF("review")}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="neg-benefits">Benefits</Label>
          <Input
            id="neg-benefits"
            maxLength={300}
            placeholder="e.g. Family health cover, a learning budget, hybrid work"
            value={d.benefits}
            onChange={setF("benefits")}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="neg-rationale">How the figure was set</Label>
          <Input
            id="neg-rationale"
            maxLength={300}
            placeholder="e.g. Set against the role's level and internal parity, benchmarked on market data"
            value={d.rationale}
            onChange={setF("rationale")}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="neg-why">
            What the panel valued — said as appreciation (up to three lines, no scores or names)
          </Label>
          <Textarea
            id="neg-why"
            rows={3}
            placeholder={"e.g. The panel valued how you built and scaled an AI team"}
            value={d.whyYou}
            onChange={setF("whyYou")}
          />
        </div>
        {detailProblem ? <p className="text-xs text-destructive">{detailProblem}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !!problem}>
            Arrange the call
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What was agreed on a call — or that nothing was. Used on the candidate page and in the pop-up. */
export function NegotiationOutcomeDialog({
  negotiationId,
  ceiling,
  applicationId,
  onClose,
  onSaved,
}: {
  negotiationId: string;
  ceiling: number | null;
  /** When given, what an AI pay call heard pre-fills the form. */
  applicationId?: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const save = useServerFn(recordNegotiationCall);
  const load = useServerFn(getNegotiation);
  const known = useQuery({
    queryKey: ["negotiation", applicationId],
    queryFn: () => load({ data: { applicationId: applicationId! } }),
    enabled: !!applicationId,
  });
  const heard = known.data?.id === negotiationId ? known.data.callOutcome : null;
  const [agreed, setAgreed] = useState(true);
  const [f, setF] = useState({ agreedCtc: "", joiningBonus: "", joiningDate: "", note: "" });
  const [prefilled, setPrefilled] = useState(false);
  if (heard?.agreed && heard.agreedCtc != null && !prefilled) {
    setPrefilled(true);
    setF((p) => ({
      ...p,
      agreedCtc: p.agreedCtc || String(heard.agreedCtc! / 100_000),
      // The extras were read out with the figure, so the yes covers them too.
      joiningBonus:
        p.joiningBonus ||
        (known.data?.levers?.joiningBonus ? String(known.data.levers.joiningBonus / 100_000) : ""),
      note: p.note || `Heard on the AI pay call: "${heard.theirWords}"`.slice(0, 1000),
    }));
  }
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
