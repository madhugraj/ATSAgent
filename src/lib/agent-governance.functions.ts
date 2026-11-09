/**
 * Agent governance (Agent administration, governance roles): is the harness
 * around this organisation's agents holding, and are hand-offs between agents
 * healthy? Deterministic, org-scoped; no vendor or model names on the wire.
 */
import { createServerFn } from "@tanstack/react-start";

import { computeHarness, type Harness } from "../server/agents/governance.server";
import { assertRole, requireOrg } from "./auth.middleware";

export type * from "../server/agents/governance.server";

export const agentGovernance = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<{ generatedAt: string; harness: Harness }> => {
    await assertRole(context.userId, context.orgId, ["hr_head", "president_cbo"]);
    return { generatedAt: new Date().toISOString(), harness: await computeHarness(context.orgId) };
  });
