/**
 * Organisation profile, O0 (docs/org-context-agent-plan.md), against the
 * disposable database:
 *  - refusals: pay figures (money, LPA, lakh/crore/k or % next to a pay
 *    word) and staff names / e-mails / phones are refused with a reason and
 *    nothing is saved; the pay philosophy in words is kept;
 *  - versions: a draft by the HR head / CBO / owner, submitted, then
 *    approved, declined or sent back by the HR head or the owner only;
 *    approved versions never change; the next draft copies the approved one;
 *  - the approval card: an agent's request (gate subject org_profile) is
 *    decided through resolveTask as the person, never by the agent;
 *  - the hard gate: no requisition while the organisation requires an
 *    approved profile it lacks; every event audited; tenant-scoped.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/org-profile.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentRuns,
  agentTasks,
  auditLog,
  hrmsEmployees,
  orgMembers,
  orgProfileVersions,
  orgProfiles,
  organizations,
  sourceIntegrations,
  userRoles,
  users,
} = await import("../drizzle/schema");
const pure = await import("../src/lib/org-profile");
const core = await import("../src/lib/org-profile.server");
const runtime = await import("../src/server/agents/runtime.server");
const lifecycle = await import("../src/lib/requisitions.server");

const stamp = Date.now();
let orgId: string;
let otherOrgId: string;
let owner: string;
let hr: string;
let cbo: string;
let recruiter: string;
let outsider: string;
const as = (userId: string, org = orgId) => ({ orgId: org, userId });
const item = (
  text: string,
  visibility: "candidate" | "internal" = "candidate",
  id = crypto.randomUUID(),
) => ({ id, text, visibility, source: { kind: "person" as const } });

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const mk = async (tag: string, fullName: string | null = null) =>
    (
      await db
        .insert(users)
        .values({ email: `op-${tag}-${stamp}@test.local`, fullName })
        .returning({ id: users.id })
    )[0]!.id;
  [owner, hr, cbo, recruiter, outsider] = [
    await mk("owner"),
    await mk("hr", "Priya Raman"),
    await mk("cbo"),
    await mk("rec"),
    await mk("out"),
  ];
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Profile Org", slug: `op-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  otherOrgId = (
    await db
      .insert(organizations)
      .values({ name: "Other Org", slug: `op-other-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  for (const [u, isOwner, role, org] of [
    [owner, true, null, orgId],
    [hr, false, "hr_head", orgId],
    [cbo, false, "president_cbo", orgId],
    [recruiter, false, "recruiter", orgId],
    [outsider, true, null, otherOrgId],
  ] as const) {
    await db.insert(orgMembers).values({
      orgId: org,
      userId: u,
      email: `${u}@x.local`,
      status: "active",
      isOwner,
    } as never);
    if (role) await db.insert(userRoles).values({ userId: u, orgId: org, role });
  }
  const [integ] = await db
    .insert(sourceIntegrations)
    .values({ orgId, provider: `hrms-test-${stamp}`, label: "HRMS", category: "hrms" })
    .returning({ id: sourceIntegrations.id });
  await db.insert(hrmsEmployees).values({
    orgId,
    integrationId: integ!.id,
    externalId: "E1",
    fullName: "Arun Kumar",
    email: "arun.kumar@example.com",
  });
});

afterAll(async () => {
  await db.delete(organizations).where(inArray(organizations.id, [orgId, otherOrgId]));
  for (const u of [owner, hr, cbo, recruiter, outsider])
    await db.delete(users).where(eq(users.id, u));
});

const audits = async (action: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, `org_profile.${action}`)));
const reload = async (id: string) =>
  (await db.select().from(orgProfileVersions).where(eq(orgProfileVersions.id, id)))[0]!;

/* --------------------------------------------------------------- refusals */

