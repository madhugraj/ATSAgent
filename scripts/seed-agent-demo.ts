/**
 * Seeds a local demo for the agent UI (Decisions inbox, activity, settings):
 * one active organisation, an owner login, and sample agent runs + tasks.
 * Local databases only.
 *
 *   DATABASE_URL=postgres://...127.0.0.1... SESSION_SECRET=... bun scripts/seed-agent-demo.ts
 *
 * Demo login (local only): agent-demo@test.local / AgentDemo#2026
 */
import { eq } from "drizzle-orm";

const DEMO_EMAIL = "agent-demo@test.local";
const DEMO_PASSWORD = "AgentDemo#2026";

const url = process.env.DATABASE_URL ?? "";
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to seed a non-local database");
}

const { db, sql } = await import("../src/server/db");
const { hashPassword } = await import("../src/server/password");
const {
  agentRuns,
  agentSteps,
  agentTasks,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");

const [existing] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL));
if (existing) await db.delete(users).where(eq(users.id, existing.id));
await db.delete(organizations).where(eq(organizations.slug, "agent-demo"));

const [user] = await db
  .insert(users)
  .values({
    email: DEMO_EMAIL,
    fullName: "Agent Demo",
    passwordHash: await hashPassword(DEMO_PASSWORD),
    emailConfirmedAt: new Date(),
  })
  .returning();
const [org] = await db
  .insert(organizations)
  .values({ name: "Agent Demo Org", slug: "agent-demo", status: "active", approvedAt: new Date() })
  .returning();
await db.insert(orgMembers).values({
  orgId: org!.id,
  userId: user!.id,
  email: DEMO_EMAIL,
  status: "active",
  isOwner: true,
  joinedAt: new Date(),
});
await db.insert(userRoles).values({ userId: user!.id, orgId: org!.id, role: "hr_head" });

const run = async (agentType: "requisition" | "jd" | "screening", goal: string, status: string) =>
  (
    await db
      .insert(agentRuns)
      .values({
        orgId: org!.id,
        agentType,
        principalUserId: user!.id,
        goal,
        status: status as never,
        stepCount: 3,
        tokensUsed: 4210,
        ...(status === "done"
          ? {
              result: "Drafted the JD from the Platform template and sent it for DH approval.",
              finishedAt: new Date(),
            }
          : {}),
      })
      .returning({ id: agentRuns.id })
  )[0]!.id;

const r1 = await run(
  "requisition",
  "Open 2 backend engineer roles for the Bengaluru platform team",
  "awaiting_human",
);
const r2 = await run("jd", "Draft the JD for Senior SRE", "done");
const r3 = await run(
  "screening",
  "Send the assessment to the 5 shortlisted SRE candidates",
  "awaiting_human",
);

// A real requisition waiting for Department Head approval: approving the gate
// below in the inbox performs that approval (the demo owner passes role checks).
const [req104] = await db
  .insert(requisitions)
  .values({
    orgId: org!.id,
    code: "REQ-2026-104",
    title: "Backend Engineer",
    location: "Bengaluru",
    openings: 2,
    experienceMin: 4,
    experienceMax: 8,
    budgetCtc: "3100000",
    ctcBandMin: "2800000",
    ctcBandMax: "3600000",
    mustHaveSkills: ["Go", "PostgreSQL", "Kubernetes"],
    goodToHaveSkills: ["Kafka"],
    status: "pending_dh",
    createdBy: user!.id,
    approvalTrail: [
      {
        from: "draft",
        to: "pending_dh",
        actor: DEMO_EMAIL,
        decision: "pending_dh",
        comment: "Submitted by the requisition agent.",
        at: new Date().toISOString(),
        via: "agent",
      },
    ] as never,
  })
  .returning({ id: requisitions.id });

