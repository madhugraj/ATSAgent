/**
 * Phase 6a — hiring desk (docs/agentic-plan.md §13.2) against the disposable
 * local database, with the desk model and the agent model scripted:
 *  - slot filling: one question at a time until the need is complete, then
 *    similar roles;
 *  - continuing with an existing approved role ranks candidates; a new role is
 *    created as the person and handed to the Requisition agent; an agent that
 *    is switched off is reported, not silently queued;
 *  - an approved JD of an earlier role is reused (audited) when chosen;
 *  - runs for a thread post their requests, results and the ranked list;
 *  - "talk to the first 2" resolves ranks and starts screening; candidates of
 *    another role are refused.
 * Run: DATABASE_URL=... SESSION_SECRET=... bun test scripts/agent-phase6a.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { AgentStepResult } from "../src/lib/ai-gateway.server";

/* ------------------------------------------------------------ fake models */

type Turn = { slots?: Record<string, unknown>; command?: Record<string, unknown>; reply?: string };
const deskScript: Turn[] = [];
let lastDeskPrompt = "";
const agentScript: AgentStepResult[] = [];
let researchCalls = 0;
let researchResult: unknown = { ok: false, message: "no research scripted" };
const say = (text: string): AgentStepResult => ({
  ok: true,
  text,
  toolCalls: [],
  stopReason: "end",
  usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
});

const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiJson: async (opts: { prompt?: string; schema?: { parse: (v: unknown) => unknown } }) => {
    lastDeskPrompt = opts.prompt ?? "";
    const t = deskScript.shift() ?? { reply: "" };
    const data = opts.schema ? opts.schema.parse(t) : t;
    return { ok: true, data, usage: null };
  },
  aiAgentStep: async () => agentScript.shift() ?? say("(done)"),
  aiResearchJson: async () => {
    researchCalls++;
    return researchResult;
  },
}));

