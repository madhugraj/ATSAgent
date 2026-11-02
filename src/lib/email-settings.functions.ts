import { eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { emailSettings } from "@db/schema";
import { requireOrg, requireRole } from "./auth.middleware";
import { DEFAULT_EMAIL_SETTINGS } from "./email-settings.shared";

const Timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown IANA timezone");

const SaveInput = z.object({
  enabled: z.boolean(),
  ackEnabled: z.boolean(),
  stageEnabled: z.boolean(),
  interviewEnabled: z.boolean(),
  offerEnabled: z.boolean(),
  /** Blank clears the override; replies then go to the careers inbox. */
  replyTo: z
    .union([z.string().email(), z.literal("")])
    .nullable()
    .optional(),
  timezone: Timezone,
});

/** Per-org candidate-email toggles (defaults = everything on). */
export const getEmailSettings = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const [row] = await db
      .select({
        enabled: emailSettings.enabled,
        ackEnabled: emailSettings.ackEnabled,
        stageEnabled: emailSettings.stageEnabled,
        interviewEnabled: emailSettings.interviewEnabled,
        offerEnabled: emailSettings.offerEnabled,
        replyTo: emailSettings.replyTo,
        timezone: emailSettings.timezone,
      })
      .from(emailSettings)
      .where(eq(emailSettings.orgId, context.orgId))
      .limit(1);

    return row ?? DEFAULT_EMAIL_SETTINGS;
  });

export const saveEmailSettings = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const payload = {
      enabled: data.enabled,
      ackEnabled: data.ackEnabled,
      stageEnabled: data.stageEnabled,
      interviewEnabled: data.interviewEnabled,
      offerEnabled: data.offerEnabled,
      replyTo: data.replyTo?.trim() || null,
      timezone: data.timezone,
      updatedAt: new Date(),
    };

    const [existing] = await db
      .select({ id: emailSettings.id })
      .from(emailSettings)
      .where(eq(emailSettings.orgId, context.orgId))
      .limit(1);
    if (existing) {
      await db.update(emailSettings).set(payload).where(eq(emailSettings.id, existing.id));
    } else {
      await db.insert(emailSettings).values({ ...payload, orgId: context.orgId, singleton: true });
    }

    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "email.settings.save",
      entityType: "email_settings",
      detail: { enabled: data.enabled, timezone: data.timezone },
    });
    return { ok: true };
  });
