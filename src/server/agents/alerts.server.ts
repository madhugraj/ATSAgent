/**
 * Alert delivery for agent health issues (docs/agentic-plan.md §9.3, Phase 5).
 *
 * The bell already shows serious and critical issues to HR leadership while
 * they are open. This adds push channels, sent once per issue:
 *  - e-mail to the org owner, HR heads and CBOs (on by default);
 *  - an optional signed webhook (HMAC-SHA256 over the body, header
 *    `X-ATSAgent-Signature: sha256=<hex>`) for the org's own paging / chat.
 * Alerts carry ids, the rule and a short title — never candidate content.
 */
import { createHmac } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { db } from "../db";
import { env } from "../env";
import { writeAudit } from "../audit";
import { decryptSecret } from "../crypto";
import { log } from "../log";
import { safeFetch } from "../safe-fetch";
import {
  agentIssues,
  agentTelemetrySettings,
  orgMembers,
  organizations,
  userRoles,
} from "@db/schema";

const ALERT_ROLES = ["hr_head", "president_cbo"] as const;
const MAX_PER_PASS = 50;

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
export async function dispatchAgentAlerts(): Promise<{ alerted: number }> {
  const issues = await db
    .select()
    .from(agentIssues)
    .where(
      and(
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

    if (settings?.alertEmailEnabled !== false) {
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
          "This is a test from Agent settings. When an agent health issue is serious or critical — for example a stuck run, repeated failures or a missing audit trail — the owner, HR heads and CBOs get an e-mail like this once per issue. Nothing is wrong.",
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