const { db } = await import("../src/server/db");
const {
  agentEvents,
  agentPolicies,
  agentRuns,
  agentTasks,
  applications,
  auditLog,
  candidates,
  hiringConversations,
  hiringMessages,
  jobDescriptions,
  matchScores,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const { registerAgent, resetRegistry } = await import("../src/server/agents/registry");
const { runAgentTick } = await import("../src/server/agents/runtime.server");
const desk = await import("../src/server/desk/desk.server");

/* -------------------------------------------------------------- fixtures */

const stamp = Date.now();
let orgId: string;
let otherOrgId: string;
let recruiter: string;
let existingReq: string;
let otherReq: string;
const apps: string[] = [];
let foreignApp: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db
    .insert(users)
    .values({ email: `desk-${stamp}@test.local` })
    .returning({ id: users.id });
  recruiter = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Desk Org", slug: `desk-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [o2] = await db
    .insert(organizations)
    .values({ name: "Other Org", slug: `desk-other-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  otherOrgId = o2!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId: recruiter,
    email: `desk-${stamp}@test.local`,
    status: "active",
    isOwner: false,
  });
  await db.insert(userRoles).values({ userId: recruiter, orgId, role: "recruiter" });

  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-D-${stamp}`,
      title: "Full Stack Developer",
      location: "Chennai",
      status: "approved",
      mustHaveSkills: ["React", "Node.js"],
      createdBy: recruiter,
    })
    .returning({ id: requisitions.id });
  existingReq = r!.id;
  await db.insert(jobDescriptions).values({
    orgId,
    requisitionId: existingReq,
    version: 1,
    status: "approved",
    purpose: "Build the product end to end",
    fullText: "Full stack JD text",
  } as never);
  for (const [i, name] of ["Asha", "Bala", "Chitra"].entries()) {
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: name, email: `${name}-${stamp}@cand.local`, skills: ["React"] })
      .returning({ id: candidates.id });
    const [a] = await db
      .insert(applications)
      .values({
        orgId,
        requisitionId: existingReq,
        candidateId: c!.id,
        stage: "shortlisted",
        source: "pool",
      } as never)
      .returning({ id: applications.id });
    await db.insert(matchScores).values({
      orgId,
      applicationId: a!.id,
      overallScore: [62, 91, 78][i]!,
      recommendation: "select",
      matchedSkills: ["React"],
    } as never);
    apps.push(a!.id);
  }
  const [r2] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-D2-${stamp}`,
      title: "QA Engineer",
      location: "Pune",
      status: "approved",
      createdBy: recruiter,
    })
    .returning({ id: requisitions.id });
  otherReq = r2!.id;
  const [fc] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Elsewhere", email: `else-${stamp}@cand.local` })
    .returning({ id: candidates.id });
  const [fa] = await db
    .insert(applications)
    .values({
      orgId,
      requisitionId: otherReq,
      candidateId: fc!.id,
      stage: "applied",
      source: "apply",
    } as never)
    .returning({ id: applications.id });
  foreignApp = fa!.id;
  // Scored, so the orchestrator's intake sweep leaves these roles alone and
  // the scripted model replies go only to the runs under test.
  await db
    .insert(matchScores)
    .values({ orgId, applicationId: foreignApp, overallScore: 50 } as never);
});

afterAll(async () => {
  await db.delete(organizations).where(inArray(organizations.id, [orgId, otherOrgId]));
  await db.delete(users).where(eq(users.id, recruiter));
});

const AGENTS = ["requisition", "jd", "intake", "screening"] as const;

beforeEach(async () => {
  deskScript.length = 0;
  agentScript.length = 0;
  await db.delete(hiringConversations).where(eq(hiringConversations.orgId, orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentEvents).where(eq(agentEvents.orgId, orgId));
  await db.delete(auditLog).where(eq(auditLog.orgId, orgId));
  await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
  await db
    .delete(requisitions)
    .where(
      and(eq(requisitions.orgId, orgId), inArray(requisitions.status, ["draft", "pending_dh"])),
    );
  await db
    .insert(agentPolicies)
    .values(AGENTS.map((agentType) => ({ orgId, agentType, enabled: true })));
  resetRegistry();
  for (const type of AGENTS)
    registerAgent({
      type,
      name: `${type} test agent`,
      version: "0.0.0-test",
      owner: "hr_head",
      responsibility: "Test fixture.",
      mustNever: [],
      scope: { reads: [], writes: [], external: [] },
      gates: ["general"],
      riskTier: "low",
      evals: [],
      feature: `agent_${type}`,
      system: "Test agent.",
      tools: [],
    });
});

async function newConversation() {
  const [c] = await db
    .insert(hiringConversations)
    .values({ orgId, createdBy: recruiter })
    .returning();
  return c!;
}
const reload = (id: string) => desk.loadConversation(orgId, id);
const messages = (id: string) =>
  db
    .select()
    .from(hiringMessages)
    .where(eq(hiringMessages.conversationId, id))
    .orderBy(hiringMessages.createdAt);
const runsOf = (conversationId: string) =>
  db.select().from(agentRuns).where(eq(agentRuns.conversationId, conversationId));

/* ------------------------------------------------------------------ slots */

describe("slot filling", () => {
  test("merge never erases and orders an inverted range", () => {
    const s = desk.mergeSlots(
      { roleTitle: "Full Stack Developer", mustHaveSkills: ["React"] },
      { mustHaveSkills: [], experienceMin: 8, experienceMax: 4 },
    );
    expect(s.mustHaveSkills).toEqual(["React"]);
    expect([s.experienceMin, s.experienceMax]).toEqual([4, 8]);
    expect(desk.missingSlots(s)).toEqual(["location", "openings"]);
  });

  test("asks one question at a time, then shows similar roles", async () => {
    const conv = await newConversation();
    deskScript.push({
      slots: { roleTitle: "Full Stack Developer", location: "Chennai", openings: 1 },
      reply: "How many years of experience should candidates have?",
    });
    await desk.handleUserMessage(
      conv,
      recruiter,
      "Hey, I need a candidate for Full stack, Chennai",
    );
    let m = await messages(conv.id);
    expect(m.map((x) => x.role)).toEqual(["user", "desk"]);
    expect(m[1]!.body).toMatch(/experience/);
    expect((await reload(conv.id)).status).toBe("gathering");

    deskScript.push({
      slots: { experienceMin: 3, experienceMax: 6, mustHaveSkills: ["React", "Node.js"] },
    });
    await desk.handleUserMessage(await reload(conv.id), recruiter, "3 to 6 years, React and Node");
    // Then one question for a deeper JD; any answer moves on.
    expect((await messages(conv.id)).at(-1)!.body).toMatch(/key responsibilities/);
    deskScript.push({ slots: { responsibilities: "Own the product end to end" } });
    await desk.handleUserMessage(await reload(conv.id), recruiter, "own the product end to end");
    const c = await reload(conv.id);
    expect(c.status).toBe("confirming");
    m = await messages(conv.id);
    const card = m.at(-1)!.card as {
      type: string;
      items: { requisitionId: string; usable: boolean }[];
    };
    expect(card.type).toBe("similar_roles");
    expect(card.items.find((i) => i.requisitionId === existingReq)?.usable).toBe(true);
  });

  test("a missing detail falls back to a fixed question when the model gives none", async () => {
    const conv = await newConversation();
    deskScript.push({ slots: { roleTitle: "Data Analyst" }, reply: "" });
    await desk.handleUserMessage(conv, recruiter, "Need a data analyst");
    expect((await messages(conv.id)).at(-1)!.body).toBe("Which location is this role based in?");
  });
});

/* ------------------------------------------------------------- the role */

const complete = {
  roleTitle: "Full Stack Developer",
  location: "Chennai",
  experienceMin: 3,
  experienceMax: 6,
  openings: 1,
  mustHaveSkills: ["React", "Node.js"],
};

async function confirming() {
  const conv = await newConversation();
  await db
    .update(hiringConversations)
    .set({ slots: complete as never, status: "confirming" })
    .where(eq(hiringConversations.id, conv.id));
  return reload(conv.id);
}

describe("choosing the role", () => {
  test("an approved role with an approved JD goes straight to matching", async () => {
    const conv = await confirming();
    await desk.continueWithRole(conv, recruiter, existingReq);
    const c = await reload(conv.id);
    expect(c.requisitionId).toBe(existingReq);
    expect(c.status).toBe("active");
    const runs = await runsOf(conv.id);
    expect(runs.map((r) => r.agentType)).toEqual(["intake"]);
    expect(runs[0]!.subjectId).toBe(existingReq);
  });

  test("a new role is drafted as the person and handed to the Requisition agent", async () => {
    const conv = await confirming();
    const { requisitionId } = await desk.createNewRole(conv, recruiter);
    const [req] = await db.select().from(requisitions).where(eq(requisitions.id, requisitionId));
    expect(req).toMatchObject({
      status: "draft",
      title: "Full Stack Developer",
      createdBy: recruiter,
      openings: 1,
    });
    expect(req!.mustHaveSkills).toEqual(["React", "Node.js"]);
    const runs = await runsOf(conv.id);
    expect(runs.map((r) => r.agentType)).toEqual(["requisition"]);
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "desk.requisition_created")));
    expect(a?.entityId).toBe(requisitionId);
  });

  test("a switched-off agent is reported in the thread, not silently queued", async () => {
    await db
      .update(agentPolicies)
      .set({ enabled: false })
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, "requisition")));
    const conv = await confirming();
    await desk.createNewRole(conv, recruiter);
    expect(await runsOf(conv.id)).toHaveLength(0);
    expect((await messages(conv.id)).at(-1)!.body).toMatch(/switched off/);
  });

  test("reusing an approved JD files it as approved when the new role is approved", async () => {
    const conv = await confirming();
    const { requisitionId } = await desk.createNewRole(conv, recruiter, {
      reuseJdFrom: existingReq,
    });
    await db
      .update(requisitions)
      .set({ status: "approved" })
      .where(eq(requisitions.id, requisitionId));
    expect(await desk.reuseJdIfChosen(orgId, requisitionId)).toBe(true);
    const [jd] = await db
      .select()
      .from(jobDescriptions)
      .where(eq(jobDescriptions.requisitionId, requisitionId));
    expect(jd).toMatchObject({ status: "approved", purpose: "Build the product end to end" });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "jd.reused")));
    expect(audit?.actorUserId).toBe(recruiter);
    const [ev] = await db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "jd.approved")));
    expect(ev?.subjectId).toBe(jd!.id);
    // Idempotent.
    expect(await desk.reuseJdIfChosen(orgId, requisitionId)).toBe(true);
    expect(
      await db
        .select()
        .from(jobDescriptions)
        .where(eq(jobDescriptions.requisitionId, requisitionId)),
    ).toHaveLength(1);
  });

  test("reusing a JD from a role without an approved JD is refused", async () => {
    const conv = await confirming();
    await expect(desk.createNewRole(conv, recruiter, { reuseJdFrom: otherReq })).rejects.toThrow(
      /no approved job description/,
    );
  });
});

/* ------------------------------------------------------- runs → thread */

describe("runs post to their thread", () => {
  test("a run on the thread's requisition is linked; its result and the ranked list are posted", async () => {
    const conv = await confirming();
    await desk.continueWithRole(conv, recruiter, existingReq);
    agentScript.push(say("Scored 3 candidates; Bala is the strongest."));
    await runAgentTick({ orgId });
    const m = await messages(conv.id);
    expect(m.some((x) => x.role === "agent" && x.body.includes("Bala is the strongest"))).toBe(
      true,
    );
    const ranked = m.at(-1)!.card as { type: string; items: { name: string; rank: number }[] };
    expect(ranked.type).toBe("ranked_candidates");
    expect(ranked.items.map((i) => i.name)).toEqual(["Bala", "Chitra", "Asha"]);
  });

  test("a request for a person appears as a task card", async () => {
    const conv = await confirming();
    await desk.continueWithRole(conv, recruiter, existingReq);
    agentScript.push({
      ok: true,
      text: "",
      toolCalls: [{ id: "q1", name: "ask_human", args: { question: "Remote allowed?" } }],
      stopReason: "tool_use",
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    });
    await runAgentTick({ orgId });
    const card = (await messages(conv.id)).at(-1)!.card as {
      type: string;
      taskId: string;
      kind: string;
    };
    expect(card).toMatchObject({ type: "task", kind: "clarification" });
    const [task] = await db.select().from(agentTasks).where(eq(agentTasks.id, card.taskId));
    expect(task?.status).toBe("open");
    expect(await desk.taskStatuses(orgId, [card.taskId])).toEqual({ [card.taskId]: "open" });
  });
});

/* -------------------------------------------------------------- screening */

describe("talk to the first N", () => {
  test("ranks resolve against the latest list and start screening", async () => {
    const conv = await confirming();
    await desk.continueWithRole(conv, recruiter, existingReq);
    agentScript.push(say("Ranked."));
    await runAgentTick({ orgId });
    deskScript.push({ command: { type: "screen", top: 2 } });
    await desk.handleUserMessage(await reload(conv.id), recruiter, "talk to the first 2");
    const screening = (await runsOf(conv.id)).find((r) => r.agentType === "screening");
    expect(screening).toBeDefined();
    expect(screening!.goal).toContain(apps[1]!); // Bala, rank 1
    expect(screening!.goal).toContain(apps[2]!); // Chitra, rank 2
    expect(screening!.goal).not.toContain(apps[0]!);
    expect((await messages(conv.id)).at(-1)!.body).toMatch(/Bala, Chitra/);
  });

  test("candidates of another role are refused", async () => {
    const conv = await confirming();
    await desk.continueWithRole(conv, recruiter, existingReq);
    await expect(
      desk.screenCandidates(await reload(conv.id), recruiter, [foreignApp]),
    ).rejects.toThrow(/not in this role's pipeline/);
  });
});

/* ------------------------------------------------- progress and recovery */

describe("what happens next", () => {
  test("progress shows the current stage and its agent", async () => {
    const conv = await confirming();
    let p = await desk.deskProgress(conv);
    expect(p.stages.find((s) => s.state === "current")?.key).toBe("requisition");
    // An approved role with an approved JD and scored candidates is at screening.
    await desk.continueWithRole(conv, recruiter, existingReq);
    p = await desk.deskProgress(await reload(conv.id));
    expect(p.stages.filter((s) => s.state === "done").map((s) => s.key)).toEqual([
      "need",
      "requisition",
      "jd",
      "candidates",
    ]);
    expect(p.next).toMatchObject({
      stage: "screening",
      agentType: "screening",
      agentEnabled: true,
    });
  });

  test("a stopped run can be tried again from the thread", async () => {
    const conv = await confirming();
    await desk.continueWithRole(conv, recruiter, existingReq);
    agentScript.push({
      ok: false,
      status: 400,
      message: "Function call is missing a thought_signature",
    } as never);
    await runAgentTick({ orgId });
    const [failed] = (await runsOf(conv.id)).filter((r) => r.status === "failed");
    expect(failed).toBeDefined();
    const m = await messages(conv.id);
    const stop = m.find((x) => (x.card as { type?: string } | null)?.type === "run_failed")!;
    expect(stop.body).toMatch(/AI model or one of its tools returned an error/);
    expect(stop.body).not.toMatch(/thought_signature/);

    const again = await desk.retryRun(await reload(conv.id), recruiter, failed!.id);
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, again));
    expect(r).toMatchObject({ status: "queued", agentType: "intake", conversationId: conv.id });
    await expect(desk.retryRun(await reload(conv.id), recruiter, again)).rejects.toThrow(
      /stopped run/,
    );
  });

  test("a switched-off next agent is announced once", async () => {
    const conv = await confirming();
    await desk.continueWithRole(conv, recruiter, existingReq);
    await desk.notifyAgentOff(orgId, existingReq, "jd");
    await desk.notifyAgentOff(orgId, existingReq, "jd");
    const off = (await messages(conv.id)).filter((x) => /switched off/.test(x.body));
    expect(off).toHaveLength(1);
  });

  test("failure reasons are plain and vendor-neutral", () => {
    expect(desk.failureReason("Invalid API key provided")).toMatch(/rejected the key/);
    expect(desk.failureReason("429 Resource has been exhausted")).toMatch(/busy or out of quota/);
    expect(desk.failureReason("The run reached its step or token budget.")).toBe(
      "The run reached its step or token budget.",
    );
  });
});

describe("approval chains read as progress", () => {
  test("steps are labelled by chain position and approver", () => {
    const gate = (type: string, expects: string, role: string) => ({
      kind: "gate",
      assigneeRole: role,
      proposedAction: { args: { subject: { type, expects } } },
    });
    expect(desk.taskStep(gate("requisition", "pending_dh", "department_head"))).toBe(
      "Approval 1 of 3 · Department head",
    );
    expect(desk.taskStep(gate("requisition", "pending_cbo", "president_cbo"))).toBe(
      "Approval 3 of 3 · CBO",
    );
    expect(desk.taskStep(gate("offer", "pending_hr", "hr_head"))).toBe("Approval 1 of 2 · HR head");
    expect(desk.taskStep({ kind: "gate", assigneeRole: "hiring_manager" })).toBe(
      "Decision · Hiring manager",
    );
    expect(desk.taskStep({ kind: "approval" })).toBeNull();
  });

  test("the next approver's identical brief is flagged as repeated", async () => {
    const conv = await confirming();
    const run = { conversationId: conv.id, orgId, agentType: "requisition" };
    const base = { kind: "gate", title: "Requisition approval", body: "Same brief" };
    await desk.onTaskOpened(run, {
      ...base,
      id: crypto.randomUUID(),
      assigneeRole: "department_head",
      proposedAction: { args: { subject: { type: "requisition", expects: "pending_dh" } } },
    });
    await desk.onTaskOpened(run, {
      ...base,
      id: crypto.randomUUID(),
      assigneeRole: "hr_head",
      proposedAction: { args: { subject: { type: "requisition", expects: "pending_hr" } } },
    });
    const cards = (await messages(conv.id))
      .map((m) => m.card as { type?: string; step?: string; repeated?: boolean } | null)
      .filter((c) => c?.type === "task");
    expect(cards.map((c) => [c!.step, Boolean(c!.repeated)])).toEqual([
      ["Approval 1 of 3 · Department head", false],
      ["Approval 2 of 3 · HR head", true],
    ]);
    expect((await messages(conv.id)).at(-1)!.body).toBe(
      "Approval 2 of 3 — waiting for the HR head.",
    );
  });
});

describe("keep the person informed", () => {
  test("approval details are readable (money, weights) and hide ids", () => {
    expect(
      desk.argDetails("set_compensation", {
        requisitionId: "x",
        budgetCtc: 9000000,
        bandMin: 7500000,
        bandMax: 11000000,
      }),
    ).toEqual([
      { label: "Budget Ctc", value: "₹90,00,000" },
      { label: "Band Min", value: "₹75,00,000" },
      { label: "Band Max", value: "₹1,10,00,000" },
    ]);
    expect(
      desk.argDetails("save_weights", { requisitionId: "x", skills: 30, experience: 25 }),
    ).toEqual([{ label: "Weights", value: "Skills 30% · Experience 25%" }]);
    expect(desk.stepLabel("research_compensation")).toBe("Researched market pay");
    expect(desk.stepLabel("some_new_tool")).toBe("Some new tool");
  });

  test("switching the next agent on continues a thread that was waiting for it", async () => {
    // An approved role without a JD, with the JD agent off: the thread is stuck at "jd".
    const [r] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-J-${stamp}`,
        title: "Data Engineer",
        location: "Chennai",
        status: "approved",
        createdBy: recruiter,
      })
      .returning({ id: requisitions.id });
    await db
      .update(agentPolicies)
      .set({ enabled: false })
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, "jd")));
    const conv = await confirming();
    await db
      .update(hiringConversations)
      .set({ requisitionId: r!.id, status: "active" })
      .where(eq(hiringConversations.id, conv.id));
    let c = await reload(conv.id);
    expect((await desk.deskProgress(c)).next).toMatchObject({ stage: "jd", agentEnabled: false });
    expect(await desk.startStage(c, recruiter, { dryRun: true })).toBeNull();

    await db
      .update(agentPolicies)
      .set({ enabled: true })
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, "jd")));
    c = await reload(conv.id);
    expect(await desk.startStage(c, recruiter, { dryRun: true })).toBe("jd");
    expect(await desk.resumeThreadsForAgent(orgId, "jd")).toBe(1);
    const runs = await runsOf(conv.id);
    expect(runs.map((x) => [x.agentType, x.status])).toEqual([["jd", "queued"]]);
    // Nothing more to start while it is running; activity shows it starting.
    expect(await desk.startStage(await reload(conv.id), recruiter, { dryRun: true })).toBeNull();
    const act = await desk.deskActivity(await reload(conv.id));
    expect(act).toMatchObject({ agentType: "jd", status: "queued" });
    expect(act!.steps.at(-1)).toEqual({ label: "Starting", state: "working" });
  });
});

