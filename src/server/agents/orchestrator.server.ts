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
  offers,
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

  if (e.type === "offer.status_changed") {
    const from = String((e.payload as { from?: string }).from ?? "");
    synced += await syncGateTasks(e.orgId, { type: "offer", id: e.subjectId }, e.actorUserId, from);
  }

  // 2. Dispatch the next agent in the chain.
  const payload = e.payload as {
    to?: string;
    requisitionId?: string;
    applicationId?: string;
    comment?: string;
  };
  // Candidate- and offer-level events: find the application and its requisition.
  const applicationId =
    e.subjectType === "application" ? e.subjectId : (payload.applicationId ?? null);
  let requisitionId = e.subjectType === "requisition" ? e.subjectId : payload.requisitionId;
  if (!requisitionId && applicationId) {
    const [app] = await db
      .select({ requisitionId: applications.requisitionId })
      .from(applications)
      .where(and(eq(applications.id, applicationId), eq(applications.orgId, e.orgId)))
      .limit(1);
    requisitionId = app?.requisitionId;
  }
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
    agent: "jd" | "publishing" | "screening" | "interview" | "evaluation" | "offer" | "onboarding",
    goal: string,
    /** Per-candidate work (evaluation) de-duplicates on the application instead. */
    subject: { type: "requisition" | "application"; id: string } = {
      type: "requisition",
      id: req.id,
    },
  ) => {
    if (!getAgent(agent)) return;
    const policy = await loadPolicy(e.orgId, agent);
    if (!policy.enabled) {
      // A hiring-desk thread waiting on this role hears why nothing happens.
      const { notifyAgentOff } = await import("../desk/desk.server");
      await notifyAgentOff(e.orgId, req.id, agent);
      return;
    }
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

  // A closed or rejected role: stop its agents and end its hiring-desk thread.
  if (
    e.type === "requisition.status_changed" &&
    (payload.to === "closed" || payload.to === "rejected")
  ) {
    const { onRequisitionEnded } = await import("../desk/desk.server");
    await onRequisitionEnded(e.orgId, req.id, payload.to, e.actorUserId);
  }

  if (e.type === "requisition.status_changed" && payload.to === "approved") {
    // Hiring desk: the person chose to reuse an earlier role's approved JD.
    const { reuseJdIfChosen } = await import("../desk/desk.server");
    const reused = await reuseJdIfChosen(e.orgId, req.id);
    const jd = reused ? { status: "approved" as const } : await latestJd();
    if (!jd || jd.status === "draft" || jd.status === "changes_requested") {
      await dispatch(
        "jd",
        `Requisition ${req.code} "${req.title}" is approved. Draft its job description and get it approved by the department head.`,
      );
    }
  }

  // Hiring desk: once a thread's JD is approved, rank candidates for it.
  if (e.type === "jd.approved") {
    const { onJdApproved } = await import("../desk/desk.server");
    await onJdApproved(e.orgId, req.id, e.subjectType === "jd" ? e.subjectId : null);
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

  if (applicationId && e.type === "hiring.selected") {
    await dispatch(
      "offer",
      `The hiring manager selected candidate application ${applicationId} for ${req.code} "${req.title}". Prepare the offer within the approved band and take it through approval.`,
      { type: "application", id: applicationId },
    );
  }

  if (applicationId && e.type === "offer.status_changed" && payload.to === "approved") {
    await dispatch(
      "onboarding",
      `The offer for candidate application ${applicationId} (${req.code} "${req.title}") is approved. Collect and cross-check the pre-onboarding documents, ask HR to validate them, then ask for the release.`,
      { type: "application", id: applicationId },
    );
  }

  if (applicationId && e.type === "onboarding.document_received") {
    // Only once the candidate has an approved offer (documents can arrive earlier).
    const [approved] = await db
      .select({ id: offers.id })
      .from(offers)
      .where(
        and(
          eq(offers.orgId, e.orgId),
          eq(offers.applicationId, applicationId),
          eq(offers.status, "approved"),
        ),
      )
      .limit(1);
    if (approved)
      await dispatch(
        "onboarding",
        `A pre-onboarding document arrived for candidate application ${applicationId} (${req.code} "${req.title}"). Check readiness and ask HR to validate what is pending.`,
        { type: "application", id: applicationId },
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
          eq(agentRuns.mode, "live"),
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
/** New applicants wait at most this long for an intake run (minutes between runs per role). */
const FRESH_INTAKE_MINUTES = 10;
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
        // Dry-run replays never stand in for real work.
        eq(agentRuns.mode, "live"),
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
  // Applicants who just arrived (any channel) are scored within minutes, not
  // at the next 6-hourly pass; agent-added ones are scored by the run that added them.
  if (getAgent("intake")) {
    for (const orgId of await enabledOrgs("intake", opts.orgId)) {
      const fresh = (await db.execute(sql`
        select a.requisition_id id, count(*)::int n, string_agg(distinct a.source, ', ') sources
        from ${applications} a
        join ${requisitions} r on r.id = a.requisition_id and r.status = 'approved'
        where a.org_id = ${orgId}
          and a.applied_at >= now() - interval '2 hours'
          and a.source not like 'agent%'
          and not exists (select 1 from ${matchScores} m where m.application_id = a.id)
        group by a.requisition_id
        limit 10`)) as unknown as { id: string; n: number; sources: string }[];
      for (const f of fresh) {
        const [busy] = (await db.execute(sql`
          select 1 from agent_runs where org_id = ${orgId} and agent_type = 'intake'
            and subject_id = ${f.id} and mode = 'live'
            and (status in ('queued','running','awaiting_human') or created_at >= now() - interval '${sql.raw(String(FRESH_INTAKE_MINUTES))} minutes')
          limit 1`)) as unknown as unknown[];
        if (busy) continue;
        const [r] = await db
          .select({
            code: requisitions.code,
            title: requisitions.title,
            createdBy: requisitions.createdBy,
          })
          .from(requisitions)
          .where(and(eq(requisitions.id, f.id), eq(requisitions.orgId, orgId)))
          .limit(1);
        const principal = r?.createdBy ?? (await ownerOf(orgId));
        if (!r || !principal) continue;
        await startRun({
          orgId,
          agentType: "intake",
          principalUserId: principal,
          goal: `${f.n} new application(s) arrived for ${r.code} "${r.title}" (via ${f.sources}). Score them and review who should be shortlisted.\n\nRequisition id: ${f.id}`,
          subjectType: "requisition",
          subjectId: f.id,
        });
        started++;
      }
    }
  }
  // Starving roles get the Sourcing agent (once a day per role at most), and
  // new CVs in the pool are checked against the open roles (plain code).
  if (getAgent("sourcing")) {
    const { starvingRoles } = await import("./sourcing.server");
    const { matchNewCvsToRoles } = await import("./pool-match.server");
    for (const orgId of await enabledOrgs("sourcing", opts.orgId)) {
      try {
        await matchNewCvsToRoles(orgId);
      } catch (err) {
        log.warn("pool.match_failed", { org_id: orgId, error: err as Error });
      }
      for (const r of await starvingRoles(orgId)) {
        const principal = r.createdBy ?? (await ownerOf(orgId));
        if (!principal) continue;
        await startRun({
          orgId,
          agentType: "sourcing",
          principalUserId: principal,
          goal: `${r.code} "${r.title}" needs more candidates. Check its supply, top it up from the talent pool and past candidates, and recommend what to change.\n\nRequisition id: ${r.id}`,
          subjectType: "requisition",
          subjectId: r.id,
        });
        started++;
      }
    }
  }
  // Interview times nobody chose in time close, and the team hears about it.
  try {
    const { expireOffers } = await import("@/lib/slot-offers.server");
    await expireOffers(opts.orgId);
  } catch (err) {
    log.warn("interview.slot_expiry_failed", { error: err as Error });
  }
  // Hiring-desk threads hear about new applicants.
  try {
    const { announceNewApplicants } = await import("../desk/desk.server");
    await announceNewApplicants(opts.orgId);
  } catch (err) {
    log.warn("desk.announce_failed", { error: err as Error });
  }
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
