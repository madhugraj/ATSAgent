/**
 * The person's own JD attached in the hiring desk (file text or long paste):
 *  - it is kept in the thread word for word, marked as their JD;
 *  - before the role exists, the desk reads it like any message (details are taken);
 *  - when the role is approved, the JD agent is told to file it, not draft one;
 *  - a role that already has an approved JD keeps it — nothing is replaced and
 *    no JD agent starts.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/desk-own-jd.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentRuns,
  hiringConversations,
  hiringMessages,
  jobDescriptions,
  organizations,
  requisitions,
  users,
} = await import("../drizzle/schema");
const desk = await import("../src/server/desk/desk.server");

const stamp = Date.now();
let orgId: string;
let userId: string;

const OWN_JD = [
  "# Regional Sales Manager – Enterprise AI",
  "",
  "Location: Uganda, East Africa. Experience: 6–8 years. Full-time.",
  "",
  "## What you will do",
  "- Own enterprise AI revenue across East Africa and build the partner channel.",
  "- Run a pipeline of banks, telcos and government accounts from first call to signature.",
].join("\n");

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  userId = (
    await db
      .insert(users)
      .values({ email: `ownjd-${stamp}@test.local` })
      .returning({ id: users.id })
  )[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Own JD Org", slug: `ownjd-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

async function thread(requisitionId: string | null) {
  const [c] = await db
    .insert(hiringConversations)
    .values({
      orgId,
      createdBy: userId,
      title: "Regional Sales Manager",
      status: (requisitionId ? "active" : "gathering") as never,
      requisitionId,
    })
    .returning();
  return desk.loadConversation(orgId, c!.id);
}

async function requisition(status: string) {
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-OJD-${Math.random().toString(36).slice(2, 7)}`,
      title: "Regional Sales Manager – Enterprise AI",
      status,
      createdBy: userId,
    } as never)
    .returning({ id: requisitions.id });
  return r!.id;
}

const messages = (conversationId: string) =>
  db
    .select({ role: hiringMessages.role, body: hiringMessages.body, card: hiringMessages.card })
    .from(hiringMessages)
    .where(eq(hiringMessages.conversationId, conversationId))
    .orderBy(asc(hiringMessages.createdAt));

describe("own JD attached in the hiring desk", () => {
  test("kept word for word and filed once the role is approved", async () => {
    const conv = await thread(null);
    await desk.attachOwnJd(conv, userId, OWN_JD, "rsm-uganda.pdf");
    const m = await messages(conv.id);
    expect(m[0]).toMatchObject({
      role: "user",
      body: OWN_JD,
      card: { type: desk.OWN_JD_CARD, fileName: "rsm-uganda.pdf" },
    });
    // The desk takes a turn on it (here without an AI key, it says so).
    expect(m[1]?.role).toBe("desk");
  });

  test("the approved role's JD agent files the shared JD instead of drafting", async () => {
    const reqId = await requisition("approved");
    const conv = await thread(reqId);
    const req = { id: reqId, code: "REQ-OJD", title: "Regional Sales Manager" };
    expect(await desk.jdGoalForRequisition(orgId, req)).toContain("Draft its job description");
    await db.insert(hiringMessages).values({
      conversationId: conv.id,
      orgId,
      role: "user",
      body: OWN_JD,
      card: { type: desk.OWN_JD_CARD, fileName: null } as never,
    });
    const goal = await desk.jdGoalForRequisition(orgId, req);
    expect(goal).toContain("import_jd_version");
    expect(goal).not.toContain("Draft its job description");
  });

  test("a role still in approval waits for its approval", async () => {
    const conv = await thread(await requisition("pending_hr"));
    await desk.attachOwnJd(conv, userId, OWN_JD, null);
    const m = await messages(conv.id);
    expect(m[1]?.body).toContain("as soon as the requisition is approved");
  });

  test("an approved JD is never replaced and no JD agent starts", async () => {
    const reqId = await requisition("approved");
    await db
      .insert(jobDescriptions)
      .values({ orgId, requisitionId: reqId, version: 1, status: "approved" } as never);
    const conv = await thread(reqId);
    await desk.attachOwnJd(conv, userId, OWN_JD, null);
    const m = await messages(conv.id);
    expect(m[1]?.body).toContain("already has an approved job description");
    const runs = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.conversationId, conv.id));
    expect(runs).toHaveLength(0);
  });

  test("“stop” cancels the role's running agents and keeps the role open", async () => {
    const reqId = await requisition("approved");
    const conv = await thread(reqId);
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "intake",
        goal: "Rank candidates",
        status: "running",
        principalUserId: userId,
        subjectType: "requisition",
        subjectId: reqId,
      } as never)
      .returning({ id: agentRuns.id });
    expect(await desk.stopRoleAgents(conv, userId)).toBe(1);
    const [after] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, run!.id));
    expect(after?.status).toBe("cancelled");
    const [req] = await db
      .select({ status: requisitions.status })
      .from(requisitions)
      .where(eq(requisitions.id, reqId));
    expect(req?.status).toBe("approved");
    const m = await messages(conv.id);
    expect(m.at(-1)?.body).toContain("Stopped:");
    expect(await desk.stopRoleAgents(conv, userId)).toBe(0);
  });
});
