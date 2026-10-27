/**
 * Platform "Service health" (SLOs, error budgets, burn rates) — platform super
 * admins only. Queries live in src/server/slo.server.ts; definitions in
 * src/server/slo.ts. Aggregates only: no tenant, user or request data.
 */
import { createServerFn } from "@tanstack/react-start";

import { requirePlatformAdmin } from "./auth.middleware";

export type { ServiceHealth } from "../server/slo.server";

export const platformServiceHealth = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .handler(async () => {
    const { serviceHealthData } = await import("../server/slo.server");
    return serviceHealthData();
  });
