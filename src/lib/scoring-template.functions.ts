/**
 * Organisation scoring template (Organisation → Rules). Reading needs a member;
 * changing it or applying it to open roles needs the HR head, the CBO or an
 * owner (checked in the core, which also audits).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireOrg } from "./auth.middleware";

const pct = z.number().int().min(0).max(100);
const Template = z.object({
  skills: pct,
  experience: pct,
  career: pct,
  impact: pct,
  education: pct,
  social: pct,
  custom: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_]{1,40}$/),
        label: z.string().max(60),
        hint: z.string().max(300),
        weight: pct,
      }),
    )
    .max(4),
});

const actorOf = (c: { orgId: string; userId: string; memberEmail: string }) => ({
  orgId: c.orgId,
  userId: c.userId,
  memberEmail: c.memberEmail,
});

export const getScoringTemplateFn = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { getScoringTemplate } = await import("./scoring-template.server");
    const { assertRole } = await import("./auth.middleware");
    const canEdit = await assertRole(context.userId, context.orgId, ["hr_head", "president_cbo"])
      .then(() => true)
      .catch(() => false);
    return { ...(await getScoringTemplate(context.orgId)), canEdit };
  });

export const saveScoringTemplateFn = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ template: Template.nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    const { saveScoringTemplateCore } = await import("./scoring-template.server");
    return saveScoringTemplateCore(actorOf(context), data.template);
  });

export const applyScoringTemplateFn = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { applyTemplateToOpenRolesCore } = await import("./scoring-template.server");
    return applyTemplateToOpenRolesCore(actorOf(context));
  });
