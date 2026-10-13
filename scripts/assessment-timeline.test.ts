/**
 * Written-assessment timeline and agent pop-ups, against the disposable database:
 *  - due dates in working days (organisation time zone), closing never before due;
 *  - reminders: day 2 and the due day, at most 2, never twice in 20 h, never at weekends;
 *  - the sweep: reminders when the Screening agent may email on its own, a pop-up
 *    when it may not; overdue tells the thread once; links close;
 *  - one policy for the invitation, the link and the reminders;
 *  - submitting grades, refuses closed / waived links, tells the thread and starts
 *    the Screening agent; a person decides who moves on;
 *  - pop-up actions: give more time, remind, phone screen, decide without;
 *    snooze / dismiss; nudges only for people who can act.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/assessment-timeline.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";

// The AI question writer is the only stub: everything else runs for real.
mock.module("../src/lib/assessment.server.ts", () => ({
  generateQuestions: async () => [
    {
      id: "q1",
      dimension: "ownership",
      prompt: "Tell us about a product you owned.",
      looks_like: "x",
    },
  ],
  scoreAnswers: async () => {
    throw new Error("not used");
  },
}));

const { db } = await import("../src/server/db");
const {
  agentPolicies,
  agentRuns,
  applications,
  assessmentSettings,
  auditLog,
  candidateAssessments,
  candidates,
  emailOutbox,
  hiringConversations,
  hiringMessages,
  notificationStates,
  orgMembers,
  organizations,
  requisitions,
  stageEvents,
  userRoles,
  users,
} = await import("../drizzle/schema");
await import("../src/server/agents");
const tl = await import("../src/lib/assessment-timeline.server");
const { processAgentEvents } = await import("../src/server/agents/orchestrator.server");

const TZ = "Asia/Kolkata";
const stamp = Date.now();
let orgId: string;
let hr: string;
let viewer: string;
let role: string;
let appId: string;
let candId: string;
let convId: string;
const hrEmail = `ta-${stamp}@test.local`;
const asHr = () => ({ orgId, userId: hr, memberEmail: hrEmail });
const ist = (y: number, m: number, d: number, h = 10, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h - 5, min - 30)); // IST wall clock → instant

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const mk = async (email: string) =>
    (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
  hr = await mk(hrEmail);
  viewer = await mk(`viewer-${stamp}@test.local`);
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Timeline Org", slug: `timeline-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  for (const [u, email, roles] of [
    [hr, hrEmail, ["recruiter", "hr_head"]],
    [viewer, `viewer-${stamp}@test.local`, ["hiring_manager"]],
  ] as const) {
    await db.insert(orgMembers).values({
      orgId,
      userId: u,
      email,
      fullName: email,
      status: "active",
      isOwner: false,
    } as never);
    for (const r of roles)
      await db.insert(userRoles).values({ userId: u, orgId, role: r as never });
  }
  role = (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-A-${stamp}`,
        title: "AI Lead",
        status: "approved",
        createdBy: hr,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
  candId = (
    await db
      .insert(candidates)
      .values({ orgId, fullName: "Meera Iyer", email: `meera-${stamp}@cand.local` })
      .returning({ id: candidates.id })
  )[0]!.id;
  appId = (
    await db
      .insert(applications)
      .values({ orgId, requisitionId: role, candidateId: candId, stage: "shortlisted" })
      .returning({ id: applications.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, hr));
  await db.delete(users).where(eq(users.id, viewer));
});

beforeEach(async () => {
  for (const t of [
    candidateAssessments,
    emailOutbox,
    hiringConversations,
    agentRuns,
    agentPolicies,
    assessmentSettings,
  ])
    await db.delete(t).where(eq((t as typeof emailOutbox).orgId, orgId));
  await db.delete(notificationStates).where(eq(notificationStates.userId, hr));
  await db.update(applications).set({ stage: "shortlisted" }).where(eq(applications.id, appId));
  convId = (
    await db
      .insert(hiringConversations)
      .values({ orgId, createdBy: hr, requisitionId: role, status: "active" })
      .returning({ id: hiringConversations.id })
  )[0]!.id;
});

const lastMessage = async () =>
  (
    await db
      .select()
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, convId))
      .orderBy(hiringMessages.createdAt)
  ).at(-1)?.body ?? "";
async function autonomy(level: "suggest" | "autonomous") {
  await db
    .insert(agentPolicies)
    .values({ orgId, agentType: "screening", enabled: true, autonomy: level } as never)
    .onConflictDoUpdate({
      target: [agentPolicies.orgId, agentPolicies.agentType],
      set: { autonomy: level, enabled: true },
    });
}
/** An assessment sent at `sentAt` under the default policy. */
async function sent(sentAt: Date, extra: Record<string, unknown> = {}) {
  const t = tl.timelineFor(sentAt, tl.DEFAULT_ASSESSMENT_POLICY, TZ);
  const [a] = await db
    .insert(candidateAssessments)
    .values({
      orgId,
      candidateId: candId,
      requisitionId: role,
      applicationId: appId,
      token: `tok-${stamp}-${Math.random().toString(36).slice(2)}`,
      status: "sent",
      questions: [],
      createdAt: sentAt,
      dueAt: t.dueAt,
      closesAt: t.closesAt,
      ...extra,
    } as never)
    .returning();
  return a!;
}
const reload = async (id: string) =>
  (await db.select().from(candidateAssessments).where(eq(candidateAssessments.id, id)))[0]!;

