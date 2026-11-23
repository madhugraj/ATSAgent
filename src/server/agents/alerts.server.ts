/**
 * Alert delivery for agent health issues (docs/agentic-plan.md §9.3, Phase 5).
 *
 * The bell already shows serious and critical issues to HR leadership while
 * they are open. This adds push channels:
 *  - e-mail to the org owner, HR heads and CBOs (on by default): critical
 *    issues straight away, at most once per rule per day; everything serious
 *    or critical still open goes in one end-of-day table per person
 *    (`dispatchAgentDigests`, after DIGEST_HOUR in the org's time zone);
 *  - an optional signed webhook (HMAC-SHA256 over the body, header
 *    `X-ATSAgent-Signature: sha256=<hex>`) for the org's own paging / chat.
 * Alerts carry ids, the rule and a short title — never candidate content.
 */
import { createHmac } from "node:crypto";
import { and, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { db } from "../db";
import { env } from "../env";
import { writeAudit } from "../audit";
import { decryptSecret } from "../crypto";
import { log } from "../log";
import { safeFetch } from "../safe-fetch";
import {
  agentIssues,
  agentTelemetrySettings,
  emailOutbox,
  orgMembers,
  organizations,
  userRoles,
} from "@db/schema";

const ALERT_ROLES = ["hr_head", "president_cbo"] as const;
const MAX_PER_PASS = 50;
/** Local hour (org time zone) from which the day's digest goes out. */
export const DIGEST_HOUR = 18;
/** A critical rule already e-mailed within this window is not e-mailed again. */
const CRITICAL_REPEAT_HOURS = 24;

export type AlertPayload = {
  type: "agent.issue.opened";
  org_id: string;
  issue: {
    id: string;
    rule: string;
    element: string;
    agent: string;
    severity: string;
    title: string;
    first_seen_at: string;
  };
  url: string;
};

export function signAlert(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** People who receive alert e-mail: active owners, HR heads and CBOs of the org. */
export async function alertRecipients(
  orgId: string,
): Promise<{ email: string; name: string | null }[]> {
  const leaders = db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(and(eq(userRoles.orgId, orgId), inArray(userRoles.role, [...ALERT_ROLES])));
  const rows = await db
    .select({ email: orgMembers.email, name: orgMembers.fullName })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.status, "active"),
        or(eq(orgMembers.isOwner, true), inArray(orgMembers.userId, leaders)),
      ),
    );
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = r.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Send alerts for serious / critical issues not yet alerted. Idempotent per issue. */
export async function dispatchAgentAlerts(
  opts: { orgId?: string } = {},
): Promise<{ alerted: number }> {
  const issues = await db
    .select()
    .from(agentIssues)
    .where(
      and(
        opts.orgId ? eq(agentIssues.orgId, opts.orgId) : undefined,
        eq(agentIssues.status, "open"),
        inArray(agentIssues.severity, ["serious", "critical"]),
        isNull(agentIssues.notifiedAt),
      ),
    )
    .limit(MAX_PER_PASS);
  let alerted = 0;
  const base = env.PUBLIC_SITE_URL.replace(/\/$/, "");
  for (const issue of issues) {
    // Claim first so two schedulers never alert twice.
    const claimed = await db
      .update(agentIssues)
      .set({ notifiedAt: new Date() })
      .where(and(eq(agentIssues.id, issue.id), isNull(agentIssues.notifiedAt)))
      .returning({ id: agentIssues.id });
    if (!claimed.length) continue;

    const [settings] = await db
      .select()
      .from(agentTelemetrySettings)
      .where(eq(agentTelemetrySettings.orgId, issue.orgId))
      .limit(1);
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, issue.orgId))
      .limit(1);
    const url = `${base}/agents/observability`;
    const who = issue.agentType === "*" ? "Orchestrator" : `The ${issue.agentType} agent`;
    const channels: string[] = [];

    // Serious issues wait for the end-of-day digest; a critical one goes now,
    // unless the same rule was already e-mailed today (a flapping issue).
    const repeat =
      issue.severity === "critical" &&
      (
        await db
          .select({ id: agentIssues.id })
          .from(agentIssues)
          .where(
            and(
              eq(agentIssues.orgId, issue.orgId),
              eq(agentIssues.rule, issue.rule),
              ne(agentIssues.id, issue.id),
              gte(agentIssues.notifiedAt, new Date(Date.now() - CRITICAL_REPEAT_HOURS * 3_600_000)),
            ),
          )
          .limit(1)
      ).length > 0;
    if (settings?.alertEmailEnabled !== false && issue.severity === "critical" && !repeat) {
      const { enqueueEmail } = await import("@/lib/email-outbox.server");
      for (const r of await alertRecipients(issue.orgId)) {
        await enqueueEmail({
          orgId: issue.orgId,
          kind: "member_reminder",
          templateName: "member_reminder",
          toEmail: r.email,
          idempotencyKey: `agent-issue:${issue.id}:${r.email.toLowerCase()}`,
          templateData: {
            memberName: r.name ?? undefined,
            orgName: org?.name ?? undefined,
            heading: `Agent alert (${issue.severity}): ${issue.title}`.slice(0, 180),
            message: `${who} — ${issue.rule}. Review it on Agent observability and acknowledge it once handled.`,
            actionUrl: url,
          },
        });
      }
      channels.push("email");
    }

    if (settings?.alertWebhookUrl) {
      const payload: AlertPayload = {
        type: "agent.issue.opened",
        org_id: issue.orgId,
        issue: {
          id: issue.id,
          rule: issue.rule,
          element: issue.element,
          agent: issue.agentType,
          severity: issue.severity,
          title: issue.title,
          first_seen_at: issue.firstSeenAt.toISOString(),
        },
        url,
      };
      const body = JSON.stringify(payload);
      const secret = decryptSecret(settings.alertWebhookSecretEnc);
      try {
        const res = await safeFetch(settings.alertWebhookUrl, {
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
        log.warn("agent.alert.webhook_failed", {
          org_id: issue.orgId,
          error: e instanceof Error ? e : String(e),
        });
        channels.push("webhook:failed");
      }
    }

    await writeAudit({
      actor: "system:agent-health",
      orgId: issue.orgId,
      action: "agent.issue.alerted",
      entityType: "agent_issue",
      entityId: issue.id,
      detail: { rule: issue.rule, severity: issue.severity, channels },
    });
    alerted++;
  }
  return { alerted };
}

