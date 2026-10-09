/**
 * Eval harness in CI: every scenario in scripts/evals/scenarios.ts runs
 * through the real runtime with its scripted model replies — stand-in
 * harness scenarios and one or more per REAL agent — plus governance checks:
 * every live agent declares evals that exist, and the gate guard holds.
 * Needs the disposable local database.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";

import type { ScriptStep } from "./evals/scenarios";

type Msg = { role: string; content?: string };
let script: ScriptStep[] = [];
const realGateway = await import("../src/lib/ai-gateway.server");
const JD = {
  purpose: "Run the platform.",
  responsibilities: "- Keep it up",
  must_have: ["Kubernetes", "Go"],
  good_to_have: [],
  qualifications: "BSc",
  success_factors: "Uptime",
  reporting_to: "Head of Platform",
  full_text: "# Platform SRE",
};
const AI_FIXTURES: Record<string, unknown> = {
  offer_letter: {
    subject: "Offer of employment — Platform SRE",
    greeting: "Dear Sana,",
    opening: "We are delighted to offer you the role of Platform SRE.",
    sections: [
      { heading: "Role and Responsibilities", body: "Run the platform." },
      { heading: "Compensation and Benefits", body: "Annual CTC of 30,00,000." },
      { heading: "Terms of Employment", body: "Standard terms apply." },
      { heading: "Next Steps", body: "Please confirm acceptance." },
    ],
    closing: "Sincerely,",
  },
  jd_generate: JD,
  linkedin_post: {
    headline: "Hiring SREs",
    body: "Join us",
    hashtags: ["sre"],
    call_to_action: "Apply",
  },
  assessment_generate: {
    questions: [1, 2, 3, 4].map((i) => ({
      id: `q${i}`,
      dimension: "ownership",
      prompt: `Q${i}?`,
      looks_like: "x",
    })),
  },
};
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiAgentStep: async (opts: { messages: Msg[] }) => {
    const next = script.shift() ?? { ok: false, status: 500, message: "script exhausted" };
    return typeof next === "function" ? next(opts.messages) : next;
  },
  aiJson: async (opts: { feature: string }) =>
    opts.feature in AI_FIXTURES
      ? { ok: true, data: AI_FIXTURES[opts.feature], model: "m", provider: "openai", usage: null }
      : { ok: false, status: 500, message: `no fixture for ${opts.feature}` },
}));

const { registerTool, resetRegistry, isGateToolName, listAgents } =
  await import("../src/server/agents/registry");
const { registerPhase1Tools } = await import("../src/server/agents/tools");
const { registerPhase2Tools } = await import("../src/server/agents/tools-phase2");
const { registerPhase3Tools } = await import("../src/server/agents/tools-phase3");
const { registerPhase4Tools } = await import("../src/server/agents/tools-phase4");
const { registerSourcingTools } = await import("../src/server/agents/tools-sourcing");
const {
  registerPhase1Agents,
  registerPhase2Agents,
  registerPhase3Agents,
  registerPhase4Agents,
  registerPhase6Agents,
} = await import("../src/server/agents/definitions");
const { runScenario } = await import("../src/server/agents/eval.server");
const { scenarios } = await import("./evals/scenarios");

const registerReal = () => {
  resetRegistry();
  registerPhase1Tools();
  registerPhase2Tools();
  registerPhase3Tools();
  registerPhase4Tools();
  registerSourcingTools();
  registerPhase1Agents();
  registerPhase2Agents();
  registerPhase3Agents();
  registerPhase4Agents();
  registerPhase6Agents();
};

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
    throw new Error("Refusing to run against a non-local database host");
  }
});

describe("eval scenarios (scripted model)", () => {
  for (const s of scenarios()) {
    test(s.name, async () => {
      if (s.agent) resetRegistry();
      else registerReal();
      script = [...s.script];
      const report = await runScenario(s);
      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
    });
  }

  test("a failing expectation is reported, not thrown", async () => {
    resetRegistry();
    const [s] = scenarios();
    script = [...s!.script];
    const report = await runScenario({
      ...s!,
      expect: { ...s!.expect, gateRole: "president_cbo" },
    });
    expect(report.passed).toBe(false);
    expect(report.failures[0]).toContain("gate routed to department_head");
  });
});

describe("governance", () => {
  test("every live agent declares at least one eval, and every declared eval exists", () => {
    registerReal();
    const names = new Set(scenarios().map((s) => s.name));
    const realScenarioAgents = new Set(
      scenarios()
        .filter((s) => s.agentType)
        .map((s) => s.agentType),
    );
    for (const a of listAgents()) {
      expect({ agent: a.type, evals: a.evals.length > 0 }).toEqual({ agent: a.type, evals: true });
      for (const e of a.evals)
        expect({ agent: a.type, eval: e, exists: names.has(e) }).toMatchObject({ exists: true });
      expect({
        agent: a.type,
        coveredByRealScenario: realScenarioAgents.has(a.type),
      }).toMatchObject({
        coveredByRealScenario: true,
      });
    }
  });

  test("tools that would make a human decision cannot be registered", () => {
    resetRegistry();
    const t = (name: string) => ({
      name,
      description: "x",
      input: z.object({}),
      risk: "write" as const,
      run: async () => null,
    });
    for (const name of [
      "approve_offer",
      "release_offer",
      "reject_candidate",
      "hire_candidate",
      "revoke_offer",
      "offer_accept",
    ]) {
      expect(isGateToolName(name)).toBe(true);
      expect(() => registerTool(t(name))).toThrow("human decision");
    }
    for (const name of [
      "propose_rejection",
      "propose_release",
      "submit_offer",
      "submit_requisition_for_approval",
      "send_assessment",
    ]) {
      expect(isGateToolName(name)).toBe(false);
      expect(() => registerTool(t(name))).not.toThrow();
    }
  });
});
