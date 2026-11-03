/**
 * The Role expert interview agent's gate, against the disposable database:
 * the role's hiring manager decides; approving stores the brief and applies
 * each round's focus and rubric; a stale card is refused; the card states
 * the brief in plain words.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/expert-brief.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const { orgMembers, organizations, requisitions, users } = await import("../drizzle/schema");
const gate = await import("../src/server/agents/expert-gate.server");

const stamp = Date.now();
let orgId: string;
let hmUser: string;
let reqId: string;

const brief = {
  mustHaves: [{ skill: "Kubernetes", why: "On call for the team's 40 clusters." }],
  niceToHaves: ["Terraform"],
  dealBreakers: ["Has never carried a pager"],
  firstMonthsWork: "Own the cluster upgrade programme.",
  successAfterSixMonths: "Upgrades with no customer-visible incident.",
  screeningQuestions: [
    {
      question: "Tell me about the worst outage you handled.",
      strongAnswer: "Names the root cause and what changed afterwards.",
      weakAnswer: "Blames others.",
    },
  ],
  rounds: [{ level: 1, focus: "On-call depth", competencies: ["Kubernetes", "Incident handling"] }],
};

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  hmUser = (
    await db
      .insert(users)
      .values({ email: `xb-${stamp}@test.local` })
      .returning({ id: users.id })
  )[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Expert Org", slug: `xb-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  const [m] = await db
    .insert(orgMembers)
    .values({ orgId, userId: hmUser, email: `xb-${stamp}@test.local`, status: "active" } as never)
    .returning({ id: orgMembers.id });
  reqId = (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-XB-${stamp}`,
        title: "Platform SRE",
        status: "approved",
        mustHaveSkills: ["Kubernetes", "Terraform"],
        hiringManagerMemberId: m!.id,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, hmUser));
});

test("the role's hiring manager decides, and the card states the brief", async () => {
  const g = await gate.expertBriefGateFor(orgId, {
    type: "expert_brief",
    requisitionId: reqId,
    brief,
  });
  if ("error" in g) throw new Error(g.error);
  expect(g.assigneeUserId).toBe(hmUser);
  expect(g.role).toBeNull();
  expect(g.status).toBe("none");
  expect(g.detail).toContain("Kubernetes: On call for the team's 40 clusters.");
  expect(g.detail).toContain("Has never carried a pager");
  expect(g.detail).toContain("rates Kubernetes, Incident handling");
});

test("an incomplete brief is refused before anyone is asked", async () => {
  const g = await gate.expertBriefGateFor(orgId, {
    type: "expert_brief",
    requisitionId: reqId,
    brief: { ...brief, screeningQuestions: [] },
  });
  expect("error" in g).toBe(true);
});

test("approving stores the brief and applies the round's rubric; a stale card is refused", async () => {
  await gate.performExpertBriefGate(
    orgId,
    hmUser,
    { type: "expert_brief", requisitionId: reqId, brief, expects: "none" },
    { status: "approved" },
  );
  const [r] = await db
    .select({ brief: requisitions.expertBrief, plan: requisitions.interviewPlan })
    .from(requisitions)
    .where(eq(requisitions.id, reqId));
  expect(r!.brief?.mustHaves[0]?.skill).toBe("Kubernetes");
  expect(r!.brief?.approvedBy).toBe(hmUser);
  expect(r!.plan?.rounds[0]?.competencies).toEqual(["Kubernetes", "Incident handling"]);
  expect(r!.plan?.rounds[0]?.focus).toBe("On-call depth");
  // A card proposed before this approval no longer matches.
  await expect(
    gate.performExpertBriefGate(
      orgId,
      hmUser,
      { type: "expert_brief", requisitionId: reqId, brief, expects: "none" },
      { status: "approved" },
    ),
  ).rejects.toThrow(/changed since/);
});

test("declining stores nothing", async () => {
  const [before] = await db
    .select({ brief: requisitions.expertBrief })
    .from(requisitions)
    .where(eq(requisitions.id, reqId));
  await gate.performExpertBriefGate(
    orgId,
    hmUser,
    {
      type: "expert_brief",
      requisitionId: reqId,
      brief: { ...brief, niceToHaves: ["Go"] },
      expects: before!.brief!.approvedAt,
    },
    { status: "rejected" },
  );
  const [after] = await db
    .select({ brief: requisitions.expertBrief })
    .from(requisitions)
    .where(eq(requisitions.id, reqId));
  expect(after!.brief?.niceToHaves).toEqual(["Terraform"]);
});

test("the rounds and panel the hiring manager named reach the plan; others are flagged on the desk", async () => {
  const { hiringConversations, hiringMessages, rolePanels } = await import("../drizzle/schema");
  const { addPanelist } = await import("../src/lib/panelists.server");
  // The desk thread for this role, and someone already in the panel directory.
  const [conv] = await db
    .insert(hiringConversations)
    .values({
      orgId,
      createdBy: hmUser,
      title: "t",
      status: "active",
      requisitionId: reqId,
      slots: {},
    } as never)
    .returning({ id: hiringConversations.id });
  await addPanelist(
    orgId,
    hmUser,
    {
      fullName: "Leela Rao",
      email: `leela-${stamp}@client.example`,
      kind: "external",
      company: "Client Co",
      areas: [],
      rounds: [1],
    },
    { via: "team_page" },
  );
  const [cur] = await db
    .select({ brief: requisitions.expertBrief })
    .from(requisitions)
    .where(eq(requisitions.id, reqId));
  await gate.performExpertBriefGate(
    orgId,
    hmUser,
    {
      type: "expert_brief",
      requisitionId: reqId,
      brief: {
        ...brief,
        roundCount: 1,
        panel: [{ level: 1, people: [`LEELA-${stamp}@client.example`, "madhanagopal.p@yavar.ai"] }],
      },
      expects: cur!.brief!.approvedAt,
    },
    { status: "approved" },
  );
  const [r] = await db
    .select({ plan: requisitions.interviewPlan })
    .from(requisitions)
    .where(eq(requisitions.id, reqId));
  expect(r!.plan?.rounds).toHaveLength(1);
  const [p] = await db.select().from(rolePanels).where(eq(rolePanels.requisitionId, reqId));
  expect(p?.level).toBe(1);
  expect(p?.panelistIds).toHaveLength(1);
  const msgs = await db
    .select({ body: hiringMessages.body, card: hiringMessages.card })
    .from(hiringMessages)
    .where(eq(hiringMessages.conversationId, conv!.id));
  const told = msgs.map((m) => m.body).join("\n");
  expect(told).toMatch(/plan now has 1 round/);
  expect(told).toMatch(/L1 panel set to Leela Rao/);
  expect(told).toMatch(/Not in the panel directory yet: madhanagopal\.p@yavar\.ai \(L1\)/);
  // The updated plan comes back for the person to confirm.
  expect(msgs.some((m) => (m.card as { type?: string } | null)?.type === "interview_plan")).toBe(
    true,
  );
});
