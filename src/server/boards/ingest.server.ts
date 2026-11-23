/**
 * Board application ingestion.
 *
 * One entry point for both transports — the public webhook route and the cron
 * poll — built on the same candidate-intake core the apply page and the
 * careers inbox use (parse → org-scoped dedupe merge → application + ack
 * mail). The raw delivery is persisted first with a dedupe key, so a vendor
 * redelivery can never file an applicant twice and a crashed intake can be
 * retried by board-sync.
 */
import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "../db";
import {
  applications,
  boardSyncState,
  boardWebhookEvents,
  organizations,
  orgProfiles,
  requisitionBoardPostings,
  requisitions,
  sourceIntegrations,
} from "@db/schema";
import { ingestCandidate, type ParsedCv } from "../../lib/intake.server";
import { getBoardAdapter, integrationForWebhookToken, loadBoardConnection } from "./registry";
import { deliveryEventId } from "./partner";
import type { BoardProviderId, NormalizedApplication } from "./types";

/** Headers worth keeping on the event row for forensics — never arbitrary. */
const KEPT_HEADERS = ["content-type", "user-agent", "x-indeed-signature", "x-naukri-signature"];

function keptHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of KEPT_HEADERS) {
    const value = headers.get(key);
    if (value) out[key] = value.slice(0, 500);
  }
  return out;
}

/** Parse the delivery body, tolerating non-JSON (kept as a wrapped string). */
async function payloadOf(rawBody: string): Promise<Record<string, unknown>> {
  const clipped = rawBody.slice(0, 500_000);
  try {
    const parsed = JSON.parse(clipped) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { body: parsed };
  } catch {
    return { raw: clipped.slice(0, 5000) };
  }
}

export type DeliveryOutcome = {
  status: "accepted" | "duplicate" | "rejected" | "stored";
  detail?: string;
};

/**
 * Handle one webhook delivery: authenticate, store raw, file the applicant.
 * Returns the outcome; HTTP mapping is the route's business (rejected → 401,
 * everything else → 200 so vendors stop retrying).
 */
export async function processBoardDelivery(input: {
  provider: string;
  token: string;
  headers: Headers;
  rawBody: string;
}): Promise<DeliveryOutcome> {
  const payload = await payloadOf(input.rawBody);

  const resolved = await integrationForWebhookToken(input.provider, input.token);
  if (!resolved) {
    // Keep unauthenticated traffic visible for forensics, bounded by the
    // public rate limiter; never process it.
    await db
      .insert(boardWebhookEvents)
      .values({
        dedupeKey: `${input.provider}:unknown:${deliveryEventId(null, input.rawBody)}`,
        orgId: null,
        provider: input.provider,
        externalEventId: deliveryEventId(null, input.rawBody),
        headers: keptHeaders(input.headers),
        payload,
        status: "failed",
        lastError: "unknown or disabled delivery token",
      })
      .onConflictDoNothing();
    return { status: "rejected", detail: "unknown delivery token" };
  }

  const provider = input.provider as BoardProviderId;
  const conn = await loadBoardConnection(resolved.orgId, provider);
  const adapter = getBoardAdapter(provider);
  const verdict = await adapter.verifyDelivery({
    conn,
    headers: input.headers,
    rawBody: input.rawBody,
  });
  if (!verdict.ok) {
    await db
      .insert(boardWebhookEvents)
      .values({
        dedupeKey: `${provider}:${resolved.orgId}:sig:${deliveryEventId(null, input.rawBody)}`,
        orgId: resolved.orgId,
        provider,
        externalEventId: deliveryEventId(null, input.rawBody),
        headers: keptHeaders(input.headers),
        payload,
        status: "failed",
        lastError: (verdict.reason ?? "signature verification failed").slice(0, 500),
      })
      .onConflictDoNothing();
    return { status: "rejected", detail: "verification failed" };
  }

  const normalized = await adapter.mapApplication(payload, conn);
  const externalEventId = deliveryEventId(normalized?.externalEventId ?? null, input.rawBody);
  const dedupeKey = `${provider}:${resolved.orgId}:${externalEventId}`;

  // The dedupe insert is the idempotency boundary — claim the event before
  // any intake work so concurrent redeliveries see the conflict instead of
  // racing each other into a double filing.
  const claimed = await db
    .insert(boardWebhookEvents)
    .values({
      dedupeKey,
      orgId: resolved.orgId,
      provider,
      externalEventId,
      headers: keptHeaders(input.headers),
      payload,
      status: "pending",
    })
    .onConflictDoNothing({ target: boardWebhookEvents.dedupeKey })
    .returning({ id: boardWebhookEvents.id });
  if (!claimed.length) return { status: "duplicate" };
  const eventId = claimed[0]!.id;

  if (!normalized) {
    await failEvent(eventId, "delivery payload could not be read as an application");
    return { status: "stored", detail: "unmappable payload" };
  }
  if (!normalized.postingExternalId) {
    await failEvent(eventId, "delivery does not name a job posting");
    return { status: "stored", detail: "no posting reference" };
  }

  // The vendor names only its own posting id — the requisition is resolved
  // server-side through our own syndication rows, org-scoped by construction.
  const [posting] = await db
    .select({
      id: requisitionBoardPostings.id,
      requisitionId: requisitionBoardPostings.requisitionId,
      title: requisitions.title,
    })
    .from(requisitionBoardPostings)
    .innerJoin(requisitions, eq(requisitions.id, requisitionBoardPostings.requisitionId))
    .where(
      and(
        eq(requisitionBoardPostings.orgId, resolved.orgId),
        eq(requisitionBoardPostings.provider, provider),
        eq(requisitionBoardPostings.externalId, normalized.postingExternalId),
      ),
    )
    .limit(1);
  if (!posting) {
    await failEvent(
      eventId,
      `no ATSIQ posting matches ${provider} job ${normalized.postingExternalId}`,
    );
    return { status: "stored", detail: "unknown posting" };
  }

  try {
    const filed = await fileNormalizedApplication({
      orgId: resolved.orgId,
      provider,
      requisitionId: posting.requisitionId,
      requisitionTitle: posting.title,
      normalized,
    });
    await db
      .update(boardWebhookEvents)
      .set({
        status: "processed",
        requisitionId: posting.requisitionId,
        candidateId: filed.candidateId,
        applicationId: filed.applicationId,
        processedAt: new Date(),
      })
      .where(eq(boardWebhookEvents.id, eventId));
    await db
      .update(requisitionBoardPostings)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(requisitionBoardPostings.id, posting.id));
    return { status: "accepted" };
  } catch (e) {
    await failEvent(eventId, e instanceof Error ? e.message : "intake failed");
    return { status: "stored", detail: "intake failed" };
  }
}

