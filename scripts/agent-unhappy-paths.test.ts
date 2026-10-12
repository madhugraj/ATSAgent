/**
 * The paths where something is declined, rejected, missed or stopped, against
 * the disposable database:
 *  - an offer declined at the HR head / CBO step goes back to draft with the
 *    reason (never stuck), the Offer agent is started, and can revise it;
 *  - a document HR rejects restarts pre-onboarding and may be asked for again
 *    at once, with the reason; the same file twice is not filed again;
 *  - a closed / on-hold role starts no agents, withdraws open time links and
 *    lists what a person must settle;
 *  - a rejected candidate gets a kind, final email (never the internal reason);
 *  - times a candidate declines are offered again, at most three times;
 *  - assessments not completed in 14 days close and the thread is told;
 *  - under the "immediate" verdict policy nobody is asked for a decision;
 *  - pricing: list price by day, the organisation's own rate first, unknown
 *    models unpriced; ids are kept out of text people read.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/agent-unhappy-paths.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  agentPolicies,
  agentRuns,
  agentTasks,
  applications,
  candidateAssessments,
  candidates,
  emailOutbox,
  hiringConversations,
  hiringMessages,
  interviewSlotOffers,
  offers,
  onboardingDocuments,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
await import("../src/server/agents");
const { getTool } = await import("../src/server/agents/registry");
const { processAgentEvents, scheduleSweeps } =
  await import("../src/server/agents/orchestrator.server");
const offersLib = await import("../src/lib/offers.functions");

const stamp = Date.now();
let orgId: string;
let userId: string;
let role: string;
let appId: string;
let candId: string;
const email = `hr-${stamp}@test.local`;
const actor = () => ({ orgId, userId, memberEmail: email });

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Unhappy Org", slug: `unhappy-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  await db
    .insert(orgMembers)
    .values({ orgId, userId, email, fullName: "Hema", status: "active", isOwner: false } as never);
  for (const r of ["hr_head", "president_cbo", "recruiter", "hiring_manager"])
    await db.insert(userRoles).values({ userId, orgId, role: r as never });
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-U-${stamp}`,
      title: "Head of Platforms",
      status: "approved",
      ctcBandMin: "8500000",
      ctcBandMax: "14000000",
      budgetCtc: "11000000",
      createdBy: userId,
    } as never)
    .returning({ id: requisitions.id });
  role = r!.id;
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Asha Rao", email: `asha-${stamp}@cand.local` })
    .returning({ id: candidates.id });
  candId = c!.id;
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: role, candidateId: candId, stage: "l1" })
    .returning({ id: applications.id });
  appId = a!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentEvents).where(eq(agentEvents.orgId, orgId));
  await db.delete(offers).where(eq(offers.orgId, orgId));
  await db.delete(onboardingDocuments).where(eq(onboardingDocuments.orgId, orgId));
  await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgId));
  await db.delete(interviewSlotOffers).where(eq(interviewSlotOffers.orgId, orgId));
  await db.delete(hiringConversations).where(eq(hiringConversations.orgId, orgId));
  await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
  await db.update(requisitions).set({ status: "approved" }).where(eq(requisitions.id, role));
  await db.update(applications).set({ stage: "l1" }).where(eq(applications.id, appId));
});

async function enable(agentType: string) {
  await db
    .insert(agentPolicies)
    .values({ orgId, agentType: agentType as never, enabled: true, autonomy: "act_and_notify" })
    .onConflictDoUpdate({
      target: [agentPolicies.orgId, agentPolicies.agentType],
      set: { enabled: true },
    });
}
async function thread() {
  const [c] = await db
    .insert(hiringConversations)
    .values({ orgId, createdBy: userId, requisitionId: role, status: "active" })
    .returning();
  return c!;
}
const messages = async (convId: string) =>
  (
    await db
      .select()
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, convId))
      .orderBy(hiringMessages.createdAt)
  ).map((m) => m.body);
async function offerAt(status: string) {
  const [o] = await db
    .insert(offers)
    .values({
      orgId,
      applicationId: appId,
      offeredCtc: "11000000",
      status,
      letter: { subject: "Offer", opening: "Dear Asha", sections: [{ heading: "Pay", body: "x" }] },
    } as never)
    .returning({ id: offers.id });
  return o!.id;
}
const runsOf = async (agentType: string) =>
  (await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId))).filter(
    (r) => r.agentType === agentType,
  );

/* --------------------------------------------------------------- offers */

