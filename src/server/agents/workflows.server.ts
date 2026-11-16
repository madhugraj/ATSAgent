/**
 * Agent workflows (platform super admin only; docs/agent-workflows.md).
 *
 * A workflow is a graph drawn in the builder: one trigger (a domain event, or
 * "manual" — a hiring need someone starts by hand), agents (stock or
 * published studio agents) with goals that may use event fields, conditions
 * (yes / no), wait-for steps (pause until an event happens on the flow's own
 * role, or a timeout), report steps and ends. Published versions are
 * immutable; granted organisations run them alongside the built-in flow.
 *
 * Nothing here bypasses the agent harness: every agent starts through
 * startRun with the organisation's own switch, autonomy, budget and the
 * de-duplication the orchestrator uses, acts for a person, and its human
 * decisions stay with people.
 */
import { createHash } from "node:crypto";

import { and, eq, inArray, isNull, lt } from "drizzle-orm";

import {
  agentRuns,
  agentTasks,
  agentWorkflowGrants,
  agentWorkflows,
  agentWorkflowVersions,
  applications,
  organizations,
  requisitions,
  users,
  workflowRuns,
  type AgentType,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowTestResult,
  type WorkflowTestScenario,
} from "@db/schema";
import { db } from "../db";
import { log } from "../log";
import { AGENT_EVENT_TYPES } from "./events";

export const MAX_NODES = 40;
const MAX_HOPS = 60;
/** The trigger of a workflow someone starts by hand with a hiring need. */
export const MANUAL_TRIGGER = "manual";
export const DEFAULT_WAIT_HOURS = 72;
export const MAX_WAIT_HOURS = 24 * 30;
const FIELD = /^(payload(\.[A-Za-z0-9_]+)+|subject_type|last\.(status|result)|wait\.status)$/;
const OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "exists"] as const;

/** What a running flow knows. */
export type WorkflowContext = {
  event: { type: string; subjectType: string; subjectId: string };
  /** The trigger's payload, merged with each awaited event's payload. */
  payload: Record<string, unknown>;
  /** How the last agent ended. */
  last: { status: string; result: string } | null;
  /** How the last wait ended: happened | timed_out. */
  wait?: { status: string; event: string; at: string } | null;
  /** The role the flow works on (from the trigger, or learned from its agents' work). */
  subject?: { type: string; id: string } | null;
  /** Every agent run the flow started or joined. */
  runs?: string[];
  principal?: string | null;
};

/* -------------------------------------------------------------- the graph */

export function triggerOf(g: WorkflowGraph): WorkflowNode | undefined {
  return g.nodes.find((n) => n.kind === "trigger");
}

/** The next node after `from`, following `branch` out of a condition. */
export function nextNode(
  g: WorkflowGraph,
  from: string,
  branch?: "yes" | "no",
): WorkflowNode | undefined {
  const edge = g.edges.find((e) => e.source === from && (branch ? e.branch === branch : !e.branch));
  return edge ? g.nodes.find((n) => n.id === edge.target) : undefined;
}

const isEvent = (e: string | undefined) =>
  (AGENT_EVENT_TYPES as readonly string[]).includes(e ?? "");

/**
 * Every problem with a graph (empty when it can be tested). `knownAgent`
 * says whether an agent type exists (stock, or a published studio agent).
 */
