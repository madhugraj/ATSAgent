import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Phone } from "lucide-react";

import { getPhoneScreening } from "@/lib/phone-screening.functions";
import {
  callCandidateNow,
  cancelScreeningCall,
  listScreeningCalls,
} from "@/lib/screening-calls.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Call = Awaited<ReturnType<typeof listScreeningCalls>>[number];

const when = (iso: string | Date | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

/** What a call's state means, in plain words. */
function describe(c: Call): {
  label: string;
  tone: "default" | "secondary" | "outline" | "destructive";
} {
  switch (c.status) {
    case "requested":
    case "approved":
      return { label: `Arranged — first try ${when(c.dueAt)}`, tone: "secondary" };
    case "dialling":
    case "in_progress":
      return { label: "On the call now", tone: "default" };
    case "completed":
      return c.endReason === "not_interested"
        ? { label: "Not interested in the role", tone: "outline" }
        : { label: "Screened by phone", tone: "default" };
    case "callback":
      return { label: `Booked with them for ${when(c.dueAt)}`, tone: "secondary" };
    case "no_answer":
      return { label: `Not answered — trying again ${when(c.dueAt)}`, tone: "outline" };
    case "failed":
      return { label: `Could not connect — trying again ${when(c.dueAt)}`, tone: "outline" };
    case "consent_declined":
      return { label: "Declined the call — nothing kept", tone: "outline" };
    case "fell_back":
      return {
        label:
          c.endReason === "prefers_human"
            ? "Asked for a person to call them"
            : c.endReason === "prefers_written"
              ? "Chose the written assessment"
              : "Could not be reached — written assessment instead",
        tone: "outline",
      };
    case "cancelled":
      return { label: "Cancelled", tone: "outline" };
  }
  return { label: c.status, tone: "outline" };
}

const DETAIL_LABEL: Record<string, string> = {
  currentTitle: "Current role",
  currentCompany: "Company",
  totalExperienceYears: "Experience (years)",
  currentLocation: "Lives in",
  openToRelocate: "Open to relocating",
  noticePeriodDays: "Notice (days)",
  earliestJoining: "Earliest joining",
  note: "They said",
};

const WAITING = new Set(["requested", "approved", "callback", "no_answer", "failed"]);

/** AI phone screening for one candidate and role: state, Call now, answers and transcript. */
export function PhoneScreeningCalls(props: {
  candidateId: string;
  requisitionId: string;
  hasKit: boolean;
}) {
  const qc = useQueryClient();
  const callNow = useServerFn(callCandidateNow);
  const cancel = useServerFn(cancelScreeningCall);
  const ready = useQuery({ queryKey: ["phone_screening"], queryFn: () => getPhoneScreening() });
  const calls = useQuery({
    queryKey: ["screening_calls", props.candidateId],
    queryFn: () => listScreeningCalls({ data: { candidateId: props.candidateId } }),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((c) => c.status === "dialling" || c.status === "in_progress")
        ? 5_000
        : false,
  });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const forRole = (calls.data ?? []).filter((c) => c.requisitionId === props.requisitionId);
  const latest = forRole[0] ?? null;
  const readiness = ready.data?.readiness;
  if (!readiness?.enabled && !forRole.length) return null;

  const canCall =
    readiness?.ready &&
    props.hasKit &&
    (!latest || latest.status === "cancelled" || latest.status === "fell_back");

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await action();
      toast.success(done);
      await qc.invalidateQueries({ queryKey: ["screening_calls", props.candidateId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Phone className="size-4" /> AI phone screening
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {latest ? <Badge variant={describe(latest).tone}>{describe(latest).label}</Badge> : null}
          {latest && WAITING.has(latest.status) ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(() => cancel({ data: { callId: latest.id } }), "Call cancelled.")
              }
            >
              Cancel call
            </Button>
          ) : null}
          {canCall ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    callNow({
                      data: { candidateId: props.candidateId, requisitionId: props.requisitionId },
                    }),
                  "Call arranged — it will be placed in your calling hours.",
                )
              }
            >
              Call now
            </Button>
          ) : null}
        </div>
      </div>
      {readiness && !readiness.ready ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Calls can't be placed yet —{" "}
          {!readiness.enabled
            ? "phone screening is switched off (Organisation page)"
            : !readiness.voice
              ? "add an AI voice key (Integrations → AI model)"
              : "this deployment has no phone line yet"}
          .
        </p>
      ) : !props.hasKit && !latest ? (
        <p className="mt-1 text-xs text-muted-foreground">Prepare the questions first.</p>
      ) : null}

      {forRole.map((c) => {
        const expanded = open === c.id;
        const details = Object.entries(c.details ?? {});
        const hasDetail = c.answers.length > 0 || c.transcript.length > 0 || details.length > 0;
        return (
          <div key={c.id} className="mt-2 border-t pt-2 text-xs">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-left"
              onClick={() => setOpen(expanded ? null : c.id)}
              disabled={!hasDetail}
            >
              <span className="text-muted-foreground">
                {describe(c).label}
                {c.phoneLast4 ? ` · mobile ending ${c.phoneLast4}` : ""}
                {c.attempt ? ` · attempt ${c.attempt}` : ""}
                {c.durationS ? ` · ${Math.max(1, Math.round(c.durationS / 60))} min` : ""}
                {c.screeningRunId ? " · graded below" : ""}
              </span>
              {hasDetail ? (
                <ChevronDown className={`size-3.5 ${expanded ? "rotate-180" : ""}`} />
              ) : null}
            </button>
            {expanded ? (
              <div className="mt-2 space-y-2">
                {details.length ? (
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                    {details.map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted-foreground">{DETAIL_LABEL[k] ?? k}</dt>
                        <dd>{typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {c.transcriptHidden ? (
                  <p className="text-muted-foreground">
                    The transcript includes pay, so only TA, the HR head and the CBO can read it.
                  </p>
                ) : null}
                {c.answers.length ? (
                  <ul className="space-y-1.5">
                    {c.answers.map((a) => (
                      <li key={a.question_id}>
                        <span className="font-medium">{a.question}</span>
                        <br />
                        {a.summary}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {c.transcript.length ? (
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">
                      Transcript (the candidate agreed to it)
                    </summary>
                    <div className="mt-1 max-h-72 space-y-1 overflow-auto rounded bg-muted/40 p-2">
                      {c.transcript.map((t, i) => (
                        <p key={i}>
                          <span className="font-medium">
                            {t.who === "ai" ? "Assistant" : "Candidate"}:
                          </span>{" "}
                          {t.text}
                        </p>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
