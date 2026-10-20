/**
 * Changing a requisition in approval, scoring weights and work mode, against
 * the disposable database:
 *  - send back for changes: only from approval; by the current approver, the
 *    person who raised it, or the HR head / CBO; reason required; draft again,
 *    on the trail, audited, raises requisition.status_changed (sentBack);
 *    from the approval card (resolveTask, changes) and from the desk chat
 *    ("i need 25% for social"); the waiting agent is told the exact change;
 *    a plain decline stays final;
 *  - weights: total 100; locked in approval and once closed; draft by its
 *    raiser or HR leadership; approved by HR leadership only; audited;
 *  - work mode: asked by the desk after location, kept on the requisition,
 *    shown with the location ("Chennai (Hybrid)").
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/requisition-changes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  agentRuns,
  agentTasks,
  auditLog,
  hiringConversations,
  hiringMessages,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const lifecycle = await import("../src/lib/requisitions.server");
const desk = await import("../src/server/desk/desk.server");
const runtime = await import("../src/server/agents/runtime.server");
const { placeLabel } = await import("../src/lib/work-mode");

const stamp = Date.now();
let orgId: string;
let owner: string;
let hr: string;
let dh: string;
let raiser: string;
let other: string;
const who = (userId: string) => ({ orgId, userId, memberEmail: `${userId}@x.local` });

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const mk = async (tag: string) =>
    (
      await db
        .insert(users)
        .values({ email: `rc-${tag}-${stamp}@test.local` })
        .returning({ id: users.id })
    )[0]!.id;
  [owner, hr, dh, raiser, other] = [
    await mk("owner"),
    await mk("hr"),
    await mk("dh"),
    await mk("raiser"),
    await mk("other"),
  ];
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Req Changes Org", slug: `rc-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  for (const [u, isOwner, role] of [
    [owner, true, null],
    [hr, false, "hr_head"],
    [dh, false, "department_head"],
    [raiser, false, "recruiter"],
    [other, false, "recruiter"],
  ] as const) {
    await db.insert(orgMembers).values({
      orgId,
      userId: u,
      email: `${u}@x.local`,
      status: "active",
      isOwner,
    } as never);
    if (role) await db.insert(userRoles).values({ userId: u, orgId, role });
  }
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const u of [owner, hr, dh, raiser, other]) await db.delete(users).where(eq(users.id, u));
});

async function requisition(status: string) {
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-RC-${Math.random().toString(36).slice(2, 7)}`,
      title: "UI/UX Developer",
      status,
      createdBy: raiser,
      weightSkills: 25,
      weightExperience: 20,
      weightCareer: 15,
      weightImpact: 25,
      weightEducation: 5,
      weightSocial: 10,
    } as never)
    .returning();
  return r!;
}
const reload = async (id: string) =>
  (await db.select().from(requisitions).where(eq(requisitions.id, id)))[0]!;
/** A Requisition agent run waiting on the department head's approval. */
async function waitingGate(reqId: string, convId: string | null = null) {
  const [run] = await db
    .insert(agentRuns)
    .values({
      orgId,
      agentType: "requisition",
      principalUserId: raiser,
      goal: "complete and submit",
      status: "awaiting_human",
      subjectType: "requisition",
      subjectId: reqId,
      conversationId: convId,
    } as never)
    .returning({ id: agentRuns.id });
  const [task] = await db
    .insert(agentTasks)
    .values({
      orgId,
      runId: run!.id,
      kind: "gate",
      title: "Requisition Approval",
      assigneeRole: "department_head",
      proposedAction: {
        toolCallId: "t1",
        name: "request_approval",
        args: { subject: { type: "requisition", id: reqId, expects: "pending_dh" } },
      },
    } as never)
    .returning({ id: agentTasks.id });
  return { runId: run!.id, taskId: task!.id };
}
const W = { skills: 20, experience: 15, career: 15, impact: 20, education: 5, social: 25 };

/* ------------------------------------------------------------ send back */

