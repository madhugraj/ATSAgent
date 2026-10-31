/**
 * End-to-end simulation of the silent panel agents (docs/silent-panel-agent-plan.md):
 * every agent (L1, L2, L3) × every case (agree, partial, disagree), plus an
 * assessment that lands after the panel has scored — through the REAL event
 * chain, orchestrator, runtime, tools, approval cards and the HR head's
 * decision. Only the AI is simulated:
 *
 *   - the agent's turns: a well-behaved model that reads the real tool
 *     results and picks the next step (it never sees a score);
 *   - the assessment: a fixed view per candidate, so each case is certain.
 *
 * Each case checks: the hidden view is stored and never appears in the run's
 * log; the panel gets the summary; the candidate moves, moves with a review,
 * or is held; the HR head's card shows both views; the decision is carried
 * out as the HR head; the run ends. A results matrix is printed at the end.
 *
 * Run: DATABASE_URL=postgres://…/atsagent_test bun test scripts/panel-simulation.test.ts
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { AgentStepResult } from "../src/lib/ai-gateway.server";

type Msg = { role: string; content?: string; name?: string };
const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };
const say = (text: string): AgentStepResult => ({
  ok: true,
  text,
  toolCalls: [],
  stopReason: "end",
  usage,
});
let callSeq = 0;
const call = (name: string, args: unknown): AgentStepResult => ({
  ok: true,
  text: "",
  toolCalls: [{ id: `c${++callSeq}`, name, args }],
  stopReason: "tool_use",
  usage,
});

/**
 * A well-behaved panel agent: it re-reads the round after each action and
 * does the next thing the facts call for — assess, summarise, ask for a
 * review — then finishes. It acts only on what the tools return.
 */
function panelAgentModel(messages: Msg[]): AgentStepResult {
  const goal = messages.find((m) => m.role === "user")?.content ?? "";
  const round = /round ([0-9a-f-]{36})/.exec(goal)?.[1];
  if (!round) return say("No round named in the goal.");
  const tools = messages.filter((m) => m.role === "tool");
  const last = tools[tools.length - 1];
  if (!last) return call("get_round_for_panel", { interviewId: round });
  if (last.name === "request_panel_review") return say("Asked the HR head to review the round.");
  if (last.name !== "get_round_for_panel")
    return call("get_round_for_panel", { interviewId: round }); // re-read after acting
  let facts: Record<string, unknown>;
  try {
    facts = JSON.parse(last.content ?? "{}") as Record<string, unknown>;
  } catch {
    return say("Could not read the round.");
  }
  if (!String(facts["transcript"] ?? "").startsWith("in")) return say("The transcript is not in.");
  if (!facts["assessed"]) return call("assess_round", { interviewId: round });
  if (!facts["summarySent"]) return call("send_panel_summary", { interviewId: round });
  if (facts["reviewDue"]) return call("request_panel_review", { interviewId: round });
  return say("Round assessed and the panel summarised.");
}

/** The agent's own view of each candidate (the case's certain input). */
const VIEW: Record<string, { rating: number; verdict: "select" | "hold" | "reject" }> = {};

const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiAgentStep: async (opts: { messages: Msg[] }) => panelAgentModel(opts.messages),
  aiJson: async (opts: { feature: string; prompt: string }) => {
    if (opts.feature === "panel_assess") {
      const name = /Candidate: (.+)/.exec(opts.prompt)?.[1]?.trim() ?? "";
      const v = VIEW[name] ?? { rating: 3, verdict: "hold" };
      return {
        ok: true,
        model: "m",
        provider: "openai",
        usage: null,
        data: {
          candidate_speaker: name,
          rating: v.rating,
          verdict: v.verdict,
          competencies: [
            {
              name: "Kubernetes",
              rating: v.rating,
              evidence: ["I run three production clusters"],
              note: "From the call.",
            },
          ],
          strengths: ["Specific examples"],
          gaps: ["Testing not discussed"],
          open_questions: [],
          panel: { covered: ["Kubernetes"], missed: ["Go"], off_limits: [], notes: null },
          suspected_prompt_injection: false,
        },
      };
    }
    if (opts.feature === "panel_summary")
      return {
        ok: true,
        model: "m",
        provider: "openai",
        usage: null,
        data: {
          overview: "A conversation about running Kubernetes in production.",
          topics: [
            {
              topic: "Kubernetes",
              asked: "How they run clusters.",
              answered: "Three production clusters.",
            },
          ],
          suspected_prompt_injection: false,
        },
      };
    return { ok: false, status: 500, message: `no fixture for ${opts.feature}` };
  },
}));

