/**
 * Interview time confirmations (migration 0085): a round a person books holds
 * the candidate's invite until the whole panel accepts, then asks the
 * candidate to confirm; a decline never reaches the candidate and tells the
 * team; offered times are e-mailed only after the panel agrees; a time the
 * candidate picked is not held. Against the local database.
 * Run: bun --env-file=.env.local test scripts/interview-confirmations.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, like } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  applications,
  candidates,
  emailOutbox,
  interviewConfirmations,
  interviewSlotOffers,
  interviews,
  orgMembers,
  organizations,
  requisitions,
  users,
} = await import("../drizzle/schema");
const conf = await import("../src/lib/interview-confirmations.server");
const { scheduleInterviewCore } = await import("../src/lib/interviews.functions");
const offers = await import("../src/lib/slot-offers.server");

const stamp = Date.now();
let orgId: string;
let userId: string;
let app: string;
const lead = `lead-${stamp}@test.local`;
const second = `second-${stamp}@test.local`;
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
  userId = u!.id;
  const [u2] = await db.insert(users).values({ email: second }).returning({ id: users.id });
  const [o] = await db
    .insert(organizations)
    .values({ name: "Confirm Org", slug: `confirm-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  await db.insert(orgMembers).values([
    { orgId, userId, email: lead, fullName: "Priya", status: "active", isOwner: true },
    { orgId, userId: u2!.id, email: second, fullName: "Ravi", status: "active" },
  ] as never);
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-C-${stamp}`,
      title: "AI Intern",
      status: "approved",
      createdBy: userId,
    })
    .returning({ id: requisitions.id });
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Vishal", email: `vishal-${stamp}@cand.local` })
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: r!.id, candidateId: c!.id, stage: "shortlisted" })
    .returning({ id: applications.id });
  app = a!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.email, lead));
  await db.delete(users).where(eq(users.email, second));
});

const invite = async (interviewId: string) =>
  db
    .select({ status: emailOutbox.status, data: emailOutbox.templateData })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.orgId, orgId),
        like(emailOutbox.idempotencyKey, `${conf.invitePrefix(interviewId)}%`),
      ),
    );
const rowsOf = (interviewId: string) =>
  db
    .select()
    .from(interviewConfirmations)
    .where(eq(interviewConfirmations.interviewId, interviewId));

describe("interview confirmations", () => {
  test("panelAgreed waits for every live panelist", () => {
    expect(conf.panelAgreed([])).toBe(true);
    expect(
      conf.panelAgreed([
        { party: "panelist", state: "accepted" },
        { party: "panelist", state: "pending" },
      ]),
    ).toBe(false);
    expect(
      conf.panelAgreed([
        { party: "panelist", state: "accepted" },
        { party: "panelist", state: "superseded" },
        { party: "candidate", state: "pending" },
      ]),
    ).toBe(true);
  });

  let roundId: string;
  test("a person's booking holds the invite until the whole panel accepts", async () => {
    const r = await scheduleInterviewCore(
      { orgId, actor: "Madhu" },
      {
        applicationId: app,
        level: 1,
        interviewer: "Priya",
        interviewerEmail: lead,
        scheduledAt: inDays(3).toISOString(),
        durationMins: 60,
        mode: "online",
        panel: [{ name: "Ravi", email: second }],
      },
    );
    roundId = r.interviewId!;
    const rows = await rowsOf(roundId);
    expect(rows.filter((x) => x.party === "panelist").map((x) => x.state)).toEqual([
      "pending",
      "pending",
    ]);
    expect(rows.find((x) => x.party === "candidate")?.state).toBe("pending");
    const [inv] = await invite(roundId);
    expect(inv?.status).toBe("held");
    expect(String(inv?.data["confirmUrl"])).toContain("/confirm/");

    const [p1, p2] = rows.filter((x) => x.party === "panelist");
    expect((await conf.answerConfirmation(p1!.token, true, null)).ok).toBe(true);
    expect((await invite(roundId))[0]?.status).toBe("held");
    expect((await conf.answerConfirmation(p1!.token, true, null)).ok).toBe(false);
    await conf.answerConfirmation(p2!.token, true, null);
    expect((await invite(roundId))[0]?.status).not.toBe("held");

    const cand = rows.find((x) => x.party === "candidate")!;
    const pub = await conf.publicConfirmation(cand.token);
    expect(pub?.candidateName).toBeNull();
    await conf.answerConfirmation(cand.token, true, null);
    const view = await conf.confirmationsFor(orgId, [roundId]);
    expect(view[roundId]).toMatchObject({ candidate: "accepted", inviteHeld: false });
  });

  test("a re-schedule supersedes old answers; a decline keeps the invite held", async () => {
    await scheduleInterviewCore(
      { orgId, actor: "Madhu" },
      {
        applicationId: app,
        level: 1,
        interviewId: roundId,
        rescheduleReason: "panel clash",
        interviewer: "Priya",
        interviewerEmail: lead,
        scheduledAt: inDays(4).toISOString(),
        durationMins: 60,
        mode: "online",
        panel: [{ name: "Ravi", email: second }],
      },
    );
    const live = (await rowsOf(roundId)).filter((x) => x.state !== "superseded");
    expect(live.every((x) => x.state === "pending")).toBe(true);
    const p = live.find((x) => x.email === second)!;
    await conf.answerConfirmation(p.token, false, "On leave");
    const [i] = await db.select().from(interviews).where(eq(interviews.id, roundId));
    expect(i!.unavailable.map((u) => u.email)).toContain(second);
    expect((await conf.confirmationsFor(orgId, [roundId]))[roundId]?.inviteHeld).toBe(true);
    // The team can still send it, on the record.
    expect(await conf.releaseInviteNow(orgId, roundId, { email: lead, userId })).toBe(1);
  });

  test("offered times reach the candidate only after the panel agrees", async () => {
    const at = [inDays(6, 9), inDays(7, 11)];
    const r = await offers.offerSlotsCore(
      orgId,
      { userId, runId: null },
      {
        applicationId: app,
        level: 1,
        interviewerEmail: lead,
        slots: at.map((d) => d.toISOString()),
        durationMins: 60,
        mode: "online",
      },
    );
    const linkOf = async () =>
      (
        await db
          .select({ at: interviewSlotOffers.linkEmailedAt })
          .from(interviewSlotOffers)
          .where(eq(interviewSlotOffers.id, r.offerId))
      )[0]!.at;
    expect(r.via).toBe("panel");
    expect(await linkOf()).toBeNull();
    const [row] = await db
      .select()
      .from(interviewConfirmations)
      .where(eq(interviewConfirmations.offerId, r.offerId));
    await conf.answerConfirmation(row!.token, true, null);
    // No phone screening in this org: no call, so the link is e-mailed now.
    expect(await linkOf()).not.toBeNull();

    // A decline on a fresh offer cancels it before the candidate hears.
    const r2 = await offers.offerSlotsCore(
      orgId,
      { userId, runId: null },
      {
        applicationId: app,
        level: 1,
        interviewerEmail: lead,
        slots: [inDays(8, 9), inDays(9, 11)].map((d) => d.toISOString()),
        durationMins: 60,
        mode: "online",
      },
    );
    const [row2] = await db
      .select()
      .from(interviewConfirmations)
      .where(eq(interviewConfirmations.offerId, r2.offerId));
    await conf.answerConfirmation(row2!.token, false, null);
    const [o] = await db
      .select()
      .from(interviewSlotOffers)
      .where(eq(interviewSlotOffers.id, r2.offerId));
    expect(o!.status).toBe("cancelled");
    expect(o!.linkEmailedAt).toBeNull();
  });
});