await db.insert(agentTasks).values([
  {
    orgId: org!.id,
    runId: r1,
    kind: "gate",
    title: "Approve requisition REQ-104 — Backend Engineer ×2",
    body: "Band ₹28–36 L (market median ₹31 L, 4 cited sources). Replaces 1 exit + 1 new headcount. No duplicate open requisition.",
    assigneeRole: "department_head",
    proposedAction: {
      name: "request_approval",
      args: { subject: { type: "requisition", id: req104!.id, expects: "pending_dh" } },
    },
  },
  {
    orgId: org!.id,
    runId: r3,
    kind: "approval",
    title: "Send the SRE assessment to 5 candidates",
    assigneeUserId: user!.id,
    proposedAction: {
      toolCallId: "c1",
      name: "send_assessment",
      args: { requisition: "REQ-098", candidates: 5, template: "assessment_invite", dueInDays: 3 },
    },
  },
  {
    orgId: org!.id,
    runId: r1,
    kind: "clarification",
    title: "The agent has a question",
    body: "Should the second opening be remote-friendly, or Bengaluru office only?",
    assigneeUserId: user!.id,
  },
]);

// A believable step trail per run, so the run inspector and tiles have data.
const trail = (
  runId: string,
  steps: { kind: string; tool?: string; status: string; output: unknown; tokens?: number }[],
) =>
  db.insert(agentSteps).values(
    steps.map((x, i) => ({
      runId,
      orgId: org!.id,
      seq: i + 1,
      kind: x.kind,
      toolName: x.tool ?? null,
      status: x.status,
      output: x.output as never,
      promptTokens: x.tokens ?? 0,
      completionTokens: x.tokens ? Math.round(x.tokens / 5) : 0,
      durationMs: x.kind === "model" ? 1800 + i * 150 : 120,
    })),
  );
await trail(r1, [
  { kind: "model", status: "ok", output: { toolCalls: ["find_similar_roles"] }, tokens: 1400 },
  {
    kind: "tool",
    tool: "find_similar_roles",
    status: "ok",
    output: { preview: "2 similar roles last quarter" },
  },
  { kind: "model", status: "ok", output: { toolCalls: ["research_compensation"] }, tokens: 1600 },
  {
    kind: "tool",
    tool: "research_compensation",
    status: "ok",
    output: { preview: "median ₹31 L, 4 sources" },
  },
  {
    kind: "model",
    status: "ok",
    output: { toolCalls: ["ask_human", "request_approval"] },
    tokens: 900,
  },
  { kind: "tool", tool: "ask_human", status: "awaiting", output: { note: "remote or office?" } },
  {
    kind: "tool",
    tool: "request_approval",
    status: "awaiting",
    output: { note: "routed to HR head" },
  },
]);
await trail(r2, [
  { kind: "model", status: "ok", output: { toolCalls: ["get_template"] }, tokens: 1100 },
  {
    kind: "tool",
    tool: "get_template",
    status: "ok",
    output: { preview: "Platform JD template v3" },
  },
  { kind: "model", status: "ok", output: { toolCalls: ["generate_jd"] }, tokens: 2300 },
  {
    kind: "tool",
    tool: "generate_jd",
    status: "error",
    output: { error: "Template field missing: team size" },
  },
  { kind: "model", status: "ok", output: { toolCalls: ["generate_jd"] }, tokens: 2100 },
  {
    kind: "tool",
    tool: "generate_jd",
    status: "ok",
    output: { preview: "JD drafted (612 words)" },
  },
  {
    kind: "model",
    status: "ok",
    output: { text: "Drafted the JD and sent it for DH approval." },
    tokens: 600,
  },
]);
await trail(r3, [
  { kind: "model", status: "ok", output: { toolCalls: ["list_applications"] }, tokens: 1200 },
  { kind: "tool", tool: "list_applications", status: "ok", output: { preview: "5 shortlisted" } },
  { kind: "model", status: "ok", output: { toolCalls: ["send_assessment"] }, tokens: 800 },
  {
    kind: "tool",
    tool: "send_assessment",
    status: "awaiting",
    output: { note: "needs approval (Suggest)" },
  },
]);
const { rollupAgentMetrics } = await import("../src/server/agents/metrics.server");
await rollupAgentMetrics();

console.log(`Seeded ${DEMO_EMAIL} (org ${org!.id}); runs ${r1}, ${r2}, ${r3}`);
await sql.end();
