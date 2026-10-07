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
const agentScript: AgentStepResult[] = [];
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
  aiJson: async (opts: { schema?: { parse: (v: unknown) => unknown } }) => {
    const t = deskScript.shift() ?? { reply: "" };
    const data = opts.schema ? opts.schema.parse(t) : t;
    return { ok: true, data, usage: null };
  },
  aiAgentStep: async () => agentScript.shift() ?? say("(done)"),
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
