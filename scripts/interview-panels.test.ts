/**
 * Interview panels, step P0 (docs/interview-panel-plan.md), against the
 * disposable database:
 *  - interviewer profiles: saved and read back, audited, scoped to the
 *    organisation, the database's own limits;
 *  - the hiring manager is a registered member: resolved from a name or an
 *    e-mail, never guessed; the desk asks for it until it is;
 *  - invites are audited (an invite is a role grant).
 *  P1: a plan cannot drop a round a candidate is in; the hiring manager is
 *    picked from members, audited; the desk posts the plan, editable in place.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/interview-panels.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  applications,
  auditLog,
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
