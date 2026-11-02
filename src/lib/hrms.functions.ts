import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { sourceIntegrations } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { clearSecrets, readSecrets } from "./integrations.server";
import {
  ensureHrmsConnections,
  forgetHrmsCache,
  hrmsSyncOverview,
  syncHrmsEmployees,
  testHrmsProvider,
} from "./hrms.server";
import { HRMS_PROVIDERS } from "./hrms";

const HRMS_PROVIDERS_IDS = HRMS_PROVIDERS.map((p) => p.provider) as [string, ...string[]];

/**
 * The caller organisation's HRMS connections with their sync health, for the
 * Integrations → HRMS sync tab. Missing rows (older orgs) are provisioned on
 * first read.
 */
export const listHrmsIntegrations = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    await ensureHrmsConnections(context.orgId);
    const rows = await db
      .select()
      .from(sourceIntegrations)
      .where(
        and(eq(sourceIntegrations.orgId, context.orgId), eq(sourceIntegrations.category, "hrms")),
      )
      .orderBy(sourceIntegrations.label);
    const overview = await hrmsSyncOverview(context.orgId);
    const byId = new Map(overview.map((o) => [o.integrationId, o]));
    return rows.map((row) => {
      const o = byId.get(row.id);
      return {
        id: row.id,
        provider: row.provider,
        label: row.label,
        enabled: row.enabled,
        has_credentials: row.hasCredentials,
        last_test_status: row.lastTestStatus,
        last_test_message: row.lastTestMessage,
        last_tested_at: row.lastTestedAt?.toISOString() ?? null,
        base_url:
          typeof (row.config as Record<string, unknown>)["base_url"] === "string"
            ? ((row.config as Record<string, unknown>)["base_url"] as string)
            : null,
        credential_fields: row.credentialFields,
        sync: o
          ? {
              last_run_at: o.state?.lastRunAt?.toISOString() ?? null,
              last_run_status: o.state?.lastRunStatus ?? "idle",
              last_error: o.state?.lastError ?? null,
              last_full_sync_at: o.state?.lastFullSyncAt?.toISOString() ?? null,
              cached_employees: o.cached ?? 0,
            }
          : {
              last_run_at: null,
              last_run_status: "idle",
              last_error: null,
              last_full_sync_at: null,
              cached_employees: 0,
            },
      };
    });
  });

const HrmsSaveInput = z.object({
  integrationId: z.string().uuid(),
  provider: z.enum(HRMS_PROVIDERS_IDS),
  enabled: z.boolean(),
  config: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({}),
  /** Blank values keep whatever is already stored. */
  secrets: z.record(z.string(), z.string()).default({}),
});

/** Persist non-secret config on the row, secrets in the server-only table. */
export const saveHrmsIntegration = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => HrmsSaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({ id: sourceIntegrations.id })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.id, data.integrationId),
          eq(sourceIntegrations.orgId, context.orgId),
          eq(sourceIntegrations.category, "hrms"),
        ),
      )
      .limit(1);
    if (!row) throw new Error("HRMS connection not found.");

    const { writeSecrets } = await import("./integrations.server");
    const keys = await writeSecrets(data.integrationId, data.secrets);
    await db
      .update(sourceIntegrations)
      .set({
        enabled: data.enabled,
        config: data.config,
        hasCredentials: keys.length > 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sourceIntegrations.id, data.integrationId),
          eq(sourceIntegrations.orgId, context.orgId),
        ),
      );

    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "hrms.integration.save",
      entityType: "source_integration",
      entityId: data.integrationId,
      detail: { provider: data.provider, enabled: data.enabled },
    });
    return { ok: true, storedKeys: keys };
  });

export const testHrmsIntegration = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) =>
    z
      .object({ integrationId: z.string().uuid(), provider: z.enum(HRMS_PROVIDERS_IDS) })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({ config: sourceIntegrations.config })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.id, data.integrationId),
          eq(sourceIntegrations.orgId, context.orgId),
          eq(sourceIntegrations.category, "hrms"),
        ),
      )
      .limit(1);
    if (!row) throw new Error("HRMS connection not found.");

    const secrets = await readSecrets(data.integrationId);
    const outcome = await testHrmsProvider(
      data.provider as "keka" | "greythr",
      secrets,
      (row.config as Record<string, string | number | boolean | null>) ?? {},
    );

    await db
      .update(sourceIntegrations)
      .set({
        lastTestStatus: outcome.status,
        lastTestMessage: outcome.message,
        lastTestedAt: new Date(),
      })
      .where(
        and(
          eq(sourceIntegrations.id, data.integrationId),
          eq(sourceIntegrations.orgId, context.orgId),
        ),
      );

    return outcome;
  });

export const disconnectHrmsIntegration = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ integrationId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({ id: sourceIntegrations.id, provider: sourceIntegrations.provider })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.id, data.integrationId),
          eq(sourceIntegrations.orgId, context.orgId),
          eq(sourceIntegrations.category, "hrms"),
        ),
      )
      .limit(1);
    if (!row) throw new Error("HRMS connection not found.");

    await clearSecrets(data.integrationId);
    // The employee cache is personal data sourced from the HRMS — drop it with
    // the connection instead of leaving a stale copy behind.
    await forgetHrmsCache(data.integrationId);
    await db
      .update(sourceIntegrations)
      .set({
        enabled: false,
        hasCredentials: false,
        lastTestStatus: "untested",
        lastTestMessage: "Credentials removed.",
        lastTestedAt: null,
      })
      .where(
        and(
          eq(sourceIntegrations.id, data.integrationId),
          eq(sourceIntegrations.orgId, context.orgId),
        ),
      );

    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "hrms.integration.disconnect",
      entityType: "source_integration",
      entityId: data.integrationId,
      detail: { provider: row.provider },
    });
    return { ok: true };
  });

export const syncHrmsNow = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ integrationId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    return syncHrmsEmployees({
      orgId: context.orgId,
      integrationId: data.integrationId,
      actor: context.memberEmail,
    });
  });
