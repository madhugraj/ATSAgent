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
  applications,
  candidates,
  evaluations,
  matchScores,
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

const run = async (
  agentType: "requisition" | "jd" | "screening" | "intake" | "evaluation",
  goal: string,
  status: string,
) =>
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

// An approved role with held candidates, for the intake rejection batch and
// the screening approval below.
const [req098] = await db
  .insert(requisitions)
  .values({
    orgId: org!.id,
    code: "REQ-2026-098",
    title: "Platform SRE",
    location: "Bengaluru",
    openings: 1,
    experienceMin: 4,
    experienceMax: 8,
    mustHaveSkills: ["Kubernetes", "Go"],
    status: "approved",
    createdBy: user!.id,
  })
  .returning({ id: requisitions.id });
const applicant = async (name: string, stage: string, score: number, skills: string[]) => {
  const [c] = await db
    .insert(candidates)
    .values({
      orgId: org!.id,
      fullName: name,
      email: `${name.toLowerCase().replace(/\s/g, ".")}@demo-candidate.test`,
      skills,
    })
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({
      orgId: org!.id,
      requisitionId: req098!.id,
      candidateId: c!.id,
      stage: stage as never,
      source: "apply",
    })
    .returning({ id: applications.id });
  await db.insert(matchScores).values({
    orgId: org!.id,
    applicationId: a!.id,
    overallScore: score,
    recommendation: score >= 75 ? "select" : score >= 60 ? "hold" : "reject",
    rationale: `Demo score ${score}/100`,
  } as never);
  return a!.id;
};
const shortlistedApp = await applicant("Meera Iyer", "shortlisted", 84, ["Kubernetes", "Go"]);
const heldA = await applicant("Arjun Rao", "ai_screened", 41, ["PHP", "MySQL"]);
const heldB = await applicant("Kiran Das", "ai_screened", 38, ["Excel"]);
const finalist = await applicant("Sana Kapoor", "l3", 86, ["Kubernetes", "Go", "Terraform"]);
await db.insert(evaluations).values([
  {
    orgId: org!.id,
    applicationId: finalist,
    level: 1,
    rating: 4,
    recommendation: "select",
    evaluator: "lead.engineer@demo-org.test",
    comments: "Strong Kubernetes depth; designed a sensible multi-region failover.",
  },
  {
    orgId: org!.id,
    applicationId: finalist,
    level: 2,
    rating: 4,
    recommendation: "select",
    evaluator: "platform.head@demo-org.test",
    comments: "Good incident leadership; clear post-mortem culture.",
  },
  {
    orgId: org!.id,
    applicationId: finalist,
    level: 3,
    rating: 3,
    recommendation: "select",
    evaluator: "cto@demo-org.test",
    comments: "Solid; would like more evidence of cost ownership.",
  },
] as never);
const r4 = await run(
  "intake",
  `Review the pipeline for REQ-2026-098 "Platform SRE"`,
  "awaiting_human",
);
await db
  .update(agentRuns)
  .set({ subjectType: "requisition", subjectId: req098!.id })
  .where(eq(agentRuns.id, r4));

const r5 = await run(
  "evaluation",
  "Debrief Sana Kapoor after L3 and ask for the hiring decision",
  "awaiting_human",
);
await db
  .update(agentRuns)
  .set({ subjectType: "application", subjectId: finalist })
  .where(eq(agentRuns.id, r5));