describe("send back for changes", () => {
  test("only from approval, with a reason, by the right people", async () => {
    const draft = await requisition("draft");
    await expect(
      lifecycle.sendBackRequisitionCore(who(raiser), { id: draft.id, reason: "social 25%" }),
    ).rejects.toThrow(/draft — change it directly/);
    const approved = await requisition("approved");
    await expect(
      lifecycle.sendBackRequisitionCore(who(hr), { id: approved.id, reason: "x y z" }),
    ).rejects.toThrow(/only one in approval/);
    const pending = await requisition("pending_dh");
    await expect(
      lifecycle.sendBackRequisitionCore(who(raiser), { id: pending.id, reason: "" }),
    ).rejects.toThrow(/Say what should change/);
    await expect(
      lifecycle.sendBackRequisitionCore(who(other), { id: pending.id, reason: "social 25%" }),
    ).rejects.toThrow(/Only the current approver, the person who raised it/);
    // The current approver may; so may the person who raised it.
    const out = await lifecycle.sendBackRequisitionCore(who(dh), {
      id: pending.id,
      reason: "Social profiling 25%",
    });
    expect(out.from).toBe("pending_dh");
    const r = await reload(pending.id);
    expect(r.status).toBe("draft");
    expect((r.approvalTrail as { decision: string; comment: string }[]).at(-1)).toMatchObject({
      decision: "sent_back",
      comment: "Social profiling 25%",
      from: "pending_dh",
      to: "draft",
    });
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "requisition.sent_back"), eq(auditLog.entityId, pending.id)));
    expect(a!.detail).toMatchObject({ from: "pending_dh", reason: "Social profiling 25%" });
    const [e] = await db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.subjectId, pending.id)));
    expect(e!.payload).toMatchObject({ to: "draft", sentBack: true });
    const mine = await requisition("pending_hr");
    await lifecycle.sendBackRequisitionCore(who(raiser), {
      id: mine.id,
      reason: "Hybrid, not onsite",
    });
    expect((await reload(mine.id)).status).toBe("draft");
  });

  test("from the approval card: draft again, and the agent is told exactly what to change", async () => {
    const r = await requisition("pending_dh");
    const { taskId } = await waitingGate(r.id);
    await runtime.resolveTask({
      orgId,
      taskId,
      userId: dh,
      decision: { status: "rejected", reason: "Social profiling 25%", changes: true },
    });
    expect((await reload(r.id)).status).toBe("draft");
    const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
    expect(t!.status).toBe("rejected");
    expect(t!.response).toMatchObject({ reason: "Social profiling 25%", changes: true });
    // A plain decline is still final.
    const r2 = await requisition("pending_dh");
    const g2 = await waitingGate(r2.id);
    await runtime.resolveTask({
      orgId,
      taskId: g2.taskId,
      userId: dh,
      decision: { status: "rejected", reason: "Not this quarter" },
    });
    expect((await reload(r2.id)).status).toBe("rejected");
  });

  test("from the chat: 'i need 25% for social' sends it back with those words", async () => {
    const r = await requisition("pending_dh");
    const [conv] = await db
      .insert(hiringConversations)
      .values({
        orgId,
        createdBy: raiser,
        title: "UI/UX Developer · Chennai",
        status: "active",
        requisitionId: r.id,
      })
      .returning();
    const { taskId } = await waitingGate(r.id, conv!.id);
    await desk.sendFeedback(conv!, raiser, "i need 25% for social");
    expect((await reload(r.id)).status).toBe("draft");
    const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
    expect(t!.response).toMatchObject({ reason: "i need 25% for social", changes: true });
    const last = (
      await db
        .select()
        .from(hiringMessages)
        .where(eq(hiringMessages.conversationId, conv!.id))
        .orderBy(hiringMessages.createdAt)
    ).at(-1)!;
    expect(last.body).toMatch(
      /^Sent REQ-RC-\w+ back to draft with your change: "i need 25% for social"/,
    );
    expect(last.body).not.toMatch(/Decline is final/);
  });

  test("someone without the right role is told so in the chat, and nothing changes", async () => {
    const r = await requisition("pending_dh");
    const [conv] = await db
      .insert(hiringConversations)
      .values({ orgId, createdBy: other, title: "x", status: "active", requisitionId: r.id })
      .returning();
    await waitingGate(r.id, conv!.id);
    await desk.sendFeedback(conv!, other, "social 25%");
    expect((await reload(r.id)).status).toBe("pending_dh");
    const last = (
      await db
        .select()
        .from(hiringMessages)
        .where(eq(hiringMessages.conversationId, conv!.id))
        .orderBy(hiringMessages.createdAt)
    ).at(-1)!;
    expect(last.body).toMatch(/I couldn't send it back: Only the current approver/);
  });
});

