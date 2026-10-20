/**
 * Agreeing pay with a candidate before the offer, against the disposable database:
 *  - preparing needs the HR head's ceiling (the CBO's above the band), a proposal
 *    at or under it and under the ask; it is idempotent and contacts nobody;
 *  - the pay message is ALWAYS approved by a person, even for an Autonomous agent;
 *    sending is once, needs an open discussion, and emails the private link;
 *  - the candidate answers once (accept / another figure / a call); closed links
 *    take nothing; the thread and audit never carry amounts;
 *  - TA records a call: role-checked, never above the ceiling;
 *  - agreement restarts the Offer agent, which drafts at the agreed figure (above
 *    the band only on a CBO-approved ceiling) — and never while a discussion is open;
 *  - unanswered links expire; pop-ups ask a person to call.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/negotiation.test.ts
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
  auditLog,
  candidateNotes,
  candidates,
  compensationDetails,
  emailOutbox,
  hiringConversations,
  hiringMessages,
  offerNegotiations,
  offers,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
await import("../src/server/agents");
const neg = await import("../src/lib/negotiation.server");
const comp = await import("../src/lib/compensation.server");
const { getTool } = await import("../src/server/agents/registry");
const { decideToolCall } = await import("../src/server/agents/policy");
const { offerReadiness } = await import("../src/server/agents/tools-phase4");
const { agreedLine } = await import("../src/server/agents/runtime.server");
const { processAgentEvents } = await import("../src/server/agents/orchestrator.server");

const stamp = Date.now();
let orgId: string;
let hr: string;
let viewer: string;
let role: string;
let appId: string;
let candId: string;
let convId: string;
const hrEmail = `neg-hr-${stamp}@test.local`;
const asHr = () => ({ orgId, userId: hr, memberEmail: hrEmail });
const TALK =
  "Open with thanks. Her ask is 1.25 Cr; we can do 1.10 Cr plus a joining bonus. Do not go above the ceiling; hand to the HR head if she holds firm.";
const MESSAGE =
  "Thank you for sharing your expectations — we were glad to read them, and the team is excited about you joining.\n\nWe can offer ₹1,10,00,000 a year with a joining bonus and a pay review after six months.";

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const mk = async (email: string) =>
    (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
  hr = await mk(hrEmail);
  viewer = await mk(`neg-viewer-${stamp}@test.local`);
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Negotiation Org", slug: `neg-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  for (const [u, roles] of [
    [hr, ["recruiter", "hr_head"]],
    [viewer, ["hiring_manager"]],
  ] as const) {
    await db.insert(orgMembers).values({
      orgId,
      userId: u,
      email: `${u}@x`,
      fullName: "M",
      status: "active",
      isOwner: false,
    } as never);
    for (const r of roles)
      await db.insert(userRoles).values({ userId: u, orgId, role: r as never });
  }
  role = (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-N-${stamp}`,
        title: "Head of AI",
        status: "approved",
        createdBy: hr,
        ctcBandMin: "7000000",
        ctcBandMax: "10500000",
        budgetCtc: "8500000",
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
  candId = (
    await db
      .insert(candidates)
      .values({ orgId, fullName: "Meera Iyer", email: `neg-meera-${stamp}@cand.local` })
      .returning({ id: candidates.id })
  )[0]!.id;
  appId = (
    await db
      .insert(applications)
      .values({ orgId, requisitionId: role, candidateId: candId, stage: "offer_pending" })
      .returning({ id: applications.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const u of [hr, viewer]) await db.delete(users).where(eq(users.id, u));
});

beforeEach(async () => {
  for (const t of [
    offerNegotiations,
    compensationDetails,
    emailOutbox,
    hiringConversations,
    agentRuns,
    agentEvents,
    agentPolicies,
    offers,
    candidateNotes,
  ])
    await db.delete(t).where(eq((t as typeof emailOutbox).orgId, orgId));
  await db.update(applications).set({ stage: "offer_pending" }).where(eq(applications.id, appId));
  await comp.recordCompensation(
    asHr(),
    appId,
    {
      currentFixed: 8_500_000,
      currentVariable: 1_000_000,
      expectedCtc: 12_500_000,
      noticePeriodDays: 90,
      earliestJoining: "2027-01-18",
    },
    "recruiter",
    new Date("2026-10-13T10:00:00Z"),
  );
  // Recording her pay raised compensation.submitted; these tests start from a quiet queue.
  await db.delete(agentEvents).where(eq(agentEvents.orgId, orgId));
  convId = (
    await db
      .insert(hiringConversations)
      .values({ orgId, createdBy: hr, requisitionId: role, status: "active" })
      .returning({ id: hiringConversations.id })
  )[0]!.id;
});

const messages = async () =>
  (
    await db
      .select()
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, convId))
      .orderBy(hiringMessages.createdAt)
  ).map((m) => m.body);
async function run() {
  return (
    await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "offer",
        principalUserId: hr,
        goal: "g",
        status: "running",
        subjectType: "application",
        subjectId: appId,
      } as never)
      .returning({ id: agentRuns.id })
  )[0]!.id;
}
async function answered(runId: string, assigneeRole: "hr_head" | "president_cbo") {
  await db.insert(agentTasks).values({
    orgId,
    runId,
    kind: "clarification",
    status: "answered",
    title: "Ceiling",
    assigneeRole,
    response: { answer: "ok" },
  } as never);
}
const ctxOf = (runId: string) => ({
  orgId,
  runId,
  principalUserId: hr,
  actor: `agent:offer:${runId}`,
  agentType: "offer" as const,
});
const prepare = (runId: string, over: Record<string, unknown> = {}) =>
  neg.prepareNegotiation(ctxOf(runId), {
    applicationId: appId,
    ceiling: 10_500_000,
    proposedCtc: 10_500_000,
    levers: { joiningBonus: 500_000, reviewMonths: 6 },
    talkTrack: TALK,
    message: MESSAGE,
    ...over,
  } as never);
const row = async (id: string) =>
  (await db.select().from(offerNegotiations).where(eq(offerNegotiations.id, id)))[0]!;
async function sent() {
  const r = await run();
  await answered(r, "hr_head");
  const { negotiationId } = await prepare(r);
  await neg.sendNegotiationMessage(orgId, negotiationId, MESSAGE, { userId: hr, actor: hrEmail });
  return { negotiationId, token: (await row(negotiationId)).token! };
}

/* ------------------------------------------------------------ pure */

