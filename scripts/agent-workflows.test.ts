/**
 * Agent workflows (docs/agent-workflows.md) — platform super admin only.
 * Graph rules, conditions, goal templates and the dry-run test are pure; the
 * engine runs against the disposable local database with a scripted model:
 * a granted organisation's event starts the flow, agents start through the
 * normal harness, the flow follows the right branch when an agent finishes,
 * and organisations without a grant never run it.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { AgentStepResult } from "../src/lib/ai-gateway.server";
import type { WorkflowGraph, WorkflowNode } from "../drizzle/schema";

const script: AgentStepResult[] = [];
const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiAgentStep: async () =>
    script.shift() ?? { ok: true, text: "Done.", toolCalls: [], stopReason: "end", usage },
}));

const w = await import("../src/server/agents/workflows.server");

const node = (
  id: string,
  kind: WorkflowNode["kind"],
  data: WorkflowNode["data"] = {},
): WorkflowNode => ({
  id,
  kind,
  position: { x: 0, y: 0 },
  data,
});

/** Shortlisted → screening → passed? → offer : end. */
function flow(agentA = "screening", agentB = "offer"): WorkflowGraph {
  return {
    nodes: [
      node("t", "trigger", { event: "application.shortlisted" }),
      node("a", "agent", { agentType: agentA, goal: "Screen {{payload.applicationId}}" }),
      node("c", "condition", { field: "last.status", op: "eq", value: "done" }),
      node("b", "agent", { agentType: agentB, goal: "Prepare the offer. Notes: {{last.result}}" }),
      node("e", "end", { label: "Stopped" }),
    ],
    edges: [
      { id: "1", source: "t", target: "a" },
      { id: "2", source: "a", target: "c" },
      { id: "3", source: "c", target: "b", branch: "yes" },
      { id: "4", source: "c", target: "e", branch: "no" },
    ],
  };
}
const known = () => true;

describe("graph rules", () => {
  test("a well-formed flow passes", () => {
    expect(w.graphProblems(flow(), known)).toEqual([]);
  });
  test("exactly one trigger, with a real event", () => {
    const g = flow();
    g.nodes.push(node("t2", "trigger", { event: "jd.approved" }));
    expect(w.graphProblems(g, known).join(" ")).toContain("exactly one trigger");
    const bad = flow();
    bad.nodes[0]!.data.event = "anything.happened";
    expect(w.graphProblems(bad, known).join(" ")).toContain("event");
  });
  test("loops, orphans, unknown agents and empty goals are refused", () => {
    const loop = flow();
    loop.edges.push({ id: "5", source: "b", target: "a" });
    expect(w.graphProblems(loop, known).join(" ")).toContain("loops");
    const orphan = flow();
    orphan.nodes.push(node("x", "agent", { agentType: "jd", goal: "g" }));
    expect(w.graphProblems(orphan, known).join(" ")).toContain("Not connected");
    expect(w.graphProblems(flow("nope"), (t) => t !== "nope").join(" ")).toContain("exists");
    const noGoal = flow();
    noGoal.nodes[1]!.data.goal = " ";
    expect(w.graphProblems(noGoal, known).join(" ")).toContain("goal");
  });
  test("only conditions branch, each branch once; conditions use known fields", () => {
    const branchy = flow();
    branchy.edges.push({ id: "6", source: "a", target: "e" });
    expect(w.graphProblems(branchy, known).join(" ")).toContain("one next step");
    const field = flow();
    field.nodes[2]!.data.field = "process.env.SECRET";
    expect(w.graphProblems(field, known).join(" ")).toContain("field");
    const twice = flow();
    twice.edges.push({ id: "7", source: "c", target: "b", branch: "no" });
    expect(w.graphProblems(twice, known).join(" ")).toContain('only one "no"');
  });
});

