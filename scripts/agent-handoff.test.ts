/**
 * Agent-to-agent handoff (docs/agent-handoff-testing.md): every edge where one
 * agent's work — or the person's decision on it — starts the next agent, run
 * against the disposable local database with the real orchestrator, lifecycle
 * cores, sweeps and hiring desk. No model is called: each handoff is checked
 * at the moment the next run is created (its agent, subject, principal,
 * trigger event and the data carried in its goal), which is the whole data
 * contract between agents. Each agent's own tools are covered by the phase
 * tests and evals.
 *
 * Then every dispatched agent is switched off in turn: the event must still be
 * consumed, nothing starts, the hiring desk says what to do by hand — and the
 * lifecycle still completes with every agent off (the L2 panel agent case in
 * particular).
 *
 * Run: DATABASE_URL=postgres://…/atsagent_handoff_test bun test scripts/agent-handoff.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  agentPolicies,
  agentRuns,
  applications,
  candidates,
  hiringConversations,
  hiringMessages,
  interviews,
  jobDescriptions,
  offers,
  orgMembers,
  organizations,
  panelAssessments,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
await import("../src/server/agents/index"); // registers every agent and tool
const { listAgents, getTool } = await import("../src/server/agents/registry");
const { processAgentEvents, scheduleSweeps } =
  await import("../src/server/agents/orchestrator.server");
const { emitAgentEvent } = await import("../src/server/agents/events");
const { startRun } = await import("../src/server/agents/runtime.server");
const { moveStageCore } = await import("../src/lib/pipeline.server");
const { scheduleInterviewCore, submitScorecardCore } =
  await import("../src/lib/interviews.functions");
const { startExpertInterview } = await import("../src/server/desk/desk.server");
const { checkScreeningCall } = await import("../src/server/voice/request.server");
const { checkSchedulingCall } = await import("../src/server/voice/scheduling-request.server");
const { checkNegotiationCall } = await import("../src/server/voice/negotiation-request.server");

const stamp = Date.now();
const HR = `hr-${stamp}@test.local`;
const HM = `hm-${stamp}@test.local`;
let orgId: string;
let hrId: string;
let hmId: string;
let hmMemberId: string;
let reqId: string;
let convId: string;

/** Every agent the organisation can switch on (the Copilot agent, shown as Arjun, is the front door). */
const SPECIALISTS = [
  "requisition",
  "jd",
  "publishing",
  "intake",
  "sourcing",
  "distribution",
  "org_context",
  "labour_policy",
  "expert_interview",
  "screening",
  "screening_call",
  "followup",
  "interview",
  "scheduling_call",
  "panel_l1",
  "panel_l2",
  "panel_l3",
  "evaluation",
  "negotiation_call",
  "voice_guard",
  "offer",
  "onboarding",
] as const;

async function member(email: string, roles: string[], owner = false) {
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  const [m] = await db
    .insert(orgMembers)
    .values({
      orgId,
      userId: u!.id,
      email,
      fullName: email,
      status: "active",
      isOwner: owner,
    } as never)
    .returning({ id: orgMembers.id });
  for (const r of roles)
    await db.insert(userRoles).values({ userId: u!.id, orgId, role: r as never });
  return { userId: u!.id, memberId: m!.id };
}

async function setAgent(agentType: string, enabled: boolean) {
  await db
    .insert(agentPolicies)
    .values({ orgId, agentType, enabled, autonomy: "suggest" } as never)
    .onConflictDoUpdate({
      target: [agentPolicies.orgId, agentPolicies.agentType],
      set: { enabled },
    });
}

async function application(stage: string, extra: Record<string, unknown> = {}) {
  const [c] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: `Cand ${Math.random().toString(36).slice(2, 7)}`,
      email: `c-${Math.random()}@cand.local`,
    } as never)
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage, ...extra } as never)
    .returning({ id: applications.id });
  return a!.id;
}

/** Runs started since `since`, oldest first. */
async function runsSince(since: Date) {
  return db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), gte(agentRuns.createdAt, since)))
    .orderBy(agentRuns.createdAt);
}

/** Close every open run so the next dispatch is not de-duplicated away. */
async function settleRuns() {
  await db
    .update(agentRuns)
    .set({ status: "cancelled" } as never)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        inArray(agentRuns.status, ["queued", "running", "awaiting_human"] as never),
      ),
    );
}

/** Emit an event, let the orchestrator drain it, return what it started. */
async function handoff(e: Parameters<typeof emitAgentEvent>[0]) {
  await settleRuns();
  await emitAgentEvent(e);
  const counts = await processAgentEvents({ orgId });
  const [ev] = await db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, e.type)))
    .orderBy(sql`${agentEvents.createdAt} desc`)
    .limit(1);
  // Exactly the runs this event started.
  const runs = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.triggerEventId, ev!.id)));
  return { runs, counts, event: ev! };
}

