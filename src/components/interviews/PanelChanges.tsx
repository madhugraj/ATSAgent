import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Clock, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  changeInterviewTime,
  getChangeOptions,
  getRoundScorecard,
  proposeScorecardChange,
} from "@/lib/interview-confirmations.functions";
import { movedTooFar, outweighMustHaves, percentSplit, sharesOf } from "@/lib/interview-plan";

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
export function ChangeTime({
  token,
  onDone,
  defaultOpen = false,
}: {
  token: string;
  onDone: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [reason, setReason] = useState("");
  const [to, setTo] = useState<string | null>(null);
  const [length, setLength] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useServerFn(getChangeOptions);
  const change = useServerFn(changeInterviewTime);
  const q = useQuery({
    queryKey: ["change_options", token, length],
    queryFn: () => load({ data: length ? { token, durationMins: length } : { token } }),
    enabled: open,
    placeholderData: (prev) => prev,
  });
  if (!open)
    return (
      <button
        type="button"
        className="w-full text-center text-xs text-muted-foreground underline"
        onClick={() => setOpen(true)}
      >
        I can&apos;t make it or need another time
      </button>
    );
  const o = q.data;
  async function send(target: string | null) {
    setBusy(true);
    try {
      const r = await change({
        data: length
          ? { token, reason, to: target, durationMins: length }
          : { token, reason, to: target },
      });
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
    <div className="space-y-3 text-sm">
      <h2 className="font-medium">Move it or step down</h2>
      {q.isLoading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      {o && !o.can ? <p className="text-xs text-muted-foreground">{o.why}</p> : null}
      {o && o.can ? (
        <>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
            <Clock className="size-3.5" /> Latest by {short(o.latest)}
          </span>
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="radiogroup"
            aria-label="Length"
          >
            {o.durations.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={o.durationMins === m}
                onClick={() => {
                  setLength(m);
                  setTo(null);
                }}
                className={`rounded-full border px-3 py-1 text-xs tabular-nums ${o.durationMins === m ? "border-primary bg-primary font-semibold text-primary-foreground" : "border-border"}`}
              >
                {m} min
              </button>
            ))}
          </div>
          <SlotCalendar
            key={o.durationMins}
            times={o.times}
            latest={o.latest}
            current={o.current}
            value={to}
            onChange={setTo}
          />
        </>
      ) : null}
      <Textarea
        rows={2}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why does the time have to change?"
      />
      {o && o.can && o.times.length ? (
        <Button
          className="w-full"
          disabled={busy || !to || reason.trim().length < 10}
          onClick={() => void send(to)}
        >
          {to ? `Move to ${short(to)} · ${o.durationMins} min` : "Pick a time"}
        </Button>
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

/** "Mon 23 Nov, 11:30" in the reader's zone. */
function short(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * The panel's free times on a calendar: weeks from today to the deadline,
 * free days tinted, the booked day outlined, days past the deadline hatched.
 */
export function SlotCalendar({
  times,
  latest,
  current,
  value,
  onChange,
}: {
  times: string[];
  latest: string;
  current: string;
  value: string | null;
  onChange: (iso: string) => void;
}) {
  const byDay = new Map<string, string[]>();
  for (const t of times) {
    const k = dayKey(new Date(t));
    byDay.set(k, [...(byDay.get(k) ?? []), t]);
  }
  const firstFree = times[0] ? dayKey(new Date(times[0])) : null;
  const [day, setDay] = useState<string | null>(value ? dayKey(new Date(value)) : firstFree);
  const today = startOfDay(new Date());
  const last = startOfDay(new Date(Math.max(Date.parse(latest), Date.parse(current))));
  const start = new Date(today);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday
  const cells: Date[] = [];
  for (let d = new Date(start); d <= last || cells.length % 7; d.setDate(d.getDate() + 1))
    cells.push(new Date(d));
  const deadlineKey = dayKey(new Date(latest));
  const bookedKey = dayKey(new Date(current));
  const months = [
    ...new Set(
      cells.map((d) => d.toLocaleDateString(undefined, { month: "long", year: "numeric" })),
    ),
  ];
  const dayTimes = (day ? byDay.get(day) : undefined) ?? [];
  return (
    <div className="space-y-3">
      <p className="text-center text-xs font-semibold">{months.join(" – ")}</p>
      <div className="grid grid-cols-7 gap-1 text-center text-xs">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d} className="py-1 text-[0.6875rem] text-muted-foreground">
            {d}
          </span>
        ))}
        {cells.map((d) => {
          const k = dayKey(d);
          const past = d < today;
          const after = k > deadlineKey;
          const free = byDay.has(k);
          const sel = k === day;
          return (
            <button
              key={k}
              type="button"
              disabled={!free}
              onClick={() => setDay(k)}
              aria-pressed={sel}
              aria-label={d.toDateString()}
              className={[
                "relative flex h-9 items-center justify-center rounded-md tabular-nums",
                past ? "text-muted-foreground/40" : "",
                after
                  ? "bg-[repeating-linear-gradient(135deg,transparent_0_4px,var(--color-muted)_4px_8px)] text-muted-foreground/40"
                  : "",
                free && !sel ? "bg-primary/10 font-semibold text-foreground" : "",
                sel ? "bg-primary font-semibold text-primary-foreground" : "",
                k === bookedKey && !sel ? "ring-2 ring-inset ring-primary" : "",
                k === deadlineKey ? "shadow-[inset_-3px_0_0_theme(colors.amber.500)]" : "",
                !free && !past && !after ? "text-muted-foreground" : "",
              ].join(" ")}
            >
              {d.getDate()}
              {free ? (
                <span
                  className={`absolute bottom-1 size-1 rounded-full ${sel ? "bg-primary-foreground" : "bg-primary"}`}
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-[0.6875rem] text-muted-foreground">
        <span className="flex items-center gap-1">
          <i className="size-2.5 rounded-sm bg-primary/15" /> Panel free
        </span>
        <span className="flex items-center gap-1">
          <i className="size-2.5 rounded-sm ring-2 ring-inset ring-primary" /> Booked now
        </span>
        <span className="flex items-center gap-1">
          <i className="size-2.5 rounded-sm bg-[repeating-linear-gradient(135deg,transparent_0_2px,var(--color-muted-foreground)_2px_3px)] opacity-50" />{" "}
          Past the deadline
        </span>
      </div>
      {day && dayTimes.length ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold">
            {new Date(dayTimes[0]!).toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </p>
          <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Time">
            {dayTimes.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={value === t}
                onClick={() => onChange(t)}
                className={`rounded-md border py-2 text-xs tabular-nums ${value === t ? "border-primary bg-primary font-semibold text-primary-foreground" : "border-border"}`}
              >
                {new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No time before {short(latest)} suits the whole panel.
        </p>
      )}
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
  const locked = new Set(d.locked.map(key));
  const w = Object.fromEntries(list.map((c) => [c, Math.max(1, pctOf(c))]));
  const red = new Set(
    [
      ...movedTooFar(round, { competencies: list, weights: w }).map((m) => m.name),
      ...outweighMustHaves({ competencies: list, weights: w }, d.locked),
    ].map(key),
  );
  const over = (c: string) => red.has(key(c));
  /** Spread 100% evenly over the given competencies (5-point steps). */
  const balance = (names: string[]) => {
    const step = Math.floor(100 / names.length / 5) * 5;
    let left = 100 - step * names.length;
    setComps(names);
    setPctMap(
      Object.fromEntries(
        names.map((x) => {
          const extra = left >= 5 && locked.has(key(x)) ? 5 : 0;
          left -= extra;
          return [x, step + extra];
        }),
      ),
    );
  };
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
              if (list.some((x) => key(x) === key(name))) return;
              balance([...list, name]);
              setAdding("");
            }}
          >
            Add
          </Button>
        </div>
      ) : null}
      <div className="flex items-center justify-between text-xs">
        <button
          type="button"
          className="text-muted-foreground underline"
          onClick={() => balance(list)}
        >
          Balance evenly
        </button>
        <span
          className={`tabular-nums ${total === 100 ? "text-muted-foreground" : "text-destructive"}`}
        >
          Total {total}%
        </span>
      </div>
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
