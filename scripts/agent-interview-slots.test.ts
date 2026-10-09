/**
 * Interview scheduling (docs/agentic-plan.md §13.4): working-hour slots in the
 * organisation's time zone, free slots that avoid booked rounds and open
 * offers, the candidate choosing a time from a private link (booked once,
 * both invites), "none of these work", expiry, the interviewer's brief on any
 * booking, and the health rule — against the disposable database. No calendar
 * is connected for the test org, so availability falls back to ATSIQ's own
 * bookings and says so.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/agent-interview-slots.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentIssues,
  applications,
  candidates,
  emailOutbox,
  hiringConversations,
  hiringMessages,
  interviewSlotOffers,
  interviews,
  orgMembers,
  organizations,
  requisitions,
  users,
} = await import("../drizzle/schema");
const cal = await import("../src/lib/calendar-availability.server");
const offers = await import("../src/lib/slot-offers.server");

const stamp = Date.now();
const TZ = "UTC"; // the test org has no email settings row → default time zone
let orgId: string;
let userId: string;
let role: string;
let app: string;
const interviewer = `panel-${stamp}@test.local`;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db.insert(users).values({ email: interviewer }).returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Slots Org", slug: `slots-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId,
    email: interviewer,
    fullName: "Priya Natarajan",
    status: "active",
    isOwner: true,
  } as never);
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-I-${stamp}`,
      title: "UI/UX Engineer",
      status: "approved",
      createdBy: userId,
    })
    .returning({ id: requisitions.id });
  role = r!.id;
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Asha Raman", email: `asha-${stamp}@cand.local`, skills: ["Figma"] })
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: role, candidateId: c!.id, stage: "shortlisted" })
    .returning({ id: applications.id });
  app = a!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await db.delete(interviewSlotOffers).where(eq(interviewSlotOffers.orgId, orgId));
  await db.delete(interviews).where(eq(interviews.orgId, orgId));
  await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgId));
  await db.delete(hiringConversations).where(eq(hiringConversations.orgId, orgId));
  await db.delete(agentIssues).where(eq(agentIssues.orgId, orgId));
  await db.update(applications).set({ stage: "shortlisted" }).where(eq(applications.id, app));
});

const day = (n: number) => new Date(Date.now() + n * 864e5);
/** A weekday 11:00 UTC at least `n` days ahead. */
function weekdayAt(n: number, hour = 11) {
  const d = day(n);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}
async function thread() {
  const [c] = await db
    .insert(hiringConversations)
    .values({ orgId, createdBy: userId, requisitionId: role, status: "active" })
    .returning();
  return c!;
}
const lastDesk = async (id: string) =>
  (
    await db
      .select()
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, id))
      .orderBy(hiringMessages.createdAt)
  ).at(-1);

describe("time zones and working hours", () => {
  test("a wall-clock time in a zone maps to the right instant", () => {
    // 10:00 in Kolkata (UTC+5:30) is 04:30 UTC.
    expect(new Date(cal.zonedTime(2026, 9, 12, 10, 0, "Asia/Kolkata")).toISOString()).toBe(
      "2026-10-12T04:30:00.000Z",
    );
    // 10:00 in New York on 12 Oct 2026 (EDT, UTC-4) is 14:00 UTC.
    expect(new Date(cal.zonedTime(2026, 9, 12, 10, 0, "America/New_York")).toISOString()).toBe(
      "2026-10-12T14:00:00.000Z",
    );
  });

  test("slots: weekdays only, 10:00–17:00 local, ending by 17:00, at least 18 hours ahead", () => {
    // Friday 9 Oct 2026, 09:00 IST.
    const now = Date.parse("2026-10-09T03:30:00Z");
    const s = cal.workingSlots({ now, timeZone: "Asia/Kolkata", durationMins: 60, days: 4 });
    // Saturday and Sunday skipped: the first is Monday 12 Oct 10:00 IST.
    expect(new Date(s[0]!).toISOString()).toBe("2026-10-12T04:30:00.000Z");
    // 10:00, 10:30 … 16:00 → 13 starts on each weekday.
    expect(s.filter((x) => new Date(x).getUTCDate() === 12)).toHaveLength(13);
    expect(s.every((x) => x >= now + 18 * 3600_000)).toBe(true);
  });
});

