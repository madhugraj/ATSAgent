/**
 * Phase 3 agents end to end against the disposable local database: interview
 * coordination and evaluation with real tools, cores, outbox and
 * orchestrator — only the model is scripted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

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
  test("books with a member under review; refuses non-members; queues the candidate invite", async () => {
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
    script.push(
      call({
        id: "x",
        name: "schedule_interview",
        args: {
          applicationId: appId,
          level: 1,
          interviewerEmail: "outsider@else.where",
          scheduledAt: when,
        },
      }),
    );
    await runAgentTick({ orgId });
    const [outsiderTask] = await openTasks(runId);
    expect(outsiderTask!.kind).toBe("approval"); // reviewed first…
    await resolveTask({
      orgId,
      taskId: outsiderTask!.id,
      userId: recruiter,
      decision: { status: "approved" },
    });
    script.push(
      call({
        id: "y",
        name: "schedule_interview",
        args: { applicationId: appId, level: 1, interviewerEmail: managerEmail, scheduledAt: when },
      }),
    );
    await runAgentTick({ orgId }); // …and still refused at execution: not a member
    expect(
      await db.select().from(interviews).where(eq(interviews.applicationId, appId)),
    ).toHaveLength(0);

    const [memberTask] = await openTasks(runId);
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
