/**
 * Service SLOs at run time: persists each instance's per-minute request SLI
 * counts, computes SLIs / error budgets for the platform "Service health"
 * page, and raises multi-window burn-rate alerts (definitions: src/server/slo.ts).
 *
 * Alerts go to the platform's channels — the same ones agent issues use, at
 * platform rather than organisation level:
 *  - e-mail to every platform admin (member_reminder template, as agent alerts);
 *  - an optional signed webhook (PLATFORM_ALERT_WEBHOOK_URL, HMAC-SHA256 with
 *    PLATFORM_ALERT_WEBHOOK_SECRET in `X-ATSAgent-Signature`, as agent alerts);
 *  - an ERROR log line `slo.burn_alert` that a Cloud Monitoring log-based alert
 *    policy pages on (infra/monitoring/);
 *  - an `audit_log` row.
 * Alerts carry the SLO id, severity and burn rate only — no tenant data.
 */
import { hostname } from "node:os";
import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { db } from "./db";
import { env } from "./env";
import { writeAudit } from "./audit";
import { log } from "./log";
import { safeFetch } from "./safe-fetch";
import {
  DURATION_BUCKETS,
  drainClosedSliMinutes,
  putBackSliMinutes,
  type SliMinute,
} from "./http-metrics";
import {
  BURN_ALERTS,
  MIN_EVENTS_FOR_BURN,
  SLOS,
  budgetRemaining,
  burnRate,
  firingBurnAlert,
  sliRatio,
  type BurnSeverity,
  type Counts,
  type Slo,
  type SloId,
} from "./slo";
import { agentRuns, platformAdmins, serviceRequestMinutes, sloAlerts } from "@db/schema";

const RETENTION_DAYS = 35;
export const INSTANCE_ID = `${hostname().slice(0, 60)}-${Math.random().toString(16).slice(2, 8)}`;

/* ------------------------------------------------------------ persistence */

let lastPrune = 0;

/** Write this instance's closed minutes. Never throws; failed rows are kept for the next try. */
export async function flushRequestMinutes(now = Date.now()): Promise<number> {
  const rows = drainClosedSliMinutes(now);
  if (!rows.length) return 0;
  try {
    await writeMinutes(rows);
  } catch (e) {
    putBackSliMinutes(rows);
    log.warn("slo.flush_failed", { error: e instanceof Error ? e : String(e) });
    return 0;
  }
  if (now - lastPrune > 3_600_000) {
    lastPrune = now;
    try {
      await db
        .delete(serviceRequestMinutes)
        .where(lt(serviceRequestMinutes.minute, new Date(now - RETENTION_DAYS * 86_400_000)));
    } catch (e) {
      log.warn("slo.prune_failed", { error: e instanceof Error ? e : String(e) });
    }
  }
  return rows.length;
}

export async function writeMinutes(rows: SliMinute[], instanceId = INSTANCE_ID): Promise<void> {
  await db
    .insert(serviceRequestMinutes)
    .values(
      rows.map((m) => ({
        minute: new Date(m.minute),
        instanceId,
        routeGroup: m.routeGroup,
        requests: m.requests,
        errors: m.errors,
        slow: m.slow,
        latency: m.latency,
      })),
    )
    .onConflictDoUpdate({
      target: [
        serviceRequestMinutes.minute,
        serviceRequestMinutes.instanceId,
        serviceRequestMinutes.routeGroup,
      ],
      set: {
        requests: sql`${serviceRequestMinutes.requests} + excluded.requests`,
        errors: sql`${serviceRequestMinutes.errors} + excluded.errors`,
        slow: sql`${serviceRequestMinutes.slow} + excluded.slow`,
        latency: sql`(select coalesce(array_agg(coalesce(a, 0) + coalesce(b, 0) order by i), '{}')
          from unnest(${serviceRequestMinutes.latency}, excluded.latency) with ordinality as u(a, b, i))`,
      },
    });
}

let flusher: ReturnType<typeof setInterval> | undefined;

/** Start the once-a-minute flush for this process (idempotent; never keeps the process alive). */
export function startSliFlusher(): void {
  if (flusher) return;
  flusher = setInterval(() => void flushRequestMinutes(), 60_000);
  (flusher as { unref?: () => void }).unref?.();
}

/* ------------------------------------------------------------- SLI counts */

const since = (minutes: number, now: number) => new Date(now - minutes * 60_000);

