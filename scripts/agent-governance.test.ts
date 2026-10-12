/**
 * Agent governance controls (docs/agentic-plan.md §6) against the disposable
 * local database: versioned definitions recorded per run, change control via
 * scripts/agents.lock.json, AI requests attributed to runs (incl. AI inside
 * tools), monthly budget enforcement, and run-lifecycle audit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";

import type { AgentStepResult, AgentToolCall } from "../src/lib/ai-gateway.server";

const script: AgentStepResult[] = [];
const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const say = (text: string): AgentStepResult => ({
  ok: true,
  text,
  toolCalls: [],
  stopReason: "end",
  usage,
});
const call = (...calls: AgentToolCall[]): AgentStepResult => ({
  ok: true,
  text: "",
  toolCalls: calls,
  stopReason: "tool_use",
  usage,
});

const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiAgentStep: async () => script.shift() ?? say("(script exhausted)"),
}));

const { db } = await import("../src/server/db");
const {
  agentDefinitions,
  agentPolicies,
  agentRuns,
  aiUsageEvents,
  auditLog,
  orgMembers,
  organizations,
  users,
} = await import("../drizzle/schema");
const registry = await import("../src/server/agents/registry");
const { registerPhase1Tools } = await import("../src/server/agents/tools");
const { registerPhase2Tools } = await import("../src/server/agents/tools-phase2");
const { registerPhase3Tools } = await import("../src/server/agents/tools-phase3");
const { registerPhase4Tools } = await import("../src/server/agents/tools-phase4");
const { registerSourcingTools } = await import("../src/server/agents/tools-sourcing");
const {
  registerPhase1Agents,
  registerPhase2Agents,
  registerPhase3Agents,
  registerPhase4Agents,
  registerPhase6Agents,
} = await import("../src/server/agents/definitions");
const { manifestHash } = await import("../src/server/agents/manifest.server");
const { runAgentTick, startRun, BUDGET_PAUSE_MESSAGE } =
  await import("../src/server/agents/runtime.server");
const { recordAiUsage } = await import("../src/server/ai-usage");

let orgId: string;
let userId: string;
const stamp = Date.now();

const testAgent = (system = "Governance test agent.") => ({
  type: "requisition" as const,
  name: "Governance test",
  version: "0.0.0-test",
  owner: "hr_head" as const,
  responsibility: "Test fixture.",
  mustNever: [],
  scope: { reads: [], writes: [], external: [] },
  gates: ["general" as const],
  riskTier: "low" as const,
  evals: [],
  feature: "agent_requisition" as const,
  system,
  tools: ["probe"],
});

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
    throw new Error("Refusing to run against a non-local database host");
  }
  const [u] = await db
    .insert(users)
    .values({ email: `gov-${stamp}@test.local` })
    .returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Gov Org", slug: `gov-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId,
    email: `gov-${stamp}@test.local`,
    status: "active",
    isOwner: true,
    joinedAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  script.length = 0;
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
  await db
    .insert(agentPolicies)
    .values({ orgId, agentType: "requisition", enabled: true, autonomy: "act_and_notify" });
  registry.resetRegistry();
  registry.registerTool({
    name: "probe",
    description: "Calls an AI feature internally, like JD generation does.",
    input: z.object({}),
    risk: "read",
    skills: ["jd_generate"],
    run: async (ctx) => {
      await recordAiUsage({
        orgId: ctx.orgId,
        feature: "jd_generate",
        provider: "openai",
        model: "m",
        status: "ok",
        totalTokens: 100,
      });
      return "ok";
    },
  });
  registry.registerAgent(testAgent());
});

const runRow = async (id: string) =>
  (await db.select().from(agentRuns).where(eq(agentRuns.id, id)))[0]!;
const auditActions = async (runId: string) =>
  (await db.select({ a: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, runId))).map(
    (r) => r.a,
  );

describe("change control", () => {
  test("agents.lock.json matches every built-in agent (bump version + `bun scripts/agents-lock.ts` on change)", () => {
    registry.resetRegistry();
    registerPhase1Tools();
    registerPhase2Tools();
    registerPhase3Tools();
    registerPhase4Tools();
    registerSourcingTools();
    registerPhase1Agents();
    registerPhase2Agents();
    registerPhase3Agents();
    registerPhase4Agents();
    registerPhase6Agents();
    const lock = JSON.parse(
      readFileSync(new URL("./agents.lock.json", import.meta.url), "utf8"),
    ) as Record<string, { version: string; hash: string }>;
    for (const a of registry.listAgents()) {
      const entry = lock[a.type];
      const hash = manifestHash(a);
      if (entry && entry.version === a.version && entry.hash !== hash) {
        throw new Error(
          `${a.type}: manifest changed without a version bump (still v${a.version}). Bump its version, then run bun scripts/agents-lock.ts.`,
        );
      }
      expect({ agent: a.type, version: entry?.version, hash: entry?.hash }).toEqual({
        agent: a.type,
        version: a.version,
        hash,
      });
    }
    expect(Object.keys(lock).sort()).toEqual(
      registry
        .listAgents()
        .map((a) => a.type)
        .sort(),
    );
  });

  test("any change to instructions or a tool contract changes the manifest hash", () => {
    const base = manifestHash(registry.getAgent("requisition")!);
    registry.registerAgent(testAgent("Different instructions."));
    expect(manifestHash(registry.getAgent("requisition")!)).not.toBe(base);
    registry.registerAgent(testAgent());
    registry.registerTool({
      ...registry.getTool("probe")!,
      description: "Changed contract.",
    } as never);
    expect(manifestHash(registry.getAgent("requisition")!)).not.toBe(base);
  });
});

describe("traceability", () => {
  test("every run records the definition it ran under; one stored snapshot per hash", async () => {
    const a = await startRun({
      orgId,
      agentType: "requisition",
      principalUserId: userId,
      goal: "one",
    });
    const b = await startRun({
      orgId,
      agentType: "requisition",
      principalUserId: userId,
      goal: "two",
    });
    const [ra, rb] = [await runRow(a.runId), await runRow(b.runId)];
    expect(ra.definitionId).toBeTruthy();
    expect(ra).toMatchObject({
      definitionVersion: "0.0.0-test",
      definitionHash: manifestHash(registry.getAgent("requisition")!),
    });
    expect(rb.definitionId).toBe(ra.definitionId);
    const [snap] = await db
      .select()
      .from(agentDefinitions)
      .where(eq(agentDefinitions.id, ra.definitionId!));
    expect(
      (snap!.manifest as { system: string; tools: { name: string; skills: string[] }[] }).tools[0],
    ).toMatchObject({ name: "probe", skills: ["jd_generate"] });
  });

  test("a definition change mid-run is recorded on the run and audited", async () => {
    const { runId } = await startRun({
      orgId,
      agentType: "requisition",
      principalUserId: userId,
      goal: "x",
    });
    const before = (await runRow(runId)).definitionHash;
    registry.registerAgent(testAgent("Changed after the run started."));
    script.push(say("done"));
    await runAgentTick({ orgId });
    const after = await runRow(runId);
    expect(after.definitionHash).not.toBe(before);
    expect(await auditActions(runId)).toContain("agent.run.definition_changed");
  });

  test("AI requests inside tools are attributed to the run; requests outside a run are not", async () => {
    const { runId } = await startRun({
      orgId,
      agentType: "requisition",
      principalUserId: userId,
      goal: "x",
    });
    script.push(call({ id: "p", name: "probe", args: {} }), say("done"));
    await runAgentTick({ orgId });
    const inside = await db.select().from(aiUsageEvents).where(eq(aiUsageEvents.agentRunId, runId));
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatchObject({ feature: "jd_generate", totalTokens: 100 });
    await recordAiUsage({
      orgId,
      feature: "jd_generate",
      provider: "openai",
      model: "m",
      status: "ok",
      totalTokens: 1,
    });
    const outside = await db
      .select()
      .from(aiUsageEvents)
      .where(and(eq(aiUsageEvents.orgId, orgId), eq(aiUsageEvents.totalTokens, 1)));
    expect(outside[0]!.agentRunId).toBeNull();
  });

  test("run start and finish are in the audit log with the definition hash and principal", async () => {
    const { runId } = await startRun({
      orgId,
      agentType: "requisition",
      principalUserId: userId,
      goal: "x",
    });
    script.push(say("done"));
    await runAgentTick({ orgId });
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, runId));
    const started = rows.find((r) => r.action === "agent.run.started")!;
    expect(started).toMatchObject({ actor: `agent:requisition:${runId}`, actorUserId: userId });
    expect((started.detail as { definition_hash: string }).definition_hash).toBe(
      (await runRow(runId)).definitionHash,
    );
    expect(rows.map((r) => r.action)).toContain("agent.run.completed");
  });
});

describe("monthly budget", () => {
  test("an agent over its budget is paused (not failed), audited once, and resumes when raised", async () => {
    // Earlier spend this month: 100 tokens through the probe tool.
    const earlier = await startRun({
      orgId,
      agentType: "requisition",
      principalUserId: userId,
      goal: "spend",
    });
    script.push(call({ id: "p", name: "probe", args: {} }), say("done"));
    await runAgentTick({ orgId });
    await db
      .update(agentPolicies)
      .set({ monthlyTokenBudget: 50 })
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, "requisition")));

    const { runId } = await startRun({
      orgId,
      agentType: "requisition",
      principalUserId: userId,
      goal: "over budget",
    });
    script.push(say("should not run"));
    await runAgentTick({ orgId });
    const paused = await runRow(runId);
    expect(paused).toMatchObject({
      status: "queued",
      lastError: BUDGET_PAUSE_MESSAGE,
      stepCount: 0,
    });
    expect(paused.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
    expect((await runAgentTick({ orgId })).claimed).toBe(0);
    expect((await auditActions(runId)).filter((a) => a === "agent.run.budget_paused")).toHaveLength(
      1,
    );

    await db
      .update(agentPolicies)
      .set({ monthlyTokenBudget: 1_000_000 })
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, "requisition")));
    await db.update(agentRuns).set({ leaseUntil: null }).where(eq(agentRuns.id, runId));
    await runAgentTick({ orgId });
    expect((await runRow(runId)).status).toBe("done");
    await db.delete(agentRuns).where(inArray(agentRuns.id, [earlier.runId]));
  });
});