export function graphProblems(g: WorkflowGraph, knownAgent: (type: string) => boolean): string[] {
  const out: string[] = [];
  const label = (n: WorkflowNode) => n.data.label?.trim() || n.kind;
  if (!g.nodes.length) return ["Add a trigger to start the flow."];
  if (g.nodes.length > MAX_NODES) out.push(`A workflow has at most ${MAX_NODES} steps.`);
  const ids = new Set(g.nodes.map((n) => n.id));
  if (ids.size !== g.nodes.length) out.push("Two steps share an id.");
  const triggers = g.nodes.filter((n) => n.kind === "trigger");
  if (triggers.length !== 1) out.push("A workflow needs exactly one trigger.");
  for (const e of g.edges) {
    if (!ids.has(e.source) || !ids.has(e.target))
      out.push("A connection points to a missing step.");
    if (e.source === e.target) out.push("A step cannot connect to itself.");
  }
  for (const n of g.nodes) {
    const outgoing = g.edges.filter((e) => e.source === n.id);
    const incoming = g.edges.filter((e) => e.target === n.id);
    if (n.kind === "trigger") {
      if (n.data.event !== MANUAL_TRIGGER && !isEvent(n.data.event))
        out.push("Pick the event that starts the flow, or Manual (a hiring need).");
      if (incoming.length) out.push("Nothing may lead into the trigger.");
    }
    if (n.kind === "agent") {
      if (!n.data.agentType || !knownAgent(n.data.agentType))
        out.push(`"${label(n)}": pick an agent that exists.`);
      if (!n.data.goal?.trim()) out.push(`"${label(n)}": write the agent's goal.`);
      if ((n.data.goal ?? "").length > 2000) out.push(`"${label(n)}": the goal is too long.`);
    }
    if (n.kind === "wait") {
      if (!isEvent(n.data.event)) out.push(`"${label(n)}": pick the event to wait for.`);
      if (n.data.field) {
        if (!/^payload(\.[A-Za-z0-9_]+)+$/.test(n.data.field))
          out.push(`"${label(n)}": "only when" checks a payload.<name> field of the event.`);
        if (!OPS.includes((n.data.op ?? "") as (typeof OPS)[number]))
          out.push(`"${label(n)}": pick a comparison for "only when".`);
        if (n.data.op !== "exists" && (n.data.value ?? "").trim() === "")
          out.push(`"${label(n)}": give the value "only when" compares with.`);
      }
      const h = n.data.timeoutHours ?? DEFAULT_WAIT_HOURS;
      if (!Number.isFinite(h) || h < 1 || h > MAX_WAIT_HOURS)
        out.push(`"${label(n)}": wait between 1 and ${MAX_WAIT_HOURS} hours.`);
    }
    if (n.kind === "condition") {
      if (!FIELD.test(n.data.field ?? ""))
        out.push(
          `"${label(n)}": the field must be payload.<name>, subject_type, last.status, last.result or wait.status.`,
        );
      if (!OPS.includes((n.data.op ?? "") as (typeof OPS)[number]))
        out.push(`"${label(n)}": pick a comparison.`);
      if (n.data.op !== "exists" && (n.data.value ?? "").trim() === "")
        out.push(`"${label(n)}": give the value to compare with.`);
      if (outgoing.some((e) => e.branch !== "yes" && e.branch !== "no"))
        out.push(`"${label(n)}": each way out of a condition is yes or no.`);
      for (const b of ["yes", "no"] as const)
        if (outgoing.filter((e) => e.branch === b).length > 1)
          out.push(`"${label(n)}": only one "${b}" connection.`);
    } else {
      if (outgoing.some((e) => e.branch)) out.push(`"${label(n)}": only conditions branch.`);
      if (outgoing.length > 1) out.push(`"${label(n)}": connect it to one next step.`);
    }
    if (n.kind === "end" && outgoing.length) out.push("An end has no next step.");
  }
  const trigger = triggers[0];
  if (trigger) {
    // Everything is reachable from the trigger, and nothing loops.
    const seen = new Set<string>();
    const stack = new Set<string>();
    let cycle = false;
    const visit = (id: string) => {
      if (stack.has(id)) {
        cycle = true;
        return;
      }
      if (seen.has(id)) return;
      seen.add(id);
      stack.add(id);
      for (const e of g.edges.filter((x) => x.source === id)) visit(e.target);
      stack.delete(id);
    };
    visit(trigger.id);
    if (cycle) out.push("The flow loops back on itself; workflows run forward only.");
    const orphans = g.nodes.filter((n) => !seen.has(n.id));
    if (orphans.length) out.push(`Not connected to the trigger: ${orphans.map(label).join(", ")}.`);
  }
  return [...new Set(out)];
}

