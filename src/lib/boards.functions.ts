/**
 * Client-reached board server functions: publishing state + actions for a
 * requisition, webhook token rotation, and the connection-completion summary
 * for the Integrations page.
 *
 * Server-only modules (adapters, audit, env) are imported lazily inside
 * handlers so this module stays safe for the client bundle — same discipline
 * as linkedin.functions.ts.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import {
  boardWebhookEvents,
  requisitionBoardPostings,
  requisitions,
  sourceIntegrations,
} from "@db/schema";
import { requireOrg, requireRole } from "./auth.middleware";
import { seedSourceIntegrations } from "../server/integration-seeds.server";

const PROVIDERS = ["linkedin", "indeed", "naukri"] as const;
const ProviderEnum = z.enum(PROVIDERS);

/** JSON-safe value — what a server function is allowed to return. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type BoardReadiness = {
  posting: boolean | null;
  applications: boolean | null;
  applicationsMode: "webhook" | "polling" | "none";
  detail: string;
};

/** Wire shape of boardConnectionStatus — what a board's connect panel renders. */
export type BoardConnectStatus = {
  provider: string;
  enabled: boolean;
  hasCredentials: boolean;
  lastTestStatus: string;
  lastTestMessage: string | null;
  connected: boolean;
  caps: BoardReadiness | null;
  capsError: string | null;
};

type BoardProviderStatus = {
  provider: string;
  enabled: boolean;
  hasCredentials: boolean;
  lastTestStatus: string;
  lastTestMessage: string | null;
  webhookConfiguredAt: string | null;
  ready: BoardReadiness;
};

/** Posting + per-provider readiness for one requisition's "Job boards" panel. */
export const boardPostingStatus = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ requisitionId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const [requisition] = await db
      .select({ status: requisitions.status })
      .from(requisitions)
      .where(and(eq(requisitions.id, data.requisitionId), eq(requisitions.orgId, context.orgId)))
      .limit(1);
    if (!requisition) throw new Error("Requisition not found.");

    const postings = await db
      .select({
        provider: requisitionBoardPostings.provider,
        status: requisitionBoardPostings.status,
        externalId: requisitionBoardPostings.externalId,
        externalUrl: requisitionBoardPostings.externalUrl,
        lastError: requisitionBoardPostings.lastError,
        attempts: requisitionBoardPostings.attempts,
        publishedAt: requisitionBoardPostings.publishedAt,
        closedAt: requisitionBoardPostings.closedAt,
        lastSyncedAt: requisitionBoardPostings.lastSyncedAt,
      })
      .from(requisitionBoardPostings)
      .where(
        and(
          eq(requisitionBoardPostings.requisitionId, data.requisitionId),
          eq(requisitionBoardPostings.orgId, context.orgId),
        ),
      );

    const rows = await db
      .select({
        provider: sourceIntegrations.provider,
        enabled: sourceIntegrations.enabled,
        hasCredentials: sourceIntegrations.hasCredentials,
        lastTestStatus: sourceIntegrations.lastTestStatus,
        lastTestMessage: sourceIntegrations.lastTestMessage,
        webhookConfiguredAt: sourceIntegrations.webhookConfiguredAt,
      })
      .from(sourceIntegrations)
      .where(eq(sourceIntegrations.orgId, context.orgId));

    const { getBoardAdapter, loadBoardConnection } = await import("../server/boards/registry");
    const providers: BoardProviderStatus[] = [];
    for (const provider of PROVIDERS) {
      const row = rows.find((r) => r.provider === provider);
      let ready: BoardReadiness = {
        posting: null,
        applications: null,
        applicationsMode: "none",
        detail: row
          ? "Enable the connection and store the credentials first."
          : "Add this board on the Integrations page first.",
      };
      if (row) {
        try {
          const conn = await loadBoardConnection(context.orgId, provider);
          const caps = await getBoardAdapter(provider).capabilities(conn);
          ready = {
            posting: caps.posting,
            applications: caps.applications,
            applicationsMode: caps.applicationsMode,
            detail: caps.detail,
          };
        } catch (e) {
          ready = {
            posting: false,
            applications: false,
            applicationsMode: "none",
            detail: e instanceof Error ? e.message : "The connection could not be checked.",
          };
        }
      }
      providers.push({
        provider,
        enabled: row?.enabled ?? false,
        hasCredentials: row?.hasCredentials ?? false,
        lastTestStatus: row?.lastTestStatus ?? "untested",
        lastTestMessage: row?.lastTestMessage ?? null,
        webhookConfiguredAt: row?.webhookConfiguredAt
          ? row.webhookConfiguredAt.toISOString()
          : null,
        ready,
      });
    }

    return {
      requisitionStatus: requisition.status,
      postings: postings.map((p) => ({
        ...p,
        publishedAt: p.publishedAt?.toISOString() ?? null,
        closedAt: p.closedAt?.toISOString() ?? null,
        lastSyncedAt: p.lastSyncedAt?.toISOString() ?? null,
      })),
      providers,
    };
  });

