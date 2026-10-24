/**
 * Phase 2 agents end to end against the disposable local database: intake &
 * matching, screening and follow-up with real tools, cores, outbox and
 * orchestrator — only the model (and AI question generation) is scripted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { AgentStepResult, AgentToolCall } from "../src/lib/ai-gateway.server";

type Msg = { role: string; content?: string };
type Step = AgentStepResult | ((messages: Msg[]) => AgentStepResult);
const script: Step[] = [];
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
const lastTool = (m: Msg[]) => [...m].reverse().find((x) => x.role === "tool")!.content!;

const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiAgentStep: async (opts: { messages: Msg[] }) => {
    const next = script.shift() ?? say("(script exhausted)");
    return typeof next === "function" ? next(opts.messages) : next;
  },
  aiJson: async (opts: { feature: string }) =>
    opts.feature === "assessment_generate"
      ? {
          ok: true,
          data: {
            questions: [
              {
                id: "q1",
                dimension: "ownership",
                prompt: "Tell us about an outage.",
                looks_like: "x",
              },
              { id: "q2", dimension: "learning", prompt: "A new tool?", looks_like: "y" },
              { id: "q3", dimension: "collaboration", prompt: "A conflict?", looks_like: "z" },
              { id: "q4", dimension: "judgement", prompt: "A trade-off?", looks_like: "w" },
            ],
          },
          model: "m",
          provider: "openai",
          usage: null,
        }
      : { ok: false, status: 500, message: `unexpected aiJson ${opts.feature}` },
}));

const { db } = await import("../src/server/db");
const schema = await import("../drizzle/schema");
const {
  agentEvents,
  agentPolicies,
  agentRuns,
  agentSteps,
  agentTasks,
  applications,
  candidateAssessments,
  candidates,
  emailOutbox,
  matchScores,
  orgMembers,
  organizations,
  requisitions,
  stageEvents,
  userRoles,
  users,
} = schema;
const { getTool, resetRegistry } = await import("../src/server/agents/registry");
const { taskIsRemindable } = await import("../src/server/agents/task-liveness");
const { eraseCandidatesCore } = await import("../src/server/erase.server");
const { registerPhase1Tools } = await import("../src/server/agents/tools");
const { registerPhase2Tools } = await import("../src/server/agents/tools-phase2");
const { registerPhase1Agents, registerPhase2Agents } =
  await import("../src/server/agents/definitions");
const { afterSubjectsDeleted, resolveTask, runAgentTick, startRun } =
  await import("../src/server/agents/runtime.server");
const { processAgentEvents, scheduleSweeps } =
  await import("../src/server/agents/orchestrator.server");
const { moveStageCore } = await import("../src/lib/pipeline.server");

let orgId: string;
let otherOrg: string;
let owner: string;
let recruiter: string;
let reqId: string;
const stamp = Date.now();
const recruiterEmail = `p2-rec-${stamp}@test.local`;

async function seedUser(email: string) {
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  return u!.id;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
    throw new Error("Refusing to run against a non-local database host");
  }
  const [o] = await db
    .insert(organizations)
    .values({ name: "Phase2 Org", slug: `p2-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [o2] = await db
    .insert(organizations)
    .values({ name: "Other Org", slug: `p2o-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  otherOrg = o2!.id;
  owner = await seedUser(`p2-owner-${stamp}@test.local`);
  recruiter = await seedUser(recruiterEmail);
  await db.insert(orgMembers).values([
    {
      orgId,
      userId: owner,
      email: `p2-owner-${stamp}@test.local`,
      fullName: "Owner",
      status: "active",
      isOwner: true,
      joinedAt: new Date(),
    },
    {
      orgId,
      userId: recruiter,
      email: recruiterEmail,
      fullName: "Rita Recruiter",
      status: "active",
      isOwner: false,
      joinedAt: new Date(),
    },
  ]);
  await db.insert(userRoles).values({ userId: recruiter, orgId, role: "recruiter" });
});

afterAll(async () => {
  await db.delete(organizations).where(inArray(organizations.id, [orgId, otherOrg]));
  await db.delete(users).where(inArray(users.id, [owner, recruiter]));
});

type Seeded = { appId: string; candidateId: string };
let apps: Record<string, Seeded> = {};

async function candidate(name: string, skills: string[], org = orgId) {
  const [c] = await db
    .insert(candidates)
    .values({
      orgId: org,
      fullName: name,
      email: `${name.toLowerCase().replace(/\s/g, ".")}-${stamp}@cand.local`,
      skills,
    })
    .returning({ id: candidates.id });
  return c!.id;
}

async function application(name: string, stage: string, score: number | null, skills: string[]) {
  const candidateId = await candidate(name, skills);
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: reqId, candidateId, stage: stage as never, source: "apply" })
    .returning({ id: applications.id });
  if (score != null) {
    await db.insert(matchScores).values({
      orgId,
      applicationId: a!.id,
      overallScore: score,
      recommendation: score >= 75 ? "select" : score >= 60 ? "hold" : "reject",
      missingSkills: score < 60 ? ["Kubernetes"] : [],
      rationale: `Score ${score}`,
    } as never);
  }
  apps[name] = { appId: a!.id, candidateId };
  return a!.id;
}

async function enable(
  agentType: string,
  autonomy: "suggest" | "act_and_notify" | "autonomous" = "act_and_notify",
  whitelist: string[] = [],
) {
  await db
    .insert(agentPolicies)
    .values({
      orgId,
      agentType: agentType as never,
      enabled: true,
      autonomy,
      whitelistedTemplates: whitelist,
    })
    .onConflictDoUpdate({
      target: [agentPolicies.orgId, agentPolicies.agentType],
      set: { enabled: true, autonomy, whitelistedTemplates: whitelist },
    });
}

beforeEach(async () => {
  script.length = 0;
  apps = {};
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentEvents).where(eq(agentEvents.orgId, orgId));
  await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
  await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgId));
  await db.delete(requisitions).where(eq(requisitions.orgId, orgId));
  await db.delete(candidates).where(inArray(candidates.orgId, [orgId, otherOrg]));
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-P2-${Math.random().toString(36).slice(2, 7)}`,
      title: "Platform SRE",
      status: "approved",
      mustHaveSkills: ["Kubernetes", "Go"],
      createdBy: recruiter,
    })
    .returning({ id: requisitions.id });
  reqId = r!.id;
  resetRegistry();
  registerPhase1Tools();
  registerPhase2Tools();
  registerPhase1Agents();
  registerPhase2Agents();
});

const stageOf = async (appId: string) =>
  (
    await db.select({ s: applications.stage }).from(applications).where(eq(applications.id, appId))
  )[0]!.s;
const openTasks = (runId: string) =>
  db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, "open")));

describe("intake & matching agent", () => {
  async function intakeRun() {
    await enable("intake");
    await application("Asha Strong", "ai_screened", 68, ["Kubernetes"]);
    await application("Ben Weak", "ai_screened", 40, ["PHP"]);
    await application("Cara Weak", "ai_screened", 35, ["Excel"]);
    const { runId } = await startRun({
      orgId,
      agentType: "intake",
      principalUserId: recruiter,
      goal: `Review the pipeline.\n\nRequisition id: ${reqId}`,
      subjectType: "requisition",
      subjectId: reqId,
    });
    script.push(
      call({ id: "s", name: "pipeline_summary", args: { requisitionId: reqId } }),
      call({
        id: "l",
        name: "list_applications",
        args: { requisitionId: reqId, stage: "ai_screened" },
      }),
      call({
        id: "m",
        name: "move_candidate",
        args: {
          applicationId: apps["Asha Strong"]!.appId,
          toStage: "shortlisted",
          reason: "68/100; Kubernetes present, Go learnable",
        },
      }),
      call({
        id: "r",
        name: "request_approval",
        args: {
          title: "Reject 2 candidates for Platform SRE",
          summary: "Both miss the must-have Kubernetes and Go.",
          assignee_role: "recruiter",
          subject: {
            type: "rejection",
            items: [
              {
                applicationId: apps["Ben Weak"]!.appId,
                reason: "Missing must-haves Kubernetes and Go",
              },
              {
                applicationId: apps["Cara Weak"]!.appId,
                reason: "Missing must-haves Kubernetes and Go",
              },
            ],
          },
        },
      }),
    );
    await runAgentTick({ orgId });
    return runId;
  }

  test("summarises, shortlists with a reason as the principal, and proposes rejections to the principal", async () => {
    const runId = await intakeRun();
    expect(await stageOf(apps["Asha Strong"]!.appId)).toBe("shortlisted");
    const [ev] = await db
      .select()
      .from(stageEvents)
      .where(
        and(
          eq(stageEvents.applicationId, apps["Asha Strong"]!.appId),
          eq(stageEvents.toStage, "shortlisted"),
        ),
      );
    expect(ev!.actor).toBe(`${recruiterEmail} (via agent)`);

    const [gate] = await openTasks(runId);
    expect(gate).toMatchObject({ kind: "gate", assigneeUserId: recruiter, assigneeRole: null });
    expect(gate!.body).toContain("Ben Weak");
    expect(gate!.body).toContain("Missing must-haves Kubernetes and Go");
    // Nobody is rejected until a person approves.
    expect(await stageOf(apps["Ben Weak"]!.appId)).toBe("ai_screened");
  });

  test("approving the batch rejects as the decider, skipping anyone who moved meanwhile", async () => {
    const runId = await intakeRun();
    await moveStageCore(
      { orgId, userId: owner, memberEmail: "owner@test.local" },
      { applicationId: apps["Cara Weak"]!.appId, toStage: "on_hold", reason: "Manual hold" },
    );
    const [gate] = await openTasks(runId);
    await resolveTask({
      orgId,
      taskId: gate!.id,
      userId: recruiter,
      decision: { status: "approved" },
    });
    expect(await stageOf(apps["Ben Weak"]!.appId)).toBe("rejected");
    expect(await stageOf(apps["Cara Weak"]!.appId)).toBe("on_hold");
    const [ev] = await db
      .select()
      .from(stageEvents)
      .where(
        and(
          eq(stageEvents.applicationId, apps["Ben Weak"]!.appId),
          eq(stageEvents.toStage, "rejected"),
        ),
      );
    expect(ev).toMatchObject({
      actor: recruiterEmail,
      reason: "Missing must-haves Kubernetes and Go",
    });
  });

  test("declining the batch rejects nobody", async () => {
    const runId = await intakeRun();
    const [gate] = await openTasks(runId);
    await resolveTask({
      orgId,
      taskId: gate!.id,
      userId: recruiter,
      decision: { status: "rejected", reason: "Keep them" },
    });
    expect(await stageOf(apps["Ben Weak"]!.appId)).toBe("ai_screened");
    expect(await stageOf(apps["Cara Weak"]!.appId)).toBe("ai_screened");
  });

  test("agents cannot reject through move_candidate", async () => {
    await enable("intake");
    await application("Dan", "ai_screened", 40, []);
    await startRun({
      orgId,
      agentType: "intake",
      principalUserId: recruiter,
      goal: "x",
      subjectType: "requisition",
      subjectId: reqId,
    });
    script.push(
      call({
        id: "m",
        name: "move_candidate",
        args: { applicationId: apps["Dan"]!.appId, toStage: "rejected", reason: "weak" },
      }),
      say("ok"),
    );
    await runAgentTick({ orgId });
    expect(await stageOf(apps["Dan"]!.appId)).toBe("ai_screened");
  });

  test("agents never move a candidate out of an interview round (regression: L1 → reserve → shortlisted)", async () => {
    await enable("intake", "autonomous");
    await application("Esha", "l1", 94, []);
    await startRun({
      orgId,
      agentType: "intake",
      principalUserId: recruiter,
      goal: "x",
      subjectType: "requisition",
      subjectId: reqId,
    });
    script.push(
      call({
        id: "r",
        name: "move_candidate",
        args: {
          applicationId: apps["Esha"]!.appId,
          toStage: "reserve",
          reason: "to send an assessment",
        },
      }),
      say("Stopped: she is in L1."),
    );
    await runAgentTick({ orgId });
    expect(await stageOf(apps["Esha"]!.appId)).toBe("l1");
    const [step] = await db
      .select()
      .from(agentSteps)
      .where(and(eq(agentSteps.orgId, orgId), eq(agentSteps.toolName, "move_candidate")));
    expect(JSON.stringify(step!.output)).toMatch(/never move candidates out of an interview round/);
  });

  test("talent pool search excludes the pipeline; add_to_pipeline refuses other organisations' candidates", async () => {
    await enable("intake");
    await application("In Pipeline", "applied", null, ["Kubernetes"]);
    const poolMatch = await candidate("Pool Match", ["kubernetes", "Go"]);
    await candidate("Pool Miss", ["Excel"]);
    const foreign = await candidate("Foreign", ["Kubernetes"], otherOrg);
    await startRun({
      orgId,
      agentType: "intake",
      principalUserId: recruiter,
      goal: "x",
      subjectType: "requisition",
      subjectId: reqId,
    });
    let found: { candidateId: string; skillHits: string[]; why: string }[] = [];
    script.push(
      call({ id: "p", name: "search_talent_pool", args: { requisitionId: reqId } }),
      (m) => {
        const raw = lastTool(m);
        found = JSON.parse(raw.slice(raw.indexOf("\n") + 1, raw.lastIndexOf("\n"))).matches;
        return call({
          id: "a",
          name: "add_to_pipeline",
          args: { requisitionId: reqId, candidateIds: [foreign] },
        });
      },
      call({
        id: "b",
        name: "add_to_pipeline",
        args: { requisitionId: reqId, candidateIds: [poolMatch] },
      }),
      say("done"),
    );
    await runAgentTick({ orgId });
    expect(found.map((c) => c.candidateId)).toEqual([poolMatch]);
    // No AI key in tests: the search falls back to the must-haves as written.
    expect(found[0]!.skillHits).toEqual(["Kubernetes", "Go"]);
    expect(found[0]!.why).toMatch(/skills: Kubernetes, Go/);
    const inReq = await db
      .select({ c: applications.candidateId, source: applications.source })
      .from(applications)
      .where(eq(applications.requisitionId, reqId));
    expect(inReq.find((r) => r.c === poolMatch)?.source).toBe("agent_talent_pool");
    expect(inReq.find((r) => r.c === foreign)).toBeUndefined();
  });

  test("the intake sweep starts once per requisition and respects the cooldown and opt-in", async () => {
    await application("Held", "ai_screened", 50, []);
    expect(await scheduleSweeps({ orgId })).toBe(0); // intake switched off
    await enable("intake");
    expect(await scheduleSweeps({ orgId })).toBe(1);
    expect(await scheduleSweeps({ orgId })).toBe(0);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(run).toMatchObject({
      agentType: "intake",
      principalUserId: recruiter,
      subjectId: reqId,
    });
  });
});

describe("screening agent", () => {
  test("a shortlist event starts screening for the requisition when switched on", async () => {
    await enable("screening");
    const id = await application("Eve", "applied", 80, ["Kubernetes"]);
    await moveStageCore(
      { orgId, userId: recruiter, memberEmail: recruiterEmail },
      { applicationId: id, toStage: "shortlisted" },
    );
    await processAgentEvents({ orgId });
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      agentType: "screening",
      subjectId: reqId,
      principalUserId: recruiter,
    });
  });

  test("a request that assumed the old stage closes itself when the candidate moves on (stale)", async () => {
    await enable("screening", "suggest");
    await application("Gita", "shortlisted", 90, ["Kubernetes"]);
    const { runId } = await startRun({
      orgId,
      agentType: "screening",
      principalUserId: recruiter,
      goal: "x",
    });
    script.push(
      call({ id: "a", name: "send_assessment", args: { applicationId: apps["Gita"]!.appId } }),
    );
    await runAgentTick({ orgId });
    const [task] = await db
      .select()
      .from(agentTasks)
      .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, "open")));
    expect(task).toBeTruthy();
    // A person moves her into an interview round before anyone approves the assessment.
    await moveStageCore(
      { orgId, userId: recruiter, memberEmail: recruiterEmail },
      { applicationId: apps["Gita"]!.appId, toStage: "l1", note: "Strong referral; screen in L1" },
    );
    const [closed] = await db.select().from(agentTasks).where(eq(agentTasks.id, task!.id));
    expect(closed).toMatchObject({ status: "cancelled" });
    expect(JSON.stringify(closed!.response)).toMatch(/moved from shortlisted to l1/);
    // The agent is told why, and the candidate stays where the person put her.
    script.push(say("Skipped: she is in an interview round."));
    await runAgentTick({ orgId });
    expect(await stageOf(apps["Gita"]!.appId)).toBe("l1");
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run!.status).toBe("done");
  });

  test("moving into an interview with no screening on record needs a reason, recorded as skipped", async () => {
    const id = await application("Hari", "shortlisted", 88, ["Kubernetes"]);
    const actor = { orgId, userId: recruiter, memberEmail: recruiterEmail };
    await expect(moveStageCore(actor, { applicationId: id, toStage: "l1" })).rejects.toThrow(
      /No screening is on record/,
    );
    await moveStageCore(actor, {
      applicationId: id,
      toStage: "l1",
      note: "Ex-colleague, known well",
    });
    expect(await stageOf(id)).toBe("l1");
    const [ev] = await db
      .select()
      .from(stageEvents)
      .where(and(eq(stageEvents.applicationId, id), eq(stageEvents.toStage, "l1")));
    expect(ev!.reason).toBe("Screening skipped: Ex-colleague, known well");
  });

  test("with screening on record, moving into an interview needs no reason", async () => {
    const id = await application("Indu", "shortlisted", 88, ["Kubernetes"]);
    const [cand] = await db.select().from(applications).where(eq(applications.id, id));
    await db.insert(candidateAssessments).values({
      orgId,
      candidateId: cand!.candidateId,
      requisitionId: reqId,
      token: `t${Date.now()}`,
      status: "completed",
      questions: [],
    } as never);
    await moveStageCore(
      { orgId, userId: recruiter, memberEmail: recruiterEmail },
      { applicationId: id, toStage: "l1" },
    );
    expect(await stageOf(id)).toBe("l1");
  });

  test("send_assessment waits for approval under suggest, then creates the assessment and queues the email", async () => {
    await enable("screening", "suggest");
    await application("Fay", "shortlisted", 82, ["Kubernetes"]);
    const { runId } = await startRun({
      orgId,
      agentType: "screening",
      principalUserId: recruiter,
      goal: "x",
    });
    script.push(
      call({ id: "a", name: "send_assessment", args: { applicationId: apps["Fay"]!.appId } }),
    );
    await runAgentTick({ orgId });
    const [task] = await openTasks(runId);
    expect(task).toMatchObject({ kind: "approval", assigneeUserId: recruiter });
    expect(
      await db.select().from(candidateAssessments).where(eq(candidateAssessments.orgId, orgId)),
    ).toHaveLength(0);

    await resolveTask({
      orgId,
      taskId: task!.id,
      userId: recruiter,
      decision: { status: "approved" },
    });
    script.push(say("Sent."));
    await runAgentTick({ orgId });
    const [assessment] = await db
      .select()
      .from(candidateAssessments)
      .where(eq(candidateAssessments.orgId, orgId));
    expect(assessment).toMatchObject({ status: "sent", candidateId: apps["Fay"]!.candidateId });
    const [mail] = await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId));
    expect(mail).toMatchObject({ kind: "assessment_invite", templateName: "assessment_invite" });
    expect((mail!.templateData as { assessmentUrl: string }).assessmentUrl).toContain(
      `/assess/${assessment!.token}`,
    );
  });

  test("a pre-approved assessment email sends without asking when autonomous", async () => {
    await enable("screening", "autonomous", ["assessment_invite"]);
    await application("Gus", "shortlisted", 85, ["Kubernetes"]);
    const { runId } = await startRun({
      orgId,
      agentType: "screening",
      principalUserId: recruiter,
      goal: "x",
    });
    script.push(
      call({ id: "a", name: "send_assessment", args: { applicationId: apps["Gus"]!.appId } }),
      say("ok"),
    );
    await runAgentTick({ orgId });
    expect(await openTasks(runId)).toHaveLength(0);
    expect(await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId))).toHaveLength(1);
  });
});

describe("follow-up agent", () => {
  test("the daily sweep starts one run per org for the owner", async () => {
    await enable("followup");
    expect(await scheduleSweeps({ orgId })).toBe(1);
    expect(await scheduleSweeps({ orgId })).toBe(0);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.agentType, "followup"));
    expect(run).toMatchObject({ orgId, principalUserId: owner });
  });

  test("lists overdue approvals and reminds members once per day; never non-members", async () => {
    await enable("followup");
    await db
      .update(requisitions)
      .set({
        status: "pending_hr",
        approvalTrail: [
          { to: "pending_hr", at: new Date(Date.now() - 4 * 864e5).toISOString() },
        ] as never,
      })
      .where(eq(requisitions.id, reqId));
    await startRun({ orgId, agentType: "followup", principalUserId: owner, goal: "daily" });
    let overdue: {
      requisitionApprovals: { requisitionId: string; waitingFor: string; days: number }[];
    } | null = null;
    const remind = (id: string, userId: string) =>
      call({
        id,
        name: "remind_member",
        args: {
          userId,
          heading: "REQ waiting for HR approval",
          message: "Waiting 4 days.",
          path: `/requisitions/${reqId}`,
        },
      });
    script.push(
      call({ id: "o", name: "list_overdue", args: {} }),
      (m) => {
        overdue = JSON.parse(lastTool(m));
        return remind("r1", recruiter);
      },
      remind("r2", recruiter),
      remind("r3", "00000000-0000-0000-0000-000000000000"),
      say("Reminded Rita."),
    );
    await runAgentTick({ orgId });
    expect(overdue!.requisitionApprovals).toEqual([
      expect.objectContaining({ requisitionId: reqId, waitingFor: "hr_head", days: 4 }),
    ]);
    const mails = await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ kind: "member_reminder", toEmail: recruiterEmail });
  });
});

describe("requests that outlived their work", () => {
  const threeDaysAgo = () => new Date(Date.now() - 3 * 864e5);
  /** A run in `status` with one open request, both three days old. */
  async function parked(
    title: string,
    status: "awaiting_human" | "cancelled" | "failed" | "done",
    opts: { subject?: { type: string; id: string }; args?: Record<string, unknown> } = {},
  ) {
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "intake",
        status,
        principalUserId: recruiter,
        goal: title,
        subjectType: opts.subject?.type ?? null,
        subjectId: opts.subject?.id ?? null,
        createdAt: threeDaysAgo(),
      })
      .returning({ id: agentRuns.id });
    const [task] = await db
      .insert(agentTasks)
      .values({
        orgId,
        runId: run!.id,
        kind: "approval",
        title,
        proposedAction: { toolCallId: "x", name: "propose_rejections", args: opts.args ?? {} },
        assigneeUserId: recruiter,
        createdAt: threeDaysAgo(),
      })
      .returning({ id: agentTasks.id });
    return { runId: run!.id, taskId: task!.id };
  }
  const ctx = (runId: string) => ({
    orgId,
    principalUserId: owner,
    runId,
    agentType: "followup" as const,
    actor: `agent:followup:${runId}`,
  });
  async function overdueTitles() {
    const out = (await getTool("list_overdue")!.run(ctx(crypto.randomUUID()), { slaDays: 2 })) as {
      agentRequests: { title: string }[];
    };
    return out.agentRequests.map((t) => t.title).sort();
  }
  async function popUpTitles() {
    const rows = await db
      .select({ title: agentTasks.title })
      .from(agentTasks)
      .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
      .where(and(eq(agentTasks.orgId, orgId), eq(agentTasks.status, "open"), taskIsRemindable()));
    return rows.map((r) => r.title).sort();
  }
  const statusOf = async (taskId: string) =>
    (await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)))[0]!;

  test("the follow-up agent and pop-ups skip requests whose run stopped or subject is gone", async () => {
    const live = await application("Lia Live", "ai_screened", 50, ["Go"]);
    const gone = await application("Gil Gone", "ai_screened", 50, ["Go"]);
    await parked("live", "awaiting_human", {
      subject: { type: "requisition", id: reqId },
      args: { applicationId: live },
    });
    await parked("cancelled run", "cancelled", { subject: { type: "requisition", id: reqId } });
    await parked("failed run", "failed");
    await parked("finished run", "done");
    await parked("deleted application", "awaiting_human", {
      subject: { type: "application", id: gone },
    });
    await parked("rejection batch, all deleted", "awaiting_human", {
      args: {
        subject: {
          type: "rejection",
          items: [{ applicationId: gone, reason: "x" }],
        },
      },
    });
    await parked("rejection batch, one left", "awaiting_human", {
      args: {
        subject: {
          type: "rejection",
          items: [
            { applicationId: gone, reason: "x" },
            { applicationId: live, reason: "x" },
          ],
        },
      },
    });
    await db.delete(applications).where(eq(applications.id, gone));

    expect(await overdueTitles()).toEqual(["live", "rejection batch, one left"]);
    expect(await popUpTitles()).toEqual(["live", "rejection batch, one left"]);
  });

  test("deleting a requisition closes requests about it and stops its runs", async () => {
    // As on 2026-10-24: a rejection batch for a role whose requisition and
    // applications were later deleted.
    const a = await application("Ana", "ai_screened", 40, ["PHP"]);
    const b = await application("Bo", "ai_screened", 35, ["PHP"]);
    const { runId, taskId } = await parked(
      "Rejection approval for 2 candidates",
      "awaiting_human",
      {
        subject: { type: "requisition", id: reqId },
        args: {
          subject: {
            type: "rejection",
            items: [
              { applicationId: a, reason: "x" },
              { applicationId: b, reason: "x" },
            ],
          },
        },
      },
    );
    await db.delete(requisitions).where(eq(requisitions.id, reqId));
    await afterSubjectsDeleted(orgId);

    const task = await statusOf(taskId);
    expect(task.status).toBe("cancelled");
    expect((task.response as { reason: string }).reason).toContain(
      "the requisition it was about has been deleted",
    );
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run!.status).toBe("cancelled");
    expect(await overdueTitles()).toEqual([]);
  });

  test("erasing a candidate closes requests about their application; the run carries on", async () => {
    const a = await application("Eve Erased", "ai_screened", 40, ["PHP"]);
    const { runId, taskId } = await parked("Reject Eve", "awaiting_human", {
      subject: { type: "requisition", id: reqId },
      args: { applicationId: a },
    });
    await eraseCandidatesCore(orgId, [apps["Eve Erased"]!.candidateId]);

    const task = await statusOf(taskId);
    expect(task.status).toBe("cancelled");
    expect((task.response as { reason: string }).reason).toContain(
      "the candidate's application it was about has been deleted",
    );
    // The requisition still exists: the agent is re-queued and told why.
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run!.status).toBe("queued");
  });

  test("the scheduler's sweep catches deletions made outside the app", async () => {
    const a = await application("Dee Deleted", "ai_screened", 40, ["PHP"]);
    const { taskId } = await parked("Reject Dee", "awaiting_human", {
      subject: { type: "requisition", id: reqId },
      args: { applicationId: a },
    });
    await db.delete(applications).where(eq(applications.id, a));
    expect((await statusOf(taskId)).status).toBe("open");
    await runAgentTick({ orgId });
    expect((await statusOf(taskId)).status).toBe("cancelled");
  });
});
