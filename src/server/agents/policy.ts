/**
 * Agent autonomy policy (docs/agentic-plan.md §5.2).
 *
 * Gates are never decided here: gate actions are not offered to agents as
 * tools at all — an agent can only ask for them (`request_approval`), and the
 * human approves through the same server functions they use today.
 */
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { agentPolicies, type AgentAutonomy, type AgentType } from "@db/schema";

export type ToolRisk = "read" | "write" | "external";

export type EffectivePolicy = {
  enabled: boolean;
  autonomy: AgentAutonomy;
  whitelistedTemplates: string[];
  monthlyTokenBudget: number | null;
};

/**
 * Agents are opt-in: with no policy row an agent is off. Turning one on in
 * Agent settings writes the row (autonomy defaults to `suggest`).
 */
export const DEFAULT_POLICY: EffectivePolicy = {
  enabled: false,
  autonomy: "suggest",
  whitelistedTemplates: [],
  monthlyTokenBudget: null,
};

/**
 * Decide whether a tool call runs now or waits for a person.
 * `templateId` is the content template an external action would send, when it
 * has one — only whitelisted templates may skip approval.
 */
export function decideToolCall(
  risk: ToolRisk,
  policy: Pick<EffectivePolicy, "autonomy" | "whitelistedTemplates">,
  templateId?: string | null,
): "run" | "approve" {
  if (risk === "read") return "run";
  if (risk === "write") return policy.autonomy === "suggest" ? "approve" : "run";
  // external: leaves the organisation (candidate mail, board posts, invites)
  const whitelisted = !!templateId && policy.whitelistedTemplates.includes(templateId);
  if (policy.autonomy === "suggest") return "approve";
  return whitelisted ? "run" : "approve";
}

/** The org-wide switch ('*') and the agent's own row (opt-in), merged over the defaults. */
export async function loadPolicy(orgId: string, agentType: AgentType): Promise<EffectivePolicy> {
  const rows = await db
    .select()
    .from(agentPolicies)
    .where(and(eq(agentPolicies.orgId, orgId), inArray(agentPolicies.agentType, ["*", agentType])));
  const orgWide = rows.find((r) => r.agentType === "*");
  const own = rows.find((r) => r.agentType === agentType);
  return {
    enabled: orgWide?.enabled !== false && own?.enabled === true,
    autonomy: own?.autonomy ?? DEFAULT_POLICY.autonomy,
    whitelistedTemplates: own?.whitelistedTemplates ?? [],
    monthlyTokenBudget: own?.monthlyTokenBudget ?? null,
  };
}
