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
    // The Interview coordinator is told, as with "Can't make it".
    const { agentEvents } = await import("../drizzle/schema");
    const ev = await db
      .select({ type: agentEvents.type, payload: agentEvents.payload })
      .from(agentEvents)
      .where(
        and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "interview.panellist_unavailable")),
      );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ interviewId: roundId, level: 1, note: "On leave" });
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

  test("workable and common times", () => {
    const t = ["2026-12-01T05:00:00.000Z", "2026-12-02T05:00:00.000Z"];
    expect(conf.workableTimes(t, { accept: true })).toEqual(t);
    expect(conf.workableTimes(t, { accept: true, okSlots: [t[1]!] })).toEqual([t[1]]);
    expect(conf.workableTimes(t, { accept: false })).toEqual([]);
    expect(
      conf.commonTimes(t, [
        { party: "panelist", state: "accepted", okSlots: null },
        { party: "panelist", state: "accepted", okSlots: [t[1]!] },
        { party: "candidate", state: "pending", okSlots: null },
      ]),
    ).toEqual([t[1]]);
    expect(
      conf.commonTimes(t, [
        { party: "panelist", state: "accepted", okSlots: [t[0]!] },
        { party: "panelist", state: "declined", okSlots: [] },
      ]),
    ).toEqual([]);
  });

  const offerTwo = (days: number[]) =>
    offers.offerSlotsCore(
      orgId,
      { userId, runId: null },
      {
        applicationId: app,
        level: 1,
        interviewerEmail: lead,
        panelEmails: [second],
        slots: days.map((d) => inDays(d, 9).toISOString()),
        durationMins: 60,
        mode: "online",
      },
    );
  const tokensOf = async (offerId: string) =>
    Object.fromEntries(
      (
        await db
          .select({ email: interviewConfirmations.email, token: interviewConfirmations.token })
          .from(interviewConfirmations)
          .where(eq(interviewConfirmations.offerId, offerId))
      ).map((r) => [r.email, r.token]),
    );

  test("the candidate is offered only the times the whole panel can do", async () => {
    const r = await offerTwo([11, 12, 13]);
    const tok = await tokensOf(r.offerId);
    await conf.answerConfirmation(tok[lead]!, {
      accept: true,
      okSlots: [r.slots[0]!, r.slots[1]!],
    });
    // Still waiting for the second panelist: nobody contacted.
    const [o1] = await db
      .select()
      .from(interviewSlotOffers)
      .where(eq(interviewSlotOffers.id, r.offerId));
    expect(o1!.linkEmailedAt).toBeNull();
    await conf.answerConfirmation(tok[second]!, {
      accept: true,
      okSlots: [r.slots[1]!, r.slots[2]!],
    });
    const [o2] = await db
      .select()
      .from(interviewSlotOffers)
      .where(eq(interviewSlotOffers.id, r.offerId));
    expect(o2!.slots.map((x) => Date.parse(x))).toEqual([Date.parse(r.slots[1]!)]);
    expect(o2!.linkEmailedAt).not.toBeNull();
  });

  test("no time in common: the offer stops and the coordinator gets the suggestions", async () => {
    const r = await offerTwo([15, 16]);
    const tok = await tokensOf(r.offerId);
    const sugg = inDays(17, 11).toISOString();
    await conf.answerConfirmation(tok[lead]!, { accept: true, okSlots: [r.slots[0]!] });
    await conf.answerConfirmation(tok[second]!, {
      accept: true,
      okSlots: [r.slots[1]!],
      suggestedAt: sugg,
    });
    const [o] = await db
      .select()
      .from(interviewSlotOffers)
      .where(eq(interviewSlotOffers.id, r.offerId));
    expect(o!.status).toBe("cancelled");
    expect(o!.linkEmailedAt).toBeNull();
    const { agentEvents } = await import("../drizzle/schema");
    const evs = await db
      .select({ payload: agentEvents.payload })
      .from(agentEvents)
      .where(
        and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "interview.panel_times_rejected")),
      );
    const ev = evs.find((e) => (e.payload as { offerId?: string }).offerId === r.offerId);
    expect(ev?.payload).toMatchObject({
      offerId: r.offerId,
      suggested: [{ email: second, at: sugg }],
    });
  });

  test("a booked round moves to a panelist's suggested time while the candidate has not been told", async () => {
    const r = await scheduleInterviewCore(
      { orgId, actor: "Madhu" },
      {
        applicationId: app,
        level: 2,
        interviewer: "Priya",
        interviewerEmail: lead,
        scheduledAt: inDays(20, 7).toISOString(),
        durationMins: 60,
        mode: "online",
        panel: [{ name: "Ravi", email: second }],
      },
    );
    const id = r.interviewId!;
    const rows = await rowsOf(id);
    const ravi = rows.find((x) => x.email === second)!;
    const half = new Date(inDays(20, 7).getTime() + 30 * 60_000);
    await conf.answerConfirmation(ravi.token, {
      accept: false,
      note: "13.30 is okay",
      suggestedAt: half.toISOString(),
    });
    const [i] = await db.select().from(interviews).where(eq(interviews.id, id));
    expect(i!.scheduledAt!.getTime()).toBe(half.getTime());
    expect(i!.unavailable).toEqual([]);
    const live = (await rowsOf(id)).filter((x) => x.state !== "superseded");
    expect(live.find((x) => x.email === second)?.state).toBe("accepted");
    expect(live.find((x) => x.email === lead)?.state).toBe("pending");
    expect((await conf.confirmationsFor(orgId, [id]))[id]?.inviteHeld).toBe(true);
  });

  test("going back to an earlier time sends a fresh invite once the panel accepts", async () => {
    const at = inDays(25, 7);
    const book = (when: Date) =>
      scheduleInterviewCore(
        { orgId, actor: "Madhu" },
        {
          applicationId: app,
          level: 3,
          interviewer: "Priya",
          interviewerEmail: lead,
          scheduledAt: when.toISOString(),
          durationMins: 60,
          mode: "online",
          ...(id ? { interviewId: id, rescheduleReason: "test" } : {}),
        },
      );
    let id: string | undefined;
    id = (await book(at)).interviewId!;
    await book(inDays(26, 7));
    await book(at);
    const live = (await rowsOf(id)).filter((x) => x.state !== "superseded");
    expect(live.filter((x) => x.party === "candidate")).toHaveLength(1);
    const held = (await invite(id)).filter((m) => m.status === "held");
    expect(held).toHaveLength(1);
    // The panelist is asked again for that time, with a new brief.
    const briefs = await db
      .select({ key: emailOutbox.idempotencyKey })
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.kind, "interviewer_brief"),
          like(emailOutbox.idempotencyKey, `interviewer-brief:${id}:${lead}:${at.toISOString()}%`),
        ),
      );
    expect(briefs).toHaveLength(2);
    // The same time again while they have not answered: no duplicate brief.
    await book(at);
    const again = await db
      .select({ key: emailOutbox.idempotencyKey })
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.kind, "interviewer_brief"),
          like(emailOutbox.idempotencyKey, `interviewer-brief:${id}:${lead}:${at.toISOString()}%`),
        ),
      );
    expect(again).toHaveLength(2);
    expect((await invite(id)).filter((m) => m.status === "held")).toHaveLength(1);
  });

  test("a silent panelist is reminded, then the offer goes ahead with the rest of the panel", async () => {
    const r = await offerTwo([30, 31]);
    const tok = await tokensOf(r.offerId);
    await conf.answerConfirmation(tok[lead]!, { accept: true, okSlots: [r.slots[1]!] });
    const back = (h: number) =>
      db
        .update(interviewConfirmations)
        .set({ createdAt: new Date(Date.now() - h * 3600_000) })
        .where(
          and(
            eq(interviewConfirmations.offerId, r.offerId),
            eq(interviewConfirmations.email, second),
          ),
        );
    const reminders = () =>
      db
        .select({ to: emailOutbox.toEmail })
        .from(emailOutbox)
        .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.kind, "panel_reminder")));
    await back(2.5);
    await conf.sweepPanelAnswers(orgId);
    expect((await reminders()).map((m) => m.to)).toEqual([second]);
    await conf.sweepPanelAnswers(orgId);
    expect(await reminders()).toHaveLength(1);
    // The window closes; no calendar is connected, so the panelist lapses and the
    // candidate is offered the time the rest of the panel agreed.
    await back(4.5);
    await conf.sweepPanelAnswers(orgId);
    const [row] = await db
      .select({ state: interviewConfirmations.state })
      .from(interviewConfirmations)
      .where(
        and(
          eq(interviewConfirmations.offerId, r.offerId),
          eq(interviewConfirmations.email, second),
        ),
      );
    expect(row!.state).toBe("lapsed");
    const [o] = await db
      .select()
      .from(interviewSlotOffers)
      .where(eq(interviewSlotOffers.id, r.offerId));
    expect(o!.slots.map((x) => Date.parse(x))).toEqual([Date.parse(r.slots[1]!)]);
    expect(o!.linkEmailedAt).not.toBeNull();
  });

  test("a silent panelist on a booked round: a stand-in is asked for, the invite stays held", async () => {
    const r = await scheduleInterviewCore(
      { orgId, actor: "Madhu" },
      {
        applicationId: app,
        level: 1,
        interviewer: "Priya",
        interviewerEmail: lead,
        scheduledAt: inDays(33, 7).toISOString(),
        durationMins: 60,
        mode: "online",
      },
    );
    const id = r.interviewId!;
    await db
      .update(interviewConfirmations)
      .set({ createdAt: new Date(Date.now() - 5 * 3600_000) })
      .where(
        and(
          eq(interviewConfirmations.interviewId, id),
          eq(interviewConfirmations.party, "panelist"),
        ),
      );
    await conf.sweepPanelAnswers(orgId);
    const { agentEvents } = await import("../drizzle/schema");
    const evs = await db
      .select({ payload: agentEvents.payload })
      .from(agentEvents)
      .where(
        and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "interview.panellist_unavailable")),
      );
    expect(evs.some((e) => (e.payload as { interviewId?: string }).interviewId === id)).toBe(true);
    expect((await conf.confirmationsFor(orgId, [id]))[id]?.inviteHeld).toBe(true);
    // Once handled, the sweep leaves it alone.
    const before = evs.length;
    await conf.sweepPanelAnswers(orgId);
    const after = await db
      .select({ id: agentEvents.id })
      .from(agentEvents)
      .where(
        and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "interview.panellist_unavailable")),
      );
    expect(after).toHaveLength(before);
  });
});
