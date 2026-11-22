/**
 * Agent alert e-mail volume (src/server/agents/alerts.server.ts): serious
 * issues wait for one end-of-day table per person; critical ones go at once
 * but at most once per rule per day; a flapping issue does not resolve and
 * reopen on every sweep (health.server.ts resolveAfterMinutes).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, like } from "drizzle-orm";

const { db } = await import("../src/server/db");
const { agentIssues, emailOutbox, orgMembers, organizations, users } =
  await import("../drizzle/schema");
const { dispatchAgentAlerts, dispatchAgentDigests, localDayHour } =
  await import("../src/server/agents/alerts.server");
const { evaluateAgentHealth } = await import("../src/server/agents/health.server");

const stamp = Date.now();
const ownerEmail = `digest-owner-${stamp}@test.local`;
let orgId: string;
let userId: string;
// Org time zone defaults to Asia/Kolkata (UTC+5:30).
const beforeEod = new Date("2026-11-22T10:00:00Z"); // 15:30 IST
const afterEod = new Date("2026-11-22T13:00:00Z"); // 18:30 IST

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db.insert(users).values({ email: ownerEmail }).returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Digest Org", slug: `digest-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  await db
    .insert(orgMembers)
    .values({ orgId, userId, email: ownerEmail, status: "active", isOwner: true });
});

afterAll(async () => {
  await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await db.delete(agentIssues).where(eq(agentIssues.orgId, orgId));
  await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgId));
});

const issue = (rule: string, severity: "serious" | "critical", agentType = "offer") =>
  db
    .insert(agentIssues)
    .values({ orgId, agentType, element: "harness", rule, severity, title: `${rule} title` })
    .returning({ id: agentIssues.id });
const mail = (prefix: string) =>
  db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.orgId, orgId), like(emailOutbox.idempotencyKey, `${prefix}%`)));

describe("immediate alerts", () => {
  test("a serious issue is not e-mailed straight away", async () => {
    await issue("context.policy_waiting_past_effective", "serious");
    expect((await dispatchAgentAlerts({ orgId })).alerted).toBe(1);
    expect(await mail("agent-issue:")).toHaveLength(0);
  });

  test("a critical issue is e-mailed once; the same rule reopening that day is not", async () => {
    await issue("harness.stuck_run", "critical", "intake");
    await dispatchAgentAlerts({ orgId });
    expect(await mail("agent-issue:")).toHaveLength(1);
    await db
      .update(agentIssues)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(agentIssues.orgId, orgId));
    await issue("harness.stuck_run", "critical", "intake");
    await dispatchAgentAlerts({ orgId });
    expect(await mail("agent-issue:")).toHaveLength(1);
  });
});

describe("end-of-day digest", () => {
  test("nothing before the digest hour; one table per person after; once per day", async () => {
    await issue("context.policy_waiting_past_effective", "serious");
    await issue("harness.stuck_run", "critical", "*");
    expect((await dispatchAgentDigests(beforeEod, { orgId })).digests).toBe(0);
    expect((await dispatchAgentDigests(afterEod, { orgId })).digests).toBe(1);
    const sent = await mail("agent-digest:");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.toEmail).toBe(ownerEmail);
    expect(sent[0]!.templateName).toBe("agent_digest");
    const rows = JSON.parse(sent[0]!.templateData!["issuesJson"]!) as { severity: string }[];
    expect(rows.map((r) => r.severity)).toEqual(["critical", "serious"]);
    expect((await dispatchAgentDigests(afterEod, { orgId })).digests).toBe(0);
    expect(await mail("agent-digest:")).toHaveLength(1);
  });

  test("no open serious issue, no digest", async () => {
    const [i] = await issue("context.policy_waiting_past_effective", "serious");
    await db.update(agentIssues).set({ status: "resolved" }).where(eq(agentIssues.id, i!.id));
    expect((await dispatchAgentDigests(afterEod, { orgId })).digests).toBe(0);
  });

  test("local day and hour follow the time zone", () => {
    expect(localDayHour(afterEod, "Asia/Kolkata")).toEqual({ day: "2026-11-22", hour: 18 });
    expect(localDayHour(afterEod, "Not/AZone")).toEqual({ day: "2026-11-22", hour: 13 });
  });
});

describe("flapping", () => {
  test("an issue unseen for less than the grace period stays open on the sweep", async () => {
    await issue("context.policy_waiting_past_effective", "serious");
    // The rule does not fire for this test org; the issue was just seen.
    await evaluateAgentHealth({ orgId, resolveAfterMinutes: 60 });
    const [row] = await db.select().from(agentIssues).where(eq(agentIssues.orgId, orgId));
    expect(row!.status).toBe("open");
    await evaluateAgentHealth({ orgId, resolveAfterMinutes: 0 });
    const [after] = await db.select().from(agentIssues).where(eq(agentIssues.orgId, orgId));
    expect(after!.status).toBe("resolved");
  });
});