describe("deeper JDs, smarter search, reasoning", () => {
  test("the desk asks once for JD details, then moves on (any answer or 'research it')", async () => {
    const conv = await newConversation();
    await db
      .update(hiringConversations)
      .set({ slots: { ...complete } as never })
      .where(eq(hiringConversations.id, conv.id));
    deskScript.push({ reply: "" });
    await desk.handleUserMessage(await reload(conv.id), recruiter, "that's all");
    expect((await messages(conv.id)).at(-1)!.body).toMatch(/key responsibilities/);
    expect((await reload(conv.id)).status).toBe("gathering");
    deskScript.push({ slots: { researchRole: true, reportingTo: "CTO" } });
    await desk.handleUserMessage(
      await reload(conv.id),
      recruiter,
      "research it, reports to the CTO",
    );
    const c = await reload(conv.id);
    expect(c.status).toBe("confirming");
    const brief = desk.jdBrief(c.slots as never)!;
    expect(brief).toContain("Reports to: CTO");
    expect(brief).toMatch(/from typical market practice/);
  });

  test("templates: default first, else the only one, else the closest name", async () => {
    const { contentTemplates } = await import("../drizzle/schema");
    const { pickTemplate } = await import("../src/lib/templates.server");
    expect(await pickTemplate(orgId, "jd", "Data Engineer")).toBeNull();
    const add = (name: string, isDefault = false) =>
      db
        .insert(contentTemplates)
        .values({ orgId, kind: "jd", name, isDefault, config: {} } as never)
        .returning({ id: contentTemplates.id });
    await add("Sales roles");
    expect((await pickTemplate(orgId, "jd", "Data Engineer"))?.reason).toMatch(/only template/);
    await add("Engineering leadership");
    expect((await pickTemplate(orgId, "jd", "VP Engineering"))?.name).toBe(
      "Engineering leadership",
    );
    await add("House style", true);
    expect(await pickTemplate(orgId, "jd", "VP Engineering")).toMatchObject({
      name: "House style",
      reason: "your default template",
    });
    await db.delete(contentTemplates).where(eq(contentTemplates.orgId, orgId));
  });

  test("pool search matches by meaning and whole words, and says why", async () => {
    const { rankPool } = await import("../src/server/agents/talent-search.server");
    const groups = [
      { skill: "LLM", terms: ["LLM", "large language models", "GenAI"] },
      { skill: "Go", terms: ["Go", "Golang"] },
    ];
    const person = (name: string, skills: string[], cv: string, exp = 20) => ({
      candidateId: name,
      name,
      experienceYears: exp,
      location: "Chennai",
      skills,
      resumeText: cv,
      currentEmployer: null,
    });
    const ranked = rankPool(
      [
        person("Asha", ["Large Language Models", "Golang"], ""),
        person("Bala", [], "Led GenAI research; a good team player"),
        person("Chitra", ["Excel"], "Very good at reporting"), // "good" is not "Go"
      ],
      groups,
      { experienceMin: 15, experienceMax: 25, location: "Chennai" },
    );
    expect(ranked.map((r) => r.name)).toEqual(["Asha", "Bala"]);
    expect(ranked[0]).toMatchObject({ skillHits: ["LLM", "Go"] });
    expect(ranked[1]).toMatchObject({ skillHits: [], textHits: ["LLM"] });
    expect(ranked[1]!.why).toMatch(/in CV: LLM/);
  });

  test("too few candidates asks for more; reasoning is read from the match score", async () => {
    const [r] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-E-${stamp}`,
        title: "Empty role",
        location: "Pune",
        status: "approved",
        createdBy: recruiter,
      })
      .returning({ id: requisitions.id });
    const conv = await confirming();
    await db
      .update(hiringConversations)
      .set({ requisitionId: r!.id, status: "active" })
      .where(eq(hiringConversations.id, conv.id));
    await desk.postRankedList(await reload(conv.id));
    const last = (await messages(conv.id)).at(-1)!;
    expect(last.card).toMatchObject({ type: "bring_candidates", found: 0 });

    await db
      .update(matchScores)
      .set({
        rationale: "Strong React evidence.",
        skillsScore: 88,
        riskFlags: ["short tenures"],
      } as never)
      .where(eq(matchScores.applicationId, apps[1]!));
    const why = await desk.candidateReasoning(orgId, [apps[1]!]);
    expect(why[apps[1]!]).toMatchObject({
      rationale: "Strong React evidence.",
      risks: ["short tenures"],
    });
    expect(why[apps[1]!]!.breakdown.find((b) => b.label === "Skills")?.score).toBe(88);
    // Another organisation's applications are never read.
    expect(await desk.candidateReasoning(otherOrgId, [apps[1]!])).toEqual({});
  });
});

describe("the thread follows the requisition", () => {
  async function approvedRoleThread() {
    const [r] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-C-${Math.random().toString(36).slice(2, 7)}`,
        title: "Closing role",
        location: "Chennai",
        status: "approved",
        createdBy: recruiter,
      })
      .returning({ id: requisitions.id });
    const conv = await confirming();
    await db
      .update(hiringConversations)
      .set({ requisitionId: r!.id, status: "active" })
      .where(eq(hiringConversations.id, conv.id));
    return { reqId: r!.id, conv: await reload(conv.id) };
  }

  test("the desk answers from live facts and the app's real rules", async () => {
    const { reqId, conv } = await approvedRoleThread();
    await db
      .update(requisitions)
      .set({
        status: "closed",
        approvalTrail: [
          {
            to: "closed",
            actor: "hr@x",
            comment: "Filled internally",
            at: new Date().toISOString(),
          },
        ] as never,
      })
      .where(eq(requisitions.id, reqId));
    deskScript.push({ reply: "It is closed." });
    await desk.handleUserMessage(conv, recruiter, "where do we stand?");
    expect(lastDeskPrompt).toMatch(/is closed\./);
    expect(lastDeskPrompt).toMatch(/Filled internally/);
    expect(lastDeskPrompt).toMatch(/cannot be reopened/);
    expect(lastDeskPrompt).not.toMatch(/archived" status\b/);
  });

  test("closing a role (anywhere) stops its agents and ends the thread once", async () => {
    const { reqId, conv } = await approvedRoleThread();
    const { startRun } = await import("../src/server/agents/runtime.server");
    const { runId } = await startRun({
      orgId,
      agentType: "intake",
      principalUserId: recruiter,
      goal: "g",
      subjectType: "requisition",
      subjectId: reqId,
    });
    await db
      .update(requisitions)
      .set({
        status: "closed",
        approvalTrail: [{ to: "closed", actor: "hr@x", comment: "Budget cut" }] as never,
      })
      .where(eq(requisitions.id, reqId));
    await desk.onRequisitionEnded(orgId, reqId, "closed", null);
    await desk.onRequisitionEnded(orgId, reqId, "closed", null);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run!.status).toBe("cancelled");
    const c = await reload(conv.id);
    expect(c.status).toBe("closed");
    const ended = (await messages(conv.id)).filter((m) => /was closed/.test(m.body));
    expect(ended).toHaveLength(1);
    expect(ended[0]!.body).toMatch(/Budget cut/);
    expect(ended[0]!.body).toMatch(/1 agent run\(s\) working on it were stopped/);
    const p = await desk.deskProgress(c);
    expect(p.next).toBeNull();
    expect(p.ended).toMatchObject({ status: "closed", reason: "Budget cut", by: "hr@x" });
    // A closed thread still answers questions but refuses actions.
    deskScript.push({ command: { type: "screen", top: 2 } });
    await desk.handleUserMessage(c, recruiter, "talk to the first 2");
    expect((await messages(conv.id)).at(-1)!.body).toMatch(/This role is closed/);
  });

  test("'close this role' offers the right action; the role check applies", async () => {
    const { reqId, conv } = await approvedRoleThread();
    deskScript.push({ command: { type: "close_role" } });
    await desk.handleUserMessage(conv, recruiter, "close this role");
    const card = (await messages(conv.id)).at(-1)!.card as { type: string; action: string };
    expect(card).toMatchObject({ type: "close_role", action: "close" });
    // A recruiter may not close an approved role (HR head / CBO only).
    await expect(
      desk.closeRole(await reload(conv.id), recruiter, "No longer needed"),
    ).rejects.toThrow();
    await db.insert(userRoles).values({ userId: recruiter, orgId, role: "hr_head" });
    try {
      expect(await desk.closeRole(await reload(conv.id), recruiter, "No longer needed")).toEqual({
        action: "close",
      });
      const [r] = await db.select().from(requisitions).where(eq(requisitions.id, reqId));
      expect(r!.status).toBe("closed");
      expect((await reload(conv.id)).status).toBe("closed");
    } finally {
      await db
        .delete(userRoles)
        .where(
          and(
            eq(userRoles.userId, recruiter),
            eq(userRoles.orgId, orgId),
            eq(userRoles.role, "hr_head"),
          ),
        );
    }
  });
});