/* ------------------------------------------------------------ pure */

describe("dates", () => {
  test("due at end of the n-th working day in the organisation's time zone", () => {
    // Mon 12 Oct 17:02 IST + 3 working days → Thu 15 Oct 23:59 IST
    expect(tl.dueAfterWorkingDays(ist(2026, 10, 12, 17, 2), 3, TZ).toISOString()).toBe(
      ist(2026, 10, 15, 23, 59).toISOString(),
    );
    // Fri 16 Oct + 3 → Wed 21 Oct (the weekend does not count)
    expect(tl.dueAfterWorkingDays(ist(2026, 10, 16), 3, TZ).toISOString()).toBe(
      ist(2026, 10, 21, 23, 59).toISOString(),
    );
    // The link never closes before the due date.
    const t = tl.timelineFor(
      ist(2026, 10, 16),
      { ...tl.DEFAULT_ASSESSMENT_POLICY, dueWorkingDays: 8, closeAfterDays: 7 },
      TZ,
    );
    expect(t.closesAt.getTime()).toBeGreaterThan(t.dueAt.getTime());
  });

  test("reminders: day 2 and the due day, at most 2, 20 h apart, working days only", () => {
    const P = tl.DEFAULT_ASSESSMENT_POLICY;
    const sentAt = ist(2026, 10, 12, 17); // Mon
    const t = tl.timelineFor(sentAt, P, TZ); // due Thu 15 23:59, closes Mon 19 17:00
    const s = { sentAt, ...t, remindersSent: 0, lastRemindedAt: null, overdueAt: null };
    expect(tl.nextStep(s, P, ist(2026, 10, 13, 10), TZ)).toBeNull(); // day 1
    expect(tl.nextStep(s, P, ist(2026, 10, 14, 18), TZ)).toBe("remind"); // day 2
    const after1 = { ...s, remindersSent: 1, lastRemindedAt: ist(2026, 10, 14, 18) };
    expect(tl.nextStep(after1, P, ist(2026, 10, 15, 9), TZ)).toBeNull(); // within 20 h
    expect(tl.nextStep(after1, P, ist(2026, 10, 15, 15), TZ)).toBe("remind"); // due day
    const after2 = { ...after1, remindersSent: 2, lastRemindedAt: ist(2026, 10, 15, 15) };
    expect(tl.nextStep(after2, P, ist(2026, 10, 16, 15), TZ)).toBeNull(); // max 2
    // Overdue two days after the due date… but here the link closes first (Mon 19 17:00).
    expect(tl.nextStep(after2, P, ist(2026, 10, 17, 23, 59), TZ)).toBe("overdue");
    expect(
      tl.nextStep({ ...after2, overdueAt: ist(2026, 10, 18) }, P, ist(2026, 10, 18, 12), TZ),
    ).toBeNull();
    expect(tl.nextStep(after2, P, ist(2026, 10, 19, 17, 1), TZ)).toBe("close");
    // Sent Thursday: day 2 is Saturday → the reminder waits for Monday.
    const thu = ist(2026, 10, 15, 11);
    const s2 = {
      sentAt: thu,
      ...tl.timelineFor(thu, P, TZ),
      remindersSent: 0,
      lastRemindedAt: null,
      overdueAt: null,
    };
    expect(tl.nextStep(s2, P, ist(2026, 10, 17, 12), TZ)).toBeNull(); // Sat
    expect(tl.nextStep(s2, P, ist(2026, 10, 19, 10), TZ)).toBe("remind"); // Mon
  });
});