async function failEvent(eventId: string, reason: string): Promise<void> {
  await db
    .update(boardWebhookEvents)
    .set({
      status: "failed",
      lastError: reason.slice(0, 500),
      attempts: sql`${boardWebhookEvents.attempts} + 1`,
      processedAt: new Date(),
    })
    .where(eq(boardWebhookEvents.id, eventId));
}

/** Fetch a hosted resume, best-effort: plain first, OAuth retry on 401/403. */
async function resumeTextFromUrl(
  provider: BoardProviderId,
  orgId: string,
  url: string | null,
): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const { safeFetchText } = await import("../safe-fetch");
  try {
    const { text } = await safeFetchText(url, { hops: 1 });
    if (text.trim().length >= 80) return text;
  } catch {
    /* fall through to the authenticated retry */
  }
  // Hosted board documents usually need the employer token.
  try {
    const conn = await loadBoardConnection(orgId, provider);
    const { fetchClientToken } = await import("./partner");
    const token = await fetchClientToken(conn);
    const { safeFetchText } = await import("../safe-fetch");
    const { text } = await safeFetchText(url, {
      hops: 1,
      headers: { Authorization: `Bearer ${token}` },
    });
    return text.trim().length >= 80 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Push one normalised application through the shared intake core. Structured
 * deliveries without a resume are filed profile-only — they may complete an
 * existing record but never overwrite a stored CV with placeholder text.
 */
export async function fileNormalizedApplication(input: {
  orgId: string;
  provider: BoardProviderId;
  requisitionId: string;
  requisitionTitle: string;
  normalized: NormalizedApplication;
}): Promise<{ candidateId: string; applicationId: string | null; alreadyApplied: boolean }> {
  const resumeUrlText = await resumeTextFromUrl(
    input.provider,
    input.orgId,
    input.normalized.resumeUrl,
  );
  const resumeText = (input.normalized.resumeText ?? resumeUrlText)?.trim() || null;
  const structuredOnly = !resumeText;

  // Structured deliveries carry their own fields — hand them to the intake as
  // a pre-parsed CV so no model call runs on data that needs no extraction.
  let parsed: ParsedCv | null = null;
  if (structuredOnly) {
    const n = input.normalized;
    parsed = {
      full_name: n.fullName,
      email: n.email,
      phone: n.phone,
      location: n.location,
      experience_years: null,
      education: null,
      skills: null,
      linkedin_url: null,
      github_url: null,
      website_url: null,
      current_employer: null,
      suspected_prompt_injection: null,
      employment_history: null,
    };
  }

  const ingested = await ingestCandidate({
    resumeText: resumeText ?? "",
    fileName: `${input.provider}-application.txt`,
    requisitionId: input.requisitionId,
    orgId: input.orgId,
    source: input.provider,
    email: input.normalized.email,
    fullName: input.normalized.fullName,
    phone: input.normalized.phone,
    // Profile-only keeps a placeholder-profile delivery from overwriting a
    // stored CV with empty fields on merge.
    ...(structuredOnly ? { parsed, profileOnly: true } : {}),
  });

  // Ack the applicant exactly like the apply page does; the outbox idempotency
  // key keeps a retry from mailing twice.
  let applicationId: string | null = null;
  if (!ingested.emailMissing) {
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          eq(applications.candidateId, ingested.candidateId),
          eq(applications.requisitionId, input.requisitionId),
        ),
      )
      .limit(1);
    applicationId = app?.id ?? null;
    if (app) {
      const [org] = await db
        .select({ name: organizations.name, websiteUrl: orgProfiles.websiteUrl })
        .from(organizations)
        .leftJoin(orgProfiles, eq(orgProfiles.orgId, organizations.id))
        .where(eq(organizations.id, input.orgId))
        .limit(1);
      const { enqueueEmail } = await import("../../lib/email-outbox.server");
      await enqueueEmail({
        orgId: input.orgId,
        kind: "ack",
        templateName: "application_ack",
        toEmail: ingested.email,
        applicationId: app.id,
        templateData: {
          candidateName: ingested.name,
          orgName: org?.name,
          websiteUrl: org?.websiteUrl ?? undefined,
          jobTitle: input.requisitionTitle,
        },
        idempotencyKey: `ack:${app.id}`,
      });
    }
  }

  return {
    candidateId: ingested.candidateId,
    applicationId,
    alreadyApplied: ingested.alreadyApplied,
  };
}

