/**
 * Agent utilisation & efficiency (src/server/agents/utilisation.server.ts):
 * the recommendation rules and cost estimates as pure functions, and the
 * day-wise / per-agent queries against the disposable test database.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/agent-utilisation.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const { agentPolicies, agentRuns, agentSteps, agentTasks, aiUsageEvents, organizations, users } =
  await import("../drizzle/schema");
const { recommend, costOf, agentUtilisation, saveCostRate } =
  await import("../src/server/agents/utilisation.server");

type Eff = Parameters<typeof recommend>[0][number];
const base: Eff = {
  agentType: "intake",
  runs: 10,
  done: 10,
  failed: 0,
  cancelled: 0,
  tokens: 100_000,
  promptTokens: 60_000,
  completionTokens: 40_000,
  wastedTokens: 0,
  tokensPerDoneRun: 10_000,
  agentMinutesPerRun: 2,
  medianWaitHours: null,
  approvals: 0,
  approvalsUnchanged: 0,
  approvalsPerRun: 0,
  repeatedReadsPerRun: 0,
  topRepeatedTool: null,
  topSkill: null,
  p95TurnSeconds: 5,
  tokensPerRunThisWeek: null,
  tokensPerRunLastWeek: null,
  monthTokens: 0,
  monthlyBudget: null,
  autonomy: "suggest",
};
const kinds = (e: Partial<Eff>, today = new Date("2026-10-08T12:00:00Z")) =>
  recommend([{ ...base, ...e }], { days: 14, today }).map((r) => r.kind);

describe("recommendations", () => {
  test("a healthy agent gets none", () => {
    expect(kinds({})).toEqual([]);
  });
  test("wasted spend on failed runs, with a weekly saving", () => {
    const [r] = recommend([{ ...base, failed: 3, wastedTokens: 30_000 }], {
      days: 14,
      today: new Date(),
    });
    expect(r).toMatchObject({ kind: "waste", severity: "save", saving: { tokens: 15_000 } });
  });
  test("rubber-stamp approvals suggest Act and notify, only under Suggest", () => {
    const e = {
      approvals: 20,
      approvalsUnchanged: 19,
      approvalsPerRun: 2,
      medianWaitHours: 3,
    };
    const [r] = recommend([{ ...base, ...e }], { days: 14, today: new Date() });
    expect(r).toMatchObject({ kind: "autonomy", saving: { approvals: 10, hours: 28.5 } });
    expect(kinds({ ...e, autonomy: "act_and_notify" })).not.toContain("autonomy");
  });
  test("long re-sent conversations, repeated reads, slow turns, growth", () => {
    expect(
      kinds({ promptTokens: 95_000, completionTokens: 5_000, tokensPerDoneRun: 120_000 }),
    ).toContain("context");
    expect(kinds({ repeatedReadsPerRun: 2, topRepeatedTool: "get_requisition" })).toContain(
      "repeats",
    );
    expect(kinds({ p95TurnSeconds: 25 })).toContain("slow");
    expect(kinds({ tokensPerRunThisWeek: 14_000, tokensPerRunLastWeek: 10_000 })).toContain(
      "growth",
    );
  });
  test("budget runway: projects the month and dates the run-out", () => {
    const [r] = recommend([{ ...base, monthTokens: 40_000, monthlyBudget: 60_000 }], {
      days: 14,
      today: new Date("2026-10-08T12:00:00Z"),
    });
    expect(r).toMatchObject({ kind: "budget", severity: "watch" });
    expect(r!.title).toMatch(/2026-10-12/);
    expect(
      recommend([{ ...base, monthTokens: 70_000, monthlyBudget: 60_000 }], {
        days: 14,
        today: new Date("2026-10-08T12:00:00Z"),
      })[0],
    ).toMatchObject({ kind: "budget", severity: "save" });
  });
  test("cost only at the organisation's own rate", () => {
    expect(costOf(null, 1_000_000, 1_000_000)).toBeNull();
    expect(
      costOf({ currency: "USD", inputPerMillion: 1.25, outputPerMillion: 10 }, 2_000_000, 500_000),
    ).toBeCloseTo(7.5);
  });
});

/* ------------------------------------------------------- the queries */

let orgId: string;
let userId: string;
const stamp = Date.now();

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db
    .insert(users)
    .values({ email: `util-${stamp}@test.local` })
    .returning();
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Util Org", slug: `util-${stamp}`, status: "active" })
    .returning();
  orgId = o!.id;
});
afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("agentUtilisation", () => {
  test("day-wise tokens and time, per-agent efficiency, cost at the saved rate", async () => {
    await db.insert(agentPolicies).values({
      orgId,
      agentType: "intake",
      enabled: true,
      monthlyTokenBudget: 1000,
    });
    const run = async (status: string) =>
      (
        await db
          .insert(agentRuns)
          .values({
            orgId,
            agentType: "intake",
            principalUserId: userId,
            goal: "g",
            status: status as never,
            finishedAt: new Date(),
          })
          .returning({ id: agentRuns.id })
      )[0]!.id;
    const ok = await run("done");
    const bad = await run("failed");
    const ai = (runId: string, prompt: number, completion: number) =>
      db.insert(aiUsageEvents).values({
        orgId,
        agentRunId: runId,
        feature: "agent_intake",
        provider: "test",
        model: "test",
        status: "ok" as never,
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
        durationMs: 1000,
      });
    await ai(ok, 900, 100);
    await ai(bad, 400, 100);
    await db.insert(agentSteps).values([
      { runId: ok, orgId, seq: 1, kind: "model", status: "ok", durationMs: 60_000 },
      {
        runId: ok,
        orgId,
        seq: 2,
        kind: "tool",
        toolName: "get_requisition",
        status: "ok",
        input: { id: 1 } as never,
      },
      {
        runId: ok,
        orgId,
        seq: 3,
        kind: "tool",
        toolName: "get_requisition",
        status: "ok",
        input: { id: 1 } as never,
      },
    ]);
    await db.insert(agentTasks).values({
      orgId,
      runId: ok,
      kind: "approval",
      status: "approved",
      title: "t",
      createdAt: new Date(Date.now() - 2 * 3600_000),
      decidedAt: new Date(),
    });

    let u = await agentUtilisation(orgId, 14);
    expect(u.series).toHaveLength(14);
    expect(u.rate).toBeNull();
    expect(u.totals).toMatchObject({ tokens: 1500, cost: null, wastedTokens: 500 });
    expect(u.totals.waitHours).toBeCloseTo(2, 0);
    const a = u.agents.find((x) => x.agentType === "intake")!;
    expect(a).toMatchObject({
      runs: 2,
      done: 1,
      failed: 1,
      tokens: 1500,
      wastedTokens: 500,
      approvals: 1,
    });
    expect(a.repeatedReadsPerRun).toBe(0.5);
    expect(a.topRepeatedTool).toBe("get_requisition");
    // Over its tiny budget: the budget recommendation fires; a third of tokens wasted fires too.
    expect(u.recommendations.map((r) => r.kind)).toEqual(
      expect.arrayContaining(["waste", "budget"]),
    );

    await saveCostRate(orgId, userId, { currency: "USD", inputPerMillion: 2, outputPerMillion: 8 });
    u = await agentUtilisation(orgId, 14);
    // (900 + 400) input × 2 + (100 + 100) output × 8, per million.
    expect(u.totals.cost).toBeCloseTo((1300 * 2 + 200 * 8) / 1e6);
    expect(u.agents[0]!.costPerRun).toBeCloseTo(u.totals.cost! / 2);
  });
});
