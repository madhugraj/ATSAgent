/**
 * Publishing channels, role supply and the Sourcing agent's data
 * (src/server/agents/sourcing.server.ts) plus the desk's supply features —
 * next steps after JD approval, re-scoring, new-applicant announcements and
 * fresh applicants scored within minutes — against the disposable database.
 * No AI key is saved for the test org, so skill expansion falls back to the
 * must-haves themselves and nothing leaves the machine.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/agent-sourcing.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentPolicies,
  agentRuns,
  applications,
  auditLog,
  candidates,
  emailOutbox,
  hiringConversations,
  hiringMessages,
  jobDescriptions,
  matchScores,
  orgMembers,
  organizations,
  requisitions,
  users,
} = await import("../drizzle/schema");
const sourcing = await import("../src/server/agents/sourcing.server");
const desk = await import("../src/server/desk/desk.server");
await import("../src/server/agents");
const { getTool } = await import("../src/server/agents/registry");

const stamp = Date.now();
let orgId: string;
let userId: string;
let role: string;
let earlier: string;

async function candidate(name: string, values: Record<string, unknown> = {}) {
  const [c] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: name,
      email: `${name.toLowerCase()}-${stamp}@cand.local`,
      skills: ["Figma", "React"],
      ...values,
    } as never)
    .returning({ id: candidates.id });
  return c!.id;
}
async function apply(
  requisitionId: string,
  candidateId: string,
  stage = "applied",
  source = "careers_inbox",
) {
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId, candidateId, stage: stage as never, source })
    .returning({ id: applications.id });
  return a!.id;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db
    .insert(users)
    .values({ email: `src-${stamp}@test.local` })
    .returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Sourcing Org", slug: `src-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId,
    email: `src-${stamp}@test.local`,
    status: "active",
    isOwner: true,
  });
  const req = async (code: string, status: string) =>
    (
      await db
        .insert(requisitions)
        .values({
          orgId,
          code,
          title: "UI/UX Engineer",
          location: "Remote",
          status: status as never,
          openings: 1,
          mustHaveSkills: ["Figma"],
          createdBy: userId,
        })
        .returning({ id: requisitions.id })
    )[0]!.id;
  role = await req(`REQ-S-${stamp}`, "approved");
  earlier = await req(`REQ-S0-${stamp}`, "closed");
  await db.insert(jobDescriptions).values({
    orgId,
    requisitionId: role,
    version: 1,
    status: "approved",
    fullText: "UI/UX JD",
  } as never);
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await db.delete(hiringConversations).where(eq(hiringConversations.orgId, orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(applications).where(eq(applications.orgId, orgId));
  await db.delete(candidates).where(eq(candidates.orgId, orgId));
  await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgId));
  await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
});

describe("channels and supply", () => {
  test("channels report the real state: nothing connected, apply link, internal posting", async () => {
    const c = await sourcing.publishChannels(orgId, role);
    expect(c.applyUrl).toMatch(new RegExp(`/apply/${role}$`));
    expect(c.internal.live).toBe(false);
    expect(c.boards.map((b) => b.provider)).toEqual(["linkedin", "naukri", "indeed"]);
    for (const b of c.boards) {
      expect(b).toMatchObject({ connected: false, canPost: false, live: null });
      expect(b.detail).toBeTruthy();
    }
  });

  test("traction counts applicants by source and says why a role is starving", async () => {
    await apply(role, await candidate("Asha"), "applied", "careers_inbox");
    await apply(role, await candidate("Bala"), "applied", "agent_talent_pool");
    const t = await sourcing.roleTraction(orgId, role);
    expect(t.applicants).toMatchObject({
      total: 2,
      // Agent-added people are not "arrivals".
      last7Days: 1,
      bySource: { careers_inbox: 1, agent_talent_pool: 1 },
    });
    expect(t.daysLive).toBeNull();
    expect(t.starving).toBe(true);
    expect(t.verdict).toMatch(/not published anywhere yet/);
    expect(t.verdict).toMatch(/0 shortlisted for 1 opening\(s\) \(wanted 3\)/);
  });

  test("past candidates: did well elsewhere, consented, not employees, not in this pipeline", async () => {
    await apply(earlier, await candidate("Priya"), "l1");
    await apply(earlier, await candidate("Quiet", { consentGiven: false }), "l1");
    await apply(earlier, await candidate("Rejected"), "rejected");
    const hired = await candidate("Hired");
    await apply(earlier, hired, "l2");
    const [third] = await db
      .insert(requisitions)
      .values({ orgId, code: `REQ-S1-${stamp}`, title: "Designer", status: "closed" } as never)
      .returning({ id: requisitions.id });
    await apply(third!.id, hired, "hired");
    const inPipe = await candidate("Already");
    await apply(earlier, inPipe, "reserve");
    await apply(role, inPipe);
    const r = await sourcing.pastCandidates(orgId, role);
    expect(r.matches.map((m) => m.name)).toEqual(["Priya"]);
    expect(r.matches[0]).toMatchObject({ pastStage: "l1", hasEmail: true });
    expect(r.matches[0]!.why).toMatch(/reached l1 for UI\/UX Engineer/);
  });

  test("invite_to_apply emails eligible past candidates once, and skips the rest", async () => {
    const priya = await candidate("Priya");
    await apply(earlier, priya, "l1");
    const quiet = await candidate("Quiet", { consentGiven: false });
    await apply(earlier, quiet, "l1");
    const tool = getTool("invite_to_apply")!;
    const ctx = {
      orgId,
      principalUserId: userId,
      runId: crypto.randomUUID(),
      agentType: "sourcing",
      actor: "agent:sourcing:test",
    };
    const out = (await tool.run(
      ctx as never,
      {
        requisitionId: role,
        candidateIds: [priya, quiet],
      } as never,
    )) as { invited: string[]; skipped: { reason: string }[] };
    expect(out.invited).toEqual(["Priya"]);
    expect(out.skipped[0]!.reason).toMatch(/consented/);
    const mails = await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ kind: "role_invite" });
    // Invited for this role: not offered again within 30 days.
    expect((await sourcing.pastCandidates(orgId, role)).matches).toHaveLength(0);
  });
});

describe("new CV → open roles", () => {
  test("a new CV that fits an open role joins its pipeline once (audited); others are left alone", async () => {
    const { matchNewCvsToRoles } = await import("../src/server/agents/pool-match.server");
    const fits = await candidate("Meera", { skills: ["Figma", "Prototyping"] });
    await candidate("Ravi", { skills: ["Excel"] });
    await candidate("Staff", { skills: ["Figma"], isInternal: true });
    const old = await candidate("Old", { skills: ["Figma"] });
    await db
      .update(candidates)
      .set({ createdAt: new Date(Date.now() - 30 * 864e5) })
      .where(eq(candidates.id, old));
    const r = await matchNewCvsToRoles(orgId);
    // Employees (internal candidates) apply through the internal job board; not checked.
    expect(r.checked).toBe(2);
    expect(r.added.map((a) => a.name)).toEqual(["Meera"]);
    const [app] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.candidateId, fits), eq(applications.requisitionId, role)));
    expect(app!.source).toBe("pool_match");
    expect((await matchNewCvsToRoles(orgId)).checked).toBe(0);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "pool.matched_to_role")));
    expect(audit!.entityId).toBe(role);
    // A pool match is not channel traction.
    expect((await sourcing.roleTraction(orgId, role)).applicants.last7Days).toBe(0);
  });
});

describe("desk: after the JD, and new applicants", () => {
  async function thread() {
    const [c] = await db
      .insert(hiringConversations)
      .values({ orgId, createdBy: userId, requisitionId: role, status: "active" })
      .returning();
    return c!;
  }
  const messages = (id: string) =>
    db
      .select()
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, id))
      .orderBy(hiringMessages.createdAt);

  test("JD approved: next steps say who works and who is switched off", async () => {
    const conv = await thread();
    await db.insert(agentPolicies).values({ orgId, agentType: "intake", enabled: true });
    await desk.onJdApproved(orgId, role, null);
    const m = await messages(conv.id);
    const steps = m.find((x) => (x.card as { type?: string } | null)?.type === "next_steps")!;
    expect(steps.body).toMatch(/Publishing agent and Sourcing agent are switched off/);
    expect((steps.card as { items: { agentType: string; enabled: boolean }[] }).items).toEqual([
      expect.objectContaining({ agentType: "intake", enabled: true }),
      expect.objectContaining({ agentType: "publishing", enabled: false }),
      expect.objectContaining({ agentType: "sourcing", enabled: false }),
    ]);
  });

  test("a later JD version offers to re-score; re-scoring replaces the old scores (audited)", async () => {
    const conv = await thread();
    const app = await apply(role, await candidate("Asha"), "shortlisted");
    await db.insert(matchScores).values({ orgId, applicationId: app, overallScore: 80 } as never);
    const [v2] = await db
      .insert(jobDescriptions)
      .values({
        orgId,
        requisitionId: role,
        version: 2,
        status: "approved",
        fullText: "v2",
      } as never)
      .returning({ id: jobDescriptions.id });
    try {
      await desk.onJdApproved(orgId, role, v2!.id);
      const card = (await messages(conv.id)).find(
        (x) => (x.card as { type?: string } | null)?.type === "rescore",
      )?.card;
      expect(card).toMatchObject({ type: "rescore", count: 1, version: 2 });
      await desk.rescoreThread(await desk.loadConversation(orgId, conv.id), userId);
      expect(
        await db.select().from(matchScores).where(eq(matchScores.applicationId, app)),
      ).toHaveLength(0);
      const [a] = await db.select().from(applications).where(eq(applications.id, app));
      expect(a!.stage).toBe("shortlisted");
      const [audit] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "desk.candidates_rescored")));
      expect(audit!.detail).toMatchObject({ scoresReplaced: 1 });
    } finally {
      await db.delete(jobDescriptions).where(eq(jobDescriptions.id, v2!.id));
    }
  });

  test("new applicants are announced once, by channel; agent additions are not", async () => {
    const conv = await thread();
    await apply(role, await candidate("Asha"), "applied", "careers_inbox");
    await apply(role, await candidate("Bala"), "applied", "careers_inbox");
    await apply(role, await candidate("Chitra"), "applied", "agent_talent_pool");
    expect(await desk.announceNewApplicants(orgId)).toBe(1);
    const last = (await messages(conv.id)).at(-1)!;
    expect(last.body).toMatch(/^2 new applicant\(s\): 2 via careers inbox — Asha, Bala/);
    expect(await desk.announceNewApplicants(orgId)).toBe(0);
  });

  test("fresh applicants start an intake run within minutes, once", async () => {
    await db.insert(agentPolicies).values({ orgId, agentType: "intake", enabled: true });
    await apply(role, await candidate("Asha"), "applied", "careers_inbox");
    const { scheduleSweeps } = await import("../src/server/agents/orchestrator.server");
    await scheduleSweeps({ orgId });
    const runs = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "intake")));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.goal).toMatch(/1 new application\(s\) arrived .* \(via careers_inbox\)/);
    await scheduleSweeps({ orgId });
    expect(
      await db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "intake"))),
    ).toHaveLength(1);
  });

  test("a starving role gets the Sourcing agent once a day", async () => {
    await db.insert(agentPolicies).values({ orgId, agentType: "sourcing", enabled: true });
    expect((await sourcing.starvingRoles(orgId)).map((r) => r.id)).toEqual([role]);
    const { scheduleSweeps } = await import("../src/server/agents/orchestrator.server");
    await scheduleSweeps({ orgId });
    await scheduleSweeps({ orgId });
    const runs = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "sourcing")));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.subjectId).toBe(role);
  });

  test("switching the Publishing agent on from the thread starts publishing (audited)", async () => {
    const conv = await thread();
    const runId = await desk.enableAgentForThread(conv, userId, "publishing");
    expect(runId).toBeTruthy();
    const [p] = await db
      .select()
      .from(agentPolicies)
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, "publishing")));
    expect(p!.enabled).toBe(true);
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId!));
    expect(r).toMatchObject({ agentType: "publishing", conversationId: conv.id });
  });
});
