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

/**
 * The role / candidate an AI request is being made for, on this async call
 * chain — so the ledger can report what hiring each candidate cost. Nested
 * scopes add detail (a requisition scope, then an application inside it).
 * `events` collects the ledger rows written inside the scope, for work that
 * only learns who the candidate is afterwards (reading a new CV).
 */
export type AiSubject = {
  requisitionId?: string | null;
  applicationId?: string | null;
  candidateId?: string | null;
  events?: string[];
};

export const aiSubjectScope = new AsyncLocalStorage<AiSubject>();

export function currentAiSubject(): AiSubject | undefined {
  return aiSubjectScope.getStore();
}

export function withAiSubject<T>(subject: AiSubject, fn: () => Promise<T>): Promise<T> {
  const outer = aiSubjectScope.getStore();
  const merged: AiSubject = {
    requisitionId: subject.requisitionId ?? outer?.requisitionId ?? null,
    applicationId: subject.applicationId ?? outer?.applicationId ?? null,
    candidateId: subject.candidateId ?? outer?.candidateId ?? null,
    // Inner scopes share the outer collector unless they bring their own.
    ...(subject.events
      ? { events: subject.events }
      : outer?.events
        ? { events: outer.events }
        : {}),
  };
  return aiSubjectScope.run(merged, fn);
}
