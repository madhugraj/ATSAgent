/**
 * HR copilot intelligence: role scoping (src/lib/copilot-scope.ts and the
 * server-side filters in src/server/copilot/data.server.ts), pool coverage
 * (src/lib/pool-coverage.ts) and the demand outlook (src/lib/demand-outlook.ts).
 * The scoping tests run against the disposable local database: a recruiter
 * never receives pay figures, a hiring manager sees only their own roles, and
 * tools outside a scope are never offered to the model.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { scopeFor } from "../src/lib/copilot-scope";
import {
  computeCoverage,
  skillMatches,
  statusOf,
  summariseCoverage,
} from "../src/lib/pool-coverage";
import { historyQuarters, quartersAgo, rankOutlook, roleTrends } from "../src/lib/demand-outlook";

const NOW = new Date("2026-11-15T00:00:00Z");
const monthsAgo = (n: number) => new Date(Date.UTC(2026, 10 - n, 10));

describe("scope", () => {
  test("tiers from roles", () => {
    expect(scopeFor([], true).tier).toBe("leadership");
    expect(scopeFor(["hr_head"], false).tier).toBe("leadership");
    expect(scopeFor(["recruiter", "hiring_manager"], false).tier).toBe("recruiter");
    expect(scopeFor(["department_head"], false).tier).toBe("manager");
    expect(scopeFor([], false).tier).toBe("member");
  });

  test("money and governance follow the tier", () => {
    const rec = scopeFor(["recruiter"], false);
    expect(rec).toMatchObject({
      wholeOrg: true,
      reqBudgets: false,
      orgMoney: false,
      governance: false,
    });
    const mgr = scopeFor(["hiring_manager"], false);
    expect(mgr).toMatchObject({ wholeOrg: false, reqBudgets: true, orgMoney: false, pool: true });
    const lead = scopeFor(["president_cbo"], false);
    expect(lead).toMatchObject({ wholeOrg: true, orgMoney: true, governance: true });
    expect(scopeFor([], false).pool).toBe(false);
  });
});

describe("pool coverage", () => {
  const fresh = new Date("2026-10-01T00:00:00Z");
  const stale = new Date("2024-01-01T00:00:00Z");
  const person = (id: string, skills: string[], internal = false, seenAt = fresh) => ({
    id,
    skills,
    isInternal: internal,
    seenAt,
  });

  test("skill matching is containment, whole-word for short skills", () => {
    expect(skillMatches("React.js", "react")).toBe(true);
    expect(skillMatches("Spring Boot", "Spring")).toBe(true);
    expect(skillMatches("Go", "go")).toBe(true);
    expect(skillMatches("Google Cloud", "go")).toBe(false);
  });

  test("strong / partial fits, ratio, status, scarce skills", () => {
    const pool = [
      person("a", ["Python", "LLM", "RAG", "Docker"], true),
      person("b", ["Python", "LLM", "RAG"]),
      person("c", ["Python", "LLM"], false, stale),
      person("d", ["Java"]),
    ];
    const [row] = computeCoverage(
      [
        {
          key: "r1",
          kind: "requisition",
          label: "AI Engineer",
          skills: ["Python", "LLM", "RAG", "Kubernetes"],
          demand: 2,
        },
      ],
      pool,
      NOW,
    );
    // a: 3/4 = 75% partial, b: 75% partial, c: 50% partial, d: 0
    expect(row).toMatchObject({ strong: 0, partial: 3, internal: 1, ratio: 0, status: "red" });
    expect(row!.freshShare).toBeCloseTo(0.67, 2);
    expect(row!.missingSkills).toEqual(["Kubernetes"]);
  });

  test("status thresholds", () => {
    expect(statusOf(3)).toBe("green");
    expect(statusOf(1.5)).toBe("amber");
    expect(statusOf(0.5)).toBe("red");
  });

  test("summary counts statuses and the most common gaps", () => {
    const rows = computeCoverage(
      [
        { key: "x", kind: "role", label: "X", skills: ["Rust"], demand: 1 },
        { key: "y", kind: "role", label: "Y", skills: ["Python"], demand: 1 },
      ],
      [person("a", ["Python"]), person("b", ["Python"]), person("c", ["Python"])],
      NOW,
    );
    const s = summariseCoverage(rows);
    expect(s.red).toBe(1);
    expect(s.green).toBe(1);
    expect(s.topSkillGaps[0]).toEqual({ skill: "Rust", roles: 1 });
  });
});

describe("demand outlook", () => {
  test("quarters and history", () => {
    expect(quartersAgo(monthsAgo(0), NOW)).toBe(0);
    expect(quartersAgo(monthsAgo(4), NOW)).toBe(1);
    expect(historyQuarters([{ createdAt: monthsAgo(1) }], NOW)).toBe(1);
    expect(historyQuarters([{ createdAt: monthsAgo(40) }], NOW)).toBe(8);
    expect(historyQuarters([], NOW)).toBe(0);
  });

  test("trend compares the last two quarters with the two before", () => {
    const [t] = roleTrends(
      [
        { role: "AI Engineer", createdAt: monthsAgo(1), openings: 3 },
        { role: "AI Engineer", createdAt: monthsAgo(4), openings: 1 },
        { role: "AI Engineer", createdAt: monthsAgo(8), openings: 1 },
      ],
      NOW,
    );
    expect(t).toMatchObject({ recent: 4, prior: 1, growth: 3 });
  });

  test("ranking: agreeing signals rank first with high confidence; thin history is low", () => {
    const trends = roleTrends(
      [
        { role: "AI Engineer", createdAt: monthsAgo(1), openings: 4 },
        { role: "AI Engineer", createdAt: monthsAgo(7), openings: 1 },
        { role: "Backend Engineer", createdAt: monthsAgo(2), openings: 1 },
        { role: "Backend Engineer", createdAt: monthsAgo(8), openings: 3 },
      ],
      NOW,
    );
    const rows = rankOutlook({
      trends,
      market: [
        { role: "AI Engineer", outlook: "rising", reason: "postings up" },
        { role: "Backend Engineer", outlook: "falling", reason: "postings down" },
      ],
      emerging: [{ name: "Forward Deployed Engineer", status: "emerging" }],
      coverage: [{ label: "AI Engineer", status: "red" }],
      historyQuarters: 6,
      marketGrounded: true,
    });
    expect(rows[0]).toMatchObject({ role: "AI Engineer", confidence: "high", coverage: "red" });
    expect(rows.map((r) => r.role)).toContain("Forward Deployed Engineer");
    expect(rows.map((r) => r.role)).not.toContain("Backend Engineer");

    const thin = rankOutlook({
      trends: roleTrends([{ role: "AI Engineer", createdAt: monthsAgo(1), openings: 2 }], NOW),
      market: [],
      emerging: [],
      coverage: [],
      historyQuarters: 1,
      marketGrounded: false,
    });
    expect(thin[0]).toMatchObject({ role: "AI Engineer", confidence: "low" });
  });
});

/* ------------------------------------------------- server-side scoping (DB) */