/**
 * Ingest one polled application (board-sync path). Same event-row idempotency
 * as the webhook transport — the poll and a webhook delivery of the same
 * applicant share the dedupe key and can never file twice.
 */
export async function ingestPolledApplication(input: {
  orgId: string;
  integrationId: string;
  provider: BoardProviderId;
  normalized: NormalizedApplication;
}): Promise<{ status: "accepted" | "duplicate" | "failed"; detail?: string }> {
  const externalEventId =
    input.normalized.externalEventId ||
    deliveryEventId(null, JSON.stringify(input.normalized.raw ?? {}));
  const dedupeKey = `${input.provider}:${input.orgId}:${externalEventId}`;
  const claimed = await db
    .insert(boardWebhookEvents)
    .values({
      dedupeKey,
      orgId: input.orgId,
      provider: input.provider,
      externalEventId,
      headers: {},
      payload: (input.normalized.raw ?? {}) as Record<string, unknown>,
      status: "pending",
    })
    .onConflictDoNothing({ target: boardWebhookEvents.dedupeKey })
    .returning({ id: boardWebhookEvents.id });
  if (!claimed.length) return { status: "duplicate" };
  const eventId = claimed[0]!.id;

  if (!input.normalized.email && !input.normalized.fullName) {
    await failEvent(eventId, "poll item has neither email nor name");
    return { status: "failed", detail: "unidentifiable applicant" };
  }

  const [posting] = input.normalized.postingExternalId
    ? await db
        .select({
          id: requisitionBoardPostings.id,
          requisitionId: requisitionBoardPostings.requisitionId,
          title: requisitions.title,
        })
        .from(requisitionBoardPostings)
        .innerJoin(requisitions, eq(requisitions.id, requisitionBoardPostings.requisitionId))
        .where(
          and(
            eq(requisitionBoardPostings.orgId, input.orgId),
            eq(requisitionBoardPostings.provider, input.provider),
            eq(requisitionBoardPostings.externalId, input.normalized.postingExternalId),
          ),
        )
        .limit(1)
    : [];

  // No posting match: a poll item for a role we did not syndicate. Keep it as
  // talent-pool evidence? No — without a requisition there is nothing to file;
  // mark the event failed so the run is visible.
  if (!posting) {
    await failEvent(
      eventId,
      `polled applicant for unknown posting ${input.normalized.postingExternalId ?? "(none)"}`,
    );
    return { status: "failed", detail: "unknown posting" };
  }

  try {
    const filed = await fileNormalizedApplication({
      orgId: input.orgId,
      provider: input.provider,
      requisitionId: posting.requisitionId,
      requisitionTitle: posting.title,
      normalized: input.normalized,
    });
    await db
      .update(boardWebhookEvents)
      .set({
        status: "processed",
        requisitionId: posting.requisitionId,
        candidateId: filed.candidateId,
        applicationId: filed.applicationId,
        processedAt: new Date(),
      })
      .where(eq(boardWebhookEvents.id, eventId));
    await db
      .update(requisitionBoardPostings)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(requisitionBoardPostings.id, posting.id));
    return { status: "accepted" };
  } catch (e) {
    await failEvent(eventId, e instanceof Error ? e.message : "intake failed");
    return { status: "failed", detail: "intake failed" };
  }
}

