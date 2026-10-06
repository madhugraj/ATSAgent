/**
 * Eval harness in CI: every scenario in scripts/evals/scenarios.ts runs
 * through the real runtime with its scripted model replies, plus the
 * registry's gate guard. Needs the disposable local database.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";

import type { AgentStepResult } from "../src/lib/ai-gateway.server";

let script: AgentStepResult[] = [];
const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiAgentStep: async () =>
    script.shift() ?? { ok: false, status: 500, message: "script exhausted" },
}));

const { registerTool, resetRegistry, isGateToolName } =
  await import("../src/server/agents/registry");
const { runScenario } = await import("../src/server/agents/eval.server");
const { scenarios } = await import("./evals/scenarios");

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
    throw new Error("Refusing to run against a non-local database host");
  }
});

describe("eval scenarios (scripted model)", () => {
  for (const s of scenarios()) {
    test(s.name, async () => {
      resetRegistry();
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

describe("gate guard", () => {
  const t = (name: string) => ({
    name,
    description: "x",
    input: z.object({}),
    risk: "write" as const,
    run: async () => null,
  });

  test("tools that would make a human decision cannot be registered", () => {
    resetRegistry();
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
  });

  test("propose / request / submit variants are allowed", () => {
    resetRegistry();
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
