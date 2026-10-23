/**
 * When the voice worker may call (pure; unit-tested): the organisation's
 * calling window and days in its time zone, retries after an unanswered
 * attempt, and a callback time the candidate asked for.
 */
import { wallDate, zonedTime } from "@/lib/calendar-availability.server";

export type CallingWindow = {
  /** Minutes after local midnight. */
  windowStartMinute: number;
  windowEndMinute: number;
  /** ISO weekdays (1 = Monday … 7 = Sunday). */
  callDays: number[];
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Local midnight (as an instant) of the day `at` falls on, plus its ISO weekday. */
function localDay(at: number, timeZone: string) {
  const w = wallDate(at, timeZone);
  return { midnight: zonedTime(w.y, w.m, w.d, 0, 0, timeZone), iso: w.wd === 0 ? 7 : w.wd, w };
}

/** Whether a call may be placed at `at`. A call needs 10 minutes before the window closes. */
export function inWindow(at: number, win: CallingWindow, timeZone: string): boolean {
  const { midnight, iso } = localDay(at, timeZone);
  if (!win.callDays.includes(iso)) return false;
  const minute = (at - midnight) / MIN;
  return minute >= win.windowStartMinute && minute <= win.windowEndMinute - 10;
}

/** The earliest instant at or after `at` inside the calling window. */
export function nextWindowStart(at: number, win: CallingWindow, timeZone: string): Date {
  if (!win.callDays.length) throw new Error("No calling days");
  if (inWindow(at, win, timeZone)) return new Date(at);
  for (let i = 0; i < 9; i++) {
    const { midnight, iso, w } = localDay(at + i * DAY, timeZone);
    if (!win.callDays.includes(iso)) continue;
    // Recompute the start through zonedTime so a DST change mid-week stays right.
    const start = zonedTime(
      w.y,
      w.m,
      w.d,
      Math.floor(win.windowStartMinute / 60),
      win.windowStartMinute % 60,
      timeZone,
    );
    if (start >= at) return new Date(start);
    if (i === 0 && at - midnight < (win.windowEndMinute - 10) * MIN) return new Date(at);
  }
  throw new Error("No calling window in the next week");
}

/** When to try again after attempt `attempt` went unanswered: 2 hours, then the next day. */
export function retryAt(now: number, attempt: number, win: CallingWindow, timeZone: string): Date {
  const wait = attempt <= 1 ? 2 * HOUR : 20 * HOUR;
  return nextWindowStart(now + wait, win, timeZone);
}

export type AttemptOutcome = "no_answer" | "failed";

/** After an unanswered or failed attempt: try again, or give up (the e-mailed assessment). */
export function afterAttempt(
  outcome: AttemptOutcome,
  attempt: number,
  maxAttempts: number,
  now: number,
  win: CallingWindow,
  timeZone: string,
): { status: "approved"; dueAt: Date } | { status: "fell_back"; dueAt: null } {
  if (attempt >= maxAttempts) return { status: "fell_back", dueAt: null };
  return { status: "approved", dueAt: retryAt(now, attempt, win, timeZone) };
}

/**
 * The callback the candidate asked for, given as local "YYYY-MM-DDTHH:mm" in
 * the organisation's time zone: at least 15 minutes and at most 7 days away,
 * moved into the calling window; unreadable → two hours from now.
 */
export function callbackAt(
  localIso: string | null | undefined,
  now: number,
  win: CallingWindow,
  timeZone: string,
): Date {
  const m = (localIso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  let at = m
    ? zonedTime(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), timeZone)
    : Number.NaN;
  if (!Number.isFinite(at) || at > now + 7 * DAY) at = now + 2 * HOUR;
  at = Math.max(at, now + 15 * MIN);
  return nextWindowStart(at, win, timeZone);
}

/** "Thursday 23 October 2026, 15:40" in the organisation's time zone — for the call agent. */
export function localNow(now: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    }).format(new Date(now));
  } catch {
    return new Date(now).toISOString();
  }
}