const { db } = await import("../src/server/db");
const { organizations, users, orgMembers, requisitions, offers, applications, candidates } =
  await import("../drizzle/schema");
const data = await import("../src/server/copilot/data.server");
const { toolsFor } = await import("../src/server/copilot/copilot.server");

let orgId: string;
let managerId: string;
let managerMember: string;
const stamp = Date.now();

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [o] = await db
    .insert(organizations)
    .values({ name: "Copilot Org", slug: `copilot-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [u] = await db
    .insert(users)
    .values({ email: `copilot-mgr-${stamp}@test.local` })
    .returning({ id: users.id });
  managerId = u!.id;
  const [m] = await db
    .insert(orgMembers)
    .values({
      orgId,
      userId: managerId,
      email: `copilot-mgr-${stamp}@test.local`,
      status: "active",
    })
    .returning({ id: orgMembers.id });
  managerMember = m!.id;
  const [mine, other] = await db
    .insert(requisitions)
    .values([
      {
        orgId,
        code: `CP-${stamp}-1`,
        title: "AI Engineer",
        status: "approved",
        budgetCtc: "2500000",
        createdBy: managerId,
        mustHaveSkills: ["Python", "LLM"],
      },
      {
        orgId,
        code: `CP-${stamp}-2`,
        title: "Finance Analyst",
        status: "pending_hr",
        budgetCtc: "1200000",
        mustHaveSkills: ["Excel"],
      },
    ])
    .returning({ id: requisitions.id });
  const [cand] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Test Person", email: `copilot-cand-${stamp}@test.local`, skills: ["Python", "LLM"] } as never)
    .returning({ id: candidates.id });
  const [app] = await db
    .insert(applications)
    .values({ orgId, requisitionId: other!.id, candidateId: cand!.id, stage: "offer" })
    .returning({ id: applications.id });
  await db
    .insert(offers)
    .values({ orgId, applicationId: app!.id, offeredCtc: "1300000", status: "pending_cbo" });
  void mine;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, managerId));
});

const ctxOf = (
  roles: Parameters<typeof scopeFor>[0],
  isOwner = false,
  userId = "00000000-0000-0000-0000-000000000000",
  memberId: string | null = null,
) => ({
  orgId,
  userId,
  memberId,
  scope: scopeFor(roles, isOwner),
});

describe("server-side scoping", () => {
  test("a recruiter sees every requisition but no budget or offer pay", async () => {
    const ctx = ctxOf(["recruiter"]);
    const r = await data.findRequisitions(ctx, {});
    expect(r.requisitions).toHaveLength(2);
    for (const q of r.requisitions) expect(q).not.toHaveProperty("budgetCtc");
    const p = await data.pipelineSummary(ctx);
    expect(JSON.stringify(p)).not.toContain("totalCtc");
  });

  test("a hiring manager sees only the roles they raised, with budgets", async () => {
    const ctx = ctxOf(["hiring_manager"], false, managerId, managerMember);
    const r = await data.findRequisitions(ctx, {});
    expect(r.requisitions.map((q) => q.title)).toEqual(["AI Engineer"]);
    expect(r.requisitions[0]).toHaveProperty("budgetCtc", 2500000);
    expect((await data.requisitionStatus(ctx, `CP-${stamp}-2`)).found).toBe(false);
  });

  test("leadership sees offers waiting with pay; the CBO's turn is marked", async () => {
    const ctx = ctxOf(["president_cbo"]);
    const p = await data.pendingApprovals(ctx);
    expect(p.offersWaiting[0]).toMatchObject({ status: "pending_cbo", offeredCtc: 1300000 });
    expect(p.otherRequisitionsInApproval.map((q) => q.title)).toContain("Finance Analyst");
  });

  test("tools outside the scope are never offered", () => {
    const names = (s: ReturnType<typeof scopeFor>) => toolsFor(s).map((t) => t.name);
    expect(names(scopeFor(["recruiter"], false))).not.toContain("governance_summary");
    expect(names(scopeFor(["recruiter"], false))).not.toContain("budget_summary");
    expect(names(scopeFor([], false))).not.toContain("talent_availability");
    expect(names(scopeFor([], true))).toContain("governance_summary");
  });

  test("pool coverage counts fits for open requisitions in scope", async () => {
    const c = await data.poolCoverage(ctxOf(["hr_head"]));
    const ai = c.requisitions.find((r) => r.label.endsWith("AI Engineer"));
    expect(ai).toMatchObject({ strong: 1, demand: 1, status: "amber" });
  });
});