describe("delegating to the market, and showing the desk's thinking", () => {
  const proposal = {
    mustHaveSkills: ["Figma", "Design systems", "User research"],
    goodToHaveSkills: ["Prototyping"],
    experienceMin: null,
    experienceMax: null,
    budgetLpaMin: 12,
    budgetLpaMax: 22,
    reasoning: "Current UI/UX postings ask for Figma and design-system work.",
    sources: [
      { title: "Postings", url: "https://example.com/jobs" },
      { title: "bad", url: "javascript:alert(1)" },
    ],
  };
  const uiux = {
    roleTitle: "UI/UX Engineer",
    location: "Remote",
    experienceMin: 3,
    experienceMax: 6,
    openings: 1,
  };

  test("each question carries what was understood, what is missing and what is next", async () => {
    const conv = await newConversation();
    deskScript.push({ slots: { roleTitle: "UI/UX Engineer", location: "Remote" }, reply: "" });
    await desk.handleUserMessage(conv, recruiter, "UI/UX engineer, remote");
    const card = (await messages(conv.id)).at(-1)!.card as {
      type: string;
      understood: { label: string; value: string }[];
      missing: string[];
      next: string;
    };
    expect(card.type).toBe("reasoning");
    expect(card.understood).toEqual(
      expect.arrayContaining([{ label: "Role", value: "UI/UX Engineer" }]),
    );
    expect(card.missing).toEqual(["experience", "number of openings", "must-have skills"]);
    expect(card.next).toMatch(/experience/);
  });

  test("'as per market' researches; 'ok' applies the proposal and moves on", async () => {
    const conv = await newConversation();
    await db
      .update(hiringConversations)
      .set({ slots: uiux as never })
      .where(eq(hiringConversations.id, conv.id));
    researchResult = { ok: true, data: proposal, grounded: true, usage: null };
    const before = researchCalls;
    {
      deskScript.push({ command: { type: "research", fields: ["skills", "budget"] } });
      await desk.handleUserMessage(await reload(conv.id), recruiter, "as per market needs");
      expect(researchCalls).toBe(before + 1);
      let card = (await messages(conv.id)).at(-1)!.card as Record<string, unknown>;
      expect(card).toMatchObject({ type: "proposal", grounded: true, accepted: false });
      // Only http(s) sources survive.
      expect((card["proposal"] as typeof proposal).sources).toHaveLength(1);
      // The next turn sees the open proposal.
      deskScript.push({ command: { type: "accept" } });
      await desk.handleUserMessage(await reload(conv.id), recruiter, "ok");
      expect(lastDeskPrompt).toMatch(/OPEN PROPOSAL: yes/);
      const s = (await reload(conv.id)).slots as Record<string, unknown>;
      expect(s["mustHaveSkills"]).toEqual(proposal.mustHaveSkills);
      expect(s["budgetLpaMax"]).toBe(22);
      // Moves on (the one JD question) instead of asking for skills again.
      const m = await messages(conv.id);
      expect(m.at(-1)!.body).toMatch(/key responsibilities/);
      card = m.find((x) => (x.card as { type?: string } | null)?.type === "proposal")!
        .card as Record<string, unknown>;
      expect(card["accepted"]).toBe(true);
      expect(await desk.latestProposal(await reload(conv.id))).toBeNull();
    }
  });

  test("editing the details yourself supersedes the proposal; a later 'ok' cannot overwrite", async () => {
    const conv = await newConversation();
    await db
      .update(hiringConversations)
      .set({ slots: uiux as never })
      .where(eq(hiringConversations.id, conv.id));
    await desk.postMessage(conv, {
      role: "desk",
      body: "proposal",
      card: { type: "proposal", fields: ["skills"], proposal, grounded: false, accepted: false },
    });
    expect(await desk.latestProposal(conv)).not.toBeNull();
    deskScript.push({ slots: { mustHaveSkills: ["Figma", "Accessibility"] } });
    await desk.handleUserMessage(await reload(conv.id), recruiter, "Figma and accessibility only");
    expect(await desk.latestProposal(await reload(conv.id))).toBeNull();
    expect(((await reload(conv.id)).slots as { mustHaveSkills: string[] }).mustHaveSkills).toEqual([
      "Figma",
      "Accessibility",
    ]);
  });
});