describe("refusals (pure)", () => {
  test("pay figures are refused; the pay philosophy in words is kept", () => {
    for (const t of [
      "Freshers start at ₹4,50,000 a year",
      "Packages from INR 12 lakh",
      "Senior engineers earn 30 LPA",
      "Salary bands go up to 25 lakhs for leads",
      "Annual hike of 10% for top performers",
      "A joining bonus of 50k for nurses",
      "We pay $120,000 for staff roles",
    ])
      expect(pure.payFigureReason(t)).not.toBeNull();
    for (const t of [
      "We pay at or above the market median for critical skills",
      "30% of our workforce are women",
      "A team of 5k engineers across three cities",
      "Bands are shared with candidates at the offer stage",
      "ISO 27001:2013 certified; 24x7 operations",
    ])
      expect(pure.payFigureReason(t)).toBeNull();
  });

  test("staff names, e-mails and phone numbers are refused", () => {
    const names = pure.nameKeys([
      { name: "Priya Raman" },
      { name: "Arun S Kumar" },
      { name: "Asha" },
    ]);
    expect(pure.staffReason("Reach our recruiter at hr.team@acme.in", names)).toMatch(/e-mail/);
    expect(pure.staffReason("Call +91 98400 12345 for details", names)).toMatch(/phone/);
    expect(pure.staffReason("The HR head, Priya Raman, approves offers", names)).toMatch(
      /Priya Raman/,
    );
    expect(pure.staffReason("Led by arun kumar in Chennai", names)).toMatch(/Arun Kumar/);
    // One-word names are too common to match ("Asha" is also a word in Hindi).
    expect(pure.staffReason("Project Asha supports rural clinics", names)).toBeNull();
    expect(pure.staffReason("Reporting to the Head of Nursing", names)).toBeNull();
  });

  test("sections: unknown refused, internal-only forced internal, limits", () => {
    const out = pure.checkSections(
      {
        about: [item("A hospital chain in Tamil Nadu")],
        never_say: [item("Never mention the pending merger", "candidate")],
        nonsense: [item("x")],
        culture: [item("   ")],
      },
      [],
    );
    expect(out.problems).toEqual(['Unknown section "nonsense".']);
    expect(out.sections["never_say"]![0]!.visibility).toBe("internal");
    expect(out.sections["culture"]).toBeUndefined();
  });

  test("diff and what candidates may hear", () => {
    const keep = item("Values: care first", "candidate", "k");
    const before = { about: [item("Old text", "candidate", "a")], culture: [keep] };
    const after = {
      about: [item("New text", "candidate", "a")],
      culture: [keep],
      policies: [item("Police verification for all clinical roles", "internal", "p")],
    };
    const d = pure.diffSections(before, after);
    expect(d.map((x) => x.section)).toEqual(["about", "policies"]);
    expect(d[0]!.changed[0]!.after.text).toBe("New text");
    expect(pure.candidateVisible(after).map((v) => v.text)).toEqual([
      "New text",
      "Values: care first",
    ]);
  });
});

/* ------------------------------------------------------------ the lifecycle */