describe("an offer declined at an approval step", () => {
  test("HR head sends it back: draft, reason on the trail, thread told, Offer agent started", async () => {
    await enable("offer");
    const conv = await thread();
    const id = await offerAt("pending_hr");
    await offersLib.sendBackOfferCore(actor(), { id, reason: "Joining date is too far out" });
    const [o] = await db.select().from(offers).where(eq(offers.id, id));
    expect(o!.status).toBe("draft");
    expect((o!.approvalTrail as { decision: string; comment: string }[]).at(-1)).toMatchObject({
      decision: "sent_back",
      comment: "Joining date is too far out",
    });
    expect((await messages(conv.id)).at(-1)).toMatch(/sent Asha Rao's offer back to draft/);
    await processAgentEvents({ orgId });
    const runs = await runsOf("offer");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.goal).toMatch(/sent the offer .* back to draft: "Joining date is too far out"/);
    // The Offer agent sees why, and may revise the draft inside the band.
    const ctx = {
      orgId,
      principalUserId: userId,
      runId: runs[0]!.id,
      agentType: "offer",
      actor: "t",
    };
    const context = (await getTool("get_offer_context")!.run(
      ctx as never,
      {
        applicationId: appId,
      } as never,
    )) as { existingOffers: { sentBack: unknown }[] };
    expect(context.existingOffers[0]!.sentBack).toEqual({
      atStep: "pending_hr",
      reason: "Joining date is too far out",
    });
    const r = (await getTool("revise_offer")!.run(
      ctx as never,
      {
        offerId: id,
        offeredCtc: 11_000_000,
        joiningDate: "2026-11-16",
        rationale: "Earlier joining date as the HR head asked.",
      } as never,
    )) as { revision: number };
    expect(r.revision).toBe(2);
  });

  test("declining the gate in the inbox: back to draft with the reason; the task is rejected", async () => {
    const id = await offerAt("pending_hr");
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "offer",
        principalUserId: userId,
        goal: "offer",
        status: "awaiting_human",
      } as never)
      .returning({ id: agentRuns.id });
    const [task] = await db
      .insert(agentTasks)
      .values({
        orgId,
        runId: run!.id,
        kind: "gate",
        status: "open",
        title: "Offer approval",
        assigneeRole: "hr_head",
        proposedAction: {
          toolCallId: "c1",
          name: "request_approval",
          args: { subject: { type: "offer", id, expects: "pending_hr" } },
        },
      } as never)
      .returning({ id: agentTasks.id });
    const { resolveTask, syncGateTasks } = await import("../src/server/agents/runtime.server");
    await resolveTask({
      orgId,
      userId,
      taskId: task!.id,
      decision: { status: "rejected", reason: "Hold the CTC at 1 Cr and confirm joining" } as never,
    });
    const [o] = await db.select().from(offers).where(eq(offers.id, id));
    expect(o!.status).toBe("draft");
    expect((o!.approvalTrail as { comment: string }[]).at(-1)!.comment).toBe(
      "Hold the CTC at 1 Cr and confirm joining",
    );
    const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, task!.id));
    expect(t!.status).toBe("rejected");
    expect(t!.response).toMatchObject({ reason: "Hold the CTC at 1 Cr and confirm joining" });
    // Had the offer's own event closed it first, it is a decline, never an approval.
    const id2 = await offerAt("pending_hr");
    const [task2] = await db
      .insert(agentTasks)
      .values({
        orgId,
        runId: run!.id,
        kind: "gate",
        status: "open",
        title: "Offer approval",
        proposedAction: {
          toolCallId: "c2",
          name: "request_approval",
          args: { subject: { type: "offer", id: id2, expects: "pending_hr" } },
        },
      } as never)
      .returning({ id: agentTasks.id });
    await db.update(offers).set({ status: "draft" }).where(eq(offers.id, id2));
    await syncGateTasks(orgId, { type: "offer", id: id2 }, userId, "pending_hr");
    const [t2] = await db.select().from(agentTasks).where(eq(agentTasks.id, task2!.id));
    expect(t2!.status).toBe("rejected");
  });

  test("the CBO step is sent back by the CBO; a decided offer cannot be sent back", async () => {
    const id = await offerAt("pending_cbo");
    await offersLib.sendBackOfferCore(actor(), { id, reason: "Above our parity for this level" });
    expect((await db.select().from(offers).where(eq(offers.id, id)))[0]!.status).toBe("draft");
    const done = await offerAt("approved");
    await expect(
      offersLib.sendBackOfferCore(actor(), { id: done, reason: "Changed my mind" }),
    ).rejects.toThrow(/not waiting for an approval/);
    await expect(
      offersLib.sendBackOfferCore(actor(), { id: await offerAt("pending_hr"), reason: "" }),
    ).rejects.toThrow(/Say why/);
  });

  test("a closed role starts no agent for a late offer change", async () => {
    await enable("offer");
    const id = await offerAt("pending_hr");
    await db.update(requisitions).set({ status: "closed" }).where(eq(requisitions.id, role));
    await offersLib.sendBackOfferCore(actor(), { id, reason: "Role closing anyway" });
    await processAgentEvents({ orgId });
    expect(await runsOf("offer")).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- documents */

describe("a document HR rejects", () => {
  test("restarts pre-onboarding; the type may be asked for again at once, with the reason", async () => {
    await enable("onboarding");
    await offerAt("approved");
    const tool = getTool("request_documents")!;
    const ctx = { orgId, principalUserId: userId, runId: "x", agentType: "onboarding", actor: "t" };
    await tool.run(
      ctx as never,
      {
        applicationId: appId,
        documentTypes: ["id_proof"],
        dueInDays: 5,
      } as never,
    );
    const [doc] = await db
      .insert(onboardingDocuments)
      .values({
        orgId,
        applicationId: appId,
        candidateId: candId,
        docType: "id_proof",
        fileName: "id.jpg",
      } as never)
      .returning({ id: onboardingDocuments.id });
    const { reviewOnboardingDocCore } = await import("../src/lib/onboarding.functions");
    await reviewOnboardingDocCore(actor(), {
      id: doc!.id,
      decision: "rejected",
      note: "The photo is blurred; send a clear scan",
    });
    await processAgentEvents({ orgId });
    const runs = await runsOf("onboarding");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.goal).toMatch(/rejected the id proof .* "The photo is blurred/);
    // Asked 5 days ahead, but the only copy was rejected: a new request is allowed now.
    const ask = {
      applicationId: appId,
      documentTypes: ["id_proof"],
      dueInDays: 5,
      note: "The photo you sent was blurred — please send a clear scan.",
    };
    expect(await tool.precheck!(ctx as never, ask as never)).toBeNull();
    await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgId));
    await tool.run(ctx as never, ask as never);
    const [mail] = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.kind, "document_request")));
    expect(mail!.templateData).toMatchObject({ note: ask.note });
  });
});

