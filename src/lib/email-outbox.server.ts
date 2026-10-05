/**
 * Durable email outbox for candidate communications.
 *
 * Trigger points enqueue rows here (cheap insert, idempotency-key deduped) and
 * /api/public/process-email-outbox drains them through sendTemplateEmail with
 * retries + backoff. Per-org toggles live in email_settings (defaults = all on).
 * Server-only.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  emailOutbox,
  emailSettings,
  organizations,
  type EmailOutboxAttachment,
  type EmailOutboxKind,
  type EmailOutboxStatus,
} from "@db/schema";
import { sendTemplateEmail } from "./email-templates/send-email";
import { DEFAULT_EMAIL_SETTINGS, type EmailSettingsEffective } from "./email-settings.shared";

const MAX_ATTEMPTS = 5;
const ACK_HOURLY_CAP = 50;
const CLAIM_LEASE_MINUTES = 5;

const KIND_TOGGLE: Record<
  EmailOutboxKind,
  "ackEnabled" | "stageEnabled" | "interviewEnabled" | "offerEnabled"
> = {
  ack: "ackEnabled",
  stage_update: "stageEnabled",
  interview_invite: "interviewEnabled",
  offer_released: "offerEnabled",
};

export async function getOrgEmailSettings(orgId: string): Promise<EmailSettingsEffective> {
  const [row] = await db
    .select()
    .from(emailSettings)
    .where(eq(emailSettings.orgId, orgId))
    .limit(1);
  if (!row) return DEFAULT_EMAIL_SETTINGS;
  return {
    enabled: row.enabled,
    ackEnabled: row.ackEnabled,
    stageEnabled: row.stageEnabled,
    interviewEnabled: row.interviewEnabled,
    offerEnabled: row.offerEnabled,
    replyTo: row.replyTo,
    timezone: row.timezone,
  };
}

/** Formats a date for email copy in the org's timezone; falls back to UTC on a bad tz. */
export function formatInOrgTZ(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return `${date.toUTCString()} (UTC)`;
  }
}

async function resolveReplyTo(
  orgId: string,
  settings: EmailSettingsEffective,
): Promise<string | null> {
  if (settings.replyTo) return settings.replyTo;
  const [org] = await db
    .select({ careersEmail: organizations.careersEmail })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return org?.careersEmail ?? null;
}

/** Marks queued stage updates superseded by a newer one for the same applications. */
async function supersedeQueuedStageUpdates(applicationIds: string[]): Promise<void> {
  if (!applicationIds.length) return;
  await db
    .update(emailOutbox)
    .set({ status: "suppressed", lastError: "superseded by a newer stage update" })
    .where(
      and(
        inArray(emailOutbox.applicationId, applicationIds),
        eq(emailOutbox.kind, "stage_update"),
        eq(emailOutbox.status, "queued"),
      ),
    );
}

export interface EnqueueEmailInput {
  orgId: string;
  kind: EmailOutboxKind;
  templateName: string;
  toEmail: string;
  applicationId?: string | null;
  templateData?: Record<string, string | undefined>;
  attachments?: EmailOutboxAttachment[];
  idempotencyKey: string;
  availableAt?: Date;
}

export async function enqueueEmail(input: EnqueueEmailInput): Promise<void> {
  const to = input.toEmail.trim().toLowerCase();
  if (!to) return;

  const settings = await getOrgEmailSettings(input.orgId);
  if (!settings.enabled || !settings[KIND_TOGGLE[input.kind]]) return;

  let status: EmailOutboxStatus = "queued";
  if (input.kind === "ack") {
    // Public apply endpoint — cap acks per org per hour so abuse lands as
    // suppressed rows instead of a send storm.
    const [ackRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.orgId, input.orgId),
          eq(emailOutbox.kind, "ack"),
          gte(emailOutbox.createdAt, new Date(Date.now() - 3_600_000)),
        ),
      );
    if ((ackRow?.count ?? 0) >= ACK_HOURLY_CAP) status = "suppressed";
  }

  if (input.kind === "stage_update" && input.applicationId) {
    await supersedeQueuedStageUpdates([input.applicationId]);
  }

  await db
    .insert(emailOutbox)
    .values({
      orgId: input.orgId,
      applicationId: input.applicationId ?? null,
      kind: input.kind,
      templateName: input.templateName,
      toEmail: to,
      replyTo: await resolveReplyTo(input.orgId, settings),
      templateData: input.templateData ?? {},
      attachments: input.attachments ?? [],
      idempotencyKey: input.idempotencyKey,
      availableAt: input.availableAt ?? new Date(),
      status,
    })
    .onConflictDoNothing({ target: emailOutbox.idempotencyKey });

  void processEmailOutbox().catch(() => {});
}

