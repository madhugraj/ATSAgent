/**
 * Panel-only access (the `interviewer` role), against the disposable database:
 *  - a member whose only role is interviewer resolves to no organisation for
 *    every tenant function (deny by default) and is refused by assertRole;
 *    panel functions (allowPanel) admit them with panelOnly set;
 *  - interviewer plus any other role, or the owner, is not panel-only;
 *  - the panel brief carries the profile, rubric and CV; match and screening
 *    only for a signed-in member, never on a private link;
 *  - a private link shows the brief while valid and nothing once expired.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/panel-access.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  applications,
  candidates,
  interviews,
  matchScores,
  orgMembers,
  organizations,
  panelistScorecardLinks,
  panelists,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const auth = await import("../src/lib/auth.middleware");
const { panelBrief } = await import("../src/lib/panel-brief.server");
const links = await import("../src/lib/panelist-links.server");

const stamp = Date.now();
const domain = `pacc${stamp}.test`;
let orgId: string;
let ownerId: string;
let panelUserId: string;
let mixedUserId: string;
let interviewId: string;
let appId: string;

async function user(email: string) {
  return (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
}
async function member(userId: string, email: string, isOwner = false) {
  await db.insert(orgMembers).values({ orgId, userId, email, status: "active", isOwner } as never);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Panel Org", slug: `pacc-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  ownerId = await user(`owner@${domain}`);
  panelUserId = await user(`panel@${domain}`);
  mixedUserId = await user(`mixed@${domain}`);
  await member(ownerId, `owner@${domain}`, true);
  await member(panelUserId, `panel@${domain}`);
  await member(mixedUserId, `mixed@${domain}`);
  await db.insert(userRoles).values([
    { userId: ownerId, orgId, role: "interviewer" as never },
    { userId: panelUserId, orgId, role: "interviewer" as never },
    { userId: mixedUserId, orgId, role: "interviewer" as never },
    { userId: mixedUserId, orgId, role: "recruiter" as never },
  ]);
  const reqId = (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-P-${stamp}`,
        title: "Head of AI",
        status: "approved",
        mustHaveSkills: ["LLMs", "MLOps"],
        createdBy: ownerId,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
  const [c] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: "Asha Candidate",
      email: `cand@${domain}`,
      currentEmployer: "Acme",
      experienceYears: "12",
      skills: ["LLMs", "MLOps"],
      resumeText: "Asha Candidate\nLed a team of nine building an LLM platform.",
      currentCtc: "9000000",
    } as never)
    .returning({ id: candidates.id });
  appId = (
    await db
      .insert(applications)
      .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "l1" } as never)
      .returning({ id: applications.id })
  )[0]!.id;
  await db.insert(matchScores).values({
    applicationId: appId,
    orgId,
    overallScore: 81,
    rationale: "Strong platform work",
  } as never);
  interviewId = (
    await db
      .insert(interviews)
      .values({
        orgId,
        applicationId: appId,
        level: 1,
        interviewerEmail: `panel@${domain}`,
        scheduledAt: new Date(Date.now() - 3600_000),
        status: "completed",
      } as never)
      .returning({ id: interviews.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const id of [ownerId, panelUserId, mixedUserId])
    await db.delete(users).where(eq(users.id, id));
});

describe("panel-only access", () => {
  test("an interviewer-only member resolves to no organisation by default", async () => {
    expect(await auth.activeOrgOf(panelUserId)).toBeNull();
    const panel = await auth.activeOrgOf(panelUserId, { allowPanel: true });
    expect(panel).toMatchObject({ orgId, panelOnly: true, isOwner: false });
  });

  test("assertRole and assertNotPanelOnly refuse them", async () => {
    await expect(auth.assertRole(panelUserId, orgId, "recruiter")).rejects.toThrow();
    await expect(auth.assertRole(panelUserId, orgId, "interviewer")).rejects.toThrow();
    await expect(auth.assertNotPanelOnly(panelUserId, orgId)).rejects.toThrow();
  });

  test("interviewer plus another role, or the owner, keeps full access", async () => {
    expect(await auth.activeOrgOf(mixedUserId)).toMatchObject({ orgId, panelOnly: false });
    expect(await auth.activeOrgOf(ownerId)).toMatchObject({ orgId, panelOnly: false });
    await auth.assertNotPanelOnly(mixedUserId, orgId);
  });
});

describe("the panel brief", () => {
  test("a member's brief has profile, rubric, CV, match — never pay", async () => {
    const b = await panelBrief(orgId, interviewId, { internal: true });
    expect(b).toMatchObject({
      candidateName: "Asha Candidate",
      jobTitle: "Head of AI",
      level: 1,
      profile: { employer: "Acme", years: 12, skills: ["LLMs", "MLOps"] },
    });
    expect(b!.competencies.length).toBeGreaterThan(0);
    expect(b!.cv).toContain("LLM platform");
    expect(b!.match).toContain("81/100");
    expect(JSON.stringify(b)).not.toContain("9000000");
  });

  test("a link brief leaves out match and screening", async () => {
    const b = await panelBrief(orgId, interviewId, { internal: false });
    expect(b!.cv).toContain("LLM platform");
    expect(b!.match).toBeNull();
    expect(b!.screening).toBeNull();
  });

  test("another org's id opens nothing", async () => {
    expect(await panelBrief(crypto.randomUUID(), interviewId, { internal: true })).toBeNull();
  });

  test("a private link shows the brief while valid, nothing once expired", async () => {
    const [p] = await db
      .insert(panelists)
      .values({
        orgId,
        fullName: "Ravi External",
        email: `ravi@client-${stamp}.example`,
        kind: "external",
      } as never)
      .returning({ id: panelists.id });
    await db
      .update(interviews)
      .set({ panel: [{ name: "Ravi External", email: `ravi@client-${stamp}.example` }] } as never)
      .where(eq(interviews.id, interviewId));
    const [iv] = await db
      .select({ scheduledAt: interviews.scheduledAt })
      .from(interviews)
      .where(eq(interviews.id, interviewId));
    const token = await links.issueScorecardLink(orgId, interviewId, p!.id, iv!.scheduledAt!);
    const open = await links.publicScorecard(token);
    expect(open!.brief!.cv).toContain("LLM platform");
    expect(open!.brief!.match).toBeNull();

    await db
      .update(panelistScorecardLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(panelistScorecardLinks.tokenHash, links.hashToken(token)));
    const expired = await links.publicScorecard(token);
    expect(expired!.state).toBe("expired");
    expect(expired!.brief).toBeNull();
  });
});
