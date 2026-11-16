/**
 * Panel onboarding, against the disposable database:
 *  - adding an internal panellist with a company address invites them with the
 *    Interviewer role only, and their directory entry becomes the member's;
 *  - another domain, or an external panellist, is not invited (scores by link);
 *  - a private link stops opening once the person is off the round or the
 *    round is cancelled;
 *  - taking a panel-only member off panels removes the membership and roles,
 *    keeps the entry (inactive) and is audited; putting them back re-invites.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/panel-onboarding.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  applications,
  auditLog,
  candidates,
  interviews,
  orgMembers,
  organizations,
  panelists,
  requisitions,
  users,
} = await import("../drizzle/schema");
const dir = await import("../src/lib/panelists.server");
const links = await import("../src/lib/panelist-links.server");

const stamp = Date.now();
const domain = `ponb${stamp}.com`;
let orgId: string;
let ownerId: string;
let interviewId: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Onboard Org", slug: `ponb-${stamp}`, status: "active" })
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
    status: "active",
    isOwner: true,
  } as never);
  const reqId = (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-O-${stamp}`,
        title: "AI Engineer",
        status: "approved",
        createdBy: ownerId,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Ravi", email: `ravi-${stamp}@example.com` } as never)
    .returning({ id: candidates.id });
  const appId = (
    await db
      .insert(applications)
      .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "l2" } as never)
      .returning({ id: applications.id })
  )[0]!.id;
  interviewId = (
    await db
      .insert(interviews)
      .values({
        orgId,
        applicationId: appId,
        level: 2,
        interviewerEmail: `owner@${domain}`,
        panel: [{ name: "Ext", email: `ext@client-${stamp}.com` }],
        scheduledAt: new Date(Date.now() + 864e5),
        status: "scheduled",
      } as never)
      .returning({ id: interviews.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, ownerId));
});

const memberOf = async (email: string) =>
  (
    await db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.email, email)))
  )[0];
const entryOf = async (email: string) =>
  (
    await db
      .select()
      .from(panelists)
      .where(and(eq(panelists.orgId, orgId), eq(panelists.email, email)))
  )[0];

describe("adding a panellist", () => {
  test("a company address is invited as Interviewer only, and keeps one entry", async () => {
    const email = `shalini@${domain}`;
    const res = await dir.addPanelist(
      orgId,
      ownerId,
      { fullName: "Shalini", email, kind: "internal", areas: ["LLMs"], rounds: [2] },
      { via: "team_page" },
    );
    expect(res.invited).toBe(true);
    const m = await memberOf(email);
    expect(m).toMatchObject({ status: "invited", invitedRole: "interviewer" });
    const e = await entryOf(email);
    expect(e!.id).toBe(res.id);
    expect(e!.memberId).toBe(m!.id);
    const rows = await dir.listPanelists(orgId);
    expect(rows.find((r) => r.email === email)).toMatchObject({
      invited: true,
      panelOnly: true,
      rounds: [2],
    });
    // Until they join, they still score by link.
    expect(await links.linkPanelist(orgId, email)).not.toBeNull();
  });

  test("another domain or an external panellist is not invited", async () => {
    const other = await dir.addPanelist(
      orgId,
      ownerId,
      {
        fullName: "Out",
        email: `out@elsewhere-${stamp}.com`,
        kind: "internal",
        areas: [],
        rounds: [2],
      },
      { via: "team_page" },
    );
    expect(other.invited).toBe(false);
    const ext = await dir.addPanelist(
      orgId,
      ownerId,
      {
        fullName: "Ext",
        email: `ext@client-${stamp}.com`,
        kind: "external",
        areas: [],
        rounds: [2],
      },
      { via: "team_page" },
    );
    expect(ext.invited).toBe(false);
    expect(await memberOf(`ext@client-${stamp}.com`)).toBeUndefined();
  });
});

describe("private links follow the round", () => {
  test("off the round or cancelled, the link no longer opens", async () => {
    const ext = await entryOf(`ext@client-${stamp}.com`);
    const [iv] = await db
      .select({ at: interviews.scheduledAt })
      .from(interviews)
      .where(eq(interviews.id, interviewId));
    const token = await links.issueScorecardLink(orgId, interviewId, ext!.id, iv!.at!);
    expect(await links.publicScorecard(token)).not.toBeNull();

    await db
      .update(interviews)
      .set({ panel: [] } as never)
      .where(eq(interviews.id, interviewId));
    expect(await links.publicScorecard(token)).toBeNull();

    await db
      .update(interviews)
      .set({
        panel: [{ name: "Ext", email: `ext@client-${stamp}.com` }],
        status: "cancelled",
      } as never)
      .where(eq(interviews.id, interviewId));
    expect(await links.publicScorecard(token)).toBeNull();
  });
});

describe("taking a panel-only member off panels", () => {
  test("removes the membership, keeps the entry, audits; back on re-invites", async () => {
    const email = `shalini@${domain}`;
    const e = await entryOf(email);
    await dir.setPanelistActive(orgId, ownerId, e!.id, false);
    expect(await memberOf(email)).toBeUndefined();
    expect(await entryOf(email)).toMatchObject({ id: e!.id, active: false, memberId: null });
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["member.invited", "member.removed", "panelist.deactivated"]),
    );

    const back = await dir.setPanelistActive(orgId, ownerId, e!.id, true);
    expect(back.invited).toBe(true);
    expect((await entryOf(email))!.memberId).toBe((await memberOf(email))!.id);
  });

  test("a member with other roles is still managed on the Team page", async () => {
    const own = await entryOf(`owner@${domain}`);
    await expect(dir.setPanelistActive(orgId, ownerId, own!.id, false)).rejects.toThrow(
      /interviewer profile/,
    );
  });
});