/** The value a condition's field names in the context. */
export function fieldValue(field: string, ctx: WorkflowContext): unknown {
  if (field === "subject_type") return ctx.subject?.type ?? ctx.event.subjectType;
  if (field === "last.status") return ctx.last?.status;
  if (field === "last.result") return ctx.last?.result;
  if (field === "wait.status") return ctx.wait?.status;
  let v: unknown = ctx.payload;
  for (const part of field.split(".").slice(1)) {
    if (v && typeof v === "object" && part in (v as Record<string, unknown>))
      v = (v as Record<string, unknown>)[part];
    else return undefined;
  }
  return v;
}

export function conditionHolds(n: WorkflowNode, ctx: WorkflowContext): boolean {
  const v = fieldValue(n.data.field ?? "", ctx);
  const want = (n.data.value ?? "").trim();
  const asText = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const num = Number(asText);
  const wantNum = Number(want);
  const numeric = asText !== "" && !Number.isNaN(num) && want !== "" && !Number.isNaN(wantNum);
  switch (n.data.op) {
    case "exists":
      return v != null && asText !== "";
    case "eq":
      return asText.toLowerCase() === want.toLowerCase();
    case "neq":
      return asText.toLowerCase() !== want.toLowerCase();
    case "contains":
      return asText.toLowerCase().includes(want.toLowerCase());
    case "gt":
      return numeric && num > wantNum;
    case "gte":
      return numeric && num >= wantNum;
    case "lt":
      return numeric && num < wantNum;
    case "lte":
      return numeric && num <= wantNum;
    default:
      return false;
  }
}

/** A goal with {{field}} placeholders filled from the context (missing → empty). */
export function renderGoal(goal: string, ctx: WorkflowContext): string {
  return goal.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, f: string) => {
    const v = FIELD.test(f) ? fieldValue(f, ctx) : undefined;
    return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

export function graphHash(g: WorkflowGraph): string {
  return createHash("sha256").update(JSON.stringify(g)).digest("hex");
}

/* ------------------------------------------------------------ dry-run test */

/**
 * Walk the flow with a sample event and the outcome of each agent and wait
 * step (an agent: done / failed; a wait: done = happens, failed = times out)
 * — no AI, no runs, nothing real. Returns the path and what went wrong.
 */
export function simulate(
  g: WorkflowGraph,
  s: WorkflowTestScenario,
): { path: string[]; failures: string[] } {
  const path: string[] = [];
  const failures: string[] = [];
  const trigger = triggerOf(g);
  if (!trigger) return { path, failures: ["No trigger."] };
  const ctx: WorkflowContext = {
    event: { type: trigger.data.event ?? "", subjectType: s.subjectType, subjectId: "sample" },
    payload: { ...s.payload },
    last: null,
    wait: null,
  };
  let node: WorkflowNode | undefined = trigger;
  for (let hop = 0; node && hop < MAX_HOPS; hop++) {
    path.push(node.id);
    if (node.kind === "end") break;
    if (node.kind === "agent") {
      const o = s.outcomes[node.id] ?? { status: "done", result: "" };
      ctx.last = { status: o.status, result: o.result };
      node = nextNode(g, node.id);
    } else if (node.kind === "wait") {
      const o = s.outcomes[node.id] ?? { status: "done", result: "" };
      ctx.wait = {
        status: o.status === "done" ? "happened" : "timed_out",
        event: node.data.event ?? "",
        at: "",
      };
      node = nextNode(g, node.id);
    } else if (node.kind === "condition") {
      node = nextNode(g, node.id, conditionHolds(node, ctx) ? "yes" : "no");
    } else node = nextNode(g, node.id);
  }
  if (s.expectEnd && path[path.length - 1] !== s.expectEnd)
    failures.push(
      `Expected to end at "${labelOf(g, s.expectEnd)}"; it ended at "${labelOf(g, path[path.length - 1] ?? "")}".`,
    );
  return { path, failures };
}

function labelOf(g: WorkflowGraph, id: string): string {
  const n = g.nodes.find((x) => x.id === id);
  return n ? n.data.label?.trim() || n.kind : id;
}

export function runTests(
  g: WorkflowGraph,
  scenarios: WorkflowTestScenario[],
  version: number,
): WorkflowTestResult {
  const runs = scenarios.map((s) => {
    const r = simulate(g, s);
    return { scenario: s.name, passed: r.failures.length === 0, ...r };
  });
  return {
    version,
    passed: runs.length > 0 && runs.every((r) => r.passed),
    at: new Date().toISOString(),
    runs,
  };
}

/* --------------------------------------------------------------- lifecycle */

type Lifecycle = {
  status: string;
  version: number;
  lastTest: WorkflowTestResult | null;
  approvedAt: Date | null;
};

export function approveProblem(w: Lifecycle): string | null {
  if (w.status !== "tested") return "Only a tested version can be approved.";
  if (!w.lastTest?.passed || w.lastTest.version !== w.version)
    return "This version's tests have not all passed.";
  return null;
}

export function publishProblem(w: Lifecycle): string | null {
  if (w.status !== "approved" || !w.approvedAt) return "Only an approved version can be published.";
  if (!w.lastTest?.passed || w.lastTest.version !== w.version)
    return "This version's tests have not all passed.";
  return null;
}

/* ------------------------------------------------------------------ engine */

type EventRow = {
  id: string;
  orgId: string;
  type: string;
  subjectType: string | null;
  subjectId: string | null;
  actorUserId: string | null;
  sourceRunId?: string | null;
  payload: unknown;
};

/** The requisition an event is about (its subject, or named in its payload, or via its application). */
async function eventRequisition(e: EventRow): Promise<string | null> {
  const payload = (e.payload ?? {}) as { requisitionId?: string; applicationId?: string };
  if (e.subjectType === "requisition" && e.subjectId) return e.subjectId;
  if (payload.requisitionId) return payload.requisitionId;
  const applicationId = e.subjectType === "application" ? e.subjectId : payload.applicationId;
  if (!applicationId) return null;
  const [a] = await db
    .select({ r: applications.requisitionId })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, e.orgId)))
    .limit(1);
  return a?.r ?? null;
}

