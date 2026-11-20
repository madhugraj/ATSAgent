/**
 * Panel liberty under the hiring SLA (migration 0090): a panelist who accepted
 * can move the round once, only to a time the whole panel has free and no
 * later than the SLA allows, until 12 hours before; otherwise they step down
 * and a stand-in is proposed. A panelist's scorecard change keeps the role's
 * must-haves and the 10-point share limit, and applies only when the hiring
 * manager (or the owner, or the HR head after a wait) approves.
 * Run: bun --env-file=.env.local test scripts/panel-changes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  applications,
  candidates,
  interviewConfirmations,
  interviews,
  orgMembers,
  organizations,
  planChangeProposals,
  requisitions,
  users,
} = await import("../drizzle/schema");
const plan = await import("../src/lib/interview-plan");
const { latestRoundTime } = await import("../src/lib/lifecycle");
const pc = await import("../src/lib/panel-changes.server");
const { scheduleInterviewCore } = await import("../src/lib/interviews.functions");

const stamp = Date.now();
let orgId: string;
let ownerId: string;
let secondId: string;
let reqId: string;
let app: string;
const lead = `lead-pc-${stamp}@test.local`;
const second = `second-pc-${stamp}@test.local`;
const inDays = (d: number, h = 10) => {
  const t = new Date(Date.now() + d * 864e5);
  t.setUTCHours(h, 0, 0, 0);
  return t;
};

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db.insert(users).values({ email: lead }).returning({ id: users.id });
  ownerId = u!.id;
  const [u2] = await db.insert(users).values({ email: second }).returning({ id: users.id });
  secondId = u2!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Liberty Org", slug: `liberty-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  await db.insert(orgMembers).values([
    { orgId, userId: ownerId, email: lead, fullName: "Priya", status: "active", isOwner: true },
    { orgId, userId: secondId, email: second, fullName: "Ravi", status: "active" },
  ] as never);
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-PC-${stamp}`,
      title: "Platform SRE",
      status: "approved",
      createdBy: ownerId,
      mustHaveSkills: ["Go", "Kubernetes"],
    })
    .returning({ id: requisitions.id });
  reqId = r!.id;
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Vishal", email: `vishal-pc-${stamp}@cand.local` })
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "shortlisted" })
    .returning({ id: applications.id });
  app = a!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.email, lead));
  await db.delete(users).where(eq(users.email, second));
});

const tokenOf = async (interviewId: string, email: string) => {
  const rows = await db
    .select()
    .from(interviewConfirmations)
    .where(eq(interviewConfirmations.interviewId, interviewId));
  return rows.find((r) => r.email === email && r.state !== "superseded")!;
};
const accept = (token: string) =>
  db
    .update(interviewConfirmations)
    .set({ state: "accepted", respondedAt: new Date() })
    .where(eq(interviewConfirmations.token, token));

describe("the latest a round may move to", () => {
  test("the stage's SLA deadline, or the booking when that is later", () => {
    const applied = new Date("2026-11-20T00:00:00Z");
    const booked = new Date("2026-11-21T00:00:00Z");
    // L2 ends at 70% of a 5-day SLA: 3.5 days after applying.
    expect(latestRoundTime("l2", applied, booked).toISOString()).toBe("2026-11-23T12:00:00.000Z");
    const late = new Date("2026-11-25T00:00:00Z");
    expect(latestRoundTime("l2", applied, late)).toEqual(late);
  });
});

describe("changing a time after accepting", () => {
  let roundId: string;
  test("moves once, within the SLA, to a time the whole panel has free", async () => {
    const r = await scheduleInterviewCore(
      { orgId, actor: "Madhu" },
      {
        applicationId: app,
        level: 1,
        interviewer: "Priya",
        interviewerEmail: lead,
        scheduledAt: inDays(4).toISOString(),
        durationMins: 60,
        mode: "online",
        panel: [{ name: "Ravi", email: second }],
      },
    );
    roundId = r.interviewId!;
    const mine = await tokenOf(roundId, lead);
    // Not before accepting.
    expect((await pc.changeOptions(mine.token)).can).toBe(false);
    await accept(mine.token);
    await accept((await tokenOf(roundId, second)).token);

    const o = await pc.changeOptions(mine.token);
    if (!o.can) throw new Error(o.why);
    expect(o.times.length).toBeGreaterThan(0);
    for (const t of o.times) expect(Date.parse(t)).toBeLessThanOrEqual(Date.parse(o.latest));

    expect(await pc.changeTime(mine.token, { reason: "short", to: o.times[0]! })).toMatchObject({
      ok: false,
    });
    // A time outside the allowed list is refused.
    const tooLate = new Date(Date.parse(o.latest) + 864e5).toISOString();
    expect(
      await pc.changeTime(mine.token, { reason: "A customer escalation", to: tooLate }),
    ).toMatchObject({ ok: false });

    expect(
      await pc.changeTime(mine.token, { reason: "A customer escalation", to: o.times[0]! }),
    ).toEqual({ ok: true, moved: true });
    const [i] = await db.select().from(interviews).where(eq(interviews.id, roundId));
    expect(i!.scheduledAt!.toISOString()).toBe(new Date(o.times[0]!).toISOString());
    expect(i!.panelChanges).toHaveLength(1);
    // Their own new time counts as accepted; the rest of the panel is asked again.
    expect((await tokenOf(roundId, lead)).state).toBe("accepted");
    expect((await tokenOf(roundId, second)).state).toBe("pending");

    // Only once.
    const again = await pc.changeOptions((await tokenOf(roundId, lead)).token);
    expect(again).toEqual({ can: false, why: "You have already changed this round once." });
  });

  test("stepping down raises a stand-in and keeps the time", async () => {
    const theirs = await tokenOf(roundId, second);
    await accept(theirs.token);
    const [before] = await db.select().from(interviews).where(eq(interviews.id, roundId));
    expect(await pc.changeTime(theirs.token, { reason: "Out sick this week", to: null })).toEqual({
      ok: true,
      moved: false,
    });
    const [i] = await db.select().from(interviews).where(eq(interviews.id, roundId));
    expect(i!.scheduledAt).toEqual(before!.scheduledAt);
    expect(i!.unavailable.map((u) => u.email)).toContain(second);
  });

  test("inside 12 hours a panelist cannot move the round", async () => {
    const soon = new Date(Date.now() + 6 * 3600_000);
    const r = await scheduleInterviewCore(
      { orgId, actor: "Madhu" },
      {
        applicationId: app,
        level: 2,
        interviewer: "Priya",
        interviewerEmail: lead,
        scheduledAt: soon.toISOString(),
        durationMins: 60,
        mode: "online",
        panel: [],
      },
    ).catch(() => null);
    expect(r?.interviewId).toBeTruthy();
    if (!r?.interviewId) return;
    const mine = await tokenOf(r.interviewId, lead);
    await accept(mine.token);
    expect(await pc.changeOptions(mine.token)).toEqual({
      can: false,
      why: "The round is less than 12 hours away.",
    });
    // …but they can still step down: HR arranges a stand-in.
    expect(await pc.changeTime(mine.token, { reason: "Family emergency today", to: null })).toEqual(
      { ok: true, moved: false },
    );
  });
});

describe("scorecard change rules", () => {
  const before = plan.defaultPlan(["Go", "Kubernetes"]).rounds[0]!;
  test("must-haves stay", () => {
    expect(
      plan.panelChangeViolations(before, { competencies: ["Kubernetes", "Problem solving"] }, [
        "Go",
        "Kubernetes",
      ])[0],
    ).toContain('"Go" is a must-have');
  });
  test("no existing competency's share moves more than 10 points", () => {
    expect(
      plan.panelChangeViolations(
        before,
        { competencies: before.competencies, weights: { "Problem solving": 5 } },
        ["Go", "Kubernetes"],
      ).length,
    ).toBeGreaterThan(0);
    expect(
      plan.panelChangeViolations(
        before,
        { competencies: [...before.competencies, "System design"] },
        ["Go", "Kubernetes"],
      ),
    ).toEqual([]);
  });
  test("a percent split within 10 points of each share passes; 50 points does not", () => {
    // Three competencies at 33% each: 40/30/30 is within the limit.
    const [a, b, c] = before.competencies as [string, string, string];
    expect(
      plan.panelChangeViolations(
        before,
        { competencies: before.competencies, weights: { [a]: 40, [b]: 30, [c]: 30 } },
        ["Go", "Kubernetes"],
      ),
    ).toEqual([]);
    expect(
      plan.panelChangeViolations(
        before,
        { competencies: before.competencies, weights: { [a]: 50, [b]: 25, [c]: 25 } },
        ["Go", "Kubernetes"],
      ).length,
    ).toBeGreaterThan(0);
  });
  test("dropping a non-must-have spreads its share; that alone moves nothing", () => {
    const kept = before.competencies.filter((x) => x !== "Problem solving");
    expect(
      plan.panelChangeViolations(before, { competencies: kept }, ["Go", "Kubernetes"]),
    ).toEqual([]);
  });
  test("percents add up to 100", () => {
    const p = plan.percentSplit({ a: 1 / 3, b: 1 / 3, c: 1 / 3 });
    expect(Object.values(p).reduce((x, y) => x + y, 0)).toBe(100);
  });
  test("the HR head decides only after the wait", () => {
    const base = { isHiringManager: false, isHrHead: true, isOwner: false };
    expect(pc.mayDecide({ ...base, waitedHours: 1 })).toBe(false);
    expect(pc.mayDecide({ ...base, waitedHours: pc.PLAN_CHANGE.hrAfterHours })).toBe(true);
    expect(pc.mayDecide({ ...base, isHrHead: false, waitedHours: 99 })).toBe(false);
  });
});

describe("proposing a scorecard change", () => {
  test("a panelist proposes; nothing changes until the hiring manager approves", async () => {
    const r = await scheduleInterviewCore(
      { orgId, actor: "Madhu" },
      {
        applicationId: app,
        level: 1,
        interviewer: "Ravi",
        interviewerEmail: second,
        scheduledAt: inDays(6).toISOString(),
        durationMins: 60,
        mode: "online",
        panel: [],
      },
    );
    const t = (await tokenOf(r.interviewId!, second)).token;
    const view = await pc.publicRound(t);
    expect(view!.locked.sort()).toEqual(["Go", "Kubernetes"]);

    const bad = await pc.proposePlanChange(t, {
      focus: "x",
      competencies: ["Kubernetes"],
      weights: {},
      reason: "Go is not needed here",
    });
    expect(bad).toMatchObject({ ok: false });

    const good = await pc.proposePlanChange(t, {
      focus: "Depth in Go and Kubernetes, plus how they design for failure.",
      competencies: [...view!.round.competencies, "System design"],
      weights: {},
      reason: "We keep losing people on failure design in production.",
    });
    expect(good).toEqual({ ok: true });
    const [p] = await db
      .select()
      .from(planChangeProposals)
      .where(eq(planChangeProposals.requisitionId, reqId));
    expect(p!.status).toBe("awaiting_approval");
    // The plan is unchanged until someone decides.
    expect((await pc.publicRound(t))!.round.competencies).not.toContain("System design");

    // A panelist cannot approve their own change.
    expect(await pc.decideProposal(orgId, secondId, p!.id, true, null)).toMatchObject({
      ok: false,
    });
    expect(await pc.decideProposal(orgId, ownerId, p!.id, true, "Good call")).toEqual({
      ok: true,
    });
    expect((await pc.publicRound(t))!.round.competencies).toContain("System design");
    expect(await pc.decideProposal(orgId, ownerId, p!.id, true, null)).toMatchObject({
      ok: false,
    });
  });
});
