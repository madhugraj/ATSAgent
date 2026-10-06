/**
 * Agent health engine (src/server/agents/health.server.ts) against the
 * disposable local database: each rule opens an issue when its condition
 * holds, escalates, re-sees without duplicating, and resolves when it clears;
 * the scheduler heartbeat reports a stopped scheduler.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, ne } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentDefinitions,
  agentEvents,
  agentIssues,
  agentRuns,
  agentRuntimeHeartbeat,
  agentSteps,
  agentTasks,
  aiUsageEvents,
  auditLog,
  organizations,
  users,
} = await import("../drizzle/schema");
const { evaluateAgentHealth, heartbeatAndMaybeEvaluate, schedulerStatus, HEALTH } =
  await import("../src/server/agents/health.server");

let orgId: string;
let userId: string;
const stamp = Date.now();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db
    .insert(users)
    .values({ email: `health-${stamp}@test.local` })
    .returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Health Org", slug: `health-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await db.delete(agentIssues).where(eq(agentIssues.orgId, orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentEvents).where(eq(agentEvents.orgId, orgId));
  await db.delete(auditLog).where(eq(auditLog.orgId, orgId));
});

async function run(agentType: string, values: Record<string, unknown> = {}) {
  const [r] = await db
    .insert(agentRuns)
    .values({
      orgId,
      agentType: agentType as never,
      principalUserId: userId,
      goal: "t",
      ...values,
    } as never)
    .returning({ id: agentRuns.id });
  return r!.id;
}

const open = () =>
  db
    .select()
    .from(agentIssues)
    .where(and(eq(agentIssues.orgId, orgId), ne(agentIssues.status, "resolved")));
const evaluate = () => evaluateAgentHealth({ orgId });

describe("rules", () => {
  test("stuck run: critical while stuck, resolved (and audited) when it clears", async () => {
    const id = await run("intake", {
      status: "running",
      leaseUntil: ago(HEALTH.stuckLeaseMinutes + 5),
    });
    expect((await evaluate()).opened).toBe(1);
    const [issue] = await open();
    expect(issue).toMatchObject({
      agentType: "intake",
      element: "harness",
      rule: "harness.stuck_run",
      severity: "critical",
    });

    expect((await evaluate()).opened).toBe(0); // re-seen, not duplicated
    expect((await open())[0]!.occurrences).toBe(2);

    await db.update(agentRuns).set({ status: "done" }).where(eq(agentRuns.id, id));
    expect((await evaluate()).resolved).toBe(1);
    expect(await open()).toHaveLength(0);
    const actions = (
      await db.select({ a: auditLog.action }).from(auditLog).where(eq(auditLog.orgId, orgId))
    ).map((r) => r.a);
    expect(actions).toEqual(expect.arrayContaining(["agent.issue.opened", "agent.issue.resolved"]));
  });

  test("overdue human request: warning past the SLA, serious past the escalation point", async () => {
    const id = await run("requisition", { status: "awaiting_human" });
    const [task] = await db
      .insert(agentTasks)
      .values({
        orgId,
        runId: id,
        kind: "clarification",
        title: "q",
        createdAt: ago((HEALTH.hitlSlaHours + 2) * 60),
      })
      .returning({ id: agentTasks.id });
    await evaluate();
    expect((await open())[0]).toMatchObject({
      rule: "hitl.overdue",
      severity: "warning",
      agentType: "requisition",
    });
    await db
      .update(agentTasks)
      .set({ createdAt: ago((HEALTH.hitlSeriousHours + 2) * 60) })
      .where(eq(agentTasks.id, task!.id));
    await evaluate();
    expect((await open())[0]!.severity).toBe("serious");
  });

  test("tool error rate fires above the threshold only", async () => {
    const id = await run("screening", { status: "done" });
    const steps = (errors: number) =>
      Array.from({ length: HEALTH.minToolCalls }, (_, i) => ({
        runId: id,
        orgId,
        seq: i + 1,
        kind: "tool",
        toolName: "get_screening_status",
        status: i < errors ? "error" : "ok",
      }));
    await db.insert(agentSteps).values(steps(1));
    await evaluate();
    expect(await open()).toHaveLength(0);
    await db.delete(agentSteps).where(eq(agentSteps.runId, id));
    await db.insert(agentSteps).values(steps(4));
    await evaluate();
    expect((await open())[0]).toMatchObject({ rule: "tools.error_rate", severity: "serious" });
    expect((await open())[0]!.detail).toMatchObject({
      calls: 10,
      errors: 4,
      topFailingTool: "get_screening_status",
    });
  });

  test("AI errors inside an agent's runs (incl. inside tools)", async () => {
    const id = await run("jd", { status: "done" });
    await db.insert(aiUsageEvents).values(
      Array.from({ length: 6 }, (_, i) => ({
        orgId,
        agentRunId: id,
        feature: "jd_generate",
        provider: "x",
        model: "x",
        status: (i < 3 ? "error" : "ok") as never,
      })),
    );
    await evaluate();
    expect((await open()).map((i) => i.rule)).toContain("skills.ai_errors");
  });

  test("audit gap: a completed write tool call without its audit entry is critical", async () => {
    const [def] = await db
      .insert(agentDefinitions)
      .values({
        agentType: "intake",
        version: "t",
        hash: `health-${stamp}-${Math.random()}`,
        manifest: {
          tools: [
            { name: "move_candidate", risk: "write" },
            { name: "list_applications", risk: "read" },
          ],
        },
      })
      .returning({ id: agentDefinitions.id });
    const id = await run("intake", { status: "done", definitionId: def!.id });
    await db.insert(auditLog).values({
      orgId,
      actor: `agent:intake:${id}`,
      action: "agent.run.started",
      entityType: "agent_run",
      entityId: id,
    });
    await db.insert(agentSteps).values([
      {
        runId: id,
        orgId,
        seq: 1,
        kind: "tool",
        toolName: "list_applications",
        status: "ok",
        createdAt: ago(10),
      },
      {
        runId: id,
        orgId,
        seq: 2,
        kind: "tool",
        toolName: "move_candidate",
        status: "ok",
        createdAt: ago(10),
      },
    ]);
    await evaluate();
    expect((await open())[0]).toMatchObject({
      rule: "audit.gap",
      severity: "critical",
      element: "audit",
    });
    await db.insert(auditLog).values({
      orgId,
      actor: `agent:intake:${id}`,
      action: "agent.tool.move_candidate",
      entityType: "agent_run",
      entityId: id,
    });
    await evaluate();
    expect(await open()).toHaveLength(0);
    await db.delete(agentDefinitions).where(eq(agentDefinitions.id, def!.id));
  });

  test("orchestrator: failed or stale lifecycle events are an organisation-wide issue", async () => {
    await db.insert(agentEvents).values([
      { orgId, type: "jd.approved", status: "failed", attempts: 3 },
      {
        orgId,
        type: "jd.approved",
        status: "pending",
        createdAt: ago(HEALTH.eventBacklogMinutes + 5),
      },
    ]);
    await evaluate();
    expect((await open())[0]).toMatchObject({
      agentType: "*",
      rule: "orchestrator.events",
      detail: { failed: 1, stale: 1 },
    });
  });

  test("an acknowledged issue stays acknowledged while it persists and still auto-resolves", async () => {
    const id = await run("intake", { status: "running", leaseUntil: ago(60) });
    await evaluate();
    const [issue] = await open();
    await db
      .update(agentIssues)
      .set({ status: "acknowledged" })
      .where(eq(agentIssues.id, issue!.id));
    await evaluate();
    expect((await open())[0]!.status).toBe("acknowledged");
    await db.update(agentRuns).set({ status: "failed" }).where(eq(agentRuns.id, id));
    await evaluate();
    expect(await open()).toHaveLength(0);
  });
});

describe("scheduler heartbeat", () => {
  test("a tick records liveness; an old tick reads as stopped", async () => {
    await heartbeatAndMaybeEvaluate({ claimed: 0 });
    expect((await schedulerStatus()).healthy).toBe(true);
    await db
      .update(agentRuntimeHeartbeat)
      .set({ lastTickAt: ago(HEALTH.heartbeatMinutes + 3) })
      .where(eq(agentRuntimeHeartbeat.id, "agents"));
    const s = await schedulerStatus();
    expect(s.healthy).toBe(false);
    expect(s.minutesSinceTick).toBeGreaterThanOrEqual(HEALTH.heartbeatMinutes + 3);
  });
});
