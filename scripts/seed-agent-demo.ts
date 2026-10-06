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
const { agentRuns, agentTasks, orgMembers, organizations, userRoles, users } =
  await import("../drizzle/schema");

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

await db.insert(agentTasks).values([
  {
    orgId: org!.id,
    runId: r1,
    kind: "gate",
    title: "Approve requisition REQ-104 — Backend Engineer ×2",
    body: "Band ₹28–36 L (market median ₹31 L, 4 cited sources). Replaces 1 exit + 1 new headcount. No duplicate open requisition.",
    assigneeRole: "hr_head",
    proposedAction: { name: "request_approval", args: {} },
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

console.log(`Seeded ${DEMO_EMAIL} (org ${org!.id}); runs ${r1}, ${r2}, ${r3}`);
await sql.end();