const PublishInput = z.object({
  requisitionId: z.string().uuid(),
  provider: ProviderEnum,
  postText: z.string().max(3000).nullish(),
});

/** Publish this requisition on one board (capability-gated, audited). */
export const publishToBoard = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) => PublishInput.parse(data))
  .handler(async ({ data, context }) => {
    const { publishToBoardImpl } = await import("../server/boards/publish.server");
    return publishToBoardImpl({
      orgId: context.orgId,
      actor: { memberEmail: context.memberEmail, userId: context.userId },
      requisitionId: data.requisitionId,
      provider: data.provider,
      postText: data.postText?.trim() || null,
    });
  });

const CloseInput = z.object({
  requisitionId: z.string().uuid(),
  provider: ProviderEnum,
  reason: z.enum(["filled", "closed", "withdrawn"]).default("closed"),
});

/** Close / mark filled a board posting (audited; vendor call is best-effort). */
export const closeBoardPosting = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) => CloseInput.parse(data))
  .handler(async ({ data, context }) => {
    const { closeBoardPostingImpl } = await import("../server/boards/publish.server");
    await closeBoardPostingImpl({
      orgId: context.orgId,
      actor: { memberEmail: context.memberEmail, userId: context.userId },
      requisitionId: data.requisitionId,
      provider: data.provider,
      reason: data.reason,
    });
    return { ok: true as const };
  });

const PROVIDER_LABEL: Record<(typeof PROVIDERS)[number], string> = {
  linkedin: "LinkedIn",
  indeed: "Indeed",
  naukri: "Naukri",
};

/**
 * Rotate the per-connection webhook delivery token and return the URL the
 * board should POST applications to. Captured in the audit trail.
 */
export const boardWebhookSetup = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) => z.object({ provider: ProviderEnum }).parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({ id: sourceIntegrations.id })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.orgId, context.orgId),
          eq(sourceIntegrations.provider, data.provider),
        ),
      )
      .limit(1);
    if (!row) throw new Error(`${PROVIDER_LABEL[data.provider]} is not on the Integrations page.`);

    const { randomBytes, createHash } = await import("node:crypto");
    const token = randomBytes(24).toString("hex");
    const hash = createHash("sha256").update(token).digest("hex");
    const { encryptSecret } = await import("../server/crypto");
    await db
      .update(sourceIntegrations)
      .set({
        webhookToken: encryptSecret(token),
        webhookTokenHash: hash,
        webhookConfiguredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(sourceIntegrations.id, row.id), eq(sourceIntegrations.orgId, context.orgId)));

    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      orgId: context.orgId,
      actorUserId: context.userId,
      action: "board.webhook.rotate",
      entityType: "integration",
      entityId: row.id,
      detail: { provider: data.provider },
    });

    const { env } = await import("../server/env");
    const base = env.PUBLIC_SITE_URL.replace(/\/$/, "");
    return { webhookUrl: `${base}/api/public/boards/${data.provider}/${token}` };
  });

/** Per-board counts for the Integrations checklist. */
export const boardIntegrationSummary = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const postings = await db
      .select({
        provider: requisitionBoardPostings.provider,
        status: requisitionBoardPostings.status,
        lastSyncedAt: requisitionBoardPostings.lastSyncedAt,
      })
      .from(requisitionBoardPostings)
      .where(eq(requisitionBoardPostings.orgId, context.orgId));

    const events = await db
      .select({
        provider: boardWebhookEvents.provider,
        status: boardWebhookEvents.status,
        receivedAt: boardWebhookEvents.receivedAt,
      })
      .from(boardWebhookEvents)
      .where(eq(boardWebhookEvents.orgId, context.orgId))
      .orderBy(desc(boardWebhookEvents.receivedAt))
      .limit(500);

    const out: Record<string, Json> = {};
    for (const provider of PROVIDERS) {
      const live = postings.filter(
        (p) => p.provider === provider && p.status === "published",
      ).length;
      const providerEvents = events.filter((e) => e.provider === provider);
      const last = providerEvents[0]?.receivedAt;
      out[provider] = {
        postingsLive: live,
        applicationsReceived: providerEvents.filter((e) => e.status === "processed").length,
        lastApplicationAt: last ? last.toISOString() : null,
      };
    }
    return out;
  });

