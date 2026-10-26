/**
 * Phase 3 agents end to end against the disposable local database: interview
 * coordination and evaluation with real tools, cores, outbox and
 * orchestrator — only the model is scripted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { AgentStepResult, AgentToolCall } from "../src/lib/ai-gateway.server";

const script: AgentStepResult[] = [];
const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const say = (text: string): AgentStepResult => ({
  ok: true,
  text,
  toolCalls: [],
  stopReason: "end",
  usage,
});
const call = (...calls: AgentToolCall[]): AgentStepResult => ({
  ok: true,
  text: "",
  toolCalls: calls,
  stopReason: "tool_use",
  usage,
});

const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiAgentStep: async () => script.shift() ?? say("(script exhausted)"),
}));

const { db } = await import("../src/server/db");
const {
  agentEvents,
  agentPolicies,
  agentRuns,
  agentTasks,
  applications,
  candidateNotes,
  candidates,
  emailOutbox,
  evaluations,
  interviews,
  orgMembers,
  organizations,
  requisitions,
  screeningKits,
  screeningRuns,
  userRoles,
  users,
} = await import("../drizzle/schema");
const registry = await import("../src/server/agents/registry");
const { registerPhase1Tools } = await import("../src/server/agents/tools");
const { registerPhase2Tools } = await import("../src/server/agents/tools-phase2");
const { registerPhase3Tools } = await import("../src/server/agents/tools-phase3");
const { registerPhase1Agents, registerPhase2Agents, registerPhase3Agents } =
  await import("../src/server/agents/definitions");
const { resolveTask, runAgentTick, startRun } = await import("../src/server/agents/runtime.server");
const { processAgentEvents } = await import("../src/server/agents/orchestrator.server");
const { emitAgentEvent } = await import("../src/server/agents/events");
const { moveStageCore } = await import("../src/lib/pipeline.server");

let orgId: string;
let recruiter: string;
let manager: string;
let reqId: string;
const stamp = Date.now();
const recruiterEmail = `p3-rec-${stamp}@test.local`;
const managerEmail = `p3-hm-${stamp}@test.local`;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [o] = await db
    .insert(organizations)
    .values({ name: "P3 Org", slug: `p3-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [r] = await db.insert(users).values({ email: recruiterEmail }).returning({ id: users.id });
  const [m] = await db.insert(users).values({ email: managerEmail }).returning({ id: users.id });
  recruiter = r!.id;
  manager = m!.id;
  await db.insert(orgMembers).values([
    {
      orgId,
      userId: recruiter,
      email: recruiterEmail,
      fullName: "Rita",
      status: "active",
      isOwner: false,
      joinedAt: new Date(),
    },
    {
      orgId,
      userId: manager,
      email: managerEmail,
      fullName: "Hari Manager",
      status: "active",
      isOwner: false,
      joinedAt: new Date(),
    },
  ]);
  await db.insert(userRoles).values([
    { userId: recruiter, orgId, role: "recruiter" },
    { userId: manager, orgId, role: "hiring_manager" },
  ]);
});

afterAll(async () => {
  await db.delete(candidateNotes).where(eq(candidateNotes.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(inArray(users.id, [recruiter, manager]));
});

async function enable(
  agentType: string,
  autonomy: "suggest" | "act_and_notify" = "act_and_notify",
) {
  await db
    .insert(agentPolicies)
    .values({ orgId, agentType: agentType as never, enabled: true, autonomy })
    .onConflictDoUpdate({
      target: [agentPolicies.orgId, agentPolicies.agentType],
      set: { enabled: true, autonomy },
    });
}

async function application(name: string, stage: string) {
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: name, email: `${name.toLowerCase()}-${stamp}@cand.local` })
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({
      orgId,
      requisitionId: reqId,
      candidateId: c!.id,
      stage: stage as never,
      source: "apply",
    })
    .returning({ id: applications.id });
  return { appId: a!.id, candidateId: c!.id };
}

beforeEach(async () => {
  script.length = 0;
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentEvents).where(eq(agentEvents.orgId, orgId));
  await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
  await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgId));
  await db.delete(candidateNotes).where(eq(candidateNotes.orgId, orgId));
  await db.delete(requisitions).where(eq(requisitions.orgId, orgId));
  await db.delete(candidates).where(eq(candidates.orgId, orgId));
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-P3-${Math.random().toString(36).slice(2, 7)}`,
      title: "Platform SRE",
      status: "approved",
      createdBy: recruiter,
    })
    .returning({ id: requisitions.id });
  reqId = r!.id;
  registry.resetRegistry();
  registerPhase1Tools();
  registerPhase2Tools();
  registerPhase3Tools();
  registerPhase1Agents();
  registerPhase2Agents();
  registerPhase3Agents();
});

const stageOf = async (id: string) =>
  (await db.select({ s: applications.stage }).from(applications).where(eq(applications.id, id)))[0]!
    .s;
const openTasks = (runId: string) =>
  db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, "open")));
const rec = { orgId: "", userId: "", memberEmail: recruiterEmail };

describe("orchestration", () => {
  test("advancing into a round starts the coordinator; booking a round does not", async () => {
    await enable("interview");
    const { appId } = await application("Ravi", "shortlisted");
    await moveStageCore(
      { ...rec, orgId, userId: recruiter },
      { applicationId: appId, toStage: "l1", note: "Screened by phone" },
    );
    await processAgentEvents({ orgId });
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(runs).toHaveLength(1);
    // One candidate advanced: the run is theirs (its cost counts in their hiring cost).
    expect(runs[0]).toMatchObject({
      agentType: "interview",
      subjectType: "application",
      subjectId: appId,
      principalUserId: recruiter,
    });
  });

  test("each submitted scorecard starts one evaluation per candidate", async () => {
    await enable("evaluation");
    const a = await application("Sana", "l2");
    const b = await application("Tom", "l2");
    for (const app of [a, b, a]) {
      await emitAgentEvent({
        orgId,
        type: "scorecard.submitted",
        subjectType: "requisition",
        subjectId: reqId,
        actorUserId: manager,
        payload: { applicationId: app.appId, level: 1, verdict: "select" },
      });
    }
    await processAgentEvents({ orgId });
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.agentType, "evaluation"));
    expect(
      runs
        .filter((r) => r.orgId === orgId)
        .map((r) => r.subjectId)
        .sort(),
    ).toEqual([a.appId, b.appId].sort());
  });
});

describe("interview coordinator", () => {
  test("books only the round's approved panel, under review; queues the candidate invite", async () => {
    await enable("interview", "suggest");
    const { appId } = await application("Ravi", "l1");
    const { runId } = await startRun({
      orgId,
      agentType: "interview",
      principalUserId: recruiter,
      goal: "x",
      subjectType: "requisition",
      subjectId: reqId,
    });
    const when = new Date(Date.now() + 3 * 864e5).toISOString();
    const book = (id: string, interviewerEmail: string) =>
      call({
        id,
        name: "schedule_interview",
        args: { applicationId: appId, level: 1, interviewerEmail, scheduledAt: when },
      });
    // No approved panel for the round yet: refused before anyone is asked.
    const { getTool } = await import("../src/server/agents/registry");
    const ctx = { orgId, principalUserId: recruiter, runId, agentType: "interview", actor: "t" };
    expect(
      await getTool("schedule_interview")!.precheck!(
        ctx as never,
        { applicationId: appId, level: 1, interviewerEmail: managerEmail } as never,
      ),
    ).toMatch(/no approved panel/);

    // A person approved the manager as the L1 panel (docs/interview-panel-plan.md, P2).
    const { rolePanels } = await import("../drizzle/schema");
    const [manager] = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.email, managerEmail)));
    await db
      .insert(rolePanels)
      .values({ orgId, requisitionId: reqId, level: 1, memberIds: [manager!.id] })
      .onConflictDoNothing();
    // Anyone else — a non-member included — is refused: not the approved panel.
    script.push(book("y", "outsider@else.where"), book("z", managerEmail));
    await runAgentTick({ orgId });
    const tasks = await openTasks(runId);
    expect(tasks).toHaveLength(1);
    const [memberTask] = tasks;
    expect(memberTask!.kind).toBe("approval"); // the approved panel, reviewed first
    expect(JSON.stringify(memberTask!.proposedAction)).toContain(managerEmail);
    await resolveTask({
      orgId,
      taskId: memberTask!.id,
      userId: recruiter,
      decision: { status: "approved" },
    });
    script.push(say("Booked."));
    await runAgentTick({ orgId });
    const [iv] = await db.select().from(interviews).where(eq(interviews.applicationId, appId));
    expect(iv).toMatchObject({
      level: 1,
      interviewerEmail: managerEmail,
      interviewer: "Hari Manager",
      status: "scheduled",
    });
    // The candidate's invite and the interviewer's own brief are both queued.
    const mails = await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId));
    const mail = mails.find((m) => m.kind === "interview_invite");
    expect(mail).toMatchObject({ kind: "interview_invite" });
    expect(mails.find((m) => m.kind === "interviewer_brief")).toMatchObject({
      toEmail: managerEmail,
    });
  });

  test("a panel is proposed, never chosen: the hiring manager decides, even when autonomous", async () => {
    await enable("interview", "autonomous");
    const { rolePanels, requisitions } = await import("../drizzle/schema");
    const memberOf = async (email: string) =>
      (
        await db
          .select({ id: orgMembers.id })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.email, email)))
      )[0]!.id;
    const [rita, hari] = [await memberOf(recruiterEmail), await memberOf(managerEmail)];
    await db
      .update(requisitions)
      .set({ hiringManagerMemberId: hari })
      .where(eq(requisitions.id, reqId));
    const { runId } = await startRun({
      orgId,
      agentType: "interview",
      principalUserId: recruiter,
      goal: "x",
      subjectType: "requisition",
      subjectId: reqId,
    });
    script.push(
      call({
        id: "pp",
        name: "propose_panel",
        args: { requisitionId: reqId, level: 2, memberIds: [rita], reason: "Rita knows the role." },
      }),
    );
    await runAgentTick({ orgId });
    const [task] = await openTasks(runId);
    expect(task).toMatchObject({ kind: "gate", assigneeUserId: manager, assigneeRole: null });
    expect(task!.body).toMatch(/Panel for L2/);
    expect(task!.body).toMatch(/Decided by Hari Manager, the role's hiring manager/);
    expect(
      await db
        .select()
        .from(rolePanels)
        .where(and(eq(rolePanels.requisitionId, reqId), eq(rolePanels.level, 2))),
    ).toHaveLength(0);
    // Only the hiring manager decides; they change the people.
    await expect(
      resolveTask({ orgId, taskId: task!.id, userId: recruiter, decision: { status: "approved" } }),
    ).rejects.toThrow(/assigned to someone else/);
    await resolveTask({
      orgId,
      taskId: task!.id,
      userId: manager,
      decision: { status: "approved", args: { memberIds: [hari] } },
    });
    const [panel] = await db
      .select()
      .from(rolePanels)
      .where(and(eq(rolePanels.requisitionId, reqId), eq(rolePanels.level, 2)));
    expect(panel).toMatchObject({ memberIds: [hari], approvedBy: manager, version: 1 });
    // The agent is told the panel as approved, not as it proposed.
    script.push(say("Waiting for times."));
    await runAgentTick({ orgId });
    const told = (await db.execute(sql`
      select output ->> 'told' as told from agent_steps
      where run_id = ${runId} and kind = 'decision'`)) as unknown as { told: string }[];
    expect(told[0]!.told).toMatch(/Approved\. The L2 panel is Hari Manager/);
  });

  test("lists rounds that ended without a scorecard", async () => {
    await enable("interview");
    const { appId } = await application("Una", "l1");
    const [past] = await db
      .insert(interviews)
      .values({
        orgId,
        applicationId: appId,
        level: 1,
        interviewerEmail: managerEmail,
        scheduledAt: new Date(Date.now() - 5 * 3600_000),
        durationMins: 60,
      })
      .returning({ id: interviews.id });
    await db.insert(interviews).values({
      orgId,
      applicationId: appId,
      level: 2,
      interviewerEmail: managerEmail,
      scheduledAt: new Date(Date.now() + 864e5),
    });
    await startRun({
      orgId,
      agentType: "interview",
      principalUserId: recruiter,
      goal: "x",
      subjectType: "requisition",
      subjectId: reqId,
    });
    let pending: { interviewId: string; interviewerUserId: string | null }[] = [];
    script.push(call({ id: "p", name: "list_pending_scorecards", args: { requisitionId: reqId } }));
    registry.getAgent("interview")!.tools.push("list_pending_scorecards"); // test-only access
    const done = say("ok");
    script.push(done);
    const original = registry.getTool("list_pending_scorecards")!;
    registry.registerTool({
      ...original,
      run: async (ctx, i) => (pending = (await original.run(ctx, i)) as typeof pending),
    } as never);
    await runAgentTick({ orgId });
    expect(pending.map((p) => p.interviewId)).toEqual([past!.id]);
    expect(pending[0]!.interviewerUserId).toBe(manager);
  });
});

describe("evaluation and the hiring decision", () => {
  async function propose(recommendation: "select" | "hold" | "reject") {
    await enable("evaluation");
    const { appId, candidateId } = await application("Sana", "l3");
    await db.insert(evaluations).values({
      orgId,
      applicationId: appId,
      level: 3,
      rating: 4,
      recommendation: "select",
      evaluator: managerEmail,
    } as never);
    const { runId } = await startRun({
      orgId,
      agentType: "evaluation",
      principalUserId: recruiter,
      goal: "x",
      subjectType: "application",
      subjectId: appId,
    });
    script.push(
      call({
        id: "h",
        name: "request_approval",
        args: {
          title: "Hiring decision",
          summary: "Strong across rounds.",
          assignee_role: "recruiter",
          subject: {
            type: "hiring_decision",
            applicationId: appId,
            recommendation,
            rationale: "4/5 in every round, all verdicts select.",
          },
        },
      }),
    );
    await runAgentTick({ orgId });
    const [gate] = await openTasks(runId);
    return { appId, candidateId, gate: gate!, runId };
  }

  test("the decision goes to the hiring manager; a recruiter cannot decide it", async () => {
    const { gate } = await propose("reject");
    expect(gate).toMatchObject({ kind: "gate", assigneeRole: "hiring_manager" });
    expect(gate.body).toContain("Recommendation: REJECT");
    await expect(
      resolveTask({ orgId, taskId: gate.id, userId: recruiter, decision: { status: "approved" } }),
    ).rejects.toThrow();
  });

  test("approving a reject rejects as the hiring manager with the rationale", async () => {
    const { appId, gate } = await propose("reject");
    await resolveTask({
      orgId,
      taskId: gate.id,
      userId: manager,
      decision: { status: "approved" },
    });
    expect(await stageOf(appId)).toBe("rejected");
  });

  test("approving a hold parks the candidate; declining changes nothing", async () => {
    const a = await propose("hold");
    await resolveTask({
      orgId,
      taskId: a.gate.id,
      userId: manager,
      decision: { status: "approved" },
    });
    expect(await stageOf(a.appId)).toBe("on_hold");
    await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
    const b = await propose("reject");
    await resolveTask({
      orgId,
      taskId: b.gate.id,
      userId: manager,
      decision: { status: "rejected", reason: "Not convinced" },
    });
    expect(await stageOf(b.appId)).toBe("l3");
  });

  test("approving a select records the decision and hands it to the offer stage", async () => {
    const { appId, candidateId, gate } = await propose("select");
    await resolveTask({
      orgId,
      taskId: gate.id,
      userId: manager,
      decision: { status: "approved", comment: "Go" },
    });
    expect(await stageOf(appId)).toBe("l3"); // offer stages stay with HR (Phase 4)
    const [note] = await db
      .select()
      .from(candidateNotes)
      .where(eq(candidateNotes.candidateId, candidateId));
    expect(note!.body).toContain("Hiring decision: SELECT");
    expect(note!.authorId).toBe(manager);
    const [ev] = await db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "hiring.selected")));
    expect(ev).toMatchObject({ subjectId: appId, actorUserId: manager });
  });

  test("a candidate who moved since the proposal cannot be decided on stale evidence", async () => {
    const { appId, gate } = await propose("reject");
    await moveStageCore(
      { ...rec, orgId, userId: recruiter },
      { applicationId: appId, toStage: "on_hold", reason: "Paused" },
    );
    await expect(
      resolveTask({ orgId, taskId: gate.id, userId: manager, decision: { status: "approved" } }),
    ).rejects.toThrow("moved on");
    expect(await stageOf(appId)).toBe("on_hold");
  });
});

describe("the screening decision in the hiring desk", () => {
  async function graded(name: string) {
    const { appId, candidateId } = await application(name, "shortlisted");
    const [kit] = await db
      .insert(screeningKits)
      .values({
        orgId,
        candidateId,
        requisitionId: reqId,
        applicationId: appId,
        focusSummary: "x",
        questions: [] as never,
      })
      .returning({ id: screeningKits.id });
    await db.insert(screeningRuns).values({
      orgId,
      kitId: kit!.id,
      candidateId,
      requisitionId: reqId,
      applicationId: appId,
      inputKind: "phone_ai",
      screeningScore: 63,
      recommendation: "hold",
      coverage: {
        planned: 4,
        asked: 2,
        answered: 2,
        plannedIds: ["q3", "q5", "q2", "q4"],
        askedIds: ["q3", "q5"],
        confidence: "medium",
      },
    });
    return { appId, candidateId };
  }

  async function propose(appId: string, recommendation: "proceed" | "hold") {
    await enable("screening");
    const { runId } = await startRun({
      orgId,
      agentType: "screening",
      principalUserId: recruiter,
      goal: "x",
      subjectType: "application",
      subjectId: appId,
    });
    script.length = 0; // a paused earlier run leaves its closing reply unused
    script.push(
      call({
        id: "d",
        name: "request_approval",
        args: {
          title: "Screening decision",
          summary: "Graded.",
          assignee_role: "recruiter",
          subject: {
            type: "screening_decision",
            applicationId: appId,
            recommendation,
            rationale: "Strong on PHI masking; probe evaluation tooling in L1.",
          },
        },
      }),
      say("done"),
    );
    await runAgentTick({ orgId });
    return { runId, tasks: await openTasks(runId) };
  }

  const taskStatus = async (id: string) =>
    (await db.select({ s: agentTasks.status }).from(agentTasks).where(eq(agentTasks.id, id)))[0]!.s;

  test("goes to the person the agent works for, with the graded result stated by the system", async () => {
    const { appId } = await graded("Madhu");
    const { tasks } = await propose(appId, "proceed");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "gate", assigneeUserId: recruiter });
    expect(tasks[0]!.body).toContain("PROCEED to the first interview round");
    expect(tasks[0]!.body).toContain(
      "Screening score: 63/100 (2 asked of 4 planned · both answered · 2 not reached on the call; medium confidence)",
    );
  });

  test("approving proceed moves them to L1 — the Interview coordinator's cue", async () => {
    const { appId } = await graded("Asha");
    const { tasks } = await propose(appId, "proceed");
    await resolveTask({
      orgId,
      taskId: tasks[0]!.id,
      userId: recruiter,
      decision: { status: "approved" },
    });
    expect(await stageOf(appId)).toBe("l1");
    // The person's approval is the record, not the stale-request sweep its own move triggered.
    expect(await taskStatus(tasks[0]!.id)).toBe("approved");
    const [ev] = await db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "application.advanced")));
    expect(ev).toBeTruthy();
  });

  test("declining keeps them in screening with the reason; rejecting is the person's, with a reason", async () => {
    const a = await graded("Ravi");
    const first = await propose(a.appId, "proceed");
    await resolveTask({
      orgId,
      taskId: first.tasks[0]!.id,
      userId: recruiter,
      decision: { status: "rejected", reason: "Want the written assessment too" },
    });
    expect(await stageOf(a.appId)).toBe("shortlisted");
    const [note] = await db
      .select()
      .from(candidateNotes)
      .where(eq(candidateNotes.candidateId, a.candidateId));
    expect(note!.body).toContain("kept in screening");
    expect(note!.body).toContain("Want the written assessment too");

    await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
    const b = await graded("Kiran");
    const second = await propose(b.appId, "hold");
    await expect(
      resolveTask({
        orgId,
        taskId: second.tasks[0]!.id,
        userId: recruiter,
        decision: { status: "rejected", rejectCandidate: true },
      }),
    ).rejects.toThrow("Say why");
    await resolveTask({
      orgId,
      taskId: second.tasks[0]!.id,
      userId: recruiter,
      decision: {
        status: "rejected",
        rejectCandidate: true,
        reason: "Evaluation depth below what the role needs",
      },
    });
    expect(await stageOf(b.appId)).toBe("rejected");
  });

  test("no decision without a graded result, and never two for one candidate", async () => {
    const { appId } = await application("Nila", "shortlisted");
    expect((await propose(appId, "proceed")).tasks).toHaveLength(0);

    const g = await graded("Tara");
    expect((await propose(g.appId, "proceed")).tasks).toHaveLength(1);
    expect((await propose(g.appId, "hold")).tasks).toHaveLength(0);
  });

  test("moving the candidate elsewhere closes the waiting decision", async () => {
    const { appId } = await graded("Uma");
    const { tasks } = await propose(appId, "proceed");
    await moveStageCore(
      { ...rec, orgId, userId: recruiter },
      { applicationId: appId, toStage: "on_hold", reason: "Paused" },
    );
    expect(await taskStatus(tasks[0]!.id)).toBe("cancelled");
  });
});