describe("free slots", () => {
  test("avoid booked rounds and times offered to someone else; say the calendar was not checked", async () => {
    const r1 = await cal.findFreeSlots(orgId, {
      interviewerEmail: interviewer,
      durationMins: 60,
      count: 3,
      timeZone: TZ,
    });
    expect(r1.slots).toHaveLength(3);
    expect(r1.checkedWith).toBeNull();
    expect(r1.note).toMatch(/No Google or Microsoft calendar is connected/);
    // Spread over three different days.
    expect(new Set(r1.slots.map((s) => s.slice(0, 10))).size).toBe(3);
    // Book the first, offer the second: neither comes back.
    await db.insert(interviews).values({
      orgId,
      applicationId: app,
      level: 1,
      interviewerEmail: interviewer,
      scheduledAt: new Date(r1.slots[0]!),
      durationMins: 60,
    });
    await offers.offerSlotsCore(
      orgId,
      { userId, runId: null },
      {
        applicationId: app,
        level: 2,
        interviewerEmail: interviewer,
        slots: [r1.slots[1]!, r1.slots[2]!],
        durationMins: 60,
        mode: "online",
      },
    );
    const r2 = await cal.findFreeSlots(orgId, {
      interviewerEmail: interviewer,
      durationMins: 60,
      count: 5,
      timeZone: TZ,
    });
    for (const s of r1.slots) expect(r2.slots).not.toContain(s);
  });
});