/* --------------------------------------------------------------- roles */

describe("a role closed or put on hold", () => {
  test("close: agents stop, open time links are withdrawn, the thread lists what is left", async () => {
    const conv = await thread();
    await db.insert(interviewSlotOffers).values({
      orgId,
      applicationId: appId,
      level: 1,
      interviewerEmail: email,
      slots: [new Date(Date.now() + 3 * 864e5).toISOString()],
      durationMins: 60,
      token: `t${stamp}`,
      expiresAt: new Date(Date.now() + 2 * 864e5),
    } as never);
    await offerAt("released");
    const { onRequisitionEnded } = await import("../src/server/desk/desk.server");
    await onRequisitionEnded(orgId, role, "closed", userId, "Budget cut");
    const [s] = await db
      .select()
      .from(interviewSlotOffers)
      .where(eq(interviewSlotOffers.orgId, orgId));
    expect(s!.status).toBe("cancelled");
    const last = (await messages(conv.id)).at(-1)!;
    expect(last).toMatch(/was closed .*Budget cut/);
    expect(last).toMatch(/1 open interview-time link\(s\) were withdrawn/);
    expect(last).toMatch(/1 offer\(s\) still open, 1 candidate\(s\) still in the pipeline/);
    const [c] = await db
      .select()
      .from(hiringConversations)
      .where(eq(hiringConversations.id, conv.id));
    expect(c!.status).toBe("closed");
  });

  test("on hold: the thread is paused, not ended; no agent starts while on hold", async () => {
    await enable("evaluation");
    const conv = await thread();
    const { onRequisitionEnded } = await import("../src/server/desk/desk.server");
    await db.update(requisitions).set({ status: "on_hold" }).where(eq(requisitions.id, role));
    await onRequisitionEnded(orgId, role, "on_hold", userId, "Re-planning");
    expect((await messages(conv.id)).at(-1)).toMatch(/put on hold .* No agent works on it/);
    const [c] = await db
      .select()
      .from(hiringConversations)
      .where(eq(hiringConversations.id, conv.id));
    expect(c!.status).toBe("active");
    const { emitAgentEvent } = await import("../src/server/agents/events");
    await emitAgentEvent({
      orgId,
      type: "scorecard.submitted",
      subjectType: "requisition",
      subjectId: role,
      actorUserId: userId,
      payload: { applicationId: appId, level: 1, verdict: "select" },
    });
    await processAgentEvents({ orgId });
    expect(await runsOf("evaluation")).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- candidates */

describe("what the candidate hears", () => {
  test("a rejection is a kind, final email without the internal reason", async () => {
    const { moveStageCore } = await import("../src/lib/pipeline.server");
    await moveStageCore(actor() as never, {
      applicationId: appId,
      toStage: "rejected",
      reason: "Weak system design — internal only",
    });
    const [mail] = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.kind, "stage_update")));
    expect(mail!.templateData).toMatchObject({
      stageHeading: "An update on your application",
      final: "yes",
    });
    expect(JSON.stringify(mail!.templateData)).not.toMatch(/Weak system design/);
  });

  test("times the candidate declines are offered again, at most three times", async () => {
    await enable("interview");
    const slots = await import("../src/lib/slot-offers.server");
    const mk = async (n: number, status: string) =>
      db.insert(interviewSlotOffers).values({
        orgId,
        applicationId: appId,
        level: 1,
        interviewerEmail: email,
        slots: [new Date(Date.now() + 3 * 864e5).toISOString()],
        durationMins: 60,
        token: `d${stamp}${n}`,
        status,
        expiresAt: new Date(Date.now() + 2 * 864e5),
      } as never);
    await mk(1, "offered");
    await slots.declineSlots(`d${stamp}1`, "Mornings only, please");
    await processAgentEvents({ orgId });
    const runs = await runsOf("interview");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.goal).toMatch(/none of them work: "Mornings only, please"/);
    const tool = getTool("offer_interview_slots")!;
    const ctx = { orgId, principalUserId: userId, runId: "x", agentType: "interview", actor: "t" };
    const again = { applicationId: appId, level: 1, interviewerEmail: email, slots: ["a", "b"] };
    expect(await tool.precheck!(ctx as never, again as never)).toBeNull();
    await mk(2, "expired");
    await mk(3, "declined");
    expect(await tool.precheck!(ctx as never, again as never)).toMatch(/ask_human/);
  });

  test("an assessment not completed in 14 days closes and the thread is told", async () => {
    const conv = await thread();
    await db.insert(candidateAssessments).values({
      orgId,
      candidateId: candId,
      requisitionId: role,
      token: `a${stamp}`,
      status: "sent",
      createdAt: new Date(Date.now() - 15 * 864e5),
    } as never);
    await scheduleSweeps({ orgId });
    const [a] = await db
      .select()
      .from(candidateAssessments)
      .where(eq(candidateAssessments.token, `a${stamp}`));
    expect(a!.status).toBe("expired");
    expect(await messages(conv.id)).toContainEqual(
      expect.stringMatching(/did not complete the written assessment within 14 days/),
    );
  });

  test("immediate verdict policy: the Evaluation agent only debriefs", async () => {
    await enable("evaluation");
    const { emitAgentEvent } = await import("../src/server/agents/events");
    await emitAgentEvent({
      orgId,
      type: "scorecard.submitted",
      subjectType: "requisition",
      subjectId: role,
      actorUserId: userId,
      payload: {
        applicationId: appId,
        level: 1,
        verdict: "reject",
        finalRound: false,
        policy: "immediate",
      },
    });
    await processAgentEvents({ orgId });
    const [run] = await runsOf("evaluation");
    expect(run!.goal).toMatch(/verdict policy is immediate[\s\S]*do not request a hiring decision/);
  });
});