async function requestCounts(
  routeGroup: string,
  minutes: number,
  now: number,
): Promise<{ total: number; errors: number; slow: number }> {
  const [r] = await db
    .select({
      total: sql<number>`coalesce(sum(${serviceRequestMinutes.requests}), 0)::int`,
      errors: sql<number>`coalesce(sum(${serviceRequestMinutes.errors}), 0)::int`,
      slow: sql<number>`coalesce(sum(${serviceRequestMinutes.slow}), 0)::int`,
    })
    .from(serviceRequestMinutes)
    .where(
      and(
        eq(serviceRequestMinutes.routeGroup, routeGroup),
        gte(serviceRequestMinutes.minute, since(minutes, now)),
      ),
    );
  return {
    total: Number(r?.total ?? 0),
    errors: Number(r?.errors ?? 0),
    slow: Number(r?.slow ?? 0),
  };
}

async function agentRunCounts(minutes: number, now: number): Promise<Counts> {
  const [r] = await db
    .select({
      total: sql<number>`count(*)::int`,
      bad: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')::int`,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.mode, "live"),
        isNotNull(agentRuns.finishedAt),
        inArray(agentRuns.status, ["done", "failed", "cancelled"]),
        gte(agentRuns.finishedAt, since(minutes, now)),
      ),
    );
  return { total: Number(r?.total ?? 0), bad: Number(r?.bad ?? 0) };
}

/** Good/bad event counts for one SLO over the last `minutes`. */
export async function sloCounts(id: SloId, minutes: number, now = Date.now()): Promise<Counts> {
  if (id === "agent_run_success") return agentRunCounts(minutes, now);
  const c = await requestCounts("server_fn", minutes, now);
  return { total: c.total, bad: id === "server_fn_availability" ? c.errors : c.slow };
}

/** Approximate percentile (upper bucket bound, seconds) from summed latency histograms. */
export function percentileFromBuckets(latency: number[], q: number): number | null {
  const total = latency.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let cum = 0;
  for (let i = 0; i < latency.length; i++) {
    cum += latency[i] ?? 0;
    if (cum >= q * total) return i < DURATION_BUCKETS.length ? DURATION_BUCKETS[i]! : Infinity;
  }
  return Infinity;
}

/* ------------------------------------------------------------ panel data */

export type ServiceHealth = {
  generatedAt: string;
  slos: {
    id: SloId;
    name: string;
    sli: string;
    target: number;
    windowDays: number;
    events: number;
    badEvents: number;
    /** Good-event ratio over the SLO window; null with no events. */
    sli30d: number | null;
    budgetRemaining: number | null;
    burn: { label: string; minutes: number; rate: number | null; events: number }[];
    alert: { severity: string; burnRate: number; openedAt: string } | null;
  }[];
  routeGroups: {
    routeGroup: string;
    requests24h: number;
    errors24h: number;
    p95Seconds1h: number | null;
    p95Seconds24h: number | null;
  }[];
  thresholds: { burnAlerts: typeof BURN_ALERTS; minEvents: number };
  recentAlerts: {
    slo: string;
    severity: string;
    status: string;
    burnRate: number;
    openedAt: string;
    resolvedAt: string | null;
  }[];
};

const BURN_WINDOWS = [
  { label: "5 min", minutes: 5 },
  { label: "1 h", minutes: 60 },
  { label: "6 h", minutes: 360 },
  { label: "24 h", minutes: 1440 },
];

