/**
 * The panel directory on the Team page (docs/panel-directory.md): anyone in the
 * organisation may see it; the HR head (or an owner) adds people and takes them
 * off panels.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { assertRole, requireOrg } from "./auth.middleware";

const PanelistBody = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  kind: z.enum(["internal", "external"]),
  title: z.string().trim().max(120).nullish(),
  company: z.string().trim().max(120).nullish(),
  areas: z.array(z.string().trim().min(2).max(60)).max(20).default([]),
  rounds: z.array(z.number().int().min(1).max(3)).min(1).max(3).default([1, 2, 3]),
});

export const listPanelDirectory = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { listPanelists } = await import("./panelists.server");
    return listPanelists(context.orgId);
  });

export const addToPanelDirectory = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => PanelistBody.parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      ["hr_head"],
      "Only the HR head can add people to the panel directory.",
    );
    const { addPanelist } = await import("./panelists.server");
    return addPanelist(context.orgId, context.userId, data, { via: "team_page" });
  });

export const setPanelDirectoryActive = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ id: z.string().uuid(), active: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      ["hr_head"],
      "Only the HR head can change the panel directory.",
    );
    const { setPanelistActive } = await import("./panelists.server");
    await setPanelistActive(context.orgId, context.userId, data.id, data.active);
    return { ok: true as const };
  });
