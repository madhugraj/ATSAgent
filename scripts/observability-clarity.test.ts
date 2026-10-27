/**
 * Observability that people can read, against the disposable database:
 *  - a tool error is "refused" when a business rule or guardrail said no (a
 *    plain, readable message) and "failed" when something broke (driver,
 *    programming or infrastructure errors) — recorded on the step;
 *  - only failures count towards the tool-error health rule;
 *  - "Try again" does not start a second run while the same agent is still
 *    working on that piece of work.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/observability-clarity.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";

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
  aiAgentStep: async () => script.shift() ?? say("done"),
}));

const { db } = await import("../src/server/db");
const {
  agentIssues,
  agentPolicies,
  agentRuns,
  agentSteps,
  hiringConversations,
  orgMembers,
  organizations,
  requisitions,
  users,
} = await import("../drizzle/schema");
const { registerAgent, registerTool, resetRegistry } =
  await import("../src/server/agents/registry");
const runtime = await import("../src/server/agents/runtime.server");
const { evaluateAgentHealth } = await import("../src/server/agents/health.server");
const desk = await import("../src/server/desk/desk.server");

const stamp = Date.now();
let orgId: string;
let userId: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  userId = (
    await db
      .insert(users)
      .values({ email: `obs-${stamp}@test.local` })
      .returning({ id: users.id })
  )[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Obs Org", slug: `obs-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId,
    email: `obs-${stamp}@test.local`,
    status: "active",
    isOwner: true,
  } as never);
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  script.length = 0;
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentIssues).where(eq(agentIssues.orgId, orgId));
  await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
  await db
    .insert(agentPolicies)
    .values({ orgId, agentType: "requisition", enabled: true, autonomy: "autonomous" } as never);
  resetRegistry();
  registerTool({
    name: "rule",
    description: "A rule says no",
    input: z.object({}),
    risk: "write",
    run: async () => {
      throw new Error("A requisition cannot move from approved to pending_dh.");
    },
  });
  registerTool({
    name: "broken",
    description: "Something breaks",
    input: z.object({}),
    risk: "write",
    run: async () => {
      const o = undefined as unknown as { x: { y: number } };
      return o.x.y;
    },
  });
  registerTool({
    name: "network",
    description: "The network fails",
    input: z.object({}),
    risk: "write",
    run: async () => {
      throw new Error("fetch failed: ECONNREFUSED 10.0.0.1:443");
    },
  });
  registerAgent({
    type: "requisition",
    name: "Obs test agent",
    version: "0.0.0-test",
    owner: "hr_head",
    responsibility: "Test fixture.",
    mustNever: [],
    scope: { reads: [], writes: [], external: [] },
    gates: ["general"],
    riskTier: "low",
    evals: [],
    feature: "agent_requisition",
    maxSteps: 10,
    system: "Test agent.",
    tools: ["rule", "broken", "network"],
  });
});

describe("refused or failed", () => {
  test("pure rule", () => {
    expect(
      runtime.isRuleRefusal(new Error("REQ-2026-002 is in approval, so its weights are locked.")),
    ).toBe(true);
    expect(runtime.isRuleRefusal(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(runtime.isRuleRefusal(new Error("fetch failed: ECONNREFUSED"))).toBe(false);
    expect(runtime.isRuleRefusal(new Error("Failed query: select …"))).toBe(false);
    expect(runtime.isRuleRefusal(new Error(""))).toBe(false);
    expect(runtime.isRuleRefusal("not an error")).toBe(false);
  });

  test("each step records which it was", async () => {
    script.push(
      call({ id: "a", name: "rule", args: {} }),
      call({ id: "b", name: "broken", args: {} }),
      call({ id: "c", name: "network", args: {} }),
      call({ id: "d", name: "nope", args: {} }),
      say("done"),
    );
    const { runId } = await runtime.startRun({
      orgId,
      agentType: "requisition",
      principalUserId: userId,
      goal: "g",
    });
    for (let i = 0; i < 6; i++) await runtime.runAgentTick({ orgId });
    const steps = await db
      .select()
      .from(agentSteps)
      .where(and(eq(agentSteps.runId, runId), eq(agentSteps.status, "error")));
    const refused = (name: string) =>
      (steps.find((s) => s.toolName === name)!.output as { refused?: boolean }).refused ?? false;
    expect(refused("rule")).toBe(true);
    expect(refused("broken")).toBe(false);
    expect(refused("network")).toBe(false);
    expect(refused("nope")).toBe(false); // an unknown tool is the agent's mistake
  });

  test("only failures count towards the tool-error health rule", async () => {
    const [r] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "requisition",
        principalUserId: userId,
        goal: "g",
        status: "done",
      } as never)
      .returning({ id: agentRuns.id });
    const steps = (failed: number, refused: number) =>
      Array.from({ length: 10 }, (_, i) => ({
        runId: r!.id,
        orgId,
        seq: i + 1,
        kind: "tool",
        toolName: "rule",
        status: i < failed + refused ? "error" : "ok",
        output:
          i < failed
            ? { error: "broke" }
            : i < failed + refused
              ? { error: "no", refused: true }
              : {},
      }));
    await db.insert(agentSteps).values(steps(0, 6) as never);
    await evaluateAgentHealth({ orgId });
    const open = () =>
      db
        .select()
        .from(agentIssues)
        .where(
          and(
            eq(agentIssues.orgId, orgId),
            eq(agentIssues.rule, "tools.error_rate"),
            ne(agentIssues.status, "resolved"),
          ),
        );
    expect(await open()).toHaveLength(0);
    await db.delete(agentSteps).where(eq(agentSteps.runId, r!.id));
    await db.insert(agentSteps).values(steps(4, 0) as never);
    await evaluateAgentHealth({ orgId });
    expect((await open())[0]!.title).toMatch(/4 of 10 tool calls failed/);
  });
});

describe("try again", () => {
  test("refuses while the same agent is still working on it", async () => {
    const [req] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-O-${stamp}`,
        title: "UI/UX",
        status: "pending_cbo",
        createdBy: userId,
      } as never)
      .returning({ id: requisitions.id });
    const [conv] = await db
      .insert(hiringConversations)
      .values({
        orgId,
        createdBy: userId,
        title: "UI/UX",
        status: "active",
        requisitionId: req!.id,
      })
      .returning();
    const [failed] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "requisition",
        principalUserId: userId,
        goal: "g",
        status: "failed",
        subjectType: "requisition",
        subjectId: req!.id,
        conversationId: conv!.id,
      } as never)
      .returning({ id: agentRuns.id });
    await db.insert(agentRuns).values({
      orgId,
      agentType: "requisition",
      principalUserId: userId,
      goal: "g",
      status: "awaiting_human",
      subjectType: "requisition",
      subjectId: req!.id,
      conversationId: conv!.id,
    } as never);
    await expect(desk.retryRun(conv!, userId, failed!.id)).rejects.toThrow(
      /already working on this — it started .* and is waiting for a person\. Nothing new was started/,
    );
    const active = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), ne(agentRuns.status, "failed")));
    expect(active).toHaveLength(1);
  });
});