/** Who a workflow's agents act for: the role's owner, else the person who caused the event. */
async function principalFor(e: EventRow): Promise<string | null> {
  const requisitionId = await eventRequisition(e);
  if (requisitionId) {
    const [r] = await db
      .select({ by: requisitions.createdBy })
      .from(requisitions)
      .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, e.orgId)))
      .limit(1);
    if (r?.by) return r.by;
  }
  return e.actorUserId;
}

/** Live published versions granted to an organisation, optionally for one trigger. */
async function grantedVersions(orgId: string, trigger?: string) {
  return db
    .select({
      workflowId: agentWorkflowVersions.workflowId,
      version: agentWorkflowVersions.version,
    })
    .from(agentWorkflowVersions)
    .innerJoin(
      agentWorkflows,
      and(
        eq(agentWorkflows.id, agentWorkflowVersions.workflowId),
        eq(agentWorkflows.publishedVersion, agentWorkflowVersions.version),
      ),
    )
    .innerJoin(
      agentWorkflowGrants,
      and(
        eq(agentWorkflowGrants.workflowId, agentWorkflows.id),
        eq(agentWorkflowGrants.orgId, orgId),
        isNull(agentWorkflowGrants.revokedAt),
      ),
    )
    .where(trigger ? eq(agentWorkflowVersions.triggerEvent, trigger) : undefined);
}

/**
 * Everything an event means for workflows: link the role an agent of a flow
 * just created, resume flows waiting for this event on their role, and start
 * flows it triggers.
 */
export async function onWorkflowEvent(e: EventRow): Promise<number> {
  await linkSubject(e);
  await resumeWaiting(e);
  return startWorkflowsFor(e);
}

/** A flow learns its role from the first event one of its own agents caused. */
async function linkSubject(e: EventRow): Promise<void> {
  if (!e.sourceRunId) return;
  const requisitionId = await eventRequisition(e);
  if (!requisitionId) return;
  const live = await db
    .select()
    .from(workflowRuns)
    .where(
      and(eq(workflowRuns.orgId, e.orgId), inArray(workflowRuns.status, ["running", "waiting"])),
    );
  for (const wr of live) {
    const ctx = wr.context as WorkflowContext;
    if (ctx.subject || !(ctx.runs ?? []).includes(e.sourceRunId)) continue;
    ctx.subject = { type: "requisition", id: requisitionId };
    await db
      .update(workflowRuns)
      .set({
        context: ctx,
        history: [
          ...wr.history,
          { node: wr.currentNode ?? "", at: new Date().toISOString(), note: "Linked to its role." },
        ],
        updatedAt: new Date(),
      })
      .where(eq(workflowRuns.id, wr.id));
  }
}