describe("versions and decisions", () => {
  let v1: string;

  test("only the HR head, CBO or owner write drafts", async () => {
    await expect(core.startDraftCore(as(recruiter))).rejects.toThrow(
      /HR head, the CBO or an owner/,
    );
    const d = await core.startDraftCore(as(hr));
    v1 = d.id;
    expect(d.version).toBe(1);
    // Only one open version: starting again returns the same draft.
    expect((await core.startDraftCore(as(cbo))).id).toBe(v1);
    expect(await audits("draft_started")).toHaveLength(1);
  });

  test("a refused item saves nothing and says why", async () => {
    const res = await core.saveDraftCore(as(hr), {
      versionId: v1,
      sections: {
        about: [item("A multi-speciality hospital chain")],
        hiring_norms: [item("Nurses earn 4 LPA to start", "internal", "pay")],
        structure: [item("Nursing is led by Arun Kumar", "internal", "name")],
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refused.map((r) => r.itemId).sort()).toEqual(["name", "pay"]);
    expect(Object.keys((await reload(v1)).sections)).toHaveLength(0);
    const [a] = await audits("items_refused");
    expect(JSON.stringify(a!.detail)).not.toContain("4 LPA"); // reasons, not the text
  });

  test("submit needs About; a pending version cannot be edited", async () => {
    await expect(core.submitDraftCore(as(hr), { versionId: v1 })).rejects.toThrow(/About/);
    const ok = await core.saveDraftCore(as(hr), {
      versionId: v1,
      sections: {
        about: [item("A multi-speciality hospital chain in Tamil Nadu")],
        hiring_norms: [item("We pay at the market median; bands are not shared", "internal")],
        never_say: [item("The planned acquisition")],
      },
    });
    expect(ok).toEqual({ ok: true, injectionFlagged: false });
    await core.submitDraftCore(as(hr), { versionId: v1 });
    expect((await reload(v1)).status).toBe("pending");
    await expect(
      core.saveDraftCore(as(hr), { versionId: v1, sections: { about: [item("x y")] } }),
    ).rejects.toThrow(/waiting for approval/);
  });

  test("only the HR head or owner decide; send back and decline need a reason", async () => {
    await expect(
      core.decideVersionCore(as(cbo), { versionId: v1, decision: "approve" }),
    ).rejects.toThrow(/HR head or an owner/);
    await expect(
      core.decideVersionCore(as(recruiter), { versionId: v1, decision: "approve" }),
    ).rejects.toThrow(/HR head or an owner/);
    await expect(
      core.decideVersionCore(as(hr), { versionId: v1, decision: "send_back", note: "" }),
    ).rejects.toThrow(/what should change/);
    // Another organisation's owner cannot see it at all.
    await expect(
      core.decideVersionCore(as(outsider, otherOrgId), { versionId: v1, decision: "approve" }),
    ).rejects.toThrow(/not found/);
    await core.decideVersionCore(as(hr), {
      versionId: v1,
      decision: "send_back",
      note: "Add our locations",
    });
    const v = await reload(v1);
    expect(v.status).toBe("changes_requested");
    expect(v.decisionNote).toBe("Add our locations");
    expect(await audits("sent_back")).toHaveLength(1);
  });

  test("resubmitted and approved by the owner: the current profile", async () => {
    const cur = await reload(v1);
    await core.saveDraftCore(as(cbo), {
      versionId: v1,
      sections: {
        ...cur.sections,
        locations: [item("Chennai and Coimbatore hospitals; rotating shifts", "candidate")],
      },
    });
    await core.submitDraftCore(as(cbo), { versionId: v1 });
    await core.decideVersionCore(as(owner), { versionId: v1, decision: "approve" });
    expect((await reload(v1)).status).toBe("approved");
    const [p] = await db.select().from(orgProfiles).where(eq(orgProfiles.orgId, orgId));
    expect(p!.currentVersionId).toBe(v1);
    expect(await audits("approved")).toHaveLength(1);
    // Approved versions never change.
    await expect(
      core.saveDraftCore(as(hr), { versionId: v1, sections: { about: [item("x y")] } }),
    ).rejects.toThrow(/Only a draft/);
  });

  test("the next draft copies the approved one; approving it supersedes v1", async () => {
    const d2 = await core.startDraftCore(as(hr));
    expect(d2.version).toBe(2);
    expect(d2.sections).toEqual((await reload(v1)).sections);
    await core.submitDraftCore(as(hr), { versionId: d2.id });
    await core.decideVersionCore(as(hr), { versionId: d2.id, decision: "approve" });
    expect((await reload(v1)).status).toBe("superseded");
    const state = await core.profileState(orgId);
    expect(state.approved!.id).toBe(d2.id);
    expect(state.open).toBeNull();
  });

  test("a draft can be discarded; declined versions stay on record", async () => {
    const d3 = await core.startDraftCore(as(hr));
    await core.discardDraftCore(as(hr), { versionId: d3.id });
    expect(await core.profileState(orgId).then((s) => s.open)).toBeNull();
    const d4 = await core.startDraftCore(as(hr));
    await core.submitDraftCore(as(hr), { versionId: d4.id });
    await core.decideVersionCore(as(owner), {
      versionId: d4.id,
      decision: "decline",
      note: "Not needed",
    });
    expect((await reload(d4.id)).status).toBe("declined");
    expect(await audits("draft_discarded")).toHaveLength(1);
    expect(await audits("declined")).toHaveLength(1);
  });
});

/* ------------------------------------------------------- the approval card */

describe("an agent's request is decided by a person", () => {
  async function gate(versionId: string) {
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "copilot",
        principalUserId: hr,
        goal: "keep the profile current",
        status: "awaiting_human",
      } as never)
      .returning({ id: agentRuns.id });
    const [task] = await db
      .insert(agentTasks)
      .values({
        orgId,
        runId: run!.id,
        kind: "gate",
        title: "Organisation profile approval",
        assigneeRole: "hr_head",
        proposedAction: {
          toolCallId: "t1",
          name: "request_approval",
          args: { subject: { type: "org_profile", versionId, expects: "pending" } },
        },
      } as never)
      .returning({ id: agentTasks.id });
    return { runId: run!.id, taskId: task!.id };
  }

  test("sent back from the card: the person's words on the task and the version", async () => {
    const d = await core.startDraftCore(as(hr));
    await core.submitDraftCore(as(hr), { versionId: d.id });
    const { taskId, runId } = await gate(d.id);
    await expect(
      runtime.resolveTask({
        orgId,
        taskId,
        userId: recruiter,
        decision: { status: "approved" },
      }),
    ).rejects.toThrow();
    expect((await reload(d.id)).status).toBe("pending");
    await runtime.resolveTask({
      orgId,
      taskId,
      userId: hr,
      decision: { status: "rejected", reason: "Add the policies", changes: true },
    });
    const v = await reload(d.id);
    expect(v.status).toBe("changes_requested");
    expect(v.decisionNote).toBe("Add the policies");
    const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
    expect(t!.status).toBe("rejected");
    expect(t!.response).toMatchObject({ reason: "Add the policies", changes: true });
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(r!.status).toBe("queued");
  });

  test("approved on the Profile page: the waiting request closes", async () => {
    const open = (await core.profileState(orgId)).open!;
    await core.submitDraftCore(as(hr), { versionId: open.id });
    const { taskId } = await gate(open.id);
    await core.decideVersionCore(as(owner), { versionId: open.id, decision: "approve" });
    const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
    expect(t!.status).toBe("approved");
  });

  test("the card states the changes and every candidate-visible line", () => {
    const text = runtime.orgProfileDetail(
      { about: [item("Old", "candidate", "a")] },
      {
        version: 3,
        injectionFlagged: true,
        sections: {
          about: [item("A bank for small businesses", "candidate", "a")],
          tone: [item("Warm and plain")],
        },
      },
    );
    expect(text).toContain("About: 1 changed");
    expect(text).toContain("Candidates may hear or read (1)");
    expect(text).toContain("A bank for small businesses");
    expect(text).not.toContain("Warm and plain");
    expect(text).toContain("looks like instructions");
  });
});

