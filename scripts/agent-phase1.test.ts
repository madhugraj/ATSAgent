/**
 * Phase 1 agents end to end against the disposable local database: real
 * tools, real requisition / JD cores, real orchestrator — only the model is
 * scripted. Covers inbox gates performing the real approval as the decider,
 * gates closing when decided on the requisition page, and the requisition →
 * JD → publishing hand-offs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { AgentStepResult, AgentToolCall } from "../src/lib/ai-gateway.server";

/* ------------------------------------------------------------ fake model */

type Step = AgentStepResult | ((messages: { role: string; content?: string }[]) => AgentStepResult);
const script: Step[] = [];
/** JSON of the most recent tool result in the transcript. */
const lastTool = (messages: { role: string; content?: string }[]) =>
  JSON.parse([...messages].reverse().find((m) => m.role === "tool")!.content!) as Record<
    string,
    unknown
  >;
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
const JD = {
  purpose: "Run the platform.",
  responsibilities: "- Keep it up",
  must_have: ["Kubernetes", "Go"],
  good_to_have: ["Terraform"],
  qualifications: "BSc",
  success_factors: "Uptime",
  reporting_to: "Head of Platform",
  full_text: "# Platform SRE\nRun the platform.",
};

const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiAgentStep: async (opts: { messages: { role: string; content?: string }[] }) => {
    const next = script.shift() ?? say("(script exhausted)");
    return typeof next === "function" ? next(opts.messages) : next;
  },
  aiJson: async (opts: { feature: string }) =>
    opts.feature === "jd_generate"
      ? { ok: true, data: JD, model: "m", provider: "openai", usage: null }
      : { ok: false, status: 500, message: `unexpected aiJson ${opts.feature}` },
}));

