import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Phone } from "lucide-react";

import { getPhoneScreening, setPhoneScreening } from "@/lib/phone-screening.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type Policy = Awaited<ReturnType<typeof getPhoneScreening>>["policy"];

const VOICES = ["Kore", "Aoede", "Leda", "Zephyr", "Puck", "Charon", "Fenrir", "Orus"] as const;

const DAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
] as const;

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minutes = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Whether shortlisted candidates are screened by a phone call from the AI assistant, and when. */
export function PhoneScreeningCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["phone_screening"], queryFn: () => getPhoneScreening() });
  const [draft, setDraft] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  if (!q.data) return null;
  const { readiness } = q.data;
  const p = draft ?? q.data.policy;
  const set = (patch: Partial<Policy>) => setDraft({ ...p, ...patch });
  const valid =
    p.assistantName.trim().length >= 2 &&
    p.windowEndMinute - p.windowStartMinute >= 60 &&
    p.callDays.length > 0;

  const missing = [
    !readiness.phoneLine &&
      "the voice worker with its phone line is not running (your administrator starts it)",
    !readiness.voice && "an AI voice key (Integrations → AI model)",
  ].filter(Boolean) as string[];

  async function save() {
    setBusy(true);
    try {
      await setPhoneScreening({ data: p });
      toast.success(
        p.enabled ? "Phone screening saved and switched on." : "Phone screening saved.",
      );
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["phone_screening"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Phone className="size-4" /> Phone screening
        </h2>
        <div className="flex items-center gap-2">
          <Label htmlFor="ps-enabled" className="text-xs text-muted-foreground">
            {p.enabled ? "On" : "Off"}
          </Label>
          <Switch
            id="ps-enabled"
            checked={p.enabled}
            disabled={!canEdit}
            onCheckedChange={(enabled) => set({ enabled })}
          />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        When on, the Screening agent can ask for an AI assistant to phone a shortlisted candidate.
        The assistant says it is an AI recruiting assistant from your talent acquisition team,
        explains the role and why it called them, asks their consent, practical details (including
        current and expected pay, which only TA and HR see — it never discusses pay) and the role's
        screening questions. If now is not a good time it agrees a time and e-mails a confirmation.
        A person approves each call unless the agent is set to Autonomous. Candidates who can't be
        reached get the written assessment instead. Calls are not recorded; the transcript is kept
        only if the candidate agrees.
      </p>
      {missing.length ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Calls can't be placed yet — still needed: {missing.join("; ")}.
        </p>
      ) : null}
      <div className="grid items-end gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="ps-name" className="text-xs">
            Assistant's name
          </Label>
          <Input
            id="ps-name"
            disabled={!canEdit}
            value={p.assistantName}
            maxLength={40}
            onChange={(e) => set({ assistantName: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ps-from" className="text-xs">
            Calls from
          </Label>
          <Input
            id="ps-from"
            type="time"
            disabled={!canEdit}
            value={hhmm(p.windowStartMinute)}
            onChange={(e) => set({ windowStartMinute: minutes(e.target.value) })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ps-to" className="text-xs">
            Until
          </Label>
          <Input
            id="ps-to"
            type="time"
            disabled={!canEdit}
            value={hhmm(p.windowEndMinute)}
            onChange={(e) => set({ windowEndMinute: minutes(e.target.value) })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="ps-attempts" className="text-xs">
              Attempts
            </Label>
            <Input
              id="ps-attempts"
              type="number"
              min={1}
              max={5}
              disabled={!canEdit}
              value={p.maxAttempts}
              onChange={(e) =>
                set({ maxAttempts: Math.min(5, Math.max(1, Number(e.target.value))) })
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ps-minutes" className="text-xs">
              Max minutes
            </Label>
            <Input
              id="ps-minutes"
              type="number"
              min={5}
              max={30}
              disabled={!canEdit}
              value={p.maxMinutes}
              onChange={(e) =>
                set({ maxMinutes: Math.min(30, Math.max(5, Number(e.target.value))) })
              }
            />
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Calls on</span>
        {DAYS.map(([d, label]) => {
          const on = p.callDays.includes(d);
          return (
            <Button
              key={d}
              type="button"
              size="sm"
              variant={on ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              disabled={!canEdit}
              aria-pressed={on}
              onClick={() =>
                set({ callDays: on ? p.callDays.filter((x) => x !== d) : [...p.callDays, d] })
              }
            >
              {label}
            </Button>
          );
        })}
        <span className="ml-1 text-xs text-muted-foreground">
          (in your organisation's time zone)
        </span>
      </div>
      <div className="grid items-end gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="ps-reschedules" className="text-xs">
            Reschedules allowed
          </Label>
          <Input
            id="ps-reschedules"
            type="number"
            min={0}
            max={5}
            disabled={!canEdit}
            value={p.maxReschedules}
            onChange={(e) =>
              set({ maxReschedules: Math.min(5, Math.max(0, Number(e.target.value))) })
            }
          />
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-3">
          How many times a candidate can ask to move the call to another time. After that the
          assistant offers the written assessment or a call from a person instead.
        </p>
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="ps-voice" className="text-xs">
            Voice
          </Label>
          <select
            id="ps-voice"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            disabled={!canEdit}
            value={p.voice}
            onChange={(e) => set({ voice: e.target.value as Policy["voice"] })}
          >
            {VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1 sm:col-span-3">
          <Label htmlFor="ps-next" className="text-xs">
            What candidates are told happens next
          </Label>
          <Input
            id="ps-next"
            disabled={!canEdit}
            maxLength={300}
            placeholder="the hiring team will review this conversation and get back to you by e-mail"
            value={p.nextStepsText ?? ""}
            onChange={(e) => set({ nextStepsText: e.target.value || null })}
          />
        </div>
      </div>
      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Interview scheduling calls</h3>
          <div className="flex items-center gap-2">
            <Label htmlFor="ps-scheduling" className="text-xs text-muted-foreground">
              {p.schedulingEnabled ? "On" : "Off"}
            </Label>
            <Switch
              id="ps-scheduling"
              checked={p.schedulingEnabled}
              disabled={!canEdit}
              onCheckedChange={(schedulingEnabled) => set({ schedulingEnabled })}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          When interview times e-mailed to a candidate go unanswered, the assistant can phone them
          to pick one — only the times offered, or up to three more that are free for the
          interviewers. It never changes the interviewer, format or length. A person approves each
          call. Coming next: this setting is saved now and used once scheduling calls are released.
        </p>
        <div className="grid items-end gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="ps-wait" className="text-xs">
              Call after (hours unanswered)
            </Label>
            <Input
              id="ps-wait"
              type="number"
              min={2}
              max={96}
              disabled={!canEdit || !p.schedulingEnabled}
              value={p.schedulingWaitHours}
              onChange={(e) =>
                set({ schedulingWaitHours: Math.min(96, Math.max(2, Number(e.target.value))) })
              }
            />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-3">
            Only while the earliest offered time is still a day away. Candidates who asked not to be
            called by the assistant are never phoned.
          </p>
        </div>
      </div>
      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Pay negotiation calls</h3>
          <div className="flex items-center gap-2">
            <Label htmlFor="ps-negotiation" className="text-xs text-muted-foreground">
              {p.negotiationEnabled ? "On" : "Off"}
            </Label>
            <Switch
              id="ps-negotiation"
              checked={p.negotiationEnabled}
              disabled={!canEdit}
              onCheckedChange={(negotiationEnabled) => set({ negotiationEnabled })}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The Negotiation call agent phones a selected candidate about an approved offer: it
          congratulates them, explains the role and the whole package, listens to how they feel, and
          may offer one pre-approved improved figure — only after they say they would go ahead. It
          never says the ceiling or band and never agrees anything: a yes comes back to TA or the HR
          head to confirm. The HR head approves each call (or TA arranges it from &quot;Call to
          negotiate&quot; on the candidate&apos;s pay discussion).
        </p>
      </div>
      {canEdit ? (
        <Button variant="outline" disabled={busy || !valid || !draft} onClick={() => void save()}>
          Save phone screening
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Only the HR head, the CBO or an owner can change this.
        </p>
      )}
    </section>
  );
}