/* ------------------------------------------------------------ the hard gate */

describe("require an approved profile before roles are raised", () => {
  const fields = {
    title: "Staff Nurse",
    departmentId: null,
    location: "Chennai",
    openings: 1,
    experienceMin: 1,
    experienceMax: 3,
    budgetCtc: 0,
    ctcBandMin: null,
    ctcBandMax: null,
    maxNoticePeriodDays: null,
    workAuthorizationRequired: null,
    hiringManager: null,
    mustHaveSkills: [],
    goodToHaveSkills: [],
    responsibilities: null,
    educationRequirement: null,
    billingType: "internal",
    engagementType: "full_time",
    clientName: null,
    costCenter: null,
  };

  test("only the HR head or owner change it; audited", async () => {
    await expect(
      core.setRequireProfileCore(as(recruiter, otherOrgId), { required: true }),
    ).rejects.toThrow();
    await expect(core.setRequireProfileCore(as(cbo), { required: true })).rejects.toThrow(
      /HR head or an owner/,
    );
    await core.setRequireProfileCore(as(outsider, otherOrgId), { required: true });
    const [a] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.orgId, otherOrgId), eq(auditLog.action, "org_profile.require_changed")),
      );
    expect(a!.detail).toEqual({ required: true });
  });

  test("refused without an approved profile; allowed once approved or not required", async () => {
    const actor = { orgId: otherOrgId, userId: outsider, memberEmail: "o@x.local" };
    await expect(lifecycle.createRequisitionCore(actor, fields as never, "draft")).rejects.toThrow(
      /requires an approved organisation profile/,
    );
    // orgId (above) has an approved profile and requires it: allowed.
    await core.setRequireProfileCore(as(hr), { required: true });
    const made = await lifecycle.createRequisitionCore(
      { orgId, userId: hr, memberEmail: "h@x.local" },
      fields as never,
      "draft",
    );
    expect(made.code).toMatch(/^REQ-/);
    await core.setRequireProfileCore(as(outsider, otherOrgId), { required: false });
    expect((await lifecycle.createRequisitionCore(actor, fields as never, "draft")).code).toMatch(
      /^REQ-/,
    );
    expect(await core.profileGate(otherOrgId)).toEqual({ approved: false, required: false });
  });
});
