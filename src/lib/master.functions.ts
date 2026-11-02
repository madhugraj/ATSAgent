import { and, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { masterItems } from "@db/schema";
import { requireOrg } from "./auth.middleware";

export const addMasterItem = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) =>
    z
      .object({
        kind: z.enum([
          "skill",
          "location",
          "education",
          "employment_type",
          "industry",
          "role_title",
          "billing_type",
          "engagement_type",
          "client",
          "rejection_reason",
        ]),
        name: z.string().min(1),
        category: z.string().nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    try {
      await db.insert(masterItems).values({
        orgId: context.orgId,
        kind: data.kind,
        name: data.name.trim(),
        category: data.category ?? null,
      });
      return { ok: true as const, existed: false as const };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A same-org duplicate is not an error — the caller decides whether to
      // tell the user. Anything else is a real failure and propagates.
      if (!/duplicate|unique/i.test(message)) throw new Error(message);
      return { ok: true as const, existed: true as const };
    }
  });

export const deleteMasterItem = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    await db
      .delete(masterItems)
      .where(and(eq(masterItems.id, data.id), eq(masterItems.orgId, context.orgId)));
    return { ok: true as const };
  });
