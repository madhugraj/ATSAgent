/**
 * Scorecards due 2 hours after a round: reminders, the HR head told, daily
 * escalation, and a quiet first look at old backlog.
 * Run: bun --env-file=.env.local test scripts/scorecard-chase.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { chaseStep, sweepScorecards } = await import("../src/lib/scorecard-chase.server");

describe("chase steps (pure)", () => {
  test("one step at a time as the clock runs, jumping when first seen late", () => {
    expect(chaseStep(-1, 0, Infinity)).toBe(0);
    expect(chaseStep(0.1, 0, Infinity)).toBe(1);
    expect(chaseStep(0.5, 1, 0.4)).toBe(1);
    expect(chaseStep(1.2, 1, 1.1)).toBe(2);
    expect(chaseStep(2.1, 2, 1)).toBe(3);
    expect(chaseStep(4.5, 3, 2)).toBe(4);
    expect(chaseStep(10, 4, 5)).toBe(4);
    expect(chaseStep(30, 4, 25)).toBe(5);
    expect(chaseStep(5, 0, Infinity)).toBe(4);
  });
});

const { db } = await import("../src/server/db");
const s = await import("../drizzle/schema");
const stamp = Date.now();
const lead = `chase-${stamp}@test.local`;
let orgId: string;
let appId: string;
let roundId: string;
const HOUR = 3600_000;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [o] = await db
    .insert(s.organizations)
    .values({ name: "Chase Org", slug: `chase-${stamp}`, status: "active" })
    .returning({ id: s.organizations.id });
  orgId = o!.id;
  const [r] = await db
    .insert(s.requisitions)
    .values({ orgId, code: `CH-${stamp}`, title: "AI Intern", status: "approved" } as never)
    .returning({ id: s.requisitions.id });
  const [c] = await db
    .insert(s.candidates)
    .values({ orgId, fullName: "Feedback Wait", email: `fw-${stamp}@cand.local` })
    .returning({ id: s.candidates.id });
  const [a] = await db
    .insert(s.applications)
    .values({ orgId, requisitionId: r!.id, candidateId: c!.id, stage: "l1" } as never)
    .returning({ id: s.applications.id });
  appId = a!.id;
  const [i] = await db
    .insert(s.interviews)
    .values({
      orgId,
      applicationId: appId,
      level: 1,
      interviewer: "Priya",
      interviewerEmail: lead,
      scheduledAt: new Date(Date.now() - 61 * 60_000),
      durationMins: 60,
      status: "scheduled",
    } as never)
    .returning({ id: s.interviews.id });
  roundId = i!.id;
});
afterAll(async () => {
  await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
});

const reminders = () =>
  db
    .select({ key: s.emailOutbox.idempotencyKey })
    .from(s.emailOutbox)
    .where(and(eq(s.emailOutbox.orgId, orgId), eq(s.emailOutbox.kind, "member_reminder")));
const step = async () =>
  (
    await db
      .select({ step: s.scorecardChases.step })
      .from(s.scorecardChases)
      .where(eq(s.scorecardChases.interviewId, roundId))
  )[0]?.step;
const endedAgo = (h: number) =>
  db
    .update(s.interviews)
    .set({ scheduledAt: new Date(Date.now() - h * HOUR - 60 * 60_000) })
    .where(eq(s.interviews.id, roundId));

describe("scorecard chase", () => {
  test("reminds, reminds again, then tells the HR head; stops once scored", async () => {
    await sweepScorecards(orgId);
    expect(await step()).toBe(1);
    expect(await reminders()).toHaveLength(1);
    await sweepScorecards(orgId);
    expect(await reminders()).toHaveLength(1);
    await endedAgo(1.2);
    await sweepScorecards(orgId);
    expect(await step()).toBe(2);
    expect(await reminders()).toHaveLength(2);
    await endedAgo(2.2);
    await sweepScorecards(orgId);
    expect(await step()).toBe(3);
    expect(await reminders()).toHaveLength(2);
    await db.insert(s.evaluations).values({
      orgId,
      applicationId: appId,
      level: 1,
      interviewId: roundId,
      evaluatorEmail: lead,
      recommendation: "select",
    } as never);
    await endedAgo(5);
    await sweepScorecards(orgId);
    expect(await step()).toBe(3);
  });
});
