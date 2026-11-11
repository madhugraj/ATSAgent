/**
 * Agent health engine (src/server/agents/health.server.ts) against the
 * disposable local database: each rule opens an issue when its condition
 * holds, escalates, re-sees without duplicating, and resolves when it clears;
 * the scheduler heartbeat reports a stopped scheduler.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, ne } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentDefinitions,
  agentEvents,
  agentIssues,
  agentRuns,
  agentRuntimeHeartbeat,
  agentSteps,
  agentTasks,
  aiUsageEvents,
  auditLog,
  organizations,
  users,
} = await import("../drizzle/schema");
const { evaluateAgentHealth, heartbeatAndMaybeEvaluate, schedulerStatus, HEALTH } =
  await import("../src/server/agents/health.server");

let orgId: string;
let userId: string;
const stamp = Date.now();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db
    .insert(users)
    .values({ email: `health-${stamp}@test.local` })
    .returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Health Org", slug: `health-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await db.delete(agentIssues).where(eq(agentIssues.orgId, orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentEvents).where(eq(agentEvents.orgId, orgId));
  await db.delete(auditLog).where(eq(auditLog.orgId, orgId));
});

async function run(agentType: string, values: Record<string, unknown> = {}) {
  const [r] = await db
    .insert(agentRuns)
    .values({
      orgId,
      agentType: agentType as never,
      principalUserId: userId,
      goal: "t",
      ...values,
    } as never)
    .returning({ id: agentRuns.id });
  return r!.id;
}

const open = () =>
  db
    .select()
    .from(agentIssues)
    .where(and(eq(agentIssues.orgId, orgId), ne(agentIssues.status, "resolved")));
const evaluate = () => evaluateAgentHealth({ orgId });

describe("rules", () => {
  test("stuck run: critical while stuck, resolved (and audited) when it clears", async () => {
    const id = await run("intake", {
      status: "running",
      leaseUntil: ago(HEALTH.stuckLeaseMinutes + 5),
    });
    expect((await evaluate()).opened).toBe(1);
    const [issue] = await open();
    expect(issue).toMatchObject({
      agentType: "intake",
      element: "harness",
      rule: "harness.stuck_run",
      severity: "critical",
    });

    expect((await evaluate()).opened).toBe(0); // re-seen, not duplicated
    expect((await open())[0]!.occurrences).toBe(2);

    await db.update(agentRuns).set({ status: "done" }).where(eq(agentRuns.id, id));
    expect((await evaluate()).resolved).toBe(1);
    expect(await open()).toHaveLength(0);
    const actions = (
      await db.select({ a: auditLog.action }).from(auditLog).where(eq(auditLog.orgId, orgId))
    ).map((r) => r.a);
    expect(actions).toEqual(expect.arrayContaining(["agent.issue.opened", "agent.issue.resolved"]));
  });

  test("overdue human request: warning past the SLA, serious past the escalation point", async () => {
    const id = await run("requisition", { status: "awaiting_human" });
    const [task] = await db
      .insert(agentTasks)
      .values({
        orgId,
        runId: id,
        kind: "clarification",
        title: "q",
        createdAt: ago((HEALTH.hitlSlaHours + 2) * 60),
      })
      .returning({ id: agentTasks.id });
    await evaluate();
    expect((await open())[0]).toMatchObject({
      rule: "hitl.overdue",
      severity: "warning",
      agentType: "requisition",
    });
    await db
      .update(agentTasks)
      .set({ createdAt: ago((HEALTH.hitlSeriousHours + 2) * 60) })
      .where(eq(agentTasks.id, task!.id));
    await evaluate();
    expect((await open())[0]!.severity).toBe("serious");
  });

  test("sourcing that finds nobody for a role, run after run, is flagged", async () => {
    const { requisitions } = await import("../drizzle/schema");
    const [q] = await db
      .insert(requisitions)
      .values({ orgId, code: `REQ-H-${stamp}`, title: "SRE", status: "approved" } as never)
      .returning({ id: requisitions.id });
    const fruitless = () =>
      run("sourcing", { status: "done", subjectType: "requisition", subjectId: q!.id });
    await fruitless();
    await evaluate();
    expect(await open()).toHaveLength(0);
    await fruitless();
    await evaluate();
    expect((await open())[0]).toMatchObject({ rule: "sourcing.no_supply", agentType: "sourcing" });
    // A run that added someone means the supply is not exhausted.
    await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
    const ok = await fruitless();
    await fruitless();
    await db.insert(agentSteps).values({
      runId: ok,
      orgId,
      seq: 1,
      kind: "tool",
      toolName: "add_to_pipeline",
      status: "ok",
    });
    await evaluate();
    expect((await open()).filter((i) => i.rule === "sourcing.no_supply")).toHaveLength(0);
  });

  test("an offer going back and forth (3+ revisions, still open) is flagged", async () => {
    const { offers, applications, candidates, requisitions } = await import("../drizzle/schema");
    const [q] = await db
      .insert(requisitions)
      .values({ orgId, code: `REQ-O-${stamp}`, title: "VP", status: "approved" } as never)
      .returning({ id: requisitions.id });
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Asha", email: `asha-${stamp}@x.local` })
      .returning({ id: candidates.id });
    const [a] = await db
      .insert(applications)
      .values({ orgId, requisitionId: q!.id, candidateId: c!.id, stage: "offer_released" })
      .returning({ id: applications.id });
    await db
      .insert(offers)
      .values({ orgId, applicationId: a!.id, status: "countered", revision: 2 } as never);
    await evaluate();
    expect((await open()).filter((i) => i.rule === "offer.negotiation_loop")).toHaveLength(0);
    await db.update(offers).set({ revision: 3 }).where(eq(offers.applicationId, a!.id));
    await evaluate();
    expect((await open()).find((i) => i.rule === "offer.negotiation_loop")).toMatchObject({
      agentType: "offer",
    });
    // Leave no open offer behind for the other rules' tests.
    await db.delete(requisitions).where(eq(requisitions.id, q!.id));
  });

  test("an offer stalled on unknown pay (form closed unanswered) is flagged until it is known", async () => {
    const { applications, candidates, requisitions, compensationRequests, compensationDetails } =
      await import("../drizzle/schema");
    const [q] = await db
      .insert(requisitions)
      .values({ orgId, code: `REQ-PAY-${stamp}`, title: "VP", status: "approved" } as never)
      .returning({ id: requisitions.id });
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Ravi", email: `ravi-${stamp}@x.local` })
      .returning({ id: candidates.id });
    const [a] = await db
      .insert(applications)
      .values({ orgId, requisitionId: q!.id, candidateId: c!.id, stage: "l3" })
      .returning({ id: applications.id });
    const [r] = await db
      .insert(compensationRequests)
      .values({
        orgId,
        applicationId: a!.id,
        candidateId: c!.id,
        token: `p${stamp}`,
        status: "sent",
      })
      .returning({ id: compensationRequests.id });
    const rule = async () => (await open()).filter((i) => i.rule === "offer.pay_unknown");
    await evaluate();
    expect(await rule()).toHaveLength(0); // still open: the candidate may answer
    await db
      .update(compensationRequests)
      .set({ status: "expired" })
      .where(eq(compensationRequests.id, r!.id));
    await evaluate();
    expect((await rule())[0]).toMatchObject({ agentType: "offer", severity: "warning" });
    // TA enters it from a call: the issue resolves.
    await db.insert(compensationDetails).values({
      orgId,
      applicationId: a!.id,
      candidateId: c!.id,
      expectedCtc: "9000000",
      noticePeriodDays: 30,
      source: "screening_call",
    });
    await evaluate();
    expect(await rule()).toHaveLength(0);
    await db.delete(requisitions).where(eq(requisitions.id, q!.id));
  });

  test("a pay discussion waiting on a person, or ended without agreement, is flagged", async () => {
    const { applications, candidates, requisitions, offerNegotiations } =
      await import("../drizzle/schema");
    const [q] = await db
      .insert(requisitions)
      .values({ orgId, code: `REQ-NEG-${stamp}`, title: "VP", status: "approved" } as never)
      .returning({ id: requisitions.id });
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Neha", email: `neha-${stamp}@x.local` })
      .returning({ id: candidates.id });
    const [a] = await db
      .insert(applications)
      .values({ orgId, requisitionId: q!.id, candidateId: c!.id, stage: "offer_pending" })
      .returning({ id: applications.id });
    const rule = async () => (await open()).filter((i) => i.rule === "offer.negotiation_stalled");
    const [n] = await db
      .insert(offerNegotiations)
      .values({
        orgId,
        applicationId: a!.id,
        candidateId: c!.id,
        status: "countered",
        ceiling: "11000000",
        ceilingApprovedBy: "hr_head",
        proposedCtc: "11000000",
        updatedAt: new Date(),
      })
      .returning({ id: offerNegotiations.id });
    await evaluate();
    expect(await rule()).toHaveLength(0); // fresh: a person has time to act
    await db
      .update(offerNegotiations)
      .set({ updatedAt: new Date(Date.now() - (HEALTH.negotiationWaitDays + 1) * 864e5) })
      .where(eq(offerNegotiations.id, n!.id));
    await evaluate();
    expect((await rule())[0]).toMatchObject({ agentType: "offer", severity: "warning" });
    // Agreed: nothing left to flag.
    await db
      .update(offerNegotiations)
      .set({ status: "agreed" })
      .where(eq(offerNegotiations.id, n!.id));
    await evaluate();
    expect(await rule()).toHaveLength(0);
    await db.delete(requisitions).where(eq(requisitions.id, q!.id));
  });

  test("a run stopped on its limits is flagged until its work is picked up again", async () => {
    const { LEG_LIMIT_MESSAGE, CEILING_MESSAGE } =
      await import("../src/server/agents/run-messages");
    const subject = crypto.randomUUID();
    const rule = async () => (await open()).filter((i) => i.rule === "harness.run_limits");
    await run("requisition", {
      status: "failed",
      lastError: LEG_LIMIT_MESSAGE,
      subjectType: "requisition",
      subjectId: subject,
      finishedAt: ago(30),
      createdAt: ago(60),
    });
    await evaluate();
    expect((await rule())[0]).toMatchObject({ agentType: "requisition", severity: "warning" });
    // Tried again and finished: nothing is waiting any more.
    await run("requisition", {
      status: "done",
      subjectType: "requisition",
      subjectId: subject,
      createdAt: ago(10),
      finishedAt: ago(5),
    });
    await evaluate();
    expect(await rule()).toHaveLength(0);
    // Stopped at the overall ceiling: serious.
    await run("jd", {
      status: "failed",
      lastError: CEILING_MESSAGE,
      subjectType: "requisition",
      subjectId: crypto.randomUUID(),
      finishedAt: ago(20),
    });
    await evaluate();
    expect((await rule()).find((i) => i.agentType === "jd")).toMatchObject({ severity: "serious" });
  });

  test("tool error rate fires above the threshold only", async () => {
    const id = await run("screening", { status: "done" });
    const steps = (errors: number) =>
      Array.from({ length: HEALTH.minToolCalls }, (_, i) => ({
        runId: id,
        orgId,
        seq: i + 1,
        kind: "tool",
        toolName: "get_screening_status",
        status: i < errors ? "error" : "ok",
      }));
    await db.insert(agentSteps).values(steps(1));
    await evaluate();
    expect(await open()).toHaveLength(0);
    await db.delete(agentSteps).where(eq(agentSteps.runId, id));
    await db.insert(agentSteps).values(steps(4));
    await evaluate();
    expect((await open())[0]).toMatchObject({ rule: "tools.error_rate", severity: "serious" });
    expect((await open())[0]!.detail).toMatchObject({
      calls: 10,
      errors: 4,
      topFailingTool: "get_screening_status",
    });
  });

  test("AI errors inside an agent's runs (incl. inside tools)", async () => {
    const id = await run("jd", { status: "done" });
    await db.insert(aiUsageEvents).values(
      Array.from({ length: 6 }, (_, i) => ({
        orgId,
        agentRunId: id,
        feature: "jd_generate",
        provider: "x",
        model: "x",
        status: (i < 3 ? "error" : "ok") as never,
      })),
    );
    await evaluate();
    expect((await open()).map((i) => i.rule)).toContain("skills.ai_errors");
  });

  test("HR copilot AI errors (chat and demand outlook, outside agent runs)", async () => {
    await db.insert(aiUsageEvents).values(
      Array.from({ length: 6 }, (_, i) => ({
        orgId,
        feature: i % 2 ? "copilot" : "demand_outlook",
        provider: "x",
        model: "x",
        status: (i < 4 ? "error" : "ok") as never,
      })),
    );
    try {
      await evaluate();
      const issue = (await open()).find((i) => i.rule === "skills.copilot_errors");
      expect(issue).toMatchObject({ agentType: "copilot", severity: "serious" });
      expect(issue!.detail).toMatchObject({ requests: 6, errors: 4 });
    } finally {
      await db.delete(aiUsageEvents).where(eq(aiUsageEvents.orgId, orgId));
    }
  });

  test("audit gap: a completed write tool call without its audit entry is critical", async () => {
    const [def] = await db
      .insert(agentDefinitions)
      .values({
        agentType: "intake",
        version: "t",
        hash: `health-${stamp}-${Math.random()}`,
        manifest: {
          tools: [
            { name: "move_candidate", risk: "write" },
            { name: "list_applications", risk: "read" },
          ],
        },
      })
      .returning({ id: agentDefinitions.id });
    const id = await run("intake", { status: "done", definitionId: def!.id });
    await db.insert(auditLog).values({
      orgId,
      actor: `agent:intake:${id}`,
      action: "agent.run.started",
      entityType: "agent_run",
      entityId: id,
    });
    await db.insert(agentSteps).values([
      {
        runId: id,
        orgId,
        seq: 1,
        kind: "tool",
        toolName: "list_applications",
        status: "ok",
        createdAt: ago(10),
      },
      {
        runId: id,
        orgId,
        seq: 2,
        kind: "tool",
        toolName: "move_candidate",
        status: "ok",
        createdAt: ago(10),
      },
    ]);
    await evaluate();
    expect((await open())[0]).toMatchObject({
      rule: "audit.gap",
      severity: "critical",
      element: "audit",
    });
    await db.insert(auditLog).values({
      orgId,
      actor: `agent:intake:${id}`,
      action: "agent.tool.move_candidate",
      entityType: "agent_run",
      entityId: id,
    });
    await evaluate();
    expect(await open()).toHaveLength(0);
    await db.delete(agentDefinitions).where(eq(agentDefinitions.id, def!.id));
  });

  test("orchestrator: failed or stale lifecycle events are an organisation-wide issue", async () => {
    await db.insert(agentEvents).values([
      { orgId, type: "jd.approved", status: "failed", attempts: 3 },
      {
        orgId,
        type: "jd.approved",
        status: "pending",
        createdAt: ago(HEALTH.eventBacklogMinutes + 5),
      },
    ]);
    await evaluate();
    expect((await open())[0]).toMatchObject({
      agentType: "*",
      rule: "orchestrator.events",
      detail: { failed: 1, stale: 1 },
    });
  });

  test("an acknowledged issue stays acknowledged while it persists and still auto-resolves", async () => {
    const id = await run("intake", { status: "running", leaseUntil: ago(60) });
    await evaluate();
    const [issue] = await open();
    await db
      .update(agentIssues)
      .set({ status: "acknowledged" })
      .where(eq(agentIssues.id, issue!.id));
    await evaluate();
    expect((await open())[0]!.status).toBe("acknowledged");
    await db.update(agentRuns).set({ status: "failed" }).where(eq(agentRuns.id, id));
    await evaluate();
    expect(await open()).toHaveLength(0);
  });
});

describe("scheduling call health", () => {
  test("few bookings from connected scheduling calls, and AI-call opt-outs", async () => {
    const { applications, candidates, interviewSlotOffers, requisitions, screeningCalls } =
      await import("../drizzle/schema");
    const [req] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-H-${Date.now()}`,
        title: "x",
        status: "approved",
        createdBy: userId,
      } as never)
      .returning({ id: requisitions.id });
    const [cand] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Asha", email: `asha-${Date.now()}@h.local` } as never)
      .returning({ id: candidates.id });
    const [app] = await db
      .insert(applications)
      .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: "l1" } as never)
      .returning({ id: applications.id });
    const [offer] = await db
      .insert(interviewSlotOffers)
      .values({
        orgId,
        applicationId: app!.id,
        level: 1,
        interviewerEmail: "p@h.local",
        slots: [new Date(Date.now() + 3 * 864e5).toISOString()],
        token: `h-${Date.now()}`,
        expiresAt: new Date(Date.now() + 864e5),
      })
      .returning({ id: interviewSlotOffers.id });
    const calls = (n: number, endReason: string) =>
      db.insert(screeningCalls).values(
        Array.from({ length: n }, () => ({
          orgId,
          candidateId: cand!.id,
          applicationId: app!.id,
          purpose: "scheduling" as const,
          slotOfferId: offer!.id,
          status: "completed" as const,
          consentAt: new Date(),
          endReason,
        })),
      );
    const ruleOf = async (rule: string) => (await open()).find((i) => i.rule === rule);
    await calls(HEALTH.minSchedulingCalls7d, "availability_noted");
    await evaluate();
    expect(await ruleOf("scheduling_call.no_booking")).toMatchObject({
      agentType: "scheduling_call",
      severity: "warning",
    });
    await calls(HEALTH.minSchedulingCalls7d, "booked");
    await evaluate();
    expect(await ruleOf("scheduling_call.no_booking")).toBeUndefined();

    for (let i = 0; i < HEALTH.aiCallOptOuts7d; i++)
      await db.insert(auditLog).values({
        orgId,
        actor: "t",
        action: "candidate.ai_call_opt_out",
        entityType: "candidate",
        entityId: cand!.id,
        detail: {},
      } as never);
    await evaluate();
    expect(await ruleOf("ai_call.opt_outs")).toMatchObject({ severity: "warning" });
    await db.delete(screeningCalls).where(eq(screeningCalls.applicationId, app!.id));
    await db.delete(applications).where(eq(applications.id, app!.id));
    await db.delete(candidates).where(eq(candidates.id, cand!.id));
    await db.delete(requisitions).where(eq(requisitions.id, req!.id));
  });
});

describe("replies cut off at the length limit", () => {
  test("flagged once they repeat", async () => {
    const id = await run("screening");
    const cut = (seq: number) =>
      db.insert(agentSteps).values({
        runId: id,
        orgId,
        seq,
        kind: "model",
        status: "ok",
        output: { stopReason: "max_tokens" },
      } as never);
    await cut(1);
    await evaluate();
    expect((await open()).find((i) => i.rule === "harness.cut_off_replies")).toBeUndefined();
    await cut(2);
    await evaluate();
    expect((await open()).find((i) => i.rule === "harness.cut_off_replies")).toMatchObject({
      agentType: "screening",
    });
  });
});

describe("an agent going round in circles", () => {
  test("a run that keeps asking people questions is flagged", async () => {
    const id = await run("interview");
    const ask = (n: number) =>
      db.insert(agentTasks).values(
        Array.from({ length: n }, () => ({
          orgId,
          runId: id,
          kind: "clarification" as const,
          title: "q",
        })),
      );
    await ask(HEALTH.questionsPerRun - 1);
    await evaluate();
    expect((await open()).find((i) => i.rule === "hitl.repeated_questions")).toBeUndefined();
    await ask(1);
    await evaluate();
    expect((await open()).find((i) => i.rule === "hitl.repeated_questions")).toMatchObject({
      agentType: "interview",
      severity: "warning",
    });
  });
});

describe("an agent re-reading instead of working", () => {
  test("a run that calls the same read tool again and again is flagged", async () => {
    const id = await run("org_context");
    let seq = 100;
    const read = (n: number) =>
      db.insert(agentSteps).values(
        Array.from({ length: n }, () => ({
          runId: id,
          orgId,
          seq: seq++,
          kind: "tool",
          toolName: "read_org_website",
          status: "ok",
        })) as never,
      );
    await read(HEALTH.repeatedReadsPerRun - 1);
    await evaluate();
    expect((await open()).find((i) => i.rule === "tools.repeated_reads")).toBeUndefined();
    await read(1);
    await evaluate();
    expect((await open()).find((i) => i.rule === "tools.repeated_reads")).toMatchObject({
      agentType: "org_context",
      severity: "warning",
    });
  });

  test("searching a document for different sections is not re-reading", async () => {
    const id = await run("labour_policy");
    await db.insert(agentSteps).values(
      Array.from({ length: HEALTH.repeatedReadsPerRun + 3 }, (_, n) => ({
        runId: id,
        orgId,
        seq: 500 + n,
        kind: "tool",
        toolName: "read_policy_document",
        input: { documentUrl: "https://x.gov.in/a.pdf", search: [`section ${n}`] },
        status: "ok",
      })) as never,
    );
    await evaluate();
    expect(
      (await open()).find(
        (i) => i.rule === "tools.repeated_reads" && i.agentType === "labour_policy",
      ),
    ).toBeUndefined();
  });

  test("a live phone call's length is not AI latency", async () => {
    const { aiUsageEvents } = await import("../drizzle/schema");
    const id = await run("screening_call");
    await db.insert(aiUsageEvents).values(
      Array.from({ length: HEALTH.minAiRequests + 1 }, () => ({
        orgId,
        agentRunId: id,
        feature: "screening_call",
        provider: "google",
        model: "m",
        status: "ok",
        durationMs: 240_000,
      })) as never,
    );
    await evaluate();
    expect(
      (await open()).find((i) => i.rule === "skills.latency" && i.agentType === "screening_call"),
    ).toBeUndefined();
  });
});

describe("a hiring manager who never answers the expert interview", () => {
  test("flagged once the questions are older than the limit", async () => {
    const id = await run("expert_interview");
    const [t] = await db
      .insert(agentTasks)
      .values({
        orgId,
        runId: id,
        kind: "clarification",
        title: "Questions",
        body: "1. What matters?",
        assigneeRole: "hiring_manager",
      } as never)
      .returning({ id: agentTasks.id });
    await evaluate();
    expect((await open()).find((i) => i.rule === "expert_interview.unanswered")).toBeUndefined();
    await db
      .update(agentTasks)
      .set({ createdAt: ago(60 * (HEALTH.expertUnansweredHours + 1)) })
      .where(eq(agentTasks.id, t!.id));
    await evaluate();
    expect((await open()).find((i) => i.rule === "expert_interview.unanswered")).toMatchObject({
      agentType: "expert_interview",
      severity: "warning",
    });
  });
});

describe("scheduler heartbeat", () => {
  test("a tick records liveness; an old tick reads as stopped", async () => {
    await heartbeatAndMaybeEvaluate({ claimed: 0 });
    expect((await schedulerStatus()).healthy).toBe(true);
    await db
      .update(agentRuntimeHeartbeat)
      .set({ lastTickAt: ago(HEALTH.heartbeatMinutes + 3) })
      .where(eq(agentRuntimeHeartbeat.id, "agents"));
    const s = await schedulerStatus();
    expect(s.healthy).toBe(false);
    expect(s.minutesSinceTick).toBeGreaterThanOrEqual(HEALTH.heartbeatMinutes + 3);
  });
});

describe("distribution rules", () => {
  const days = (n: number) => new Date(Date.now() - n * 864e5);
  async function seed() {
    const { requisitions, candidates, applications } = await import("../drizzle/schema");
    const role = async (status: string) =>
      (
        await db
          .insert(requisitions)
          .values({
            orgId,
            code: `REQ-DH-${Math.random().toString(36).slice(2, 7)}`,
            title: "SRE",
            status,
          } as never)
          .returning({ id: requisitions.id })
      )[0]!.id;
    const person = async (values: Record<string, unknown>) =>
      (
        await db
          .insert(candidates)
          .values({
            orgId,
            fullName: "Meena",
            email: `m-${Math.random().toString(36).slice(2, 7)}@x.local`,
            ...values,
          } as never)
          .returning({ id: candidates.id })
      )[0]!.id;
    return { role, person, applications, requisitions, candidates };
  }

  test("a portal listing quiet for 14 days is flagged, only where the Distribution agent is on", async () => {
    const { requisitionBoardPostings, agentPolicies } = await import("../drizzle/schema");
    const { role, requisitions } = await seed();
    const r = await role("approved");
    await db.insert(requisitionBoardPostings).values({
      orgId,
      requisitionId: r,
      provider: "workindia",
      status: "published",
      publishedAt: days(HEALTH.quietListingDays + 1),
    });
    await evaluate();
    expect((await open()).filter((i) => i.rule === "distribution.quiet_listing")).toHaveLength(0);
    await db.insert(agentPolicies).values({ orgId, agentType: "distribution", enabled: true });
    await evaluate();
    expect((await open()).find((i) => i.rule === "distribution.quiet_listing")).toMatchObject({
      agentType: "distribution",
      title: expect.stringMatching(/on WorkIndia/),
    });
    await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
    await db.delete(requisitions).where(eq(requisitions.id, r));
  });

  test("role-limited CVs kept a week past their erasure date are a serious finding", async () => {
    const { role, person, applications, requisitions, candidates } = await seed();
    const closed = await role("closed");
    const c = await person({ poolUse: "role_only", poolUseSource: "naukri", createdAt: days(60) });
    await db.insert(applications).values({
      orgId,
      requisitionId: closed,
      candidateId: c,
      stage: "rejected",
      source: "naukri",
      lastActivityAt: days(33),
    } as never);
    await evaluate();
    expect(
      (await open()).filter((i) => i.rule === "distribution.role_limited_retention"),
    ).toHaveLength(0);
    await db
      .update(applications)
      .set({ lastActivityAt: days(30 + HEALTH.roleLimitedOverdueDays + 1) })
      .where(eq(applications.candidateId, c));
    await evaluate();
    expect(
      (await open()).find((i) => i.rule === "distribution.role_limited_retention"),
    ).toMatchObject({ agentType: "distribution", severity: "serious" });
    await db.delete(candidates).where(eq(candidates.id, c));
    await db.delete(requisitions).where(eq(requisitions.id, closed));
  });
});

describe("phone screening health", () => {
  const ruleOf = async (rule: string) => (await open()).find((i) => i.rule === rule);
  async function calls(n: number, values: Record<string, unknown>) {
    const { candidates, screeningCalls } = await import("../drizzle/schema");
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Call Test", email: `call-${Math.random()}@cand.local` } as never)
      .returning({ id: candidates.id });
    for (let i = 0; i < n; i++)
      await db.insert(screeningCalls).values({ orgId, candidateId: c!.id, ...values } as never);
    return c!.id;
  }
  const clear = async (candidateId: string) => {
    const { candidates } = await import("../drizzle/schema");
    await db.delete(candidates).where(eq(candidates.id, candidateId));
  };

  test("calls not placed long after they were due; resolved once placed", async () => {
    const c = await calls(1, { status: "approved", dueAt: ago(60) });
    await evaluate();
    expect(await ruleOf("screening_call.not_placed")).toBeUndefined();
    const late = await calls(1, {
      status: "approved",
      dueAt: ago(HEALTH.callOverdueHours * 60 + 10),
    });
    await evaluate();
    expect(await ruleOf("screening_call.not_placed")).toMatchObject({
      agentType: "screening_call",
      severity: "serious",
    });
    await clear(late);
    await evaluate();
    expect(await ruleOf("screening_call.not_placed")).toBeUndefined();
    await clear(c);
  });

  test("a call stuck mid-call is critical", async () => {
    const c = await calls(1, {
      status: "in_progress",
      updatedAt: ago(HEALTH.callStuckMinutes + 5),
    });
    await evaluate();
    expect(await ruleOf("screening_call.stuck")).toMatchObject({ severity: "critical" });
    await clear(c);
  });

  test("line or voice failures, not unanswered calls", async () => {
    const quiet = await calls(HEALTH.callFailures24h, { status: "no_answer", attempt: 1 });
    await evaluate();
    expect(await ruleOf("screening_call.failures")).toBeUndefined();
    const broken = await calls(HEALTH.callFailures24h, {
      status: "fell_back",
      attempt: 1,
      lastError: "503 Service Unavailable",
    });
    await evaluate();
    expect(await ruleOf("screening_call.failures")).toMatchObject({ severity: "serious" });
    await clear(quiet);
    await clear(broken);
  });

  test("low pick-up, then many declines, then calls ending before any question", async () => {
    const unanswered = await calls(HEALTH.minCalls7d, { status: "no_answer", attempt: 1 });
    await evaluate();
    expect(await ruleOf("screening_call.answer_rate")).toMatchObject({ severity: "warning" });
    await clear(unanswered);

    const declined = await calls(HEALTH.minCalls7d, {
      status: "consent_declined",
      attempt: 1,
      startedAt: ago(30),
    });
    await evaluate();
    expect(await ruleOf("screening_call.answer_rate")).toBeUndefined();
    expect(await ruleOf("screening_call.declines")).toMatchObject({ severity: "warning" });
    await clear(declined);

    const short = await calls(HEALTH.shortCalls7d, {
      status: "completed",
      attempt: 1,
      startedAt: ago(30),
      consentAt: ago(29),
    });
    await evaluate();
    expect(await ruleOf("screening_call.short_calls")).toMatchObject({ severity: "warning" });
    await clear(short);
    await evaluate();
    expect(await ruleOf("screening_call.short_calls")).toBeUndefined();
  });

  test("a high share of prompted answers (the candidate only agreed) is flagged", async () => {
    const own = { question_id: "q1", summary: "Runs three EKS clusters." };
    const prompted = { question_id: "q1", summary: "Yes, EKS.", prompted: true };
    // Under the threshold (or too few answers): quiet.
    const few = await calls(2, {
      status: "completed",
      attempt: 1,
      startedAt: ago(30),
      answers: [own, prompted],
    });
    await evaluate();
    expect(await ruleOf("screening_call.prompted")).toBeUndefined();
    await clear(few);
    // HEALTH.callPromptedShare of answers prompted, over HEALTH.minCallAnswers7d of them.
    const many = await calls(2, {
      status: "completed",
      attempt: 1,
      startedAt: ago(30),
      answers: [own, own, prompted, prompted, prompted],
    });
    await evaluate();
    expect(await ruleOf("screening_call.prompted")).toMatchObject({
      agentType: "screening_call",
      severity: "warning",
    });
    await clear(many);
    await evaluate();
    expect(await ruleOf("screening_call.prompted")).toBeUndefined();
  });
});

describe("Voice Guard health", () => {
  const ruleOf = async (rule: string) => (await open()).find((i) => i.rule === rule);
  async function endedCall(minutesAgo: number) {
    const { candidates, screeningCalls } = await import("../drizzle/schema");
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Guard Test", email: `vg-${Math.random()}@cand.local` } as never)
      .returning({ id: candidates.id });
    const [call] = await db
      .insert(screeningCalls)
      .values({
        orgId,
        candidateId: c!.id,
        status: "completed",
        startedAt: ago(minutesAgo + 5),
        endedAt: ago(minutesAgo),
      } as never)
      .returning({ id: screeningCalls.id });
    return { candidateId: c!.id, callId: call!.id };
  }
  const clear = async (candidateId: string) => {
    const { candidates } = await import("../drizzle/schema");
    await db.delete(candidates).where(eq(candidates.id, candidateId));
  };

  test("an answered call left without a review is flagged; resolved once reviewed", async () => {
    const { agentPolicies, callReviews } = await import("../drizzle/schema");
    await db
      .insert(agentPolicies)
      .values({ orgId, agentType: "screening_call", enabled: true })
      .onConflictDoNothing();
    const fresh = await endedCall(30);
    await evaluate();
    expect(await ruleOf("voice_guard.unreviewed")).toBeUndefined();
    const late = await endedCall(HEALTH.callReviewOverdueHours * 60 + 10);
    await evaluate();
    expect(await ruleOf("voice_guard.unreviewed")).toMatchObject({
      agentType: "voice_guard",
      severity: "warning",
      title: "1 answered AI phone call has no Voice Guard review yet",
    });
    await db.insert(callReviews).values({
      orgId,
      callId: late.callId,
      purpose: "screening",
      status: "done",
      reviewedAt: new Date(),
    });
    await evaluate();
    expect(await ruleOf("voice_guard.unreviewed")).toBeUndefined();
    await clear(fresh.candidateId);
    await clear(late.candidateId);
    await db
      .delete(agentPolicies)
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, "screening_call")));
  });

  test("repeated breaches on one phone agent's calls are flagged on that agent", async () => {
    const { callReviews } = await import("../drizzle/schema");
    const breach = {
      check: "read_back",
      severity: "high",
      summary: "Read the answer back.",
      evidence: [{ turn: 3, quote: "You run three clusters" }],
      source: "review",
    } as const;
    const made: string[] = [];
    for (let i = 0; i < HEALTH.callBreaches7d; i++) {
      const c = await endedCall(60);
      made.push(c.candidateId);
      await db.insert(callReviews).values({
        orgId,
        callId: c.callId,
        purpose: "screening",
        status: "done",
        verdict: i === 0 ? "pass" : "breach",
        findings: i === 0 ? [] : [breach],
        breaches: i === 0 ? 0 : 1,
        reviewedAt: new Date(),
      });
    }
    await evaluate();
    expect(await ruleOf("voice_guard.breaches")).toBeUndefined();
    const c = await endedCall(60);
    made.push(c.candidateId);
    await db.insert(callReviews).values({
      orgId,
      callId: c.callId,
      purpose: "screening",
      status: "done",
      verdict: "breach",
      findings: [breach],
      breaches: 1,
      reviewedAt: new Date(),
    });
    await evaluate();
    const issue = await ruleOf("voice_guard.breaches");
    expect(issue).toMatchObject({
      agentType: "screening_call",
      severity: "warning",
      title: `${HEALTH.callBreaches7d} of ${HEALTH.callBreaches7d + 1} reviewed screening calls in 7 days broke the call's rules`,
    });
    expect((issue!.detail as { top: string }).top).toBe("read_back (2)");
    for (const id of made) await clear(id);
    await evaluate();
    expect(await ruleOf("voice_guard.breaches")).toBeUndefined();
  });

  test("reading out a tool call, code or its reasoning is serious from the first call", async () => {
    const { WORKINGS_FINDING } = await import("../src/server/voice/guard/checks");
    const { callReviews } = await import("../drizzle/schema");
    await evaluate();
    expect(await ruleOf("voice_guard.read_out_workings")).toBeUndefined();
    const c = await endedCall(30);
    await db.insert(callReviews).values({
      orgId,
      callId: c.callId,
      purpose: "screening",
      status: "done",
      verdict: "breach",
      findings: [
        {
          check: "charter",
          severity: "critical",
          summary: WORKINGS_FINDING,
          evidence: [{ turn: 12, quote: "```json" }],
          source: "code",
        },
      ],
      breaches: 1,
      reviewedAt: new Date(),
    });
    await evaluate();
    expect(await ruleOf("voice_guard.read_out_workings")).toMatchObject({
      agentType: "screening_call",
      severity: "serious",
      title: "1 screening call read out a tool call, code or its reasoning to the candidate",
    });
    await clear(c.candidateId);
    await evaluate();
    expect(await ruleOf("voice_guard.read_out_workings")).toBeUndefined();
  });
});

describe("interview panels", () => {
  test("candidates waiting for a round nobody is eligible to interview are flagged", async () => {
    const {
      applications,
      candidates,
      memberInterviewerProfiles,
      orgMembers,
      requisitions,
      rolePanels,
    } = await import("../drizzle/schema");
    const [m] = await db
      .insert(orgMembers)
      .values({ orgId, userId, email: `health-${stamp}@test.local`, status: "active" } as never)
      .returning({ id: orgMembers.id });
    // The only registered interviewer takes L3 alone.
    await db
      .insert(memberInterviewerProfiles)
      .values({ orgId, memberId: m!.id, active: true, rounds: [3] });
    const [req] = await db
      .insert(requisitions)
      .values({ orgId, code: `H-P-${stamp}`, title: "Panel Test", status: "approved" } as never)
      .returning({ id: requisitions.id });
    const [cand] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Panel Wait", email: `pw-${stamp}@cand.local` } as never)
      .returning({ id: candidates.id });
    await db
      .insert(applications)
      .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: "l1" } as never);
    const rule = async () => (await open()).find((i) => i.rule === "interview.no_eligible_panel");
    await evaluate();
    expect(await rule()).toMatchObject({
      agentType: "interview",
      severity: "warning",
      title: `Nobody is eligible to interview for H-P-${stamp} L1`,
    });
    // A person settled the panel: no longer flagged.
    await db
      .insert(rolePanels)
      .values({ orgId, requisitionId: req!.id, level: 1, memberIds: [m!.id] });
    await evaluate();
    expect(await rule()).toBeUndefined();
    await db.delete(requisitions).where(eq(requisitions.id, req!.id));
    await db.delete(candidates).where(eq(candidates.id, cand!.id));
    await db.delete(orgMembers).where(eq(orgMembers.id, m!.id));
  });
});

describe("interviewers who can't make it", () => {
  test("a booked interview within a day with an interviewer who can't make it is critical", async () => {
    const { applications, candidates, interviews, requisitions } =
      await import("../drizzle/schema");
    const [req] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `H-U-${stamp}`,
        title: "Unavailable Test",
        status: "approved",
      } as never)
      .returning({ id: requisitions.id });
    const [cand] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Soon", email: `soon-${stamp}@cand.local` } as never)
      .returning({ id: candidates.id });
    const [app] = await db
      .insert(applications)
      .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: "l1" } as never)
      .returning({ id: applications.id });
    const [r] = await db
      .insert(interviews)
      .values({
        orgId,
        applicationId: app!.id,
        level: 1,
        interviewer: "Busy",
        interviewerEmail: "busy@x.test",
        scheduledAt: new Date(Date.now() + 5 * 3600_000),
        status: "scheduled",
        unavailable: [{ email: "busy@x.test", note: null, at: new Date().toISOString() }],
      } as never)
      .returning({ id: interviews.id });
    const rule = async () =>
      (await open()).find((i) => i.rule === "interview.unavailable_unresolved");
    await evaluate();
    expect(await rule()).toMatchObject({ agentType: "interview", severity: "critical" });
    // A stand-in took their place: resolved.
    await db
      .update(interviews)
      .set({ interviewer: "Stand-in", interviewerEmail: "standin@x.test" })
      .where(eq(interviews.id, r!.id));
    await evaluate();
    expect(await rule()).toBeUndefined();
    await db.delete(requisitions).where(eq(requisitions.id, req!.id));
    await db.delete(candidates).where(eq(candidates.id, cand!.id));
  });
});

describe("silent panel agent", () => {
  test("an interview call whose transcript never came is flagged; cleared once it is in", async () => {
    const { applications, candidates, interviews, requisitions } =
      await import("../drizzle/schema");
    const [req] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `H-T-${stamp}`,
        title: "Transcript Test",
        status: "approved",
      } as never)
      .returning({ id: requisitions.id });
    const [cand] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Heard", email: `heard-${stamp}@cand.local` } as never)
      .returning({ id: candidates.id });
    const [app] = await db
      .insert(applications)
      .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: "l1" } as never)
      .returning({ id: applications.id });
    const [r] = await db
      .insert(interviews)
      .values({
        orgId,
        applicationId: app!.id,
        level: 1,
        scheduledAt: new Date(Date.now() - 8 * 3600_000),
        status: "completed",
        transcription: "unavailable",
        transcriptionDetail: "No transcript arrived within 6 hours of the call's end.",
      } as never)
      .returning({ id: interviews.id });
    const rule = async () => (await open()).find((i) => i.rule === "panel.transcript_missing");
    await evaluate();
    expect(await rule()).toMatchObject({ agentType: "*", severity: "warning" });
    expect((await rule())!.detail).toMatchObject({ rounds: 1 });
    // The transcript was started by hand and came in after all: resolved.
    await db.update(interviews).set({ transcription: "ready" }).where(eq(interviews.id, r!.id));
    await evaluate();
    expect(await rule()).toBeUndefined();
    await db.delete(requisitions).where(eq(requisitions.id, req!.id));
    await db.delete(candidates).where(eq(candidates.id, cand!.id));
  });
});

describe("panel agents", () => {
  test("a transcript in for hours with no assessment is flagged, only while the level's agent is on", async () => {
    const {
      agentPolicies,
      applications,
      candidates,
      interviews,
      interviewTranscripts,
      panelAssessments,
      requisitions,
    } = await import("../drizzle/schema");
    const [req] = await db
      .insert(requisitions)
      .values({ orgId, code: `H-PA-${stamp}`, title: "Assess Test", status: "approved" } as never)
      .returning({ id: requisitions.id });
    const [cand] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Unread", email: `unread-${stamp}@cand.local` } as never)
      .returning({ id: candidates.id });
    const [app] = await db
      .insert(applications)
      .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: "l2" } as never)
      .returning({ id: applications.id });
    const [r] = await db
      .insert(interviews)
      .values({
        orgId,
        applicationId: app!.id,
        level: 2,
        scheduledAt: new Date(Date.now() - 5 * 3600_000),
        status: "completed",
        transcription: "ready",
      } as never)
      .returning({ id: interviews.id });
    await db.insert(interviewTranscripts).values({
      orgId,
      interviewId: r!.id,
      applicationId: app!.id,
      provider: "zoom",
      segments: [],
      fetchedAt: new Date(Date.now() - 3 * 3600_000),
    });
    const rule = async () => (await open()).find((i) => i.rule === "panel.assessment_missing");
    // The L2 panel agent is off: nobody was meant to read it.
    await evaluate();
    expect(await rule()).toBeUndefined();
    await db.insert(agentPolicies).values({ orgId, agentType: "panel_l2", enabled: true } as never);
    await evaluate();
    expect(await rule()).toMatchObject({ agentType: "panel_l2", severity: "warning" });
    // Assessed: resolved.
    await db.insert(panelAssessments).values({
      orgId,
      interviewId: r!.id,
      applicationId: app!.id,
      level: 2,
      assessedAt: new Date(),
    });
    await evaluate();
    expect(await rule()).toBeUndefined();
    await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
    await db.delete(requisitions).where(eq(requisitions.id, req!.id));
    await db.delete(candidates).where(eq(candidates.id, cand!.id));
  });
});

describe("panel reviews", () => {
  test("a review left open two days is flagged; serious while the candidate is held", async () => {
    const { applications, candidates, interviews, panelAssessments, requisitions } =
      await import("../drizzle/schema");
    const [req] = await db
      .insert(requisitions)
      .values({ orgId, code: `H-PR-${stamp}`, title: "Review Test", status: "approved" } as never)
      .returning({ id: requisitions.id });
    const [cand] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Waiting", email: `waiting-${stamp}@cand.local` } as never)
      .returning({ id: candidates.id });
    const [app] = await db
      .insert(applications)
      .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: "l1" } as never)
      .returning({ id: applications.id });
    const [r] = await db
      .insert(interviews)
      .values({ orgId, applicationId: app!.id, level: 1, status: "completed" } as never)
      .returning({ id: interviews.id });
    const [a] = await db
      .insert(panelAssessments)
      .values({
        orgId,
        interviewId: r!.id,
        applicationId: app!.id,
        level: 1,
        outcome: "disagree",
        held: true,
        reconciledAt: new Date(Date.now() - 50 * 3600_000),
      })
      .returning({ id: panelAssessments.id });
    const rule = async () => (await open()).find((i) => i.rule === "panel.review_unresolved");
    await evaluate();
    expect(await rule()).toMatchObject({ agentType: "panel_l1", severity: "serious" });
    await db
      .update(panelAssessments)
      .set({ reviewDecision: "go_with_panel", reviewedAt: new Date() })
      .where(eq(panelAssessments.id, a!.id));
    await evaluate();
    expect(await rule()).toBeUndefined();
    await db.delete(requisitions).where(eq(requisitions.id, req!.id));
    await db.delete(candidates).where(eq(candidates.id, cand!.id));
  });
});

describe("organisation context rules", () => {
  const days = (n: number) => new Date(Date.now() - n * 864e5);

  async function approvedProfile(values: Record<string, unknown> = {}) {
    const { orgProfileVersions, orgProfiles } = await import("../drizzle/schema");
    const [v] = await db
      .insert(orgProfileVersions)
      .values({
        orgId,
        version: 1,
        status: "approved",
        sections: {
          about: [
            {
              id: "a1",
              text: "We build hiring software.",
              visibility: "candidate",
              source: { kind: "person" },
            },
          ],
        },
        decidedAt: days(10),
        ...values,
      } as never)
      .returning({ id: orgProfileVersions.id });
    await db
      .insert(orgProfiles)
      .values({ orgId, currentVersionId: v!.id })
      .onConflictDoUpdate({
        target: orgProfiles.orgId,
        set: { currentVersionId: v!.id },
      });
    return v!.id;
  }

  afterEach(async () => {
    const { orgProfiles, orgProfileVersions, orgContextSources, agentPolicies, requisitions } =
      await import("../drizzle/schema");
    await db.delete(orgProfiles).where(eq(orgProfiles.orgId, orgId));
    await db.delete(orgProfileVersions).where(eq(orgProfileVersions.orgId, orgId));
    await db.delete(orgContextSources).where(eq(orgContextSources.orgId, orgId));
    await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
    await db.delete(requisitions).where(eq(requisitions.orgId, orgId));
  });

  test("no approved profile: warning while agents are on, serious once a role was raised", async () => {
    const { agentPolicies, requisitions } = await import("../drizzle/schema");
    // Other blocks' fixtures must not read as "roles raised without a profile".
    await db.delete(requisitions).where(eq(requisitions.orgId, orgId));
    await evaluate();
    expect((await open()).filter((i) => i.rule === "context.profile_missing")).toHaveLength(0);
    await db.insert(agentPolicies).values({ orgId, agentType: "jd", enabled: true });
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.profile_missing")).toMatchObject({
      agentType: "org_context",
      element: "context",
      severity: "warning",
    });
    await db.insert(requisitions).values({
      orgId,
      code: `REQ-CTX-${Math.random().toString(36).slice(2, 7)}`,
      title: "Engineer",
      status: "draft",
    } as never);
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.profile_missing")).toMatchObject({
      severity: "serious",
    });
  });

  test("an approved profile older than 180 days is stale; documents after it are named", async () => {
    const { orgContextSources } = await import("../drizzle/schema");
    await approvedProfile({ decidedAt: days(HEALTH.profileStaleDays + 5) });
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.profile_stale")).toMatchObject({
      agentType: "org_context",
      severity: "warning",
    });
    await db.insert(orgContextSources).values({
      orgId,
      kind: "document",
      fileName: "handbook.pdf",
      sha256: "x".repeat(64),
      text: "handbook",
      createdAt: days(2),
    });
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.profile_stale")).toMatchObject({
      title: expect.stringContaining("document"),
    });
  });

  test("pay conventions: a proposal left waiting, and a role paying in a currency its zone does not", async () => {
    const { payConventionDrafts, payZones, requisitions } = await import("../drizzle/schema");
    const old = new Date(Date.now() - (HEALTH.payConventionsWaitDays + 1) * 86_400_000);
    await db.insert(payConventionDrafts).values({
      orgId,
      conventions: { reportingCurrency: "USD" } as never,
      summary: "Reporting currency: INR → USD",
      createdAt: old,
    });
    const [zone] = await db
      .insert(payZones)
      .values({ orgId, name: "Milan", countries: ["IT"], currency: "EUR" })
      .returning({ id: payZones.id });
    const code = `REQ-PAY-${Math.random().toString(36).slice(2, 7)}`;
    await db.insert(requisitions).values({
      orgId,
      code,
      title: "Engineer",
      status: "pending_hr",
      payCurrency: "INR",
      payZoneId: zone!.id,
    } as never);
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.pay_conventions_waiting")).toMatchObject({
      agentType: "org_context",
      severity: "warning",
    });
    expect((await open()).find((i) => i.rule === "context.pay_currency_mismatch")).toMatchObject({
      agentType: "requisition",
      severity: "serious",
      title: expect.stringContaining(`${code} pays in INR`),
    });
    // Paying by the candidate's location is not a mismatch; a decided proposal is not waiting.
    await db.update(requisitions).set({ paysByLocation: true }).where(eq(requisitions.code, code));
    await db
      .update(payConventionDrafts)
      .set({ status: "approved" })
      .where(eq(payConventionDrafts.orgId, orgId));
    await evaluate();
    const after = await open();
    expect(after.find((i) => i.rule === "context.pay_currency_mismatch")).toBeUndefined();
    expect(after.find((i) => i.rule === "context.pay_conventions_waiting")).toBeUndefined();
  });

  test("pay recorded in a currency with no current rate is flagged", async () => {
    const { applications, candidates, payFigures, requisitions } =
      await import("../drizzle/schema");
    const [req] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-NR-${Math.random().toString(36).slice(2, 7)}`,
        title: "Engineer",
        status: "approved",
        payCurrency: "EUR",
      } as never)
      .returning({ id: requisitions.id });
    const [cand] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Ana", email: `ana-${stamp}@cand.local` } as never)
      .returning({ id: candidates.id });
    const [app] = await db
      .insert(applications)
      .values({
        orgId,
        requisitionId: req!.id,
        candidateId: cand!.id,
        stage: "shortlisted",
      } as never)
      .returning({ id: applications.id });
    await db.insert(payFigures).values({
      orgId,
      ownerType: "application",
      ownerId: app!.id,
      figure: "expected",
      amount: "70000",
      currency: "USD",
      payBasis: "annual",
      source: "screening_call",
      refusal: "no_rate",
      candidateId: cand!.id,
    });
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.pay_not_comparable")).toMatchObject({
      agentType: "org_context",
      severity: "warning",
      title: expect.stringContaining("USD → EUR"),
    });
  });

  test("an Autonomous agent without a passed model safety check is flagged", async () => {
    const { agentPolicies, aiRedteamChecks, aiSettings } = await import("../drizzle/schema");
    await db.insert(agentPolicies).values({
      orgId,
      agentType: "intake",
      enabled: true,
      autonomy: "autonomous",
    });
    await evaluate();
    expect((await open()).find((i) => i.rule === "harness.autonomous_unverified")).toMatchObject({
      agentType: "intake",
      element: "harness",
      severity: "warning",
    });
    // A passed check for the model in use clears it.
    const [cfg] = await db
      .select({ provider: aiSettings.provider, model: aiSettings.model })
      .from(aiSettings)
      .where(eq(aiSettings.orgId, orgId));
    await db.insert(aiRedteamChecks).values({
      orgId,
      provider: cfg?.provider ?? "openai",
      model: cfg?.model ?? "gpt-5.5",
      passed: true,
      results: [],
    });
    await evaluate();
    expect((await open()).filter((i) => i.rule === "harness.autonomous_unverified")).toHaveLength(
      0,
    );
    await db.delete(aiRedteamChecks).where(eq(aiRedteamChecks.orgId, orgId));
  });

  test("CV scores that jump after a profile approval are flagged; serious when self-approved", async () => {
    const { applications, candidates, matchScores, requisitions, auditLog } =
      await import("../drizzle/schema");
    const versionId = await approvedProfile({ decidedAt: days(10) });
    const [q] = await db
      .insert(requisitions)
      .values({ orgId, code: `REQ-D-${stamp}`, title: "Analyst", status: "approved" } as never)
      .returning({ id: requisitions.id });
    const n = HEALTH.scoreDriftMinSamples;
    const score = async (i: number, overallScore: number, computedAt: Date) => {
      const [c] = await db
        .insert(candidates)
        .values({ orgId, fullName: `D${i}`, email: `drift-${stamp}-${i}@x.local` })
        .returning({ id: candidates.id });
      const [a] = await db
        .insert(applications)
        .values({ orgId, requisitionId: q!.id, candidateId: c!.id, stage: "ai_screened" })
        .returning({ id: applications.id });
      await db
        .insert(matchScores)
        .values({ orgId, applicationId: a!.id, overallScore, computedAt });
    };
    for (let i = 0; i < n; i++) await score(i, 50, days(15)); // before the approval
    for (let i = n; i < 2 * n; i++) await score(i, 55, days(5)); // after: +5, under the threshold
    await evaluate();
    expect((await open()).filter((i) => i.rule === "context.score_drift")).toHaveLength(0);

    await db
      .update(matchScores)
      .set({ overallScore: 50 + HEALTH.scoreDriftPoints + 4 })
      .where(and(eq(matchScores.orgId, orgId), eq(matchScores.overallScore, 55)));
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.score_drift")).toMatchObject({
      agentType: "org_context",
      element: "context",
      severity: "warning",
      title: expect.stringContaining("rose 14 points"),
    });

    await db.insert(auditLog).values({
      orgId,
      actor: "user:x",
      action: "org_profile.approved",
      entityType: "org_profile_version",
      entityId: versionId,
      detail: { selfApproved: true },
    } as never);
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.score_drift")).toMatchObject({
      severity: "serious",
    });
    await db.delete(requisitions).where(eq(requisitions.id, q!.id));
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.entityId, versionId)));
  });

  test("a failed website re-read escalates after two failures in a row", async () => {
    const { orgProfiles } = await import("../drizzle/schema");
    await approvedProfile();
    await db
      .insert(orgProfiles)
      .values({ orgId, lastRereadStatus: "failed", rereadFailures: 1 })
      .onConflictDoUpdate({
        target: orgProfiles.orgId,
        set: { lastRereadStatus: "failed", rereadFailures: 1 },
      });
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.reread_failed")).toMatchObject({
      severity: "warning",
    });
    await db
      .update(orgProfiles)
      .set({ rereadFailures: HEALTH.rereadSeriousFailures })
      .where(eq(orgProfiles.orgId, orgId));
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.reread_failed")).toMatchObject({
      severity: "serious",
    });
  });

  test("a submitted version waiting past 7 days is flagged", async () => {
    const { orgProfileVersions } = await import("../drizzle/schema");
    await db.insert(orgProfileVersions).values({
      orgId,
      version: 2,
      status: "pending",
      sections: {
        about: [
          { id: "a2", text: "About us", visibility: "candidate", source: { kind: "person" } },
        ],
      },
      submittedAt: days(HEALTH.reviewWaitingDays + 2),
    } as never);
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.review_waiting")).toMatchObject({
      agentType: "org_context",
      title: expect.stringContaining("waited"),
    });
  });

  test("more than five refused items in 7 days is flagged", async () => {
    const refused = Array.from({ length: HEALTH.refusedItems7d + 1 }, (_, i) => ({
      section: "about",
      reason: `r${i}`,
    }));
    await db.insert(auditLog).values({
      orgId,
      actor: "user:x",
      action: "org_profile.items_refused",
      entityType: "org_context_source",
      detail: { refused },
    });
    await evaluate();
    expect((await open()).find((i) => i.rule === "context.items_refused")).toMatchObject({
      agentType: "org_context",
      title: expect.stringContaining("refused"),
    });
  });
});

describe("AI pay calls (negotiation_call)", () => {
  test("a broken call, an unconfirmed yes and too few yeses are flagged; amounts never in the issue", async () => {
    const { applications, candidates, requisitions, offerNegotiations, screeningCalls } =
      await import("../drizzle/schema");
    const L = 100_000;
    const [q] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-NC-${stamp}`,
        title: "SRE",
        status: "approved",
        ctcBandMax: String(21 * L),
      } as never)
      .returning({ id: requisitions.id });
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Meera", email: `meera-nc-${stamp}@x.local` })
      .returning({ id: candidates.id });
    const [a] = await db
      .insert(applications)
      .values({ orgId, requisitionId: q!.id, candidateId: c!.id, stage: "l3" })
      .returning({ id: applications.id });
    const [n] = await db
      .insert(offerNegotiations)
      .values({
        orgId,
        applicationId: a!.id,
        candidateId: c!.id,
        status: "message_sent",
        ceiling: String(20 * L),
        ceilingApprovedBy: "hr_head",
        proposedCtc: String(18 * L),
        callStepCtc: String(19.5 * L),
        levers: { joiningBonus: L },
      })
      .returning({ id: offerNegotiations.id });
    const ruleOf = async (rule: string) => (await open()).find((i) => i.rule === rule);
    const turn = (who: "ai" | "caller", text: string) => ({
      who,
      text,
      at: new Date().toISOString(),
    });
    const good = [
      turn("caller", "Hello?"),
      turn("ai", "Hello, this is Saranya, an AI recruiting assistant — am I speaking with Meera?"),
      turn("caller", "Yes."),
      turn(
        "ai",
        "Thank you. I make notes of this call for the hiring team. Do you have a few minutes?",
      ),
      turn("caller", "Sure."),
      turn(
        "ai",
        "The hiring team would like to offer you 18 lakh rupees a year. Along with that, the offer includes a one-time joining bonus of 1 lakh rupees. Would that work for you?",
      ),
      turn("caller", "I was hoping for 22."),
      turn(
        "ai",
        "Having heard you, the hiring team can offer 19 lakh 50 thousand rupees a year. Would that work for you?",
      ),
      turn("caller", "Yes, that works."),
    ];
    const call = (o: { transcript?: unknown[]; endReason?: string } = {}) =>
      db
        .insert(screeningCalls)
        .values({
          orgId,
          candidateId: c!.id,
          applicationId: a!.id,
          purpose: "negotiation",
          negotiationId: n!.id,
          status: "completed",
          consentAt: new Date(),
          endReason: o.endReason ?? "handed_off",
          transcript: (o.transcript ?? good) as never,
        })
        .returning({ id: screeningCalls.id });

    // A call that kept its rules is not flagged.
    await call({ endReason: "verbal_agreement" });
    await evaluate();
    expect(await ruleOf("negotiation_call.leak_suspected")).toBeUndefined();

    // One that spoke the ceiling is critical; the issue names kinds, never amounts.
    await call({
      transcript: [
        ...good.slice(0, 6),
        turn("ai", "Between us, the ceiling for this role is 20 lakh rupees a year."),
      ],
    });
    await evaluate();
    const leak = await ruleOf("negotiation_call.leak_suspected");
    expect(leak).toMatchObject({ agentType: "negotiation_call", severity: "critical" });
    expect(JSON.stringify(leak)).not.toMatch(/2000000|20 lakh/);
    expect((leak!.detail as { kinds: string[] }).kinds).toContain("ceiling_leak");

    // A yes heard on a call and left unconfirmed past the window.
    const heard = (hoursAgo: number) => ({
      callId: crypto.randomUUID(),
      agreed: true,
      which: "improved" as const,
      agreedCtc: 19.5 * L,
      theirWords: "Yes, that works.",
      at: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    });
    await db
      .update(offerNegotiations)
      .set({ callOutcome: heard(1) })
      .where(eq(offerNegotiations.id, n!.id));
    await evaluate();
    expect(await ruleOf("negotiation_call.unconfirmed_yes")).toBeUndefined();
    await db
      .update(offerNegotiations)
      .set({ callOutcome: heard(HEALTH.verbalConfirmHours + 1) })
      .where(eq(offerNegotiations.id, n!.id));
    await evaluate();
    expect(await ruleOf("negotiation_call.unconfirmed_yes")).toMatchObject({
      agentType: "negotiation_call",
      severity: "warning",
    });
    // Confirmed by a person: cleared.
    await db
      .update(offerNegotiations)
      .set({ status: "agreed" })
      .where(eq(offerNegotiations.id, n!.id));
    await evaluate();
    expect(await ruleOf("negotiation_call.unconfirmed_yes")).toBeUndefined();

    // Enough connected calls with too few yeses (1 yes so far, + 4 hand-offs = 1 of 6).
    for (let i = 0; i < HEALTH.minNegotiationCalls14d - 1; i++) await call();
    await evaluate();
    expect(await ruleOf("negotiation_call.few_agreements")).toMatchObject({
      agentType: "negotiation_call",
    });
    for (let i = 0; i < 2; i++) await call({ endReason: "verbal_agreement" });
    await evaluate();
    expect(await ruleOf("negotiation_call.few_agreements")).toBeUndefined();

    await db.delete(screeningCalls).where(eq(screeningCalls.negotiationId, n!.id));
    await db.delete(requisitions).where(eq(requisitions.id, q!.id));
  });
});
