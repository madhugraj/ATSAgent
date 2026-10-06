/**
 * Agent and tool registry (docs/agentic-plan.md §3.4, §4).
 *
 * A tool wraps the core logic of an existing server function; it runs with
 * the run's principal so `assertRole` and org predicates apply exactly as for
 * that person. Agents only see the tools their definition lists.
 */
import type { z } from "zod/v4";

import type { AiFeature } from "../ai-usage";
import type { AgentType } from "@db/schema";
import type { ToolRisk } from "./policy";

export type ToolContext = {
  orgId: string;
  principalUserId: string;
  runId: string;
  agentType: AgentType;
  /** Audit actor label: agent:<type>:<runId>. */
  actor: string;
};

export type AgentTool<I = unknown> = {
  name: string;
  description: string;
  input: z.ZodType<I>;
  risk: ToolRisk;
  /** Content template an external tool would send — matched against the org whitelist. */
  templateOf?: (input: I) => string | null;
  /** Output carries third-party text (CV, mail, document) and is fenced with untrusted(). */
  untrustedOutput?: boolean;
  /** One-line description of the call, used as the approval card title. */
  describe?: (input: I) => string;
  run: (ctx: ToolContext, input: I) => Promise<unknown>;
};

export type AgentDefinition = {
  type: AgentType;
  feature: AiFeature;
  /** Role-specific instructions; the runtime prepends INJECTION_RULES and HITL rules. */
  system: string;
  /** Tool names this agent may call (the HITL tools are always available). */
  tools: string[];
  maxSteps?: number;
};

const tools = new Map<string, AgentTool<never>>();
const agents = new Map<AgentType, AgentDefinition>();

/**
 * Gate guard (docs/agentic-plan.md §1 principle 2): approving, releasing,
 * rejecting, hiring and revoking are human decisions, so no agent tool may
 * perform them. Agents can only `propose_*`, `request_*` or `submit_*` (send
 * for a human's approval). Enforced at registration so a gate tool can never
 * reach a model.
 */
const GATE_VERB = /(^|_)(approve|approval|release|reject|hire|revoke|decline|accept)(_|$)/;
const ALLOWED_PREFIX = /^(propose|request|submit)_/;

export function isGateToolName(name: string): boolean {
  return GATE_VERB.test(name) && !ALLOWED_PREFIX.test(name);
}

export function registerTool<I>(tool: AgentTool<I>): void {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(tool.name)) {
    throw new Error(`Invalid tool name: ${tool.name}`);
  }
  if (isGateToolName(tool.name)) {
    throw new Error(
      `Tool ${tool.name} would perform a human decision; expose propose_/request_/submit_ instead.`,
    );
  }
  tools.set(tool.name, tool as unknown as AgentTool<never>);
}

export function registerAgent(def: AgentDefinition): void {
  agents.set(def.type, def);
}

export function getTool(name: string): AgentTool<unknown> | undefined {
  return tools.get(name) as AgentTool<unknown> | undefined;
}

export function getAgent(type: AgentType): AgentDefinition | undefined {
  return agents.get(type);
}

/** Test helper: forget everything registered. */
export function resetRegistry(): void {
  tools.clear();
  agents.clear();
}