async function threadWithRequest(kind: "approval" | "clarification" | "gate") {
  const conv = await confirming();
  await db
    .update(hiringConversations)
    .set({ status: "active", requisitionId: existingReq })
    .where(eq(hiringConversations.id, conv.id));
  const [run] = await db
    .insert(agentRuns)
    .values({
      orgId,
      agentType: "requisition",
      principalUserId: recruiter,
      goal: "g",
      status: "awaiting_human",
      conversationId: conv.id,
    })
    .returning();
  const [task] = await db
    .insert(agentTasks)
    .values({
      orgId,
      runId: run!.id,
      kind,
      status: "open",
      title: "Save candidate-scoring weights",
      assigneeUserId: recruiter,
    })
    .returning();
  return { conv: await reload(conv.id), runId: run!.id, taskId: task!.id };
}

describe("the person talks to the agents through the desk", () => {
  test("a change asked in chat goes back to the agent, which revises and asks again", async () => {
    const { conv, runId, taskId } = await threadWithRequest("approval");
    deskScript.push({
      command: { type: "feedback", text: "more weight for experience and skills" },
      reply: "Noted, I will ensure extra weight.",
    });
    await desk.handleUserMessage(
      conv,
      recruiter,
      "I think we can give more weightage for experience and skills",
    );
    expect(lastDeskPrompt).toMatch(/OPEN REQUESTS[^\n]*Save candidate-scoring weights/);
    const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
    expect(t).toMatchObject({ status: "rejected", decidedBy: recruiter });
    expect(t!.response).toMatchObject({
      changes: true,
      reason: "more weight for experience and skills",
    });
    expect(await desk.taskStatuses(orgId, [taskId])).toEqual({ [taskId]: "changes_requested" });
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(r!.status).toBe("queued");
    const last = (await messages(conv.id)).at(-1)!;
    // The model's promise is not what is posted; what was done is.
    expect(last.body).toMatch(/^Sent back to the .* agent/);
    expect((last.card as { type: string }).type).toBe("reasoning");
  });

  test("the re-proposed request says it is a revision and what changed", async () => {
    const { conv, runId, taskId } = await threadWithRequest("approval");
    const v1 = { career: 10, skills: 35, experience: 15, requisitionId: existingReq };
    await db
      .update(agentTasks)
      .set({ proposedAction: { name: "save_weights", args: v1 } as never })
      .where(eq(agentTasks.id, taskId));
    deskScript.push({ command: { type: "feedback", text: "more weight for experience" } });
    await desk.handleUserMessage(conv, recruiter, "more weight for experience");
    const v2 = { career: 10, skills: 30, experience: 25, requisitionId: existingReq };
    await desk.onTaskOpened(
      { conversationId: conv.id, orgId, agentType: "requisition" },
      {
        id: crypto.randomUUID(),
        kind: "approval",
        title: "Save candidate-scoring weights",
        body: "",
        proposedAction: { name: "save_weights", args: v2 },
      },
    );
    const last = (await messages(conv.id)).at(-1)!;
    expect(last.body).toMatch(/^Revised as you asked \("more weight for experience"\)/);
    expect(last.body).toContain("Experience 15% → 25%");
    expect(last.body).not.toMatch(/Requisition id|Career/);
    expect((last.card as { revision: unknown }).revision).toEqual({
      reason: "more weight for experience",
      changes: [
        { label: "Skills", from: "35%", to: "30%" },
        { label: "Experience", from: "15%", to: "25%" },
      ],
    });
    expect(runId).toBeTruthy();
  });

  test("an agent's question can be answered in chat", async () => {
    const { conv, taskId } = await threadWithRequest("clarification");
    deskScript.push({ command: { type: "feedback", text: "Yes, remote is fine" } });
    await desk.handleUserMessage(conv, recruiter, "yes remote is fine");
    const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
    expect(t).toMatchObject({ status: "answered", response: { answer: "Yes, remote is fine" } });
  });

  test("approval steps are never decided from chat; a plain reply says nothing was sent", async () => {
    const { conv, taskId } = await threadWithRequest("gate");
    deskScript.push({ command: { type: "feedback", text: "looks fine" } });
    await desk.handleUserMessage(conv, recruiter, "looks fine");
    const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
    expect(t!.status).toBe("open");
    expect((await messages(conv.id)).at(-1)!.body).toMatch(/decided on its card/);
    deskScript.push({ reply: "Sure." });
    await desk.handleUserMessage(await reload(conv.id), recruiter, "thanks");
    const card = (await messages(conv.id)).at(-1)!.card as { next: string };
    expect(card.next).toMatch(/Nothing was sent to the agents/);
  });
});