describe("the candidate chooses the time", () => {
  async function offer() {
    const slots = [weekdayAt(3), weekdayAt(4, 14), weekdayAt(5)].map((d) => d.toISOString());
    const r = await offers.offerSlotsCore(
      orgId,
      { userId, runId: null },
      {
        applicationId: app,
        level: 1,
        interviewerEmail: interviewer,
        slots,
        durationMins: 60,
        mode: "online",
        agenda: "Design systems depth",
      },
    );
    const [row] = await db
      .select()
      .from(interviewSlotOffers)
      .where(eq(interviewSlotOffers.id, r.offerId));
    return { ...r, token: row!.token };
  }

  test("an offer emails the candidate a private link; a clashing time is refused", async () => {
    const o = await offer();
    expect(o.slots).toHaveLength(3);
    const [mail] = await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId));
    expect(mail).toMatchObject({ kind: "interview_slots" });
    expect((mail!.templateData as Record<string, string>)["chooseUrl"]).toMatch(
      new RegExp(`/schedule/${o.token}$`),
    );
    await db.insert(interviews).values({
      orgId,
      applicationId: app,
      level: 1,
      interviewerEmail: interviewer,
      scheduledAt: weekdayAt(8),
      durationMins: 60,
    });
    await expect(
      offers.offerSlotsCore(
        orgId,
        { userId, runId: null },
        {
          applicationId: app,
          level: 1,
          interviewerEmail: interviewer,
          slots: [weekdayAt(8).toISOString(), weekdayAt(8, 15).toISOString()],
          durationMins: 60,
          mode: "online",
        },
      ),
    ).rejects.toThrow(/not free: .*another interview is booked then/);
  });

  test("the public view shows the round and times, nothing about the candidate", async () => {
    const o = await offer();
    const p = (await offers.publicOffer(o.token))!;
    expect(p).toMatchObject({
      orgName: "Slots Org",
      jobTitle: "UI/UX Engineer",
      roundLabel: "L1 interview",
      interviewerName: "Priya",
      status: "offered",
    });
    expect(p.slots).toHaveLength(3);
    expect(JSON.stringify(p)).not.toMatch(/asha|Raman|@/i);
    expect(await offers.publicOffer("0".repeat(64))).toBeNull();
  });

  test("picking a time books it once, with invites to both and the thread told", async () => {
    const conv = await thread();
    const o = await offer();
    const r = await offers.chooseSlot(o.token, o.slots[1]!);
    expect(r).toEqual({ booked: true, at: o.slots[1] });
    const [iv] = await db.select().from(interviews).where(eq(interviews.applicationId, app));
    expect(iv).toMatchObject({
      level: 1,
      interviewerEmail: interviewer,
      agenda: "Design systems depth",
    });
    const [a] = await db.select().from(applications).where(eq(applications.id, app));
    expect(a!.stage).toBe("l1");
    const kinds = (await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId)))
      .map((m) => m.kind)
      .sort();
    expect(kinds).toEqual(["interview_invite", "interview_slots", "interviewer_brief"]);
    const brief = (
      await db.select().from(emailOutbox).where(eq(emailOutbox.kind, "interviewer_brief"))
    ).find((m) => m.orgId === orgId)!;
    expect(brief.toEmail).toBe(interviewer);
    expect((brief.templateData as Record<string, string>)["candidateName"]).toBe("Asha Raman");
    expect((brief.attachments as { filename: string }[])[0]!.filename).toMatch(/\.ics$/);
    expect((await lastDesk(conv.id))!.body).toMatch(/^Asha Raman chose .* It is booked/);
    expect(await offers.chooseSlot(o.token, o.slots[0]!)).toMatchObject({ booked: false });
  });

  test("none of these work: the candidate's words reach the thread; the offer closes", async () => {
    const conv = await thread();
    const o = await offer();
    expect(await offers.declineSlots(o.token, "  Evenings after 6 pm please  ")).toBe(true);
    const [row] = await db
      .select()
      .from(interviewSlotOffers)
      .where(eq(interviewSlotOffers.token, o.token));
    expect(row).toMatchObject({ status: "declined", candidateNote: "Evenings after 6 pm please" });
    expect((await lastDesk(conv.id))!.body).toMatch(
      /none of the offered times .*"Evenings after 6 pm please"/,
    );
    expect(await offers.chooseSlot(o.token, o.slots[0]!)).toMatchObject({ booked: false });
  });

  test("an unanswered offer expires and the thread hears about it", async () => {
    const conv = await thread();
    const o = await offer();
    await db
      .update(interviewSlotOffers)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(interviewSlotOffers.token, o.token));
    expect(await offers.expireOffers(orgId)).toBe(1);
    expect((await lastDesk(conv.id))!.body).toMatch(
      /did not choose a time .* before the link expired/,
    );
  });

  test("health: offers repeatedly not taken up are flagged", async () => {
    const { evaluateAgentHealth } = await import("../src/server/agents/health.server");
    for (let i = 0; i < 3; i++) {
      const o = await offer();
      await db
        .update(interviewSlotOffers)
        .set({ status: "expired" })
        .where(eq(interviewSlotOffers.token, o.token));
    }
    await evaluateAgentHealth({ orgId });
    const open = await db
      .select()
      .from(agentIssues)
      .where(and(eq(agentIssues.orgId, orgId), eq(agentIssues.rule, "interview.slots_unanswered")));
    expect(open).toHaveLength(1);
    expect(open[0]!.detail).toMatchObject({ closed: 3, missed: 3 });
  });
});

describe("the interviewer's brief", () => {
  test("a round booked on the Interviews page also briefs the interviewer", async () => {
    const { scheduleInterviewCore } = await import("../src/lib/interviews.functions");
    await scheduleInterviewCore(
      { orgId, actor: "test" },
      {
        applicationId: app,
        level: 1,
        interviewer: "Priya Natarajan",
        interviewerEmail: interviewer,
        scheduledAt: weekdayAt(6).toISOString(),
        durationMins: 45,
        mode: "onsite",
      },
    );
    const mails = await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId));
    const brief = mails.find((m) => m.kind === "interviewer_brief")!;
    expect(brief).toMatchObject({ toEmail: interviewer });
    expect(brief.templateData).toMatchObject({
      interviewerName: "Priya Natarajan",
      roundLabel: "L1 interview",
      modeLabel: "Onsite",
    });
    expect((brief.templateData as Record<string, string>)["scorecardUrl"]).toMatch(
      /\/interviews\/mine$/,
    );
  });
});
