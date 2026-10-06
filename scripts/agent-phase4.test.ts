/**
 * Phase 4 agents end to end against the disposable local database: the offer
 * and pre-onboarding agents with real tools, offer / onboarding cores, outbox
 * and orchestrator — only the model is scripted. Approvals, document
 * validation and release are inbox gates performed as the deciding person.
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
  candidates,
  emailOutbox,
  offers,
  onboardingDocuments,
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
const { registerPhase4Tools } = await import("../src/server/agents/tools-phase4");
const defs = await import("../src/server/agents/definitions");
const { resolveTask, runAgentTick, startRun } = await import("../src/server/agents/runtime.server");
const { processAgentEvents } = await import("../src/server/agents/orchestrator.server");
const { emitAgentEvent } = await import("../src/server/agents/events");
const { advanceOfferCore } = await import("../src/lib/offers.functions");

let orgId: string;
const ids: Record<string, string> = {};
const emails: Record<string, string> = {};
let reqId: string;
const stamp = Date.now();

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [o] = await db
    .insert(organizations)
    .values({
      name: "P4 Org",
      slug: `p4-${stamp}`,
      status: "active",
      careersEmail: `careers-${stamp}@p4.test`,
    })
    .returning({ id: organizations.id });
  orgId = o!.id;
  for (const [key, role] of [
    ["recruiter", "recruiter"],
    ["hr", "hr_head"],
    ["cbo", "president_cbo"],
    ["manager", "hiring_manager"],
  ] as const) {
    emails[key] = `p4-${key}-${stamp}@test.local`;
    const [u] = await db.insert(users).values({ email: emails[key]! }).returning({ id: users.id });
    ids[key] = u!.id;
    await db.insert(orgMembers).values({
      orgId,
      userId: u!.id,
      email: emails[key]!,
      status: "active",
      isOwner: false,
      joinedAt: new Date(),
    });
    await db.insert(userRoles).values({ userId: u!.id, orgId, role });
  }
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(inArray(users.id, Object.values(ids)));
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

async function finalist(stage = "l3") {
  const [c] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: "Sana",
      email: `sana-${Math.random().toString(36).slice(2, 7)}@cand.local`,
      expectedCtc: "3200000",
    })
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
  await db.delete(requisitions).where(eq(requisitions.orgId, orgId));
  await db.delete(candidates).where(eq(candidates.orgId, orgId));
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-P4-${Math.random().toString(36).slice(2, 7)}`,
      title: "Platform SRE",
      status: "approved",
      ctcBandMin: "2500000",
      ctcBandMax: "3500000",
      createdBy: ids["recruiter"],
    })
    .returning({ id: requisitions.id });
  reqId = r!.id;
  registry.resetRegistry();
  registerPhase1Tools();
  registerPhase2Tools();
  registerPhase3Tools();
  registerPhase4Tools();
  defs.registerPhase1Agents();
  defs.registerPhase2Agents();
  defs.registerPhase3Agents();
  defs.registerPhase4Agents();
});

const offerOf = async (appId: string) =>
  (await db.select().from(offers).where(eq(offers.applicationId, appId)))[0];
const openTasks = (runId: string) =>
  db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, "open")));
const lastToolError = async (runId: string) => {
  const { agentSteps } = await import("../drizzle/schema");
  const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, runId));
  return steps.filter((s) => s.status === "error").map((s) => JSON.stringify(s.output));
};

describe("offer agent", () => {
  test("a hiring decision starts it for the requisition's creator; not while switched off", async () => {
    const { appId } = await finalist();
    const ev = {
      orgId,
      type: "hiring.selected" as const,
      subjectType: "application" as const,
      subjectId: appId,
      actorUserId: ids["manager"]!,
    };
    await emitAgentEvent(ev);
    await processAgentEvents({ orgId });
    expect(await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId))).toHaveLength(0);
    await enable("offer");
    await emitAgentEvent(ev);
    await processAgentEvents({ orgId });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(run).toMatchObject({
      agentType: "offer",
      subjectId: appId,
      principalUserId: ids["recruiter"],
    });
  });

  test("drafts only inside the band, once, and only for a recruiting-team principal", async () => {
    await enable("offer");
    const { appId } = await finalist();
    const { runId } = await startRun({
      orgId,
      agentType: "offer",
      principalUserId: ids["recruiter"]!,
      goal: "x",
      subjectType: "application",
      subjectId: appId,
    });
    script.push(
      call({ id: "a", name: "draft_offer", args: { applicationId: appId, offeredCtc: 4000000 } }),
      call({ id: "b", name: "draft_offer", args: { applicationId: appId, offeredCtc: 3000000 } }),
      call({ id: "c", name: "draft_offer", args: { applicationId: appId, offeredCtc: 3100000 } }),
      say("done"),
    );
    await runAgentTick({ orgId });
    const errors = await lastToolError(runId);
    expect(errors[0]).toContain("outside the approved band");
    expect(errors[1]).toContain("already has an active offer");
    const drafted = (await offerOf(appId))!;
    expect(drafted.status).toBe("draft");
    expect(Number(drafted.offeredCtc)).toBe(3000000);

    const other = await finalist();
    const m = await startRun({
      orgId,
      agentType: "offer",
      principalUserId: ids["manager"]!,
      goal: "x",
      subjectType: "application",
      subjectId: other.appId,
    });
    script.push(
      call({
        id: "d",
        name: "draft_offer",
        args: { applicationId: other.appId, offeredCtc: 3000000 },
      }),
      say("x"),
    );
    await runAgentTick({ orgId });
    expect((await lastToolError(m.runId))[0]).toContain("recruiting team");
    expect(await offerOf(other.appId)).toBeUndefined();
  });

  test("approvals run through the inbox as HR head then CBO; approval starts pre-onboarding", async () => {
    await enable("offer");
    await enable("onboarding");
    const { appId } = await finalist();
    const [o] = await db
      .insert(offers)
      .values({
        orgId,
        applicationId: appId,
        offeredCtc: "3000000",
        status: "pending_hr",
        letter: { subject: "x" } as never,
      })
      .returning({ id: offers.id });
    const { runId } = await startRun({
      orgId,
      agentType: "offer",
      principalUserId: ids["recruiter"]!,
      goal: "x",
      subjectType: "application",
      subjectId: appId,
    });
    const gate = (role: string) =>
      call({
        id: role,
        name: "request_approval",
        args: {
          title: "Approve",
          summary: "30 L",
          assignee_role: "recruiter",
          subject: { type: "offer", id: o!.id },
        },
      });
    script.push(gate("hr"));
    await runAgentTick({ orgId });
    let [t] = await openTasks(runId);
    expect(t).toMatchObject({ kind: "gate", assigneeRole: "hr_head" });
    await expect(
      resolveTask({
        orgId,
        taskId: t!.id,
        userId: ids["recruiter"]!,
        decision: { status: "approved" },
      }),
    ).rejects.toThrow();
    await resolveTask({
      orgId,
      taskId: t!.id,
      userId: ids["hr"]!,
      decision: { status: "approved" },
    });
    expect((await offerOf(appId))!.status).toBe("pending_cbo");

    script.push(gate("cbo"));
    await runAgentTick({ orgId });
    [t] = await openTasks(runId);
    expect(t!.assigneeRole).toBe("president_cbo");
    await resolveTask({
      orgId,
      taskId: t!.id,
      userId: ids["cbo"]!,
      decision: { status: "approved" },
    });
    const offer = (await offerOf(appId))!;
    expect(offer.status).toBe("approved");
    expect((offer.approvalTrail as { actor: string }[]).at(-1)!.actor).toBe(emails["cbo"]);

    await processAgentEvents({ orgId });
    const onboarding = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "onboarding")));
    expect(onboarding).toHaveLength(1);
    expect(onboarding[0]!.subjectId).toBe(appId);
  });

  test("an approval made on the Offers page closes the inbox request", async () => {
    await enable("offer");
    const { appId } = await finalist();
    const [o] = await db
      .insert(offers)
      .values({
        orgId,
        applicationId: appId,
        offeredCtc: "3000000",
        status: "pending_hr",
        letter: { subject: "x" } as never,
      })
      .returning({ id: offers.id });
    const { runId } = await startRun({
      orgId,
      agentType: "offer",
      principalUserId: ids["recruiter"]!,
      goal: "x",
      subjectType: "application",
      subjectId: appId,
    });
    script.push(
      call({
        id: "g",
        name: "request_approval",
        args: {
          title: "A",
          summary: "B",
          assignee_role: "hr_head",
          subject: { type: "offer", id: o!.id },
        },
      }),
    );
    await runAgentTick({ orgId });
    await advanceOfferCore(
      { orgId, userId: ids["hr"]!, memberEmail: emails["hr"]! },
      { id: o!.id, status: "pending_cbo" },
    );
    await processAgentEvents({ orgId });
    const [task] = await db.select().from(agentTasks).where(eq(agentTasks.runId, runId));
    expect(task).toMatchObject({ status: "approved", decidedBy: ids["hr"] });
  });
});

describe("pre-onboarding agent", () => {
  async function approvedOffer() {
    const f = await finalist("offer_pending");
    const [o] = await db
      .insert(offers)
      .values({ orgId, applicationId: f.appId, offeredCtc: "3000000", status: "approved" })
      .returning({ id: offers.id });
    return { ...f, offerId: o!.id };
  }
  const doc = (appId: string, candidateId: string, docType: string, status = "pending") =>
    db
      .insert(onboardingDocuments)
      .values({
        orgId,
        applicationId: appId,
        candidateId,
        docType,
        fileName: `${docType}.pdf`,
        source: "upload",
        extractionStatus: "ok",
        status,
        uploadedBy: ids["recruiter"]!,
      } as never)
      .returning({ id: onboardingDocuments.id });

  test("requests only catalogue documents, by email with the careers address to reply to", async () => {
    await enable("onboarding", "act_and_notify");
    await db
      .update(agentPolicies)
      .set({ whitelistedTemplates: ["document_request"], autonomy: "autonomous" })
      .where(eq(agentPolicies.orgId, orgId));
    const { appId } = await approvedOffer();
    const { runId } = await startRun({
      orgId,
      agentType: "onboarding",
      principalUserId: ids["recruiter"]!,
      goal: "x",
      subjectType: "application",
      subjectId: appId,
    });
    script.push(
      call({
        id: "a",
        name: "request_documents",
        args: { applicationId: appId, documentTypes: ["passport_scan"] },
      }),
      call({
        id: "b",
        name: "request_documents",
        args: { applicationId: appId, documentTypes: ["id_proof", "payslip"] },
      }),
      say("done"),
    );
    await runAgentTick({ orgId });
    expect((await lastToolError(runId))[0]).toContain("Unknown document types");
    const [mail] = await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId));
    expect(mail).toMatchObject({ kind: "document_request" });
    expect((mail!.templateData as { replyTo: string; documents: string }).replyTo).toBe(
      `careers-${stamp}@p4.test`,
    );
    expect((mail!.templateData as { documents: string }).documents.split("\n")).toHaveLength(2);
  });

  test("document validation: approve verifies as HR, decline rejects with the reason", async () => {
    await enable("onboarding");
    const { appId, candidateId } = await approvedOffer();
    const [d1] = await doc(appId, candidateId, "payslip");
    const [d2] = await doc(appId, candidateId, "id_proof");
    const { runId } = await startRun({
      orgId,
      agentType: "onboarding",
      principalUserId: ids["recruiter"]!,
      goal: "x",
      subjectType: "application",
      subjectId: appId,
    });
    script.push(
      call({
        id: "v",
        name: "request_approval",
        args: {
          title: "Validate",
          summary: "ok",
          assignee_role: "recruiter",
          subject: { type: "document_validation", applicationId: appId, documentIds: [d1!.id] },
        },
      }),
    );
    await runAgentTick({ orgId });
    let [t] = await openTasks(runId);
    expect(t).toMatchObject({ assigneeRole: "hr_head" });
    await resolveTask({
      orgId,
      taskId: t!.id,
      userId: ids["hr"]!,
      decision: { status: "approved" },
    });
    expect(
      (await db.select().from(onboardingDocuments).where(eq(onboardingDocuments.id, d1!.id)))[0],
    ).toMatchObject({ status: "verified", reviewedBy: ids["hr"] });

    script.push(
      call({
        id: "w",
        name: "request_approval",
        args: {
          title: "Validate",
          summary: "blurry",
          assignee_role: "hr_head",
          subject: { type: "document_validation", applicationId: appId, documentIds: [d2!.id] },
        },
      }),
    );
    await runAgentTick({ orgId });
    [t] = await openTasks(runId);
    await resolveTask({
      orgId,
      taskId: t!.id,
      userId: ids["hr"]!,
      decision: { status: "rejected", reason: "Photo is blurred" },
    });
    expect(
      (await db.select().from(onboardingDocuments).where(eq(onboardingDocuments.id, d2!.id)))[0],
    ).toMatchObject({ status: "rejected", reviewNote: "Photo is blurred" });
  });

  test("release is refused until every required document is verified, then performed by the HR head", async () => {
    await enable("onboarding");
    const { appId, candidateId, offerId } = await approvedOffer();
    const { runId } = await startRun({
      orgId,
      agentType: "onboarding",
      principalUserId: ids["recruiter"]!,
      goal: "x",
      subjectType: "application",
      subjectId: appId,
    });
    const release = () =>
      call({
        id: "r",
        name: "request_approval",
        args: {
          title: "Release",
          summary: "ready",
          assignee_role: "hr_head",
          subject: { type: "offer_release", offerId },
        },
      });
    script.push(release(), say("waiting"));
    await runAgentTick({ orgId });
    expect((await lastToolError(runId))[0]).toContain("Pre-onboarding is incomplete");

    for (const t of ["id_proof", "experience_letter", "payslip", "education_certificate"])
      await doc(appId, candidateId, t, "verified");
    const second = await startRun({
      orgId,
      agentType: "onboarding",
      principalUserId: ids["recruiter"]!,
      goal: "y",
      subjectType: "application",
      subjectId: appId,
    });
    script.push(release());
    await runAgentTick({ orgId });
    const [t] = await openTasks(second.runId);
    await expect(
      resolveTask({
        orgId,
        taskId: t!.id,
        userId: ids["recruiter"]!,
        decision: { status: "approved" },
      }),
    ).rejects.toThrow();
    await resolveTask({
      orgId,
      taskId: t!.id,
      userId: ids["hr"]!,
      decision: { status: "approved" },
    });
    expect((await offerOf(appId))!.status).toBe("released");
    expect(
      (
        await db
          .select({ s: applications.stage })
          .from(applications)
          .where(eq(applications.id, appId))
      )[0]!.s,
    ).toBe("offer_released");
  });

  test("a document arriving starts pre-onboarding only once the offer is approved", async () => {
    await enable("onboarding");
    const pre = await finalist("l3");
    await emitAgentEvent({
      orgId,
      type: "onboarding.document_received",
      subjectType: "application",
      subjectId: pre.appId,
      actorUserId: null,
    });
    await processAgentEvents({ orgId });
    expect(await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId))).toHaveLength(0);
    const ready = await approvedOffer();
    await emitAgentEvent({
      orgId,
      type: "onboarding.document_received",
      subjectType: "application",
      subjectId: ready.appId,
      actorUserId: null,
    });
    await processAgentEvents({ orgId });
    expect((await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId)))[0]).toMatchObject({
      agentType: "onboarding",
      subjectId: ready.appId,
    });
  });
});
