import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { requireOrg } from "./auth.middleware";

/**
 * Re-enter your password before a high-impact action (offer release, bulk
 * rejection). Marks this session re-authenticated for 10 minutes; audited.
 * docs/guardrails.md P2-4.
 */
export const confirmPassword = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ password: z.string().min(1).max(128) }).parse(d))
  .handler(async ({ data, context }) => {
    const { confirmStepUp } = await import("../server/step-up");
    await confirmStepUp({
      userId: context.userId,
      orgId: context.orgId,
      password: data.password,
      request: getRequest(),
    });
    return { ok: true as const };
  });
