/**
 * The end-to-end hiring SLA: stage shares, at-risk and breached states, and the
 * desk told once per state. Run: bun --env-file=.env.local test scripts/hiring-sla.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { hiringSla, stalledDays } from "../src/lib/lifecycle";

const DAY = 864e5;
const now = Date.parse("2026-11-20T06:00:00Z");
const ago = (d: number) => new Date(now - d * DAY).toISOString();

describe("hiring SLA (pure)", () => {
  test("pace by stage over 5 days", () => {
    expect(hiringSla("applied", ago(0.5), 5, now)?.state).toBe("on_track");
    expect(hiringSla("applied", ago(1.5), 5, now)?.state).toBe("at_risk");
    expect(hiringSla("l2", ago(3), 5, now)?.state).toBe("on_track");
    expect(hiringSla("l2", ago(3.6), 5, now)?.state).toBe("at_risk");
    expect(hiringSla("offer_pending", ago(5.5), 5, now)).toMatchObject({
      state: "breached",
      elapsedDays: 5.5,
      daysLeft: -0.5,
    });
    expect(hiringSla("offer_released", ago(9), 5, now)).toBeNull();
    expect(hiringSla("rejected", ago(9), 5, now)).toBeNull();
  });
  test("a longer SLA stretches every stage", () => {
    expect(hiringSla("l2", ago(6), 10, now)?.state).toBe("on_track");
  });
  test("a stage is stalled past its share of the SLA, not a fixed week", () => {
    expect(stalledDays("l2", ago(0.5), 5, now)).toBeNull();
    expect(stalledDays("l2", ago(1.5), 5, now)).toBe(1);
    expect(stalledDays("offer_released", ago(3), 5, now)).toBeNull();
  });
});

const { db } = await import("../src/server/db");
const s = await import("../drizzle/schema");
const { sweepHiringSla } = await import("../src/server/hiring-sla.server");
const stamp = Date.now();
let orgId: string;
let appId: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [o] = await db
    .insert(s.organizations)
    .values({ name: "SLA Org", slug: `sla-${stamp}`, status: "active" })
    .returning({ id: s.organizations.id });
  orgId = o!.id;
  const [r] = await db
    .insert(s.requisitions)
    .values({ orgId, code: `SLA-${stamp}`, title: "AI Intern", status: "approved" } as never)
    .returning({ id: s.requisitions.id });
  const [c] = await db
    .insert(s.candidates)
    .values({ orgId, fullName: "Pace Test", email: `pace-${stamp}@cand.local` })
    .returning({ id: s.candidates.id });
  const [a] = await db
    .insert(s.applications)
    .values({
      orgId,
      requisitionId: r!.id,
      candidateId: c!.id,
      stage: "l1",
      appliedAt: new Date(Date.now() - 3 * DAY),
    } as never)
    .returning({ id: s.applications.id });
  appId = a!.id;
});
afterAll(async () => {
  await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
});

describe("hiring SLA sweep", () => {
  test("flags at risk once, then breached once", async () => {
    const flag = async () =>
      (
        await db
          .select({ f: s.applications.slaFlag })
          .from(s.applications)
          .where(eq(s.applications.id, appId))
      )[0]!.f;
    await sweepHiringSla(orgId);
    expect(await flag()).toBe("at_risk");
    await sweepHiringSla(orgId);
    expect(await flag()).toBe("at_risk");
    await db
      .update(s.applications)
      .set({ appliedAt: new Date(Date.now() - 5.5 * DAY) })
      .where(eq(s.applications.id, appId));
    await sweepHiringSla(orgId);
    expect(await flag()).toBe("breached");
  });
});
