/**
 * Orchestrator v1 (docs/agentic-plan.md §3.1) — deterministic, no model.
 *
 * Drains agent_events and, per event:
 *  1. closes inbox gate tasks whose requisition / JD was decided elsewhere, so
 *     the waiting run carries on;
 *  2. starts the next agent in the requisition → JD → publish chain when the
 *     organisation has switched that agent on and none is already working on
 *     the requisition.
 *
 * Runs act for the member who raised the requisition (falling back to the
 * member whose action produced the event).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db";
import { agentEvents, agentRuns, jobDescriptions, requisitions } from "@db/schema";
import { log } from "../log";
import { loadPolicy } from "./policy";
import { getAgent } from "./registry";
import { startRun, syncGateTasks } from "./runtime.server";
import { activeRunFor } from "./tools";

const MAX_ATTEMPTS = 3;

export type OrchestratorCounts = {
  processed: number;
  started: number;
  synced: number;
  failed: number;
};

export async function processAgentEvents(
  opts: { max?: number; orgId?: string } = {},
): Promise<OrchestratorCounts> {
  const max = Math.min(Math.max(opts.max ?? 50, 1), 200);
  const counts: OrchestratorCounts = { processed: 0, started: 0, synced: 0, failed: 0 };

  const dueIds = db
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.status, "pending"),
        opts.orgId ? eq(agentEvents.orgId, opts.orgId) : undefined,
      ),
    )
    .orderBy(agentEvents.createdAt)
    .limit(max)
    .for("update", { skipLocked: true });
  const claimed = await db
    .update(agentEvents)
    .set({ status: "processing", updatedAt: new Date() })
    .where(inArray(agentEvents.id, dueIds))
    .returning();

  for (const e of claimed) {
    try {
      const r = await handle(e);
      counts.started += r.started;
      counts.synced += r.synced;
      await db
        .update(agentEvents)
        .set({ status: "done", updatedAt: new Date() })
        .where(eq(agentEvents.id, e.id));
      counts.processed++;
    } catch (err) {
      counts.failed++;
      const attempts = e.attempts + 1;
      log.error("agent.orchestrator.event_failed", {
        org_id: e.orgId,
        event_id: e.id,
        type: e.type,
        error: err as Error,
      });
      await db
        .update(agentEvents)
        .set({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          lastError: err instanceof Error ? err.message.slice(0, 500) : String(err),
          updatedAt: new Date(),
        })
        .where(eq(agentEvents.id, e.id));
    }
  }
  return counts;
}

type Event = typeof agentEvents.$inferSelect;

async function handle(e: Event): Promise<{ started: number; synced: number }> {
  let synced = 0;
  let started = 0;
  if (!e.subjectId) return { started, synced };

  // 1. Keep inbox gates in step with decisions made on the regular pages.
  if (e.type === "requisition.status_changed") {
    const from = String((e.payload as { from?: string }).from ?? "");
    synced += await syncGateTasks(
      e.orgId,
      { type: "requisition", id: e.subjectId },
      e.actorUserId,
      from,
    );
  }
  if (e.type === "jd.approved" || e.type === "jd.changes_requested") {
    synced += await syncGateTasks(
      e.orgId,
      { type: "jd", id: e.subjectId },
      e.actorUserId,
      "pending_dh",
    );
  }

  // 2. Dispatch the next agent in the chain.
  const payload = e.payload as { to?: string; requisitionId?: string; comment?: string };
  const requisitionId = e.subjectType === "requisition" ? e.subjectId : payload.requisitionId;
  if (!requisitionId) return { started, synced };
  const [req] = await db
    .select({
      id: requisitions.id,
      code: requisitions.code,
      title: requisitions.title,
      status: requisitions.status,
      createdBy: requisitions.createdBy,
    })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, e.orgId)))
    .limit(1);
  if (!req) return { started, synced };
  const principal = req.createdBy ?? e.actorUserId;
  if (!principal) return { started, synced };

  const dispatch = async (agent: "jd" | "publishing", goal: string) => {
    if (!getAgent(agent)) return;
    const policy = await loadPolicy(e.orgId, agent);
    if (!policy.enabled) return;
    if (await activeRunFor(e.orgId, agent, req.id)) return;
    await startRun({
      orgId: e.orgId,
      agentType: agent,
      principalUserId: principal,
      goal: `${goal}\n\nRequisition id: ${req.id}`,
      subjectType: "requisition",
      subjectId: req.id,
      triggerEventId: e.id,
    });
    started++;
  };

  const latestJd = async () =>
    (
      await db
        .select({ status: jobDescriptions.status })
        .from(jobDescriptions)
        .where(and(eq(jobDescriptions.requisitionId, req.id), eq(jobDescriptions.orgId, e.orgId)))
        .orderBy(desc(jobDescriptions.version))
        .limit(1)
    )[0];

  if (e.type === "requisition.status_changed" && payload.to === "approved") {
    const jd = await latestJd();
    if (!jd || jd.status === "draft" || jd.status === "changes_requested") {
      await dispatch(
        "jd",
        `Requisition ${req.code} "${req.title}" is approved. Draft its job description and get it approved by the department head.`,
      );
    }
  }

  if (e.type === "jd.changes_requested") {
    await dispatch(
      "jd",
      `The department head asked for changes to the job description for ${req.code} "${req.title}": ${payload.comment ?? "(no comment)"}. Revise it and resubmit.`,
    );
  }

  if (e.type === "jd.approved" && req.status === "approved") {
    const [published] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, e.orgId),
          eq(agentRuns.agentType, "publishing"),
          eq(agentRuns.subjectId, req.id),
          eq(agentRuns.status, "done"),
        ),
      )
      .limit(1);
    if (!published) {
      await dispatch(
        "publishing",
        `Requisition ${req.code} "${req.title}" and its job description are approved. Publish it internally and prepare the external posts.`,
      );
    }
  }
  return { started, synced };
}

/* ------------------------------------------------------ inline kick (dev UX) */

const kicking = new Set<string>();

/**
 * Best-effort: process this org's events and advance its runs right away, so
 * people see agents react without waiting for the next scheduler tick. The
 * scheduler (/api/public/agent-tick) remains the source of truth. Disabled in
 * tests and with AGENT_INLINE_KICK=0.
 */
export function kickAgents(orgId: string): void {
  if (process.env["NODE_ENV"] === "test" || process.env["AGENT_INLINE_KICK"] === "0") return;
  if (kicking.has(orgId)) return;
  kicking.add(orgId);
  void (async () => {
    try {
      const { ensureAgentsRegistered } = await import("./index");
      ensureAgentsRegistered();
      const { runAgentTick } = await import("./runtime.server");
      for (let i = 0; i < 3; i++) {
        const c = await runAgentTick({ orgId, max: 3 });
        if (!c.claimed && !c.reclaimed) break;
      }
    } catch (err) {
      log.warn("agent.kick.failed", { org_id: orgId, error: err as Error });
    } finally {
      kicking.delete(orgId);
    }
  })();
}

/** Events still waiting, for diagnostics. */
export async function pendingEventCount(orgId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentEvents)
    .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.status, "pending")));
  return Number(r?.n ?? 0);
}
