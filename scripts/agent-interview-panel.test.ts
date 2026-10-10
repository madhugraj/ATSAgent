/**
 * Interview plans, panels and decisions against the disposable database:
 *  1. the hiring decision (select → offer) only after the role's final round;
 *  2. a per-role plan and rubric from the must-haves (editable, validated);
 *  3. panels: every interviewer briefed, one scorecard each, the round
 *     completes when all have scored;
 *  4. verdict policy: holds / rejects are recommendations unless "immediate";
 *  5. rounds that did not happen: recorded, the team told, new times offered.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/agent-interview-panel.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  agentIssues,
  agentPolicies,
  agentRuns,
  applications,
  candidates,
  emailOutbox,
  evaluations,
  hiringConversations,
  hiringMessages,
  interviews,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const planLib = await import("../src/lib/interview-plan");
const planServer = await import("../src/lib/interview-plan.server");
const iv = await import("../src/lib/interviews.functions");
await import("../src/server/agents");
const { getTool } = await import("../src/server/agents/registry");

const stamp = Date.now();
let orgId: string;
let role: string;
let app: string;
const people: { id: string; email: string; name: string }[] = [];
const [A, B, C] = [0, 1, 2];

async function user(name: string, roles: string[] = []) {
  const email = `${name.toLowerCase()}-${stamp}@test.local`;
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  await db.insert(orgMembers).values({
    orgId,
    userId: u!.id,
    email,
    fullName: name,
    status: "active",
    isOwner: false,
  } as never);
  for (const r of roles)
    await db.insert(userRoles).values({ userId: u!.id, orgId, role: r as never });
  people.push({ id: u!.id, email, name });
}
const ctx = (i: number) => ({
  orgId,
  userId: people[i]!.id,
  email: people[i]!.email,
  actor: people[i]!.email,
});
const card = (level: number, verdict: "select" | "hold" | "reject", interviewId?: string) => ({
  applicationId: app,
  interviewId: interviewId ?? null,
  level,
  rating: verdict === "select" ? 4 : 2,
  verdict,
  comments: verdict === "select" ? "Strong" : "Weak on the must-haves",
  competencies: [{ name: "Figma", rating: verdict === "select" ? 4 : 2 }],
});
const stage = async () =>
  (await db.select().from(applications).where(eq(applications.id, app)))[0]!.stage;
const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString();

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [o] = await db
    .insert(organizations)
    .values({ name: "Panel Org", slug: `panel-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  await user("Priya", ["hiring_manager"]);
  await user("Ravi", ["department_head"]);
  await user("Sam", ["recruiter"]);
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-P-${stamp}`,
      title: "UI/UX Engineer",
      status: "approved",
      mustHaveSkills: ["Figma", "Design systems", "React", "Accessibility", "Prototyping"],
      createdBy: people[C]!.id,
    })
    .returning({ id: requisitions.id });
  role = r!.id;
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Asha Raman", email: `asha-${stamp}@cand.local` })
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: role, candidateId: c!.id, stage: "shortlisted" })
    .returning({ id: applications.id });
  app = a!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const p of people) await db.delete(users).where(eq(users.id, p.id));
});

beforeEach(async () => {
  await db.delete(evaluations).where(eq(evaluations.orgId, orgId));
  await db.delete(interviews).where(eq(interviews.orgId, orgId));
  await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgId));
  await db.delete(agentEvents).where(eq(agentEvents.orgId, orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentIssues).where(eq(agentIssues.orgId, orgId));
  await db.delete(hiringConversations).where(eq(hiringConversations.orgId, orgId));
  await db.update(requisitions).set({ interviewPlan: null }).where(eq(requisitions.id, role));
  await db.update(applications).set({ stage: "shortlisted" }).where(eq(applications.id, app));
});

async function book(level: number, panel: number[] = []) {
  await iv.scheduleInterviewCore(
    { orgId, actor: "test" },
    {
      applicationId: app,
      level,
      interviewer: people[A]!.name,
      interviewerEmail: people[A]!.email,
      scheduledAt: future(2 + level),
      durationMins: 60,
      mode: "online",
      panel: panel.map((i) => ({ email: people[i]!.email })),
    },
  );
  const [r] = await db
    .select()
    .from(interviews)
    .where(and(eq(interviews.applicationId, app), eq(interviews.level, level)));
  return r!;
}
const events = async (type: string) =>
  db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, type)));

/* --------------------------------------------------------------- 2. plan */

