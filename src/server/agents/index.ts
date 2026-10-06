/**
 * Agent definitions register here (side-effect imports), so every entry point
 * that drives or inspects agents sees the same set. Phase 0 ships the runtime
 * only; agents arrive from Phase 1 (docs/agentic-plan.md §10).
 */
import { getAgent } from "./registry";
import type { AgentType } from "@db/schema";

/** Whether an agent type has a definition in this build. */
export function isAgentLive(type: AgentType): boolean {
  return getAgent(type) !== undefined;
}