export interface StageUpdateEmailRow {
  applicationId: string;
  toEmail: string;
  templateData: Record<string, string | undefined>;
  idempotencyKey: string;
}

/** Batched stage-update enqueue (used by bulk moves and single transitions). */
export async function enqueueStageUpdates(
  rows: StageUpdateEmailRow[],
  ctx: { orgId: string; settings?: EmailSettingsEffective },
): Promise<void> {
  const valid = rows.filter((r) => r.toEmail && r.toEmail.trim());
  if (!valid.length) return;

  const settings = ctx.settings ?? (await getOrgEmailSettings(ctx.orgId));
  if (!settings.enabled || !settings.stageEnabled) return;
  const replyTo = await resolveReplyTo(ctx.orgId, settings);

  await supersedeQueuedStageUpdates(valid.map((r) => r.applicationId));

  await db
    .insert(emailOutbox)
    .values(
      valid.map((r) => ({
        orgId: ctx.orgId,
        applicationId: r.applicationId,
        kind: "stage_update" as const,
        templateName: "stage_update",
        toEmail: r.toEmail.trim().toLowerCase(),
        replyTo,
        templateData: r.templateData,
        attachments: [] as EmailOutboxAttachment[],
        idempotencyKey: r.idempotencyKey,
      })),
    )
    .onConflictDoNothing({ target: emailOutbox.idempotencyKey });

  void processEmailOutbox({ max: 50 }).catch(() => {});
}

export interface OutboxRunCounts {
  sent: number;
  suppressed: number;
  failed: number;
  deferred: number;
}

/**
 * Claims up to `max` due rows by pushing available_at forward (crash-safe: an
 * interrupted run simply leaves the row due again), then sends each one.
 */
export async function processEmailOutbox(opts: { max?: number } = {}): Promise<OutboxRunCounts> {
  const max = Math.min(Math.max(opts.max ?? 25, 1), 100);

  const dueIds = db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.status, "queued"), lte(emailOutbox.availableAt, new Date())))
    .orderBy(emailOutbox.createdAt)
    .limit(max)
    .for("update", { skipLocked: true });

  const claimed = await db
    .update(emailOutbox)
    .set({ availableAt: new Date(Date.now() + CLAIM_LEASE_MINUTES * 60_000) })
    .where(inArray(emailOutbox.id, dueIds))
    .returning();

  const counts: OutboxRunCounts = { sent: 0, suppressed: 0, failed: 0, deferred: 0 };

  for (const row of claimed) {
    try {
      await sendTemplateEmail(row.templateName, row.toEmail, {
        templateData: row.templateData,
        idempotencyKey: `outbox:${row.id}`,
        ...(row.replyTo ? { replyTo: row.replyTo } : {}),
        ...(row.attachments.length ? { attachments: row.attachments } : {}),
      });
      await db
        .update(emailOutbox)
        .set({ status: "sent", sentAt: new Date(), lastError: null })
        .where(eq(emailOutbox.id, row.id));
      counts.sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const isFinal = attempts >= MAX_ATTEMPTS;
      await db
        .update(emailOutbox)
        .set({
          attempts,
          lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500),
          status: isFinal ? "failed" : "queued",
          ...(isFinal
            ? {}
            : { availableAt: new Date(Date.now() + Math.min(2 ** attempts, 60) * 60_000) }),
        })
        .where(eq(emailOutbox.id, row.id));
      if (isFinal) counts.failed++;
      else counts.deferred++;
    }
  }

  return counts;
}