describe("the role's interview plan", () => {
  test("default rounds and rubric come from the must-haves", async () => {
    const { plan, saved } = await planServer.planFor(orgId, role);
    expect(saved).toBe(false);
    expect(plan.rounds.map((r) => r.level)).toEqual([1, 2, 3]);
    expect(plan.rounds[0]!.competencies).toEqual([
      "Figma",
      "Design systems",
      "React",
      "Accessibility",
      "Problem solving",
    ]);
    expect(plan.rounds[1]!.competencies).toContain("Prototyping");
    expect(plan.verdictPolicy).toBe("recommend");
  });

  test("a saved plan is validated and used; rounds must be in order", async () => {
    const two = {
      verdictPolicy: "recommend",
      rounds: [
        { level: 1, name: "Craft", focus: "", competencies: ["Figma"], panelSize: 2 },
        { level: 2, name: "Fit", focus: "", competencies: ["Ownership"], panelSize: 1 },
      ],
    };
    await planServer.savePlan(orgId, role, two);
    const { plan, saved } = await planServer.planFor(orgId, role);
    expect(saved).toBe(true);
    expect(planLib.finalLevel(plan)).toBe(2);
    await expect(
      planServer.savePlan(orgId, role, { ...two, rounds: [two.rounds[1]] }),
    ).rejects.toThrow(/numbered 1, 2, 3/);
  });

  test("progression rules", () => {
    expect(iv.progressionFor(1, "select", 3, "recommend")).toBe("l2");
    expect(iv.progressionFor(3, "select", 3, "recommend")).toBeNull();
    expect(iv.progressionFor(1, "reject", 3, "recommend")).toBeNull();
    expect(iv.progressionFor(1, "reject", 3, "immediate")).toBe("rejected");
    expect(iv.progressionFor(2, "hold", 3, "immediate")).toBe("on_hold");
    expect(iv.progressionFor(2, "select", 2, "immediate")).toBe("offer_pending");
    expect(planLib.roundVerdict(["select", "hold", "select"])).toBe("hold");
    expect(planLib.roundVerdict(["select", "reject", "hold"])).toBe("reject");
  });
});

/* ------------------------------------------------------------- 3. panels */

