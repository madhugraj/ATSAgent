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
  /** Run limits per leg set by the organisation; null = the agent's default. */
  maxStepsPerLeg: number | null;
  maxTokensPerLeg: number | null;
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
  maxStepsPerLeg: null,
  maxTokensPerLeg: null,
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
 *
 * `tainted`: earlier in this run a tool returned third-party text that tripped
 * the injection tripwire. From then on the run is treated as possibly
 * hijacked — every write and external action waits for a person, whatever the
 * autonomy level or template whitelist. Reads still run.
 */
export function decideToolCall(
  risk: ToolRisk,
  policy: Pick<EffectivePolicy, "autonomy" | "whitelistedTemplates">,
  templateId?: string | null,
  opts: { tainted?: boolean } = {},
): "run" | "approve" {
  if (risk === "read") return "run";
  if (opts.tainted) return "approve";
  if (risk === "write") return policy.autonomy === "suggest" ? "approve" : "run";
  if (policy.autonomy === "suggest" || !templateId) return "approve";
  const preApproved = policy.whitelistedTemplates.includes(templateId);
  if (templateId.startsWith("job_board:"))
    return policy.autonomy === "autonomous" && preApproved ? "run" : "approve";
  return policy.autonomy === "autonomous" || preApproved ? "run" : "approve";
}

/** The AI phone agents whose calls the Voice Guard reviews. */
export const VOICE_CALL_AGENTS = ["screening_call", "scheduling_call", "negotiation_call"] as const;

/**
 * The Voice Guard is mandatory, not opt-in: it is on whenever any AI phone
 * agent is on (and cannot be switched off while one is), and its only write —
 * its own review — never waits for Suggest-level approval. The org-wide pause
 * still stops it. (A run whose transcript tripped the injection tripwire is
 * still held for a person, like any agent.)
 */
export function voiceGuardPolicy(
  base: Pick<EffectivePolicy, "enabled" | "autonomy">,
  o: { orgPaused: boolean; voiceAgentOn: boolean },
): Pick<EffectivePolicy, "enabled" | "autonomy"> {
  return {
    enabled: !o.orgPaused && (base.enabled || o.voiceAgentOn),
    autonomy: base.autonomy === "suggest" ? "act_and_notify" : base.autonomy,
  };
}

/** The org-wide switch ('*') and the agent's own row (opt-in), merged over the defaults. */
export async function loadPolicy(orgId: string, agentType: AgentType): Promise<EffectivePolicy> {
  const guard = agentType === "voice_guard";
  const rows = await db
    .select()
    .from(agentPolicies)
    .where(
      and(
        eq(agentPolicies.orgId, orgId),
        inArray(agentPolicies.agentType, ["*", agentType, ...(guard ? VOICE_CALL_AGENTS : [])]),
      ),
    );
  const orgWide = rows.find((r) => r.agentType === "*");
  const own = rows.find((r) => r.agentType === agentType);
  const mandatory = guard
    ? voiceGuardPolicy(
        {
          enabled: own?.enabled === true,
          autonomy: own?.autonomy ?? DEFAULT_POLICY.autonomy,
        },
        {
          orgPaused: orgWide?.enabled === false,
          voiceAgentOn: rows.some(
            (r) => (VOICE_CALL_AGENTS as readonly string[]).includes(r.agentType) && r.enabled,
          ),
        },
      )
    : null;
  return {
    enabled: mandatory?.enabled ?? (orgWide?.enabled !== false && own?.enabled === true),
    autonomy: mandatory?.autonomy ?? own?.autonomy ?? DEFAULT_POLICY.autonomy,
    whitelistedTemplates: own?.whitelistedTemplates ?? [],
    monthlyTokenBudget: own?.monthlyTokenBudget ?? null,
    maxStepsPerLeg: own?.maxStepsPerLeg ?? null,
    maxTokensPerLeg: own?.maxTokensPerLeg ?? null,
  };
}
