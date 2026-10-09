/**
 * Interviewer availability from the organisation's connected calendar
 * (Google Calendar via Google Meet, or Microsoft 365 via Teams — the same
 * connections that create meeting links). Free/busy only: event titles and
 * details are never read. Calls go to fixed provider endpoints with the
 * organisation's own stored credentials.
 *
 * Slots are proposed in the organisation's time zone on weekdays between
 * WORKING.startHour and WORKING.endHour, on a 30-minute grid, at least
 * WORKING.leadHours ahead, avoiding (1) calendar busy time, (2) rounds already
 * booked in ATSIQ for the interviewer and (3) times already offered to another
 * candidate and not yet answered.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "../server/db";
import { interviews, interviewSlotOffers, sourceIntegrations } from "@db/schema";

export const WORKING = {
  startHour: 10,
  endHour: 17,
  stepMins: 30,
  leadHours: 18,
  horizonDays: 14,
} as const;

type Interval = { start: number; end: number };
export type Busy = {
  source: "google" | "microsoft" | null;
  busy: Record<string, Interval[]>;
  /** Calendars the provider could not read (not in the domain, no sharing). */
  unknown: string[];
  note: string | null;
};

async function calendarConnection(orgId: string) {
  const rows = await db
    .select({
      id: sourceIntegrations.id,
      provider: sourceIntegrations.provider,
      enabled: sourceIntegrations.enabled,
      ready: sourceIntegrations.hasCredentials,
    })
    .from(sourceIntegrations)
    .where(
      and(
        eq(sourceIntegrations.orgId, orgId),
        inArray(sourceIntegrations.provider, ["google_meet", "teams"]),
      ),
    );
  const ok = rows.filter((r) => r.enabled && r.ready);
  return ok.find((r) => r.provider === "google_meet") ?? ok[0] ?? null;
}

/** Busy intervals for these people between two instants, from the connected calendar. */
export async function busyFor(
  orgId: string,
  emails: string[],
  from: Date,
  to: Date,
): Promise<Busy> {
  const conn = await calendarConnection(orgId);
  if (!conn)
    return {
      source: null,
      busy: {},
      unknown: emails,
      note: "No Google or Microsoft calendar is connected, so availability could not be checked.",
    };
  const { readSecrets } = await import("./integrations.server");
  const secrets = await readSecrets(conn.id);
  const m = await import("./meetings.server");
  const busy: Record<string, Interval[]> = {};
  const unknown: string[] = [];
  try {
    if (conn.provider === "google_meet") {
      const token = await m.googleToken(secrets);
      const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          items: emails.map((id) => ({ id })),
        }),
      });
      if (!res.ok) throw new Error(`Google free/busy failed [${res.status}]`);
      const body = (await res.json()) as {
        calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
      };
      for (const e of emails) {
        const c = body.calendars?.[e];
        if (!c || c.errors?.length) unknown.push(e);
        else
          busy[e] = (c.busy ?? []).map((b) => ({
            start: Date.parse(b.start),
            end: Date.parse(b.end),
          }));
      }
      return {
        source: "google",
        busy,
        unknown,
        note: unknown.length
          ? `Google could not share the calendar of ${unknown.join(", ")}.`
          : null,
      };
    }
    const delegated = Boolean(secrets["refresh_token"]);
    const token = delegated ? await m.msDelegatedToken(secrets) : await m.graphToken(secrets);
    const who = delegated ? "me" : `users/${encodeURIComponent(secrets["organizer_email"] ?? "")}`;
    const res = await fetch(`https://graph.microsoft.com/v1.0/${who}/calendar/getSchedule`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        schedules: emails,
        startTime: { dateTime: from.toISOString().slice(0, 19), timeZone: "UTC" },
        endTime: { dateTime: to.toISOString().slice(0, 19), timeZone: "UTC" },
        availabilityViewInterval: 30,
      }),
    });
    if (!res.ok) throw new Error(`Microsoft free/busy failed [${res.status}]`);
    const body = (await res.json()) as {
      value?: {
        scheduleId: string;
        error?: unknown;
        scheduleItems?: {
          status?: string;
          start: { dateTime: string };
          end: { dateTime: string };
        }[];
      }[];
    };
    for (const e of emails) {
      const v = body.value?.find((x) => x.scheduleId.toLowerCase() === e.toLowerCase());
      if (!v || v.error) unknown.push(e);
      else
        busy[e] = (v.scheduleItems ?? [])
          .filter((i) => i.status !== "free")
          .map((i) => ({
            start: Date.parse(`${i.start.dateTime.replace(/Z?$/, "")}Z`),
            end: Date.parse(`${i.end.dateTime.replace(/Z?$/, "")}Z`),
          }));
    }
    return {
      source: "microsoft",
      busy,
      unknown,
      note: unknown.length
        ? `Microsoft 365 could not share the calendar of ${unknown.join(", ")}.`
        : null,
    };
  } catch (e) {
    return {
      source: null,
      busy: {},
      unknown: emails,
      note: `The calendar could not be read (${e instanceof Error ? e.message : "error"}), so availability was not checked.`,
    };
  }
}

