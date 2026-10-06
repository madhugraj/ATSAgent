/**
 * Agent trace export and alert channels per organisation (docs/agentic-plan.md
 * §9, Phase 5). HR head / CBO / owner. Header values and the webhook signing
 * secret are write-only: encrypted at rest and never returned to the browser.
 */
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { agentTelemetrySettings } from "@db/schema";
import { requireOrg } from "./auth.middleware";

const SETTINGS_ROLES = ["hr_head", "president_cbo"] as const;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "connection"]);

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => u.startsWith("https://"), "Use an https:// address.");

export type AgentTelemetryView = {
  canEdit: boolean;
  otlpEnabled: boolean;
  otlpEndpoint: string | null;
  otlpHeaderNames: string[];
  alertEmailEnabled: boolean;
  alertWebhookUrl: string | null;
  hasWebhookSecret: boolean;
  lastExportAt: string | null;
  lastExportError: string | null;
};

async function canEdit(userId: string, orgId: string): Promise<boolean> {
  const { assertRole } = await import("./auth.middleware");
  try {
    await assertRole(userId, orgId, [...SETTINGS_ROLES]);
    return true;
  } catch {
    return false;
  }
}

export const agentTelemetry = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<AgentTelemetryView> => {
    const [s] = await db
      .select()
      .from(agentTelemetrySettings)
      .where(eq(agentTelemetrySettings.orgId, context.orgId))
      .limit(1);
    const { parseHeaders } = await import("../server/agents/otel.server");
    return {
      canEdit: await canEdit(context.userId, context.orgId),
      otlpEnabled: s?.otlpEnabled ?? false,
      otlpEndpoint: s?.otlpEndpoint ?? null,
      otlpHeaderNames: Object.keys(parseHeaders(s?.otlpHeadersEnc ?? null)),
      alertEmailEnabled: s?.alertEmailEnabled ?? true,
      alertWebhookUrl: s?.alertWebhookUrl ?? null,
      hasWebhookSecret: Boolean(s?.alertWebhookSecretEnc),
      lastExportAt: s?.lastExportAt?.toISOString() ?? null,
      lastExportError: s?.lastExportError ?? null,
    };
  });

const TelemetryInput = z.object({
  otlpEnabled: z.boolean(),
  otlpEndpoint: httpsUrl.nullable(),
  /** undefined keeps the saved headers; null clears them. */
  otlpHeaders: z
    .record(
      z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Header names use letters, digits and dashes."),
      z.string().max(2000),
    )
    .refine((h) => Object.keys(h).length <= 10, "At most 10 headers.")
    .refine(
      (h) => Object.keys(h).every((k) => !FORBIDDEN_HEADERS.has(k.toLowerCase())),
      "That header is set by the exporter.",
    )
    .nullable()
    .optional(),
  alertEmailEnabled: z.boolean(),
  alertWebhookUrl: httpsUrl.nullable(),
  /** undefined keeps the saved secret; null clears it. */
  alertWebhookSecret: z.string().min(16).max(200).nullable().optional(),
});

export type AgentTelemetryInput = z.infer<typeof TelemetryInput>;

export const saveAgentTelemetry = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => TelemetryInput.parse(d))
  .handler(async ({ data, context }) => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...SETTINGS_ROLES]);
    if (data.otlpEnabled && !data.otlpEndpoint)
      throw new Error("Add the collector address before switching export on.");
    const { encryptSecret } = await import("../server/crypto");
    const now = new Date();
    const values = {
      otlpEnabled: data.otlpEnabled,
      otlpEndpoint: data.otlpEndpoint,
      ...(data.otlpHeaders !== undefined
        ? {
            otlpHeadersEnc:
              data.otlpHeaders && Object.keys(data.otlpHeaders).length
                ? encryptSecret(JSON.stringify(data.otlpHeaders))
                : null,
          }
        : {}),
      alertEmailEnabled: data.alertEmailEnabled,
      alertWebhookUrl: data.alertWebhookUrl,
      ...(data.alertWebhookSecret !== undefined
        ? {
            alertWebhookSecretEnc: data.alertWebhookSecret
              ? encryptSecret(data.alertWebhookSecret)
              : null,
          }
        : {}),
      // A changed configuration gets a fresh try straight away.
      lastExportError: null,
      updatedBy: context.userId,
      updatedAt: now,
    };
    await db
      .insert(agentTelemetrySettings)
      .values({ orgId: context.orgId, ...values })
      .onConflictDoUpdate({ target: agentTelemetrySettings.orgId, set: values });
    const host = (u: string | null) => (u ? new URL(u).host : null);
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "agent.telemetry.updated",
      entityType: "agent_telemetry_settings",
      entityId: context.orgId,
      detail: {
        otlp_enabled: data.otlpEnabled,
        otlp_host: host(data.otlpEndpoint),
        otlp_headers_changed: data.otlpHeaders !== undefined,
        alert_email_enabled: data.alertEmailEnabled,
        webhook_host: host(data.alertWebhookUrl),
        webhook_secret_changed: data.alertWebhookSecret !== undefined,
      },
    });
    return { ok: true as const };
  });

/** Send one synthetic trace or alert to the saved destination. */
export const testAgentTelemetry = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ target: z.enum(["otlp", "webhook"]) }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: boolean; message: string }> => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...SETTINGS_ROLES]);
    const [s] = await db
      .select()
      .from(agentTelemetrySettings)
      .where(eq(agentTelemetrySettings.orgId, context.orgId))
      .limit(1);
    if (data.target === "otlp") {
      if (!s?.otlpEndpoint) return { ok: false, message: "Save a collector address first." };
      const { buildOtlpPayload, postOtlp } = await import("../server/agents/otel.server");
      const now = new Date();
      const id = crypto.randomUUID();
      const body = buildOtlpPayload(context.orgId, [
        {
          run: {
            id,
            traceId: crypto.randomUUID(),
            orgId: context.orgId,
            agentType: "copilot",
            status: "done",
            mode: "live",
            replayOf: null,
            principalUserId: context.userId,
            subjectType: "telemetry_test",
            subjectId: null,
            definitionVersion: null,
            definitionHash: null,
            stepCount: 0,
            tokensUsed: 0,
            attempts: 0,
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            finishedAt: now,
          } as never,
          steps: [],
        },
      ]);
      const error = await postOtlp(s.otlpEndpoint, s.otlpHeadersEnc, body);
      return error
        ? { ok: false, message: error }
        : { ok: true, message: "The collector accepted a test trace." };
    }
    if (!s?.alertWebhookUrl) return { ok: false, message: "Save a webhook address first." };
    const { signAlert } = await import("../server/agents/alerts.server");
    const { decryptSecret } = await import("../server/crypto");
    const { safeFetch } = await import("../server/safe-fetch");
    const body = JSON.stringify({ type: "agent.alert.test", org_id: context.orgId });
    const secret = decryptSecret(s.alertWebhookSecretEnc);
    try {
      const res = await safeFetch(s.alertWebhookUrl, {
        method: "POST",
        body,
        timeoutMs: 8_000,
        headers: {
          "content-type": "application/json",
          ...(secret ? { "x-atsagent-signature": signAlert(body, secret) } : {}),
        },
      });
      return res.ok
        ? { ok: true, message: "The webhook accepted a test alert." }
        : { ok: false, message: `The webhook answered HTTP ${res.status}.` };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : "The webhook could not be reached.",
      };
    }
  });
