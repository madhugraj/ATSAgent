/**
 * Silent panel agents, S3 (docs/silent-panel-agent-plan.md): when the last
 * scorecard of a round arrives, the panel's verdict is compared with the
 * agent's hidden view — agree moves the candidate as before; partial moves
 * them and raises a review; disagree holds the move (while the level's agent
 * is on) and raises a review. The HR head's decision is carried out as the
 * HR head: go with the panel, confirm, hold or reject (stopping later rounds).
 * An assessment that lands after the panel scored is compared then.
 *
 * Run: DATABASE_URL=postgres://…/atsagent_test bun test scripts/panel-review.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  agentPolicies,
  applications,
  auditLog,
  candidates,
  interviews,
  orgMembers,
  organizations,
  panelAssessments,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const { submitScorecardCore } = await import("../src/lib/interviews.functions");
const review = await import("../src/server/panel/review.server");

const stamp = Date.now();
const HR = `hr-${stamp}@test.local`;
const PRIYA = `priya-${stamp}@test.local`;
let orgId: string;
let hrId: string;
let priyaId: string;
let requisitionId: string;

async function member(email: string, roles: string[]) {
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  await db.insert(orgMembers).values({
    orgId,
    userId: u!.id,
    email,
    fullName: email,
    status: "active",
    isOwner: false,
  } as never);
  for (const r of roles)
    await db.insert(userRoles).values({ userId: u!.id, orgId, role: r as never });
  return u!.id;
}

/** A candidate at L1 whose L1 round was held, with the agent's view of it. */
async function heldRound(agent: { rating: number; verdict: "select" | "hold" | "reject" } | null) {
  const [cand] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: `Cand ${Math.random()}`,
      email: `c-${Math.random()}@cand.local`,
    } as never)
    .returning({ id: candidates.id });
  const [app] = await db
    .insert(applications)
    .values({ orgId, requisitionId, candidateId: cand!.id, stage: "l1" } as never)
    .returning({ id: applications.id });
  const [r] = await db
    .insert(interviews)
    .values({
      orgId,
      applicationId: app!.id,
      level: 1,
      interviewer: "Priya",
      interviewerEmail: PRIYA,
      scheduledAt: new Date(Date.now() - 2 * 3600_000),
      status: "scheduled",
      transcription: "ready",
    } as never)
    .returning({ id: interviews.id });
  if (agent)
    await db.insert(panelAssessments).values({
      orgId,
      interviewId: r!.id,
      applicationId: app!.id,
      level: 1,
      rating: agent.rating,
      verdict: agent.verdict,
      assessedAt: new Date(),
    });
  return { applicationId: app!.id, interviewId: r!.id };
}

const score = (
  x: { applicationId: string; interviewId: string },
  rating: number,
  verdict: "select" | "hold" | "reject",
) =>
  submitScorecardCore(
    { orgId, userId: priyaId, email: PRIYA, actor: PRIYA },
    {
      applicationId: x.applicationId,
      interviewId: x.interviewId,
      level: 1,
      rating,
      verdict,
      comments: verdict === "select" ? null : "Not convinced on depth.",
      competencies: [],
    },
  );

const stageOf = async (applicationId: string) =>
  (
    await db
      .select({ s: applications.stage })
      .from(applications)
      .where(eq(applications.id, applicationId))
  )[0]!.s;
const assessmentOf = async (interviewId: string) =>
  (
    await db.select().from(panelAssessments).where(eq(panelAssessments.interviewId, interviewId))
  )[0]!;
const reviewEvents = async (applicationId: string) =>
  db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.type, "panel.review_due"), eq(agentEvents.subjectId, applicationId)));