await db.insert(agentTasks).values([
  {
    orgId: org!.id,
    runId: r5,
    kind: "gate",
    title: "Hiring decision: Sana Kapoor — Platform SRE",
    body: [
      "Consistent select across three rounds (4, 4, 3 out of 5); the only open point is cost ownership.",
      "",
      "Hiring decision for Sana Kapoor (REQ-2026-098 Platform SRE, l3).",
      "Recommendation: SELECT",
      "Rationale: Select verdicts in all three rounds (4/5, 4/5, 3/5); Kubernetes and incident leadership evidenced; cost ownership to probe at offer stage.",
      "",
      "Approve to accept this recommendation; decline to leave the candidate where they are.",
    ].join("\n"),
    assigneeRole: "hiring_manager",
    proposedAction: {
      name: "request_approval",
      args: {
        subject: {
          type: "hiring_decision",
          applicationId: finalist,
          recommendation: "select",
          rationale:
            "Select verdicts in all three rounds (4/5, 4/5, 3/5); Kubernetes and incident leadership evidenced; cost ownership to probe at offer stage.",
          expects: "l3",
        },
      },
    },
  },
  {
    orgId: org!.id,
    runId: r4,
    kind: "gate",
    title: "Reject 2 candidates for REQ-2026-098 Platform SRE",
    body: [
      "Both are well below the shortlist bar and miss the must-have skills.",
      "",
      "Candidates to reject (2):",
      "• Arjun Rao (REQ-2026-098, ai_screened) — Missing must-haves Kubernetes and Go; 41/100",
      "• Kiran Das (REQ-2026-098, ai_screened) — Missing must-haves Kubernetes and Go; 38/100",
    ].join("\n"),
    assigneeUserId: user!.id,
    proposedAction: {
      name: "request_approval",
      args: {
        subject: {
          type: "rejection",
          items: [
            {
              applicationId: heldA,
              reason: "Missing must-haves Kubernetes and Go",
              expects: "ai_screened",
            },
            {
              applicationId: heldB,
              reason: "Missing must-haves Kubernetes and Go",
              expects: "ai_screened",
            },
          ],
        },
      },
    },
  },
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
      args: { applicationId: shortlistedApp, dueInDays: 3 },
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
// Observability demo: realistic activity for the dashboard and the health
// engine — AI usage linked to runs, a burst of tool failures, failed runs, an
// overdue human request and a failed lifecycle event. Local demo data only.
{
  const { agentEvents, agentPolicies, aiUsageEvents } = await import("../drizzle/schema");
  await db.insert(agentPolicies).values([
    { orgId: org!.id, agentType: "requisition", enabled: true, autonomy: "suggest" },
    {
      orgId: org!.id,
      agentType: "intake",
      enabled: true,
      autonomy: "suggest",
      monthlyTokenBudget: 60000,
    },
    { orgId: org!.id, agentType: "screening", enabled: true, autonomy: "act_and_notify" },
    { orgId: org!.id, agentType: "evaluation", enabled: true, autonomy: "suggest" },
  ]);
  const ago = (h: number) => new Date(Date.now() - h * 3600_000);
  const ai = (
    runId: string,
    feature: string,
    n: number,
    opts: { errors?: number; ms?: number } = {},
  ) =>
    db.insert(aiUsageEvents).values(
      Array.from({ length: n }, (_, i) => ({
        orgId: org!.id,
        agentRunId: runId,
        feature,
        provider: "demo",
        model: "demo",
        status: (i < (opts.errors ?? 0) ? "error" : "ok") as never,
        promptTokens: 900,
        completionTokens: 250,
        totalTokens: 1150,
        durationMs: (opts.ms ?? 4200) + i * 300,
        createdAt: ago(1 + i),
      })),
    );
  await ai(r1, "agent_requisition", 6);
  await ai(r1, "market_benchmark", 2, { ms: 21000 });
  await ai(r2, "agent_jd", 4);
  await ai(r2, "jd_generate", 2, { ms: 9000 });
  await ai(r3, "agent_screening", 5);
  await ai(r4, "agent_intake", 8, { errors: 3 });
  await ai(r4, "candidate_score", 10, { ms: 7000 });
  // Screening: a burst of tool failures in the last 24 h (12 calls, 4 errors).
  await db.insert(agentSteps).values(
    Array.from({ length: 12 }, (_, i) => ({
      runId: r3,
      orgId: org!.id,
      seq: 100 + i,
      kind: "tool",
      toolName: i % 3 === 0 ? "prepare_screening_kit" : "get_screening_status",
      status: i % 3 === 0 ? "error" : "ok",
      output: (i % 3 === 0
        ? { error: "No job description text for this role yet." }
        : { preview: "ok" }) as never,
      durationMs: 300,
      createdAt: ago(2 + i),
    })),
  );
  // Intake: three runs that failed today, and a backlog of history over 14 days.
  for (let d = 0; d < 14; d++) {
    const count = [2, 0, 1, 3, 1, 0, 2, 4, 1, 2, 3, 1, 2, 3][d]!;
    for (let k = 0; k < count; k++) {
      const failed = d === 13 && k < 3;
      const created = new Date(Date.now() - (13 - d) * 864e5 - (k + 1) * 3600_000);
      const [hist] = await db
        .insert(agentRuns)
        .values({
          orgId: org!.id,
          agentType: "intake",
          principalUserId: user!.id,
          goal: `Review the pipeline for REQ-2026-098 (sweep ${d}-${k})`,
          status: failed ? "failed" : "done",
          lastError: failed ? "The tool failed." : null,
          result: failed ? null : "Scored new applicants; proposed rejections for review.",
          stepCount: 5 + k,
          tokensUsed: 5200,
          createdAt: created,
          startedAt: created,
          finishedAt: new Date(created.getTime() + (6 + k) * 60_000),
        })
        .returning({ id: agentRuns.id });
      // Its trail: tool calls, AI requests and one decided approval, so the
      // 14-day trend charts have history (demo data, deterministic).
      const at = (min: number) => new Date(created.getTime() + min * 60_000);
      await db.insert(agentSteps).values(
        ["list_applications", "score_application", "shortlist"].map((tool, i) => ({
          runId: hist!.id,
          orgId: org!.id,
          seq: i + 1,
          kind: "tool",
          toolName: tool,
          status: failed && i === 2 ? "error" : (d + k + i) % 9 === 0 ? "error" : "ok",
          output: { preview: "demo" } as never,
          durationMs: 250 + i * 120,
          createdAt: at(i + 1),
        })),
      );
      await db.insert(aiUsageEvents).values(
        [0, 1].map((i) => ({
          orgId: org!.id,
          agentRunId: hist!.id,
          feature: i ? "candidate_score" : "agent_intake",
          provider: "demo",
          model: "demo",
          status: "ok" as never,
          promptTokens: 1800,
          completionTokens: 400,
          totalTokens: 2200,
          durationMs: 3500 + ((d * 7 + k * 3 + i * 5) % 11) * 900,
          createdAt: at(2 + i),
        })),
      );
      if (!failed) {
        const waitH = [3, 9, 26, 5, 14, 40, 7, 2, 19, 11, 31, 4, 8, 16][(d + k) % 14]!;
        const outcome = (d + k) % 7 === 0 ? "rejected" : "approved";
        await db.insert(agentTasks).values({
          orgId: org!.id,
          runId: hist!.id,
          kind: "approval",
          status: outcome,
          title: "Shortlist the top-scored applicants",
          proposedAction: { name: "shortlist", args: {} } as never,
          response: (outcome === "rejected"
            ? { status: "rejected", reason: "Wait for the referral to apply." }
            : (d + k) % 5 === 0
              ? { status: "approved", args: { note: "edited" } }
              : { status: "approved" }) as never,
          decidedBy: user!.id,
          createdAt: at(5),
          decidedAt: new Date(Math.min(at(5).getTime() + waitH * 3600_000, Date.now() - 600_000)),
        });
      }
    }
  }
  // A question nobody has answered for three days (past the 48 h SLA).
  await db
    .update(agentTasks)
    .set({ createdAt: ago(72) })
    .where(eq(agentTasks.kind, "clarification"));
  // A lifecycle event the orchestrator could not process.
  await db.insert(agentEvents).values({
    orgId: org!.id,
    type: "requisition.status_changed",
    subjectType: "requisition",
    subjectId: req104!.id,
    status: "failed",
    attempts: 3,
    lastError: "Demo: event handler failed",
  });
  const { evaluateAgentHealth } = await import("../src/server/agents/health.server");
  await evaluateAgentHealth({ orgId: org!.id });
}

const { rollupAgentMetrics } = await import("../src/server/agents/metrics.server");
await rollupAgentMetrics();

console.log(`Seeded ${DEMO_EMAIL} (org ${org!.id}); runs ${r1}, ${r2}, ${r3}`);
await sql.end();
