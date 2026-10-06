/**
 * The agent run currently executing on this async call chain. Set by the
 * runtime around each run, read by the AI ledger so every request — model
 * turns and AI calls inside tools — is attributed to its run.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type AgentRunScope = { runId: string; orgId: string; agentType: string };

export const agentRunScope = new AsyncLocalStorage<AgentRunScope>();

export function currentAgentRun(): AgentRunScope | undefined {
  return agentRunScope.getStore();
}
