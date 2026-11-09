/**
 * Agent event lineage against the disposable local database: an event emitted
 * inside a run's scope records that run as its publisher (never across orgs),
 * one emitted outside a run records none, and the governance read model
 * follows run → event → run chains end to end and flags an agent that
 * restarts itself on the same work.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

process.env["AGENT_INLINE_KICK"] = "0";

const { db } = await import("../src/server/db");
const { agentEvents, agentRuns, organizations, users } = await import("../drizzle/schema");
const { emitAgentEvent } = await import("../src/server/agents/events");
const { agentRunScope } = await import("../src/server/agents/context");
const { computeHarness } = await import("../src/server/agents/governance.server");

let orgId: string;
let otherOrgId: string;
let userId: string;
const stamp = Date.now();
const SUBJECT = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db
    .insert(users)
    .values({ email: `lineage-${stamp}@test.local` })
    .returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Lineage Org", slug: `lineage-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [o2] = await db
    .insert(organizations)
    .values({ name: "Lineage Other", slug: `lineage-o-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  otherOrgId = o2!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(organizations).where(eq(organizations.id, otherOrgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await db.delete(agentEvents).where(eq(agentEvents.orgId, orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
});

async function run(agentType: string, triggerEventId: string | null = null) {
  const [r] = await db
    .insert(agentRuns)
    .values({
      orgId,
      agentType: agentType as never,
      principalUserId: userId,
      goal: "t",
      subjectType: "requisition",
      subjectId: SUBJECT,
      status: "completed",
      triggerEventId,
    } as never)
    .returning({ id: agentRuns.id });
  return r!.id;
}

const emit = (org: string) =>
  emitAgentEvent({
    orgId: org,
    type: "requisition.status_changed",
    subjectType: "requisition",
    subjectId: SUBJECT,
    actorUserId: userId,
  });

async function lastEvent(org: string) {
  const [e] = await db.select().from(agentEvents).where(eq(agentEvents.orgId, org));
  return e!;
}

describe("event lineage", () => {
  test("an event emitted inside a run records that run as its publisher", async () => {
    const runId = await run("requisition");
    await agentRunScope.run({ runId, orgId, agentType: "requisition" }, () => emit(orgId));
    expect((await lastEvent(orgId)).sourceRunId).toBe(runId);
  });

  test("an event emitted outside any run has no publishing run", async () => {
    await emit(orgId);
    expect((await lastEvent(orgId)).sourceRunId).toBeNull();
  });

  test("a run in another organisation is never recorded as the publisher", async () => {
    const runId = await run("requisition");
    await agentRunScope.run({ runId, orgId, agentType: "requisition" }, () => emit(otherOrgId));
    const e = await lastEvent(otherOrgId);
    expect(e.sourceRunId).toBeNull();
    await db.delete(agentEvents).where(eq(agentEvents.orgId, otherOrgId));
  });
});

describe("governance chains", () => {
  async function chained(publisherRun: string, agentType: string) {
    await agentRunScope.run({ runId: publisherRun, orgId, agentType: "x" }, () => emit(orgId));
    const evs = await db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.sourceRunId, publisherRun));
    return run(agentType, evs[0]!.id);
  }

  test("follows run → event → run end to end", async () => {
    const a = await run("requisition");
    const b = await chained(a, "jd");
    await chained(b, "publishing");
    const h = await computeHarness(orgId);
    expect(h.handoffs.chainedRuns).toBe(2);
    expect(h.handoffs.longest?.path).toEqual(["requisition", "jd", "publishing"]);
    expect(h.handoffs.loops).toHaveLength(0);
    expect(h.handoffs.edges.some((e) => e.k === "publish" && e.s === "pub-requisition")).toBe(true);
  });

  test("flags an agent that restarts itself on the same work", async () => {
    const a = await run("requisition");
    const b = await chained(a, "jd");
    await chained(b, "requisition");
    const h = await computeHarness(orgId);
    expect(h.handoffs.loops).toHaveLength(1);
    expect(h.handoffs.loops[0]!.path).toEqual(["requisition", "jd", "requisition"]);
    expect(h.questions.find((q) => q.key === "handoffs")?.tone).toBe("bad");
  });
});