/* ------------------------------------------------------------ issuing */

describe("one policy for invitation, link and reminders", () => {
  test("issuing uses the organisation's policy and links the application", async () => {
    await db.insert(assessmentSettings).values({ orgId, dueWorkingDays: 5, closeAfterDays: 10 });
    const { createAssessmentCore } = await import("../src/lib/assessment.functions");
    const a = await createAssessmentCore(orgId, {
      candidateId: candId,
      requisitionId: role,
      count: 6,
    });
    const row = await reload(a.id);
    expect(row.applicationId).toBe(appId);
    const expected = tl.timelineFor(
      row.createdAt,
      { ...tl.DEFAULT_ASSESSMENT_POLICY, dueWorkingDays: 5, closeAfterDays: 10 },
      TZ,
    );
    expect(row.dueAt!.toISOString()).toBe(expected.dueAt.toISOString());
    expect(row.closesAt!.toISOString()).toBe(expected.closesAt.toISOString());
  });
});

/* ------------------------------------------------------------ sweep */

describe("the sweep", () => {
  test("autonomous: a reminder is emailed with the due date, once", async () => {
    await autonomy("autonomous");
    const a = await sent(new Date(Date.now() - 2.2 * 864e5));
    const now = new Date();
    const { wd } = (await import("../src/lib/calendar-availability.server")).wallDate(
      now.getTime(),
      TZ,
    );
    const counts = await tl.runAssessmentSweep(orgId, now);
    if (wd === 0 || wd === 6) {
      expect(counts.reminded).toBe(0); // weekends wait
      return;
    }
    expect(counts.reminded).toBe(1);
    const mails = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.kind, "assessment_invite")));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.templateData).toMatchObject({
      reminder: "yes",
      dueDate: expect.stringContaining("end of day"),
    });
    expect((await reload(a.id)).remindersSent).toBe(1);
    expect((await tl.runAssessmentSweep(orgId, now)).reminded).toBe(0); // not twice
  });

  test("not autonomous: no email — the reminder waits in a pop-up for a person", async () => {
    await autonomy("suggest");
    await sent(new Date(Date.now() - 2.2 * 864e5));
    const now = new Date();
    const { wd } = (await import("../src/lib/calendar-availability.server")).wallDate(
      now.getTime(),
      TZ,
    );
    const counts = await tl.runAssessmentSweep(orgId, now);
    expect(counts.reminded).toBe(0);
    expect(await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId))).toHaveLength(0);
    if (wd === 0 || wd === 6) return;
    const { assessmentNudges } = await import("../src/lib/notifications.functions");
    const n = (await assessmentNudges(orgId)).find((x) => x.id.startsWith("assessment:remind:"));
    expect(n).toMatchObject({ popup: true, agent: "Screening agent" });
    expect(n!.actions!.map((x) => x.id)).toEqual(["remind", "extend"]);
  });

  test("overdue: the thread is told once and a pop-up offers extend / remind / phone / decide without", async () => {
    await autonomy("autonomous");
    const a = await sent(new Date(Date.now() - 6 * 864e5), {
      dueAt: new Date(Date.now() - 2.5 * 864e5),
      closesAt: new Date(Date.now() + 864e5),
      remindersSent: 2,
    });
    expect((await tl.runAssessmentSweep(orgId)).overdue).toBe(1);
    expect(await lastMessage()).toMatch(/Meera Iyer's written assessment is overdue/);
    expect((await tl.runAssessmentSweep(orgId)).overdue).toBe(0);
    const { assessmentNudges } = await import("../src/lib/notifications.functions");
    const n = (await assessmentNudges(orgId)).find((x) => x.id === `assessment:overdue:${a.id}`);
    expect(n!.actions!.map((x) => x.id)).toEqual([
      "extend",
      "remind",
      "phone_screen",
      "decide_without",
    ]);
  });

  test("the link closes when its time runs out; a closed link takes no answers", async () => {
    const a = await sent(new Date(Date.now() - 8 * 864e5), {
      dueAt: new Date(Date.now() - 5 * 864e5),
      closesAt: new Date(Date.now() - 60_000),
      overdueAt: new Date(Date.now() - 3 * 864e5),
    });
    expect((await tl.runAssessmentSweep(orgId)).closed).toBe(1);
    expect((await reload(a.id)).status).toBe("expired");
    expect(await lastMessage()).toMatch(/link has closed/);
    const { submitAssessmentCore } = await import("../src/lib/assessment.functions");
    await expect(
      submitAssessmentCore({ token: a.token, answers: [{ id: "q1", answer: "late" }] }),
    ).rejects.toThrow(/expired/);
  });
});