export async function serviceHealthData(now = Date.now()): Promise<ServiceHealth> {
  const open = await db.select().from(sloAlerts).where(eq(sloAlerts.status, "open"));
  const slos: ServiceHealth["slos"] = [];
  for (const s of SLOS) {
    const window = await sloCounts(s.id, s.windowDays * 1440, now);
    const burn = [];
    for (const w of BURN_WINDOWS) {
      const c = await sloCounts(s.id, w.minutes, now);
      burn.push({
        label: w.label,
        minutes: w.minutes,
        rate: burnRate(c, s.target),
        events: c.total,
      });
    }
    const a = open.find((o) => o.slo === s.id);
    slos.push({
      id: s.id,
      name: s.name,
      sli: s.sli,
      target: s.target,
      windowDays: s.windowDays,
      events: window.total,
      badEvents: window.bad,
      sli30d: sliRatio(window),
      budgetRemaining: budgetRemaining(window, s.target),
      burn,
      alert: a
        ? { severity: a.severity, burnRate: a.burnRate, openedAt: a.openedAt.toISOString() }
        : null,
    });
  }

  const day = since(1440, now).toISOString();
  const hour = since(60, now).toISOString();
  const groupRows = (await db.execute(sql`
    select route_group, sum(requests)::int as requests, sum(errors)::int as errors
    from service_request_minutes
    where minute >= ${day}::timestamptz
    group by route_group
    order by route_group`)) as unknown as {
    route_group: string;
    requests: number;
    errors: number;
  }[];
  const latencyRows = (await db.execute(sql`
    select route_group, minute >= ${hour}::timestamptz as last_hour, latency
    from service_request_minutes
    where minute >= ${day}::timestamptz`)) as unknown as {
    route_group: string;
    last_hour: boolean;
    latency: number[];
  }[];
  const sum = (rows: typeof latencyRows) => {
    const out = [...DURATION_BUCKETS.map(() => 0), 0];
    for (const r of rows) (r.latency ?? []).forEach((v, i) => (out[i] = (out[i] ?? 0) + Number(v)));
    return out;
  };
  const finite = (v: number | null) => (v == null ? null : Number.isFinite(v) ? v : 60);
  const routeGroups = groupRows.map((g) => {
    const mine = latencyRows.filter((r) => r.route_group === g.route_group);
    return {
      routeGroup: g.route_group,
      requests24h: Number(g.requests),
      errors24h: Number(g.errors),
      p95Seconds1h: finite(percentileFromBuckets(sum(mine.filter((r) => r.last_hour)), 0.95)),
      p95Seconds24h: finite(percentileFromBuckets(sum(mine), 0.95)),
    };
  });

  const recent = await db
    .select()
    .from(sloAlerts)
    .where(gte(sloAlerts.openedAt, since(30 * 1440, now)))
    .orderBy(sql`${sloAlerts.openedAt} desc`)
    .limit(20);

  return {
    generatedAt: new Date(now).toISOString(),
    slos,
    routeGroups,
    thresholds: { burnAlerts: BURN_ALERTS, minEvents: MIN_EVENTS_FOR_BURN },
    recentAlerts: recent.map((r) => ({
      slo: r.slo,
      severity: r.severity,
      status: r.status,
      burnRate: r.burnRate,
      openedAt: r.openedAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    })),
  };
}

/* ---------------------------------------------------------- burn alerting */

const RANK: Record<string, number> = { serious: 1, critical: 2 };

export type SloEvalCounts = {
  opened: number;
  escalated: number;
  resolved: number;
  notified: number;
};

/**
 * Evaluate every SLO's burn-rate alerts: open (or escalate) an alert when both
 * windows burn too fast, resolve it once nothing fires. Runs with the agent
 * health engine (every few minutes, scheduler tick). Idempotent.
 */
export async function evaluateSloBurn(now = Date.now()): Promise<SloEvalCounts> {
  // Count this instance's finished minutes before judging.
  await flushRequestMinutes(now);
  const out: SloEvalCounts = { opened: 0, escalated: 0, resolved: 0, notified: 0 };
  for (const s of SLOS) {
    const cache = new Map<number, Counts>();
    for (const a of BURN_ALERTS)
      for (const m of [a.longMinutes, a.shortMinutes])
        if (!cache.has(m)) cache.set(m, await sloCounts(s.id, m, now));
    const fire = firingBurnAlert(s.target, (m) => cache.get(m) ?? { total: 0, bad: 0 });
    const [current] = await db
      .select()
      .from(sloAlerts)
      .where(and(eq(sloAlerts.slo, s.id), eq(sloAlerts.status, "open")))
      .limit(1);

    if (!fire) {
      if (current) {
        await db
          .update(sloAlerts)
          .set({ status: "resolved", resolvedAt: new Date(now) })
          .where(eq(sloAlerts.id, current.id));
        log.info("slo.burn_resolved", { slo: s.id, severity: current.severity });
        out.resolved++;
      }
      continue;
    }

    let alertId: string;
    let notify = false;
    if (!current) {
      const [row] = await db
        .insert(sloAlerts)
        .values({
          slo: s.id,
          severity: fire.severity,
          burnRate: fire.longBurn,
          windowMinutes: fire.windowMinutes,
          openedAt: new Date(now),
          lastSeenAt: new Date(now),
        })
        .onConflictDoNothing()
        .returning({ id: sloAlerts.id });
      if (!row) continue; // another instance opened it
      alertId = row.id;
      notify = true;
      out.opened++;
    } else {
      alertId = current.id;
      const escalate = (RANK[fire.severity] ?? 0) > (RANK[current.severity] ?? 0);
      await db
        .update(sloAlerts)
        .set({
          lastSeenAt: new Date(now),
          burnRate: fire.longBurn,
          ...(escalate
            ? { severity: fire.severity, windowMinutes: fire.windowMinutes, notifiedAt: null }
            : {}),
        })
        .where(eq(sloAlerts.id, current.id));
      if (escalate) out.escalated++;
      notify = escalate || !current.notifiedAt;
    }
    if (
      notify &&
      (await notifySloAlert(alertId, s, fire.severity, fire.longBurn, fire.windowMinutes))
    )
      out.notified++;
  }
  return out;
}