/* --------------------------------------------------------------- pricing & text */

describe("pricing and readable text", () => {
  test("list price by day, the organisation's rate first, unknown models unpriced", async () => {
    const { listPrice, priceBucket } = await import("../src/server/ai-pricing");
    expect(listPrice("google", "gemini-3.8-flash", "2026-10-09")).toMatchObject({
      inputPerMillion: 0.75,
      outputPerMillion: 3.75,
    });
    expect(listPrice("google", "gemini-3.8-flash", "2027-01-01")).toMatchObject({
      inputPerMillion: 1.5,
      outputPerMillion: 7.5,
    });
    const b = {
      provider: "google",
      model: "gemini-3.8-flash",
      day: "2026-10-09",
      promptTokens: 1_000_000,
      completionTokens: 100_000,
    };
    expect(priceBucket(b, null)).toMatchObject({
      cost: 1.125,
      currency: "USD",
      basis: "list_price",
    });
    expect(
      priceBucket(b, { currency: "INR", inputPerMillion: 60, outputPerMillion: 300 }),
    ).toMatchObject({ cost: 90, currency: "INR", basis: "org_rate" });
    expect(priceBucket({ ...b, model: "unknown-model" }, null)).toBeNull();
  });

  test("ids are taken out of text people read, the content stays", async () => {
    const { readableAgentText } = await import("../src/server/desk/desk.server");
    const u = "769901cc-785b-4e82-b6cf-9bf2eed791c4";
    expect(readableAgentText(`- Government photo ID (ID: ${u}): Verified (ID Number: T-1).`)).toBe(
      "- Government photo ID: Verified (ID Number: T-1).",
    );
    expect(
      readableAgentText(`Documents for Asha (Application ID: ${u}, Requisition: REQ-1) verified.`),
    ).toBe("Documents for Asha (Requisition: REQ-1) verified.");
    expect(readableAgentText(`Application ID: ${u}\nAll set.`)).toBe("All set.");
  });
});
