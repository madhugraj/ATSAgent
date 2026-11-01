/**
 * Step-up re-authentication (src/server/step-up.ts, docs/guardrails.md P2-4)
 * against the disposable database: a session without a recent password is
 * refused; the right password unlocks it for 10 minutes for THAT session
 * only; wrong passwords are audited and lock after five.
 * Run: DATABASE_URL=... SESSION_SECRET=... bun test scripts/step-up.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const { auditLog, organizations, sessions, users } = await import("../drizzle/schema");
const { createSession, SESSION_COOKIE } = await import("../src/server/identity");
const { hashPassword } = await import("../src/server/password");
const { assertStepUp, confirmStepUp, stepUpFresh, STEP_UP_MAX_FAILURES, STEP_UP_WINDOW_MS } =
  await import("../src/server/step-up");

const stamp = Date.now();
const PASSWORD = `StepUp#${stamp}`;
let orgId: string;
let userId: string;
let otherId: string;
let tokenA: string;
let tokenB: string;
const req = (token: string) =>
  new Request("http://localhost/_serverFn/x", {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });

beforeAll(async () => {
  const [o] = await db
    .insert(organizations)
    .values({ name: "Step Org", slug: `su-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [u] = await db
    .insert(users)
    .values({ email: `su-${stamp}@test.local`, passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: users.id });
  userId = u!.id;
  const [v] = await db
    .insert(users)
    .values({
      email: `su-other-${stamp}@test.local`,
      passwordHash: await hashPassword("Other#2026x"),
    })
    .returning({ id: users.id });
  otherId = v!.id;
  tokenA = await createSession(userId);
  tokenB = await createSession(userId); // the same person, another browser
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, otherId));
});

describe("step-up", () => {
  test("freshness window", () => {
    const now = new Date();
    expect(stepUpFresh(null, now)).toBe(false);
    expect(stepUpFresh(new Date(now.getTime() - STEP_UP_WINDOW_MS + 1000), now)).toBe(true);
    expect(stepUpFresh(new Date(now.getTime() - STEP_UP_WINDOW_MS - 1000), now)).toBe(false);
  });

  test("a signed-in session alone is refused with the step-up marker", async () => {
    await expect(assertStepUp(userId, req(tokenA))).rejects.toThrow(/^STEP_UP_REQUIRED/);
  });

  test("the right password unlocks this session only; audited", async () => {
    await confirmStepUp({ userId, orgId, password: PASSWORD, request: req(tokenA) });
    await assertStepUp(userId, req(tokenA));
    await expect(assertStepUp(userId, req(tokenB))).rejects.toThrow(/STEP_UP_REQUIRED/);
    // Someone else's session never counts for this user.
    const tokenOther = await createSession(otherId);
    await expect(assertStepUp(userId, req(tokenOther))).rejects.toThrow(/STEP_UP_REQUIRED/);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, userId), eq(auditLog.action, "auth.step_up")));
    expect(audits).toHaveLength(1);
  });

  test("it expires after 10 minutes", async () => {
    await db
      .update(sessions)
      .set({ reauthenticatedAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 1000) })
      .where(eq(sessions.userId, userId));
    await expect(assertStepUp(userId, req(tokenA))).rejects.toThrow(/STEP_UP_REQUIRED/);
  });

  test("wrong passwords are audited and lock step-up after five", async () => {
    for (let i = 0; i < STEP_UP_MAX_FAILURES; i++) {
      await expect(
        confirmStepUp({ userId, orgId, password: "wrong", request: req(tokenB) }),
      ).rejects.toThrow(/not correct/);
    }
    // Even the right password is refused while locked.
    await expect(
      confirmStepUp({ userId, orgId, password: PASSWORD, request: req(tokenB) }),
    ).rejects.toThrow(/Too many wrong passwords/);
    await expect(assertStepUp(userId, req(tokenB))).rejects.toThrow(/STEP_UP_REQUIRED/);
  });
});
