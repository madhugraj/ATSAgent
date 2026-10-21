import { poolUseFor } from "./job-channels";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { applications, candidates, requisitions, sourceIntegrations } from "@db/schema";
import { requireOrg, requireRole } from "./auth.middleware";
import {
  clearSecrets,
  importFromProvider,
  readSecrets,
  testProvider,
  writeSecrets,
  type IntegrationConfig,
  type ProviderId,
} from "./integrations.server";

const PROVIDERS = [
  "linkedin",
  "naukri",
  "indeed",
  "github",
  "careers",
  "zoom",
  "google_meet",
  "teams",
] as const;

/** JSON-safe value — what a server function is allowed to return. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** camelCase drizzle row → PostgREST-style snake_case row with ISO dates. */
function snakeRow(row: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] =
      value instanceof Date ? value.toISOString() : (value as Json);
  }
  return out;
}

/**
 * The caller organisation's integration rows for the Integrations page,
 * returned in the same snake_case wire shape the browser used to read via
 * PostgREST, ordered by label.
 */
export const listSourceIntegrations = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const rows = await db
      .select()
      .from(sourceIntegrations)
      .where(eq(sourceIntegrations.orgId, context.orgId))
      .orderBy(sourceIntegrations.label);
    return rows.map(snakeRow);
  });

const SaveInput = z.object({
  integrationId: z.string().uuid(),
  provider: z.enum(PROVIDERS),
  enabled: z.boolean(),
  config: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({}),
  /** Blank values keep whatever is already stored. */
  secrets: z.record(z.string(), z.string()).default({}),
});

/**
 * Persist non-secret config on the row, secrets in the server-only table.
 * Credential changes are a privileged action (AGENTS.md) — role-checked and
 * audited.
 */
export const saveIntegration = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .inputValidator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({ id: sourceIntegrations.id, label: sourceIntegrations.label })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.id, data.integrationId),
          eq(sourceIntegrations.orgId, context.orgId),
        ),
      )
      .limit(1);
    if (!row) throw new Error("Integration not found.");

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
      orgId: context.orgId,
      actorUserId: context.userId,
      action: "integration.credentials.save",
      entityType: "integration",
      entityId: data.integrationId,
      detail: { provider: data.provider, enabled: data.enabled, fields: keys },
    });
    return { ok: true, storedKeys: keys };
  });

export const testIntegration = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z.object({ integrationId: z.string().uuid(), provider: z.enum(PROVIDERS) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({ config: sourceIntegrations.config })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.id, data.integrationId),
          eq(sourceIntegrations.orgId, context.orgId),
        ),
      )
      .limit(1);
    if (!row) throw new Error("Integration not found.");

    const secrets = await readSecrets(data.integrationId);
    const outcome = await testProvider(
      data.provider as ProviderId,
      secrets,
      (row.config as IntegrationConfig) ?? {},
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

/** Forget a connection's credentials. Privileged (credential change) + audited. */
export const disconnectIntegration = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .inputValidator((data: unknown) => z.object({ integrationId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({
        id: sourceIntegrations.id,
        label: sourceIntegrations.label,
        config: sourceIntegrations.config,
      })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.id, data.integrationId),
          eq(sourceIntegrations.orgId, context.orgId),
        ),
      )
      .limit(1);
    if (!row) throw new Error("Integration not found.");

    await clearSecrets(data.integrationId);

    // Meeting-provider connects stamp connection state (connected_email /
    // connected_at) into config — clear it too, or the card keeps rendering
    // "Connected as …" and the Connect button never comes back.
    const config = { ...((row.config as IntegrationConfig) ?? {}) } as Record<
      string,
      string | number | boolean | null
    >;
    delete config["connected_email"];
    delete config["connected_at"];

    await db
      .update(sourceIntegrations)
      .set({
        enabled: false,
        hasCredentials: false,
        config,
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
      orgId: context.orgId,
      actorUserId: context.userId,
      action: "integration.credentials.remove",
      entityType: "integration",
      entityId: data.integrationId,
      detail: { label: row.label },
    });
    return { ok: true };
  });

/** Search a configured board and upsert the results into the talent pool. */
export const importCandidates = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        provider: z.enum(PROVIDERS),
        requisitionId: z.string().uuid(),
        limit: z.number().min(1).max(50).default(10),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const [integration] = await db
      .select({
        id: sourceIntegrations.id,
        config: sourceIntegrations.config,
        enabled: sourceIntegrations.enabled,
      })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.provider, data.provider),
          eq(sourceIntegrations.orgId, context.orgId),
        ),
      )
      .limit(1);
    if (!integration) throw new Error("Integration not found.");
    if (!integration.enabled)
      throw new Error(`${data.provider} is disabled on the Integrations page.`);

    const [req] = await db
      .select({
        mustHaveSkills: requisitions.mustHaveSkills,
        goodToHaveSkills: requisitions.goodToHaveSkills,
        experienceMin: requisitions.experienceMin,
        experienceMax: requisitions.experienceMax,
        location: requisitions.location,
      })
      .from(requisitions)
      .where(and(eq(requisitions.id, data.requisitionId), eq(requisitions.orgId, context.orgId)))
      .limit(1);
    if (!req) throw new Error("Requisition not found.");

    const secrets = await readSecrets(integration.id);
    const found = await importFromProvider({
      provider: data.provider as ProviderId,
      secrets,
      config: (integration.config as IntegrationConfig) ?? {},
      keywords: [...req.mustHaveSkills, ...req.goodToHaveSkills],
      experienceMin: req.experienceMin,
      experienceMax: req.experienceMax,
      location: req.location,
      limit: data.limit,
    });

    let imported = 0;
    for (const c of found) {
      const [cand] = await db
        .insert(candidates)
        .values({
          orgId: context.orgId,
          fullName: c.full_name,
          email: c.email,
          phone: c.phone,
          location: c.location,
          source: data.provider,
          experienceYears: String(c.experience_years),
          education: c.education,
          skills: c.skills,
          resumeText: c.resume_text,
          linkedinUrl: c.linkedin_url,
          githubUrl: c.github_url,
          externalId: c.external_id,
          externalProvider: data.provider,
          // A portal's database may limit its CVs to the role (job-channels.ts).
          poolUse: poolUseFor(data.provider),
          poolUseSource: poolUseFor(data.provider) === "role_only" ? data.provider : null,
        })
        .onConflictDoUpdate({
          // Partial unique index candidates_external_unique on
          // (external_provider, external_id) where external_id is not null.
          target: [candidates.externalProvider, candidates.externalId],
          targetWhere: sql`${candidates.externalId} is not null`,
          // Never touch another organisation's candidate row on conflict.
          setWhere: eq(candidates.orgId, context.orgId),
          set: {
            fullName: c.full_name,
            email: c.email,
            phone: c.phone,
            location: c.location,
            experienceYears: String(c.experience_years),
            education: c.education,
            skills: c.skills,
            resumeText: c.resume_text,
            linkedinUrl: c.linkedin_url,
            githubUrl: c.github_url,
          },
        })
        .returning({ id: candidates.id });
      if (!cand) continue;

      try {
        await db.insert(applications).values({
          requisitionId: data.requisitionId,
          candidateId: cand.id,
          orgId: context.orgId,
          source: data.provider,
        });
        imported += 1;
      } catch {
        // Already applied to this requisition — the old code skipped the
        // per-row error and kept counting only successful inserts.
      }
    }

    return { found: found.length, imported };
  });