/** "YYYY-MM-DD" and hour of `now` in the time zone (UTC on a bad zone). */
export function localDayHour(now: Date, timeZone: string): { day: string; hour: number } {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt(timeZone);
  } catch {
    parts = fmt("UTC");
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/**
 * End-of-day summary: one e-mail per person per organisation, sent once per
 * local day after DIGEST_HOUR. The owner, HR heads and CBOs get a table of
 * every serious / critical agent issue still open; anyone an agent reminded
 * that day (remind_member, parked as `held` outbox rows) gets a "waiting for
 * you" table. Nothing to say, nothing sent. Idempotent (outbox key per day).
 */
export async function dispatchAgentDigests(
  now = new Date(),
  opts: { orgId?: string } = {},
): Promise<{ digests: number }> {
  const withIssues = await db
    .selectDistinct({ orgId: agentIssues.orgId })
    .from(agentIssues)
    .where(
      and(
        opts.orgId ? eq(agentIssues.orgId, opts.orgId) : undefined,
        ne(agentIssues.status, "resolved"),
        inArray(agentIssues.severity, ["serious", "critical"]),
      ),
    );
  const withReminders = await db
    .selectDistinct({ orgId: emailOutbox.orgId })
    .from(emailOutbox)
    .where(
      and(
        opts.orgId ? eq(emailOutbox.orgId, opts.orgId) : undefined,
        eq(emailOutbox.status, "held"),
        sql`${emailOutbox.idempotencyKey} like 'reminder:%'`,
      ),
    );
  const orgIds = [...new Set([...withIssues, ...withReminders].map((o) => o.orgId))];
  if (!orgIds.length) return { digests: 0 };
  const { enqueueEmail, getOrgEmailSettings, formatInOrgTZ } =
    await import("@/lib/email-outbox.server");
  const base = env.PUBLIC_SITE_URL.replace(/\/$/, "");
  let digests = 0;
  for (const orgId of orgIds) {
    const emailSettings = await getOrgEmailSettings(orgId);
    const tz = emailSettings.timezone || "UTC";
    const { day, hour } = localDayHour(now, tz);
    if (hour < DIGEST_HOUR || !emailSettings.enabled) continue;
    const prefix = `agent-digest:${orgId}:${day}:`;
    const [already] = await db
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(
        and(eq(emailOutbox.orgId, orgId), sql`${emailOutbox.idempotencyKey} like ${`${prefix}%`}`),
      )
      .limit(1);
    if (already) continue;

    const [settings] = await db
      .select({ on: agentTelemetrySettings.alertEmailEnabled })
      .from(agentTelemetrySettings)
      .where(eq(agentTelemetrySettings.orgId, orgId))
      .limit(1);
    const issues =
      settings?.on === false
        ? []
        : await db
            .select()
            .from(agentIssues)
            .where(
              and(
                eq(agentIssues.orgId, orgId),
                ne(agentIssues.status, "resolved"),
                inArray(agentIssues.severity, ["serious", "critical"]),
              ),
            );
    issues.sort(
      (a, b) =>
        (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1) ||
        a.firstSeenAt.getTime() - b.firstSeenAt.getTime(),
    );
    const { AGENT_LABEL } = await import("@/lib/agents.catalog");
    const short = (d: Date) => {
      try {
        return new Intl.DateTimeFormat("en-GB", {
          timeZone: tz,
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(d);
      } catch {
        return formatInOrgTZ(d, tz);
      }
    };
    const issueRows = issues.slice(0, 40).map((i) => ({
      severity: i.severity,
      agent:
        i.agentType === "*"
          ? "Orchestrator"
          : (AGENT_LABEL[i.agentType] ?? i.agentType.replace(/_/g, " ")),
      title: i.title.slice(0, 200),
      since: short(i.firstSeenAt),
    }));
    let dayLabel = day;
    try {
      dayLabel = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(now);
    } catch {
      /* keep ISO day */
    }
    const held = await db
      .select()
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.orgId, orgId),
          eq(emailOutbox.status, "held"),
          sql`${emailOutbox.idempotencyKey} like 'reminder:%'`,
        ),
      );

    const people = new Map<string, { name: string | null; issues: boolean }>();
    if (issueRows.length)
      for (const r of await alertRecipients(orgId))
        people.set(r.email.toLowerCase(), { name: r.name, issues: true });
    for (const h of held)
      if (!people.has(h.toEmail))
        people.set(h.toEmail, { name: h.templateData?.["memberName"] ?? null, issues: false });
    if (!people.size) continue;

    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    for (const [email, p] of people) {
      const mine = held
        .filter((h) => h.toEmail === email)
        .slice(0, 40)
        .map((h) => ({
          heading: (h.templateData?.["heading"] ?? "").slice(0, 180),
          message: (h.templateData?.["message"] ?? "").slice(0, 400),
          url: h.templateData?.["actionUrl"] ?? "",
        }));
      const rowsForMe = p.issues ? issueRows : [];
      if (!mine.length && !rowsForMe.length) continue;
      const parts = [
        mine.length ? `${mine.length} waiting for you` : "",
        rowsForMe.length
          ? `${rowsForMe.length} agent issue${rowsForMe.length === 1 ? "" : "s"}`
          : "",
      ].filter(Boolean);
      await enqueueEmail({
        orgId,
        kind: "member_reminder",
        templateName: "agent_digest",
        toEmail: email,
        idempotencyKey: `${prefix}${email}`,
        templateData: {
          memberName: p.name ?? undefined,
          orgName: org?.name ?? undefined,
          heading: `Today at ${org?.name ?? "your organisation"}: ${parts.join(", ")}`,
          dayLabel,
          issuesJson: JSON.stringify(rowsForMe),
          remindersJson: JSON.stringify(mine),
          actionUrl: rowsForMe.length ? `${base}/agents/observability` : `${base}/`,
        },
      });
    }
    // The reminders now travel in the summary; never send them on their own.
    if (held.length)
      await db
        .update(emailOutbox)
        .set({ status: "suppressed" })
        .where(
          inArray(
            emailOutbox.id,
            held.map((h) => h.id),
          ),
        );
    await writeAudit({
      actor: "system:agent-health",
      orgId,
      action: "agent.issue.digest",
      entityType: "organization",
      entityId: orgId,
      detail: { day, issues: issues.length, reminders: held.length, people: people.size },
    });
    digests++;
  }
  return { digests };
}

