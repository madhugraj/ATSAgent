/**
 * Another interview round (src/server/agents/round-gate.server.ts): after the
 * role's final round, the Evaluation agent drafts one more round for the
 * hiring manager to edit and approve. Approving adds it to the role's plan,
 * moves the candidate into it and lets the Interview coordinator arrange it;
 * declining changes nothing; a stale card or a full plan is refused.
 *
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/extra-round.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  applications,
  auditLog,
  candidates,
  interviews,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const { submitScorecardCore } = await import("../src/lib/interviews.functions");
const { planFor, hiringDecisionBlocked } = await import("../src/lib/interview-plan.server");
const gate = await import("../src/server/agents/round-gate.server");
await import("../src/server/agents");
const { getTool } = await import("../src/server/agents/registry");

const stamp = Date.now();
const HM = `hm-${stamp}@test.local`;
const PRIYA = `priya-${stamp}@test.local`;
let orgId: string;
let hmId: string;
let hmMemberId: string;
let priyaId: string;

const ROUND = {
  name: "Practical Python",
  focus: "A live task on the gaps both earlier rounds flagged.",
  competencies: ["Python", "Git"],
};

async function member(email: string, roles: string[]) {
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  const [m] = await db
    .insert(orgMembers)
    .values({
      orgId,
      userId: u!.id,
      email,
      fullName: email,
      status: "active",
      isOwner: false,
    } as never)
    .returning({ id: orgMembers.id });
  for (const r of roles)
    await db.insert(userRoles).values({ userId: u!.id, orgId, role: r as never });
  return { userId: u!.id, memberId: m!.id };
}

/** A role with `rounds` rounds and a candidate who has completed every one with a select. */
async function scoredCandidate(rounds: number) {
  const [req] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `XR-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
      title: "AI Intern",
      status: "approved",
      mustHaveSkills: ["Python"],
      createdBy: hmId,
      hiringManagerMemberId: hmMemberId,
      interviewPlan: {
        rounds: Array.from({ length: rounds }, (_, i) => ({
          level: i + 1,
          name: `Round ${i + 1}`,
          focus: "",
          competencies: ["Python"],
          panelSize: 1,
        })),
        verdictPolicy: "recommend",
      },
    } as never)
    .returning({ id: requisitions.id });
  const [cand] = await db
    .insert(candidates)
    .values({ orgId, fullName: `Cand ${stamp}`, email: `c-${Math.random()}@cand.local` } as never)
    .returning({ id: candidates.id });
  const [app] = await db
    .insert(applications)
    .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: `l${rounds}` } as never)
    .returning({ id: applications.id });
  for (let level = 1; level <= rounds; level++) {
    const [r] = await db
      .insert(interviews)
      .values({
        orgId,
        applicationId: app!.id,
        level,
        interviewer: "Priya",
        interviewerEmail: PRIYA,
        scheduledAt: new Date(Date.now() - (rounds - level + 1) * 86_400_000),
        status: "scheduled",
      } as never)
      .returning({ id: interviews.id });
    await submitScorecardCore(
      { orgId, userId: priyaId, email: PRIYA, actor: PRIYA },
      {
        applicationId: app!.id,
        interviewId: r!.id,
        level,
        rating: 4,
        verdict: "select",
        comments: null,
        competencies: [],
      },
    );
  }
  return { applicationId: app!.id, requisitionId: req!.id };
}

const subjectFor = (x: { applicationId: string; requisitionId: string }) => ({
  type: "round_addition" as const,
  applicationId: x.applicationId,
  requisitionId: x.requisitionId,
  round: ROUND,
  reason: "The hiring manager wants one more round before deciding.",
});
const actor = () => ({ orgId, userId: hmId, memberEmail: HM });
const stageOf = async (applicationId: string) =>
  (
    await db
      .select({ s: applications.stage })
      .from(applications)
      .where(eq(applications.id, applicationId))
  )[0]!.s;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [o] = await db
    .insert(organizations)
    .values({ name: "Extra Round Org", slug: `xr-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  ({ userId: hmId, memberId: hmMemberId } = await member(HM, ["hiring_manager"]));
  ({ userId: priyaId } = await member(PRIYA, ["recruiter"]));
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const id of [hmId, priyaId]) await db.delete(users).where(eq(users.id, id));
});

