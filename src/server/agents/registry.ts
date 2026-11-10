/**
 * Agent and tool registry (docs/agentic-plan.md §3.4, §4).
 *
 * A tool wraps the core logic of an existing server function; it runs with
 * the run's principal so `assertRole` and org predicates apply exactly as for
 * that person. Agents only see the tools their definition lists.
 */
import type { z } from "zod";

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
  /**
   * Checked before a person is asked (and before the tool runs): a reason the
   * call is pointless now (e.g. it would repeat or is already done). The reason
   * goes back to the agent instead of an approval card. Must only read.
   */
  precheck?: (ctx: ToolContext, input: I) => Promise<string | null>;
  /**
   * Facts the system states on the approval card (never left to the agent),
   * e.g. the interview times a scheduling call will offer. Must only read.
   */
  brief?: (ctx: ToolContext, input: I) => Promise<string>;
  /**
   * A proposal tool (propose_*): calling it never runs anything — it opens a
   * person's decision on `subject` (a gate; the system checks it and states
   * the facts), whatever the agent's autonomy. `run` is not called.
   */
  proposes?: (
    ctx: ToolContext,
    input: I,
  ) => Promise<{ title: string; summary: string; subject: unknown }>;
  run: (ctx: ToolContext, input: I) => Promise<unknown>;
};

/** Kinds of human decision an agent may ask for with request_approval. */
export type GateKind =
  | "requisition"
  | "jd"
  | "rejection"
  | "screening_decision"
  | "hiring_decision"
  | "panel_approval"
  | "panel_substitute"
  | "panel_review"
  | "org_profile"
  | "expert_brief"
  | "general";

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
const GATE_VERB =
  /(^|_)(approve|approval|release|reject|hire|revoke|decline|accept|confirm|sign|advance|finalize|complete)(_|$)/;
const ALLOWED_PREFIX = /^(propose|request|submit)_/;

/**
 * Prefixed tools whose `run` only moves work INTO a human chain — a draft
 * sent for review, a version filed for approval — and never decides an
 * outcome. Reviewed by name; anything else prefixed must carry an approval
 * anchor (`proposes` decision card, `approverRole`, or `templateOf`
 * external-send routing) so the prefix always means "a person decides"
 * (2026-11 audit N-9).
 */
export const SUBMISSION_TOOLS: ReadonlySet<string> = new Set([
  "submit_requisition_for_approval",
  "submit_jd_version",
  "submit_offer_for_approval",
  "submit_profile_version",
  "propose_profile_items",
  // In-call negotiation tool: passes the candidate's spoken yes to the hiring
  // team, who confirm it with them — it does not agree anything itself.
  "submit_agreed_terms",
  // In-call negotiation tool: asks for a person to take the call over.
  "request_human_call",
  // Prepares a pay discussion for a person to review; the send itself is
  // always approved by the HR head (send_negotiation_message).
  "propose_negotiation",
  // Marks roles as "waiting to be posted" — the person posts on the portal
  // themselves (the extension only fills the form they are looking at).
  "request_hand_posting",
  // The Voice Guard files its after-call review for a person (Call reviews);
  // it changes nothing on the call, the candidate or any decision.
  "submit_call_review",
]);

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
  if (
    ALLOWED_PREFIX.test(tool.name) &&
    !tool.proposes &&
    !tool.approverRole &&
    !tool.templateOf &&
    !SUBMISSION_TOOLS.has(tool.name)
  ) {
    throw new Error(
      `Tool ${tool.name} uses a propose_/request_/submit_ prefix but no human approval anchors it (proposes, approverRole or templateOf); add one or review it into SUBMISSION_TOOLS.`,
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

/** Every registered tool's name and whether it carries an approval card (CI checks). */
export function listTools(): { name: string; proposes: boolean }[] {
  return [...tools.values()].map((t) => ({
    name: t.name,
    proposes: Boolean((t as { proposes?: unknown }).proposes),
  }));
}

/** Skills an agent exercises: its own model turns plus every AI feature its tools call. */
export function skillsOf(def: AgentDefinition): AiFeature[] {
  const out = new Set<AiFeature>([def.feature]);
  for (const name of def.tools) for (const s of getTool(name)?.skills ?? []) out.add(s);
  return [...out];
}
