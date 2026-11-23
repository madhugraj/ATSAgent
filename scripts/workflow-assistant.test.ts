/**
 * Workflow assistant (docs/agent-workflows.md § Build with chat): model output
 * becomes a builder graph with safe ids and a layout, the same graph rules and
 * dry run the Test button uses judge it, and one repair turn is given when the
 * first draft does not pass. The model is scripted; nothing is saved.
 */
import { describe, expect, mock, test } from "bun:test";

const replies: unknown[] = [];
const calls: { prompt: string; feature: string; orgId: string }[] = [];
const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiJson: async (o: { prompt: string; feature: string; orgId: string }) => {
    calls.push(o);
    return { ok: true, data: replies.shift(), model: "m", provider: "openai", usage: null };
  },
}));

const { normalizeDraft, checkDraft, draftWorkflow, ModelDraft } =
  await import("../src/server/agents/workflow-assistant.server");

const agents = [
  { type: "screening", name: "Screening agent", responsibility: "Screens shortlisted candidates" },
  { type: "followup", name: "Follow-up agent", responsibility: "Chases people" },
];
const known = (t: string) => agents.some((a) => a.type === t);

const good = {
  reply: "Screening starts on shortlist; if it fails, follow-up reminds the team.",
  name: "Shortlist → screening",
  description: "Screen shortlisted candidates, chase if it fails.",
  steps: [
    {
      id: "screen",
      kind: "agent",
      label: "Screen",
      agentType: "screening",
      goal: "Screen {{payload.applicationIds}}",
    },
    { id: "start", kind: "trigger", label: "Shortlisted", event: "application.shortlisted" },
    { id: "ok", kind: "condition", label: "Done?", field: "last.status", op: "eq", value: "done" },
    { id: "chase", kind: "agent", label: "Chase", agentType: "followup", goal: "Remind the team" },
    { id: "end ok", kind: "end", label: "Screened" },
    { id: "end2", kind: "end", label: "Reminded" },
  ],
  connections: [
    { from: "start", to: "screen" },
    { from: "screen", to: "ok" },
    { from: "ok", to: "end ok", branch: "yes" },
    { from: "ok", to: "chase", branch: "no" },
    { from: "chase", to: "end2" },
  ],
  tests: [
    {
      name: "Screened",
      subjectType: "application",
      payloadJson: '{"applicationIds":["a"]}',
      outcomes: [{ step: "screen", status: "done", result: "ok" }],
      expectEnd: "end ok",
    },
    {
      name: "Stalls",
      subjectType: "application",
      payloadJson: "not json",
      outcomes: [
        { step: "screen", status: "failed", result: "x" },
        { step: "chase", status: "done", result: "sent" },
      ],
      expectEnd: "end2",
    },
  ],
};

describe("normalizeDraft", () => {
  test("trigger first, ids made safe, positions laid out, tests in builder shape", () => {
    const d = normalizeDraft(ModelDraft.parse(good));
    expect(d.graph.nodes[0]!.kind).toBe("trigger");
    expect(d.graph.nodes.map((n) => n.id)).toContain("end_ok");
    expect(d.graph.edges.find((e) => e.branch === "yes")!.target).toBe("end_ok");
    const y = (id: string) => d.graph.nodes.find((n) => n.id === id)!.position.y;
    expect(y("start")).toBeLessThan(y("screen"));
    expect(y("screen")).toBeLessThan(y("ok"));
    expect(d.testScenarios[0]!.expectEnd).toBe("end_ok");
    expect(JSON.parse(d.testScenarios[1]!.payloadJson)).toEqual({});
    expect(JSON.parse(d.testScenarios[1]!.outcomesJson).chase.status).toBe("done");
  });

  test("fields that do not belong to a step kind are dropped", () => {
    const d = normalizeDraft(
      ModelDraft.parse({
        ...good,
        steps: good.steps.map((s) =>
          s.id === "end2" ? { ...s, goal: "nope", event: "jd.approved" } : s,
        ),
      }),
    );
    expect(d.graph.nodes.find((n) => n.id === "end2")!.data).toEqual({ label: "Reminded" });
  });
});

describe("checkDraft", () => {
  test("a sound draft passes the graph rules and its dry runs", () => {
    expect(checkDraft(normalizeDraft(ModelDraft.parse(good)), known)).toEqual({
      problems: [],
      testsPassed: true,
    });
  });

  test("an unknown agent and a wrong expected end are reported", () => {
    const bad = ModelDraft.parse({
      ...good,
      steps: good.steps.map((s) => (s.id === "chase" ? { ...s, agentType: "made_up" } : s)),
    });
    expect(checkDraft(normalizeDraft(bad), known).problems.join(" ")).toContain("pick an agent");
    const wrongEnd = ModelDraft.parse({
      ...good,
      tests: [{ ...good.tests[0]!, expectEnd: "end2" }],
    });
    const r = checkDraft(normalizeDraft(wrongEnd), known);
    expect(r.testsPassed).toBe(false);
    expect(r.problems[0]).toContain('Test "Screened"');
  });
});

describe("draftWorkflow", () => {
  test("a failing first draft gets one repair turn with the problems", async () => {
    calls.length = 0;
    replies.push({ ...good, tests: [] }, good);
    const d = await draftWorkflow({
      orgId: "00000000-0000-0000-0000-000000000001",
      messages: [{ role: "user", text: "screen on shortlist, chase if it fails" }],
      current: null,
      agents,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.feature).toBe("workflow_assistant");
    expect(calls[0]!.prompt).toContain("<untrusted_data");
    expect(calls[1]!.prompt).toContain("Add at least one test.");
    expect(d.testsPassed).toBe(true);
  });

  test("a passing draft is returned after one call", async () => {
    calls.length = 0;
    replies.push(good);
    const d = await draftWorkflow({
      orgId: "00000000-0000-0000-0000-000000000001",
      messages: [{ role: "user", text: "x" }],
      current: null,
      agents,
    });
    expect(calls).toHaveLength(1);
    expect(d.reply).toContain("Screening starts");
  });
});

describe("ModelDraft", () => {
  test("accepts the common ways a model bends the format", () => {
    const d = ModelDraft.parse({
      ...good,
      steps: good.steps.map((s) =>
        s.id === "ok" ? { ...s, kind: "Condition", op: "equals", timeoutHours: "x" } : s,
      ),
      tests: [
        { ...good.tests[0]!, payloadJson: { applicationIds: ["a"] }, subjectType: "candidate" },
      ],
    });
    const ok = d.steps.find((s) => s.id === "ok")!;
    expect(ok.kind).toBe("condition");
    expect(ok.op).toBe("eq");
    expect(d.tests[0]!.payloadJson).toBe('{"applicationIds":["a"]}');
    expect(d.tests[0]!.subjectType).toBe("requisition");
  });
});