describe("panels", () => {
  test("every interviewer on the panel gets their brief; non-members are refused", async () => {
    const r = await book(1, [B]);
    expect(r.panel).toEqual([{ name: "Ravi", email: people[B]!.email }]);
    const briefs = (await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId)))
      .filter((m) => m.kind === "interviewer_brief")
      .map((m) => m.toEmail)
      .sort();
    expect(briefs).toEqual([people[A]!.email, people[B]!.email].sort());
    const brief = (await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId))).find(
      (m) => m.kind === "interviewer_brief",
    )!;
    expect(brief.templateData).toMatchObject({
      panelText: "Priya, Ravi",
      competencies: "Figma, Design systems, React, Accessibility, Problem solving",
    });
    await expect(
      iv.scheduleInterviewCore(
        { orgId, actor: "test" },
        {
          applicationId: app,
          level: 2,
          interviewerEmail: people[A]!.email,
          scheduledAt: future(5),
          durationMins: 60,
          mode: "online",
          panel: [{ email: "stranger@else.where" }],
        },
      ),
    ).rejects.toThrow(/Panel members must be active members/);
  });

  test("the round completes only when everyone has scored; one scorecard each; only the panel", async () => {
    const r = await book(1, [B]);
    const first = await iv.submitScorecardCore(ctx(A), card(1, "select", r.id));
    expect(first).toMatchObject({
      roundComplete: false,
      waitingFor: [people[B]!.email],
      movedTo: null,
    });
    expect(await stage()).toBe("l1");
    expect(await events("scorecard.submitted")).toHaveLength(0);
    await expect(iv.submitScorecardCore(ctx(A), card(1, "select", r.id))).rejects.toThrow(
      /already scored this round/,
    );
    await expect(iv.submitScorecardCore(ctx(C), card(1, "select", r.id))).rejects.toThrow(
      /Only the interviewers on this round/,
    );
    const second = await iv.submitScorecardCore(ctx(B), card(1, "select", r.id));
    expect(second).toMatchObject({
      roundComplete: true,
      movedTo: "l2",
      nextInterviewCreated: true,
    });
    const [ev] = await events("scorecard.submitted");
    expect(ev!.payload).toMatchObject({
      level: 1,
      verdict: "select",
      roundComplete: true,
      finalRound: false,
    });
    const [done] = await db.select().from(interviews).where(eq(interviews.id, r.id));
    expect(done!.status).toBe("completed");
  });

  test("pending scorecards are listed per interviewer still to score", async () => {
    const r = await book(1, [B]);
    await db
      .update(interviews)
      .set({ scheduledAt: new Date(Date.now() - 5 * 3600_000) })
      .where(eq(interviews.id, r.id));
    await iv.submitScorecardCore(ctx(A), card(1, "select", r.id));
    const tool = getTool("list_pending_scorecards")!;
    const rows = (await tool.run(
      {
        orgId,
        principalUserId: people[C]!.id,
        runId: crypto.randomUUID(),
        agentType: "followup",
        actor: "t",
      } as never,
      { requisitionId: role } as never,
    )) as { interviewerEmail: string; interviewerUserId: string | null }[];
    expect(rows).toEqual([
      expect.objectContaining({
        interviewerEmail: people[B]!.email,
        interviewerUserId: people[B]!.id,
      }),
    ]);
  });

  test("free times suit the whole panel", async () => {
    const { findFreeSlots } = await import("../src/lib/calendar-availability.server");
    const first = await findFreeSlots(orgId, {
      interviewerEmail: people[A]!.email,
      durationMins: 60,
      count: 3,
      timeZone: "UTC",
    });
    // Ravi is busy at Priya's first free time.
    await db.insert(interviews).values({
      orgId,
      applicationId: app,
      level: 3,
      interviewerEmail: people[B]!.email,
      scheduledAt: new Date(first.slots[0]!),
      durationMins: 60,
    });
    const both = await findFreeSlots(orgId, {
      interviewerEmail: people[A]!.email,
      panelEmails: [people[B]!.email],
      durationMins: 60,
      count: 5,
      timeZone: "UTC",
    });
    expect(both.slots).not.toContain(first.slots[0]);
  });
});

/* --------------------------------------------------------- 4. verdicts */

describe("verdict policy", () => {
  test("recommend (default): a reject moves nobody; the hiring manager decides", async () => {
    const r = await book(1);
    const res = await iv.submitScorecardCore(ctx(A), card(1, "reject", r.id));
    expect(res).toMatchObject({ roundComplete: true, movedTo: null });
    expect(res.decisionPending).toMatch(/hiring manager decides/);
    expect(await stage()).toBe("l1");
    const [ev] = await events("scorecard.submitted");
    expect(ev!.payload).toMatchObject({ verdict: "reject" });
  });

  test("immediate: the round's verdict moves the candidate", async () => {
    const { plan } = await planServer.planFor(orgId, role);
    await planServer.savePlan(orgId, role, { ...plan, verdictPolicy: "immediate" });
    const r = await book(1);
    await iv.submitScorecardCore(ctx(A), { ...card(1, "reject", r.id) });
    expect(await stage()).toBe("rejected");
  });

  test("a panel's verdict is the most cautious one", async () => {
    const r = await book(1, [B]);
    await iv.submitScorecardCore(ctx(A), card(1, "select", r.id));
    const res = await iv.submitScorecardCore(ctx(B), card(1, "hold", r.id));
    expect(res).toMatchObject({ roundComplete: true, movedTo: null });
    const [ev] = await events("scorecard.submitted");
    expect(ev!.payload).toMatchObject({ verdict: "hold" });
  });
});

/* ------------------------------------------------- 1. decision timing */

