/**
 * Interview panels, step P0 (docs/interview-panel-plan.md), against the
 * disposable database:
 *  - interviewer profiles: saved and read back, audited, scoped to the
 *    organisation, the database's own limits;
 *  - the hiring manager is a registered member: resolved from a name or an
 *    e-mail, never guessed; the desk asks for it until it is;
 *  - invites are audited (an invite is a role grant).
 *  P2: eligibility (registered, round, weekly limit, ranked by fit); the panel
 *    gate's refusals, decider and stale proposals; only the approved panel is used.
 *  P3: "can't make it" before the interview; a stand-in for one candidate keeps
 *    the booked time when free, else the booking is cancelled for new times.
 *  P1: a plan cannot drop a round a candidate is in; the hiring manager is
 *    picked from members, audited; the desk posts the plan, editable in place.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/interview-panels.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  applications,
  auditLog,
  emailOutbox,
  candidates,
  hiringConversations,
  hiringMessages,
  interviews,
  memberInterviewerProfiles,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const iv = await import("../src/lib/interviewers.server");
const desk = await import("../src/server/desk/desk.server");
const org = await import("../src/lib/org.functions");
const plans = await import("../src/lib/interview-plan.server");
const { defaultPlan } = await import("../src/lib/interview-plan");
const hm = await import("../src/lib/role-hiring-manager.functions");

const stamp = Date.now();
const domain = `panels${stamp}.test`;
let orgId: string;
let otherOrgId: string;
let ownerId: string;
const members: Record<string, string> = {};

async function member(name: string, email: string, roles: string[] = [], user = true) {
  const uid = user
    ? (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id
    : null;
  const [m] = await db
    .insert(orgMembers)
    .values({ orgId, userId: uid, email, fullName: name, status: "active" } as never)
    .returning({ id: orgMembers.id });
  for (const role of roles)
    await db.insert(userRoles).values({ userId: uid!, orgId, role: role as never });
  return m!.id;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Panels Org", slug: `panels-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  otherOrgId = (
    await db
      .insert(organizations)
      .values({ name: "Other Org", slug: `panels-other-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  ownerId = (
    await db
      .insert(users)
      .values({ email: `owner@${domain}` })
      .returning({ id: users.id })
  )[0]!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId: ownerId,
    email: `owner@${domain}`,
    fullName: "Madhu R",
    status: "active",
    isOwner: true,
  } as never);
  members["priya"] = await member("Priya Natarajan", `priya@${domain}`, ["hiring_manager"]);
  members["arun"] = await member("Arun Kumar", `arun@${domain}`, ["department_head"]);
  members["arunb"] = await member("Arun Bala", `arun.b@${domain}`);
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(organizations).where(eq(organizations.id, otherOrgId));
  await db.delete(users).where(eq(users.email, `owner@${domain}`));
  for (const e of ["priya", "arun", "arun.b"])
    await db.delete(users).where(eq(users.email, `${e}@${domain}`));
});

const actor = () => ({ userId: ownerId, memberEmail: `owner@${domain}` });

describe("interviewer profiles", () => {
  test("areas are tidied: trimmed, de-duplicated, at most 20", () => {
    expect(iv.cleanAreas([" Machine  learning ", "MLOps", "mlops", "", "Leadership"])).toEqual([
      "Machine learning",
      "MLOps",
      "Leadership",
    ]);
    expect(iv.cleanAreas(Array.from({ length: 30 }, (_, i) => `a${i}`))).toHaveLength(20);
  });

  test("everyone starts as not interviewing; a saved profile is read back and audited", async () => {
    const before = await iv.interviewerProfilesOf(orgId);
    expect(before.find((r) => r.memberId === members["priya"])!.profile).toEqual(
      iv.DEFAULT_INTERVIEWER,
    );
    const saved = await iv.setInterviewerProfileCore(orgId, actor(), members["priya"]!, {
      active: true,
      areas: ["Machine learning", "MLOps", "machine learning"],
      rounds: [2, 1, 2],
      weeklyCap: 3,
    });
    expect(saved).toEqual({
      active: true,
      areas: ["Machine learning", "MLOps"],
      rounds: [1, 2],
      weeklyCap: 3,
    });
    const after = await iv.interviewerProfilesOf(orgId);
    expect(after.find((r) => r.memberId === members["priya"])!.profile).toEqual(saved);
    const [a] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "member.interviewer_profile.set")));
    expect(a!.detail).toMatchObject({ member: `priya@${domain}`, rounds: [1, 2] });
  });

  test("scoped to the organisation; at least one round; the database's own limits", async () => {
    await expect(
      iv.setInterviewerProfileCore(otherOrgId, actor(), members["priya"]!, {
        active: true,
        areas: [],
        rounds: [1],
        weeklyCap: 4,
      }),
    ).rejects.toThrow(/not found in your organisation/);
    await expect(
      iv.setInterviewerProfileCore(orgId, actor(), members["arun"]!, {
        active: true,
        areas: [],
        rounds: [],
        weeklyCap: 4,
      }),
    ).rejects.toThrow(/at least one interview round/);
    for (const bad of [{ weeklyCap: 0 }, { rounds: [4] }]) {
      let refused = false;
      try {
        await db
          .update(memberInterviewerProfiles)
          .set(bad)
          .where(eq(memberInterviewerProfiles.memberId, members["priya"]!));
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    }
  });
});

describe("the hiring manager is a registered member", () => {
  test("resolved from an e-mail, a full name or a unique first name; never guessed", async () => {
    expect(await desk.resolveHiringManager(orgId, `PRIYA@${domain}`)).toEqual({
      memberId: members["priya"],
      name: "Priya Natarajan",
    });
    expect(await desk.resolveHiringManager(orgId, "priya natarajan")).toMatchObject({
      memberId: members["priya"],
    });
    expect(await desk.resolveHiringManager(orgId, "Priya")).toMatchObject({
      memberId: members["priya"],
    });
    // Two Aruns: ambiguous, so not resolved; the full name settles it.
    expect(await desk.resolveHiringManager(orgId, "Arun")).toBeNull();
    expect(await desk.resolveHiringManager(orgId, "Arun Kumar")).toMatchObject({
      memberId: members["arun"],
    });
    expect(await desk.resolveHiringManager(orgId, "Kavitha")).toBeNull();
    // Nobody from another organisation.
    expect(await desk.resolveHiringManager(otherOrgId, `priya@${domain}`)).toBeNull();
  });

  test("the team's hiring managers and department heads are offered first", async () => {
    const names = (await desk.hiringManagerOptions(orgId)).map((m) => m.name);
    expect(names).toEqual(["Arun Kumar", "Priya Natarajan"]);
  });

  test("the desk asks for it, last, until it is a member", () => {
    const base = {
      roleTitle: "Head of AI",
      location: "Chennai",
      workMode: "onsite" as const,
      experienceMin: 15,
      openings: 1,
      mustHaveSkills: ["MLOps"],
    };
    expect(desk.missingSlots(base)).toEqual(["hiringManager"]);
    expect(desk.missingSlots({ ...base, hiringManager: "Priya" })).toEqual(["hiringManager"]);
    expect(
      desk.missingSlots({
        ...base,
        hiringManager: "Priya",
        hiringManagerMemberId: members["priya"]!,
      }),
    ).toEqual([]);
  });
});

describe("invites", () => {
  test("an invite is a role grant: audited", async () => {
    await org.inviteMemberCore(orgId, ownerId, {
      email: `saranya@${domain}`,
      role: "hr_head",
      title: "HR",
      fullName: "Saranya",
    });
    const [m] = await db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.email, `saranya@${domain}`)));
    expect(m).toMatchObject({ status: "invited", invitedRole: "hr_head" });
    const [a] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "member.invited")));
    expect(a!.detail).toEqual({ email: `saranya@${domain}`, role: "hr_head" });
  });
});

describe("P1: the interview plan and the hiring manager per role", () => {
  let reqId: string;
  let appId: string;

  beforeAll(async () => {
    reqId = (
      await db
        .insert(requisitions)
        .values({
          orgId,
          code: `REQ-P-${stamp}`,
          title: "Head of AI",
          location: "Chennai",
          status: "approved",
          mustHaveSkills: ["MLOps", "LLMs"],
          createdBy: ownerId,
        })
        .returning({ id: requisitions.id })
    )[0]!.id;
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Test Candidate", email: `cand@${domain}` } as never)
      .returning({ id: candidates.id });
    appId = (
      await db
        .insert(applications)
        .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "l1" } as never)
        .returning({ id: applications.id })
    )[0]!.id;
  });

  test("a plan cannot drop a round a candidate is in or an interview is booked for", async () => {
    const three = defaultPlan(["MLOps", "LLMs"]);
    const one = { ...three, rounds: three.rounds.slice(0, 1) };
    // The candidate is at L1: one round is fine.
    await plans.savePlan(orgId, reqId, one);
    // An L2 interview booked: one round is refused, two are fine.
    await db.insert(interviews).values({
      orgId,
      applicationId: appId,
      level: 2,
      scheduledAt: new Date(Date.now() + 86_400_000),
      status: "scheduled",
    } as never);
    expect(await plans.roundsInUse(orgId, reqId)).toBe(2);
    await expect(plans.savePlan(orgId, reqId, one)).rejects.toThrow(/L2 is already in use/);
    await plans.savePlan(orgId, reqId, { ...three, rounds: three.rounds.slice(0, 2) });
    // A cancelled interview no longer holds the round.
    await db
      .update(interviews)
      .set({ status: "cancelled" })
      .where(eq(interviews.applicationId, appId));
    expect(await plans.roundsInUse(orgId, reqId)).toBe(1);
    // Another organisation's role is not touched.
    await expect(plans.savePlan(otherOrgId, reqId, three)).rejects.toThrow(/not found/);
  });

  test("the hiring manager is picked from active members; audited; scoped", async () => {
    const before = await hm.roleHiringManagerOf(orgId, reqId);
    expect(before.memberId).toBeNull();
    expect(before.options.slice(0, 2).map((o) => o.name)).toEqual([
      "Arun Kumar",
      "Priya Natarajan",
    ]);
    expect(await hm.setRoleHiringManagerCore(orgId, ownerId, reqId, members["priya"]!)).toEqual({
      memberId: members["priya"],
      name: "Priya Natarajan",
    });
    const [r] = await db
      .select({ id: requisitions.hiringManagerMemberId, name: requisitions.hiringManager })
      .from(requisitions)
      .where(eq(requisitions.id, reqId));
    expect(r).toEqual({ id: members["priya"]!, name: "Priya Natarajan" });
    const [a] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "requisition.hiring_manager_set")));
    expect(a!.detail).toEqual({ member: `priya@${domain}` });
    // Not a member of this organisation, or another organisation's role: refused.
    await expect(
      hm.setRoleHiringManagerCore(otherOrgId, ownerId, reqId, members["priya"]!),
    ).rejects.toThrow(/active member/);
    const [invited] = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, "invited")));
    if (invited)
      await expect(hm.setRoleHiringManagerCore(orgId, ownerId, reqId, invited.id)).rejects.toThrow(
        /active member/,
      );
  });

  test("the desk posts the plan as a card the person edits in place", async () => {
    const [conv] = await db
      .insert(hiringConversations)
      .values({ orgId, createdBy: ownerId, requisitionId: reqId, status: "active" } as never)
      .returning();
    await desk.showInterviewPlan(conv as never);
    const [m] = await db
      .select()
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, conv!.id));
    expect(m!.body).toMatch(/interview plan for this role: L1 Skills, L2 Role and ownership/);
    expect(m!.card).toEqual({ type: "interview_plan", requisitionId: reqId });
  });
});

describe("P2: proposing and approving a round's panel", () => {
  const panels = () => import("../src/lib/panels.server");
  const gate = () => import("../src/server/agents/panel-gate.server");
  let reqId: string;
  let p2App: string;

  beforeAll(async () => {
    reqId = (
      await db
        .insert(requisitions)
        .values({
          orgId,
          code: `REQ-P2-${stamp}`,
          title: "Head of AI",
          location: "Chennai",
          status: "approved",
          mustHaveSkills: ["MLOps", "Leadership"],
          createdBy: ownerId,
          hiringManagerMemberId: members["priya"],
        } as never)
        .returning({ id: requisitions.id })
    )[0]!.id;
  });

  test("coverage and ranking (pure)", async () => {
    const { coverage, rankInterviewers } = await panels();
    expect(coverage(["Machine learning", "MLOps"], ["MLOps", "LLMs", "Problem solving"])).toEqual([
      "MLOps",
    ]);
    const p = (name: string, covers: number, pastRounds: number, load: number) => ({
      memberId: name,
      name,
      email: name,
      covers: Array.from({ length: covers }, (_, i) => `c${i}`),
      pastRounds,
      load,
      cap: 4,
    });
    expect(
      rankInterviewers([p("a", 0, 3, 0), p("b", 2, 0, 3), p("c", 2, 0, 1), p("d", 2, 1, 4)]).map(
        (x) => x.name,
      ),
    ).toEqual(["d", "c", "b", "a"]);
  });

  test("only registered interviewers who take the round, under their weekly limit", async () => {
    const { eligibleInterviewers } = await panels();
    // Priya is registered for L1 and L2 (earlier test); Arun is not registered.
    await iv.setInterviewerProfileCore(orgId, actor(), members["arunb"]!, {
      active: true,
      areas: ["Leadership"],
      rounds: [2, 3],
      weeklyCap: 1,
    });
    const l1 = await eligibleInterviewers(orgId, reqId, 1);
    expect(l1.registered).toBe(true);
    expect(l1.people.map((x) => x.name)).toEqual(["Priya Natarajan"]);
    expect(l1.people[0]!.covers).toEqual(["MLOps"]);
    const l2 = await eligibleInterviewers(orgId, reqId, 2);
    expect(l2.people.map((x) => x.name).sort()).toEqual(["Arun Bala", "Priya Natarajan"]);
    // Arun Bala at his weekly limit of one: left out, and said so.
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Load Test", email: `load@${domain}` } as never)
      .returning({ id: candidates.id });
    const [a] = await db
      .insert(applications)
      .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "l2" } as never)
      .returning({ id: applications.id });
    p2App = a!.id;
    await db.insert(interviews).values({
      orgId,
      applicationId: a!.id,
      level: 3,
      interviewer: "Arun Bala",
      interviewerEmail: `arun.b@${domain}`,
      scheduledAt: new Date(Date.now() + 2 * 86_400_000),
      status: "scheduled",
    } as never);
    const full = await eligibleInterviewers(orgId, reqId, 2);
    expect(full.people.map((x) => x.name)).toEqual(["Priya Natarajan"]);
    expect(full.full).toEqual(["Arun Bala"]);
  });

  test("the gate refuses outsiders and oversize panels; the hiring manager decides", async () => {
    const { panelGateFor } = await gate();
    const subject = (memberIds: string[], level = 1) => ({
      type: "panel_approval" as const,
      requisitionId: reqId,
      level,
      memberIds,
      reason: "Fits the round",
    });
    expect(await panelGateFor(orgId, subject([members["arun"]!]))).toMatchObject({
      error: expect.stringMatching(/Only eligible interviewers .*Priya Natarajan/),
    });
    expect(
      await panelGateFor(orgId, subject([members["priya"]!, members["arunb"]!], 2)),
    ).toMatchObject({
      error: expect.stringMatching(/panel of 1/),
    });
    expect(await panelGateFor(otherOrgId, subject([members["priya"]!]))).toEqual({
      error: "Requisition not found.",
    });
    const [priyaUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, `priya@${domain}`));
    const g = await panelGateFor(orgId, subject([members["priya"]!]));
    expect(g).toMatchObject({ role: null, assigneeUserId: priyaUser!.id, status: "0" });
    expect((g as { detail: string }).detail).toMatch(/Priya Natarajan: assesses MLOps/);
  });

  test("approval stores the panel (changed or not), audited; a stale proposal is refused", async () => {
    const { performPanelGate, approvedPanelWords } = await gate();
    const { approvedPanel, panelMismatch } = await panels();
    const subject = {
      type: "panel_approval" as const,
      requisitionId: reqId,
      level: 1,
      memberIds: [members["priya"]!],
      reason: "Fits",
      expects: "0",
    };
    expect(await panelMismatch(orgId, p2App, 1, [`priya@${domain}`])).toMatch(/no approved panel/);
    await performPanelGate(orgId, ownerId, subject, { status: "rejected" });
    expect(await approvedPanel(orgId, reqId, 1)).toBeNull();
    await performPanelGate(orgId, ownerId, subject, { status: "approved" });
    expect(await approvedPanel(orgId, reqId, 1)).toMatchObject({
      version: 1,
      members: [{ name: "Priya Natarajan" }],
    });
    expect(await approvedPanelWords(orgId, subject)).toMatch(
      /^Approved\. The L1 panel is Priya Natarajan/,
    );
    expect(await panelMismatch(orgId, p2App, 1, [`PRIYA@${domain}`])).toBeNull();
    expect(await panelMismatch(orgId, p2App, 1, [`arun@${domain}`])).toMatch(
      /Use this candidate's L1 panel/,
    );
    // Proposed against version 0; the panel is now version 1.
    await expect(
      performPanelGate(orgId, ownerId, subject, {
        status: "approved",
        args: { memberIds: [members["arun"]!] },
      }),
    ).rejects.toThrow(/changed since this was proposed/);
    await performPanelGate(
      orgId,
      ownerId,
      { ...subject, expects: "1" },
      { status: "approved", args: { memberIds: [members["arun"]!] } },
    );
    expect((await approvedPanel(orgId, reqId, 1))!.members.map((m) => m.name)).toEqual([
      "Arun Kumar",
    ]);
    const audits = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "role_panel.approved")));
    expect(audits.map((a) => (a.detail as { changed: boolean }).changed).sort()).toEqual([
      false,
      true,
    ]);
    // Never someone outside the organisation.
    await expect(
      performPanelGate(otherOrgId, ownerId, { ...subject, expects: undefined } as never, {
        status: "approved",
      }),
    ).rejects.toThrow(/Requisition not found|active member/);
  });
});

describe("P3: an interviewer can't make it; a stand-in for one candidate", () => {
  const panels = () => import("../src/lib/panels.server");
  const gate = () => import("../src/server/agents/panel-gate.server");
  const ivf = () => import("../src/lib/interviews.functions");
  let reqId: string;
  let appId: string;
  const at = new Date(Date.now() + 3 * 86_400_000);

  async function bookRound(level: number, email: string, name: string, app = appId) {
    const [r] = await db
      .insert(interviews)
      .values({
        orgId,
        applicationId: app,
        level,
        interviewer: name,
        interviewerEmail: email,
        scheduledAt: at,
        durationMins: 60,
        status: "scheduled",
      } as never)
      .returning();
    return r!;
  }

  beforeAll(async () => {
    reqId = (
      await db
        .insert(requisitions)
        .values({
          orgId,
          code: `REQ-P3-${stamp}`,
          title: "Head of AI",
          location: "Chennai",
          status: "approved",
          mustHaveSkills: ["MLOps", "Leadership"],
          createdBy: ownerId,
          hiringManagerMemberId: members["priya"],
        } as never)
        .returning({ id: requisitions.id })
    )[0]!.id;
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Stand In", email: `standin@${domain}` } as never)
      .returning({ id: candidates.id });
    appId = (
      await db
        .insert(applications)
        .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "l1" } as never)
        .returning({ id: applications.id })
    )[0]!.id;
    // Arun Kumar is the role's approved L1 panel; Priya takes L1 too.
    const { savePanel } = await panels();
    await savePanel(orgId, ownerId, reqId, 1, [members["arun"]!], false);
  });

  test("only someone on the round, before it starts; recorded once, audited, the coordinator told", async () => {
    const { interviewerUnavailableCore } = await ivf();
    const r = await bookRound(1, `arun@${domain}`, "Arun Kumar");
    const who = (email: string) => ({ orgId, userId: ownerId, email });
    await expect(
      interviewerUnavailableCore(who(`priya@${domain}`), { interviewId: r.id, note: "" }),
    ).rejects.toThrow(/Only an interviewer on this round/);
    await interviewerUnavailableCore(who(`ARUN@${domain}`), {
      interviewId: r.id,
      note: "Travelling",
    });
    await expect(
      interviewerUnavailableCore(who(`arun@${domain}`), { interviewId: r.id, note: "" }),
    ).rejects.toThrow(/already said/);
    const [row] = await db.select().from(interviews).where(eq(interviews.id, r.id));
    expect(row!.status).toBe("scheduled"); // the candidate keeps their time for now
    expect(row!.unavailable).toMatchObject([{ email: `arun@${domain}`, note: "Travelling" }]);
    const [ev] = await db
      .select()
      .from(agentEvents)
      .where(
        and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "interview.panellist_unavailable")),
      );
    expect(ev!.payload).toMatchObject({ level: 1, memberId: members["arun"], name: "Arun Kumar" });
    // Too late once the interview has started: that is "didn't happen".
    await db
      .update(interviews)
      .set({ scheduledAt: new Date(Date.now() - 60_000), unavailable: [] })
      .where(eq(interviews.id, r.id));
    await expect(
      interviewerUnavailableCore(who(`arun@${domain}`), { interviewId: r.id, note: "" }),
    ).rejects.toThrow(/already started/);
    await db.update(interviews).set({ scheduledAt: at }).where(eq(interviews.id, r.id));
  });

  test("a free stand-in keeps the booked time: swapped in, briefed, audited", async () => {
    const { substituteOptions, roundPanel, panelMismatch } = await panels();
    const { substituteGateFor, performSubstituteGate } = await gate();
    const opts = await substituteOptions(orgId, appId, 1, members["arun"]!);
    expect(opts.bookedAt).toBe(at.toISOString());
    expect(opts.options.map((o) => [o.name, o.freeAtBookedTime])).toEqual([
      ["Priya Natarajan", true],
    ]);
    const subject = {
      type: "panel_substitute" as const,
      applicationId: appId,
      level: 1,
      replaceMemberId: members["arun"]!,
      withMemberId: members["priya"]!,
      reason: "Arun is travelling",
    };
    expect(
      await substituteGateFor(orgId, { ...subject, withMemberId: members["arunb"]! }),
    ).toMatchObject({ error: expect.stringMatching(/Only eligible interviewers/) });
    const g = await substituteGateFor(orgId, subject);
    if ("error" in g) throw new Error(g.error);
    expect(g.detail).toMatch(/Priya Natarajan replaces Arun Kumar for this candidate only/);
    expect(g.detail).toMatch(/the time stays and the candidate sees no change/);
    // A stale card is refused.
    await expect(
      performSubstituteGate(
        orgId,
        ownerId,
        `owner@${domain}`,
        { ...subject, expects: "none" },
        {
          status: "approved",
        },
      ),
    ).rejects.toThrow(/changed since this was proposed/);
    await performSubstituteGate(orgId, ownerId, `owner@${domain}`, g.subject, {
      status: "approved",
    });
    const [row] = await db
      .select()
      .from(interviews)
      .where(and(eq(interviews.applicationId, appId), eq(interviews.level, 1)));
    expect(row).toMatchObject({
      status: "scheduled",
      interviewerEmail: `priya@${domain}`,
      interviewer: "Priya Natarajan",
    });
    expect(row!.scheduledAt!.toISOString()).toBe(at.toISOString());
    expect((await roundPanel(orgId, appId, 1))!.members.map((m) => m.name)).toEqual([
      "Priya Natarajan",
    ]);
    expect(await panelMismatch(orgId, appId, 1, [`priya@${domain}`])).toBeNull();
    const briefs = await db
      .select({ to: emailOutbox.toEmail })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.kind, "interviewer_brief")));
    expect(briefs.map((b) => b.to)).toContain(`priya@${domain}`);
    const [a] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "round_substitute.approved")));
    expect(a!.detail).toMatchObject({ outcome: "swapped", with: `priya@${domain}` });
  });

  test("a stand-in who is busy then: the booking is cancelled and new times are offered", async () => {
    const { savePanel } = await panels();
    const { substituteGateFor, performSubstituteGate } = await gate();
    await savePanel(orgId, ownerId, reqId, 2, [members["priya"]!], false);
    await iv.setInterviewerProfileCore(orgId, actor(), members["arun"]!, {
      active: true,
      areas: ["Leadership"],
      rounds: [2],
      weeklyCap: 10,
    });
    const r = await bookRound(2, `priya@${domain}`, "Priya Natarajan");
    // Arun Kumar is already interviewing someone else at that time.
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Other", email: `other@${domain}` } as never)
      .returning({ id: candidates.id });
    const [other] = await db
      .insert(applications)
      .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "l1" } as never)
      .returning({ id: applications.id });
    await bookRound(1, `arun@${domain}`, "Arun Kumar", other!.id);
    const g = await substituteGateFor(orgId, {
      type: "panel_substitute",
      applicationId: appId,
      level: 2,
      replaceMemberId: members["priya"]!,
      withMemberId: members["arun"]!,
      reason: "Priya is away",
    });
    if ("error" in g) throw new Error(g.error);
    expect(g.detail).toMatch(/is not free then, so that time is cancelled/);
    await performSubstituteGate(orgId, ownerId, `owner@${domain}`, g.subject, {
      status: "approved",
    });
    const [row] = await db.select().from(interviews).where(eq(interviews.id, r.id));
    expect(row!.status).toBe("cancelled");
    const missed = await db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "interview.missed")));
    expect(missed.length).toBeGreaterThan(0);
  });
});
