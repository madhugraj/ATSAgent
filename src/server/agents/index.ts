/**
 * Agent definitions and tools register here, so every entry point that
 * drives or inspects agents sees the same set (docs/agentic-plan.md §10).
 */
import { getAgent } from "./registry";
import { registerPhase1Agents } from "./definitions";
import { registerPhase1Tools } from "./tools";
import type { AgentType } from "@db/schema";

let registered = false;

/** Idempotent: register the built-in agents and tools once per process. */
export function ensureAgentsRegistered(): void {
  if (registered) return;
  registered = true;
  registerPhase1Tools();
  registerPhase1Agents();
}

ensureAgentsRegistered();

/** Whether an agent type has a definition in this build. */
export function isAgentLive(type: AgentType): boolean {
  return getAgent(type) !== undefined;
}