describe("rules", () => {
  const base = {
    expectedCtc: 12_500_000,
    ceiling: 11_000_000,
    proposedCtc: 11_000_000,
    bandMax: 10_500_000,
    hrAnswered: true,
    cboAnswered: true,
  };
  test("what may be proposed", () => {
    expect(neg.negotiationProblem(base)).toBeNull();
    expect(neg.negotiationProblem({ ...base, cboAnswered: false })).toMatch(/president_cbo/);
    expect(
      neg.negotiationProblem({
        ...base,
        ceiling: 10_000_000,
        proposedCtc: 9_500_000,
        cboAnswered: false,
      }),
    ).toBeNull();
    expect(
      neg.negotiationProblem({
        ...base,
        ceiling: 10_000_000,
        proposedCtc: 9_500_000,
        hrAnswered: false,
        cboAnswered: false,
      }),
    ).toMatch(/hr_head/);
    expect(neg.negotiationProblem({ ...base, proposedCtc: 11_500_000 })).toMatch(
      /above the ceiling/,
    );
    expect(neg.negotiationProblem({ ...base, expectedCtc: 10_000_000 })).toMatch(
      /within the ceiling/,
    );
    expect(neg.negotiationProblem({ ...base, expectedCtc: null })).toMatch(
      /pay & availability form/,
    );
  });

  test("the approval card states what was agreed", () => {
    expect(
      agreedLine(11_000_000, { agreedCtc: 11_000_000, joiningBonus: 500_000, cboApproved: true }),
    ).toBe(
      " Agreed with the candidate in a pay discussion: ₹1,10,00,000 plus a ₹5,00,000 joining bonus (ceiling approved by the CBO); this offer matches it.",
    );
    expect(agreedLine(10_000_000, null)).toBe("");
  });

  test("the pay message is always approved by a person, whatever the autonomy", () => {
    const tool = getTool("send_negotiation_message")!;
    const t = tool.templateOf?.({} as never) ?? null;
    expect(t).toBeNull();
    expect(
      decideToolCall(
        tool.risk,
        { autonomy: "autonomous", whitelistedTemplates: ["offer_negotiation"] },
        t,
      ),
    ).toBe("approve");
    expect(tool.approverRole).toBe("hr_head");
  });
});

/* ------------------------------------------------------------ prepare and send */

