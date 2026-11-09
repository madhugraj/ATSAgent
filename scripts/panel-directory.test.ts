/**
 * The panel directory (docs/panel-directory.md), against the disposable database:
 *  - org members are internal entries; HR adds internal and external people
 *    (self-approved, audited); duplicates and a member typed as external are refused;
 *  - an external panellist is eligible for their rounds, can sit on an approved
 *    panel, and panels stored with member ids still resolve;
 *  - the Interview coordinator's new_panelist request: refused while one waits;
 *    HR's typed person is added; nothing is added on a decline;
 *  - the external scorecard link: their brief carries it (and leaves out internal
 *    material), it opens only after the interview, scores once, never moves a
 *    candidate into the offer pipeline, and an unknown or expired token opens nothing.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/panel-directory.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  applications,
  auditLog,
  candidates,
  emailOutbox,
  evaluations,
  interviews,
  orgMembers,
  organizations,
  panelistScorecardLinks,
  panelists,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const dir = await import("../src/lib/panelists.server");
const panels = await import("../src/lib/panels.server");
const gate = await import("../src/server/agents/panel-gate.server");
const links = await import("../src/lib/panelist-links.server");

const stamp = Date.now();
const domain = `pdir${stamp}.test`;
let orgId: string;
let hrId: string;
let memberId: string;
let reqId: string;
let appId: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Directory Org", slug: `pdir-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  hrId = (
    await db
      .insert(users)
      .values({ email: `hr@${domain}` })
      .returning({ id: users.id })
  )[0]!.id;
  memberId = (
    await db
      .insert(orgMembers)
      .values({
        orgId,
        userId: hrId,
        email: `hr@${domain}`,
        fullName: "Hema HR",
        status: "active",
        isOwner: true,
      } as never)
      .returning({ id: orgMembers.id })
  )[0]!.id;
  await db.insert(userRoles).values({ userId: hrId, orgId, role: "hr_head" as never });
  reqId = (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-D-${stamp}`,
        title: "VP Data Engineering",
        location: "Bangalore",
        status: "approved",
        mustHaveSkills: ["Spark", "Kafka"],
        createdBy: hrId,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Bala Candidate", email: `cand@${domain}` } as never)
    .returning({ id: candidates.id });
  appId = (
    await db
      .insert(applications)
      .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "l1" } as never)
      .returning({ id: applications.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, hrId));
});

const external = {
  fullName: "Leela Rao",
  email: `Leela.Rao@client-${stamp}.example`,
  kind: "external" as const,
  company: "Client Co",
  title: "CTO",
  areas: ["Spark", "Kafka", "spark"],
  rounds: [1, 2],
};

describe("the panel directory", () => {
  test("members are internal entries; HR adds an external person, self-approved and audited", async () => {
    const before = await dir.listPanelists(orgId);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ kind: "internal", member: true, email: `hr@${domain}` });

    const added = await dir.addPanelist(orgId, hrId, external, { via: "team_page" });
    expect(added.kind).toBe("external");
    const [row] = await db.select().from(panelists).where(eq(panelists.id, added.id));
    expect(row).toMatchObject({
      kind: "external",
      email: external.email.toLowerCase(),
      company: "Client Co",
      areas: ["Spark", "Kafka"],
      rounds: [1, 2],
      addedBy: hrId,
      approvedBy: hrId,
      selfApproved: true,
      memberId: null,
    });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "panelist.added")));
    expect(audit?.detail).toMatchObject({ kind: "external", selfApproved: true, via: "team_page" });
  });

  test("the same e-mail twice, or a member typed as external, is refused", async () => {
    await expect(
      dir.addPanelist(
        orgId,
        hrId,
        { ...external, email: external.email.toUpperCase() },
        {
          via: "team_page",
        },
      ),
    ).rejects.toThrow(/already in the panel directory/);
    await expect(
      dir.addPanelist(orgId, hrId, { ...external, email: `hr@${domain}` }, { via: "team_page" }),
    ).rejects.toThrow(/add them as internal/);
  });

  test("an external panellist is eligible for their rounds and resolves on an approved panel", async () => {
    const l1 = await panels.eligibleInterviewers(orgId, reqId, 1);
    const leela = l1.people.find((p) => p.email === external.email.toLowerCase());
    expect(leela).toMatchObject({ kind: "external", company: "Client Co" });
    expect(leela!.covers.length).toBeGreaterThan(0);
    const l3 = await panels.eligibleInterviewers(orgId, reqId, 3);
    expect(l3.people.some((p) => p.email === external.email.toLowerCase())).toBe(false);

    // A panel given as an org member's id and a directory id: both resolve.
    const saved = await panels.savePanel(orgId, hrId, reqId, 1, [memberId, leela!.memberId], false);
    expect(saved.members.map((m) => m.kind)).toEqual(["internal", "external"]);
    const again = await panels.approvedPanel(orgId, reqId, 1);
    expect(again!.members.map((m) => m.email)).toEqual([
      `hr@${domain}`,
      external.email.toLowerCase(),
    ]);
  });
});

describe("the coordinator asks; HR types someone in", () => {
  const subject = {
    type: "new_panelist" as const,
    requisitionId: reqId,
    level: 2,
    needed: "Data governance for L2",
    reason: "Nobody in the directory covers data governance.",
  };

  test("the card goes to the HR head; a decline adds nobody; approval adds the typed person", async () => {
    const info = await gate.newPanelistGateFor(orgId, { ...subject, requisitionId: reqId });
    expect("error" in info).toBe(false);
    expect((info as { role: string }).role).toBe("hr_head");

    const count = async () => (await dir.listPanelists(orgId)).length;
    const n = await count();
    await gate.performNewPanelistGate(
      orgId,
      hrId,
      { ...subject, requisitionId: reqId },
      {
        status: "rejected",
      },
    );
    expect(await count()).toBe(n);

    await expect(
      gate.performNewPanelistGate(
        orgId,
        hrId,
        { ...subject, requisitionId: reqId },
        {
          status: "approved",
          args: { panelist: { fullName: "No Email" } },
        },
      ),
    ).rejects.toThrow(/name, e-mail/);

    await gate.performNewPanelistGate(
      orgId,
      hrId,
      { ...subject, requisitionId: reqId },
      {
        status: "approved",
        args: {
          panelist: {
            fullName: "Gopal Iyer",
            email: `gopal@${domain}`,
            kind: "internal",
            areas: ["Data governance"],
            rounds: [2],
          },
        },
      },
    );
    const gopal = (await dir.listPanelists(orgId)).find((p) => p.email === `gopal@${domain}`);
    expect(gopal).toMatchObject({ kind: "internal", member: false, selfApproved: true });
    const l2 = await panels.eligibleInterviewers(orgId, reqId, 2);
    expect(l2.people.some((p) => p.email === `gopal@${domain}`)).toBe(true);
  });

  test("an unknown requisition is refused", async () => {
    const info = await gate.newPanelistGateFor(orgId, {
      ...subject,
      requisitionId: "00000000-0000-0000-0000-000000000000",
    });
    expect(info).toMatchObject({ error: "Requisition not found." });
  });
});

describe("an external panellist's scorecard link", () => {
  let interviewId: string;
  let leelaId: string;
  const email = () => external.email.toLowerCase();

  beforeAll(async () => {
    leelaId = (await dir.listPanelists(orgId)).find((p) => p.email === email())!.id;
    interviewId = (
      await db
        .insert(interviews)
        .values({
          orgId,
          applicationId: appId,
          level: 1,
          interviewer: "Hema HR",
          interviewerEmail: `hr@${domain}`,
          panel: [{ name: "Leela Rao", email: email() }],
          scheduledAt: new Date(Date.now() + 2 * 3600_000),
          status: "scheduled",
        } as never)
        .returning({ id: interviews.id })
    )[0]!.id;
  });

  test("their brief carries the private link and leaves out internal material", async () => {
    const { sendInterviewerBrief } = await import("../src/lib/interviewer-brief.server");
    const [iv] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
    const [app] = await db.select().from(applications).where(eq(applications.id, appId));
    await sendInterviewerBrief(orgId, {
      interviewId,
      applicationId: appId,
      candidateId: app!.candidateId,
      level: 1,
      interviewerName: "Leela Rao",
      interviewerEmail: email(),
      scheduledAt: iv!.scheduledAt!,
      durationMins: 60,
      mode: "online",
      meetingLink: null,
      agenda: null,
    });
    const [mail] = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.toEmail, email())));
    const data = mail!.templateData as Record<string, string>;
    expect(data["scorecardUrl"]).toMatch(/\/scorecard\/[a-f0-9]{64}$/);
    expect(data["candidateUrl"]).toBeUndefined();
    expect(data["matchText"]).toBeUndefined();
    const [link] = await db
      .select()
      .from(panelistScorecardLinks)
      .where(eq(panelistScorecardLinks.interviewId, interviewId));
    // Only the hash is stored, never the token in the e-mail.
    const token = data["scorecardUrl"]!.split("/").pop()!;
    expect(link!.tokenHash).toBe(links.hashToken(token));
    expect(link!.tokenHash).not.toBe(token);
  });

  test("it opens only after the interview starts, scores once, and never opens an offer", async () => {
    const token = await links.issueScorecardLink(
      orgId,
      interviewId,
      leelaId,
      (await db.select().from(interviews).where(eq(interviews.id, interviewId)))[0]!.scheduledAt!,
    );
    expect((await links.publicScorecard(token))!.state).toBe("not_yet");
    await expect(
      links.submitByLink(token, {
        rating: 4,
        verdict: "select",
        comments: null,
        reason: null,
        competencies: [],
      }),
    ).rejects.toThrow(/scorecards open once it has started/);

    // The interview has taken place (moved into the past, same link re-issued for that time).
    const past = new Date(Date.now() - 3600_000);
    await db.update(interviews).set({ scheduledAt: past }).where(eq(interviews.id, interviewId));
    const live = await links.issueScorecardLink(orgId, interviewId, leelaId, past);
    const view = await links.publicScorecard(live);
    expect(view).toMatchObject({ state: "open", level: 1, candidateName: "Bala Candidate" });
    expect(JSON.stringify(view)).not.toContain("@");

    const r = await links.submitByLink(live, {
      rating: 4,
      verdict: "select",
      comments: "Clear Spark design.",
      reason: null,
      competencies: [],
    });
    expect(r.ok).toBe(true);
    const [ev] = await db
      .select()
      .from(evaluations)
      .where(
        and(eq(evaluations.interviewId, interviewId), eq(evaluations.evaluatorEmail, email())),
      );
    expect(ev).toMatchObject({ recommendation: "select", evaluator: `external:${email()}` });
    expect((await links.publicScorecard(live))!.state).toBe("submitted");
    await expect(
      links.submitByLink(live, {
        rating: 1,
        verdict: "reject",
        comments: null,
        reason: "changed my mind",
        competencies: [],
      }),
    ).rejects.toThrow(/already scored/);
    const [app] = await db.select().from(applications).where(eq(applications.id, appId));
    expect(["offer_pending", "offer_released", "offer_accepted"]).not.toContain(app!.stage);
  });

  test("an unknown token, or one past its expiry, opens nothing", async () => {
    expect(await links.publicScorecard("0".repeat(64))).toBeNull();
    const token = await links.issueScorecardLink(
      orgId,
      interviewId,
      leelaId,
      new Date(Date.now() - 30 * 864e5),
    );
    await db
      .update(panelistScorecardLinks)
      .set({ usedAt: null })
      .where(eq(panelistScorecardLinks.interviewId, interviewId));
    await db.delete(evaluations).where(eq(evaluations.interviewId, interviewId));
    expect((await links.publicScorecard(token))!.state).toBe("expired");
    await expect(
      links.submitByLink(token, {
        rating: 3,
        verdict: "hold",
        comments: null,
        reason: "unsure",
        competencies: [],
      }),
    ).rejects.toThrow(/expired/);
  });
});