/* ------------------------------------------------------------ submit and decide */

describe("submitting", () => {
  const grade = async () =>
    ({
      mindset_score: 84,
      dimensions: {},
      strengths: ["ownership"],
      red_flags: [],
      summary: "Strong",
      model: "test",
    }) as never;

  test("grades, tells the thread, starts the Screening agent; a person then decides", async () => {
    await autonomy("autonomous");
    const a = await sent(new Date(Date.now() - 864e5));
    const { submitAssessmentCore } = await import("../src/lib/assessment.functions");
    await submitAssessmentCore(
      { token: a.token, answers: [{ id: "q1", answer: "I owned X" }] },
      grade,
    );
    const row = await reload(a.id);
    expect(row).toMatchObject({ status: "completed", mindsetScore: 84 });
    expect(await lastMessage()).toMatch(/Meera Iyer completed the written assessment \(84\/100\)/);
    await processAgentEvents({ orgId });
    const [run] = (await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId))).filter(
      (r) => r.agentType === "screening",
    );
    expect(run!.goal).toMatch(
      /completed the written assessment \(84\/100\)[\s\S]*a person decides/,
    );
    // Submitting twice is refused.
    await expect(
      submitAssessmentCore({ token: a.token, answers: [{ id: "q1", answer: "again" }] }, grade),
    ).rejects.toThrow(/already been submitted/);
    // The pop-up asks a person to decide; moving on records the basis.
    const { assessmentNudges } = await import("../src/lib/notifications.functions");
    const n = (await assessmentNudges(orgId)).find((x) => x.id === `assessment:review:${a.id}`);
    expect(n).toMatchObject({ severity: "urgent", popup: true });
    const { decideAfterAssessmentCore } = await import("../src/lib/nudges.functions");
    await expect(
      decideAfterAssessmentCore(asHr(), { applicationId: appId, decision: "reject", note: "" }),
    ).rejects.toThrow(/Say why/);
    await decideAfterAssessmentCore(asHr(), {
      applicationId: appId,
      decision: "move_l1",
      note: "Strong ownership",
    });
    const [app] = await db.select().from(applications).where(eq(applications.id, appId));
    expect(app!.stage).toBe("l1");
    const [ev] = await db
      .select()
      .from(stageEvents)
      .where(and(eq(stageEvents.applicationId, appId), eq(stageEvents.toStage, "l1")));
    expect(ev!.reason).toBe("Written assessment 84/100. Strong ownership");
    expect((await assessmentNudges(orgId)).some((x) => x.id === `assessment:review:${a.id}`)).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------ pop-up actions */

describe("pop-up actions", () => {
  test("give more time: new due date, overdue cleared, candidate told, audited", async () => {
    const a = await sent(new Date(Date.now() - 6 * 864e5), {
      dueAt: new Date(Date.now() - 2.5 * 864e5),
      closesAt: new Date(Date.now() + 864e5),
      overdueAt: new Date(),
      remindersSent: 2,
    });
    const d = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    await tl.extendAssessment(asHr(), { assessmentId: a.id, dueDate: d, notify: true });
    const row = await reload(a.id);
    expect(row.overdueAt).toBeNull();
    expect(row.remindersSent).toBe(1); // reset, then the "new date" email counts as one
    expect(row.closesAt!.getTime()).toBeGreaterThan(row.dueAt!.getTime());
    expect(await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId))).toHaveLength(1);
    expect(await lastMessage()).toMatch(/gave Meera Iyer until/);
    await expect(
      tl.extendAssessment(asHr(), { assessmentId: a.id, dueDate: "2020-01-01", notify: false }),
    ).rejects.toThrow(/future/);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "assessment.extended")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  test("phone screen instead: the link closes, the reason is recorded; then a decision is asked", async () => {
    const a = await sent(new Date(Date.now() - 864e5));
    await expect(
      tl.waiveAssessment(asHr(), { assessmentId: a.id, mode: "phone_screen", reason: "" }),
    ).rejects.toThrow(/Say why/);
    await tl.waiveAssessment(asHr(), {
      assessmentId: a.id,
      mode: "phone_screen",
      reason: "Prefers a call",
    });
    expect(await reload(a.id)).toMatchObject({
      status: "waived",
      waivedReason: "Screening by phone instead: Prefers a call",
    });
    expect(await lastMessage()).toMatch(/screening by phone instead for Meera Iyer/);
    const { submitAssessmentCore } = await import("../src/lib/assessment.functions");
    await expect(
      submitAssessmentCore({ token: a.token, answers: [{ id: "q1", answer: "x" }] }),
    ).rejects.toThrow(/expired/);
  });

  test("snooze and dismiss are per person; nudges only for people who can act", async () => {
    await sent(new Date(Date.now() - 864e5));
    const { setNotificationStateCore } = await import("../src/lib/nudges.functions");
    const id = (
      await (await import("../src/lib/notifications.functions")).assessmentNudges(orgId)
    )[0]!.id;
    await setNotificationStateCore(hr, { id, state: "snooze", hours: 4 });
    const [st] = await db
      .select()
      .from(notificationStates)
      .where(eq(notificationStates.userId, hr));
    expect(st!.snoozedUntil!.getTime()).toBeGreaterThan(Date.now() + 3.9 * 3600_000);
    await setNotificationStateCore(hr, { id, state: "dismiss", hours: 4 });
    const [st2] = await db
      .select()
      .from(notificationStates)
      .where(eq(notificationStates.userId, hr));
    expect(st2!.dismissedAt).not.toBeNull();
    // A hiring manager without TA/HR roles cannot act on assessments.
    const { decideAfterAssessmentCore } = await import("../src/lib/nudges.functions");
    await expect(
      decideAfterAssessmentCore(
        { orgId, userId: viewer, memberEmail: "v" },
        { applicationId: appId, decision: "hold", note: "Wait" },
      ),
    ).rejects.toThrow(/Only TA or HR/);
  });
});

describe("after the candidate has moved on", () => {
  test("a completed assessment does not start the Screening agent for someone past screening", async () => {
    await autonomy("autonomous");
    await db.update(applications).set({ stage: "l2" }).where(eq(applications.id, appId));
    const { emitAgentEvent } = await import("../src/server/agents/events");
    await emitAgentEvent({
      orgId,
      type: "assessment.completed",
      subjectType: "application",
      subjectId: appId,
      actorUserId: null,
      payload: { applicationId: appId, score: 80 },
    });
    await processAgentEvents({ orgId });
    const runs = (await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId))).filter(
      (r) => r.agentType === "screening",
    );
    expect(runs).toHaveLength(0);
  });
});