/* ------------------------------------------------------------ weights */

describe("scoring weights", () => {
  test("must total 100", () => {
    expect(lifecycle.weightsProblem(W)).toBeNull();
    expect(lifecycle.weightsProblem({ ...W, social: 30 })).toMatch(/add up to 105%/);
    expect(lifecycle.weightsProblem({ ...W, social: 25.5 })).toMatch(/whole percentage/);
  });

  test("locked in approval and when closed; draft by its raiser or HR leadership; audited", async () => {
    const pending = await requisition("pending_hr");
    await expect(lifecycle.saveRequisitionWeightsCore(who(owner), pending.id, W)).rejects.toThrow(
      /in approval[\s\S]*Send it back for changes/,
    );
    const closed = await requisition("closed");
    await expect(lifecycle.saveRequisitionWeightsCore(who(owner), closed.id, W)).rejects.toThrow(
      /closed/,
    );
    const draft = await requisition("draft");
    await expect(lifecycle.saveRequisitionWeightsCore(who(other), draft.id, W)).rejects.toThrow(
      /Only the person who raised this requisition/,
    );
    expect(await lifecycle.saveRequisitionWeightsCore(who(raiser), draft.id, W)).toEqual({
      status: "draft",
      changed: true,
    });
    expect((await reload(draft.id)).weightSocial).toBe(25);
    const [a] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "requisition.weights_changed"), eq(auditLog.entityId, draft.id)),
      );
    expect(a!.detail).toMatchObject({ before: { social: 10 }, after: { social: 25 } });
    // Same weights again: nothing to record.
    expect(await lifecycle.saveRequisitionWeightsCore(who(raiser), draft.id, W)).toEqual({
      status: "draft",
      changed: false,
    });
  });

  test("an approved role: HR head / CBO only", async () => {
    const approved = await requisition("approved");
    await expect(lifecycle.saveRequisitionWeightsCore(who(raiser), approved.id, W)).rejects.toThrow(
      /Only the HR head or the CBO/,
    );
    expect(await lifecycle.saveRequisitionWeightsCore(who(hr), approved.id, W)).toEqual({
      status: "approved",
      changed: true,
    });
  });
});

/* ------------------------------------------------------------ work mode */

describe("work mode", () => {
  test("shown with the location", () => {
    expect(placeLabel("Chennai", "hybrid")).toBe("Chennai (Hybrid)");
    expect(placeLabel("Chennai", null)).toBe("Chennai");
    expect(placeLabel("", "remote")).toBe("Remote");
    expect(placeLabel("Remote — India", "remote")).toBe("Remote — India");
  });

  test("the desk asks for it right after the location, and the requisition keeps it", async () => {
    expect(desk.missingSlots({ roleTitle: "UI/UX Developer", location: "Chennai" })[0]).toBe(
      "workMode",
    );
    expect(
      desk.describeNeed({
        roleTitle: "UI/UX Developer",
        location: "Chennai",
        workMode: "hybrid",
        openings: 1,
      }),
    ).toBe("1 × UI/UX Developer in Chennai (Hybrid)");
    const created = await lifecycle.createRequisitionCore(
      who(raiser),
      {
        title: "UI/UX Developer",
        departmentId: null,
        location: "Chennai",
        workMode: "hybrid",
        openings: 1,
        experienceMin: 3,
        experienceMax: 5,
        budgetCtc: 0,
        ctcBandMin: null,
        ctcBandMax: null,
        maxNoticePeriodDays: null,
        workAuthorizationRequired: null,
        hiringManager: null,
        mustHaveSkills: ["Figma"],
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
    expect((await reload(created.id)).workMode).toBe("hybrid");
    await lifecycle.updateRequisitionDraftCore(who(raiser), created.id, { workMode: "remote" });
    expect((await reload(created.id)).workMode).toBe("remote");
  });
});