/** Retry failed/stuck webhook events (board-sync). Returns the retry count. */
export async function retryPendingEvents(limit: number): Promise<number> {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await db
    .select({
      id: boardWebhookEvents.id,
      orgId: boardWebhookEvents.orgId,
      provider: boardWebhookEvents.provider,
      payload: boardWebhookEvents.payload,
      attempts: boardWebhookEvents.attempts,
      externalEventId: boardWebhookEvents.externalEventId,
    })
    .from(boardWebhookEvents)
    .where(
      and(
        sql`${boardWebhookEvents.status} in ('pending', 'failed')`,
        lt(boardWebhookEvents.attempts, 5),
        lt(boardWebhookEvents.receivedAt, cutoff),
      ),
    )
    .limit(limit);

  let retried = 0;
  for (const row of rows) {
    if (!row.orgId) continue; // unresolvable events stay for forensics only
    try {
      const normalized = await getBoardAdapter(row.provider as BoardProviderId).mapApplication(
        row.payload,
        await loadBoardConnection(row.orgId, row.provider as BoardProviderId),
      );
      const posting = normalized?.postingExternalId
        ? await db
            .select({
              requisitionId: requisitionBoardPostings.requisitionId,
              title: requisitions.title,
            })
            .from(requisitionBoardPostings)
            .innerJoin(requisitions, eq(requisitions.id, requisitionBoardPostings.requisitionId))
            .where(
              and(
                eq(requisitionBoardPostings.orgId, row.orgId),
                eq(requisitionBoardPostings.provider, row.provider),
                eq(requisitionBoardPostings.externalId, normalized.postingExternalId),
              ),
            )
            .limit(1)
        : [];
      if (!normalized || !posting.length) {
        await failEvent(row.id, "retry: payload still unmappable");
        continue;
      }
      await fileNormalizedApplication({
        orgId: row.orgId,
        provider: row.provider as BoardProviderId,
        requisitionId: posting[0]!.requisitionId,
        requisitionTitle: posting[0]!.title,
        normalized,
      });
      await db
        .update(boardWebhookEvents)
        .set({ status: "processed", processedAt: new Date() })
        .where(eq(boardWebhookEvents.id, row.id));
      retried += 1;
    } catch (e) {
      await failEvent(row.id, `retry failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
  return retried;
}

/** Purge terminal event rows older than 30 days (PII retention). */
export async function purgeOldEvents(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const purged = await db
    .delete(boardWebhookEvents)
    .where(
      and(
        sql`${boardWebhookEvents.status} in ('processed', 'duplicate')`,
        lt(boardWebhookEvents.receivedAt, cutoff),
      ),
    )
    .returning({ id: boardWebhookEvents.id });
  return purged.length;
}

/** Update the per-connection sync bookkeeping after a cron run. */
export async function recordSyncRun(input: {
  orgId: string;
  integrationId: string;
  provider: string;
  ok: boolean;
  error?: string | null;
  polledAt?: Date | null;
  stats?: Record<string, number>;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(boardSyncState)
    .values({
      orgId: input.orgId,
      integrationId: input.integrationId,
      provider: input.provider,
      lastPolledAt: input.polledAt ?? now,
      lastRunAt: now,
      lastRunStatus: input.ok ? "ok" : "failed",
      lastError: input.error?.slice(0, 500) ?? null,
      stats: input.stats ?? {},
    })
    .onConflictDoUpdate({
      target: boardSyncState.integrationId,
      set: {
        lastPolledAt: input.polledAt ?? now,
        lastRunAt: now,
        lastRunStatus: input.ok ? "ok" : "failed",
        lastError: input.error?.slice(0, 500) ?? null,
        stats: input.stats ?? {},
        updatedAt: now,
      },
    });
}

/** The stored poll watermark for one integration, if any. */
export async function lastPolledAt(integrationId: string): Promise<Date | null> {
  const [row] = await db
    .select({ lastPolledAt: boardSyncState.lastPolledAt })
    .from(boardSyncState)
    .where(eq(boardSyncState.integrationId, integrationId))
    .limit(1);
  return row?.lastPolledAt ?? null;
}

/** Count enabled board integrations for the cron summary. */
export async function countEnabledBoardIntegrations(): Promise<number> {
  const rows = await db
    .select({ id: sourceIntegrations.id })
    .from(sourceIntegrations)
    .where(
      and(
        eq(sourceIntegrations.enabled, true),
        sql`${sourceIntegrations.provider} in ('linkedin', 'indeed', 'naukri')`,
      ),
    );
  return rows.length;
}
