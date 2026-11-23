/**
 * Offer actions move the candidate's stage through the pipeline, so every
 * offer stage lands in stage_events like any other move: raising an offer
 * (offer_pending), releasing it (offer_released) and accepting it
 * (offer_accepted, which is also captured as an outcome).
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/offer-stage-events.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  applications,
  candidates,
  orgMembers,
  organizations,
  requisitions,
  stageEvents,
  userRoles,
  users,
} = await import("../drizzle/schema");
const offersLib = await import("../src/lib/offers.functions");
const { recordOfferStageCore } = await import("../src/lib/pipeline.server");

const stamp = Date.now();
const email = `offer-stage-${stamp}@test.local`;
let orgId: string;
let userId: string;
let appId: string;
let actor: { orgId: string; userId: string; memberEmail: string };

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Offer Stage Org", slug: `offer-stage-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  await db
    .insert(orgMembers)
    .values({ orgId, userId, email, fullName: "Hema", status: "active", isOwner: true } as never);
  for (const r of ["recruiter", "hr_head", "president_cbo"])
    await db.insert(userRoles).values({ userId, orgId, role: r as never });
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-OS-${stamp}`,
      title: "Staff Engineer",
      status: "approved",
      createdBy: userId,
    } as never)
    .returning({ id: requisitions.id });
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Asha", email: `asha-${stamp}@cand.local` })
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: r!.id, candidateId: c!.id, stage: "l3" })
    .returning({ id: applications.id });
  appId = a!.id;
  actor = { orgId, userId, memberEmail: email };
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

const events = () =>
  db
    .select({ from: stageEvents.fromStage, to: stageEvents.toStage, actor: stageEvents.actor })
    .from(stageEvents)
    .where(and(eq(stageEvents.applicationId, appId), eq(stageEvents.orgId, orgId)))
    .orderBy(asc(stageEvents.createdAt));

describe("offer stages are recorded", () => {
  test("raising an offer moves to offer_pending with a stage event", async () => {
    await offersLib.createOfferCore(actor, { applicationId: appId, offeredCtc: "5000000" });
    const [app] = await db
      .select({ stage: applications.stage })
      .from(applications)
      .where(eq(applications.id, appId));
    expect(app!.stage).toBe("offer_pending");
    expect(await events()).toEqual([{ from: "l3", to: "offer_pending", actor: email }]);
  });

  test("release and accept are recorded once each; repeating a stage adds nothing", async () => {
    await recordOfferStageCore(actor, { applicationId: appId, toStage: "offer_released" });
    const again = await recordOfferStageCore(actor, {
      applicationId: appId,
      toStage: "offer_released",
    });
    expect(again?.unchanged).toBe(true);
    await recordOfferStageCore(actor, { applicationId: appId, toStage: "offer_accepted" });
    expect((await events()).map((e) => e.to)).toEqual([
      "offer_pending",
      "offer_released",
      "offer_accepted",
    ]);
  });

  test("another organisation's application is never touched", async () => {
    const res = await recordOfferStageCore(
      { ...actor, orgId: crypto.randomUUID() },
      { applicationId: appId, toStage: "offer_pending" },
    );
    expect(res).toBeNull();
    const [app] = await db
      .select({ stage: applications.stage })
      .from(applications)
      .where(eq(applications.id, appId));
    expect(app!.stage).toBe("offer_accepted");
  });
});