describe("prepare and send", () => {
  test("needs the HR head's ceiling; above the band the CBO's; idempotent; contacts nobody", async () => {
    const r = await run();
    await expect(prepare(r)).rejects.toThrow(/hr_head/);
    await answered(r, "hr_head");
    await expect(prepare(r, { ceiling: 11_000_000, proposedCtc: 11_000_000 })).rejects.toThrow(
      /president_cbo/,
    );
    const a = await prepare(r);
    expect(a).toMatchObject({ status: "open", existing: false });
    expect(await prepare(r)).toMatchObject({ negotiationId: a.negotiationId, existing: true });
    expect(await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId))).toHaveLength(0);
    expect((await row(a.negotiationId)).ceilingApprovedBy).toBe("hr_head");
    expect((await messages()).at(-1)).toMatch(/prepared a pay discussion/);
    expect((await messages()).join("\n")).not.toMatch(/₹|lakh|10500000/);
  });

  test("a CBO-approved ceiling above the band is recorded as the CBO's", async () => {
    const r = await run();
    await answered(r, "hr_head");
    await answered(r, "president_cbo");
    const a = await prepare(r, { ceiling: 11_000_000, proposedCtc: 11_000_000 });
    expect((await row(a.negotiationId)).ceilingApprovedBy).toBe("president_cbo");
  });

  test("sending emails the private link once; the approver's edit is kept", async () => {
    const r = await run();
    await answered(r, "hr_head");
    const { negotiationId } = await prepare(r);
    const edited = `${MESSAGE}\n\nWarm regards, the HR team.`;
    await neg.sendNegotiationMessage(orgId, negotiationId, edited, { userId: hr, actor: hrEmail });
    const n = await row(negotiationId);
    expect(n).toMatchObject({ status: "message_sent", message: edited });
    expect(n.token).toMatch(/^[a-f0-9]{64}$/);
    const mails = await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ kind: "offer_negotiation" });
    expect((mails[0]!.templateData as { responseUrl: string }).responseUrl).toMatch(
      /\/negotiate\/[a-f0-9]{64}$/,
    );
    await expect(
      neg.sendNegotiationMessage(orgId, negotiationId, edited, { userId: hr, actor: hrEmail }),
    ).rejects.toThrow(/message sent; nothing to send/);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "negotiation.message_sent")));
    expect(audit!.detail).toMatchObject({ edited: true });
  });
});

/* ------------------------------------------------------------ the candidate */

