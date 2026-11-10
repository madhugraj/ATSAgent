/**
 * Agent governance (Agent administration, governance roles): is the harness
 * around this organisation's agents holding, and are hand-offs between agents
 * healthy? Deterministic, org-scoped; no vendor or model names on the wire.
 */
import { createServerFn } from "@tanstack/react-start";

import { computeActivity, type ActivityReport } from "../server/agents/activity-report.server";
import { computeHarness, type Harness } from "../server/agents/governance.server";
import { assertRole, requireOrg } from "./auth.middleware";
import type { ModalityFilter } from "./agent-modality";
import { reportWindowSchema, resolveWindow } from "./report-window";

export type * from "../server/agents/governance.server";
export type * from "../server/agents/activity-report.server";

export const agentGovernance = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((input: unknown) => reportWindowSchema.parse(input ?? {}))
  .handler(
    async ({
      context,
      data,
    }): Promise<{
      generatedAt: string;
      window: { from: string; to: string; agent: string | null; modality: ModalityFilter };
      harness: Harness;
    }> => {
      await assertRole(context.userId, context.orgId, ["hr_head", "president_cbo"]);
      const win = resolveWindow(data);
      return {
        generatedAt: new Date().toISOString(),
        window: {
          from: win.from.toISOString(),
          to: win.to.toISOString(),
          agent: win.agent,
          modality: win.modality,
        },
        harness: await computeHarness(context.orgId, win),
      };
    },
  );

/** Row-level activity for the downloadable reports (same window as the pages). */
export const agentActivityReport = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((input: unknown) => reportWindowSchema.parse(input ?? {}))
  .handler(async ({ context, data }): Promise<ActivityReport> => {
    await assertRole(context.userId, context.orgId, ["hr_head", "president_cbo"]);
    return computeActivity(context.orgId, resolveWindow(data));
  });
