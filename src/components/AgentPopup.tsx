import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Bot, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  myNotifications,
  type Notification,
  type NotificationAction,
} from "@/lib/notifications.functions";
import {
  assessmentAction,
  decideAfterAssessment,
  setNotificationState,
} from "@/lib/nudges.functions";
import { sendCandidateCompensationForm } from "@/lib/compensation.functions";
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

/** The next pop-up this person has not snoozed or dismissed. */
function nextPopup(items: Notification[]): Notification | null {
  const now = Date.now();
  return (
    items.find(
      (n) =>
        n.popup && !n.dismissed && !(n.snoozedUntil && new Date(n.snoozedUntil).getTime() > now),
    ) ?? null
  );
}

/**
 * An agent pops up when something needs a person — an overdue assessment, a
 * reminder waiting for approval, a completed assessment to decide on. Each
 * button opens a short form; "Later" snoozes it for 4 hours, × dismisses it
 * (it comes back only if the situation changes).
 */
export function AgentPopup() {
  const fetchAll = useServerFn(myNotifications);
  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => fetchAll({}),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 2,
  });
  const qc = useQueryClient();
  const [action, setAction] = useState<NotificationAction | null>(null);
  const n = nextPopup(q.data ?? []);
  if (!n) return null;

  const mark = async (state: "snooze" | "dismiss") => {
    try {
      await setNotificationState({ data: { id: n.id, state, hours: 4 } });
    } finally {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    }
  };

  return (
    <>
      <div
        role="dialog"
        aria-label={`${n.agent ?? "Agent"}: ${n.title}`}
        className="fixed bottom-20 right-5 z-40 w-[min(24rem,calc(100vw-2.5rem))] rounded-xl border border-border bg-card p-4 shadow-lg"
      >
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Bot className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground">{n.agent ?? "Agent"}</p>
            <p className="text-sm font-semibold leading-snug">{n.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{n.body}</p>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void mark("dismiss")}
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {(n.actions ?? []).map((a, i) => (
            <Button
              key={a.id}
              size="sm"
              variant={i === 0 ? "default" : "outline"}
              onClick={() => setAction(a)}
            >
              {a.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => void mark("snooze")}>
            Later
          </Button>
          <Link to={n.to} className="self-center text-xs text-primary underline">
            Open
          </Link>
        </div>
      </div>
      {action ? (
        <ActionDialog
          n={n}
          action={action}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            qc.invalidateQueries({ queryKey: ["notifications"] });
          }}
        />
      ) : null}
    </>
  );
}

/** Two working days from today (or from the current due date), as YYYY-MM-DD. */
function suggestedDue(current: string | null | undefined): string {
  const from = Math.max(Date.now(), current ? new Date(current).getTime() : 0);
  const d = new Date(from);
  let left = 2;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

function ActionDialog({
  n,
  action,
  onClose,
  onDone,
}: {
  n: Notification;
  action: NotificationAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const who = n.subject?.candidate ?? "the candidate";
  const [due, setDue] = useState(suggestedDue(n.subject?.dueAt));
  const [notify, setNotify] = useState(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const needsReason = ["phone_screen", "decide_without", "hold", "reject"].includes(action.id);

  const copy: Record<NotificationAction["id"], { title: string; desc: string; go: string }> = {
    extend: {
      title: `Give ${who} more time`,
      desc: "The new due date is end of day in your organisation's time zone; the link stays open past it.",
      go: "Save the new date",
    },
    remind: {
      title: `Remind ${who}`,
      desc: "They get the assessment link again with the date it is due.",
      go: "Send the reminder",
    },
    phone_screen: {
      title: `Screen ${who} by phone instead`,
      desc: "The written assessment link closes; the reason goes on the candidate's record and the role's thread.",
      go: "Close the link",
    },
    decide_without: {
      title: `Decide on ${who} without the assessment`,
      desc: "The link closes; you then decide who moves on.",
      go: "Close the link",
    },
    move_l1: {
      title: `Move ${who} to an interview round`,
      desc: "The Interview coordinator then offers interview times.",
      go: "Move to interview",
    },
    hold: {
      title: `Put ${who} on hold`,
      desc: "They stay in the pipeline, out of the active steps.",
      go: "Put on hold",
    },
    reject: {
      title: `Not taking ${who} further`,
      desc: "They get a kind, final email — your reason stays internal.",
      go: "Confirm",
    },
    pay_remind: {
      title: `Remind ${who} about the pay & availability form`,
      desc: "They get the same private link again with the date it is due.",
      go: "Send the reminder",
    },
  };
  const c = copy[action.id];

  async function submit() {
    setBusy(true);
    try {
      const assessmentId = n.subject?.assessmentId;
      if (action.id === "extend" && assessmentId)
        await assessmentAction({ data: { action: "extend", assessmentId, dueDate: due, notify } });
      else if (action.id === "pay_remind" && n.subject?.payRequestId)
        await sendCandidateCompensationForm({
          data: { action: "remind", requestId: n.subject.payRequestId },
        });
      else if (action.id === "remind" && assessmentId)
        await assessmentAction({ data: { action: "remind", assessmentId } });
      else if ((action.id === "phone_screen" || action.id === "decide_without") && assessmentId)
        await assessmentAction({ data: { action: action.id, assessmentId, reason: text.trim() } });
      else if (
        (action.id === "move_l1" || action.id === "hold" || action.id === "reject") &&
        n.subject?.applicationId
      )
        await decideAfterAssessment({
          data: { applicationId: n.subject.applicationId, decision: action.id, note: text.trim() },
        });
      else throw new Error("This item is missing its candidate — open it instead.");
      toast.success("Done.");
      onDone();
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
          <DialogTitle>{c.title}</DialogTitle>
          <DialogDescription>{c.desc}</DialogDescription>
        </DialogHeader>
        {action.id === "extend" ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="popup-due">New due date</Label>
              <Input
                id="popup-due"
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} />
              Email {who} the new date
            </label>
          </div>
        ) : null}
        {action.id !== "extend" && action.id !== "remind" && action.id !== "pay_remind" ? (
          <div className="space-y-1">
            <Label htmlFor="popup-text">
              {needsReason ? "Why? (required)" : "Note (optional)"}
            </Label>
            <Textarea
              id="popup-text"
              rows={3}
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              busy || (needsReason && text.trim().length < 3) || (action.id === "extend" && !due)
            }
          >
            {c.go}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