const { db } = await import("../src/server/db");
const s = await import("../drizzle/schema");
await import("../src/server/agents");
const { runAgentTick, resolveTask } = await import("../src/server/agents/runtime.server");
const { emitAgentEvent } = await import("../src/server/agents/events");
const { submitScorecardCore } = await import("../src/lib/interviews.functions");

const stamp = Date.now();
const HR = `sim-hr-${stamp}@test.local`;
const PRIYA = `sim-priya-${stamp}@test.local`;
const ARUN = `sim-arun-${stamp}@test.local`;
let orgId: string;
let hrId: string;
let priyaId: string;
let arunId: string;
let requisitionId: string;

type Case = "agree" | "partial" | "disagree";
const results: Record<string, string>[] = [];

async function member(email: string, name: string, roles: string[]) {
  const [u] = await db.insert(s.users).values({ email }).returning({ id: s.users.id });
  await db.insert(s.orgMembers).values({
    orgId,
    userId: u!.id,
    email,
    fullName: name,
    status: "active",
    isOwner: false,
  } as never);
  for (const r of roles)
    await db.insert(s.userRoles).values({ userId: u!.id, orgId, role: r as never });
  return u!.id;
}

/** Drive the agents until nothing is left to do (events → runs → turns). */
async function drain() {
  for (let i = 0; i < 12; i++) await runAgentTick({ orgId });
}

async function seedRound(level: number, name: string) {
  const [cand] = await db
    .insert(s.candidates)
    .values({
      orgId,
      fullName: name,
      email: `${name.replace(/\s/g, ".").toLowerCase()}-${stamp}@cand.local`,
    } as never)
    .returning({ id: s.candidates.id });
  const [app] = await db
    .insert(s.applications)
    .values({ orgId, requisitionId, candidateId: cand!.id, stage: `l${level}` } as never)
    .returning({ id: s.applications.id });
  const [r] = await db
    .insert(s.interviews)
    .values({
      orgId,
      applicationId: app!.id,
      level,
      interviewer: "Priya",
      interviewerEmail: PRIYA,
      panel: [{ name: "Arun", email: ARUN }],
      scheduledAt: new Date(Date.now() - 2 * 3600_000),
      durationMins: 45,
      mode: "online",
      status: "scheduled",
      transcription: "ready",
    } as never)
    .returning({ id: s.interviews.id });
  const segments = [
    {
      speaker: "Priya",
      text: "Tell us how you run Kubernetes in production?",
      startMs: 0,
      endMs: 4000,
    },
    {
      speaker: name,
      text: "I run three production clusters and own their upgrades.",
      startMs: 5000,
      endMs: 25000,
    },
    { speaker: "Arun", text: "Which Go services have you written?", startMs: 26000, endMs: 29000 },
    {
      speaker: name,
      text: "The ingest service and a scheduler, both in Go.",
      startMs: 30000,
      endMs: 45000,
    },
  ];
  await db.insert(s.interviewTranscripts).values({
    orgId,
    interviewId: r!.id,
    applicationId: app!.id,
    provider: "teams",
    segments,
    segmentCount: segments.length,
  });
  return { applicationId: app!.id, interviewId: r!.id };
}

const transcriptReady = (x: { applicationId: string; interviewId: string }, level: number) =>
  emitAgentEvent({
    orgId,
    type: "interview.transcript_ready",
    subjectType: "application",
    subjectId: x.applicationId,
    actorUserId: null,
    payload: { interviewId: x.interviewId, level, requisitionId },
  });