/** Flows waiting for this event on their own role move on. */
async function resumeWaiting(e: EventRow): Promise<void> {
  const waiting = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.orgId, e.orgId),
        eq(workflowRuns.status, "waiting"),
        eq(workflowRuns.waitingEvent, e.type),
      ),
    );
  if (!waiting.length) return;
  const requisitionId = await eventRequisition(e);
  for (const wr of waiting) {
    const ctx = wr.context as WorkflowContext;
    const mine =
      (ctx.subject && requisitionId && ctx.subject.id === requisitionId) ||
      (e.sourceRunId && (ctx.runs ?? []).includes(e.sourceRunId));
    if (!mine) continue;
    // "Only when": an event that does not match keeps the flow waiting.
    const graph = await versionGraph(wr.workflowId, wr.version);
    const step = graph?.nodes.find((x) => x.id === wr.currentNode);
    if (step?.data.field) {
      const probe: WorkflowContext = {
        ...ctx,
        payload: (e.payload ?? {}) as Record<string, unknown>,
      };
      if (!conditionHolds(step, probe)) continue;
    }
    if (!ctx.subject && requisitionId) ctx.subject = { type: "requisition", id: requisitionId };
    ctx.wait = { status: "happened", event: e.type, at: new Date().toISOString() };
    ctx.payload = { ...ctx.payload, ...((e.payload ?? {}) as Record<string, unknown>) };
    await moveOn(wr, ctx, `${e.type} happened.`);
  }
}

/** Waits past their time move on with wait.status = timed_out (scheduler sweep). */
export async function expireWorkflowWaits(now = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.status, "waiting"), lt(workflowRuns.waitingUntil, now)));
  for (const wr of due) {
    if (!wr.waitingEvent) continue;
    const ctx = wr.context as WorkflowContext;
    ctx.wait = { status: "timed_out", event: wr.waitingEvent, at: now.toISOString() };
    await moveOn(wr, ctx, `Stopped waiting for ${wr.waitingEvent} (timed out).`);
  }
  return due.length;
}

/** Leave the current step (an agent or a wait) for the next one, then advance. */
async function moveOn(
  wr: typeof workflowRuns.$inferSelect,
  ctx: WorkflowContext,
  note: string,
): Promise<void> {
  const graph = await versionGraph(wr.workflowId, wr.version);
  const next = graph && wr.currentNode ? nextNode(graph, wr.currentNode) : undefined;
  const moved = await db
    .update(workflowRuns)
    .set({
      status: next ? "running" : "done",
      context: ctx,
      history: [...wr.history, { node: wr.currentNode ?? "", at: new Date().toISOString(), note }],
      waitingRunId: null,
      waitingEvent: null,
      waitingUntil: null,
      currentNode: next?.id ?? null,
      ...(next ? {} : { finishedAt: new Date() }),
      updatedAt: new Date(),
    })
    .where(and(eq(workflowRuns.id, wr.id), eq(workflowRuns.status, "waiting")))
    .returning({ id: workflowRuns.id });
  if (moved.length && next) await advanceWorkflowRun(wr.id);
}

/** Start every published workflow granted to the event's organisation whose trigger matches. */
export async function startWorkflowsFor(e: EventRow): Promise<number> {
  if (!e.subjectId || !e.subjectType) return 0;
  const matches = await grantedVersions(e.orgId, e.type);
  let started = 0;
  for (const m of matches) {
    if (!m.workflowId) continue;
    const requisitionId = await eventRequisition(e);
    const context: WorkflowContext = {
      event: { type: e.type, subjectType: e.subjectType, subjectId: e.subjectId },
      payload: (e.payload ?? {}) as Record<string, unknown>,
      last: null,
      wait: null,
      subject: requisitionId
        ? { type: "requisition", id: requisitionId }
        : { type: e.subjectType, id: e.subjectId },
      runs: [],
      principal: await principalFor(e),
    };
    const [wr] = await db
      .insert(workflowRuns)
      .values({
        orgId: e.orgId,
        workflowId: m.workflowId,
        version: m.version,
        triggerEventId: e.id,
        context,
      })
      .onConflictDoNothing()
      .returning({ id: workflowRuns.id });
    if (!wr) continue;
    started++;
    await advanceWorkflowRun(wr.id);
  }
  return started;
}