describe("conditions and goals", () => {
  const ctx = {
    event: { type: "application.shortlisted", subjectType: "application", subjectId: "A1" },
    payload: { applicationId: "A1", score: 82, nested: { level: 4 } },
    last: { status: "done", result: "Strong in SQL" },
  };
  test("comparisons", () => {
    const c = (field: string, op: WorkflowNode["data"]["op"], value = "") =>
      w.conditionHolds(node("c", "condition", { field, op, value }), ctx);
    expect(c("payload.score", "gte", "80")).toBe(true);
    expect(c("payload.score", "gt", "90")).toBe(false);
    expect(c("payload.nested.level", "eq", "4")).toBe(true);
    expect(c("last.result", "contains", "sql")).toBe(true);
    expect(c("last.status", "neq", "failed")).toBe(true);
    expect(c("payload.missing", "exists")).toBe(false);
    expect(c("payload.score", "gt", "not a number")).toBe(false);
  });
  test("goal placeholders fill from the event and the last agent; unknown ones stay empty", () => {
    expect(w.renderGoal("Screen {{payload.applicationId}} ({{last.result}}) {{secret}}", ctx)).toBe(
      "Screen A1 (Strong in SQL) ",
    );
  });
});

describe("dry-run tests", () => {
  test("the path follows each agent's outcome", () => {
    const g = flow();
    const pass = w.simulate(g, {
      name: "passes",
      payload: {},
      subjectType: "application",
      outcomes: { a: { status: "done", result: "" } },
      expectEnd: "b",
    });
    expect(pass.path).toEqual(["t", "a", "c", "b"]);
    expect(pass.failures).toEqual([]);
    const fail = w.simulate(g, {
      name: "fails",
      payload: {},
      subjectType: "application",
      outcomes: { a: { status: "failed", result: "" } },
      expectEnd: "b",
    });
    expect(fail.path).toEqual(["t", "a", "c", "e"]);
    expect(fail.failures[0]).toContain("Stopped");
  });
  test("only a tested version whose own tests passed is approved; only approved is published", () => {
    const passed = { version: 3, passed: true, at: "", runs: [] };
    expect(
      w.approveProblem({ status: "draft", version: 3, lastTest: passed, approvedAt: null }),
    ).not.toBeNull();
    expect(
      w.approveProblem({
        status: "tested",
        version: 3,
        lastTest: { ...passed, version: 2 },
        approvedAt: null,
      }),
    ).not.toBeNull();
    expect(
      w.approveProblem({ status: "tested", version: 3, lastTest: passed, approvedAt: null }),
    ).toBeNull();
    expect(
      w.publishProblem({ status: "tested", version: 3, lastTest: passed, approvedAt: null }),
    ).not.toBeNull();
    expect(
      w.publishProblem({
        status: "approved",
        version: 3,
        lastTest: passed,
        approvedAt: new Date(),
      }),
    ).toBeNull();
  });
});