describe("another interview round", () => {
  test("goes to the role's hiring manager, with the round and who it affects", async () => {
    const x = await scoredCandidate(2);
    const info = await gate.roundGateFor(orgId, subjectFor(x));
    if ("error" in info) throw new Error(info.error);
    expect(info.assigneeUserId).toBe(hmId);
    expect(info.role).toBeNull();
    expect(info.status).toBe("2");
    expect(info.detail).toContain("Add L3 · Practical Python");
    expect(info.detail).toContain("every candidate of this role");
  });

  test("approved as edited: the plan grows, the candidate moves in, the coordinator is told", async () => {
    const x = await scoredCandidate(2);
    const info = await gate.roundGateFor(orgId, subjectFor(x));
    if ("error" in info) throw new Error(info.error);
    const edited = {
      name: "Hands-on build",
      focus: "Pair on a small RAG fix.",
      competencies: ["Python", "RAG basics"],
    };
    await gate.performRoundGate(orgId, actor(), info.subject, {
      status: "approved",
      args: { round: edited },
    });
    const { plan } = await planFor(orgId, x.requisitionId);
    expect(plan.rounds).toHaveLength(3);
    expect(plan.rounds[2]).toMatchObject({ level: 3, ...edited, panelSize: 1 });
    expect(await stageOf(x.applicationId)).toBe("l3");
    const l3 = await db
      .select({ status: interviews.status })
      .from(interviews)
      .where(and(eq(interviews.applicationId, x.applicationId), eq(interviews.level, 3)));
    expect(l3).toEqual([{ status: "pending_scheduling" }]);
    const advanced = await db
      .select({ payload: agentEvents.payload })
      .from(agentEvents)
      .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "application.advanced")));
    expect(
      advanced.some((e) =>
        ((e.payload as { applicationIds?: string[] }).applicationIds ?? []).includes(
          x.applicationId,
        ),
      ),
    ).toBe(true);
    const [audit] = await db
      .select({ detail: auditLog.detail, actor: auditLog.actor })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, x.requisitionId),
          eq(auditLog.action, "interview_plan.round_added"),
        ),
      );
    expect(audit).toMatchObject({ actor: HM, detail: { level: 3, changed: true } });
    // The new round is now the final one: no select until it is complete.
    expect(await hiringDecisionBlocked(orgId, x.applicationId, "select")).toContain("L3");
    expect(await gate.extraRoundBlocked(orgId, x.applicationId)).toContain(
      "three interview rounds",
    );
    expect(await gate.roundAddedWords(orgId, info.subject)).toContain("L3 Hands-on build");
  });

  test("declined: nothing changes", async () => {
    const x = await scoredCandidate(1);
    const info = await gate.roundGateFor(orgId, subjectFor(x));
    if ("error" in info) throw new Error(info.error);
    await gate.performRoundGate(orgId, actor(), info.subject, { status: "rejected" });
    expect((await planFor(orgId, x.requisitionId)).plan.rounds).toHaveLength(1);
    expect(await stageOf(x.applicationId)).toBe("l1");
  });

  test("a card for a plan that changed since is refused", async () => {
    const x = await scoredCandidate(1);
    await expect(
      gate.performRoundGate(
        orgId,
        actor(),
        { ...subjectFor(x), expects: "2" },
        { status: "approved" },
      ),
    ).rejects.toThrow("changed since");
  });

  test("not before the final round is complete, and never past three rounds", async () => {
    const full = await scoredCandidate(3);
    expect(await gate.extraRoundBlocked(orgId, full.applicationId)).toContain(
      "three interview rounds",
    );
    const info = await gate.roundGateFor(orgId, subjectFor(full));
    expect("error" in info).toBe(true);
  });

  test("the agent can only propose it — the tool never adds the round", async () => {
    // Other suites in the same process may reset the registry.
    if (!getTool("propose_extra_round")) gate.registerRoundTools();
    const tool = getTool("propose_extra_round")!;
    expect(tool.proposes).toBeDefined();
    await expect(tool.run({} as never, {} as never)).rejects.toThrow("added by a person");
  });
});