export type SloAlertPayload = {
  type: "slo.burn";
  slo: { id: SloId; name: string; target: number; window_days: number };
  severity: BurnSeverity;
  burn_rate: number;
  window_minutes: number;
  url: string;
};

/** Push one alert to the platform channels, once (claimed via notified_at). */
async function notifySloAlert(
  alertId: string,
  s: Slo,
  severity: BurnSeverity,
  rate: number,
  windowMinutes: number,
): Promise<boolean> {
  const claimed = await db
    .update(sloAlerts)
    .set({ notifiedAt: new Date() })
    .where(and(eq(sloAlerts.id, alertId), sql`${sloAlerts.notifiedAt} is null`))
    .returning({ id: sloAlerts.id });
  if (!claimed.length) return false;

  const url = `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/platform-health`;
  const burn = Math.round(rate * 10) / 10;
  const channels: string[] = ["log"];
  // The log line is a channel in its own right: a log-based alert policy pages on it.
  log.error("slo.burn_alert", {
    slo: s.id,
    severity,
    burn_rate: burn,
    window_minutes: windowMinutes,
    target: s.target,
  });

  if (process.env["SMTP_URL"]) {
    const admins = await db.select({ email: platformAdmins.email }).from(platformAdmins);
    const { sendTemplateEmail } = await import("@/lib/email-templates/send-email");
    let sent = 0;
    for (const a of admins) {
      try {
        await sendTemplateEmail("member_reminder", a.email, {
          idempotencyKey: `slo-alert:${alertId}:${severity}:${a.email.toLowerCase()}`,
          templateData: {
            heading: `Service alert (${severity}): ${s.name}`.slice(0, 180),
            message: `${s.name} is spending its error budget ${burn}× faster than allowed over the last ${windowMinutes >= 60 ? `${windowMinutes / 60} h` : `${windowMinutes} min`} (target ${(s.target * 100).toFixed(1)} % over ${s.windowDays} days). Check Service health and the request logs for the failing route group.`,
            actionUrl: url,
          },
        });
        sent++;
      } catch (e) {
        log.warn("slo.alert.email_failed", { error: e instanceof Error ? e : String(e) });
      }
    }
    if (sent) channels.push("email");
  }

  const hook = process.env["PLATFORM_ALERT_WEBHOOK_URL"];
  if (hook) {
    const payload: SloAlertPayload = {
      type: "slo.burn",
      slo: { id: s.id, name: s.name, target: s.target, window_days: s.windowDays },
      severity,
      burn_rate: burn,
      window_minutes: windowMinutes,
      url,
    };
    const body = JSON.stringify(payload);
    const secret = process.env["PLATFORM_ALERT_WEBHOOK_SECRET"];
    try {
      const { signAlert } = await import("./agents/alerts.server");
      const res = await safeFetch(hook, {
        method: "POST",
        body,
        timeoutMs: 8_000,
        headers: {
          "content-type": "application/json",
          ...(secret ? { "x-atsagent-signature": signAlert(body, secret) } : {}),
        },
      });
      channels.push(res.ok ? "webhook" : `webhook:${res.status}`);
    } catch (e) {
      log.warn("slo.alert.webhook_failed", { error: e instanceof Error ? e : String(e) });
      channels.push("webhook:failed");
    }
  }

  await writeAudit({
    actor: "system:slo",
    action: "slo.alert.notified",
    entityType: "slo_alert",
    entityId: alertId,
    detail: { slo: s.id, severity, burn_rate: burn, window_minutes: windowMinutes, channels },
  });
  return true;
}