async function scorecards(
  x: { applicationId: string; interviewId: string },
  level: number,
  cards: [number, "select" | "hold" | "reject"][],
) {
  let last: Awaited<ReturnType<typeof submitScorecardCore>> | null = null;
  for (const [i, [rating, verdict]] of cards.entries()) {
    const [userId, email] = i === 0 ? [priyaId, PRIYA] : [arunId, ARUN];
    last = await submitScorecardCore(
      { orgId, userId, email, actor: email },
      {
        applicationId: x.applicationId,
        interviewId: x.interviewId,
        level,
        rating,
        verdict,
        comments: verdict === "select" ? "Good depth." : "Not enough depth for the role.",
        competencies: [],
      },
    );
  }
  return last!;
}

const stageOf = async (applicationId: string) =>
  (
    await db
      .select({ v: s.applications.stage })
      .from(s.applications)
      .where(eq(s.applications.id, applicationId))
  )[0]!.v;
const assessment = async (interviewId: string) =>
  (
    await db
      .select()
      .from(s.panelAssessments)
      .where(eq(s.panelAssessments.interviewId, interviewId))
  )[0];
const runsFor = async (applicationId: string, agentType: string) =>
  db
    .select()
    .from(s.agentRuns)
    .where(
      and(
        eq(s.agentRuns.orgId, orgId),
        eq(s.agentRuns.subjectId, applicationId),
        eq(s.agentRuns.agentType, agentType as never),
      ),
    );
const openReviewCard = async (applicationId: string, agentType: string) => {
  const runIds = (await runsFor(applicationId, agentType)).map((r) => r.id);
  if (!runIds.length) return undefined;
  return (
    await db
      .select()
      .from(s.agentTasks)
      .where(
        and(
          inArray(s.agentTasks.runId, runIds),
          eq(s.agentTasks.status, "open"),
          eq(s.agentTasks.kind, "gate"),
        ),
      )
  )[0];
};

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [o] = await db
    .insert(s.organizations)
    .values({ name: "Panel Simulation Org", slug: `sim-${stamp}`, status: "active" })
    .returning({ id: s.organizations.id });
  orgId = o!.id;
  hrId = await member(HR, "Saranya (HR head)", ["hr_head"]);
  priyaId = await member(PRIYA, "Priya", ["hiring_manager"]);
  arunId = await member(ARUN, "Arun", ["recruiter"]);
  const plan = {
    verdictPolicy: "recommend",
    rounds: [1, 2, 3].map((level) => ({
      level,
      name: `Round ${level}`,
      focus: "",
      competencies: ["Kubernetes", "Go"],
      panelSize: 2,
    })),
  };
  const [req] = await db
    .insert(s.requisitions)
    .values({
      orgId,
      code: `SIM-${stamp}`,
      title: "Platform SRE",
      status: "approved",
      mustHaveSkills: ["Kubernetes", "Go"],
      interviewPlan: plan,
      createdBy: hrId,
    } as never)
    .returning({ id: s.requisitions.id });
  requisitionId = req!.id;
  // The three agents on, as recommended: act and notify, the panel summary pre-approved.
  for (const level of [1, 2, 3])
    await db.insert(s.agentPolicies).values({
      orgId,
      agentType: `panel_l${level}`,
      enabled: true,
      autonomy: "act_and_notify",
      whitelistedTemplates: ["panel_summary"],
    } as never);
});

afterAll(async () => {
  console.log("\nSilent panel agents — simulation results\n");

  console.table(results);
  await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
  for (const id of [hrId, priyaId, arunId]) await db.delete(s.users).where(eq(s.users.id, id));
});

/**
 * One case for one agent. The agent's view and the panel's scores are chosen
 * so the case is certain:
 *   agree     agent 4 select   · panel 4 + 5 select     (same verdict, within 1)
 *   partial   agent 4 select   · panel 2 + 2 select     (same verdict, 2 apart)
 *   disagree  agent 1 reject   · panel 5 + 5 select     (opposite verdicts)
 */
const SETUP: Record<
  Case,
  {
    view: { rating: number; verdict: "select" | "hold" | "reject" };
    panel: [number, "select" | "hold" | "reject"][];
  }
