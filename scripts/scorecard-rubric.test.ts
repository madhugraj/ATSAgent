/**
 * The scorecard rubric (weights and rating guides per competency):
 *  - pure: the overall is the weighted average, rounded to 1–5; a missing
 *    weight is 1; pruning drops rubric entries for competencies no longer
 *    listed; the default plan only tops up a round with generic competencies;
 *    the panel agent's overall follows the same rule;
 *  - against the disposable database: the server records the weighted overall
 *    whatever the client sends, and refuses a card that skips a listed
 *    competency or rates one the rubric does not list.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/scorecard-rubric.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const plan = await import("../src/lib/interview-plan");
const { buildAssessment } = await import("../src/lib/panel-assessment");

describe("the overall rule", () => {
  test("weighted average, rounded to the 1–5 scale", () => {
    const round = { weights: { LLMs: 3 } };
    // (5*3 + 2*1) / 4 = 4.25 → 4
    expect(
      plan.overallRating(
        [
          { name: "LLMs", rating: 5 },
          { name: "RAG", rating: 2 },
        ],
        round,
      ),
    ).toBe(4);
    // equal weights: (5 + 2) / 2 = 3.5 → 4
    expect(
      plan.overallRating(
        [
          { name: "LLMs", rating: 5 },
          { name: "RAG", rating: 2 },
        ],
        null,
      ),
    ).toBe(4);
    expect(() => plan.overallRating([], null)).toThrow();
  });

  test("a missing or invalid weight counts as 1", () => {
    expect(plan.weightOf({ weights: { A: 4 } }, "A")).toBe(4);
    expect(plan.weightOf({ weights: { A: 4 } }, "B")).toBe(1);
    expect(plan.weightOf({}, "A")).toBe(1);
  });

  test("pruning drops rubric entries for competencies the round no longer lists", () => {
    const pruned = plan.pruneRubric({
      verdictPolicy: "recommend",
      rounds: [
        {
          level: 1,
          name: "Skills",
          focus: "",
          competencies: ["LLMs"],
          panelSize: 1,
          weights: { LLMs: 2, Gone: 3, Plain: 1 },
          anchors: {
            LLMs: { low: "Buzzwords only", mid: "", high: "" },
            Gone: { low: "x", mid: "y", high: "z" },
          },
        },
      ],
    });
    expect(pruned.rounds[0]!.weights).toEqual({ LLMs: 2 });
    expect(Object.keys(pruned.rounds[0]!.anchors ?? {})).toEqual(["LLMs"]);
  });

  test("the default plan adds generic competencies only to fill a short round", () => {
    const rich = plan.defaultPlan(["A1", "A2", "A3", "A4", "B1", "B2", "B3"]);
    expect(rich.rounds[0]!.competencies).toEqual(["A1", "A2", "A3", "A4"]);
    expect(rich.rounds[1]!.competencies).toEqual(["B1", "B2", "B3"]);
    const thin = plan.defaultPlan(["Nursing care"]);
    expect(thin.rounds[0]!.competencies).toEqual(["Nursing care", "Problem solving"]);
    expect(thin.rounds[1]!.competencies).toEqual(["Ownership", "Collaboration", "Communication"]);
  });

  test("the panel agent's overall uses the same weighted rule", () => {
    const out = {
      candidate_speaker: null,
      rating: 1,
      verdict: "hold",
      competencies: [
        { name: "LLMs", rating: 5, evidence: [], note: "" },
        { name: "RAG", rating: 2, evidence: [], note: "" },
        { name: "MLOps", rating: null, evidence: [], note: "" },
      ],
      strengths: [],
      gaps: [],
      open_questions: [],
      panel: { covered: [], missed: [], off_limits: [], notes: "" },
      suspected_prompt_injection: false,
    } as never;
    const v = buildAssessment(out, [], ["LLMs", "RAG", "MLOps"], "Asha", { LLMs: 3 });
    expect(v.rating).toBe(4);
    const none = buildAssessment(
      { ...(out as object), competencies: [] } as never,
      [],
      ["LLMs"],
      "Asha",
    );
    expect(none.rating).toBe(1);
  });
});

/* ------------------------------------------------------------- database */

