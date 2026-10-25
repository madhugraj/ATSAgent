/**
 * Phone screening settings (docs/voice-screening-agent.md): the
 * organisation's policy (Organisation page) and its AI voice credential
 * (Integrations → AI model). The credential is never returned — only whether
 * one is stored.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { assertRole, requireOrg, requireRole } from "./auth.middleware";

const Policy = z
  .object({
    enabled: z.boolean(),
    assistantName: z
      .string()
      .trim()
      .min(2, "Give the assistant a name of at least 2 letters.")
      .max(40)
      .regex(/^[\p{L} .'-]+$/u, "Use letters only for the assistant's name."),
    windowStartMinute: z.number().int().min(0).max(1439),
    windowEndMinute: z.number().int().min(1).max(1440),
    callDays: z.array(z.number().int().min(1).max(7)).min(1, "Choose at least one day.").max(7),
    maxAttempts: z.number().int().min(1).max(5),
    maxMinutes: z.number().int().min(5).max(30),
    maxReschedules: z.number().int().min(0).max(5),
    voice: z.enum(["Kore", "Aoede", "Leda", "Zephyr", "Puck", "Charon", "Fenrir", "Orus"]),
    nextStepsText: z.string().trim().max(300).nullable(),
    schedulingEnabled: z.boolean(),
    schedulingWaitHours: z.number().int().min(2).max(96),
  })
  .refine((p) => p.windowEndMinute - p.windowStartMinute >= 60, {
    message: "The calling window must be at least an hour long.",
  });

/** The policy plus what is still missing before calls can be placed. */
export const getPhoneScreening = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { phoneScreeningPolicyOf, phoneScreeningReadiness } =
      await import("../server/voice/settings.server");
    const [policy, readiness] = await Promise.all([
      phoneScreeningPolicyOf(context.orgId),
      phoneScreeningReadiness(context.orgId),
    ]);
    return { policy, readiness };
  });

/** Change the phone screening policy — HR head, CBO or owner; audited. */
export const setPhoneScreening = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => Policy.parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      ["hr_head", "president_cbo"],
      "Only the HR head, the CBO or an owner can change phone screening.",
    );
    const { setPhoneScreeningPolicyCore } = await import("../server/voice/settings.server");
    await setPhoneScreeningPolicyCore(
      context.orgId,
      { userId: context.userId, memberEmail: context.memberEmail },
      data,
    );
    return { ok: true };
  });

/** Store the organisation's service-account key for the AI voice — HR head; audited. */
export const saveVoiceServiceAccount = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .inputValidator((d: unknown) =>
    z
      .object({
        json: z.string().min(50).max(20_000),
        location: z.string().trim().min(3).max(40).default("us-central1"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { parseVoiceServiceAccount, writeVoiceServiceAccount } =
      await import("./ai-gateway.server");
    const parsed = parseVoiceServiceAccount(data.json, data.location);
    if (!parsed.ok) throw new Error(parsed.message);
    await writeVoiceServiceAccount(context.orgId, parsed.vertex);
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "ai.voice_credential.save",
      entityType: "ai_provider_credentials",
      detail: { kind: "service_account", location: data.location },
    });
    return { ok: true };
  });

export const removeVoiceServiceAccount = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .handler(async ({ context }) => {
    const { clearVoiceServiceAccount } = await import("./ai-gateway.server");
    await clearVoiceServiceAccount(context.orgId);
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "ai.voice_credential.remove",
      entityType: "ai_provider_credentials",
      detail: { kind: "service_account" },
    });
    return { ok: true };
  });