> = {
  agree: {
    view: { rating: 4, verdict: "select" },
    panel: [
      [4, "select"],
      [5, "select"],
    ],
  },
  partial: {
    view: { rating: 4, verdict: "select" },
    panel: [
      [2, "select"],
      [2, "select"],
    ],
  },
  disagree: {
    view: { rating: 1, verdict: "reject" },
    panel: [
      [5, "select"],
      [5, "select"],
    ],
  },
};

/** What the HR head decides on each card in the simulation. */
const HR_DECISION: Record<
  string,
  { status: "approved" } | { status: "rejected"; reason: string; rejectCandidate?: boolean }
> = {
  "1:partial": { status: "approved" },
  "2:partial": {
    status: "rejected",
    reason: "Stop: the panel's own ratings are low; talk to them first.",
  },
  "3:partial": { status: "approved" },
  "1:disagree": { status: "approved" },
  "2:disagree": {
    status: "rejected",
    reason: "The call shows no production depth.",
    rejectCandidate: true,
  },
  "3:disagree": { status: "rejected", reason: "Hold until the hiring manager re-interviews." },
};

for (const level of [1, 2, 3] as const) {
  describe(`L${level} panel agent`, () => {
    for (const c of ["agree", "partial", "disagree"] as const) {
      test(`${c}`, async () => {
        const agent = `panel_l${level}`;
        const name = `Cand L${level} ${c}`;
        VIEW[name] = SETUP[c].view;
        const x = await seedRound(level, name);
        const final = level === 3;

        // 1. The call's transcript is in: the level's agent reads it.
        await transcriptReady(x, level);
        await drain();
        const assessRuns = await runsFor(x.applicationId, agent);
        expect(assessRuns.map((r) => r.status)).toEqual(["done"]);
        const a = await assessment(x.interviewId);
        expect(a).toMatchObject({
          level,
          rating: SETUP[c].view.rating,
          verdict: SETUP[c].view.verdict,
        });
        expect(a!.summarySentAt).not.toBeNull();
        // Hidden: the run's own log never carries the score or verdict.
        const steps = await db
          .select()
          .from(s.agentSteps)
          .where(eq(s.agentSteps.runId, assessRuns[0]!.id));
        const log = JSON.stringify(steps.map((st) => [st.input, st.output]));
        // (The log is real: it holds the tools' results — counts, facts, the summary send.)
        expect(steps.length).toBeGreaterThanOrEqual(5);
        expect(log).toContain("competenciesAssessed");
        expect(log).toContain("sentTo");
        expect(log).not.toMatch(/"rating"|"verdict"|"select"|"reject"/);
        // The panel got the same factual summary, once each.
        const mails = await db
          .select({ to: s.emailOutbox.toEmail })
          .from(s.emailOutbox)
          .where(
            and(
              eq(s.emailOutbox.applicationId, x.applicationId),
              eq(s.emailOutbox.kind, "panel_summary"),
            ),
          );
        expect(mails.map((m) => m.to).sort()).toEqual([ARUN, PRIYA].sort());

        // 2. The panel scores. The last scorecard triggers the comparison.
        const res = await scorecards(x, level, SETUP[c].panel);
        expect(res.panelCheck).toBe(c);
        const afterScore = await stageOf(x.applicationId);
        const held = Boolean((await assessment(x.interviewId))!.held);
        if (c === "agree") {
          // The panel's verdict stands exactly as before.
          expect(afterScore).toBe(final ? `l${level}` : `l${level + 1}`);
          expect(held).toBe(false);
        } else if (c === "partial") {
          expect(afterScore).toBe(final ? `l${level}` : `l${level + 1}`);
          expect(held).toBe(false);
        } else {
          // Disagree: held where something would move; the final round never moves on its own.
          expect(afterScore).toBe(`l${level}`);
          expect(held).toBe(!final);
          if (!final) expect(res.blocked).toContain("On hold for the HR head");
        }

        // 3. Partial / disagree: the agent asks the HR head; agree: nothing is raised.
        await drain();
        const card = await openReviewCard(x.applicationId, agent);
        let decision = "—";
        let afterDecision = afterScore;
        if (c === "agree") {
          expect(card).toBeUndefined();
        } else {
          expect(card).toBeDefined();
          expect(card!.assigneeRole).toBe("hr_head");
          expect(card!.body).toContain("The panel — verdict select");
          expect(card!.body).toContain(
            `The L${level} panel agent, from the call's transcript — ${SETUP[c].view.verdict}`,
          );
          expect(card!.body).toContain("How the round was run (for the HR head only)");

          // 4. The HR head decides; it is carried out as them, and the run ends.
          const d = HR_DECISION[`${level}:${c}`]!;
          await resolveTask({ orgId, taskId: card!.id, userId: hrId, decision: d });
          await drain();
          afterDecision = await stageOf(x.applicationId);
          const reviewed = (await assessment(x.interviewId))!.reviewDecision;
          decision = reviewed ?? "?";
          if (d.status === "approved") {
            expect(reviewed).toBe(held ? "go_with_panel" : "confirmed");
            expect(afterDecision).toBe(held ? `l${level + 1}` : afterScore);
          } else if ("rejectCandidate" in d && d.rejectCandidate) {
            expect(reviewed).toBe("rejected");
            expect(afterDecision).toBe("rejected");
          } else {
            expect(reviewed).toBe("held");
            expect(afterDecision).toBe("on_hold");
            // Stopped before the next round: it is cancelled, not left to run.
            const next = await db
              .select({ status: s.interviews.status })
              .from(s.interviews)
              .where(
                and(
                  eq(s.interviews.applicationId, x.applicationId),
                  eq(s.interviews.level, level + 1),
                ),
              );
            for (const n of next) expect(n.status).toBe("cancelled");
          }
          const audit = await db
            .select()
            .from(s.auditLog)
            .where(
              and(
                eq(s.auditLog.entityId, x.interviewId),
                eq(s.auditLog.action, "panel_review.decided"),
              ),
            );
          expect(audit).toHaveLength(1);
        }
        const runs = await runsFor(x.applicationId, agent);
        for (const r of runs) expect(r.status).toBe("done");

        results.push({
          agent: `L${level}`,
          case: c,
          "agent view": `${SETUP[c].view.rating}/5 ${SETUP[c].view.verdict}`,
          panel: SETUP[c].panel.map(([r, v]) => `${r} ${v}`).join(", "),
          "after scorecards": `${afterScore}${held ? " (held)" : ""}`,
          "HR card": c === "agree" ? "none" : "raised",
          "HR decision": decision,
          "final stage": afterDecision,
          "agent runs": `${runs.length} done`,
        });
      });
    }
  });
}