describe("the hiring decision comes after the final round", () => {
  test("select is refused until the final round is complete; hold / reject after any round", async () => {
    expect(await planServer.hiringDecisionBlocked(orgId, app, "reject")).toMatch(
      /No interview round/,
    );
    const r1 = await book(1);
    await iv.submitScorecardCore(ctx(A), card(1, "select", r1.id));
    expect(await planServer.hiringDecisionBlocked(orgId, app, "select")).toMatch(
      /Too early for a select: .* final one \(L3\) is not complete \(complete: L1\)/,
    );
    expect(await planServer.hiringDecisionBlocked(orgId, app, "hold")).toBeNull();
    for (const level of [2, 3]) {
      const r = await book(level);
      await iv.submitScorecardCore(ctx(A), card(level, "select", r.id));
    }
    expect(await planServer.hiringDecisionBlocked(orgId, app, "select")).toBeNull();
    // After the final select nothing moves on its own: the hiring manager decides.
    expect(await stage()).toBe("l3");
    const last = (await events("scorecard.submitted")).find(
      (e) => (e.payload as { level: number }).level === 3,
    );
    expect(last!.payload).toMatchObject({ finalRound: true });
  });

  test("the Evaluation agent is told to debrief only after an earlier select, and to ask after the final round", async () => {
    await db
      .insert(agentPolicies)
      .values(
        ["evaluation", "interview"].map((agentType) => ({
          orgId,
          agentType: agentType as never,
          enabled: true,
        })),
      )
      .onConflictDoNothing();
    const { processAgentEvents } = await import("../src/server/agents/orchestrator.server");
    const r1 = await book(1);
    await iv.submitScorecardCore(ctx(A), card(1, "select", r1.id));
    await processAgentEvents({ orgId });
    const [run1] = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "evaluation")));
    expect(run1!.goal).toMatch(/not the final round .* do not request a hiring decision/);
  });
});

/* -------------------------------------------- 5. rounds that did not happen */

describe("no-shows and cancellations", () => {
  test("recorded, the thread told, new times requested; the round cannot be scored", async () => {
    const [conv] = await db
      .insert(hiringConversations)
      .values({ orgId, createdBy: people[C]!.id, requisitionId: role, status: "active" })
      .returning();
    const r = await book(1);
    await iv.markInterviewOutcomeCore(
      { orgId, userId: people[A]!.id, email: people[A]!.email },
      { interviewId: r.id, outcome: "candidate_no_show", note: "Waited 15 minutes" },
    );
    const [row] = await db.select().from(interviews).where(eq(interviews.id, r.id));
    expect(row).toMatchObject({
      status: "no_show",
      outcomeNote: "the candidate did not join — Waited 15 minutes",
    });
    expect(await stage()).toBe("l1");
    expect(await events("interview.missed")).toHaveLength(1);
    const [msg] = await db
      .select()
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, conv!.id));
    expect(msg!.body).toMatch(/did not happen: the candidate did not join \("Waited 15 minutes"\)/);
    await expect(iv.submitScorecardCore(ctx(A), card(1, "select", r.id))).rejects.toThrow(
      /did not take place/,
    );
    await expect(
      iv.markInterviewOutcomeCore(
        { orgId, userId: people[A]!.id, email: people[A]!.email },
        { interviewId: r.id, outcome: "cancelled", note: "" },
      ),
    ).rejects.toThrow(/only a booked round can be marked/);
    // The coordinator is asked to offer new times.
    await db
      .insert(agentPolicies)
      .values({ orgId, agentType: "interview", enabled: true })
      .onConflictDoNothing();
    const { processAgentEvents } = await import("../src/server/agents/orchestrator.server");
    await processAgentEvents({ orgId });
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "interview")));
    expect(run!.goal).toMatch(/did not happen \(candidate no show\)\. Offer new times/);
  });

  test("health: repeated candidate no-shows are flagged", async () => {
    const { evaluateAgentHealth } = await import("../src/server/agents/health.server");
    for (let i = 0; i < 3; i++)
      await db.insert(interviews).values({
        orgId,
        applicationId: app,
        level: 1,
        status: "no_show",
        scheduledAt: new Date(Date.now() - (i + 1) * 3600_000),
      });
    await evaluateAgentHealth({ orgId });
    const issues = await db
      .select()
      .from(agentIssues)
      .where(and(eq(agentIssues.orgId, orgId), eq(agentIssues.rule, "interview.no_shows")));
    expect(issues).toHaveLength(1);
  });
});
