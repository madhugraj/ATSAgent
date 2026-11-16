/**
 * Agent studio: test a draft with sample data before it can be approved
 * (docs/agent-studio.md). Same protocol as the code agents' eval harness
 * (eval.server.ts), adapted for agents built in the app:
 *
 * - the run happens in a test organisation the super admin owns, on that
 *   organisation's own AI key (no platform key);
 * - every tool is a stand-in with the real tool's input contract that returns
 *   the scenario's sample data — nothing real is read, sent or changed;
 * - the model sees the agent exactly as it will run (its instructions, the
 *   locked rules, the renamed tools);
 * - approvals and questions are answered by the test (approve / a fixed answer)
 *   and the checks are recorded on the draft.
 */
import { randomBytes } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import {
  agentPolicies,
  agentRuns,
  agentSteps,
  agentTasks,
  type AgentType,
  type StudioTestResult,
  type StudioTestScenario,
} from "@db/schema";
import { db } from "../db";
import {
  definitionFromManifest,
  studioManifest,
  studioTestDefinitions,
  type AgentBlueprintRow,
} from "./blueprints.server";
import {
  getTool,
  registerTool,
  STUDIO_TEST_TOOL_PREFIX,
  unregisterTestTool,
  type AgentTool,
} from "./registry";
import { resolveTask, runAgentTick, startRun } from "./runtime.server";

const MAX_TICKS = 12;
export const MAX_SCENARIOS = 5;
const NO_SAMPLE = { note: "No sample data was given for this tool in the test." };

/** Check a scenario's own shape before running it. */
export function scenarioProblem(s: StudioTestScenario, tools: string[]): string | null {
  if (!s.name.trim()) return "Name each test.";
  if (s.goal.trim().length < 5) return `Test "${s.name}": write the goal the agent is given.`;
  const unknown = [...Object.keys(s.fixtures ?? {}), ...(s.expectCalls ?? [])].filter(
    (t) => !tools.includes(t),
  );
  if (unknown.length) return `Test "${s.name}": not a tool of this agent: ${unknown.join(", ")}.`;
  return null;
}