describe("the candidate answers", () => {
  test("accept: agreed once, thread told without amounts, the Offer agent restarts", async () => {
    await db
      .insert(agentPolicies)
      .values({ orgId, agentType: "offer", enabled: true, autonomy: "suggest" } as never);
    const { negotiationId, token } = await sent();
    const view = await neg.publicNegotiationView(token);
    expect(view).toMatchObject({
      status: "open",
      proposedCtc: 10_500_000,
      candidateName: "Meera Iyer",
    });
    const results = await Promise.allSettled([
      neg.answerNegotiation(token, { decision: "accept" }),
      neg.answerNegotiation(token, { decision: "call" }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const n = await row(negotiationId);
    expect(["agreed", "call_requested"]).toContain(n.status);
    if (n.status === "agreed") {
      expect(n.outcome).toMatchObject({
        agreedCtc: 10_500_000,
        joiningBonus: 500_000,
        source: "candidate_link",
      });
      // The run that prepared the discussion has finished by now.
      await db.update(agentRuns).set({ status: "done" }).where(eq(agentRuns.orgId, orgId));
      await processAgentEvents({ orgId });
      const runs = (await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId))).filter(
        (x) => x.agentType === "offer" && x.goal.includes("agreed"),
      );
      expect(runs).toHaveLength(1);
    }
    expect(await neg.publicNegotiationView(token)).toMatchObject({ status: "answered" });
    expect((await messages()).join("\n")).not.toMatch(/₹|lakh|10500000/);
  });

  test("another figure or a call: a person is asked; closed links take nothing", async () => {
    const a = await sent();
    await neg.answerNegotiation(a.token, {
      decision: "propose",
      amount: 11_500_000,
      note: "Firm on this",
    });
    expect(await row(a.negotiationId)).toMatchObject({ status: "countered" });
    const { negotiationNudges } = await import("../src/lib/notifications.functions");
    const nudges = await negotiationNudges(orgId);
    expect(nudges.map((x) => x.id)).toContain(`negotiation:countered:${a.negotiationId}`);
    expect(JSON.stringify(nudges)).not.toMatch(/₹|lakh|11500000/);
    await expect(neg.answerNegotiation(a.token, { decision: "accept" })).rejects.toThrow(
      /already answered/,
    );
    // A fresh discussion whose link has closed.
    await db
      .update(offerNegotiations)
      .set({ status: "cancelled" })
      .where(eq(offerNegotiations.id, a.negotiationId));
    const b = await sent();
    await db
      .update(offerNegotiations)
      .set({ closesAt: new Date(Date.now() - 1000) })
      .where(eq(offerNegotiations.id, b.negotiationId));
    await expect(neg.publicNegotiationView(b.token)).rejects.toThrow(/closed/);
    await expect(neg.answerNegotiation(b.token, { decision: "accept" })).rejects.toThrow(/closed/);
    expect(await neg.runNegotiationSweep(orgId)).toBe(1);
    expect(await row(b.negotiationId)).toMatchObject({ status: "expired" });
    expect((await messages()).at(-1)).toMatch(/did not answer the pay message/);
  });
});

/* ------------------------------------------------------------ TA records a call */

describe("TA records a call", () => {
  test("role-checked; never above the ceiling; agreement or not, recorded", async () => {
    const { negotiationId } = await sent();
    await expect(
      neg.recordNegotiationOutcome({ orgId, userId: viewer, memberEmail: "v@x" }, negotiationId, {
        agreed: true,
        agreedCtc: 10_000_000,
      }),
    ).rejects.toThrow(/Only TA/);
    await expect(
      neg.recordNegotiationOutcome(asHr(), negotiationId, { agreed: true, agreedCtc: 11_000_000 }),
    ).rejects.toThrow(/above the approved ceiling/);
    await neg.recordNegotiationOutcome(asHr(), negotiationId, {
      agreed: true,
      agreedCtc: 10_500_000,
      joiningBonus: 700_000,
      joiningDate: "2027-01-18",
    });
    expect((await row(negotiationId)).outcome).toMatchObject({
      agreedCtc: 10_500_000,
      joiningBonus: 700_000,
      joiningDate: "2027-01-18",
      source: "call",
      by: hrEmail,
    });
    await expect(
      neg.recordNegotiationOutcome(asHr(), negotiationId, { agreed: false, note: "Changed mind" }),
    ).rejects.toThrow(/already agreed/);
    expect(await neg.agreedTerms(orgId, appId)).toMatchObject({
      agreedCtc: 10_500_000,
      joiningDate: "2027-01-18",
      cboApproved: false,
    });
  });
});

/* ------------------------------------------------------------ the Offer agent */

describe("the Offer agent", () => {
  test("waits while a discussion is open; drafts at the agreed figure, never above its ceiling", async () => {
    const r = await run();
    await answered(r, "hr_head");
    await answered(r, "president_cbo");
    const { negotiationId } = await prepare(r, { ceiling: 11_000_000, proposedCtc: 11_000_000 });
    const fresh = await run();
    expect(await offerReadiness({ orgId, runId: fresh }, appId)).toMatch(
      /pay discussion with the candidate is in progress/,
    );
    await neg.recordNegotiationOutcome(asHr(), negotiationId, {
      agreed: true,
      agreedCtc: 11_000_000,
      joiningDate: "2027-01-18",
    });
    // A new run (no HR head answer in it) may draft: the agreement settles the expectation.
    expect(await offerReadiness({ orgId, runId: fresh }, appId)).toBeNull();
    const draft = getTool("draft_offer")!;
    const ctx = ctxOf(fresh);
    await expect(
      draft.run(ctx, { applicationId: appId, offeredCtc: 11_500_000, joiningDate: "2027-01-18" }),
    ).rejects.toThrow(/above the ceiling/);
    // Above the band (₹1.05 Cr) only because the CBO approved this ceiling.
    const out = (await draft.run(ctx, {
      applicationId: appId,
      offeredCtc: 11_000_000,
      joiningDate: "2027-01-18",
    })) as { status: string };
    expect(out.status).toBe("draft");
  });

  test("an HR-head-only ceiling never lets a draft above the band", async () => {
    const r = await run();
    await answered(r, "hr_head");
    const { negotiationId } = await prepare(r);
    await neg.recordNegotiationOutcome(asHr(), negotiationId, {
      agreed: true,
      agreedCtc: 10_500_000,
    });
    const fresh = await run();
    await expect(
      getTool("draft_offer")!.run(ctxOf(fresh), {
        applicationId: appId,
        offeredCtc: 10_600_000,
        joiningDate: "2027-01-18",
      }),
    ).rejects.toThrow(/above the ceiling|outside the approved band/);
  });
});
