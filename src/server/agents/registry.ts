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
import type { AppRole } from "@/lib/auth.middleware";
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
  /** AI features (skills) the tool itself calls — ledger slugs from AI_FEATURES. */
  skills?: AiFeature[];
  /** One-line description of the call, used as the approval card title. */
  describe?: (input: I) => string;
  /**
   * Approval requests for this tool go to this role instead of the person the
   * agent works for; once approved the tool runs as the approver (e.g. job-board
   * posts: anyone may ask, the HR head decides and posts).
   */
  approverRole?: AppRole;
  run: (ctx: ToolContext, input: I) => Promise<unknown>;
};

/** Kinds of human decision an agent may ask for with request_approval. */
export type GateKind = "requisition" | "jd" | "rejection" | "hiring_decision" | "general";

/**
 * Agent manifest (docs/agentic-plan.md §6): the single, versioned source of an
 * agent's identity, accountability and permissions. The runtime builds the
 * agent from it, every run records the exact manifest version and hash it ran
 * under, and the agent register shows it to auditors.
 */
export type AgentDefinition = {
  type: AgentType;
  /** Human-readable name shown in the register. */
  name: string;
  /** Semantic version; must change whenever the manifest hash changes (CI-enforced). */
  version: string;
  /** Role accountable for this agent's behaviour in an organisation. */
  owner: AppRole;
  /** What the agent is accountable for, in one or two sentences. */
  responsibility: string;
  /** Explicit prohibitions, beyond what the runtime enforces. */
  mustNever: string[];
  /** Data the agent may touch, in plain words (reads / internal writes / outside the org). */
  scope: { reads: string[]; writes: string[]; external: string[] };
  /** Human decisions it may request. */
  gates: GateKind[];
  /** Impact if it misbehaves: drives review depth and default autonomy guidance. */
  riskTier: "low" | "medium" | "high";
  /** Eval scenario names (scripts/evals/scenarios.ts) that cover it; CI requires at least one. */
  evals: string[];
  /** Ledger slug for its own model turns. */
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

/** All registered agents (for the register, CI checks and definition snapshots). */
export function listAgents(): AgentDefinition[] {
  return [...agents.values()];
}

/** Skills an agent exercises: its own model turns plus every AI feature its tools call. */
export function skillsOf(def: AgentDefinition): AiFeature[] {
  const out = new Set<AiFeature>([def.feature]);
  for (const name of def.tools) for (const s of getTool(name)?.skills ?? []) out.add(s);
  return [...out];
}