/**
 * Start a manual (hiring-need) workflow in an organisation that holds a grant.
 * Its agents act for `userId`, who must belong to the organisation.
 */
export async function startWorkflowManually(input: {
  workflowId: string;
  orgId: string;
  userId: string;
  need: string;
}): Promise<{ runId: string }> {
  const [m] = (await grantedVersions(input.orgId, MANUAL_TRIGGER)).filter(
    (x) => x.workflowId === input.workflowId,
  );
  if (!m) throw new Error("This workflow is not available to this organisation.");
  const context: WorkflowContext = {
    event: { type: MANUAL_TRIGGER, subjectType: "", subjectId: "" },
    payload: { need: input.need.trim() },
    last: null,
    wait: null,
    subject: null,
    runs: [],
    principal: input.userId,
  };
  const [wr] = await db
    .insert(workflowRuns)
    .values({
      orgId: input.orgId,
      workflowId: input.workflowId,
      version: m.version,
      context,
      startedBy: input.userId,
    })
    .returning({ id: workflowRuns.id });
  await advanceWorkflowRun(wr!.id);
  return { runId: wr!.id };
}

async function versionGraph(workflowId: string, version: number): Promise<WorkflowGraph | null> {
  const [v] = await db
    .select({ graph: agentWorkflowVersions.graph })
    .from(agentWorkflowVersions)
    .where(
      and(
        eq(agentWorkflowVersions.workflowId, workflowId),
        eq(agentWorkflowVersions.version, version),
      ),
    )
    .limit(1);
  return v?.graph ?? null;
}

/**
 * Move a workflow run forward until it waits (for an agent or an event) or
 * ends. Each step is recorded in its history.
 */
