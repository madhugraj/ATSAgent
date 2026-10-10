import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { applicationsQuery, candidatesQuery, offersQuery, requisitionsQuery } from "@/lib/data";
import { advanceOffer, createOffer, sendBackOffer } from "@/lib/offers.functions";
import { EmptyState, PageHeader, StatusBadge, inr } from "@/components/ats";
import { OfferLetterDialog } from "@/components/OfferLetterDialog";
import { PreOnboardingDialog } from "@/components/PreOnboardingDialog";
import { listOnboardingReadiness } from "@/lib/onboarding.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/offers")({
  head: () => ({
    meta: [
      { title: "Offers & Approvals — ATS" },
      {
        name: "description",
        content:
          "Raise offers against the requisition budget, route them through HR and CBO approval and track acceptance to joining.",
      },
      { property: "og:title", content: "Offers & Approvals" },
      {
        property: "og:description",
        content:
          "Budget-checked offer creation with HR/CBO approval trail and acceptance tracking.",
      },
    ],
  }),
  component: Offers,
});

/** Offer approval chain, and the candidate stage each step implies. */
const FLOW: Record<string, { next: string; label: string; stage?: string }> = {
  draft: { next: "pending_hr", label: "Send to HR" },
  pending_hr: { next: "pending_cbo", label: "HR approve" },
  pending_cbo: { next: "approved", label: "CBO approve" },
  approved: { next: "released", label: "Release offer", stage: "offer_released" },
  released: { next: "accepted", label: "Mark accepted", stage: "offer_accepted" },
};

/** A candidate is offer-ready once the final round is cleared or HR pushed them to offer. */
const OFFER_READY = ["l3", "offer", "offer_pending"];

/** The letter lives with the offer from the moment it is raised; only closed offers hide it. */
const LETTER_HIDDEN = ["declined", "revoked"];