describe("JD changes, templates, budget pauses and readable agent text", () => {
  async function jdGateThread() {
    const conv = await confirming();
    await db
      .update(hiringConversations)
      .set({ status: "active", requisitionId: existingReq })
      .where(eq(hiringConversations.id, conv.id));
    const [jd] = await db
      .insert(jobDescriptions)
      .values({
        orgId,
        requisitionId: existingReq,
        version: 9,
        status: "pending_dh",
        purpose: "p",
        fullText: "draft",
      } as never)
      .returning({ id: jobDescriptions.id });
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "jd",
        principalUserId: recruiter,
        goal: "g",
        status: "awaiting_human",
        conversationId: conv.id,
      })
      .returning();
    const [task] = await db
      .insert(agentTasks)
      .values({
        orgId,
        runId: run!.id,
        kind: "gate",
        status: "open",
        title: "Approval Request: Job Description",
        assigneeRole: "department_head",
        proposedAction: {
          name: "request_approval",
          args: { subject: { type: "jd", id: jd!.id } },
        } as never,
      })
      .returning();
    return { conv: await reload(conv.id), jdId: jd!.id, taskId: task!.id };
  }
  const asReviewer = async <T>(fn: () => Promise<T>) => {
    await db.insert(userRoles).values({ userId: recruiter, orgId, role: "department_head" });
    try {
      return await fn();
    } finally {
      await db
        .delete(userRoles)
        .where(
          and(
            eq(userRoles.userId, recruiter),
            eq(userRoles.orgId, orgId),
            eq(userRoles.role, "department_head"),
          ),
        );
    }
  };

  test("a template that does not exist is said plainly; nothing is sent", async () => {
    const { contentTemplates } = await import("../drizzle/schema");
    await db
      .insert(contentTemplates)
      .values({ orgId, kind: "jd", name: "Standard Product Job Description", config: {} } as never);
    try {
      const { conv, taskId } = await jdGateThread();
      deskScript.push({
        command: { type: "feedback", text: "use the Yavar template", template: "Yavar" },
      });
      await desk.handleUserMessage(conv, recruiter, "Can u use Yavar template?");
      const last = (await messages(conv.id)).at(-1)!;
      expect(last.body).toMatch(/none mentions "Yavar"/);
      expect(last.body).toContain('"Standard Product Job Description"');
      const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
      expect(t!.status).toBe("open");
    } finally {
      await db.delete(contentTemplates).where(eq(contentTemplates.orgId, orgId));
    }
  });

  test("changing a JD under review from chat requests changes (not a rejection), with the template", async () => {
    const { contentTemplates } = await import("../drizzle/schema");
    await db
      .insert(contentTemplates)
      .values({ orgId, kind: "jd", name: "Yavar House Style", config: {} } as never);
    try {
      const { conv, jdId, taskId } = await jdGateThread();
      deskScript.push({
        command: { type: "feedback", text: "use the Yavar template", template: "yavar" },
      });
      await asReviewer(() => desk.handleUserMessage(conv, recruiter, "Can u use Yavar template?"));
      const [jd] = await db.select().from(jobDescriptions).where(eq(jobDescriptions.id, jdId));
      expect(jd!.status).toBe("changes_requested");
      expect(jd!.approverComment).toContain('Use the JD template "Yavar House Style"');
      const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
      expect(t!.response).toMatchObject({ changes: true });
      expect((await messages(conv.id)).at(-1)!.body).toMatch(/^Sent the job description back/);
      const { pickTemplate } = await import("../src/lib/templates.server");
      expect(await pickTemplate(orgId, "jd", "UI/UX", "Yavar")).toMatchObject({
        name: "Yavar House Style",
        reason: "the template the reviewer asked for",
      });
      await expect(pickTemplate(orgId, "jd", "UI/UX", "Acme")).rejects.toThrow(/Yavar House Style/);
    } finally {
      await db.delete(contentTemplates).where(eq(contentTemplates.orgId, orgId));
      await db.delete(jobDescriptions).where(eq(jobDescriptions.version, 9));
    }
  });

  test("a template is found by what it contains, and one already in use is not re-requested", async () => {
    const { contentTemplates } = await import("../drizzle/schema");
    const [tpl] = await db
      .insert(contentTemplates)
      .values({
        orgId,
        kind: "jd",
        name: "Standard Product Job Description",
        config: {
          sections: [
            { key: "s2", heading: "About Yavar" },
            { key: "s6", heading: "Why Join Yavar?" },
          ],
        },
      } as never)
      .returning({ id: contentTemplates.id });
    try {
      const { findTemplateByName } = await import("../src/lib/templates.server");
      expect((await findTemplateByName(orgId, "jd", "Yavar")).match).toMatchObject({
        name: "Standard Product Job Description",
        by: "content",
        evidence: 'its sections "About Yavar", "Why Join Yavar?"',
      });
      const { conv, jdId, taskId } = await jdGateThread();
      await db
        .update(jobDescriptions)
        .set({ templateId: tpl!.id } as never)
        .where(eq(jobDescriptions.id, jdId));
      deskScript.push({
        command: { type: "feedback", text: "use Yavar template", template: "Yavar" },
      });
      await desk.handleUserMessage(conv, recruiter, "Can u use Yavar template?");
      const last = (await messages(conv.id)).at(-1)!;
      expect(last.body).toMatch(
        /already drafted with "Standard Product Job Description" — your Yavar template/,
      );
      const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
      expect(t!.status).toBe("open");
      // Another agent's open request never receives a template change.
      const other = await threadWithRequest("approval");
      deskScript.push({
        command: { type: "feedback", text: "use Yavar template", template: "Yavar" },
      });
      await desk.handleUserMessage(other.conv, recruiter, "use the Yavar template");
      const [o] = await db.select().from(agentTasks).where(eq(agentTasks.id, other.taskId));
      expect(o!.status).toBe("open");
      expect((await messages(other.conv.id)).at(-1)!.body).toMatch(/^The job description/);
    } finally {
      await db.delete(contentTemplates).where(eq(contentTemplates.orgId, orgId));
      await db.delete(jobDescriptions).where(eq(jobDescriptions.version, 9));
    }
  });

  test("a budget-paused run shows its usage and is released when the budget changes", async () => {
    const { releaseBudgetPaused, BUDGET_PAUSE_MESSAGE } =
      await import("../src/server/agents/runtime.server");
    await db
      .update(agentPolicies)
      .set({ monthlyTokenBudget: 1000 })
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, "intake")));
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "intake",
        principalUserId: recruiter,
        goal: "g",
        status: "queued",
        lastError: BUDGET_PAUSE_MESSAGE,
        leaseUntil: new Date(Date.now() + 3600_000),
      })
      .returning();
    const b = await desk.budgetOf(orgId, "intake");
    expect(b).toMatchObject({ limit: 1000, suggested: 50_000 });
    expect(await releaseBudgetPaused(orgId, "intake")).toBe(1);
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(r!.leaseUntil).toBeNull();
    // Under the raised budget it runs, and is no longer marked paused.
    await db
      .update(agentPolicies)
      .set({ monthlyTokenBudget: 1_000_000 })
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, "intake")));
    agentScript.push(say("Nothing to do."));
    await runAgentTick({ orgId });
    const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(after!.lastError).toBeNull();
  });

  test("'show the JD' posts the saved job description into the thread", async () => {
    const conv = await confirming();
    await db
      .update(hiringConversations)
      .set({ status: "active", requisitionId: existingReq })
      .where(eq(hiringConversations.id, conv.id));
    deskScript.push({
      command: { type: "show_jd" },
      reply: "You can view it on the requisition page.",
    });
    await desk.handleUserMessage(await reload(conv.id), recruiter, "show the JD");
    const last = (await messages(conv.id)).at(-1)!;
    expect(last.body).toMatch(/^Here is the job description for .* version 1, approved/);
    expect(last.card).toMatchObject({ type: "jd", version: 1, text: "Full stack JD text" });
  });

  test("agent text in the thread hides internal ids", () => {
    const text = [
      "The job description for REQ-2026-106 has been approved.",
      "",
      "- **Requisition ID:** `52d7079d-e471-4968-bee4-8773ced5fd68`",
      "- **JD ID:** `3ce4fb38-04c2-40d0-a3df-cddf7f3d787b` (Version 1)",
      "- Status: approved (run 3ce4fb38-04c2-40d0-a3df-cddf7f3d787b)",
    ].join("\n");
    const out = desk.readableAgentText(text);
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(out).toContain("REQ-2026-106");
    expect(out).toContain("- Status: approved (run)");
  });
});