describe("late assessment", () => {
  test("L2: the panel scored before the transcript came in — compared on arrival, card raised in the same run", async () => {
    const level = 2;
    const name = "Cand L2 late";
    VIEW[name] = { rating: 1, verdict: "reject" };
    const x = await seedRound(level, name);
    const res = await scorecards(x, level, [
      [5, "select"],
      [5, "select"],
    ]);
    expect(res.panelCheck).toBeUndefined(); // nothing to compare yet
    expect(await stageOf(x.applicationId)).toBe("l3");
    await transcriptReady(x, level);
    await drain();
    const a = await assessment(x.interviewId);
    expect(a).toMatchObject({ outcome: "disagree", held: false });
    const card = await openReviewCard(x.applicationId, "panel_l2");
    expect(card).toBeDefined();
    await resolveTask({
      orgId,
      taskId: card!.id,
      userId: hrId,
      decision: { status: "rejected", reason: "Stop before L3: the call shows no depth." },
    });
    await drain();
    expect(await stageOf(x.applicationId)).toBe("on_hold");
    results.push({
      agent: "L2",
      case: "late disagree",
      "agent view": "1/5 reject",
      panel: "5 select, 5 select",
      "after scorecards": "l3 (moved before the view existed)",
      "HR card": "raised",
      "HR decision": "held",
      "final stage": "on_hold",
      "agent runs": `${(await runsFor(x.applicationId, "panel_l2")).length} done`,
    });
  });
});