/** The handoff ledger the testing document's tables are checked against. */
const ledger: {
  edge: string;
  from: string;
  event: string;
  to: string;
  subject: string;
  carried: string;
}[] = [];

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [o] = await db
    .insert(organizations)
    .values({ name: "Handoff Org", slug: `handoff-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  hrId = (await member(HR, ["hr_head"], true)).userId;
  const hm = await member(HM, ["hiring_manager"]);
  hmId = hm.userId;
  hmMemberId = hm.memberId;
  const [req] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `HO-${stamp}`,
      title: "Backend Engineer",
      status: "approved",
      mustHaveSkills: ["Go", "Postgres"],
      createdBy: hrId,
      hiringManagerMemberId: hmMemberId,
    } as never)
    .returning({ id: requisitions.id });
  reqId = req!.id;
  const [conv] = await db
    .insert(hiringConversations)
    .values({ orgId, createdBy: hrId, title: "Backend Engineer", requisitionId: reqId } as never)
    .returning({ id: hiringConversations.id });
  convId = conv!.id;
  for (const a of SPECIALISTS) await setAgent(a, true);
  await setAgent("copilot", true);
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const id of [hrId, hmId]) await db.delete(users).where(eq(users.id, id));
  if (process.env.HANDOFF_LEDGER)
    await Bun.write(process.env.HANDOFF_LEDGER, JSON.stringify(ledger, null, 2));
});

describe("registry", () => {
  test("23 agents are registered: Arjun (the Copilot agent) and the 22 specialists", () => {
    const types = listAgents()
      .map((a) => a.type)
      .sort();
    expect(types).toEqual(["copilot", ...SPECIALISTS].sort());
  });
});

/* ------------------------------------------------- A. event → agent edges */

describe("A. orchestrator handoffs (every agent on)", () => {
  /** Expect exactly one run of `agent`, carrying the strings in `carries`. */
  const expectRun = (
    out: Awaited<ReturnType<typeof handoff>>,
    agent: string,
    subject: { type: string; id: string },
    carries: string[],
    meta: { edge: string; from: string },
  ) => {
    const mine = out.runs.filter((r) => r.agentType === agent);
    expect(mine).toHaveLength(1);
    const r = mine[0]!;
    expect(r.subjectType).toBe(subject.type);
    expect(r.subjectId).toBe(subject.id);
    expect(r.principalUserId).toBe(hrId); // the requisition's raiser
    expect(r.triggerEventId).toBe(out.event.id);
    expect(r.status).toBe("queued");
    expect(r.goal).toContain(`Requisition id: ${reqId}`);
    for (const c of carries) expect(r.goal).toContain(c);
    expect(out.event.status).toBe("done");
    ledger.push({
      edge: meta.edge,
      from: meta.from,
      event: out.event.type,
      to: agent,
      subject: subject.type,
      carried: carries.join(" | "),
    });
  };
  const R = () => ({ type: "requisition", id: reqId });
  const A = (id: string) => ({ type: "application", id });

  test("H1 requisition approved (no JD yet) → JD agent", async () => {
    const out = await handoff({
      orgId,
      type: "requisition.status_changed",
      subjectType: "requisition",
      subjectId: reqId,
      actorUserId: hrId,
      payload: { from: "pending_cbo", to: "approved" },
    });
    expectRun(out, "jd", R(), [`HO-${stamp}`, "Backend Engineer", "is approved"], {
      edge: "H1",
      from: "requisition (CBO approval)",
    });
  });

  test("H2 department head asks for JD changes → JD agent revises (comment carried)", async () => {
    const out = await handoff({
      orgId,
      type: "jd.changes_requested",
      subjectType: "requisition",
      subjectId: reqId,
      actorUserId: hmId,
      payload: { comment: "Add on-call expectations" },
    });
    expectRun(out, "jd", R(), ["Add on-call expectations", "Revise it and resubmit"], {
      edge: "H2",
      from: "jd (DH send-back)",
    });
  });

  test("H3 JD approved on an approved role → Publishing and Distribution agents", async () => {
    await db.insert(jobDescriptions).values({
      orgId,
      requisitionId: reqId,
      version: 1,
      status: "approved",
    } as never);
    const out = await handoff({
      orgId,
      type: "jd.approved",
      subjectType: "requisition",
      subjectId: reqId,
      actorUserId: hmId,
    });
    expectRun(out, "publishing", R(), ["Publish it internally"], {
      edge: "H3a",
      from: "jd (DH approval)",
    });
    expectRun(out, "distribution", R(), ["job portals"], {
      edge: "H3b",
      from: "jd (DH approval)",
    });
    // The hiring desk thread on the role also asks Intake & matching to rank the pool.
    const [intake] = await db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.agentType, "intake"),
          eq(agentRuns.conversationId, convId),
        ),
      );
    expect(intake?.subjectId).toBe(reqId);
    expect(intake?.goal).toContain(`HO-${stamp}`);
    ledger.push({
      edge: "H3c",
      from: "jd (DH approval, hiring desk thread)",
      event: "jd.approved → desk.onJdApproved",
      to: "intake",
      subject: "requisition",
      carried: "requisition code + title, thread",
    });
  });

  test("H4 candidates shortlisted (Intake or a person) → Screening agent", async () => {
    const a = await application("shortlisted");
    const out = await handoff({
      orgId,
      type: "application.shortlisted",
      subjectType: "requisition",
      subjectId: reqId,
      actorUserId: hrId,
      payload: { applicationIds: [a] },
    });
    expectRun(out, "screening", R(), ["1 candidate(s) were shortlisted"], {
      edge: "H4",
      from: "intake",
    });
  });

  test("H5 written assessment completed → Screening agent (score carried)", async () => {
    const a = await application("shortlisted");
    const out = await handoff({
      orgId,
      type: "assessment.completed",
      subjectType: "application",
      subjectId: a,
      actorUserId: null,
      payload: { score: 78 },
    });
    expectRun(out, "screening", A(a), [a, "(78/100)", "screening_decision"], {
      edge: "H5",
      from: "screening (assessment sent)",
    });
  });

  test("H6 AI screening call ended → Screening agent grades and recommends", async () => {
    const a = await application("shortlisted");
    const out = await handoff({
      orgId,
      type: "screening_call.ended",
      subjectType: "application",
      subjectId: a,
      actorUserId: null,
      payload: { status: "completed", endReason: "done" },
    });
    expectRun(out, "screening", A(a), [a, "took the AI screening call"], {
      edge: "H6",
      from: "screening_call",
    });
  });

  test("H7 candidate advanced to an interview round → Interview coordinator", async () => {
    const a = await application("l1");
    const out = await handoff({
      orgId,
      type: "application.advanced",
      subjectType: "requisition",
      subjectId: reqId,
      actorUserId: hrId,
      payload: { applicationIds: [a] },
    });
    expectRun(out, "interview", A(a), ["advanced to an interview round"], {
      edge: "H7",
      from: "screening (person decides proceed)",
    });
  });

  const interviewEdges = [
    {
      edge: "H8",
      type: "interview.panellist_unavailable" as const,
      payload: { level: 2, memberId: "m-1", name: "Priya", when: "Tue 10:00" },
      carries: ["Priya", "memberId m-1", "booked L2", "propose_substitute"],
      from: "interview (panellist declined)",
    },
    {
      edge: "H9",
      type: "interview.missed" as const,
      payload: { level: 2, outcome: "candidate_no_show" },
      carries: ["L2 interview", "candidate no show", "Offer new times"],
      from: "interview (no-show)",
    },
    {
      edge: "H10",
      type: "interview.slots_unanswered" as const,
      payload: { level: 2, why: "none_work", note: "Only evenings" },
      carries: ["L2", "none of them work", "Only evenings", "request_scheduling_call"],
      from: "interview (times declined)",
    },
    {
      edge: "H11",
      type: "interview.slots_no_reply" as const,
      payload: { level: 2 },
      carries: ["L2", "request_scheduling_call"],
      from: "interview (no reply)",
    },
  ];
  for (const x of interviewEdges)
    test(`${x.edge} ${x.type} → Interview coordinator`, async () => {
      const a = await application("l2");
      const out = await handoff({
        orgId,
        type: x.type,
        subjectType: "application",
        subjectId: a,
        actorUserId: null,
        payload: x.payload,
      });
      expectRun(out, "interview", A(a), [a, ...x.carries], { edge: x.edge, from: x.from });
    });

  for (const level of [1, 2, 3])
    test(`H12.${level} L${level} transcript ready → L${level} panel agent`, async () => {
      const a = await application(`l${level}`);
      const iv = crypto.randomUUID();
      const out = await handoff({
        orgId,
        type: "interview.transcript_ready",
        subjectType: "application",
        subjectId: a,
        actorUserId: null,
        payload: { level, interviewId: iv },
      });
      expectRun(out, `panel_l${level}`, A(a), [iv, `L${level} interview round`], {
        edge: `H12.${level}`,
        from: "interview (call recorded)",
      });
      expect(out.runs.filter((r) => r.agentType.startsWith("panel_"))).toHaveLength(1);
    });

  test("H13 panel view disagrees → L2 panel agent asks the HR head", async () => {
    const a = await application("l2");
    const iv = crypto.randomUUID();
    const out = await handoff({
      orgId,
      type: "panel.review_due",
      subjectType: "application",
      subjectId: a,
      actorUserId: null,
      payload: { level: 2, interviewId: iv, outcome: "disagree" },
    });
    expectRun(out, "panel_l2", A(a), [iv, "disagrees with", "request_panel_review"], {
      edge: "H13",
      from: "panel_l2 (after panel scored)",
    });
  });

  test("H14 final-round scorecard → Evaluation agent asks for the hiring decision", async () => {
    const a = await application("l3");
    const out = await handoff({
      orgId,
      type: "scorecard.submitted",
      subjectType: "requisition",
      subjectId: reqId,
      actorUserId: hmId,
      payload: { applicationId: a, level: 3, verdict: "select", finalRound: true },
    });
    expectRun(out, "evaluation", A(a), [a, "L3", "select", "ask the hiring manager"], {
      edge: "H14",
      from: "panel (people scored)",
    });
  });

  test("H14b a held L2 round → Evaluation agent writes the debrief only", async () => {
    const a = await application("l2");
    const out = await handoff({
      orgId,
      type: "scorecard.submitted",
      subjectType: "requisition",
      subjectId: reqId,
      actorUserId: hmId,
      payload: {
        applicationId: a,
        level: 2,
        verdict: "select",
        finalRound: false,
        heldForPanelReview: true,
      },
    });
    expectRun(out, "evaluation", A(a), ["on hold", "do not request a hiring decision"], {
      edge: "H14b",
      from: "panel_l2 (disagreement hold)",
    });
  });

  let selected: string;
  test("H15 hiring manager selects → Offer agent", async () => {
    selected = await application("offer_pending");
    const out = await handoff({
      orgId,
      type: "hiring.selected",
      subjectType: "application",
      subjectId: selected,
      actorUserId: hmId,
    });
    expectRun(out, "offer", A(selected), [selected, "within the approved band"], {
      edge: "H15",
      from: "evaluation (HM decision)",
    });
  });

  test("H16 candidate shares expected pay → Offer agent continues", async () => {
    const out = await handoff({
      orgId,
      type: "compensation.submitted",
      subjectType: "application",
      subjectId: selected,
      actorUserId: null,
    });
    expectRun(out, "offer", A(selected), ["expected CTC and notice period"], {
      edge: "H16",
      from: "offer / screening (pay form)",
    });
  });

  test("H17 negotiation needs a call → Offer agent may ask for the pay call", async () => {
    const neg = crypto.randomUUID();
    const out = await handoff({
      orgId,
      type: "negotiation.needs_call",
      subjectType: "application",
      subjectId: selected,
      actorUserId: null,
      payload: { negotiationId: neg, why: "countered" },
    });
    expectRun(out, "offer", A(selected), [neg, "replied to the pay message with another figure"], {
      edge: "H17",
      from: "offer (pay message)",
    });
  });

  test("H18 a figure is agreed (message or pay call) → Offer agent drafts at it", async () => {
    const out = await handoff({
      orgId,
      type: "negotiation.agreed",
      subjectType: "application",
      subjectId: selected,
      actorUserId: null,
    });
    expectRun(out, "offer", A(selected), ["agreed figure", "HR head and CBO approval"], {
      edge: "H18",
      from: "negotiation_call",
    });
  });

  test("H19 approver sends the offer back → Offer agent revises (reason carried)", async () => {
    const out = await handoff({
      orgId,
      type: "offer.status_changed",
      subjectType: "offer",
      subjectId: crypto.randomUUID(),
      actorUserId: hrId,
      payload: {
        applicationId: selected,
        requisitionId: reqId,
        from: "pending_hr",
        to: "draft",
        sentBack: true,
        comment: "Keep joining bonus under 1L",
      },
    });
    expectRun(out, "offer", A(selected), ["Keep joining bonus under 1L"], {
      edge: "H19",
      from: "offer (HR/CBO send-back)",
    });
  });

  test("H20 candidate asks for changes → Offer agent proposes a revision", async () => {
    const out = await handoff({
      orgId,
      type: "offer.status_changed",
      subjectType: "offer",
      subjectId: crypto.randomUUID(),
      actorUserId: null,
      payload: { applicationId: selected, requisitionId: reqId, from: "released", to: "countered" },
    });
    expectRun(out, "offer", A(selected), ["asked for changes"], {
      edge: "H20",
      from: "offer (candidate counter)",
    });
  });

  test("H21 offer approved → Pre-onboarding & release agent", async () => {
    await db.insert(offers).values({
      orgId,
      applicationId: selected,
      status: "approved",
      offeredCtc: "2400000",
    } as never);
    const out = await handoff({
      orgId,
      type: "offer.status_changed",
      subjectType: "offer",
      subjectId: crypto.randomUUID(),
      actorUserId: hrId,
      payload: {
        applicationId: selected,
        requisitionId: reqId,
        from: "pending_cbo",
        to: "approved",
      },
    });
    expectRun(out, "onboarding", A(selected), ["is approved", "pre-onboarding documents"], {
      edge: "H21",
      from: "offer (CBO approval)",
    });
  });

  test("H22 a document arrives → Pre-onboarding agent checks readiness", async () => {
    const out = await handoff({
      orgId,
      type: "onboarding.document_received",
      subjectType: "application",
      subjectId: selected,
      actorUserId: null,
    });
    expectRun(out, "onboarding", A(selected), ["pre-onboarding document arrived"], {
      edge: "H22",
      from: "onboarding (candidate upload)",
    });
  });

  test("H23 HR rejects a document → Pre-onboarding agent asks again (reason carried)", async () => {
    const out = await handoff({
      orgId,
      type: "onboarding.document_rejected",
      subjectType: "application",
      subjectId: selected,
      actorUserId: hrId,
      payload: { docType: "relieving_letter", reason: "Unsigned copy" },
    });
    expectRun(out, "onboarding", A(selected), ["relieving letter", "Unsigned copy"], {
      edge: "H23",
      from: "onboarding (HR validation)",
    });
  });

  test("an inactive role starts nothing (closed / on hold)", async () => {
    await db
      .update(requisitions)
      .set({ status: "on_hold" } as never)
      .where(eq(requisitions.id, reqId));
    const a = await application("shortlisted");
    const out = await handoff({
      orgId,
      type: "assessment.completed",
      subjectType: "application",
      subjectId: a,
      actorUserId: null,
      payload: { score: 50 },
    });
    expect(out.runs).toHaveLength(0);
    expect(out.event.status).toBe("done");
    await db
      .update(requisitions)
      .set({ status: "approved" } as never)
      .where(eq(requisitions.id, reqId));
  });
});

/* -------------------------------- B. handoffs that are not orchestrator events */

describe("B. handoffs started by an agent, a person or the scheduler", () => {
  test("H0 Copilot → Requisition agent (start_agent after the person confirms)", async () => {
    await settleRuns();
    const { runId } = await startRun({
      orgId,
      agentType: "copilot",
      principalUserId: hrId,
      goal: "We need two backend engineers in Chennai.",
    });
    const tool = getTool("start_agent")!;
    const res = (await tool.run(
      {
        orgId,
        principalUserId: hrId,
        runId,
        agentType: "copilot",
        actor: `agent:copilot:${runId}`,
      },
      {
        agent: "requisition",
        goal: "Draft a requisition: 2 backend engineers, Chennai, hybrid.",
      } as never,
    )) as { started: string; runId: string };
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId));
    expect(r!.agentType).toBe("requisition");
    expect(r!.goal).toContain("2 backend engineers, Chennai, hybrid");
    expect(r!.principalUserId).toBe(hrId);
    ledger.push({
      edge: "H0",
      from: "copilot",
      event: "start_agent tool",
      to: "requisition",
      subject: "none (new role)",
      carried: "the person's request, verbatim details",
    });
  });

  test("H0b Copilot → JD agent needs a requisition id (and carries it)", async () => {
    await settleRuns();
    const { runId } = await startRun({
      orgId,
      agentType: "copilot",
      principalUserId: hrId,
      goal: "Revise the JD",
    });
    const ctx = { orgId, principalUserId: hrId, runId, agentType: "copilot" as const, actor: "x" };
    const tool = getTool("start_agent")!;
    await expect(
      tool.run(ctx, { agent: "jd", goal: "Revise the JD for the backend role" } as never),
    ).rejects.toThrow("requisitionId");
    const res = (await tool.run(ctx, {
      agent: "jd",
      goal: "Revise the JD for the backend role",
      requisitionId: reqId,
    } as never)) as { runId: string };
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId));
    expect(r!.subjectId).toBe(reqId);
    expect(r!.goal).toContain(`Requisition id: ${reqId}`);
  });

  test("H24 hiring desk → Role expert interview agent (to the role's hiring manager)", async () => {
    await settleRuns();
    const [conv] = await db
      .select()
      .from(hiringConversations)
      .where(eq(hiringConversations.id, convId));
    const runId = await startExpertInterview(conv as never, hrId);
    expect(runId).toBeTruthy();
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId!));
    expect(r!.agentType).toBe("expert_interview");
    expect(r!.subjectId).toBe(reqId);
    expect(r!.conversationId).toBe(convId);
    ledger.push({
      edge: "H24",
      from: "hiring desk (HR)",
      event: "startExpertInterview",
      to: "expert_interview",
      subject: "requisition",
      carried: "requisition code + title, thread",
    });
  });

  test("H25 scheduler: new applicants → Intake; starving role → Sourcing; daily → Follow-up and Distribution", async () => {
    await settleRuns();
    // The desk's intake run (H3c) would put the sweep on its 10-minute cooldown.
    await db.execute(sql`delete from agent_runs where org_id = ${orgId} and agent_type = 'intake'`);
    const since = new Date(Date.now() - 5);
    await application("applied", { source: "careers_page", appliedAt: new Date() });
    await scheduleSweeps({ orgId });
    const runs = await runsSince(since);
    // The role has an approved JD and almost no applicants: it is starving.
    const sourcing = runs.find((r) => r.agentType === "sourcing");
    expect(sourcing?.subjectId).toBe(reqId);
    expect(sourcing?.goal).toContain("needs more candidates");
    const intake = runs.find((r) => r.agentType === "intake");
    expect(intake?.subjectId).toBe(reqId);
    expect(intake?.goal).toContain("new application(s) arrived");
    expect(intake?.goal).toContain("careers_page");
    expect(runs.some((r) => r.agentType === "followup")).toBe(true);
    expect(runs.some((r) => r.agentType === "distribution" && r.subjectId === null)).toBe(true);
    ledger.push(
      {
        edge: "H25a",
        from: "scheduler (applications)",
        event: "sweep",
        to: "intake",
        subject: "requisition",
        carried: "count + source channels",
      },
      {
        edge: "H25b",
        from: "scheduler (daily)",
        event: "sweep",
        to: "followup",
        subject: "none",
        carried: "fixed goal",
      },
      {
        edge: "H25d",
        from: "scheduler (starving role)",
        event: "sweep",
        to: "sourcing",
        subject: "requisition",
        carried: "requisition code + title",
      },
      {
        edge: "H25c",
        from: "scheduler (daily)",
        event: "sweep",
        to: "distribution",
        subject: "none",
        carried: "fixed goal",
      },
    );
  });

  test("H26 voice agents are only reachable through a request their caller makes — refused (with a reason) while phone calls are off", async () => {
    const a = await application("shortlisted");
    const s = await checkScreeningCall(orgId, a);
    expect(s).toMatchObject({ ok: false });
    expect((s as { reason: string }).reason).toContain("switched off");
    const sc = await checkSchedulingCall(orgId, a);
    expect((sc as { reason: string }).reason).toContain("switched off");
    const n = await checkNegotiationCall(orgId, crypto.randomUUID());
    expect((n as { reason: string }).reason).toContain("switched off");
  });
});

/* -------------------------------------------- C. one agent switched off */

describe("C. any one agent switched off mid-process", () => {
  const cases: { agent: string; make: () => Promise<Parameters<typeof emitAgentEvent>[0]> }[] = [
    {
      agent: "jd",
      make: async () => ({
        orgId,
        type: "jd.changes_requested",
        subjectType: "requisition",
        subjectId: reqId,
        actorUserId: hmId,
        payload: { comment: "x" },
      }),
    },
    {
      agent: "screening",
      make: async () => ({
        orgId,
        type: "application.shortlisted",
        subjectType: "requisition",
        subjectId: reqId,
        actorUserId: hrId,
        payload: { applicationIds: [await application("shortlisted")] },
      }),
    },
    {
      agent: "interview",
      make: async () => ({
        orgId,
        type: "application.advanced",
        subjectType: "requisition",
        subjectId: reqId,
        actorUserId: hrId,
        payload: { applicationIds: [await application("l1")] },
      }),
    },
    ...[1, 2, 3].map((level) => ({
      agent: `panel_l${level}`,
      make: async () => ({
        orgId,
        type: "interview.transcript_ready" as const,
        subjectType: "application" as const,
        subjectId: await application(`l${level}`),
        actorUserId: null,
        payload: { level, interviewId: crypto.randomUUID() },
      }),
    })),
    {
      agent: "evaluation",
      make: async () => ({
        orgId,
        type: "scorecard.submitted",
        subjectType: "requisition",
        subjectId: reqId,
        actorUserId: hmId,
        payload: { applicationId: await application("l3"), level: 3, verdict: "select" },
      }),
    },
    {
      agent: "offer",
      make: async () => ({
        orgId,
        type: "hiring.selected",
        subjectType: "application",
        subjectId: await application("offer_pending"),
        actorUserId: hmId,
      }),
    },
    {
      agent: "onboarding",
      make: async () => {
        const a = await application("offer_pending");
        return {
          orgId,
          type: "offer.status_changed",
          subjectType: "offer",
          subjectId: crypto.randomUUID(),
          actorUserId: hrId,
          payload: { applicationId: a, requisitionId: reqId, from: "pending_cbo", to: "approved" },
        };
      },
    },
  ];

  for (const c of cases)
    test(`${c.agent} off: the event is consumed, nothing starts, the desk tells HR to do the step by hand`, async () => {
      await setAgent(c.agent, false);
      const out = await handoff(await c.make());
      expect(out.runs.filter((r) => r.agentType === c.agent)).toHaveLength(0);
      expect(out.event.status).toBe("done"); // never retried, never stuck
      expect(out.counts.failed).toBe(0);
      const msgs = await db
        .select({ body: hiringMessages.body })
        .from(hiringMessages)
        .where(
          and(eq(hiringMessages.conversationId, convId), eq(hiringMessages.agentType, c.agent)),
        );
      expect(msgs.some((m) => /switched off/.test(m.body) && /Manual mode/.test(m.body))).toBe(
        true,
      );
      await setAgent(c.agent, true);
    });

  test("Publishing off on JD approval: Distribution still starts; the desk says post it by hand", async () => {
    await setAgent("publishing", false);
    await db.execute(
      sql`update agent_runs set status = 'cancelled' where org_id = ${orgId} and agent_type = 'distribution'`,
    );
    await db.execute(
      sql`delete from agent_runs where org_id = ${orgId} and agent_type = 'distribution'`,
    );
    const out = await handoff({
      orgId,
      type: "jd.approved",
      subjectType: "requisition",
      subjectId: reqId,
      actorUserId: hmId,
    });
    expect(out.runs.map((r) => r.agentType)).toEqual(["distribution"]);
    const msgs = await db
      .select({ body: hiringMessages.body })
      .from(hiringMessages)
      .where(
        and(eq(hiringMessages.conversationId, convId), eq(hiringMessages.agentType, "publishing")),
      );
    expect(msgs.some((m) => m.body.includes("post it yourself in Manual mode"))).toBe(true);
    await setAgent("publishing", true);
  });

  test("Expert interview off: the desk says so instead of starting it", async () => {
    await setAgent("expert_interview", false);
    await settleRuns();
    const [conv] = await db
      .select()
      .from(hiringConversations)
      .where(eq(hiringConversations.id, convId));
    expect(await startExpertInterview(conv as never, hrId)).toBeNull();
    await setAgent("expert_interview", true);
  });

  test("Intake / Follow-up / Distribution off: the scheduler starts none of them", async () => {
    for (const a of ["intake", "followup", "distribution", "sourcing"]) await setAgent(a, false);
    await settleRuns();
    await db.execute(sql`delete from agent_runs where org_id = ${orgId}`);
    const since = new Date(Date.now() - 5);
    await application("applied", { source: "careers_page", appliedAt: new Date() });
    await scheduleSweeps({ orgId });
    const started = (await runsSince(since)).map((r) => r.agentType);
    for (const a of ["intake", "followup", "distribution", "sourcing"])
      expect(started).not.toContain(a);
    for (const a of ["intake", "followup", "distribution", "sourcing"]) await setAgent(a, true);
  });
});

/* ------------------------------- D. the L2 panel agent off, round by round */

describe("D. L2 panel agent off: the L2 round completes on the people's scorecards", () => {
  async function l2Round(view: { rating: number; verdict: "select" | "hold" | "reject" } | null) {
    const a = await application("l2");
    const [r] = await db
      .insert(interviews)
      .values({
        orgId,
        applicationId: a,
        level: 2,
        interviewer: "HM",
        interviewerEmail: HM,
        scheduledAt: new Date(Date.now() - 3600_000),
        status: "scheduled",
        transcription: "ready",
      } as never)
      .returning({ id: interviews.id });
    if (view)
      await db.insert(panelAssessments).values({
        orgId,
        interviewId: r!.id,
        applicationId: a,
        level: 2,
        rating: view.rating,
        verdict: view.verdict,
        assessedAt: new Date(),
      });
    return { applicationId: a, interviewId: r!.id };
  }
  const score = (x: { applicationId: string; interviewId: string }) =>
    submitScorecardCore(
      { orgId, userId: hmId, email: HM, actor: HM },
      {
        applicationId: x.applicationId,
        interviewId: x.interviewId,
        level: 2,
        rating: 5,
        verdict: "select",
        comments: null,
        competencies: [],
      },
    );

  test("off before the call: no panel run, no hidden view, the scorecard moves the candidate", async () => {
    await setAgent("panel_l2", false);
    const x = await l2Round(null);
    const out = await handoff({
      orgId,
      type: "interview.transcript_ready",
      subjectType: "application",
      subjectId: x.applicationId,
      actorUserId: null,
      payload: { level: 2, interviewId: x.interviewId },
    });
    expect(out.runs.filter((r) => r.agentType === "panel_l2")).toHaveLength(0);
    const res = await score(x);
    expect(res.blocked).toBeNull();
    expect(res.movedTo).not.toBeNull();
    expect(res.panelCheck).toBeUndefined();
  });

  test("off after it already formed a view that disagrees: recorded, but nothing is held", async () => {
    await setAgent("panel_l2", false);
    const x = await l2Round({ rating: 1, verdict: "reject" });
    const res = await score(x);
    expect(res.panelCheck).toBe("disagree");
    expect(res.blocked).toBeNull();
    expect(res.movedTo).not.toBeNull();
    const [pa] = await db
      .select()
      .from(panelAssessments)
      .where(eq(panelAssessments.interviewId, x.interviewId));
    expect(pa!.held).toBe(false);
  });

  test("on, for contrast: the same disagreement holds the move for the HR head", async () => {
    await setAgent("panel_l2", true);
    const x = await l2Round({ rating: 1, verdict: "reject" });
    const res = await score(x);
    expect(res.movedTo).toBeNull();
    expect(res.blocked).toContain("On hold for the HR head");
  });
});

/* ------------------------- E. every agent off: a person completes the hire */

describe("E. org-wide switch off: HR completes the pipeline by hand", () => {
  test("applied → shortlisted → L1 → L2 → L3 → offer: every event consumed, no agent run", async () => {
    await db
      .insert(agentPolicies)
      .values({ orgId, agentType: "*", enabled: false } as never)
      .onConflictDoUpdate({
        target: [agentPolicies.orgId, agentPolicies.agentType],
        set: { enabled: false },
      });
    await settleRuns();
    const since = new Date(Date.now() - 5);
    const hr = { orgId, userId: hrId, memberEmail: HR };
    const a = await application("applied");
    await moveStageCore(hr, { applicationId: a, toStage: "shortlisted" as never });
    await moveStageCore(hr, {
      applicationId: a,
      toStage: "l1" as never,
      reason: "Screened by phone by HR",
    });
    const moves: string[] = [];
    for (const level of [1, 2, 3]) {
      // The Interview coordinator is off: HR books the round on the Interviews page.
      const [open] = await db
        .select({ id: interviews.id })
        .from(interviews)
        .where(and(eq(interviews.applicationId, a), eq(interviews.level, level)))
        .limit(1);
      const booked = await scheduleInterviewCore(
        { orgId, actor: HR },
        {
          applicationId: a,
          level,
          interviewer: "HR head",
          interviewerEmail: HR,
          scheduledAt: new Date(Date.now() - 3600_000).toISOString(),
          durationMins: 60,
          mode: "phone",
          interviewId: open?.id ?? null,
          rescheduleReason: open ? "Booked by hand" : null,
        },
      );
      const interviewId =
        (booked as { interviewId?: string; id?: string }).interviewId ??
        (booked as { id?: string }).id ??
        (
          await db
            .select({ id: interviews.id })
            .from(interviews)
            .where(and(eq(interviews.applicationId, a), eq(interviews.level, level)))
            .limit(1)
        )[0]!.id;
      // The panel agent of this level is off too: the people's scorecard decides.
      const res = await submitScorecardCore(
        { orgId, userId: hrId, email: HR, actor: HR },
        {
          applicationId: a,
          interviewId,
          level,
          rating: 4,
          verdict: "select",
          comments: null,
          competencies: [],
        },
      );
      expect(res.roundComplete).not.toBe(false);
      expect(res.blocked).toBeNull();
      moves.push(`L${level}→${res.movedTo}`);
    }
    const [app] = await db
      .select({ stage: applications.stage })
      .from(applications)
      .where(eq(applications.id, a));
    // Under the default plan the final select reaches the offer pipeline (or
    // waits for the hiring decision the HR head records by hand).
    if (app!.stage === "l3")
      await moveStageCore(hr, {
        applicationId: a,
        toStage: "offer_pending" as never,
        reason: "Selected by the hiring manager",
      });
    const [after] = await db
      .select({ stage: applications.stage })
      .from(applications)
      .where(eq(applications.id, a));
    expect(["offer_pending", "offer"]).toContain(after!.stage);

    await processAgentEvents({ orgId });
    expect(await runsSince(since)).toHaveLength(0);
    const stuck = await db
      .select({ type: agentEvents.type, status: agentEvents.status })
      .from(agentEvents)
      .where(and(eq(agentEvents.orgId, orgId), gte(agentEvents.createdAt, since)));
    expect(stuck.length).toBeGreaterThan(0);
    expect(stuck.every((e) => e.status === "done")).toBe(true);
  });
});