/**
 * "Send a test alert e-mail" in Agent settings: the same message, channel and
 * recipients as a real alert, marked as a test; audited. Org-scoped.
 */
export async function sendTestAlertEmail(ctx: {
  orgId: string;
  userId: string;
  memberEmail: string;
  alertEmailEnabled: boolean;
}): Promise<{ ok: boolean; message: string }> {
  if (!ctx.alertEmailEnabled)
    return { ok: false, message: "Switch on alert e-mail and save first." };
  const { enqueueEmail, getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  if (!(await getOrgEmailSettings(ctx.orgId)).enabled)
    return {
      ok: false,
      message: "E-mail is switched off for this organisation (Settings → E-mail).",
    };
  const people = await alertRecipients(ctx.orgId);
  if (!people.length) return { ok: false, message: "No active owner, HR head or CBO to e-mail." };
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, ctx.orgId))
    .limit(1);
  const at = Date.now();
  for (const r of people)
    await enqueueEmail({
      orgId: ctx.orgId,
      kind: "member_reminder",
      templateName: "member_reminder",
      toEmail: r.email,
      idempotencyKey: `agent-alert-test:${ctx.orgId}:${at}:${r.email.toLowerCase()}`,
      templateData: {
        memberName: r.name ?? undefined,
        orgName: org?.name ?? undefined,
        heading: "Agent alert (test): this is how serious agent issues reach you",
        message:
          "This is a test from Agent settings. When an agent health issue is serious or critical — for example a stuck run, repeated failures or a missing audit trail — the owner, HR heads and CBOs get one end-of-day table of open issues, and critical ones straight away. Nothing is wrong.",
        actionUrl: `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/agents/observability`,
      },
    });
  await writeAudit({
    actor: ctx.memberEmail,
    actorUserId: ctx.userId,
    orgId: ctx.orgId,
    action: "agent.alert.test_email",
    entityType: "agent_telemetry_settings",
    entityId: ctx.orgId,
    detail: { recipients: people.length },
  });
  return {
    ok: true,
    message: `Test alert queued for ${people.map((p) => p.email).join(", ")}; it is sent within a few minutes.`,
  };
}