export async function advanceWorkflowRun(id: string): Promise<void> {
  const [wr] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
  if (!wr || wr.status !== "running") return;
  const graph = await versionGraph(wr.workflowId, wr.version);
  const history = [...wr.history];
  const ctx = wr.context as WorkflowContext;
  ctx.runs ??= [];
  const note = (node: string, text: string) =>
    history.push({ node, at: new Date().toISOString(), note: text });
  const save = (patch: Partial<typeof workflowRuns.$inferInsert>) =>
    db
      .update(workflowRuns)
      .set({ history, context: ctx, updatedAt: new Date(), ...patch })
      .where(eq(workflowRuns.id, id));
  const end = (status: "done" | "failed", error: string | null) =>
    save({ status, error, finishedAt: new Date(), waitingRunId: null, waitingEvent: null });
  if (!graph) return void (await end("failed", "The workflow version is missing."));

  let node = wr.currentNode ? graph.nodes.find((n) => n.id === wr.currentNode) : triggerOf(graph);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!node) return void (await end("done", null));
    if (node.kind === "end") {
      note(node.id, "Ended.");
      return void (await end("done", null));
    }
    if (node.kind === "trigger") {
      note(
        node.id,
        ctx.event.type === MANUAL_TRIGGER
          ? `Started by hand: ${String(ctx.payload["need"] ?? "").slice(0, 200)}`
          : `Started by ${ctx.event.type}.`,
      );
      node = nextNode(graph, node.id);
      continue;
    }
    if (node.kind === "condition") {
      const yes = conditionHolds(node, ctx);
      note(node.id, yes ? "Yes." : "No.");
      node = nextNode(graph, node.id, yes ? "yes" : "no");
      continue;
    }
    if (node.kind === "report") {
      note(node.id, "Report ready.");
      node = nextNode(graph, node.id);
      continue;
    }
    if (node.kind === "wait") {
      const hours = Math.min(
        Math.max(node.data.timeoutHours ?? DEFAULT_WAIT_HOURS, 1),
        MAX_WAIT_HOURS,
      );
      note(node.id, `Waiting for ${node.data.event} (up to ${hours} h).`);
      await save({
        status: "waiting",
        currentNode: node.id,
        waitingEvent: node.data.event ?? null,
        waitingUntil: new Date(Date.now() + hours * 3_600_000),
      });
      return;
    }
    // Agent: start it the way the orchestrator does, then wait for it.
    const agentType = node.data.agentType as AgentType;
    try {
      const { loadPolicy } = await import("./policy");
      const policy = await loadPolicy(wr.orgId, agentType);
      if (!policy.enabled) {
        note(node.id, `${agentType} is switched off in this organisation.`);
        return void (await end("failed", `${agentType} is switched off.`));
      }
      if (!ctx.principal) {
        note(node.id, "Nobody to act for.");
        return void (await end("failed", "No person to act for."));
      }
      const subject = ctx.subject ?? null;
      const [existing] = subject
        ? await db
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.orgId, wr.orgId),
                eq(agentRuns.agentType, agentType),
                eq(agentRuns.subjectId, subject.id),
                inArray(agentRuns.status, ["queued", "running", "awaiting_human"]),
              ),
            )
            .limit(1)
        : [];
      let runId = existing?.id;
      if (runId) note(node.id, "Joined the run already working on this.");
      else {
        const { startRun } = await import("./runtime.server");
        const goal = renderGoal(node.data.goal ?? "", ctx);
        ({ runId } = await startRun({
          orgId: wr.orgId,
          agentType,
          principalUserId: ctx.principal,
          goal: subject ? `${goal}\n\n(${subject.type} id: ${subject.id})` : goal,
          ...(subject ? { subjectType: subject.type, subjectId: subject.id } : {}),
          triggerEventId: wr.triggerEventId,
        }));
        note(node.id, "Agent started.");
      }
      if (!ctx.runs.includes(runId)) ctx.runs.push(runId);
      await save({ status: "waiting", currentNode: node.id, waitingRunId: runId });
      const { kickAgents } = await import("./orchestrator.server");
      kickAgents(wr.orgId);
      return;
    } catch (err) {
      note(
        node.id,
        err instanceof Error ? err.message.slice(0, 200) : "Could not start the agent.",
      );
      return void (await end("failed", "An agent could not start."));
    }
  }
  await end("failed", "The flow took too many steps.");
}

/** When an agent run a workflow waits on ends, the flow moves to its next step. */
export async function onAgentRunFinished(run: {
  id: string;
  orgId: string;
  status: string;
  result: string | null;
}): Promise<void> {
  const waiting = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.waitingRunId, run.id),
        eq(workflowRuns.orgId, run.orgId),
        eq(workflowRuns.status, "waiting"),
      ),
    );
  for (const wr of waiting) {
    try {
      const ctx = wr.context as WorkflowContext;
      ctx.last = { status: run.status, result: (run.result ?? "").slice(0, 2000) };
      if (!ctx.subject) {
        // The agent may have worked on a role (e.g. the Requisition agent drafted one).
        const [r] = await db
          .select({ type: agentRuns.subjectType, id: agentRuns.subjectId })
          .from(agentRuns)
          .where(eq(agentRuns.id, run.id))
          .limit(1);
        if (r?.type && r.id) ctx.subject = { type: r.type, id: r.id };
      }
      await moveOn(wr, ctx, `Agent ${run.status}.`);
    } catch (err) {
      log.error("workflow.advance_failed", { workflow_run_id: wr.id, error: err as Error });
    }
  }
}

/** Stop an organisation's live runs of a workflow (grant withdrawn or workflow archived). */
export async function cancelWorkflowRuns(workflowId: string, orgId?: string): Promise<number> {
  const done = await db
    .update(workflowRuns)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      waitingRunId: null,
      waitingEvent: null,
      waitingUntil: null,
    })
    .where(
      and(
        eq(workflowRuns.workflowId, workflowId),
        inArray(workflowRuns.status, ["running", "waiting"]),
        ...(orgId ? [eq(workflowRuns.orgId, orgId)] : []),
      ),
    )
    .returning({ id: workflowRuns.id });
  return done.length;
}

