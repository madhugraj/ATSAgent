/**
 * Deleting a hiring-desk chat (migration 0040), against the disposable database:
 *  - what may be deleted: a chat still gathering details, or one with an unused
 *    draft requisition — never anything in approval or later;
 *  - who: a chat by its starter or the HR head / CBO / owner; a draft only by
 *    the HR head / CBO / owner, with a reason;
 *  - deleting hides it at once, stops its agent runs, deletes the draft, and is
 *    audited; restoring is for owners within 30 days; after that the sweep
 *    purges it (messages go, agent runs keep their record), audited.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/desk-delete.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentRuns,
  applications,
  auditLog,
  candidates,
  hiringConversations,
  hiringMessages,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const desk = await import("../src/server/desk/desk.server");

const stamp = Date.now();
let orgId: string;
let owner: string;
let hr: string;
let creator: string;
let other: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const mk = async (tag: string) =>
    (
      await db
        .insert(users)
        .values({ email: `del-${tag}-${stamp}@test.local` })
        .returning({ id: users.id })
    )[0]!.id;
  [owner, hr, creator, other] = [await mk("owner"), await mk("hr"), await mk("c"), await mk("o")];
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Delete Org", slug: `del-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  for (const [u, isOwner, role] of [
    [owner, true, null],
    [hr, false, "hr_head"],
    [creator, false, "recruiter"],
    [other, false, "recruiter"],
  ] as const) {
    await db.insert(orgMembers).values({
      orgId,
      userId: u,
      email: `${u}@x.local`,
      status: "active",
      isOwner,
    } as never);
    if (role) await db.insert(userRoles).values({ userId: u, orgId, role });
  }
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const u of [owner, hr, creator, other]) await db.delete(users).where(eq(users.id, u));
});

async function thread(opts: { requisition?: string; status?: string } = {}) {
  const [c] = await db
    .insert(hiringConversations)
    .values({
      orgId,
      createdBy: creator,
      title: "UI/UX Developer",
      status: (opts.status ?? (opts.requisition ? "active" : "gathering")) as never,
      requisitionId: opts.requisition ?? null,
    })
    .returning();
  await desk.postMessage(c!, { role: "user", body: "I need a UI/UX developer" });
  await desk.postMessage(c!, { role: "desk", body: "Where will this role be located?" });
  return c!;
}
async function requisition(status: string, withApplicant = false) {
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-DEL-${Math.random().toString(36).slice(2, 7)}`,
      title: "UI/UX Developer",
      status,
      createdBy: creator,
    } as never)
    .returning({ id: requisitions.id, code: requisitions.code });
  if (withApplicant) {
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Asha", email: `asha-${Math.random()}@x.local` })
      .returning({ id: candidates.id });
    await db.insert(applications).values({ orgId, requisitionId: r!.id, candidateId: c!.id });
  }
  return r!;
}
const audits = (action: string, entityId: string) =>
  db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.orgId, orgId), eq(auditLog.action, action), eq(auditLog.entityId, entityId)),
    );

describe("what the dustbin may delete", () => {
  test("pure rule", () => {
    expect(desk.deletionFor({ requisitionId: null }, null)).toEqual({ kind: "chat" });
    const draft = { id: "r", code: "REQ-1", status: "draft", applications: 0 };
    expect(desk.deletionFor({ requisitionId: "r" }, draft)).toEqual({
      kind: "draft",
      requisitionId: "r",
      code: "REQ-1",
    });
    expect(desk.deletionFor({ requisitionId: "r" }, { ...draft, applications: 1 })).toBeNull();
    for (const status of [
      "pending_dh",
      "pending_hr",
      "pending_cbo",
      "approved",
      "on_hold",
      "closed",
    ])
      expect(desk.deletionFor({ requisitionId: "r" }, { ...draft, status })).toBeNull();
  });
});

describe("deleting a chat", () => {
  test("its starter deletes it: hidden at once, audited, restorable for 30 days", async () => {
    const c = await thread();
    expect(await desk.deletionAllowed(c, other)).toBeNull(); // someone else's chat
    expect(await desk.deletionAllowed(c, hr)).toEqual({ kind: "chat" }); // HR leadership may
    const now = new Date("2026-10-20T06:00:00Z");
    const out = await desk.deleteThread(c, creator, "", now);
    expect(out).toMatchObject({ kind: "chat", code: null });
    expect(out.restoreUntil).toBe("2026-11-19T06:00:00.000Z");
    await expect(desk.loadConversation(orgId, c.id)).rejects.toThrow(/not found/);
    expect((await desk.loadConversation(orgId, c.id, { includeDeleted: true })).deletedBy).toBe(
      creator,
    );
    const [a] = await audits("desk.thread_deleted", c.id);
    expect(a!.detail).toMatchObject({ title: "UI/UX Developer", messages: 2, stage: "chat" });
    await expect(desk.deleteThread(c, creator, "")).rejects.toThrow(/not found|already/);
  });

  test("another recruiter cannot delete someone else's chat", async () => {
    const c = await thread();
    await expect(desk.deleteThread(c, other, "tidy up")).rejects.toThrow(
      /Only the person who started this chat/,
    );
  });

  test("with an unused draft: HR head / CBO / owner only, with a reason; the draft goes and runs stop", async () => {
    const r = await requisition("draft");
    const c = await thread({ requisition: r.id });
    await expect(desk.deleteThread(c, creator, "not needed")).rejects.toThrow(/Only the person/);
    await expect(desk.deleteThread(c, hr, "")).rejects.toThrow(/Say why/);
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "requisition",
        principalUserId: creator,
        goal: "complete the draft",
        status: "running",
        conversationId: c.id,
      } as never)
      .returning({ id: agentRuns.id });
    const out = await desk.deleteThread(c, hr, "Budget not approved this quarter");
    expect(out).toMatchObject({ kind: "draft", code: r.code });
    expect(await db.select().from(requisitions).where(eq(requisitions.id, r.id))).toHaveLength(0);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)))[0]!.status).toBe(
      "cancelled",
    );
    expect(await audits("requisition.delete", r.id)).toHaveLength(1);
    const [a] = await audits("desk.thread_deleted", c.id);
    expect(a!.detail).toMatchObject({ stage: "draft", requisition: r.code, runsStopped: 1 });
  });

  test("nothing in approval, approved or with applicants can be deleted", async () => {
    const pending = await requisition("pending_hr");
    const c1 = await thread({ requisition: pending.id });
    await expect(desk.deleteThread(c1, owner, "x")).rejects.toThrow(/reject or close the role/);
    const used = await requisition("draft", true);
    const c2 = await thread({ requisition: used.id });
    await expect(desk.deleteThread(c2, owner, "x")).rejects.toThrow(/already has applications/);
    expect(await desk.deletionAllowed(c1, owner)).toBeNull();
  });
});

describe("restore and purge", () => {
  test("only an owner restores, within 30 days; a draft deleted with it is not brought back", async () => {
    const r = await requisition("draft");
    const c = await thread({ requisition: r.id });
    const deletedAt = new Date(Date.now() - 2 * 864e5);
    await desk.deleteThread(c, hr, "Raised by mistake", deletedAt);
    expect((await desk.deletedThreads(orgId)).map((t) => t.id)).toContain(c.id);
    await expect(desk.restoreThread(orgId, hr, c.id)).rejects.toThrow(/Only an owner/);
    await desk.restoreThread(orgId, owner, c.id);
    const back = await desk.loadConversation(orgId, c.id);
    expect(back).toMatchObject({ deletedAt: null, requisitionId: null, status: "gathering" });
    const last = (
      await db
        .select()
        .from(hiringMessages)
        .where(eq(hiringMessages.conversationId, c.id))
        .orderBy(hiringMessages.createdAt)
    ).at(-1)!;
    expect(last.body).toMatch(/draft requisition was deleted with it and is not brought back/);
    expect(await audits("desk.thread_restored", c.id)).toHaveLength(1);
  });

  test("after 30 days: no restore, and the sweep purges it (runs keep their record)", async () => {
    const c = await thread();
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "intake",
        principalUserId: creator,
        goal: "g",
        status: "done",
        conversationId: c.id,
      } as never)
      .returning({ id: agentRuns.id });
    await desk.deleteThread(c, creator, "", new Date(Date.now() - 31 * 864e5));
    await expect(desk.restoreThread(orgId, owner, c.id)).rejects.toThrow(/30 days/);
    const fresh = await thread();
    await desk.deleteThread(fresh, creator, "", new Date(Date.now() - 864e5));
    expect(await desk.purgeDeletedThreads()).toBeGreaterThanOrEqual(1);
    expect(
      await db.select().from(hiringConversations).where(eq(hiringConversations.id, c.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(hiringMessages).where(eq(hiringMessages.conversationId, c.id)),
    ).toHaveLength(0);
    const [kept] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(kept).toMatchObject({ conversationId: null, status: "done" });
    expect(await audits("desk.thread_purged", c.id)).toHaveLength(1);
    // The one deleted yesterday is still restorable.
    expect(
      await db.select().from(hiringConversations).where(eq(hiringConversations.id, fresh.id)),
    ).toHaveLength(1);
  });
});