describe("templates", () => {
  test("every ready-made workflow uses real stock agents, passes the graph rules and its own tests", async () => {
    const { ensureAgentsRegistered } = await import("../src/server/agents");
    ensureAgentsRegistered();
    const { listAgents } = await import("../src/server/agents/registry");
    const stock = new Set(listAgents().map((a) => a.type as string));
    const { WORKFLOW_TEMPLATES } = await import("../src/lib/workflow-templates");
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const t of WORKFLOW_TEMPLATES) {
      expect({ id: t.id, problems: w.graphProblems(t.graph, (x) => stock.has(x)) }).toEqual({
        id: t.id,
        problems: [],
      });
      const r = w.runTests(t.graph, t.tests, 1);
      expect({ id: t.id, failures: r.runs.flatMap((x) => x.failures) }).toEqual({
        id: t.id,
        failures: [],
      });
      expect(r.passed).toBe(true);
      // Each template's tests take at least two different paths.
      const paths = new Set(r.runs.map((x) => x.path.join(">")));
      expect(paths.size).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("access", () => {
  test("every workflow server function is super admin only", () => {
    const src = readFileSync("src/lib/platform-agent-workflows.functions.ts", "utf8");
    const fns = src.match(/createServerFn\(/g)?.length ?? 0;
    expect(fns).toBeGreaterThan(6);
    expect(src.match(/\.middleware\(\[requirePlatformAdmin\]\)/g)?.length ?? 0).toBe(fns);
    expect(src).not.toMatch(/requireOrg\b|requireRole\(/);
  });
});

/* ------------------------------------------------------------------ engine */

const { db } = await import("../src/server/db");
const schema = await import("../drizzle/schema");
const {
  agentEvents,
  agentPolicies,
  agentRuns,
  agentWorkflowGrants,
  agentWorkflows,
  agentWorkflowVersions,
  organizations,
  requisitions,
  users,
  workflowRuns,
} = schema;
const registry = await import("../src/server/agents/registry");
const { runAgentTick } = await import("../src/server/agents/runtime.server");
const { processAgentEvents } = await import("../src/server/agents/orchestrator.server");

describe("engine", () => {
  let orgId = "";
  let otherOrgId = "";
  let userId = "";
  let reqId = "";
  let otherReqId = "";
  let workflowId = "";
  const stamp = Date.now();

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? "";
    if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
      throw new Error("Refusing to run against a non-local database host");
    const [u] = await db
      .insert(users)
      .values({ email: `wf-${stamp}@test.local` })
      .returning({ id: users.id });
    userId = u!.id;
    const orgs = await db
      .insert(organizations)
      .values([
        { name: "Granted", slug: `wf-a-${stamp}`, status: "active" },
        { name: "Other", slug: `wf-b-${stamp}`, status: "active" },
      ])
      .returning({ id: organizations.id });
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    const reqs = await db
      .insert(requisitions)
      .values([
        {
          orgId,
          code: `WF-${stamp}`,
          title: "Engineer",
          status: "approved",
          createdBy: userId,
        } as never,
        {
          orgId: otherOrgId,
          code: `WF2-${stamp}`,
          title: "Engineer",
          status: "approved",
          createdBy: userId,
        } as never,
      ])
      .returning({ id: requisitions.id });
    reqId = reqs[0]!.id;
    otherReqId = reqs[1]!.id;
    // Stand-in agents for the flow (registered under two real types).
    registry.registerTool({
      name: "wf_probe",
      description: "Probe",
      input: z.object({}),
      risk: "read",
      run: async () => ({ ok: true }),
    });
    for (const type of ["jd", "publishing"] as const)
      registry.registerAgent({
        type,
        name: `WF ${type}`,
        version: "0.0.0-test",
        owner: "hr_head",
        responsibility: "Test.",
        mustNever: [],
        scope: { reads: [], writes: [], external: [] },
        gates: ["general"],
        riskTier: "low",
        evals: [],
        feature: "agent_jd",
        system: `WF ${type}`,
        tools: ["wf_probe"],
      });
    await db.insert(agentPolicies).values([
      { orgId, agentType: "jd", enabled: true },
      { orgId, agentType: "publishing", enabled: true },
      { orgId: otherOrgId, agentType: "jd", enabled: true },
    ]);
    const graph: WorkflowGraph = {
      nodes: [
        node("t", "trigger", { event: "requisition.created" }),
        node("a", "agent", { agentType: "jd", goal: "Draft the JD for {{payload.title}}" }),
        node("c", "condition", { field: "last.result", op: "contains", value: "ready" }),
        node("b", "agent", { agentType: "publishing", goal: "Publish it" }),
        node("e", "end"),
      ],
      edges: [
        { id: "1", source: "t", target: "a" },
        { id: "2", source: "a", target: "c" },
        { id: "3", source: "c", target: "b", branch: "yes" },
        { id: "4", source: "c", target: "e", branch: "no" },
      ],
    };
    const test = { version: 1, passed: true, at: "", runs: [] };
    const [wf] = await db
      .insert(agentWorkflows)
      .values({ name: `WF ${stamp}`, graph, status: "published", version: 1, publishedVersion: 1 })
      .returning({ id: agentWorkflows.id });
    workflowId = wf!.id;
    await db.insert(agentWorkflowVersions).values({
      workflowId,
      version: 1,
      triggerEvent: "requisition.created",
      graph,
      hash: "h",
      test,
      approvedAt: new Date(),
    });
    await db.insert(agentWorkflowGrants).values({ workflowId, orgId });
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [orgId, otherOrgId]));
    await db.delete(agentWorkflows).where(eq(agentWorkflows.id, workflowId));
    await db.delete(users).where(eq(users.id, userId));
  });

  const emit = (org: string, req: string) =>
    db.insert(agentEvents).values({
      orgId: org,
      type: "requisition.created",
      subjectType: "requisition",
      subjectId: req,
      actorUserId: userId,
      payload: { title: "Engineer" },
    });

  test("a granted organisation's event starts the flow; it follows the branch the agent's result takes", async () => {
    await emit(orgId, reqId);
    await processAgentEvents({ orgId });
    const [wr] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflowId));
    expect(wr!.status).toBe("waiting");
    expect(wr!.currentNode).toBe("a");
    const [first] = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "jd")));
    expect(first!.goal).toContain("Draft the JD for Engineer");
    expect(first!.principalUserId).toBe(userId);

    script.push({ ok: true, text: "The JD is ready.", toolCalls: [], stopReason: "end", usage });
    await runAgentTick({ max: 1, orgId, onlyRunId: first!.id });
    const [after] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, wr!.id));
    expect(after!.currentNode).toBe("b");
    expect(after!.status).toBe("waiting");
    const [second] = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "publishing")));
    expect(second).toBeDefined();

    script.push({ ok: true, text: "Published.", toolCalls: [], stopReason: "end", usage });
    await runAgentTick({ max: 1, orgId, onlyRunId: second!.id });
    const [done] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, wr!.id));
    expect(done!.status).toBe("done");
    expect(done!.history.map((h) => h.node)).toEqual(["t", "a", "a", "c", "b", "b"]);
  });

  test("a cancelled agent run moves the flow on (last.status = cancelled → the no branch)", async () => {
    const { cancelRun } = await import("../src/server/agents/runtime.server");
    const [r2] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `WF4-${stamp}`,
        title: "Ops",
        status: "approved",
        createdBy: userId,
      } as never)
      .returning({ id: requisitions.id });
    await emit(orgId, r2!.id);
    await processAgentEvents({ orgId });
    const [wr] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.status, "waiting")));
    await cancelRun({ orgId, runId: wr!.waitingRunId!, userId });
    const [after] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, wr!.id));
    expect(after!.status).toBe("done");
    expect((after!.context as { last: { status: string } }).last.status).toBe("cancelled");
    expect(after!.history.map((h) => h.node).slice(-2)).toEqual(["c", "e"]);
  });

  test("an older run still open on the role: the flow waits for it, then starts its own", async () => {
    const { cancelRun } = await import("../src/server/agents/runtime.server");
    const [r5] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `WF5-${stamp}`,
        title: "Data",
        status: "approved",
        createdBy: userId,
      } as never)
      .returning({ id: requisitions.id });
    const [old] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "jd",
        status: "awaiting_human",
        subjectType: "requisition",
        subjectId: r5!.id,
        goal: "Earlier work on this role",
        principalUserId: userId,
        createdAt: new Date(Date.now() - 2 * 864e5),
      } as never)
      .returning({ id: agentRuns.id });
    await emit(orgId, r5!.id);
    await processAgentEvents({ orgId });
    const mineWr = async () =>
      (await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId))).find(
        (r) => (r.context as { subject?: { id: string } }).subject?.id === r5!.id,
      )!;
    const queued = await mineWr();
    expect(queued.status).toBe("waiting");
    expect(queued.waitingRunId).toBe(old!.id);
    expect(queued.history.at(-1)!.note).toContain("Waiting for an earlier jd run");

    await cancelRun({ orgId, runId: old!.id, userId });
    const after = await mineWr();
    expect(after.status).toBe("waiting");
    expect(after.currentNode).toBe("a");
    expect(after.waitingRunId).not.toBe(old!.id);
    const [mine] = await db.select().from(agentRuns).where(eq(agentRuns.id, after.waitingRunId!));
    expect(mine!.goal).toContain("Draft the JD for");
    expect(after.history.map((h) => h.note).join(" ")).toContain("starting this step's own run");
  });

  test("an organisation without a grant never runs it", async () => {
    await emit(otherOrgId, otherReqId);
    await processAgentEvents({ orgId: otherOrgId });
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.orgId, otherOrgId));
    expect(runs).toHaveLength(0);
  });

  test("an agent switched off in the organisation stops the flow with the reason", async () => {
    await db
      .update(agentPolicies)
      .set({ enabled: false })
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, "jd")));
    const [r2] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `WF3-${stamp}`,
        title: "QA",
        status: "approved",
        createdBy: userId,
      } as never)
      .returning({ id: requisitions.id });
    await emit(orgId, r2!.id);
    await processAgentEvents({ orgId });
    const [wr] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.status, "failed")));
    expect(wr!.error).toContain("switched off");
  });

  test("go-live check: granted workflows and what each organisation still needs", async () => {
    const granted = await w.grantedWorkflows(orgId);
    expect(granted.map((g) => g.id)).toEqual([workflowId]);
    expect(await w.grantedWorkflows(otherOrgId)).toHaveLength(0);
    const r = await w.workflowReadiness(orgId, granted[0]!.graph);
    const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
    expect(r.ready).toBe(false);
    expect(by["ai_key"]!.ok).toBe(false);
    expect(by["agent:jd"]!.ok).toBe(false);
    expect(by["agent:publishing"]!.ok).toBe(true);
    expect(by["agent:publishing"]!.detail).toContain("On");
    expect(w.agentsOf(granted[0]!.graph)).toEqual(["jd", "publishing"]);
  });
});