/** Offset (ms) of a time zone at an instant: local wall time minus UTC. */
function tzOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - at;
}

/** The UTC instant of a wall-clock time in a time zone. */
export function zonedTime(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  timeZone: string,
): number {
  const guess = Date.UTC(y, m, d, h, min);
  const first = guess - tzOffset(guess, timeZone);
  return guess - tzOffset(first, timeZone);
}

function wallDate(at: number, timeZone: string) {
  const local = new Date(at + tzOffset(at, timeZone));
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth(),
    d: local.getUTCDate(),
    wd: local.getUTCDay(),
  };
}

/** Working-hour candidate start times (pure; unit-tested). */
export function workingSlots(opts: {
  now: number;
  timeZone: string;
  durationMins: number;
  days?: number;
}): number[] {
  const out: number[] = [];
  const earliest = opts.now + WORKING.leadHours * 3600_000;
  for (let day = 0; day <= (opts.days ?? WORKING.horizonDays); day++) {
    const { y, m, d, wd } = wallDate(opts.now + day * 864e5, opts.timeZone);
    if (wd === 0 || wd === 6) continue;
    for (
      let mins = WORKING.startHour * 60;
      mins + opts.durationMins <= WORKING.endHour * 60;
      mins += WORKING.stepMins
    ) {
      const at = zonedTime(y, m, d, Math.floor(mins / 60), mins % 60, opts.timeZone);
      if (at >= earliest) out.push(at);
    }
  }
  return out;
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/** Free slots for an interviewer (and the rest of the panel), spread over different days. */
export async function findFreeSlots(
  orgId: string,
  input: {
    interviewerEmail: string;
    panelEmails?: string[];
    durationMins: number;
    count: number;
    timeZone: string;
  },
): Promise<{ slots: string[]; checkedWith: "google" | "microsoft" | null; note: string | null }> {
  const emails = [input.interviewerEmail, ...(input.panelEmails ?? [])]
    .map((e) => e.toLowerCase())
    .filter((e, i, all) => all.indexOf(e) === i);
  const candidates = workingSlots({
    now: Date.now(),
    timeZone: input.timeZone,
    durationMins: input.durationMins,
  });
  if (!candidates.length) return { slots: [], checkedWith: null, note: "No working-hour slots." };
  const from = new Date(candidates[0]!);
  const to = new Date(candidates.at(-1)! + input.durationMins * 60_000);
  const cal = await busyFor(orgId, emails, from, to);
  const blocked: Interval[] = emails.flatMap((e) => cal.busy[e] ?? []);
  const booked = await db
    .select({ at: interviews.scheduledAt, mins: interviews.durationMins })
    .from(interviews)
    .where(
      and(
        eq(interviews.orgId, orgId),
        involves(emails),
        gte(interviews.scheduledAt, new Date(Date.now() - 864e5)),
        sql`${interviews.status} not in ('cancelled','completed','no_show')`,
      ),
    );
  for (const b of booked)
    if (b.at) blocked.push({ start: b.at.getTime(), end: b.at.getTime() + b.mins * 60_000 });
  const offered = await db
    .select({ slots: interviewSlotOffers.slots, mins: interviewSlotOffers.durationMins })
    .from(interviewSlotOffers)
    .where(
      and(
        eq(interviewSlotOffers.orgId, orgId),
        eq(interviewSlotOffers.status, "offered"),
        sql`(lower(${interviewSlotOffers.interviewerEmail}) in (${sql.join(
          emails.map((e) => sql`${e}`),
          sql`, `,
        )}) or ${sql.join(
          emails.map(
            (e) => sql`${interviewSlotOffers.panel} @> ${JSON.stringify([{ email: e }])}::jsonb`,
          ),
          sql` or `,
        )})`,
      ),
    );
  for (const o of offered)
    for (const s of o.slots) {
      const at = Date.parse(s);
      blocked.push({ start: at, end: at + o.mins * 60_000 });
    }
  const free = candidates.filter(
    (at) => !blocked.some((b) => overlaps(b, { start: at, end: at + input.durationMins * 60_000 })),
  );
  // One per day first (varied times), then fill.
  const picked: number[] = [];
  const days = new Set<string>();
  for (const at of free) {
    const { y, m, d } = wallDate(at, input.timeZone);
    const key = `${y}-${m}-${d}`;
    if (days.has(key)) continue;
    days.add(key);
    // Rotate the time of day: morning, afternoon, late morning…
    const sameDay = free.filter((x) => {
      const w = wallDate(x, input.timeZone);
      return `${w.y}-${w.m}-${w.d}` === key;
    });
    picked.push(sameDay[(picked.length * 3) % sameDay.length]!);
    if (picked.length >= input.count) break;
  }
  for (const at of free) {
    if (picked.length >= input.count) break;
    if (!picked.includes(at)) picked.push(at);
  }
  picked.sort((a, b) => a - b);
  return {
    slots: picked.map((at) => new Date(at).toISOString()),
    checkedWith: cal.source && !emails.some((e) => cal.unknown.includes(e)) ? cal.source : null,
    note: cal.note,
  };
}

/** Rounds where any of these people interview (primary or on the panel). */
function involves(emails: string[]) {
  return sql`(lower(${interviews.interviewerEmail}) in (${sql.join(
    emails.map((e) => sql`${e}`),
    sql`, `,
  )}) or ${sql.join(
    emails.map((e) => sql`${interviews.panel} @> ${JSON.stringify([{ email: e }])}::jsonb`),
    sql` or `,
  )})`;
}

/** Is this one interval free for the interviewer (calendar + ATSIQ rounds)? */
export async function isFree(
  orgId: string,
  interviewerEmail: string,
  startIso: string,
  durationMins: number,
): Promise<{ free: boolean; reason: string | null }> {
  const email = interviewerEmail.toLowerCase();
  const slot = { start: Date.parse(startIso), end: Date.parse(startIso) + durationMins * 60_000 };
  const clash = await db
    .select({ id: interviews.id })
    .from(interviews)
    .where(
      and(
        eq(interviews.orgId, orgId),
        involves([email]),
        sql`${interviews.status} not in ('cancelled','completed','no_show')`,
        sql`${interviews.scheduledAt} < ${new Date(slot.end).toISOString()}::timestamptz`,
        sql`${interviews.scheduledAt} + make_interval(mins => ${interviews.durationMins}) > ${new Date(slot.start).toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  if (clash.length) return { free: false, reason: "another interview is booked then" };
  const cal = await busyFor(orgId, [email], new Date(slot.start), new Date(slot.end));
  if ((cal.busy[email] ?? []).some((b) => overlaps(b, slot)))
    return { free: false, reason: "the interviewer's calendar is busy then" };
  return { free: true, reason: null };
}
