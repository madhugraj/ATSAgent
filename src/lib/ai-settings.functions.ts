import { eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { aiSettings } from "@db/schema";
import { requireOrg, requireRole } from "./auth.middleware";

const Provider = z.enum(["openai", "anthropic", "google"]);

const SaveInput = z.object({
  provider: Provider,
  model: z.string().min(1).max(120),
  /** Blank keeps the stored key. */
  apiKey: z.string().default(""),
});

/** Current model setting plus which bring-your-own keys are stored. */
export const getAiSettings = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { DEFAULT_MODEL, hasProviderKey } = await import("./ai-gateway.server");
    const [data] = await db
      .select({
        provider: aiSettings.provider,
        model: aiSettings.model,
        lastTestStatus: aiSettings.lastTestStatus,
        lastTestMessage: aiSettings.lastTestMessage,
        lastTestedAt: aiSettings.lastTestedAt,
      })
      .from(aiSettings)
      .where(eq(aiSettings.orgId, context.orgId))
      .limit(1);

    return {
      provider: (data?.provider ?? "openai") as z.infer<typeof Provider>,
      model: data?.model ?? DEFAULT_MODEL.openai,
      last_test_status: data?.lastTestStatus ?? "untested",
      last_test_message: data?.lastTestMessage ?? null,
      last_tested_at: data?.lastTestedAt ? data.lastTestedAt.toISOString() : null,
      // The model's published price on file (hiring cost uses it unless your own rates are set).
      list_price: await (async () => {
        const { priceEntry } = await import("../server/ai-pricing");
        const e = priceEntry(data?.provider ?? "openai", data?.model ?? DEFAULT_MODEL.openai);
        return e
          ? {
              currency: e.currency,
              basis: e.basis,
              periods: e.periods,
              source: e.source,
              checkedOn: e.checkedOn,
            }
          : null;
      })(),
      keys: {
        openai: await hasProviderKey(context.orgId, "openai"),
        anthropic: await hasProviderKey(context.orgId, "anthropic"),
        google: await hasProviderKey(context.orgId, "google"),
      },
    };
  });

export const saveAiSettings = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .inputValidator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const { writeProviderKey } = await import("./ai-gateway.server");
    if (data.apiKey.trim()) await writeProviderKey(context.orgId, data.provider, data.apiKey);

    const [existing] = await db
      .select({ id: aiSettings.id })
      .from(aiSettings)
      .where(eq(aiSettings.orgId, context.orgId))
      .limit(1);
    const payload = { provider: data.provider, model: data.model.trim(), updatedAt: new Date() };
    if (existing) {
      await db.update(aiSettings).set(payload).where(eq(aiSettings.id, existing.id));
    } else {
      await db.insert(aiSettings).values({ ...payload, orgId: context.orgId, singleton: true });
    }
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "ai.settings.save",
      entityType: "ai_settings",
      detail: {
        provider: data.provider,
        model: data.model,
        keyChanged: Boolean(data.apiKey.trim()),
      },
    });
    return { ok: true };
  });

export const removeAiKey = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .inputValidator((data: unknown) => z.object({ provider: Provider }).parse(data))
  .handler(async ({ data, context }) => {
    const { clearProviderKey } = await import("./ai-gateway.server");
    await clearProviderKey(context.orgId, data.provider);
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "ai.key.remove",
      entityType: "ai_provider_credentials",
      detail: { provider: data.provider },
    });
    return { ok: true };
  });

const TestInput = z
  .object({
    /** Test what is on screen instead of what is saved. */
    provider: Provider.optional(),
    model: z.string().max(120).optional(),
    apiKey: z.string().optional(),
  })
  .optional();

/** Fire a tiny real completion at the chosen (or saved) provider/model and record the outcome. */
export const testAiModel = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => TestInput.parse(data))
  .handler(async ({ context, data }) => {
    const { aiJson, resolveAiConfig, readProviderKey, DEFAULT_MODEL } =
      await import("./ai-gateway.server");
    let cfg = await resolveAiConfig(context.orgId);
    if (data && (data.provider || data.model || data.apiKey !== undefined)) {
      const provider = data.provider ?? cfg.provider;
      const model = data.model?.trim() || DEFAULT_MODEL[provider];
      const apiKey = data.apiKey?.trim() || (await readProviderKey(context.orgId, provider));
      cfg = { provider, model, apiKey };
    }
    const started = Date.now();
    const res = await aiJson<{ ok: boolean }>({
      system: 'Reply with exactly {"ok": true} and nothing else.',
      prompt: "connection test",
      config: cfg,
      orgId: context.orgId,
      feature: "model_test",
    });

    const outcome = res.ok
      ? {
          status: "ok",
          message: `${cfg.provider} · ${cfg.model} responded in ${Date.now() - started}ms.`,
        }
      : { status: "failed", message: res.message };

    const stamp = {
      lastTestStatus: outcome.status,
      lastTestMessage: outcome.message,
      lastTestedAt: new Date(),
    };
    const [existing] = await db
      .select({ id: aiSettings.id })
      .from(aiSettings)
      .where(eq(aiSettings.orgId, context.orgId))
      .limit(1);
    if (existing) {
      await db.update(aiSettings).set(stamp).where(eq(aiSettings.id, existing.id));
    } else {
      await db.insert(aiSettings).values({
        orgId: context.orgId,
        singleton: true,
        provider: cfg.provider,
        model: cfg.model,
        ...stamp,
      });
    }
    return outcome;
  });