/**
 * Live connection status for one board's Integrations card connect panel:
 * the stored-row facts plus what the board's adapter says the connection can
 * actually do. Read-only; the honest "not provisioned yet" detail strings come
 * from the adapters themselves.
 */
export const boardConnectionStatus = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ provider: ProviderEnum }).parse(data))
  .handler(async ({ data, context }): Promise<BoardConnectStatus> => {
    const [row] = await db
      .select({
        enabled: sourceIntegrations.enabled,
        hasCredentials: sourceIntegrations.hasCredentials,
        lastTestStatus: sourceIntegrations.lastTestStatus,
        lastTestMessage: sourceIntegrations.lastTestMessage,
      })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.orgId, context.orgId),
          eq(sourceIntegrations.provider, data.provider),
        ),
      )
      .limit(1);
    if (!row) throw new Error(`${PROVIDER_LABEL[data.provider]} is not on the Integrations page.`);

    // Credentials are the source of truth; lastTestStatus only says the board
    // itself accepted them (same honesty rule as the meeting-provider cards).
    const connected = row.hasCredentials && row.lastTestStatus === "ok";

    let caps: BoardReadiness | null = null;
    let capsError: string | null = null;
    if (row.enabled) {
      try {
        const { getBoardAdapter, loadBoardConnection } = await import("../server/boards/registry");
        const conn = await loadBoardConnection(context.orgId, data.provider);
        const adapterCaps = await getBoardAdapter(data.provider).capabilities(conn);
        caps = {
          posting: adapterCaps.posting,
          applications: adapterCaps.applications,
          applicationsMode: adapterCaps.applicationsMode,
          detail: adapterCaps.detail,
        };
      } catch (e) {
        capsError = e instanceof Error ? e.message : "The connection could not be checked.";
      }
    }

    return {
      provider: data.provider,
      enabled: row.enabled,
      hasCredentials: row.hasCredentials,
      lastTestStatus: row.lastTestStatus,
      lastTestMessage: row.lastTestMessage,
      connected,
      caps,
      capsError,
    };
  });

/**
 * The current webhook URL for one board, decrypted server-side. The token in
 * it is a delivery credential — this endpoint is role-checked and only ever
 * returns to the org's own admins.
 */
export const boardWebhookUrl = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ provider: ProviderEnum }).parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({
        webhookToken: sourceIntegrations.webhookToken,
        webhookConfiguredAt: sourceIntegrations.webhookConfiguredAt,
      })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.orgId, context.orgId),
          eq(sourceIntegrations.provider, data.provider),
        ),
      )
      .limit(1);
    if (!row?.webhookToken) return { webhookUrl: null, configuredAt: null };
    const { decryptSecret } = await import("../server/crypto");
    const { env } = await import("../server/env");
    const base = env.PUBLIC_SITE_URL.replace(/\/$/, "");
    return {
      webhookUrl: `${base}/api/public/boards/${data.provider}/${decryptSecret(row.webhookToken)}`,
      configuredAt: row.webhookConfiguredAt ? row.webhookConfiguredAt.toISOString() : null,
    };
  });

/**
 * Seed any missing integration catalog rows for this org and return the
 * refreshed list — the fallback for orgs created before the seeding hook.
 */
export const ensureBoardIntegrations = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    await seedSourceIntegrations(context.orgId);
    const rows = await db
      .select({
        id: sourceIntegrations.id,
        provider: sourceIntegrations.provider,
        label: sourceIntegrations.label,
        enabled: sourceIntegrations.enabled,
        category: sourceIntegrations.category,
      })
      .from(sourceIntegrations)
      .where(eq(sourceIntegrations.orgId, context.orgId))
      .orderBy(sourceIntegrations.label);
    return { rows };
  });
