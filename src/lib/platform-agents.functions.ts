/**
 * Platform agent console (docs/agentic-plan.md §9.2, Phase 5) — platform super
 * admins only. The queries live in src/server/agents/platform.server.ts.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requirePlatformAdmin } from "./auth.middleware";

export type { PlatformAgentConsole } from "../server/agents/platform.server";

export const platformAgentConsole = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({ days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7) })
      .parse(d ?? {}),
  )
  .handler(async ({ data }) => {
    const { platformAgentConsoleData } = await import("../server/agents/platform.server");
    return platformAgentConsoleData(data.days);
  });