/* ------------------------------------------------------------------ report */

export type WorkflowRunReport = {
  title: string;
  workflow: string;
  version: number;
  organisation: string;
  status: string;
  started: string;
  finished: string | null;
  startedBy: string | null;
  trigger: string;
  need: string | null;
  error: string | null;
  steps: { at: string; step: string; note: string }[];
  agents: {
    agent: string;
    status: string;
    started: string | null;
    finished: string | null;
    steps: number;
    tokens: number;
    result: string;
  }[];
  decisions: {
    at: string | null;
    agent: string;
    request: string;
    kind: string;
    outcome: string;
    by: string | null;
  }[];
  totals: { agentRuns: number; tokens: number; decisions: number; minutes: number | null };
};

/** Everything a workflow run did, for the PDF / Excel report (org-scoped by the caller). */
export async function workflowRunReport(
  runId: string,
  orgId?: string,
): Promise<WorkflowRunReport | null> {
  const [row] = await db
    .select({ wr: workflowRuns, name: agentWorkflows.name, org: organizations.name })
    .from(workflowRuns)
    .innerJoin(agentWorkflows, eq(agentWorkflows.id, workflowRuns.workflowId))
    .innerJoin(organizations, eq(organizations.id, workflowRuns.orgId))
    .where(and(eq(workflowRuns.id, runId), ...(orgId ? [eq(workflowRuns.orgId, orgId)] : [])))
    .limit(1);
  if (!row) return null;
  const { wr } = row;
  const ctx = wr.context as WorkflowContext;
  const graph = await versionGraph(wr.workflowId, wr.version);
  const stepName = (id: string) => {
    const n = graph?.nodes.find((x) => x.id === id);
    return n ? n.data.label?.trim() || n.data.agentType || n.kind : id;
  };
  const runIds = ctx.runs ?? [];
  const runs = runIds.length
    ? await db
        .select()
        .from(agentRuns)
        .where(and(inArray(agentRuns.id, runIds), eq(agentRuns.orgId, wr.orgId)))
    : [];
  const tasks = runIds.length
    ? await db
        .select({ t: agentTasks, run: agentRuns.agentType, by: users.email })
        .from(agentTasks)
        .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
        .leftJoin(users, eq(users.id, agentTasks.decidedBy))
        .where(and(inArray(agentTasks.runId, runIds), eq(agentTasks.orgId, wr.orgId)))
    : [];
  const [starter] = wr.startedBy
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, wr.startedBy))
    : [];
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  const tokens = runs.reduce((s, r) => s + r.tokensUsed, 0);
  return {
    title: `${row.name} — run report`,
    workflow: row.name,
    version: wr.version,
    organisation: row.org,
    status: wr.status,
    started: wr.createdAt.toISOString(),
    finished: iso(wr.finishedAt),
    startedBy: starter?.email ?? null,
    trigger: ctx.event.type,
    need: typeof ctx.payload["need"] === "string" ? (ctx.payload["need"] as string) : null,
    error: wr.error,
    steps: wr.history.map((h) => ({ at: h.at, step: stepName(h.node), note: h.note })),
    agents: runIds
      .map((id) => runs.find((r) => r.id === id))
      .filter((r): r is (typeof runs)[number] => Boolean(r))
      .map((r) => ({
        agent: r.agentType,
        status: r.status,
        started: iso(r.startedAt ?? r.createdAt),
        finished: iso(r.finishedAt),
        steps: r.stepCount,
        tokens: r.tokensUsed,
        result: (r.result ?? "").slice(0, 1500),
      })),
    decisions: tasks.map(({ t, run, by }) => ({
      at: iso(t.decidedAt ?? t.createdAt),
      agent: run,
      request: t.title,
      kind: t.kind,
      outcome: t.status,
      by: by ?? null,
    })),
    totals: {
      agentRuns: runs.length,
      tokens,
      decisions: tasks.filter((x) => x.t.status !== "open").length,
      minutes: wr.finishedAt
        ? Math.round((wr.finishedAt.getTime() - wr.createdAt.getTime()) / 60_000)
        : null,
    },
  };
}
