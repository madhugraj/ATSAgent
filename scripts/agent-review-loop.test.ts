/**
 * Agents must not go round in circles on a role where nothing has changed.
 *
 * - The scheduled pipeline review fires for an unscored application or a
 *   candidate put on hold since the last review — not again and again for a
 *   hold that is only waiting for a person — and while candidates are held it
 *   does not top the role up from the talent pool.
 * - Picking candidates on the hiring desk lets the Screening agent arrange
 *   their call, and does not start screening again where it is under way.
 *
 * Needs a local Postgres (DATABASE_URL).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentPolicies,
  agentRuns,
  applications,
  candidates,
  hiringConversations,
  hiringMessages,
  matchScores,
  orgMembers,
  organizations,
  requisitions,
  screeningCalls,
  screeningKits,
  stageEvents,
  userRoles,
  users,
} = await import("../drizzle/schema");
await import("../src/server/agents/index"); // registers every agent and tool
const { scheduleSweeps } = await import("../src/server/agents/orchestrator.server");
const { screenCandidates } = await import("../src/server/desk/desk.server");

const stamp = Date.now();
let orgId: string;
let hrId: string;
let reqId: string;

async function application(stage: string) {
  const [c] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: `Cand ${Math.random().toString(36).slice(2, 7)}`,
      email: `c-${Math.random()}@cand.local`,
    } as never)
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage } as never)
    .returning({ id: applications.id });
  await db
    .insert(matchScores)
    .values({ orgId, applicationId: a!.id, overallScore: 62, recommendation: "hold" } as never);
  return { appId: a!.id, candidateId: c!.id };
}

/** Put an application on hold now, as the pipeline records it. */
async function hold(appId: string) {
  await db.insert(stageEvents).values({
    orgId,
    applicationId: appId,
    fromStage: "applied",
    toStage: "ai_screened",
    actorUserId: hrId,
  } as never);
}

async function reviews() {
  return db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentType, "intake"),
        sql`${agentRuns.goal} like 'Review the pipeline%'`,
      ),
    );
}

/** Close every run and move it past the sweep's cooldown. */
async function settleAndAge() {
  await db
    .update(agentRuns)
    .set({ status: "done", createdAt: sql`now() - interval '7 hours'` } as never)
    .where(eq(agentRuns.orgId, orgId));
  // Holds recorded so far happened before those runs.
  await db
    .update(stageEvents)
    .set({ createdAt: sql`now() - interval '8 hours'` } as never)
    .where(eq(stageEvents.orgId, orgId));
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [o] = await db
    .insert(organizations)
    .values({ name: "Loop Org", slug: `loop-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [u] = await db
    .insert(users)
    .values({ email: `hr-${stamp}@test.local` })
    .returning({ id: users.id });
  hrId = u!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId: hrId,
    email: `hr-${stamp}@test.local`,
    fullName: "HR",
    status: "active",
    isOwner: true,
  } as never);
  await db.insert(userRoles).values({ userId: hrId, orgId, role: "hr_head" as never });
  const [req] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `LOOP-${stamp}`,
      title: "AI Engineer",
      status: "approved",
      mustHaveSkills: ["Python"],
      createdBy: hrId,
    } as never)
    .returning({ id: requisitions.id });
  reqId = req!.id;
  for (const a of ["intake", "screening"])
    await db
      .insert(agentPolicies)
      .values({ orgId, agentType: a, enabled: true, autonomy: "suggest" } as never)
      .onConflictDoUpdate({
        target: [agentPolicies.orgId, agentPolicies.agentType],
        set: { enabled: true },
      });
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, hrId));
});

describe("scheduled pipeline review", () => {
  test("a new hold starts a review that does not top up from the pool", async () => {
    const { appId } = await application("ai_screened");
    await hold(appId);
    await scheduleSweeps({ orgId });
    const runs = await reviews();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.subjectId).toBe(reqId);
    expect(runs[0]!.goal).toContain("do not add candidates from the talent pool");
    expect(runs[0]!.goal).not.toContain("top up from the talent pool");
  });

  test("the same hold, still waiting for a person, does not start another review", async () => {
    await settleAndAge();
    await scheduleSweeps({ orgId });
    expect(await reviews()).toHaveLength(1);
  });

  test("another candidate put on hold since the last review starts one", async () => {
    const { appId } = await application("ai_screened");
    await hold(appId);
    await scheduleSweeps({ orgId });
    expect(await reviews()).toHaveLength(2);
  });

  test("an unscored application still starts intake work", async () => {
    await settleAndAge();
    const intakeRuns = async () =>
      (
        await db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "intake")))
      ).length;
    const before = await intakeRuns();
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "New", email: `n-${stamp}@cand.local` } as never)
      .returning({ id: candidates.id });
    await db
      .insert(applications)
      .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "applied" } as never);
    await scheduleSweeps({ orgId });
    expect(await intakeRuns()).toBe(before + 1);
  });
});

describe("hiring desk: picking candidates for screening", () => {
  async function thread() {
    const [conv] = await db
      .insert(hiringConversations)
      .values({ orgId, createdBy: hrId, title: "AI Engineer", requisitionId: reqId } as never)
      .returning();
    return conv!;
  }
  const screeningRuns = () =>
    db
      .select({ goal: agentRuns.goal })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "screening")));
  const deskNotes = async (convId: string) =>
    (
      await db
        .select({ body: hiringMessages.body })
        .from(hiringMessages)
        .where(and(eq(hiringMessages.conversationId, convId), eq(hiringMessages.role, "desk")))
    )
      .map((m) => m.body)
      .join("\n");

  test("a candidate with a kit but no call yet goes to the agent to arrange the call", async () => {
    await settleAndAge();
    const { appId, candidateId } = await application("shortlisted");
    await db.insert(screeningKits).values({
      orgId,
      candidateId,
      requisitionId: reqId,
      applicationId: appId,
      questions: [],
    } as never);
    const before = (await screeningRuns()).length;
    await screenCandidates((await thread()) as never, hrId, [appId]);
    const runs = await screeningRuns();
    expect(runs).toHaveLength(before + 1);
    const goal = runs.map((r) => r.goal).find((g) => g.includes(appId))!;
    // The stale "calls are not connected" line kept the agent from ever arranging one.
    expect(goal).not.toContain("not connected");
    expect(goal).toContain("arrange their screening");
    expect(goal).toContain("reuse an existing kit");
  });

  test("a candidate whose call is already arranged is not started again", async () => {
    await settleAndAge();
    const { appId, candidateId } = await application("shortlisted");
    await db.insert(screeningCalls).values({
      orgId,
      candidateId,
      requisitionId: reqId,
      applicationId: appId,
      status: "approved",
      requestedBy: hrId,
    } as never);
    const before = (await screeningRuns()).length;
    const conv = await thread();
    expect(await screenCandidates(conv as never, hrId, [appId])).toBe(1);
    expect(await screeningRuns()).toHaveLength(before);
    expect(await deskNotes(conv.id)).toContain("already being screened");
  });

  test("a cancelled call does not count: the candidate is screened again", async () => {
    await settleAndAge();
    const { appId, candidateId } = await application("shortlisted");
    await db.insert(screeningCalls).values({
      orgId,
      candidateId,
      requisitionId: reqId,
      applicationId: appId,
      status: "cancelled",
      requestedBy: hrId,
    } as never);
    const before = (await screeningRuns()).length;
    await screenCandidates((await thread()) as never, hrId, [appId]);
    expect(await screeningRuns()).toHaveLength(before + 1);
  });
});