const hasDb = Boolean(process.env.DATABASE_URL);
describe.skipIf(!hasDb)("the server records the rubric's overall", async () => {
  const { db } = await import("../src/server/db");
  const { applications, candidates, evaluations, interviews, organizations, requisitions } =
    await import("../drizzle/schema");
  const { submitScorecardCore } = await import("../src/lib/interviews.functions");
  const stamp = Date.now();
  let orgId: string;
  let appId: string;
  let ivA: string;
  let ivB: string;

  beforeAll(async () => {
    if (!["127.0.0.1", "localhost", "::1"].includes(new URL(process.env.DATABASE_URL!).hostname))
      throw new Error("Refusing non-local database");
    orgId = (
      await db
        .insert(organizations)
        .values({ name: "Rubric Org", slug: `rubric-${stamp}`, status: "active" })
        .returning({ id: organizations.id })
    )[0]!.id;
    const reqId = (
      await db
        .insert(requisitions)
        .values({
          orgId,
          code: `REQ-R-${stamp}`,
          title: "Head of AI",
          status: "approved",
          mustHaveSkills: ["LLMs", "RAG"],
          interviewPlan: {
            verdictPolicy: "recommend",
            rounds: [
              {
                level: 1,
                name: "Skills",
                focus: "",
                competencies: ["LLMs", "RAG"],
                panelSize: 1,
                weights: { LLMs: 3 },
              },
            ],
          },
        } as never)
        .returning({ id: requisitions.id })
    )[0]!.id;
    const [c] = await db
      .insert(candidates)
      .values({ orgId, fullName: "Asha", email: `asha-${stamp}@example.com` } as never)
      .returning({ id: candidates.id });
    appId = (
      await db
        .insert(applications)
        .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "l1" } as never)
        .returning({ id: applications.id })
    )[0]!.id;
    const mk = async (email: string) =>
      (
        await db
          .insert(interviews)
          .values({
            orgId,
            applicationId: appId,
            level: 1,
            interviewerEmail: email,
            scheduledAt: new Date(Date.now() - 3600_000),
            status: "completed",
          } as never)
          .returning({ id: interviews.id })
      )[0]!.id;
    ivA = await mk("a@example.com");
    ivB = await mk("b@example.com");
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  const ctx = (email: string) => ({ orgId, userId: null, email, actor: `external:${email}` });

  test("a card that skips or adds a competency is refused", async () => {
    const base = { applicationId: appId, level: 1, verdict: "select" as const, interviewId: ivA };
    await expect(
      submitScorecardCore(ctx("a@example.com"), {
        ...base,
        competencies: [{ name: "LLMs", rating: 5 }],
      }),
    ).rejects.toThrow(/every competency/);
    await expect(
      submitScorecardCore(ctx("a@example.com"), {
        ...base,
        competencies: [
          { name: "LLMs", rating: 5 },
          { name: "RAG", rating: 2 },
          { name: "Charm", rating: 5 },
        ],
      }),
    ).rejects.toThrow(/only the competencies/);
  });

  test("the weighted overall is recorded, whatever the client sends", async () => {
    await submitScorecardCore(ctx("b@example.com"), {
      applicationId: appId,
      level: 1,
      interviewId: ivB,
      verdict: "select",
      rating: 1,
      competencies: [
        { name: "LLMs", rating: 5 },
        { name: "RAG", rating: 2 },
      ],
    });
    const [e] = await db
      .select({ rating: evaluations.rating })
      .from(evaluations)
      .where(and(eq(evaluations.orgId, orgId), eq(evaluations.interviewId, ivB)));
    expect(e!.rating).toBe(4);
  });
});
