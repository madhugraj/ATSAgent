/**
 * Behaviour lockdown for the "interviews" domain (Phase 5/6 L3: regex
 * ^src/server/panel/|^src/lib/(interview|panel|slot-offers|vtt|assessment|
 * scorecard-chase|panel-changes)) so any behaviour change when it moves into an
 * @ats/* package fails a test. Covers the cores the existing per-feature
 * suites leave open:
 *  - interviews.functions.ts: scheduleInterviewCore (books the round, parks
 *    the application on the round's stage, writes the stage event, queues the
 *    invite; cross-org application, unknown panelist, bad time, reschedule
 *    without a reason all refuse), submitScorecardCore (one final scorecard
 *    per interviewer per round, rubric-checked competencies, round completion
 *    moves the candidate under the plan, the next round is queued, an
 *    off-panel member without the HR role is refused, an interviewer-only role
 *    cannot open the offer pipeline, an external panelist's final-round select
 *    stays with the hiring manager, cross-org application is invisible),
 *    markInterviewOutcomeCore (a no-show is recorded and audited by the hiring
 *    team; a non-panel member without a hiring role is refused; completed
 *    rounds cannot be marked; cross-org invisible) and interviewerUnavailableCore
 *    (before it starts, once; not-on-panel and already-started refuse);
 *  - progressionFor / nextStageFor (pure): the plan's verdict → stage table;
 *  - panel access gaps left by panel-access.test.ts: submitByLink (one scorecard
 *    per link, audited, the link reads "submitted" after), the "not_yet" state,
 *    invalid tokens open nothing, and linkPanelist never crosses organisations;
 *  - slot offers (public-token scoping gaps agent-interview-slots.test.ts does
 *    not lock): an unknown token opens and books nothing, an expired offer is
 *    shown expired and refuses to book, a booked offer cannot be declined, a
 *    time outside the offer refuses, and an offer is not reachable through
 *    another org's id;
 *  - assessment.server.ts: the vendor-neutral refusal when the organisation has
 *    no AI key (no provider names in the message) — real-AI paths are not
 *    testable here;
 *  - scorecard-chase.server.ts: missingScorecards is org-scoped (another org's
 *    rounds are invisible), honours the empty list and drops panelists who said
 *    they cannot make it.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/interviews-domain.test.ts
 */
// bun test does not load .env.local — pick up the secrets the server env
// schema demands before any module graph loads, so the documented run line
// needs only DATABASE_URL and SESSION_SECRET (what CI exports).
import { readFileSync } from "node:fs";
try {
  const dotEnv = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of dotEnv.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !m[1]!.startsWith("DATABASE_URL") && process.env[m[1]!] === undefined)
      process.env[m[1]!] = m[2]!;
  }
} catch {
  // no .env.local — the caller must have exported everything.
}
process.env["SECRET_ENCRYPTION_KEY"] ??= Buffer.alloc(32, 7).toString("base64");

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  applications,
  auditLog,
  candidates,
  emailOutbox,
  evaluations,
  interviewSlotOffers,
  interviews,
  orgMembers,
  organizations,
  panelistScorecardLinks,
  panelists,
  requisitions,
  stageEvents,
  userRoles,
  users,
} = await import("../drizzle/schema");
const iv = await import("../src/lib/interviews.functions");
const chase = await import("../src/lib/scorecard-chase.server");
const slotOffers = await import("../src/lib/slot-offers.server");
const links = await import("../src/lib/panelist-links.server");
const mindset = await import("../src/lib/assessment.server");

const stamp = Date.now();
const dom = `ivd${stamp}.test`;
const HOUR = 3600_000;
let orgA: string;
let orgB: string;
let ownerId: string;
let interAId: string;
let panelA2Id: string;
let recruiterAId: string;
let panelOnlyId: string;
let ownerBId: string;
const interA = `interviewer-${stamp}@${dom}`;
const panelA2 = `panel2-${stamp}@${dom}`;
const recruiterA = `recruiter-${stamp}@${dom}`;
const panelOnly = `ponly-${stamp}@${dom}`;
const extEmail = `external-${stamp}@client.example`;
const candEmail = `cand1-${stamp}@${dom}`;
let reqA: string;
let reqImm: string;
let reqB: string;
let appA1: string;
let appA3: string;
let appA4: string;
let appB1: string;
let roundA1: string; // booked L1 on appA1 (created by scheduleInterviewCore)
let roundA3: string; // completed L3 on appA3 (external + lead)
let roundFuture3: string; // a future L3 on appA3 — scorecards closed
let roundImm: string; // L1 of the "immediate" plan on appA4
let roundOutcome: string; // L2 on appA1 for outcome marking
let roundUnavail: string; // L2 on appA1 for the can't-make-it flow
let roundPast: string; // a past, still-"scheduled" round on appA1
let roundLink: string; // L2 on appA1, external panelist only
let roundNotYet: string; // future L3 on appA3, external panelist only
let roundB: string; // org B's own round
let extPanelistId: string;
let bPanelistId: string;