async function runScenario(
  bp: AgentBlueprintRow,
  scenario: StudioTestScenario,
  orgId: string,
  userId: string,
): Promise<StudioTestResult["runs"][number]> {
  const stamp = randomBytes(4).toString("hex");
  const testType = `studio:test_${stamp}` as AgentType;
  const manifest = studioManifest(bp, testType as `studio:${string}`);
  // Stand-ins: the real tool's contract, the scenario's sample data as the result.
  const realOf = new Map<string, string>();
  const standIns: string[] = [];
  for (const [i, real] of manifest.tools.entries()) {
    const t = getTool(real);
    if (!t) continue;
    const name = `${STUDIO_TEST_TOOL_PREFIX}${stamp}_${i}`;
    const sample = scenario.fixtures?.[real] ?? NO_SAMPLE;
    registerTool({
      name,
      description: t.description,
      input: t.input,
      risk: t.risk,
      untrustedOutput: t.untrustedOutput,
      run: async () => structuredClone(sample),
    } as AgentTool<unknown>);
    realOf.set(name, real);
    standIns.push(name);
  }
  const def = definitionFromManifest(manifest);
  def.tools = standIns;
  def.toolAliases = Object.fromEntries(
    standIns.map((n) => [n, manifest.toolAliases[realOf.get(n)!]!]),
  );
  studioTestDefinitions.set(testType, { orgId, def });
  let runId: string | null = null;
  try {
    await db
      .insert(agentPolicies)
      .values({ orgId, agentType: testType, enabled: true, autonomy: "suggest" });
    ({ runId } = await startRun({
      orgId,
      agentType: testType,
      principalUserId: userId,
      goal: `[Studio test: ${scenario.name}] ${scenario.goal}`,
    }));
    let approvals = 0;
    for (let tick = 0; tick < MAX_TICKS; tick++) {
      await runAgentTick({ max: 1, orgId, onlyRunId: runId });
      const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
      if (!run || run.status === "done" || run.status === "failed") break;
      if (run.status !== "awaiting_human") continue;
      const open = await db
        .select()
        .from(agentTasks)
        .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, "open")));
      for (const t of open) {
        // A person was asked: a decision (gate) or an approval of a proposed action.
        if (t.kind !== "clarification") approvals++;
        await resolveTask({
          orgId,
          taskId: t.id,
          userId,
          decision:
            t.kind === "clarification"
              ? { status: "answered", answer: "Proceed with what you have (studio test)." }
              : { status: "approved", comment: "Approved by the studio test." },
        });
      }
    }
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    const steps = await db
      .select()
      .from(agentSteps)
      .where(eq(agentSteps.runId, runId))
      .orderBy(agentSteps.seq);
    const calls = steps
      .filter((x) => x.kind === "tool" && x.toolName)
      .map((x) => realOf.get(x.toolName!) ?? x.toolName!);
    const gateTasks = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(and(eq(agentTasks.runId, runId), inArray(agentTasks.kind, ["gate", "approval"])));
    const failures: string[] = [];
    if (run?.status !== "done")
      failures.push(`The run ended ${run?.status ?? "missing"} instead of finishing.`);
    if (scenario.expectCalls?.length) {
      let i = 0;
      for (const c of calls) if (c === scenario.expectCalls[i]) i++;
      if (i < scenario.expectCalls.length)
        failures.push(
          `Expected ${scenario.expectCalls.join(" → ")} in order; it called ${calls.join(" → ") || "nothing"}.`,
        );
    }
    if (scenario.expectApproval && !gateTasks.length && !approvals)
      failures.push("It never asked a person for approval.");
    // A call the model got wrong and then corrected (invalid arguments) is normal;
    // any other tool error fails the test.
    const errors = steps.filter(
      (x) =>
        x.kind === "tool" &&
        x.status === "error" &&
        !String((x.output as { error?: unknown } | null)?.error ?? "").startsWith(
          "Invalid arguments",
        ),
    ).length;
    if (errors) failures.push(`${errors} tool call${errors === 1 ? "" : "s"} failed.`);
    return {
      scenario: scenario.name,
      runId,
      passed: failures.length === 0,
      failures,
      calls,
      status: run?.status ?? "missing",
      steps: run?.stepCount ?? 0,
      tokens: run?.tokensUsed ?? 0,
      result: run?.result ?? null,
    };
  } catch (e) {
    return {
      scenario: scenario.name,
      runId,
      passed: false,
      failures: [e instanceof Error ? e.message.slice(0, 300) : "The test could not run."],
      calls: [],
      status: "failed",
      steps: 0,
      tokens: 0,
      result: null,
    };
  } finally {
    // A test never leaves work behind: an unfinished test run is cancelled.
    if (runId)
      await db
        .update(agentRuns)
        .set({ status: "cancelled", finishedAt: new Date(), leaseUntil: null })
        .where(
          and(
            eq(agentRuns.id, runId),
            inArray(agentRuns.status, ["queued", "running", "awaiting_human"]),
          ),
        );
    if (runId)
      await db
        .update(agentTasks)
        .set({ status: "cancelled" })
        .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, "open")));
    studioTestDefinitions.delete(testType);
    standIns.forEach(unregisterTestTool);
    await db
      .delete(agentPolicies)
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, testType)));
  }
}

/**
 * Run every test of a draft in the test organisation. Passing all of them is
 * what lets the version be approved.
 */
export async function runStudioTests(
  bp: AgentBlueprintRow,
  orgId: string,
  userId: string,
): Promise<StudioTestResult> {
  const runs: StudioTestResult["runs"] = [];
  for (const s of bp.testScenarios.slice(0, MAX_SCENARIOS))
    runs.push(await runScenario(bp, s, orgId, userId));
  return {
    version: bp.version,
    passed: runs.length > 0 && runs.every((r) => r.passed),
    at: new Date().toISOString(),
    orgId,
    runs,
  };
}