describe("hiring need, waits and reports", () => {
  let orgId = "";
  let otherOrgId = "";
  let userId = "";
  let workflowId = "";
  const stamp = Date.now() + 1;
  const wfr = () => db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `wfn-${stamp}@test.local` })
      .returning({ id: users.id });
    userId = u!.id;
    const orgs = await db
      .insert(organizations)
      .values([
        { name: "Need org", slug: `wfn-a-${stamp}`, status: "active" },
        { name: "Elsewhere", slug: `wfn-b-${stamp}`, status: "active" },
      ])
      .returning({ id: organizations.id });
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    registry.registerTool({
      name: "wfn_probe",
      description: "Probe",
      input: z.object({}),
      risk: "read",
      run: async () => ({ ok: true }),
    });
    for (const type of ["requisition", "jd"] as const)
      registry.registerAgent({
        type,
        name: `WFN ${type}`,
        version: "0.0.0-test",
        owner: "hr_head",
        responsibility: "Test.",
        mustNever: [],
        scope: { reads: [], writes: [], external: [] },
        gates: ["general"],
        riskTier: "low",
        evals: [],
        feature: "agent_jd",
        system: `WFN ${type}`,
        tools: ["wfn_probe"],
      });
    await db.insert(agentPolicies).values([
      { orgId, agentType: "requisition", enabled: true },
      { orgId, agentType: "jd", enabled: true },
    ]);
    const graph: WorkflowGraph = {
      nodes: [
        node("t", "trigger", { event: "manual" }),
        node("req", "agent", { agentType: "requisition", goal: "Need: {{payload.need}}" }),
        node("w", "wait", {
          event: "requisition.status_changed",
          field: "payload.to",
          op: "eq",
          value: "approved",
          timeoutHours: 1,
        }),
        node("ok", "condition", { field: "wait.status", op: "eq", value: "happened" }),
        node("jd", "agent", { agentType: "jd", goal: "Write the JD for: {{payload.need}}" }),
        node("rep", "report"),
        node("e", "end"),
      ],
      edges: [
        { id: "1", source: "t", target: "req" },
        { id: "2", source: "req", target: "w" },
        { id: "3", source: "w", target: "ok" },
        { id: "4", source: "ok", target: "jd", branch: "yes" },
        { id: "5", source: "ok", target: "rep", branch: "no" },
        { id: "6", source: "jd", target: "rep" },
        { id: "7", source: "rep", target: "e" },
      ],
    };
    expect(w.graphProblems(graph, () => true)).toEqual([]);
    const [wf] = await db
      .insert(agentWorkflows)
      .values({ name: `WFN ${stamp}`, graph, status: "published", version: 1, publishedVersion: 1 })
      .returning({ id: agentWorkflows.id });
    workflowId = wf!.id;
    await db.insert(agentWorkflowVersions).values({
      workflowId,
      version: 1,
      triggerEvent: "manual",
      graph,
      hash: "h",
      test: { version: 1, passed: true, at: "", runs: [] },
      approvedAt: new Date(),
    });
    await db.insert(agentWorkflowGrants).values({ workflowId, orgId });
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [orgId, otherOrgId]));
    await db.delete(agentWorkflows).where(eq(agentWorkflows.id, workflowId));
    await db.delete(users).where(eq(users.id, userId));
  });

  const finishAgent = async (runId: string, text: string) => {
    script.push({ ok: true, text, toolCalls: [], stopReason: "end", usage });
    await runAgentTick({ max: 1, orgId, onlyRunId: runId });
  };
  const event = (
    type: string,
    reqId: string,
    payload: Record<string, unknown>,
    sourceRunId?: string,
  ) =>
    db.insert(agentEvents).values({
      orgId,
      type,
      subjectType: "requisition",
      subjectId: reqId,
      actorUserId: userId,
      payload,
      ...(sourceRunId ? { sourceRunId } : {}),
    });

  test("a hiring need flows: role linked, wait ignores other changes, resumes on approval, report", async () => {
    const { startWorkflowManually, workflowRunReport } =
      await import("../src/server/agents/workflows.server");
    await expect(
      startWorkflowManually({ workflowId, orgId: otherOrgId, userId, need: "x needs" }),
    ).rejects.toThrow("not available");
    const { runId: wrId } = await startWorkflowManually({
      workflowId,
      orgId,
      userId,
      need: "Two AI engineers in Chennai",
    });
    let [wr] = await wfr();
    expect(wr!.status).toBe("waiting");
    const reqRun = wr!.waitingRunId!;
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, reqRun));
    expect(run!.goal).toContain("Two AI engineers in Chennai");

    // The Requisition agent drafts a role (its own event links the flow to it).
    const [req] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `WFN-${stamp}`,
        title: "AI engineer",
        status: "draft",
        createdBy: userId,
      } as never)
      .returning({ id: requisitions.id });
    await event("requisition.created", req!.id, {}, reqRun);
    await processAgentEvents({ orgId });
    await finishAgent(reqRun, "Requisition drafted and submitted.");
    [wr] = await wfr();
    expect(wr!.status).toBe("waiting");
    expect(wr!.waitingEvent).toBe("requisition.status_changed");
    expect((wr!.context as { subject: { id: string } }).subject.id).toBe(req!.id);

    // A change that is not the approval keeps it waiting.
    await event("requisition.status_changed", req!.id, { from: "draft", to: "pending_hr" });
    await processAgentEvents({ orgId });
    [wr] = await wfr();
    expect(wr!.waitingEvent).toBe("requisition.status_changed");

    // The approval resumes it; the JD agent works on that role.
    await event("requisition.status_changed", req!.id, { from: "pending_hr", to: "approved" });
    await processAgentEvents({ orgId });
    [wr] = await wfr();
    expect(wr!.currentNode).toBe("jd");
    const [jdRun] = await db.select().from(agentRuns).where(eq(agentRuns.id, wr!.waitingRunId!));
    expect(jdRun!.subjectId).toBe(req!.id);
    expect(jdRun!.goal).toContain("Write the JD for: Two AI engineers in Chennai");

    await finishAgent(jdRun!.id, "JD v1 submitted.");
    [wr] = await wfr();
    expect(wr!.status).toBe("done");
    expect(wr!.history.some((h) => h.note === "Report ready.")).toBe(true);

    const report = await workflowRunReport(wrId, orgId);
    expect(report!.need).toBe("Two AI engineers in Chennai");
    expect(report!.agents.map((a) => a.agent)).toEqual(["requisition", "jd"]);
    expect(report!.agents[1]!.result).toContain("JD v1");
    expect(report!.steps.length).toBeGreaterThan(5);
    expect(await workflowRunReport(wrId, otherOrgId)).toBeNull();
  });

  test("a wait that times out takes the other path to the report", async () => {
    const { startWorkflowManually, expireWorkflowWaits } =
      await import("../src/server/agents/workflows.server");
    await db.delete(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));
    await startWorkflowManually({ workflowId, orgId, userId, need: "One analyst" });
    let [wr] = await wfr();
    await finishAgent(wr!.waitingRunId!, "Submitted.");
    [wr] = await wfr();
    expect(wr!.waitingEvent).toBe("requisition.status_changed");
    await expireWorkflowWaits(new Date(Date.now() + 2 * 3_600_000));
    [wr] = await wfr();
    expect(wr!.status).toBe("done");
    expect((wr!.context as { wait: { status: string } }).wait.status).toBe("timed_out");
    expect(wr!.history.map((h) => h.node).slice(-3)).toEqual(["ok", "rep", "e"]);
  });
});
