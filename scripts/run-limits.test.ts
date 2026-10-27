/**
 * Run limits per stretch of work (migration 0042), against the disposable
 * database with a scripted model:
 *  - a run stops when one stretch (the work between two human decisions)
 *    uses up its AI turns, with a message that says what to do;
 *  - a person's decision gives a fresh allowance, so an approval chain is no
 *    longer cut short; a hard ceiling (four stretches) still stops a loop;
 *  - the organisation can raise an agent's limits, also for runs under way;
 *  - older tool results are shortened in what the model re-reads, never in
 *    the run's own record.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/run-limits.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { AgentMessage, AgentStepResult, AgentToolCall } from "../src/lib/ai-gateway.server";

const script: AgentStepResult[] = [];
const seen: AgentMessage[][] = [];
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
  aiAgentStep: async (input: { messages: AgentMessage[] }) => {
    seen.push(input.messages);
    return script.shift() ?? say("(script exhausted)");
  },
}));

const { db } = await import("../src/server/db");
const { agentPolicies, agentRuns, agentTasks, orgMembers, organizations, userRoles, users } =
  await import("../drizzle/schema");
const { registerAgent, registerTool, resetRegistry } =
  await import("../src/server/agents/registry");
const runtime = await import("../src/server/agents/runtime.server");
const { LEG_LIMIT_MESSAGE, CEILING_MESSAGE } = await import("../src/server/agents/run-messages");

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
      .values({ email: `limits-${stamp}@test.local` })
      .returning({ id: users.id })
  )[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Limits Org", slug: `limits-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId,
    email: `limits-${stamp}@test.local`,
    status: "active",
    isOwner: true,
  } as never);
  await db.insert(userRoles).values({ userId, orgId, role: "recruiter" });
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  script.length = 0;
  seen.length = 0;
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
  await db
    .insert(agentPolicies)
    .values({ orgId, agentType: "requisition", enabled: true, autonomy: "autonomous" } as never);
  resetRegistry();
  registerTool({
    name: "lookup",
    description: "Read something long",
    input: z.object({ id: z.string() }),
    risk: "read",
    run: async (_ctx, i) => `${i.id}: ${"x".repeat(2000)}`,
  });
  registerAgent({
    type: "requisition",
    name: "Limits test agent",
    version: "0.0.0-test",
    owner: "hr_head",
    responsibility: "Test fixture.",
    mustNever: [],
    scope: { reads: [], writes: [], external: [] },
    gates: ["general"],
    riskTier: "low",
    evals: [],
    feature: "agent_requisition",
    maxSteps: 3,
    system: "Test agent.",
    tools: ["lookup"],
  });
});

const look = (id: string) => call({ id, name: "lookup", args: { id } });
const start = () =>
  runtime.startRun({ orgId, agentType: "requisition", principalUserId: userId, goal: "Work" });
const runOf = async (id: string) =>
  (await db.select().from(agentRuns).where(eq(agentRuns.id, id)))[0]!;
async function tickUntilSettled(id: string) {
  for (let i = 0; i < 12; i++) {
    await runtime.runAgentTick({ orgId });
    const r = await runOf(id);
    if (!["queued", "running"].includes(r.status)) return r;
  }
  return runOf(id);
}

describe("pure rules", () => {
  const base = {
    stepCount: 0,
    tokensUsed: 0,
    legStepStart: 0,
    legTokenStart: 0,
    maxSteps: 16,
    maxTokens: 200_000,
  };
  test("leg and ceiling", () => {
    expect(runtime.limitReached(base)).toBeNull();
    expect(runtime.limitReached({ ...base, stepCount: 16 })).toBe("leg");
    // After a decision at step 16, the next 15 turns are fine…
    expect(runtime.limitReached({ ...base, stepCount: 31, legStepStart: 16 })).toBeNull();
    expect(runtime.limitReached({ ...base, stepCount: 32, legStepStart: 16 })).toBe("leg");
    // …but four stretches' worth is the ceiling, decisions or not.
    expect(runtime.limitReached({ ...base, stepCount: 64, legStepStart: 60 })).toBe("ceiling");
    expect(runtime.limitReached({ ...base, tokensUsed: 200_000 })).toBe("leg");
    expect(runtime.limitReached({ ...base, tokensUsed: 800_000, legTokenStart: 790_000 })).toBe(
      "ceiling",
    );
  });

  test("older tool results are shortened for the model; recent ones and fences stay whole", () => {
    const long = "y".repeat(3000);
    const t: AgentMessage[] = [
      { role: "user", content: "goal" },
      { role: "tool", toolCallId: "a", name: "lookup", content: long },
      {
        role: "tool",
        toolCallId: "b",
        name: "read_cv",
        content: `<untrusted_data label="cv">\n${long}\n</untrusted_data>`,
      },
      ...Array.from({ length: 8 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
      { role: "tool", toolCallId: "c", name: "lookup", content: long },
    ];
    const out = runtime.compactForModel(t);
    expect(out[0]).toEqual(t[0]!);
    expect((out[1] as { content: string }).content).toMatch(
      /^y{700}\n\[… shortened: 2300 more characters/,
    );
    const fenced = (out[2] as { content: string }).content;
    expect(fenced.startsWith('<untrusted_data label="cv">\n')).toBe(true);
    expect(fenced.endsWith("\n</untrusted_data>")).toBe(true);
    expect((out.at(-1) as { content: string }).content).toBe(long);
    expect(t[1]).toMatchObject({ content: long }); // the record is untouched
  });
});

describe("in a run", () => {
  test("one stretch that uses up its turns stops, saying what to do", async () => {
    script.push(look("a"), look("b"), look("c"), say("done"));
    const { runId } = await start();
    const r = await tickUntilSettled(runId);
    expect(r).toMatchObject({ status: "failed", lastError: LEG_LIMIT_MESSAGE, stepCount: 3 });
  });

  test("a person's decision gives a fresh allowance", async () => {
    script.push(
      look("a"),
      look("b"),
      call({ id: "q", name: "ask_human", args: { question: "Which band?" } }),
    );
    const { runId } = await start();
    let r = await tickUntilSettled(runId);
    expect(r.status).toBe("awaiting_human");
    const [task] = await db.select().from(agentTasks).where(eq(agentTasks.runId, runId));
    script.push(look("c"), look("d"), say("All done."));
    await runtime.resolveTask({
      orgId,
      taskId: task!.id,
      userId,
      decision: { status: "answered", answer: "Use the market band." },
    });
    r = await tickUntilSettled(runId);
    // Six turns in all — twice the per-stretch allowance — and it finished.
    expect(r).toMatchObject({ status: "done", stepCount: 6, legStepStart: 3 });
  });

  test("the ceiling stops a run whatever the decisions", async () => {
    const { runId } = await start();
    await db
      .update(agentRuns)
      .set({ stepCount: 12, legStepStart: 12 })
      .where(eq(agentRuns.id, runId));
    script.push(say("never reached"));
    const r = await tickUntilSettled(runId);
    expect(r).toMatchObject({ status: "failed", lastError: CEILING_MESSAGE });
    expect(seen).toHaveLength(0);
  });

  test("raised limits apply to new runs and to runs under way", async () => {
    await db
      .update(agentPolicies)
      .set({ maxStepsPerLeg: 5, maxTokensPerLeg: 50_000 })
      .where(eq(agentPolicies.orgId, orgId));
    const { runId } = await start();
    expect(await runOf(runId)).toMatchObject({ maxSteps: 5, maxTokens: 50_000 });
    script.push(look("a"), look("b"), look("c"), look("d"), say("done"));
    expect(await tickUntilSettled(runId)).toMatchObject({ status: "done", stepCount: 5 });
  });

  test("the model re-reads earlier results shortened; the run keeps them whole", async () => {
    await db
      .update(agentPolicies)
      .set({ maxStepsPerLeg: 20 })
      .where(eq(agentPolicies.orgId, orgId));
    script.push(...["a", "b", "c", "d", "e", "f"].map(look), say("done"));
    const { runId } = await start();
    await tickUntilSettled(runId);
    const lastSeen = seen.at(-1)!;
    const firstResult = lastSeen.find((m) => m.role === "tool") as { content: string };
    expect(firstResult.content).toMatch(/shortened/);
    const stored = ((await runOf(runId)).transcript as AgentMessage[]).find(
      (m) => m.role === "tool",
    ) as { content: string };
    expect(stored.content).not.toMatch(/shortened/);
    expect(stored.content.length).toBeGreaterThan(2000);
  });
});
