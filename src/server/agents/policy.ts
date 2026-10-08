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
 * `templateId` names what an external action would send: a candidate message
 * template (e.g. "interview_invite") or a job board ("job_board:linkedin").
 *
 *   read      always runs
 *   write     Suggest asks; Act and notify / Autonomous run
 *   external  Suggest asks;
 *             candidate messages — Act and notify runs pre-approved templates,
 *               Autonomous runs every template;
 *             job-board posts — run only at Autonomous on a board the org
 *               pre-approved, otherwise they go to the approver;
 *             anything else asks.
 * Decisions (gates) are never tools, so no level can make them.
 */
export function decideToolCall(
  risk: ToolRisk,
  policy: Pick<EffectivePolicy, "autonomy" | "whitelistedTemplates">,
  templateId?: string | null,
): "run" | "approve" {
  if (risk === "read") return "run";
  if (risk === "write") return policy.autonomy === "suggest" ? "approve" : "run";
  if (policy.autonomy === "suggest" || !templateId) return "approve";
  const preApproved = policy.whitelistedTemplates.includes(templateId);
  if (templateId.startsWith("job_board:"))
    return policy.autonomy === "autonomous" && preApproved ? "run" : "approve";
  return policy.autonomy === "autonomous" || preApproved ? "run" : "approve";
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
