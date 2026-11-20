import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  changeInterviewTime,
  getChangeOptions,
  getRoundScorecard,
  proposeScorecardChange,
} from "@/lib/interview-confirmations.functions";
import { keptShares, percentSplit, sharesOf } from "@/lib/interview-plan";

/** In the reader's own time zone. */
function fmt(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

/** After accepting: move the round once, within the hiring SLA, or step down. */
export function ChangeTime({ token, onDone }: { token: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [to, setTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useServerFn(getChangeOptions);
  const change = useServerFn(changeInterviewTime);
  const q = useQuery({
    queryKey: ["change_options", token],
    queryFn: () => load({ data: { token } }),
    enabled: open,
  });
  if (!open)
    return (
      <button
        type="button"
        className="w-full text-center text-xs text-muted-foreground underline"
        onClick={() => setOpen(true)}
      >
        I need to change this time
      </button>
    );
  const o = q.data;
  async function send(target: string | null) {
    setBusy(true);
    try {
      const r = await change({ data: { token, reason, to: target } });
      if (!r.ok) toast.error(r.error);
      else {
        toast.success(
          r.moved
            ? "Moved. The panel and the candidate are asked to confirm."
            : "The team is arranging a stand-in.",
        );
        onDone();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the time");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <h2 className="font-medium">Change the time</h2>
      {q.isLoading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      <Textarea
        rows={2}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why does the time have to change?"
      />
      {o && !o.can ? <p className="text-xs text-muted-foreground">{o.why}</p> : null}
      {o && o.can && o.times.length ? (
        <div className="space-y-1.5" role="radiogroup" aria-label="New time">
          {o.times.map((t) => (
            <label
              key={t}
              className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2"
            >
              <input type="radio" name="to" checked={to === t} onChange={() => setTo(t)} />
              {fmt(t)}
            </label>
          ))}
          <Button
            className="w-full"
            disabled={busy || !to || reason.trim().length < 10}
            onClick={() => void send(to)}
          >
            Move the round
          </Button>
        </div>
      ) : null}
      {o && o.can && !o.times.length ? (
        <p className="text-xs text-muted-foreground">
          No time before {fmt(o.latest)} suits the whole panel.
        </p>
      ) : null}
      {o ? (
        <Button
          variant="outline"
          className="w-full"
          disabled={busy || reason.trim().length < 10}
          onClick={() => void send(null)}
        >
          I can&apos;t take this round
        </Button>
      ) : null}
    </div>
  );
}

/** Propose topics, competencies and weights for this round; the hiring manager decides. */
export function ScorecardChange({ token }: { token: string }) {
  const load = useServerFn(getRoundScorecard);
  const propose = useServerFn(proposeScorecardChange);
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["round_scorecard", token],
    queryFn: () => load({ data: { token } }),
    enabled: open,
  });
  const [focus, setFocus] = useState<string | null>(null);
  const [comps, setComps] = useState<string[] | null>(null);
  /** Competency → percent of the overall, once the panelist changes it. */
  const [pct, setPctMap] = useState<Record<string, number> | null>(null);
  const [adding, setAdding] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  if (!open)
    return (
      <button
        type="button"
        className="w-full text-center text-xs text-muted-foreground underline"
        onClick={() => setOpen(true)}
      >
        Suggest changes to this round&apos;s scorecard
      </button>
    );
  const d = q.data;
  if (!d) return q.isLoading ? <Loader2 className="size-4 animate-spin" /> : null;
  if (
    d.proposal &&
    ["reviewing", "awaiting_approval"].includes(d.proposal.status) &&
    comps === null
  )
    return (
      <p className="text-xs text-muted-foreground">Your proposal is with the hiring manager.</p>
    );
  const round = d.round;
  const list = comps ?? round.competencies;
  const key = (c: string) => c.toLowerCase();
  // The split in percent: the round's own to start, then the panelist's.
  const start = percentSplit(sharesOf(round));
  const pctOf = (c: string) => pct?.[c] ?? start[key(c)] ?? 0;
  const total = list.reduce((sum, c) => sum + pctOf(c), 0);
  const was = keptShares(round, { competencies: list });
  const locked = new Set(d.locked.map(key));
  const over = (c: string) =>
    key(c) in was && Math.abs(pctOf(c) / 100 - (was[key(c)] ?? 0)) > d.shareLimit + 1e-9;
  const w = Object.fromEntries(list.map((c) => [c, Math.max(1, pctOf(c))]));
  const setPct = (c: string, v: number) => {
    setComps(list);
    setPctMap({ ...Object.fromEntries(list.map((x) => [x, pctOf(x)])), [c]: v });
  };
  const ready =
    reason.trim().length >= 10 && total === 100 && list.every((c) => pctOf(c) > 0 && !over(c));

  async function send() {
    setBusy(true);
    setProblems([]);
    try {
      const r = await propose({
        data: {
          token,
          change: { focus: focus ?? round.focus, competencies: list, weights: w, reason },
        },
      });
      if (!r.ok) {
        toast.error(r.error);
        setProblems(r.violations ?? []);
      } else {
        toast.success("Sent to the hiring manager");
        setComps(null);
        await q.refetch();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the proposal");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <h2 className="font-medium">Scorecard for this round</h2>
      {d.proposal && ["approved", "rejected"].includes(d.proposal.status) ? (
        <p className="text-xs text-muted-foreground">
          Your last proposal was {d.proposal.status}
          {d.proposal.decisionNote ? `: ${d.proposal.decisionNote}` : "."}
        </p>
      ) : null}
      <Textarea
        rows={2}
        maxLength={300}
        value={focus ?? round.focus}
        onChange={(e) => setFocus(e.target.value)}
        aria-label="What the round covers"
      />
      <div className="space-y-1.5">
        {list.map((c) => {
          const k = c.toLowerCase();
          return (
            <div key={c} className="flex items-center gap-2">
              <span className="flex-1 text-xs">
                {c}
                {locked.has(k) ? (
                  <span className="ml-1 text-muted-foreground">(must-have)</span>
                ) : null}
              </span>
              <button
                type="button"
                className="rounded border border-border px-2 text-xs disabled:opacity-40"
                aria-label={`Less weight on ${c}`}
                disabled={pctOf(c) <= 5}
                onClick={() => setPct(c, pctOf(c) - 5)}
              >
                −
              </button>
              <span
                className={`w-10 text-center text-xs tabular-nums ${over(c) ? "text-destructive" : ""}`}
              >
                {pctOf(c)}%
              </span>
              <button
                type="button"
                className="rounded border border-border px-2 text-xs disabled:opacity-40"
                aria-label={`More weight on ${c}`}
                disabled={pctOf(c) >= 95}
                onClick={() => setPct(c, pctOf(c) + 5)}
              >
                +
              </button>
              <button
                type="button"
                className="text-xs text-muted-foreground underline disabled:no-underline disabled:opacity-40"
                disabled={locked.has(k) || list.length <= 1}
                onClick={() => {
                  // Its share goes to the rest in proportion.
                  const rest = list.filter((x) => x !== c);
                  const tot = rest.reduce((sum, x) => sum + pctOf(x), 0) || 1;
                  setComps(rest);
                  setPctMap(percentSplit(Object.fromEntries(rest.map((x) => [x, pctOf(x) / tot]))));
                }}
              >
                Remove
              </button>
            </div>
          );
        })}
      </div>
      {list.length < 8 ? (
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs"
            maxLength={60}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="Add a competency"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={adding.trim().length < 2}
            onClick={() => {
              const name = adding.trim();
              setComps([...list, name]);
              setPctMap({ ...Object.fromEntries(list.map((x) => [x, pctOf(x)])), [name]: 0 });
              setAdding("");
            }}
          >
            Add
          </Button>
        </div>
      ) : null}
      <p
        className={`text-right text-xs tabular-nums ${total === 100 ? "text-muted-foreground" : "text-destructive"}`}
      >
        Total {total}%
      </p>
      <Textarea
        rows={2}
        maxLength={1000}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why this change?"
      />
      {problems.length ? (
        <ul className="list-disc pl-4 text-xs text-destructive">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <Button className="w-full" disabled={busy || !ready} onClick={() => void send()}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null} Send to the hiring manager
      </Button>
    </div>
  );
}
