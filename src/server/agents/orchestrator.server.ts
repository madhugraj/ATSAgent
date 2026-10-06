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
import {
  agentEvents,
  agentPolicies,
  agentRuns,
  applications,
  jobDescriptions,
  matchScores,
  orgMembers,
  requisitions,
} from "@db/schema";
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

  const dispatch = async (
    agent: "jd" | "publishing" | "screening" | "interview" | "evaluation",
    goal: string,
    /** Per-candidate work (evaluation) de-duplicates on the application instead. */
    subject: { type: "requisition" | "application"; id: string } = {
      type: "requisition",
      id: req.id,
    },
  ) => {
    if (!getAgent(agent)) return;
    const policy = await loadPolicy(e.orgId, agent);
    if (!policy.enabled) return;
    if (await activeRunFor(e.orgId, agent, subject.id)) return;
    await startRun({
      orgId: e.orgId,
      agentType: agent,
      principalUserId: principal,
      goal: `${goal}\n\nRequisition id: ${req.id}`,
      subjectType: subject.type,
      subjectId: subject.id,
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

  if (e.type === "application.shortlisted") {
    const ids = (e.payload as { applicationIds?: string[] }).applicationIds ?? [];
    await dispatch(
      "screening",
      `${ids.length} candidate(s) were shortlisted for ${req.code} "${req.title}". Prepare their screening kits, send assessments and summarise who should proceed.`,
    );
  }

  if (e.type === "application.advanced") {
    const ids = (e.payload as { applicationIds?: string[] }).applicationIds ?? [];
    await dispatch(
      "interview",
      `${ids.length} candidate(s) advanced to an interview round for ${req.code} "${req.title}". Book their next rounds.`,
    );
  }

  if (e.type === "scorecard.submitted") {
    const p = e.payload as { applicationId?: string; level?: number; verdict?: string };
    await dispatch(
      "evaluation",
      `A level ${p.level ?? "?"} scorecard (${p.verdict ?? "?"}) was submitted for ${req.code} "${req.title}". Debrief candidate application ${p.applicationId} and ask the hiring manager for the hiring decision.`,
      p.applicationId ? { type: "application", id: p.applicationId } : undefined,
    );
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

/* ------------------------------------------------------------------ sweeps */

const INTAKE_COOLDOWN_HOURS = 6;
const FOLLOWUP_COOLDOWN_HOURS = 20;

async function enabledOrgs(agentType: string, orgId?: string): Promise<string[]> {
  const rows = await db
    .select({ orgId: agentPolicies.orgId })
    .from(agentPolicies)
    .where(
      and(
        eq(agentPolicies.agentType, agentType as never),
        eq(agentPolicies.enabled, true),
        orgId ? eq(agentPolicies.orgId, orgId) : undefined,
        sql`not exists (select 1 from agent_policies p where p.org_id = ${agentPolicies.orgId} and p.agent_type = '*' and p.enabled = false)`,
      ),
    );
  return rows.map((r) => r.orgId);
}

async function ownerOf(orgId: string): Promise<string | null> {
  const [o] = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.isOwner, true),
        eq(orgMembers.status, "active"),
      ),
    )
    .limit(1);
  return o?.userId ?? null;
}

async function recentRun(
  orgId: string,
  agentType: string,
  hours: number,
  subjectId?: string,
): Promise<boolean> {
  const [r] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentType, agentType as never),
        subjectId ? eq(agentRuns.subjectId, subjectId) : undefined,
        sql`(${agentRuns.status} in ('queued','running','awaiting_human') or ${agentRuns.createdAt} >= now() - make_interval(hours => ${hours}))`,
      ),
    )
    .limit(1);
  return Boolean(r);
}

/**
 * Time-based work the event stream does not cover (docs/agentic-plan.md §3.1):
 * intake for approved requisitions with unscored or held applications, and a
 * daily follow-up pass. Only for organisations that switched the agent on.
 */
export async function scheduleSweeps(opts: { orgId?: string } = {}): Promise<number> {
  let started = 0;
  if (getAgent("intake")) {
    for (const orgId of await enabledOrgs("intake", opts.orgId)) {
      const reqs = await db
        .select({
          id: requisitions.id,
          code: requisitions.code,
          title: requisitions.title,
          createdBy: requisitions.createdBy,
        })
        .from(requisitions)
        .where(
          and(
            eq(requisitions.orgId, orgId),
            eq(requisitions.status, "approved"),
            sql`exists (
              select 1 from ${applications} a
              left join ${matchScores} m on m.application_id = a.id
              where a.requisition_id = ${requisitions.id}
                and (m.id is null or a.stage = 'ai_screened')
            )`,
          ),
        )
        .limit(5);
      for (const r of reqs) {
        if (await recentRun(orgId, "intake", INTAKE_COOLDOWN_HOURS, r.id)) continue;
        const principal = r.createdBy ?? (await ownerOf(orgId));
        if (!principal) continue;
        await startRun({
          orgId,
          agentType: "intake",
          principalUserId: principal,
          goal: `Review the pipeline for ${r.code} "${r.title}": score new applications, review held candidates, propose rejections for a person to confirm, and top up from the talent pool if the shortlist is thin.\n\nRequisition id: ${r.id}`,
          subjectType: "requisition",
          subjectId: r.id,
        });
        started++;
      }
    }
  }
  if (getAgent("followup")) {
    for (const orgId of await enabledOrgs("followup", opts.orgId)) {
      if (await recentRun(orgId, "followup", FOLLOWUP_COOLDOWN_HOURS)) continue;
      const owner = await ownerOf(orgId);
      if (!owner) continue;
      await startRun({
        orgId,
        agentType: "followup",
        principalUserId: owner,
        goal: "Daily follow-up: find everything overdue and remind the right people.",
      });
      started++;
    }
  }
  return started;
}
