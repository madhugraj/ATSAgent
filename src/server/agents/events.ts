/**
 * Domain events for the orchestrator (docs/agentic-plan.md §3.1). Written by
 * the lifecycle cores after a successful change; never blocks the change.
 */
import { db } from "../db";
import { agentEvents } from "@db/schema";
import { log } from "../log";

export type AgentEventType =
  | "requisition.created"
  | "requisition.status_changed"
  | "jd.submitted"
  | "jd.approved"
  | "jd.changes_requested"
  | "application.shortlisted";

export async function emitAgentEvent(e: {
  orgId: string;
  type: AgentEventType;
  subjectType: "requisition" | "jd";
  subjectId: string;
  actorUserId: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(agentEvents).values({
      orgId: e.orgId,
      type: e.type,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      actorUserId: e.actorUserId,
      payload: e.payload ?? {},
    });
    const { kickAgents } = await import("./orchestrator.server");
    kickAgents(e.orgId);
  } catch (err) {
    log.error("agent.event.emit_failed", { org_id: e.orgId, type: e.type, error: err as Error });
  }
}
