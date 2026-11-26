/**
 * A booked round nobody on the panel can make (src/lib/interview-reminders.server.ts):
 * the candidate is not reminded, whoever decides the stand-in is told the day
 * before, and an hour before the round is called off — the candidate is told
 * with an apology and the Interview coordinator offers new times. Also: Teams
 * meetings go to the panel as calendar invites (src/lib/meetings.server.ts).
 *
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/unstaffed-round.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const S = await import("../drizzle/schema");
const { sweepInterviewReminders, noInterviewer } =
  await import("../src/lib/interview-reminders.server");
const { teamsCalendarInvite } = await import("../src/lib/meetings.server");

const stamp = Date.now();
const SHALINI = `shalini-${stamp}@test.local`;
const HM = `hm-${stamp}@test.local`;
let orgId: string;
let hmId: string;
let reqId: string;

async function round(hoursAhead: number, name: string) {
  const [c] = await db
    .insert(S.candidates)
    .values({ orgId, fullName: name, email: `${name.toLowerCase()}-${stamp}@cand.local` } as never)
    .returning({ id: S.candidates.id });
  const [a] = await db
    .insert(S.applications)
    .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "l1" } as never)
    .returning({ id: S.applications.id });
  const [iv] = await db
    .insert(S.interviews)
    .values({
      orgId,
      applicationId: a!.id,
      level: 1,
      interviewer: "Shalini",
      interviewerEmail: SHALINI,
      scheduledAt: new Date(Date.now() + hoursAhead * 3600_000),
      status: "scheduled",
      unavailable: [{ email: SHALINI, note: null, at: new Date().toISOString() }],
      createdAt: new Date(Date.now() - 3 * 86_400_000),
    } as never)
    .returning({ id: S.interviews.id });
  return { applicationId: a!.id, interviewId: iv!.id };
}
const mail = async (applicationId: string) =>
  db
    .select({
      to: S.emailOutbox.toEmail,
      kind: S.emailOutbox.kind,
      data: S.emailOutbox.templateData,
    })
    .from(S.emailOutbox)
    .where(and(eq(S.emailOutbox.orgId, orgId), eq(S.emailOutbox.applicationId, applicationId)));

beforeAll(async () => {
  const [o] = await db
    .insert(S.organizations)
    .values({ name: "Unstaffed Org", slug: `us-${stamp}`, status: "active" })
    .returning({ id: S.organizations.id });
  orgId = o!.id;
  const [u] = await db.insert(S.users).values({ email: HM }).returning({ id: S.users.id });
  hmId = u!.id;
  await db.insert(S.userRoles).values({ userId: hmId, orgId, role: "hr_head" as never });
  const [req] = await db
    .insert(S.requisitions)
    .values({
      orgId,
      code: `US-${stamp}`,
      title: "AI Intern",
      status: "approved",
      createdBy: hmId,
    } as never)
    .returning({ id: S.requisitions.id });
  reqId = req!.id;
});
afterAll(async () => {
  await db.delete(S.organizations).where(eq(S.organizations.id, orgId));
  await db.delete(S.users).where(eq(S.users.id, hmId));
});

describe("a round with no interviewer", () => {
  test("nobody left on the panel (pure)", () => {
    const away = [{ email: "a@x.io" }];
    expect(noInterviewer({ lead: "A@x.io", panel: [], unavailable: away })).toBe(true);
    expect(noInterviewer({ lead: "a@x.io", panel: [{ email: "b@x.io" }], unavailable: away })).toBe(
      false,
    );
    expect(noInterviewer({ lead: "a@x.io", panel: null, unavailable: [] })).toBe(false);
  });

  test("the day before: no reminder to the candidate; the stand-in's decider is told", async () => {
    const x = await round(20, "Sweatha");
    const [run] = await db
      .insert(S.agentRuns)
      .values({ orgId, agentType: "interview", principalUserId: hmId, goal: "t" } as never)
      .returning({ id: S.agentRuns.id });
    await db.insert(S.agentTasks).values({
      orgId,
      runId: run!.id,
      kind: "gate",
      status: "open",
      title: "Stand-in for an L1 interview",
      assigneeUserId: hmId,
      proposedAction: {
        args: { subject: { type: "panel_substitute", applicationId: x.applicationId, level: 1 } },
      },
    } as never);
    await sweepInterviewReminders(orgId);
    await sweepInterviewReminders(orgId);
    const sent = await mail(x.applicationId);
    expect(sent.map((m) => [m.to, m.kind])).toEqual([[HM, "member_reminder"]]);
    expect((sent[0]!.data as Record<string, string>).heading).toContain("No interviewer");
    const [iv] = await db.select().from(S.interviews).where(eq(S.interviews.id, x.interviewId));
    expect(iv!.status).toBe("scheduled");
  });

  test("an hour before: called off, the candidate told with an apology, new times asked for", async () => {
    const x = await round(0.5, "Vishal");
    await sweepInterviewReminders(orgId);
    const [iv] = await db.select().from(S.interviews).where(eq(S.interviews.id, x.interviewId));
    expect(iv!.status).toBe("cancelled");
    const sent = await mail(x.applicationId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(`vishal-${stamp}@cand.local`);
    expect((sent[0]!.data as Record<string, string>).stageBody).toContain("We are sorry");
    const missed = await db
      .select()
      .from(S.agentEvents)
      .where(and(eq(S.agentEvents.orgId, orgId), eq(S.agentEvents.type, "interview.missed")));
    expect(missed.map((e) => e.subjectId)).toContain(x.applicationId);
  });
});

describe("Teams: the panel gets a calendar invite", () => {
  const req = {
    topic: "L3 interview: AI Intern",
    startIso: "2026-11-27T06:00:00Z",
    durationMins: 60,
    attendees: ["Saranya@yavar.ai", "saranya@yavar.ai"],
    agenda: null,
  };
  const realFetch = globalThis.fetch;
  const calls: { url: string; method: string; body: unknown }[] = [];
  const stub = (res: (url: string) => Response) => {
    calls.length = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return res(url);
    }) as typeof fetch;
  };
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("an event with the panel as attendees and a Teams link", async () => {
    stub(() =>
      Response.json({ id: "evt1", onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/x" } }),
    );
    const r = await teamsCalendarInvite("https://graph/me", {}, req);
    expect(r).toEqual({
      joinUrl: "https://teams.microsoft.com/l/x",
      externalId: "evt1",
      provider: "teams",
    });
    const body = calls[0]!.body as {
      attendees: { emailAddress: { address: string } }[];
      isOnlineMeeting: boolean;
    };
    expect(calls[0]!.url).toBe("https://graph/me/events");
    expect(body.attendees.map((a) => a.emailAddress.address)).toEqual(["saranya@yavar.ai"]);
    expect(body.isOnlineMeeting).toBe(true);
  });

  test("no calendar access, or no link: null (a bare meeting is made instead); a linkless invite is withdrawn", async () => {
    stub(() => new Response("forbidden", { status: 403 }));
    expect(await teamsCalendarInvite("https://graph/me", {}, req)).toBeNull();
    stub(() => Response.json({ id: "evt2" }));
    expect(await teamsCalendarInvite("https://graph/me", {}, req)).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    stub(() => Response.json({}));
    expect(await teamsCalendarInvite("https://graph/me", {}, { ...req, attendees: [] })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