function Offers() {
  const qc = useQueryClient();
  const offers = useQuery(offersQuery);
  const apps = useQuery(applicationsQuery);
  const cands = useQuery(candidatesQuery);
  const reqs = useQuery(requisitionsQuery);

  const [appId, setAppId] = useState("");
  const [ctc, setCtc] = useState("");
  const [joining, setJoining] = useState("");
  const [letterOfferId, setLetterOfferId] = useState<string | null>(null);
  const [docsAppId, setDocsAppId] = useState<string | null>(null);
  const readiness = useQuery({
    queryKey: ["onboarding_readiness"],
    queryFn: () => listOnboardingReadiness(),
  });
  const letterOffer = (offers.data ?? []).find((o) => o.id === letterOfferId);

  const raisedFor = new Set((offers.data ?? []).map((o) => o.application_id));
  const offerStage = (apps.data ?? []).filter(
    (a) => OFFER_READY.includes(a.stage) && !raisedFor.has(a.id),
  );

  async function create() {
    if (!appId || !ctc) {
      toast.error("Pick a candidate and enter the offered CTC");
      return;
    }
    const app = (apps.data ?? []).find((a) => a.id === appId);
    const req = (reqs.data ?? []).find((r) => r.id === app?.requisition_id);
    if (req && Number(ctc) > Number(req.budget_ctc)) {
      toast.warning(
        "Offered CTC exceeds the approved requisition budget — CBO approval will be mandatory",
      );
    }
    try {
      await createOffer({
        data: { applicationId: appId, offeredCtc: ctc, joiningDate: joining || null },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not raise the offer");
      return;
    }
    setAppId("");
    setCtc("");
    setJoining("");
    toast.success("Offer raised and sent for HR approval");
    qc.invalidateQueries({ queryKey: ["offers"] });
    qc.invalidateQueries({ queryKey: ["applications"] });
  }

  async function sendBack(id: string) {
    const reason = window.prompt(
      "Why is this offer sent back? (the Offer agent and the team see this)",
    );
    if (!reason || reason.trim().length < 3) return;
    try {
      await sendBackOffer({ data: { id, reason: reason.trim() } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the offer back");
      return;
    }
    toast.success("Offer sent back to draft with your reason");
    qc.invalidateQueries({ queryKey: ["offers"] });
  }

  async function advance(id: string, status: string, trail: unknown) {
    const step = FLOW[status];
    if (!step) return;
    const next = [
      ...(Array.isArray(trail) ? (trail as unknown[]) : []),
      { from: status, to: step.next, at: new Date().toISOString() },
    ];
    try {
      await advanceOffer({
        data: {
          id,
          status: step.next,
          approvalTrail: next,
          applicationStage:
            step.stage === "offer_released" || step.stage === "offer_accepted"
              ? step.stage
              : undefined,
        },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the offer");
      return;
    }
    toast.success(`Offer moved to ${step.next.replace("_", " ")}`);
    qc.invalidateQueries({ queryKey: ["offers"] });
    qc.invalidateQueries({ queryKey: ["applications"] });
  }

  return (
    <>
      <PageHeader
        eyebrow="Closure"
        title="Offers"
        description="A candidate becomes offer-ready when the final interview round is recorded as a select (or you move them to offer manually). Raising the offer sets the candidate to Offer pending approval. The creator then opens Letter, picks the offer-letter template, generates and reviews the letter — an offer cannot go for approval until its letter exists. HR then CBO sign off against the requisition budget, releasing sets Offer released, and acceptance sets Offer accepted — joining is confirmed from the candidate's stage mover. Before release, collect the candidate's ID, experience letters, payslips and education certificate under Documents — the agent reads each one, HR validates it against the original, and release stays locked until every mandatory document is validated."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="panel lg:col-span-2">
          <div className="border-b border-border p-5">
            <h2 className="font-semibold">Offer register</h2>
          </div>
          {(offers.data ?? []).length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No offers yet"
                hint="Record a select verdict on the final interview round, or move a candidate to Offer pending — they then appear in the picker on the right."
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {(offers.data ?? []).map((o) => {
                const app = (apps.data ?? []).find((a) => a.id === o.application_id);
                const c = (cands.data ?? []).find((x) => x.id === app?.candidate_id);
                const r = (reqs.data ?? []).find((x) => x.id === app?.requisition_id);
                const step = FLOW[o.status];
                const overBudget = r ? Number(o.offered_ctc) > Number(r.budget_ctc) : false;
                const ready = (readiness.data ?? []).find(
                  (x) => x.applicationId === o.application_id,
                );
                const blocked = o.status === "approved" && !ready?.ready;
                return (
                  <li key={o.id} className="flex flex-wrap items-center gap-4 p-5">
                    <div className="min-w-0 flex-1">
                      {app ? (
                        <Link
                          to="/candidates/$id"
                          params={{ id: app.candidate_id }}
                          className="font-medium hover:underline"
                        >
                          {c?.full_name}
                        </Link>
                      ) : (
                        <span className="font-medium">Unknown candidate</span>
                      )}
                      <div className="text-xs text-muted-foreground">{r?.title}</div>
                      <div className="num mt-1 text-sm">
                        {inr(Number(o.offered_ctc))}
                        {overBudget ? (
                          <span className="ml-2 text-xs text-destructive">
                            above requisition budget
                          </span>
                        ) : null}
                        {o.joining_date ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            joins {new Date(o.joining_date).toLocaleDateString()}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <StatusBadge status={o.status} />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDocsAppId(o.application_id)}
                    >
                      Documents
                      {ready
                        ? ready.ready
                          ? " ✓"
                          : ` ${ready.verified}/${ready.verified + ready.missing.length}`
                        : ""}
                    </Button>
                    {!LETTER_HIDDEN.includes(o.status) || o.letter ? (
                      <Button size="sm" variant="outline" onClick={() => setLetterOfferId(o.id)}>
                        Letter{o.letter ? " ✓" : ""}
                      </Button>
                    ) : null}
                    {step ? (
                      <Button
                        size="sm"
                        disabled={blocked}
                        title={
                          blocked
                            ? "Pre-onboarding documents are not validated yet — open Documents."
                            : undefined
                        }
                        onClick={() => advance(o.id, o.status, o.approval_trail)}
                      >
                        {step.label}
                      </Button>
                    ) : null}
                    {o.status === "pending_hr" || o.status === "pending_cbo" ? (
                      <Button size="sm" variant="ghost" onClick={() => void sendBack(o.id)}>
                        Send back
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel p-5">
          <h2 className="font-semibold">Raise an offer</h2>
          <div className="mt-4 space-y-4">
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                Candidate at offer stage
              </Label>
              <Select value={appId} onValueChange={setAppId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select candidate" />
                </SelectTrigger>
                <SelectContent>
                  {offerStage.map((a) => {
                    const c = (cands.data ?? []).find((x) => x.id === a.candidate_id);
                    const r = (reqs.data ?? []).find((x) => x.id === a.requisition_id);
                    return (
                      <SelectItem key={a.id} value={a.id}>
                        {c?.full_name} — {r?.title ?? "Requisition"}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {offerStage.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Nobody is offer-ready. Record a select verdict on the final round in Interviews,
                  or use Move stage on the candidate to set Offer pending approval.
                </p>
              ) : null}
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Offered CTC (₹)</Label>
              <Input type="number" value={ctc} onChange={(e) => setCtc(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Joining date</Label>
              <Input type="date" value={joining} onChange={(e) => setJoining(e.target.value)} />
            </div>
            <Button className="w-full" onClick={create}>
              Raise offer
            </Button>
          </div>
        </section>
      </div>

      {docsAppId
        ? (() => {
            const app = (apps.data ?? []).find((a) => a.id === docsAppId);
            const c = (cands.data ?? []).find((x) => x.id === app?.candidate_id);
            const r = (reqs.data ?? []).find((x) => x.id === app?.requisition_id);
            return (
              <PreOnboardingDialog
                applicationId={docsAppId}
                candidateName={c?.full_name ?? "Candidate"}
                roleTitle={r?.title ?? "Requisition"}
                open
                onOpenChange={(v) => {
                  if (!v) setDocsAppId(null);
                }}
              />
            );
          })()
        : null}

      {letterOffer ? (
        <OfferLetterDialog
          offer={letterOffer}
          candidateName={
            (cands.data ?? []).find(
              (x) =>
                x.id ===
                (apps.data ?? []).find((a) => a.id === letterOffer.application_id)?.candidate_id,
            )?.full_name ?? "Candidate"
          }
          open
          onOpenChange={(v) => {
            if (!v) setLetterOfferId(null);
          }}
        />
      ) : null}
    </>
  );
}
