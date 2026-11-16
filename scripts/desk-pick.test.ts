/**
 * Hiring-desk roles screen only whom the person picked, against the disposable
 * database:
 *  - an agent's shortlist (move_candidate, byAgent) on a desk role raises no
 *    application.shortlisted event and queues no "shortlisted" e-mail;
 *  - a person's shortlist on the same role still does (their pick decides);
 *  - on a role without a desk thread, an agent's shortlist still starts
 *    screening as before.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/desk-pick.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  applications,
  candidates,
  emailOutbox,
  hiringConversations,
  organizations,
  requisitions,
  users,
} = await import("../drizzle/schema");
const { recordStageTransition } = await import("../src/lib/stage-events.server");

const stamp = Date.now();
let orgId: string;
let userId: string;
let deskReq: string;
let plainReq: string;

async function app(reqId: string, n: string) {
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: `Cand ${n}`, email: `cand-${n}-${stamp}@example.com` } as never)
    .returning({ id: candidates.id });
  return (
    await db
      .insert(applications)
      .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "ai_screened" } as never)
      .returning({ id: applications.id })
  )[0]!.id;
}
const shortlistEvents = async (reqId: string) =>
  (
    await db
      .select({ id: agentEvents.id })
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.orgId, orgId),
          eq(agentEvents.type, "application.shortlisted"),
          eq(agentEvents.subjectId, reqId),
        ),
      )
  ).length;
const mailTo = async (applicationId: string) =>
  (
    await db
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.applicationId, applicationId)))
  ).length;

beforeAll(async () => {
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(process.env.DATABASE_URL!).hostname))
    throw new Error("Refusing non-local database");
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Desk Pick Org", slug: `dpick-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  userId = (
    await db
      .insert(users)
      .values({ email: `hr-${stamp}@dpick.test` })
      .returning({ id: users.id })
  )[0]!.id;
  const mk = async (code: string) =>
    (
      await db
        .insert(requisitions)
        .values({ orgId, code, title: "AI Intern", status: "approved", createdBy: userId } as never)
        .returning({ id: requisitions.id })
    )[0]!.id;
  deskReq = await mk(`REQ-D-${stamp}`);
  plainReq = await mk(`REQ-P-${stamp}`);
  await db
    .insert(hiringConversations)
    .values({ orgId, createdBy: userId, requisitionId: deskReq, kind: "hiring" } as never);
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("a hiring-desk role screens only the person's pick", () => {
  test("an agent's shortlist starts nothing and e-mails nobody", async () => {
    const a = await app(deskReq, "a");
    await recordStageTransition({
      orgId,
      applicationId: a,
      fromStage: "ai_screened",
      toStage: "shortlisted",
      actor: "agent",
      byAgent: true,
    });
    expect(await shortlistEvents(deskReq)).toBe(0);
    expect(await mailTo(a)).toBe(0);
  });

  test("an automatic (scorer) shortlist on a desk role starts nothing", async () => {
    const a = await app(deskReq, "s");
    await recordStageTransition({
      orgId,
      applicationId: a,
      fromStage: "applied",
      toStage: "shortlisted",
      actor: "auto",
      source: "ai",
    });
    expect(await shortlistEvents(deskReq)).toBe(0);
  });

  test("a person's shortlist on the same role does", async () => {
    const b = await app(deskReq, "b");
    await recordStageTransition({
      orgId,
      applicationId: b,
      fromStage: "ai_screened",
      toStage: "shortlisted",
      actor: "hr",
    });
    expect(await shortlistEvents(deskReq)).toBe(1);
  });

  test("a role without a desk thread keeps the automatic start", async () => {
    const c = await app(plainReq, "c");
    await recordStageTransition({
      orgId,
      applicationId: c,
      fromStage: "ai_screened",
      toStage: "shortlisted",
      actor: "agent",
      byAgent: true,
    });
    expect(await shortlistEvents(plainReq)).toBe(1);
  });
});