async function mkUser(email: string) {
  return (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
}
async function mkMember(
  userId: string,
  email: string,
  orgId: string,
  isOwner = false,
  fullName?: string,
) {
  await db.insert(orgMembers).values({
    orgId,
    userId,
    email,
    fullName: fullName ?? email.split("@")[0]!,
    status: "active",
    isOwner,
  } as never);
}
async function mkRole(userId: string, orgId: string, role: string) {
  await db.insert(userRoles).values({ userId, orgId, role } as never);
}
/** A booked round (status scheduled) at the given time. */
async function mkRound(
  orgId: string,
  applicationId: string,
  level: number,
  scheduledAt: Date,
  lead: string | null,
  panel: { name: string | null; email: string }[] = [],
  extra: Record<string, unknown> = {},
) {
  return (
    await db
      .insert(interviews)
      .values({
        orgId,
        applicationId,
        level,
        interviewerEmail: lead,
        panel,
        scheduledAt,
        status: "scheduled",
        durationMins: 60,
        ...extra,
      } as never)
      .returning({ id: interviews.id })
  )[0]!.id;
}
const stageOf = async (appId: string) =>
  (
    await db
      .select({ stage: applications.stage })
      .from(applications)
      .where(eq(applications.id, appId))
  )[0]!.stage;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgA = (
    await db
      .insert(organizations)
      .values({ name: "Interviews Org A", slug: `ivda-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  orgB = (
    await db
      .insert(organizations)
      .values({ name: "Interviews Org B", slug: `ivdb-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;

  ownerId = await mkUser(`owner-${stamp}@${dom}`);
  interAId = await mkUser(interA);
  panelA2Id = await mkUser(panelA2);
  recruiterAId = await mkUser(recruiterA);
  panelOnlyId = await mkUser(panelOnly);
  ownerBId = await mkUser(`owner-b-${stamp}@${dom}`);
  await mkMember(ownerId, `owner-${stamp}@${dom}`, orgA, true);
  await mkMember(interAId, interA, orgA);
  await mkMember(panelA2Id, panelA2, orgA, false, "Panel Two");
  await mkMember(recruiterAId, recruiterA, orgA);
  await mkMember(panelOnlyId, panelOnly, orgA);
  await mkMember(ownerBId, `owner-b-${stamp}@${dom}`, orgB, true);
  await mkRole(interAId, orgA, "interviewer");
  await mkRole(panelA2Id, orgA, "interviewer");
  await mkRole(recruiterAId, orgA, "recruiter");
  await mkRole(panelOnlyId, orgA, "interviewer");

  reqA = (
    await db
      .insert(requisitions)
      .values({
        orgId: orgA,
        code: `REQ-IV-${stamp}`,
        title: "Platform Engineer",
        status: "approved",
        mustHaveSkills: ["LLMs", "System design"],
        createdBy: ownerId,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
  // A one-round plan under the "immediate" policy: the round's own verdict
  // would move the candidate into the offer pipeline.
  reqImm = (
    await db
      .insert(requisitions)
      .values({
        orgId: orgA,
        code: `REQ-IMM-${stamp}`,
        title: "Field Lead",
        status: "approved",
        mustHaveSkills: ["Craft"],
        createdBy: ownerId,
        interviewPlan: {
          verdictPolicy: "immediate",
          rounds: [
            {
              level: 1,
              name: "Craft",
              focus: "Depth of craft.",
              competencies: ["Craft"],
              panelSize: 1,
            },
          ],
        },
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
  reqB = (
    await db
      .insert(requisitions)
      .values({
        orgId: orgB,
        code: `REQ-B-${stamp}`,
        title: "Analyst",
        status: "approved",
        mustHaveSkills: ["SQL"],
        createdBy: ownerBId,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;

  const mkCand = async (email: string, name: string) =>
    (
      await db
        .insert(candidates)
        .values({ orgId: orgA, fullName: name, email, currentEmployer: "Acme" } as never)
        .returning({ id: candidates.id })
    )[0]!.id;
  const mkApp = async (orgId: string, requisitionId: string, candidateId: string, stage: string) =>
    (
      await db
        .insert(applications)
        .values({ orgId, requisitionId, candidateId, stage } as never)
        .returning({ id: applications.id })
    )[0]!.id;

  const cand1 = await mkCand(candEmail, "Asha Candidate");
  const cand3 = await mkCand(`cand3-${stamp}@${dom}`, "Devi Final");
  const cand4 = await mkCand(`cand4-${stamp}@${dom}`, "Kiran Immediate");
  const candB = await mkCand(`candb-${stamp}@${dom}`, "Bee Org");
  appA1 = await mkApp(orgA, reqA, cand1, "shortlisted");
  appA3 = await mkApp(orgA, reqA, cand3, "l3");
  appA4 = await mkApp(orgA, reqImm, cand4, "l1");
  appB1 = await mkApp(orgB, reqB, candB, "shortlisted");

  extPanelistId = (
    await db
      .insert(panelists)
      .values({
        orgId: orgA,
        fullName: "Ext Ernal",
        email: extEmail,
        kind: "external",
        active: true,
      } as never)
      .returning({ id: panelists.id })
  )[0]!.id;
  // Same person's email on org B's directory, but inactive: never linkable.
  bPanelistId = (
    await db
      .insert(panelists)
      .values({
        orgId: orgB,
        fullName: "B Ext",
        email: extEmail,
        kind: "external",
        active: false,
      } as never)
      .returning({ id: panelists.id })
  )[0]!.id;

  const past = new Date(Date.now() - 2 * HOUR);
  const future = new Date(Date.now() + 48 * HOUR);
  roundA3 = await mkRound(orgA, appA3, 3, past, interA, [{ name: "Ext Ernal", email: extEmail }]);
  roundFuture3 = await mkRound(orgA, appA3, 3, future, interA);
  roundImm = await mkRound(orgA, appA4, 1, past, interA);
  roundB = await mkRound(orgB, appB1, 1, past, `blead-${stamp}@${dom}`);
});

afterAll(async () => {
  // audit rows carry no FK; everything else cascades from organizations.
  for (const id of [orgA, orgB]) await db.delete(auditLog).where(eq(auditLog.orgId, id));
  await db.delete(organizations).where(eq(organizations.id, orgA));
  await db.delete(organizations).where(eq(organizations.id, orgB));
  for (const id of [ownerId, interAId, panelA2Id, recruiterAId, panelOnlyId, ownerBId])
    await db.delete(users).where(eq(users.id, id));
});

describe("progressionFor / nextStageFor (the verdict → stage table)", () => {
  test("nextStageFor: reject and hold end the run, a select walks the rounds", () => {
    expect(iv.nextStageFor(1, "reject")).toBe("rejected");
    expect(iv.nextStageFor(2, "hold")).toBe("on_hold");
    expect(iv.nextStageFor(2, "select")).toBe("l3");
    expect(iv.nextStageFor(3, "select")).toBe("offer_pending");
  });

  test("progressionFor: recommend leaves every call but a pre-final select to the hiring manager", () => {
    // A select before the final round opens the next one, under either policy.
    expect(iv.progressionFor(1, "select", 3, "recommend")).toBe("l2");
    expect(iv.progressionFor(1, "select", 3, "immediate")).toBe("l2");
    expect(iv.progressionFor(2, "select", 2, "immediate")).toBe("offer_pending");
    // The final decision always comes from the hiring manager under recommend.
    expect(iv.progressionFor(3, "select", 3, "recommend")).toBeNull();
    expect(iv.progressionFor(2, "select", 2, "recommend")).toBeNull();
    // Holds and rejects: only "immediate" moves the candidate itself.
    expect(iv.progressionFor(1, "reject", 3, "recommend")).toBeNull();
    expect(iv.progressionFor(1, "reject", 3, "immediate")).toBe("rejected");
    expect(iv.progressionFor(1, "hold", 3, "recommend")).toBeNull();
    expect(iv.progressionFor(1, "hold", 3, "immediate")).toBe("on_hold");
  });
});

describe("scheduleInterviewCore", () => {
  test("booking L1 parks the application on the round's stage, writes the stage event and queues the invite", async () => {
    const r = await iv.scheduleInterviewCore(
      { orgId: orgA, actor: `recruiter-${stamp}` },
      {
        applicationId: appA1,
        level: 1,
        interviewer: "Interviewer One",
        interviewerEmail: interA,
        scheduledAt: new Date(Date.now() + 24 * HOUR).toISOString(),
        durationMins: 45,
        mode: "online",
        agenda: "  Platform depth  ",
        panel: [{ name: "Panel Two", email: panelA2 }],
      },
    );
    expect(r.ok).toBe(true);
    expect(r.rescheduled).toBe(false);
    expect(r.candidateEmail).toBe(candEmail);
    expect(r.interviewId).toBeTruthy();
    roundA1 = r.interviewId!;
    const [row] = await db
      .select({
        status: interviews.status,
        level: interviews.level,
        panel: interviews.panel,
        agenda: interviews.agenda,
        interviewerEmail: interviews.interviewerEmail,
      })
      .from(interviews)
      .where(eq(interviews.id, roundA1));
    expect(row).toMatchObject({ status: "scheduled", level: 1, agenda: "Platform depth" });
    // The panel is stored normalised: lowercased, the lead not repeated.
    expect(row!.panel).toEqual([{ name: "Panel Two", email: panelA2.toLowerCase() }]);
    expect(row!.interviewerEmail).toBe(interA.toLowerCase());
    expect(await stageOf(appA1)).toBe("l1");
    const [evt] = await db
      .select({
        toStage: stageEvents.toStage,
        reason: stageEvents.reason,
        actor: stageEvents.actor,
      })
      .from(stageEvents)
      .where(eq(stageEvents.applicationId, appA1))
      .orderBy(stageEvents.createdAt);
    expect(evt).toMatchObject({ toStage: "l1", actor: `recruiter-${stamp}` });
    const invites = await db
      .select({ id: emailOutbox.id, to: emailOutbox.toEmail })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.orgId, orgA), eq(emailOutbox.kind, "interview_invite")));
    expect(invites.some((i) => i.to === candEmail)).toBe(true);
  });

  test("an unparseable time refuses", async () => {
    await expect(
      iv.scheduleInterviewCore(
        { orgId: orgA, actor: "x" },
        {
          applicationId: appA1,
          level: 2,
          scheduledAt: "not a date",
          durationMins: 60,
          mode: "online",
        },
      ),
    ).rejects.toThrow("Choose a valid interview date and time.");
  });

  test("another org's application is invisible — the query is org-scoped", async () => {
    await expect(
      iv.scheduleInterviewCore(
        { orgId: orgB, actor: "x" },
        {
          applicationId: appA1,
          level: 1,
          scheduledAt: new Date(Date.now() + 24 * HOUR).toISOString(),
          durationMins: 60,
          mode: "online",
        },
      ),
    ).rejects.toThrow("Application not found in your organisation.");
  });

  test("a panelist outside the organisation and its directory refuses", async () => {
    await expect(
      iv.scheduleInterviewCore(
        { orgId: orgA, actor: "x" },
        {
          applicationId: appA1,
          level: 2,
          scheduledAt: new Date(Date.now() + 24 * HOUR).toISOString(),
          durationMins: 60,
          mode: "online",
          panel: [{ email: `stranger-${stamp}@nowhere.example` }],
        },
      ),
    ).rejects.toThrow("Panel members must be active members of the organisation");
  });

  test("a re-schedule needs an auditable reason, and one is written", async () => {
    const newTime = new Date(Date.now() + 30 * HOUR).toISOString();
    const sameRound = {
      applicationId: appA1,
      level: 1,
      interviewId: roundA1,
      interviewer: "Interviewer One",
      interviewerEmail: interA,
      scheduledAt: newTime,
      durationMins: 45,
      mode: "online" as const,
      panel: [{ name: "Panel Two", email: panelA2 }],
    };
    await expect(iv.scheduleInterviewCore({ orgId: orgA, actor: "x" }, sameRound)).rejects.toThrow(
      "Give a reason for the re-schedule",
    );
    const r = await iv.scheduleInterviewCore(
      { orgId: orgA, actor: "x" },
      { ...sameRound, rescheduleReason: "panel conflict" },
    );
    expect(r).toMatchObject({ ok: true, rescheduled: true, interviewId: roundA1 });
    const [row] = await db
      .select({ status: interviews.status })
      .from(interviews)
      .where(eq(interviews.id, roundA1));
    expect(row!.status).toBe("rescheduled");
    const events = await db
      .select({ reason: stageEvents.reason })
      .from(stageEvents)
      .where(eq(stageEvents.applicationId, appA1));
    expect(events.some((e) => e.reason?.includes("re-scheduled: panel conflict"))).toBe(true);
  });
});

describe("submitScorecardCore", () => {
  beforeAll(async () => {
    // The booked round has now happened: scorecards are open.
    await db
      .update(interviews)
      .set({ scheduledAt: new Date(Date.now() - 2 * HOUR) })
      .where(eq(interviews.id, roundA1));
  });

  const l1Rubric = [
    { name: "LLMs", rating: 4 },
    { name: "System design", rating: 4 },
    { name: "Problem solving", rating: 4 },
  ];

  test("a hold or reject needs a written reason", async () => {
    await expect(
      iv.submitScorecardCore(
        { orgId: orgA, userId: interAId, email: interA, actor: interA },
        {
          interviewId: roundA1,
          applicationId: appA1,
          level: 1,
          verdict: "hold",
          competencies: l1Rubric,
        },
      ),
    ).rejects.toThrow("A hold or reject needs a written reason.");
  });

  test("a scorecard before the round starts refuses", async () => {
    await expect(
      iv.submitScorecardCore(
        { orgId: orgA, userId: interAId, email: interA, actor: interA },
        {
          interviewId: roundFuture3,
          applicationId: appA3,
          level: 3,
          verdict: "select",
          competencies: [{ name: "Judgement", rating: 4 }],
        },
      ),
    ).rejects.toThrow("scorecards open once it has started");
  });

  test("another org's application is invisible to the scorecard core", async () => {
    await expect(
      iv.submitScorecardCore(
        { orgId: orgB, userId: ownerBId, email: `owner-b-${stamp}@${dom}`, actor: "b" },
        {
          interviewId: roundA1,
          applicationId: appA1,
          level: 1,
          verdict: "select",
          competencies: l1Rubric,
        },
      ),
    ).rejects.toThrow("Application not found");
  });

  test("an off-panel member without the HR head's role cannot score the round", async () => {
    await expect(
      iv.submitScorecardCore(
        { orgId: orgA, userId: recruiterAId, email: recruiterA, actor: recruiterA },
        {
          interviewId: roundA1,
          applicationId: appA1,
          level: 1,
          verdict: "select",
          competencies: l1Rubric,
        },
      ),
    ).rejects.toThrow("Only the interviewers on this round can score it.");
  });

  test("only the rubric's competencies may be rated", async () => {
    await expect(
      iv.submitScorecardCore(
        { orgId: orgA, userId: panelA2Id, email: panelA2, actor: panelA2 },
        {
          interviewId: roundA1,
          applicationId: appA1,
          level: 1,
          verdict: "select",
          competencies: [{ name: "Vibes", rating: 5 }],
        },
      ),
    ).rejects.toThrow("Rate only the competencies this round's rubric lists.");
  });

  test("the first card is stored, immutable; the round waits for the rest of the panel", async () => {
    const r = await iv.submitScorecardCore(
      { orgId: orgA, userId: interAId, email: interA, actor: interA },
      {
        interviewId: roundA1,
        applicationId: appA1,
        level: 1,
        verdict: "select",
        comments: "Strong systems depth",
        competencies: l1Rubric,
      },
    );
    expect(r.ok).toBe(true);
    expect(r.roundComplete).toBe(false);
    expect(r.movedTo).toBeNull();
    expect(r.waitingFor).toContain(panelA2);
    const [card] = await db
      .select({
        rating: evaluations.rating,
        verdict: evaluations.recommendation,
        email: evaluations.evaluatorEmail,
      })
      .from(evaluations)
      .where(eq(evaluations.interviewId, roundA1));
    expect(card).toMatchObject({ rating: 4, verdict: "select", email: interA });
    // Nothing moves while the round is incomplete.
    expect(await stageOf(appA1)).toBe("l1");
  });

  test("a second card from the same interviewer is refused — scorecards are final", async () => {
    await expect(
      iv.submitScorecardCore(
        { orgId: orgA, userId: interAId, email: interA, actor: interA },
        {
          interviewId: roundA1,
          applicationId: appA1,
          level: 1,
          verdict: "select",
          competencies: l1Rubric,
        },
      ),
    ).rejects.toThrow("You have already scored this round");
  });

  test("when the whole panel has scored a select, the candidate moves and the next round is queued", async () => {
    const r = await iv.submitScorecardCore(
      { orgId: orgA, userId: panelA2Id, email: panelA2, actor: panelA2 },
      {
        interviewId: roundA1,
        applicationId: appA1,
        level: 1,
        verdict: "select",
        competencies: l1Rubric.map((c) => ({ ...c, rating: 5 })),
      },
    );
    expect(r).toMatchObject({
      ok: true,
      roundComplete: true,
      movedTo: "l2",
      nextInterviewCreated: true,
      waitingFor: [],
    });
    expect(await stageOf(appA1)).toBe("l2");
    const [round] = await db
      .select({ status: interviews.status, completedAt: interviews.completedAt })
      .from(interviews)
      .where(eq(interviews.id, roundA1));
    expect(round!.status).toBe("completed");
    expect(round!.completedAt).toBeTruthy();
    const next = await db
      .select({ id: interviews.id, status: interviews.status })
      .from(interviews)
      .where(
        and(
          eq(interviews.orgId, orgA),
          eq(interviews.applicationId, appA1),
          eq(interviews.level, 2),
        ),
      );
    expect(next.some((n) => n.status === "pending_scheduling")).toBe(true);
  });

  test("an interviewer-only role cannot move a candidate into the offer pipeline", async () => {
    // The "immediate" plan would move the candidate to offer_pending; the
    // round's verdict is recorded, but the move itself is HR-only.
    await expect(
      iv.submitScorecardCore(
        { orgId: orgA, userId: interAId, email: interA, actor: interA },
        {
          interviewId: roundImm,
          applicationId: appA4,
          level: 1,
          verdict: "select",
          competencies: [{ name: "Craft", rating: 5 }],
        },
      ),
    ).rejects.toThrow("Only the HR head or an owner can move a candidate into the offer pipeline.");
    expect(await stageOf(appA4)).toBe("l1");
  });

  test("an external panelist's final-round select stays with the hiring manager", async () => {
    // The lead scores first; the round completes only when the external
    // panelist (on the round through their directory entry) has scored too.
    const lead = await iv.submitScorecardCore(
      { orgId: orgA, userId: interAId, email: interA, actor: interA },
      {
        interviewId: roundA3,
        applicationId: appA3,
        level: 3,
        verdict: "select",
        competencies: [
          { name: "Judgement", rating: 5 },
          { name: "Motivation", rating: 5 },
          { name: "Growth potential", rating: 5 },
          { name: "Team fit", rating: 5 },
        ],
      },
    );
    expect(lead.roundComplete).toBe(false);
    const r = await iv.submitScorecardCore(
      { orgId: orgA, userId: null, email: extEmail, actor: `external:${extEmail}` },
      {
        interviewId: roundA3,
        applicationId: appA3,
        level: 3,
        verdict: "select",
        competencies: [
          { name: "Judgement", rating: 5 },
          { name: "Motivation", rating: 5 },
          { name: "Growth potential", rating: 5 },
          { name: "Team fit", rating: 4 },
        ],
      },
    );
    expect(r).toMatchObject({ ok: true, roundComplete: true, movedTo: null, blocked: null });
    // "recommend": the final decision is the hiring manager's, not the panel's —
    // and certainly not a private link's.
    expect(r.decisionPending).toContain("the hiring manager makes the hiring decision");
    expect(await stageOf(appA3)).toBe("l3");
  });
});

describe("markInterviewOutcomeCore", () => {
  let stillBooked: string;
  beforeAll(async () => {
    roundOutcome = await mkRound(orgA, appA1, 2, new Date(Date.now() + 12 * HOUR), panelA2);
    stillBooked = await mkRound(orgA, appA1, 3, new Date(Date.now() + 12 * HOUR), interA);
  });

  test("the hiring team records a no-show on a booked round, audited, nothing moves", async () => {
    const before = await stageOf(appA1);
    expect(
      await iv.markInterviewOutcomeCore(
        { orgId: orgA, userId: recruiterAId, email: recruiterA },
        { interviewId: roundOutcome, outcome: "candidate_no_show", note: "Never joined the call" },
      ),
    ).toEqual({ ok: true });
    const [row] = await db
      .select({ status: interviews.status, note: interviews.outcomeNote })
      .from(interviews)
      .where(eq(interviews.id, roundOutcome));
    expect(row!.status).toBe("no_show");
    expect(row!.note).toContain("the candidate did not join");
    expect(row!.note).toContain("Never joined the call");
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "interview.no_show")));
    expect(audits.length).toBe(1);
    expect(await stageOf(appA1)).toBe(before);
  });

  test("a member with no hiring role who is not on the round is refused", async () => {
    await expect(
      iv.markInterviewOutcomeCore(
        { orgId: orgA, userId: panelOnlyId, email: panelOnly },
        { interviewId: stillBooked, outcome: "cancelled", note: "" },
      ),
    ).rejects.toThrow("Only an interviewer on this round or the hiring team can mark it.");
  });

  test("a round that already happened cannot be marked as missed", async () => {
    await expect(
      iv.markInterviewOutcomeCore(
        { orgId: orgA, userId: recruiterAId, email: recruiterA },
        { interviewId: roundA3, outcome: "cancelled", note: "" },
      ),
    ).rejects.toThrow("only a booked round can be marked");
  });

  test("another org's round is invisible", async () => {
    await expect(
      iv.markInterviewOutcomeCore(
        { orgId: orgB, userId: ownerBId, email: `owner-b-${stamp}@${dom}` },
        { interviewId: roundOutcome, outcome: "cancelled", note: "" },
      ),
    ).rejects.toThrow("Interview round not found.");
  });
});

describe("interviewerUnavailableCore", () => {
  beforeAll(async () => {
    roundUnavail = await mkRound(orgA, appA1, 2, new Date(Date.now() + 12 * HOUR), interA);
    roundPast = await mkRound(orgA, appA1, 2, new Date(Date.now() - HOUR), interA);
  });

  test("an interviewer on a booked round says they cannot make it — once, audited", async () => {
    expect(
      await iv.interviewerUnavailableCore(
        { orgId: orgA, userId: interAId, email: interA },
        { interviewId: roundUnavail, note: "Client escalation that day" },
      ),
    ).toEqual({ ok: true });
    const [row] = await db
      .select({ unavailable: interviews.unavailable })
      .from(interviews)
      .where(eq(interviews.id, roundUnavail));
    expect(row!.unavailable).toHaveLength(1);
    expect(row!.unavailable![0]).toMatchObject({
      email: interA,
      note: "Client escalation that day",
    });
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(eq(auditLog.orgId, orgA), eq(auditLog.action, "interview.interviewer_unavailable")),
      );
    expect(audits.length).toBe(1);
  });

  test("saying it twice is refused", async () => {
    await expect(
      iv.interviewerUnavailableCore(
        { orgId: orgA, userId: interAId, email: interA },
        { interviewId: roundUnavail, note: "" },
      ),
    ).rejects.toThrow("You have already said you cannot make it");
  });

  test("someone not on the round is refused", async () => {
    await expect(
      iv.interviewerUnavailableCore(
        { orgId: orgA, userId: recruiterAId, email: recruiterA },
        { interviewId: roundUnavail, note: "" },
      ),
    ).rejects.toThrow("Only an interviewer on this round can say this.");
  });

  test("once the round has started, the can't-make-it flow is closed", async () => {
    await expect(
      iv.interviewerUnavailableCore(
        { orgId: orgA, userId: interAId, email: interA },
        { interviewId: roundPast, note: "" },
      ),
    ).rejects.toThrow("already started");
  });

  test("another org's round is invisible", async () => {
    await expect(
      iv.interviewerUnavailableCore(
        { orgId: orgB, userId: ownerBId, email: `owner-b-${stamp}@${dom}` },
        { interviewId: roundUnavail, note: "" },
      ),
    ).rejects.toThrow("Interview round not found.");
  });
});

describe("private scorecard links: submitByLink and the states panel-access.test.ts leaves open", () => {
  let linkToken: string;

  beforeAll(async () => {
    // An external panelist alone on a past round: their link is the only way in.
    roundLink = await mkRound(orgA, appA1, 2, new Date(Date.now() - HOUR), null, [
      { name: "Ext Ernal", email: extEmail },
    ]);
    linkToken = await links.issueScorecardLink(
      orgA,
      roundLink,
      extPanelistId,
      (
        await db
          .select({ at: interviews.scheduledAt })
          .from(interviews)
          .where(eq(interviews.id, roundLink))
      )[0]!.at!,
    );
    roundNotYet = await mkRound(orgA, appA3, 3, new Date(Date.now() + 6 * HOUR), null, [
      { name: "Ext Ernal", email: extEmail },
    ]);
  });

  test("a token that does not exist opens nothing", async () => {
    expect(await links.publicScorecard(`nope-${stamp}`)).toBeNull();
    await expect(
      links.submitByLink(`nope-${stamp}`, {
        verdict: "select",
        comments: null,
        reason: null,
        competencies: [],
      }),
    ).rejects.toThrow("This link is not valid.");
  });

  test("a round that has not started yet reads not_yet, with the rubric shown", async () => {
    const token = await links.issueScorecardLink(
      orgA,
      roundNotYet,
      extPanelistId,
      (
        await db
          .select({ at: interviews.scheduledAt })
          .from(interviews)
          .where(eq(interviews.id, roundNotYet))
      )[0]!.at!,
    );
    const page = await links.publicScorecard(token);
    expect(page!.state).toBe("not_yet");
    expect(page!.competencies).toContain("Judgement");
    expect(page!.brief).not.toBeNull();
    expect(page!.brief!.match).toBeNull();
  });

  test("the external panelist submits once through the link; it is audited and reads submitted", async () => {
    const r = await links.submitByLink(linkToken, {
      verdict: "hold",
      comments: "Solid craft, unsure about the ownership range",
      reason: "Need a second conversation on ownership",
      competencies: [
        { name: "Ownership", rating: 3 },
        { name: "Collaboration", rating: 4 },
        { name: "Communication", rating: 4 },
      ],
    });
    expect(r).toEqual({ ok: true, roundComplete: true });
    const [row] = await db
      .select({ usedAt: panelistScorecardLinks.usedAt })
      .from(panelistScorecardLinks)
      .where(eq(panelistScorecardLinks.tokenHash, links.hashToken(linkToken)));
    expect(row!.usedAt).toBeTruthy();
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "scorecard.submitted_by_link")));
    expect(audits.length).toBe(1);
    const page = await links.publicScorecard(linkToken);
    expect(page!.state).toBe("submitted");
  });

  test("the same link cannot score twice", async () => {
    await expect(
      links.submitByLink(linkToken, {
        verdict: "select",
        comments: null,
        reason: null,
        competencies: [{ name: "Ownership", rating: 5 }],
      }),
    ).rejects.toThrow("You have already scored this round");
  });

  test("a link resolves its own organisation's panelist only", async () => {
    expect((await links.linkPanelist(orgA, extEmail))?.id).toBe(extPanelistId);
    // The same email sits on org B's directory too — but inactive there.
    expect(await links.linkPanelist(orgB, extEmail)).toBeNull();
  });
});

describe("slot offers: public-token scoping", () => {
  let openToken: string;
  let expiredToken: string;
  let bookedToken: string;
  let openOfferId: string;
  let openSlots: string[];

  beforeAll(async () => {
    openSlots = [
      new Date(Date.now() + 26 * HOUR).toISOString(),
      new Date(Date.now() + 30 * HOUR).toISOString(),
    ];
    openToken = `open${stamp}${"a".repeat(16)}`;
    expiredToken = `expired${stamp}${"b".repeat(16)}`;
    bookedToken = `booked${stamp}${"c".repeat(16)}`;
    openOfferId = (
      await db
        .insert(interviewSlotOffers)
        .values({
          orgId: orgA,
          applicationId: appA1,
          level: 1,
          interviewerEmail: interA,
          slots: openSlots,
          token: openToken,
          status: "offered",
          expiresAt: new Date(Date.now() + 24 * HOUR),
        } as never)
        .returning({ id: interviewSlotOffers.id })
    )[0]!.id;
    await db.insert(interviewSlotOffers).values({
      orgId: orgA,
      applicationId: appA1,
      level: 1,
      interviewerEmail: interA,
      slots: [new Date(Date.now() - HOUR).toISOString()],
      token: expiredToken,
      status: "offered",
      expiresAt: new Date(Date.now() - HOUR),
    } as never);
    await db.insert(interviewSlotOffers).values({
      orgId: orgA,
      applicationId: appA1,
      level: 1,
      interviewerEmail: interA,
      slots: openSlots,
      token: bookedToken,
      status: "booked",
      expiresAt: new Date(Date.now() + 24 * HOUR),
    } as never);
  });

  test("an unknown token shows and books nothing", async () => {
    expect(await slotOffers.publicOffer(`garbage-${stamp}`)).toBeNull();
    expect(await slotOffers.chooseSlot(`garbage-${stamp}`, openSlots[0]!)).toEqual({
      booked: false,
      reason: "This link is not valid.",
    });
    expect(await slotOffers.declineSlots(`garbage-${stamp}`, "none work")).toBe(false);
  });

  test("an expired offer is shown expired, with no pickable times, and refuses to book", async () => {
    const page = await slotOffers.publicOffer(expiredToken);
    expect(page).toMatchObject({ status: "expired", slots: [] });
    expect(
      await slotOffers.chooseSlot(expiredToken, new Date(Date.now() - HOUR).toISOString()),
    ).toEqual({
      booked: false,
      reason: "This link is no longer open. The hiring team will be in touch.",
    });
  });

  test("an already-booked offer cannot be declined again", async () => {
    expect(await slotOffers.declineSlots(bookedToken, "none work")).toBe(false);
  });

  test("the open offer shows the round and the times, never a person", async () => {
    const page = await slotOffers.publicOffer(openToken)!;
    const page2 = await slotOffers.publicOffer(openToken);
    expect(page2).toMatchObject({
      status: "offered",
      roundLabel: "L1 interview",
      withText: "the hiring team",
      slots: openSlots,
    });
    expect(JSON.stringify(page2)).not.toContain(interA);
    expect(page).toBeTruthy();
  });

  test("a time outside the offer refuses", async () => {
    expect(
      await slotOffers.chooseSlot(openToken, new Date(Date.now() + 40 * HOUR).toISOString()),
    ).toEqual({
      booked: false,
      reason: "Please choose one of the times offered.",
    });
  });

  test("an offer is not reachable through another org's id", async () => {
    expect(
      await slotOffers.chooseSlotByOffer(orgB, openOfferId, openSlots[0]!, {
        callId: `call-${stamp}`,
        alternates: [],
      }),
    ).toEqual({ booked: false, reason: "That interview offer was not found." });
    expect(
      await slotOffers.chooseSlotByOffer(orgA, crypto.randomUUID(), openSlots[0]!, {
        callId: `call-${stamp}`,
        alternates: [],
      }),
    ).toEqual({ booked: false, reason: "That interview offer was not found." });
  });
});

describe("assessment.server: the vendor-neutral refusal (no AI key)", () => {
  test("generating questions refuses without a key, naming no provider", async () => {
    let message = "";
    try {
      await mindset.generateQuestions({
        orgId: orgA,
        title: "Platform Engineer",
        mustHave: ["LLMs"],
      });
      expect.unreachable();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("No AI model key saved");
    expect(message).not.toMatch(/openai|anthropic|google|gpt|gemini|claude/i);
  });

  test("scoring answers refuses the same way", async () => {
    let message = "";
    try {
      await mindset.scoreAnswers({
        orgId: orgA,
        title: "Platform Engineer",
        questions: [
          { id: "q1", dimension: "Learning agility", prompt: "Tell us…", looks_like: "…" },
        ],
        answers: [{ id: "q1", answer: "I once led a migration…" }],
      });
      expect.unreachable();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("No AI model key saved");
  });
});

describe("scorecard-chase: who still owes a scorecard", () => {
  let chaseRound: string;

  beforeAll(async () => {
    chaseRound = await mkRound(orgA, appA1, 2, new Date(Date.now() - HOUR), interA, [
      { name: "Panel Two", email: panelA2 },
    ]);
  });

  test("the empty list answers nothing", async () => {
    expect(await chase.missingScorecards(orgA, [])).toEqual({});
  });

  test("the round's panel who have not scored, minus anyone who said they cannot make it", async () => {
    const both = await chase.missingScorecards(orgA, [chaseRound]);
    expect(both[chaseRound]!.sort()).toEqual([interA, panelA2].map((e) => e.toLowerCase()).sort());
    await db
      .update(interviews)
      .set({ unavailable: [{ email: interA, note: null, at: new Date().toISOString() }] })
      .where(eq(interviews.id, chaseRound));
    const after = await chase.missingScorecards(orgA, [chaseRound]);
    expect(after[chaseRound]).toEqual([panelA2]);
  });

  test("another org's rounds are invisible to the sweep's lookup", async () => {
    expect(await chase.missingScorecards(orgB, [chaseRound])).toEqual({});
    expect(await chase.missingScorecards(orgA, [roundB])).toEqual({});
    const mine = await chase.missingScorecards(orgB, [roundB]);
    expect(mine[roundB]).toEqual([`blead-${stamp}@${dom}`]);
  });
});