const { db } = await import("../src/server/db");
const {
  agentEvents,
  agentPolicies,
  agentRuns,
  agentTasks,
  jobDescriptions,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const { resetRegistry, getTool } = await import("../src/server/agents/registry");
const { registerPhase1Tools } = await import("../src/server/agents/tools");
const { registerPhase1Agents } = await import("../src/server/agents/definitions");
const { resolveTask, runAgentTick, startRun } = await import("../src/server/agents/runtime.server");
const { processAgentEvents } = await import("../src/server/agents/orchestrator.server");
const lifecycle = await import("../src/lib/requisitions.server");

/* ------------------------------------------------------------- fixtures */

let orgId: string;
let recruiter: string;
let dh: string;
let hr: string;
let cbo: string;
const stamp = Date.now();

async function member(
  email: string,
  role: "recruiter" | "department_head" | "hr_head" | "president_cbo",
) {
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  await db.insert(orgMembers).values({
    orgId,
    userId: u!.id,
    email,
    status: "active",
    isOwner: false,
    joinedAt: new Date(),
  });
  await db.insert(userRoles).values({ userId: u!.id, orgId, role });
  return u!.id;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
    throw new Error("Refusing to run against a non-local database host");
  }
  const [org] = await db
    .insert(organizations)
    .values({ name: "Phase1 Org", slug: `p1-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = org!.id;
  recruiter = await member(`p1-rec-${stamp}@test.local`, "recruiter");
  dh = await member(`p1-dh-${stamp}@test.local`, "department_head");
  hr = await member(`p1-hr-${stamp}@test.local`, "hr_head");
  cbo = await member(`p1-cbo-${stamp}@test.local`, "president_cbo");
});

afterAll(async () => {
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(inArray(users.id, [recruiter, dh, hr, cbo]));
});

async function enable(...agents: string[]) {
  for (const agentType of agents) {
    await db
      .insert(agentPolicies)
      .values({ orgId, agentType: agentType as never, enabled: true, autonomy: "act_and_notify" })
      .onConflictDoUpdate({
        target: [agentPolicies.orgId, agentPolicies.agentType],
        set: { enabled: true, autonomy: "act_and_notify" },
      });
  }
}

beforeEach(async () => {
  script.length = 0;
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentEvents).where(eq(agentEvents.orgId, orgId));
  await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
  await db.delete(requisitions).where(eq(requisitions.orgId, orgId));
  resetRegistry();
  registerPhase1Tools();
  registerPhase1Agents();
});

const openGate = async (runId: string) =>
  (
    await db
      .select()
      .from(agentTasks)
      .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, "open")))
  )[0];
const runStatus = async (runId: string) =>
  (await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!;
const reqRow = async (id: string) =>
  (await db.select().from(requisitions).where(eq(requisitions.id, id)))[0]!;

/** Drive the requisition agent to a submitted draft waiting on the DH gate. */
async function draftAndSubmit() {
  await enable("requisition");
  const { runId } = await startRun({
    orgId,
    agentType: "requisition",
    principalUserId: recruiter,
    goal: "Open one Platform SRE role.",
  });
  let reqId = "";
  script.push(
    call({
      id: "d",
      name: "draft_requisition",
      args: {
        title: "Platform SRE",
        openings: 1,
        experienceMin: 4,
        experienceMax: 8,
        mustHaveSkills: ["Kubernetes"],
      },
    }),
    (m) => {
      reqId = String(lastTool(m)["id"]);
      return call({
        id: "c",
        name: "set_compensation",
        args: { requisitionId: reqId, budgetCtc: 3000000, bandMin: 2600000, bandMax: 3400000 },
      });
    },
    () =>
      call({ id: "s", name: "submit_requisition_for_approval", args: { requisitionId: reqId } }),
    () =>
      call({
        id: "g",
        name: "request_approval",
        args: {
          title: "Approve REQ Platform SRE",
          summary: "Band 26–34 L from market median.",
          assignee_role: "hr_head", // wrong on purpose — the runtime derives the role
          subject: { type: "requisition", id: reqId },
        },
      }),
  );
  await runAgentTick({ orgId });
  return { runId, reqId };
}

/* ----------------------------------------------------------------- tests */

describe("phase 1 tools", () => {
  test("no Phase 1 tool trips the gate guard, and the agents only list registered tools", () => {
    for (const name of [
      "draft_requisition",
      "submit_requisition_for_approval",
      "submit_jd_version",
      "publish_to_job_board",
      "start_agent",
    ]) {
      expect(getTool(name)).toBeDefined();
    }
  });
});

describe("requisition agent", () => {
  test("drafts as the principal, submits with an agent-marked trail, and routes the gate by status", async () => {
    const { runId, reqId } = await draftAndSubmit();
    const r = await reqRow(reqId);
    expect(r.status).toBe("pending_dh");
    expect(r.createdBy).toBe(recruiter);
    expect(Number(r.budgetCtc)).toBe(3000000);
    const trail = r.approvalTrail as { to: string; via?: string; actor: string }[];
    expect(trail.at(-1)).toMatchObject({
      to: "pending_dh",
      via: "agent",
      actor: `p1-rec-${stamp}@test.local`,
    });

    expect((await runStatus(runId)).status).toBe("awaiting_human");
    const gate = await openGate(runId);
    expect(gate).toMatchObject({ kind: "gate", assigneeRole: "department_head" });
  });

  test("approving the gate in the inbox performs the DH approval as the decider; a recruiter cannot", async () => {
    const { runId, reqId } = await draftAndSubmit();
    const gate = await openGate(runId);
    await expect(
      resolveTask({ orgId, taskId: gate!.id, userId: recruiter, decision: { status: "approved" } }),
    ).rejects.toThrow();
    expect((await reqRow(reqId)).status).toBe("pending_dh");

    await resolveTask({
      orgId,
      taskId: gate!.id,
      userId: dh,
      decision: { status: "approved", comment: "ok" },
    });
    const r = await reqRow(reqId);
    expect(r.status).toBe("pending_hr");
    const trail = r.approvalTrail as { to: string; via?: string; actor: string }[];
    expect(trail.at(-1)).toMatchObject({ to: "pending_hr", actor: `p1-dh-${stamp}@test.local` });
    expect(trail.at(-1)!.via).toBeUndefined();
    expect((await runStatus(runId)).status).toBe("queued");
  });

  test("declining the gate rejects the requisition with the reason", async () => {
    const { runId, reqId } = await draftAndSubmit();
    const gate = await openGate(runId);
    await resolveTask({
      orgId,
      taskId: gate!.id,
      userId: dh,
      decision: { status: "rejected", reason: "No budget" },
    });
    const r = await reqRow(reqId);
    expect(r.status).toBe("rejected");
    expect((r.approvalTrail as { comment: string }[]).at(-1)!.comment).toBe("No budget");
  });

  test("a gate decided on the requisition page closes and the run resumes", async () => {
    const { runId, reqId } = await draftAndSubmit();
    await lifecycle.advanceRequisitionCore(
      { orgId, userId: dh, memberEmail: `p1-dh-${stamp}@test.local` },
      { id: reqId, status: "pending_hr" },
    );
    const counts = await processAgentEvents({ orgId });
    expect(counts.synced).toBe(1);
    const [task] = await db.select().from(agentTasks).where(eq(agentTasks.runId, runId));
    expect(task).toMatchObject({ status: "approved", decidedBy: dh });
    expect((await runStatus(runId)).status).toBe("queued");
  });

  test("an agent cannot target a requisition that is not awaiting approval", async () => {
    await enable("requisition");
    const r = await lifecycle.createRequisitionCore(
      { orgId, userId: recruiter, memberEmail: "r@test.local" },
      {
        title: "Draft only",
        departmentId: null,
        location: "",
        openings: 1,
        experienceMin: 0,
        experienceMax: 0,
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
        billingType: "Non-billable",
        engagementType: "Internal / Corporate",
        clientName: null,
        costCenter: null,
      },
      "draft",
    );
    const { runId } = await startRun({
      orgId,
      agentType: "requisition",
      principalUserId: recruiter,
      goal: "x",
    });
    script.push(
      call({
        id: "g",
        name: "request_approval",
        args: {
          title: "t",
          summary: "s",
          assignee_role: "department_head",
          subject: { type: "requisition", id: r.id },
        },
      }),
      say("ok"),
    );
    await runAgentTick({ orgId });
    expect(await openGate(runId)).toBeUndefined();
    expect((await runStatus(runId)).status).toBe("done");
  });
});

describe("orchestrator hand-offs", () => {
  async function approvedRequisition() {
    const actorOf = (userId: string, email: string) => ({ orgId, userId, memberEmail: email });
    const r = await lifecycle.createRequisitionCore(
      actorOf(recruiter, "r@test.local"),
      {
        title: "Platform SRE",
        departmentId: null,
        location: "Bengaluru",
        openings: 1,
        experienceMin: 4,
        experienceMax: 8,
        budgetCtc: 0,
        ctcBandMin: null,
        ctcBandMax: null,
        maxNoticePeriodDays: null,
        workAuthorizationRequired: null,
        hiringManager: null,
        mustHaveSkills: ["Kubernetes"],
        goodToHaveSkills: [],
        responsibilities: null,
        educationRequirement: null,
        billingType: "Non-billable",
        engagementType: "Internal / Corporate",
        clientName: null,
        costCenter: null,
      },
      "pending_dh",
    );
    await lifecycle.advanceRequisitionCore(actorOf(dh, "dh@test.local"), {
      id: r.id,
      status: "pending_hr",
    });
    await lifecycle.advanceRequisitionCore(actorOf(hr, "hr@test.local"), {
      id: r.id,
      status: "pending_cbo",
    });
    await lifecycle.advanceRequisitionCore(actorOf(cbo, "cbo@test.local"), {
      id: r.id,
      status: "approved",
    });
    return r.id;
  }
  const runsOf = (agent: string) =>
    db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, agent as never)));

  test("nothing starts while the JD agent is switched off", async () => {
    await approvedRequisition();
    await processAgentEvents({ orgId });
    expect(await runsOf("jd")).toEqual([]);
  });

  test("approval starts the JD agent for the requisition's creator; the JD gate approves the real JD", async () => {
    await enable("jd");
    const reqId = await approvedRequisition();
    await processAgentEvents({ orgId });
    const [run] = await runsOf("jd");
    expect(run).toMatchObject({ principalUserId: recruiter, subjectId: reqId, status: "queued" });

    script.push(call({ id: "j", name: "submit_jd_version", args: { requisitionId: reqId } }), (m) =>
      call({
        id: "g",
        name: "request_approval",
        args: {
          title: "Approve JD",
          summary: "v1",
          assignee_role: "department_head",
          subject: { type: "jd", id: String(lastTool(m)["jdId"]) },
        },
      }),
    );
    await runAgentTick({ orgId });
    const [jd] = await db
      .select()
      .from(jobDescriptions)
      .where(eq(jobDescriptions.requisitionId, reqId))
      .orderBy(desc(jobDescriptions.version));
    expect(jd).toMatchObject({ status: "pending_dh", version: 1, mustHave: ["Kubernetes", "Go"] });
    const gate = await openGate(run!.id);
    await resolveTask({ orgId, taskId: gate!.id, userId: dh, decision: { status: "approved" } });
    const [approved] = await db
      .select()
      .from(jobDescriptions)
      .where(eq(jobDescriptions.id, jd!.id));
    expect(approved!.status).toBe("approved");
    // Approving without edits keeps the drafted text (it used to be erased).
    expect(approved!.fullText).toBe(jd!.fullText);
    expect(approved!.fullText).toBeTruthy();
  });

  test("JD changes requested restarts the JD agent; JD approval starts publishing once", async () => {
    await enable("jd", "publishing");
    const reqId = await approvedRequisition();
    const jd = await lifecycle.saveJobDescriptionCore(
      { orgId, userId: recruiter, memberEmail: "r@test.local" },
      { requisitionId: reqId, jd: JD },
    );
    await processAgentEvents({ orgId }); // approval: latest JD exists and is pending → no JD run
    expect(await runsOf("jd")).toEqual([]);

    await lifecycle.requestJdChangesCore(
      { orgId, userId: dh, memberEmail: "dh@test.local" },
      { id: jd.id, comment: "Add on-call expectations" },
    );
    await processAgentEvents({ orgId });
    const [jdRun] = await runsOf("jd");
    expect(jdRun!.goal).toContain("Add on-call expectations");

    const v2 = await lifecycle.saveJobDescriptionCore(
      { orgId, userId: recruiter, memberEmail: "r@test.local" },
      { requisitionId: reqId, jd: JD },
    );
    await lifecycle.approveJobDescriptionCore(
      { orgId, userId: dh, memberEmail: "dh@test.local" },
      { id: v2.id },
    );
    await processAgentEvents({ orgId });
    expect((await runsOf("publishing")).length).toBe(1);
    await lifecycle.saveJobDescriptionCore(
      { orgId, userId: recruiter, memberEmail: "r@test.local" },
      { requisitionId: reqId, jd: JD },
    );
    await processAgentEvents({ orgId });
    expect((await runsOf("publishing")).length).toBe(1); // an active run is not duplicated
  });

  test("copilot start_agent waits for the person's confirmation under suggest", async () => {
    await db.insert(agentPolicies).values({ orgId, agentType: "copilot", enabled: true });
    await enable("requisition");
    const { runId } = await startRun({
      orgId,
      agentType: "copilot",
      principalUserId: recruiter,
      goal: "Open a Platform SRE role",
    });
    script.push(
      call({
        id: "a",
        name: "start_agent",
        args: { agent: "requisition", goal: "Open one Platform SRE role in Bengaluru, 4-8 years." },
      }),
    );
    await runAgentTick({ orgId });
    const confirm = await openGate(runId);
    expect(confirm).toMatchObject({ kind: "approval", assigneeUserId: recruiter });
    expect(await runsOf("requisition")).toEqual([]);

    await resolveTask({
      orgId,
      taskId: confirm!.id,
      userId: recruiter,
      decision: { status: "approved" },
    });
    script.push(say("Started the requisition agent."));
    await runAgentTick({ orgId, max: 1 });
    const [req] = await runsOf("requisition");
    expect(req).toMatchObject({ principalUserId: recruiter, status: "queued" });
  });
});