const nextRound = async (applicationId: string) =>
  db
    .select({ status: interviews.status })
    .from(interviews)
    .where(and(eq(interviews.applicationId, applicationId), eq(interviews.level, 2)));

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [o] = await db
    .insert(organizations)
    .values({ name: "Panel Review Org", slug: `pr-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  hrId = await member(HR, ["hr_head"]);
  priyaId = await member(PRIYA, ["recruiter"]);
  const [req] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `PR-${stamp}`,
      title: "Platform SRE",
      status: "approved",
      mustHaveSkills: ["Kubernetes", "Go"],
      createdBy: hrId,
    } as never)
    .returning({ id: requisitions.id });
  requisitionId = req!.id;
  await db.insert(agentPolicies).values({ orgId, agentType: "panel_l1", enabled: true } as never);
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const id of [hrId, priyaId]) await db.delete(users).where(eq(users.id, id));
});

describe("when the panel has scored", () => {
  test("agree: the panel's verdict moves the candidate, nothing is raised", async () => {
    const x = await heldRound({ rating: 4, verdict: "select" });
    const res = await score(x, 4, "select");
    expect(res).toMatchObject({ movedTo: "l2", panelCheck: "agree", blocked: null });
    expect((await nextRound(x.applicationId)).length).toBe(1);
    expect(await assessmentOf(x.interviewId)).toMatchObject({ outcome: "agree", held: false });
    expect(await reviewEvents(x.applicationId)).toHaveLength(0);
  });

  test("partial: the candidate moves on, and the HR head is asked to review", async () => {
    const x = await heldRound({ rating: 4, verdict: "hold" });
    const res = await score(x, 4, "select");
    expect(res).toMatchObject({ movedTo: "l2", panelCheck: "partial" });
    expect(await assessmentOf(x.interviewId)).toMatchObject({ outcome: "partial", held: false });
    expect((await reviewEvents(x.applicationId))[0]!.payload).toMatchObject({
      interviewId: x.interviewId,
      level: 1,
      outcome: "partial",
    });
  });

  test("disagree: the move is held, no next round is queued, the HR head is asked", async () => {
    const x = await heldRound({ rating: 1, verdict: "reject" });
    const res = await score(x, 5, "select");
    expect(res.movedTo).toBeNull();
    expect(res.panelCheck).toBe("disagree");
    expect(res.blocked).toContain("On hold for the HR head");
    expect(await stageOf(x.applicationId)).toBe("l1");
    expect(await nextRound(x.applicationId)).toHaveLength(0);
    expect(await assessmentOf(x.interviewId)).toMatchObject({
      outcome: "disagree",
      held: true,
      panelVerdict: "select",
    });
    expect(await reviewEvents(x.applicationId)).toHaveLength(1);
    const audit = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, x.interviewId), eq(auditLog.action, "panel_review.reconciled")),
      );
    expect(audit[0]!.detail).toEqual({ level: 1, outcome: "disagree", held: true });
  });

  test("no view of the round: it runs exactly as before", async () => {
    const x = await heldRound(null);
    const res = await score(x, 4, "select");
    expect(res.movedTo).toBe("l2");
    expect(res.panelCheck).toBeUndefined();
  });

  test("the level's agent switched off: a disagreement is recorded but nothing is held", async () => {
    await db.update(agentPolicies).set({ enabled: false }).where(eq(agentPolicies.orgId, orgId));
    const x = await heldRound({ rating: 1, verdict: "reject" });
    const res = await score(x, 5, "select");
    expect(res).toMatchObject({ movedTo: "l2", panelCheck: "disagree" });
    expect(await assessmentOf(x.interviewId)).toMatchObject({ held: false });
    await db.update(agentPolicies).set({ enabled: true }).where(eq(agentPolicies.orgId, orgId));
  });
});

describe("the HR head's review card", () => {
  test("states both views side by side and goes to the HR head", async () => {
    const x = await heldRound({ rating: 1, verdict: "reject" });
    await score(x, 5, "select");
    const gate = await review.reviewGateFor(orgId, {
      type: "panel_review",
      interviewId: x.interviewId,
    });
    if ("error" in gate) throw new Error(gate.error);
    expect(gate.role).toBe("hr_head");
    expect(gate.subject.expects).toBe("l1");
    expect(gate.detail).toContain("ON HOLD");
    expect(gate.detail).toContain(`${PRIYA}: 5/5, select`);
    expect(gate.detail).toContain("verdict select, average 5/5");
    expect(gate.detail).toContain("reject, 1/5");
    expect(gate.detail).toContain("Approve to go with the panel");
  });

  test("held, approved: the candidate goes on as the panel decided", async () => {
    const x = await heldRound({ rating: 1, verdict: "reject" });
    await score(x, 5, "select");
    await review.performReviewGate(
      orgId,
      hrId,
      HR,
      { type: "panel_review", interviewId: x.interviewId, expects: "l1" },
      { status: "approved" },
    );
    expect(await stageOf(x.applicationId)).toBe("l2");
    expect(await nextRound(x.applicationId)).toEqual([{ status: "pending_scheduling" }]);
    expect(await assessmentOf(x.interviewId)).toMatchObject({
      reviewDecision: "go_with_panel",
      reviewedBy: hrId,
    });
    await expect(
      review.performReviewGate(
        orgId,
        hrId,
        HR,
        { type: "panel_review", interviewId: x.interviewId },
        {
          status: "approved",
        },
      ),
    ).rejects.toThrow("already been reviewed");
  });

  test("partial, declined: on hold with the reason, and the next round is cancelled", async () => {
    const x = await heldRound({ rating: 4, verdict: "hold" });
    await score(x, 4, "select");
    expect(await nextRound(x.applicationId)).toEqual([{ status: "pending_scheduling" }]);
    await expect(
      review.performReviewGate(
        orgId,
        hrId,
        HR,
        { type: "panel_review", interviewId: x.interviewId },
        {
          status: "rejected",
        },
      ),
    ).rejects.toThrow("Say why");
    await review.performReviewGate(
      orgId,
      hrId,
      HR,
      { type: "panel_review", interviewId: x.interviewId, expects: "l2" },
      { status: "rejected", reason: "Depth on incidents is unclear; talk to the panel first." },
    );
    expect(await stageOf(x.applicationId)).toBe("on_hold");
    expect(await nextRound(x.applicationId)).toEqual([{ status: "cancelled" }]);
    expect(await assessmentOf(x.interviewId)).toMatchObject({ reviewDecision: "held" });
  });

  test("rejecting the candidate is the HR head's call, with a reason; others cannot decide", async () => {
    const x = await heldRound({ rating: 1, verdict: "reject" });
    await score(x, 5, "select");
    await expect(
      review.performReviewGate(
        orgId,
        priyaId,
        PRIYA,
        { type: "panel_review", interviewId: x.interviewId },
        {
          status: "approved",
        },
      ),
    ).rejects.toThrow("HR head");
    await review.performReviewGate(
      orgId,
      hrId,
      HR,
      { type: "panel_review", interviewId: x.interviewId },
      {
        status: "rejected",
        reason: "The call shows no production experience.",
        rejectCandidate: true,
      },
    );
    expect(await stageOf(x.applicationId)).toBe("rejected");
    expect(await assessmentOf(x.interviewId)).toMatchObject({ reviewDecision: "rejected" });
    const audit = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, x.interviewId), eq(auditLog.action, "panel_review.decided")),
      );
    expect(audit[0]!.detail).toMatchObject({ decision: "rejected", outcome: "disagree" });
  });

  test("the request is refused when there is nothing to review", async () => {
    const x = await heldRound({ rating: 4, verdict: "select" });
    expect(await review.reviewPrecheck(orgId, x.interviewId, 1)).toBe(
      "The panel has not finished scoring this round yet.",
    );
    await score(x, 4, "select");
    expect(await review.reviewPrecheck(orgId, x.interviewId, 1)).toContain("agrees with the panel");
    expect(await review.reviewPrecheck(orgId, x.interviewId, 2)).toContain("no L2 panel agent");
  });
});

describe("an assessment after the panel scored", () => {
  test("is compared then; nothing is held, and the run that assessed asks for the review", async () => {
    const x = await heldRound(null);
    await score(x, 5, "select");
    expect(await stageOf(x.applicationId)).toBe("l2");
    await db.insert(panelAssessments).values({
      orgId,
      interviewId: x.interviewId,
      applicationId: x.applicationId,
      level: 1,
      rating: 2,
      verdict: "reject",
      assessedAt: new Date(),
    });
    const outcome = await review.reconcileAfterAssessment(
      orgId,
      x.interviewId,
      1,
      "agent:panel_l1",
    );
    expect(outcome).toBe("disagree");
    expect(await assessmentOf(x.interviewId)).toMatchObject({ outcome: "disagree", held: false });
    // The assessing run raises the card itself: no second event.
    expect(await reviewEvents(x.applicationId)).toHaveLength(0);
    expect(await review.reconcileAfterAssessment(orgId, x.interviewId, 1, "x")).toBeNull();
  });
});
