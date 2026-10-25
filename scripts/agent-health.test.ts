/**
 * Agent health engine (src/server/agents/health.server.ts) against the
 * disposable local database: each rule opens an issue when its condition
 * holds, escalates, re-sees without duplicating, and resolves when it clears;
 * the scheduler heartbeat reports a stopped scheduler.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
});
