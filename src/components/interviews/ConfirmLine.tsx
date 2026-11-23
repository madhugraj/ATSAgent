import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { sendInviteNow } from "@/lib/interview-confirmations.functions";

type State = "pending" | "accepted" | "declined" | "superseded" | "lapsed";
type RoundConfirmations = {
  panel: { name: string | null; email: string; state: State }[];
  candidate: State | null;
  inviteHeld: boolean;
};

const WORD: Record<State, string> = {
  pending: "waiting",
  accepted: "accepted",
  declined: "can't make it",
  superseded: "",
  lapsed: "no answer",
};

/** Who has agreed the round's time; the held candidate invite can be sent anyway. */
export function ConfirmLine({
  interviewId,
  c,
  onChange,
}: {
  interviewId: string;
  c: RoundConfirmations | undefined;
  onChange: () => void;
}) {
  const send = useServerFn(sendInviteNow);
  const [busy, setBusy] = useState(false);
  if (!c) return null;
  const agreed = c.panel.filter((p) => p.state === "accepted").length;
  const declined = c.panel.filter((p) => p.state === "declined");
  const panelText = declined.length
    ? `${declined.map((p) => p.name ?? p.email).join(", ")} can't make it`
    : `Panel ${agreed}/${c.panel.length} accepted`;
  const candText = c.inviteHeld
    ? "candidate not told yet"
    : c.candidate
      ? `candidate ${WORD[c.candidate]}`
      : null;
  return (
    <span
      className={`flex flex-wrap items-center gap-1 text-[0.6875rem] ${declined.length || c.candidate === "declined" ? "text-destructive" : "text-muted-foreground"}`}
      title={c.panel.map((p) => `${p.name ?? p.email}: ${WORD[p.state]}`).join("\n")}
    >
      {panelText}
      {candText ? ` · ${candText}` : ""}
      {c.inviteHeld ? (
        <button
          type="button"
          className="underline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await send({ data: { interviewId } });
              toast[r.sent ? "success" : "error"](
                r.sent ? "Invite sent to the candidate" : "Nothing was waiting to send",
              );
              onChange();
            } finally {
              setBusy(false);
            }
          }}
        >
          Send invite now
        </button>
      ) : null}
    </span>
  );
}
