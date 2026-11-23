/**
 * Agent studio (docs/agent-studio.md) — platform super admin only.
 *
 * Studio agents are built from the tool catalogue, tested with sample data,
 * approved and published as immutable versions, and run inside the app only in
 * organisations granted them. The locked rules, human tools and gate-verb ban
 * always hold, renamed tools run the real tool, runs pin their version, and
 * packages are vendor-neutral. Runtime parts run against the disposable local
 * database with a scripted model.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { AgentMessage, AgentStepResult } from "../src/lib/ai-gateway.server";

type Seen = { system: string; toolNames: string[] };
const script: AgentStepResult[] = [];
const seen: Seen[] = [];
const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const say = (text: string): AgentStepResult => ({
  ok: true,
  text,
  toolCalls: [],
  stopReason: "end",
  usage,
});
const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiAgentStep: async (opts: {
    system: string;
    messages: AgentMessage[];
    tools?: { name: string }[];
  }) => {
    seen.push({ system: opts.system, toolNames: (opts.tools ?? []).map((t) => t.name) });
    return script.shift() ?? say("Done.");
  },
}));

const { ensureAgentsRegistered } = await import("../src/server/agents");
ensureAgentsRegistered();
const registry = await import("../src/server/agents/registry");
const s = await import("../src/server/agents/blueprints.server");
const { manifestHash } = await import("../src/server/agents/manifest.server");

const labour = registry.getAgent("labour_policy")!;

function content(over: Partial<ReturnType<typeof s.stockContent>> = {}) {
  const c = s.stockContent(labour);
  return {
    ...c,
    name: "Environmental compliance agent",
    responsibility: "Keeps a company's environmental obligations current.",
    instructions: "You track environmental regulations for the company.",
    mustNever: ["Give legal advice as final"],
    toolOverrides: {
      ...c.toolOverrides,
      [labour.tools[0]!]: { name: "read_regulation", description: "Read one regulation source." },
    },
    ...over,
  };
}
const cap = { stepsCap: labour.maxSteps ?? 20 };

describe("what a studio agent may contain", () => {
  test("an adapted agent with a renamed tool passes", () => {
    expect(s.blueprintProblem(content(), cap)).toBeNull();
  });
  test("a new agent may combine tools from several stock agents", () => {
    const groups = s.studioCatalogue();
    const mixed = [groups[0]!.tools[0]!, groups[groups.length - 1]!.tools[0]!];
    expect(
      s.blueprintProblem(content({ tools: mixed, toolOverrides: {} }), {
        stepsCap: s.NEW_AGENT_MAX_STEPS,
      }),
    ).toBeNull();
  });
  test("identity-bound tools (panel, live call, call review) are not in the catalogue", () => {
    const catalogue = s.catalogueTools();
    for (const t of ["assess_round", "send_panel_summary", "record_consent", "submit_call_review"])
      expect(catalogue.has(t)).toBe(false);
    expect(
      s.blueprintProblem(content({ tools: [...labour.tools, "assess_round"] }), cap),
    ).toContain("catalogue");
  });
  test("renaming a tool into a human decision, a reserved name or a prefix trick is refused", () => {
    const first = labour.tools[0]!;
    for (const bad of ["approve_policy", "reject_finding", "hire_candidate", "release_offer"]) {
      const c = content();
      c.toolOverrides[first] = { name: bad, description: "x" };
      expect(s.blueprintProblem(c, cap)).toContain("human decision");
    }
    const reserved = content();
    reserved.toolOverrides[first] = { name: "ask_human", description: "" };
    expect(s.blueprintProblem(reserved, cap)).toContain("reserved");
    const read = labour.tools.find((t) => !/^(propose|request|submit)_/.test(t))!;
    const prefix = content();
    prefix.toolOverrides[read] = { name: "submit_rules", description: "" };
    expect(s.blueprintProblem(prefix, cap)).toContain("prefix");
  });
  test("empty parts, raised limits, unknown roles and gates are refused", () => {
    expect(s.blueprintProblem(content({ instructions: " " }), cap)).not.toBeNull();
    expect(s.blueprintProblem(content({ responsibility: "" }), cap)).not.toBeNull();
    expect(s.blueprintProblem(content({ mustNever: [" "] }), cap)).not.toBeNull();
    expect(s.blueprintProblem(content({ tools: [] }), cap)).not.toBeNull();
    expect(s.blueprintProblem(content({ maxSteps: cap.stepsCap + 1 }), cap)).not.toBeNull();
    expect(s.blueprintProblem(content({ ownerRole: "superuser" }), cap)).not.toBeNull();
    expect(s.blueprintProblem(content({ gates: [] }), cap)).not.toBeNull();
    expect(s.blueprintProblem(content({ gates: ["anything"] }), cap)).not.toBeNull();
  });
  test("the stock agent is never changed", () => {
    const before = manifestHash(labour);
    s.stockContent(labour);
    expect(manifestHash(registry.getAgent("labour_policy")!)).toBe(before);
    expect(labour.toolAliases).toBeUndefined();
  });
});

function row(over: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    agentType: labour.type,
    origin: "adapted" as const,
    typeSlug: "studio:environmental",
    baseVersion: labour.version,
    baseHash: manifestHash(labour),
    status: "draft" as const,
    version: 2,
    publishedVersion: null,
    workspaceOrgId: null,
    testScenarios: [],
    lastTest: null,
    approvedBy: null,
    approvedAt: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...content(),
    ...over,
  } as Parameters<typeof s.studioManifest>[0];
}

describe("versions", () => {
  test("a manifest is self-contained and runs with the locked rules added by the runtime", () => {
    const m = s.studioManifest(row(), "studio:environmental");
    const def = s.definitionFromManifest(m);
    expect(def.type).toBe("studio:environmental");
    expect(def.feature).toBe("agent_studio");
    expect(def.system).toBe("You track environmental regulations for the company.");
    expect(def.toolAliases![labour.tools[0]!]!.name).toBe("read_regulation");
    expect(m.basedOn).toEqual({
      type: labour.type,
      version: labour.version,
      hash: manifestHash(labour),
    });
  });
  test("only a tested version whose own tests passed can be approved; only approved can be published", () => {
    const passed = { version: 2, passed: true, at: "", orgId: "", runs: [] };
    expect(s.approveProblem(row({ status: "draft" }))).not.toBeNull();
    expect(
      s.approveProblem(row({ status: "tested", lastTest: { ...passed, passed: false } })),
    ).not.toBeNull();
    expect(
      s.approveProblem(row({ status: "tested", lastTest: { ...passed, version: 1 } })),
    ).not.toBeNull();
    expect(s.approveProblem(row({ status: "tested", lastTest: passed }))).toBeNull();
    expect(s.publishProblem(row({ status: "tested", lastTest: passed }))).not.toBeNull();
    expect(
      s.publishProblem(row({ status: "approved", approvedAt: new Date(), lastTest: passed })),
    ).toBeNull();
  });
});

describe("packages", () => {
  const VENDOR =
    /\b(openai|anthropic|claude|gpt-?\d|gemini|google ai|mistral|llama|cohere|deepseek|vertex|bedrock)\b/i;
  test("the package carries the locked rules first, the aliases and the real inputs", () => {
    const pkg = s.buildPackage(s.studioManifest(row(), "studio:environmental"), "d");
    expect(pkg.instructions.startsWith(s.LOCKED_RULES)).toBe(true);
    const renamed = pkg.tools.find((t) => t.name === "read_regulation")!;
    expect(renamed.input).toEqual(
      realGateway.toolParameters(registry.getTool(labour.tools[0]!)!.input),
    );
  });
  for (const d of registry.listAgents().filter((a) => s.stockContent(a).tools.length)) {
    test(`${d.type}: vendor-neutral, no model fields, no gate tools`, () => {
      const m = s.studioManifest(row({ ...s.stockContent(d), agentType: d.type }), "studio:x");
      const pkg = s.buildPackage(m, "");
      expect(JSON.stringify(pkg)).not.toMatch(VENDOR);
      for (const obj of [pkg, pkg.agent, ...pkg.tools, ...pkg.humanTools])
        for (const k of ["model", "engine", "feature", "skills"])
          expect(Object.keys(obj)).not.toContain(k);
      for (const t of pkg.tools) expect(registry.isGateToolName(t.name)).toBe(false);
    });
  }
});

describe("access", () => {
  test("every studio server function is super admin only", () => {
    const src = readFileSync("src/lib/platform-agent-studio.functions.ts", "utf8");
    const fns = src.match(/createServerFn\(/g)?.length ?? 0;
    const guarded = src.match(/\.middleware\(\[requirePlatformAdmin\]\)/g)?.length ?? 0;
    expect(fns).toBeGreaterThan(10);
    expect(guarded).toBe(fns);
    expect(src).not.toMatch(/requireOrg\b|requireRole\(/);
  });
  test("organisations start a granted studio agent only with settings roles", () => {
    const src = readFileSync("src/lib/agents.functions.ts", "utf8");
    const fn = src.slice(src.indexOf("export const startStudioAgentRun"));
    expect(fn.slice(0, 1200)).toContain(
      "assertRole(context.userId, context.orgId, [...SETTINGS_ROLES])",
    );
  });
  test("no organisation menu reaches the studio", () => {
    const nav = readFileSync("src/components/nav-config.ts", "utf8");
    const item = nav.slice(nav.indexOf('"/platform-agent-studio"'));
    expect(item.slice(0, 200)).toContain("c.isSuperUser");
  });
});

/* ------------------------------------------- runtime: grants, aliases, pins */

const { db } = await import("../src/server/db");
const schema = await import("../drizzle/schema");
const {
  agentBlueprints,
  agentPolicies,
  agentRuns,
  agentSteps,
  organizations,
  studioAgentGrants,
  studioAgentVersions,
  users,
} = schema;
const { runAgentTick, startRun } = await import("../src/server/agents/runtime.server");

describe("in the app", () => {
  let orgId = "";
  let otherOrgId = "";
  let userId = "";
  let blueprintId = "";
  const executed: string[] = [];
  const stamp = Date.now();
  const type = `studio:t${stamp}` as const;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? "";
    if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
      throw new Error("Refusing to run against a non-local database host");
    const [u] = await db
      .insert(users)
      .values({ email: `studio-${stamp}@test.local` })
      .returning({ id: users.id });
    userId = u!.id;
    const orgs = await db
      .insert(organizations)
      .values([
        { name: "Granted", slug: `studio-a-${stamp}`, status: "active" },
        { name: "Not granted", slug: `studio-b-${stamp}`, status: "active" },
      ])
      .returning({ id: organizations.id });
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    registry.registerTool({
      name: "stub_lookup",
      description: "Stock lookup",
      input: z.object({ id: z.string() }),
      risk: "read",
      run: async (_ctx, input) => {
        executed.push(`stub_lookup:${input.id}`);
        return { ok: true };
      },
    });
    const manifest = (version: number, instructions: string): s.StudioManifest => ({
      type,
      name: "Studio test agent",
      version,
      owner: "hr_head",
      responsibility: "Test fixture.",
      mustNever: ["Nothing harmful"],
      scope: { reads: [], writes: [], external: [] },
      gates: ["general"],
      riskTier: "low",
      instructions,
      tools: ["stub_lookup"],
      toolAliases: { stub_lookup: { name: "read_regulation", description: "Read a regulation." } },
      maxSteps: 6,
      basedOn: null,
    });
    const [bp] = await db
      .insert(agentBlueprints)
      .values({
        agentType: type,
        origin: "new",
        typeSlug: type,
        baseVersion: "",
        baseHash: "",
        name: "Studio test agent",
        responsibility: "Test fixture.",
        instructions: "V2 INSTRUCTIONS",
        mustNever: ["Nothing harmful"],
        tools: ["stub_lookup"],
        status: "published",
        version: 2,
        publishedVersion: 1,
      })
      .returning({ id: agentBlueprints.id });
    blueprintId = bp!.id;
    const test = { version: 1, passed: true, at: "", orgId, runs: [] };
    await db.insert(studioAgentVersions).values([
      {
        blueprintId,
        version: 1,
        typeSlug: type,
        manifest: manifest(1, "V1 INSTRUCTIONS") as never,
        hash: "h1",
        test,
        approvedAt: new Date(),
      },
      {
        blueprintId,
        version: 2,
        typeSlug: type,
        manifest: manifest(2, "V2 INSTRUCTIONS") as never,
        hash: "h2",
        test: { ...test, version: 2 },
        approvedAt: new Date(),
      },
    ]);
    await db.insert(studioAgentGrants).values({ blueprintId, orgId });
    await db.insert(agentPolicies).values([
      { orgId, agentType: type, enabled: true },
      { orgId: otherOrgId, agentType: type, enabled: true },
    ]);
    s.clearStudioCache();
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [orgId, otherOrgId]));
    if (blueprintId) await db.delete(agentBlueprints).where(eq(agentBlueprints.id, blueprintId));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("an organisation without a grant cannot run it", async () => {
    await expect(
      startRun({ orgId: otherOrgId, agentType: type, principalUserId: userId, goal: "Go" }),
    ).rejects.toThrow("not available to this organisation");
  });

  test("a granted organisation runs the published version; the alias runs the real tool", async () => {
    seen.length = 0;
    const { runId } = await startRun({
      orgId,
      agentType: type,
      principalUserId: userId,
      goal: "Check R1",
    });
    script.push({
      ok: true,
      text: "",
      toolCalls: [{ id: "c1", name: "read_regulation", args: { id: "R1" } }],
      stopReason: "tool_use",
      usage,
    });
    await runAgentTick({ max: 1, orgId, onlyRunId: runId });
    await runAgentTick({ max: 1, orgId, onlyRunId: runId });
    expect(executed).toContain("stub_lookup:R1");
    expect(seen[0]!.toolNames).toContain("read_regulation");
    expect(seen[0]!.system.startsWith(s.LOCKED_RULES)).toBe(true);
    expect(seen[0]!.system).toContain("V1 INSTRUCTIONS");
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(r!.blueprintId).toBe(blueprintId);
    expect(r!.blueprintVersion).toBe(1);
    expect(r!.status).toBe("done");
  });

  test("a run keeps the version it started on after a newer one is published", async () => {
    seen.length = 0;
    const { runId } = await startRun({
      orgId,
      agentType: type,
      principalUserId: userId,
      goal: "Long task",
    });
    await db
      .update(agentBlueprints)
      .set({ publishedVersion: 2 })
      .where(eq(agentBlueprints.id, blueprintId));
    s.clearStudioCache();
    await runAgentTick({ max: 1, orgId, onlyRunId: runId });
    expect(seen[0]!.system).toContain("V1 INSTRUCTIONS");
    seen.length = 0;
    const next = await startRun({ orgId, agentType: type, principalUserId: userId, goal: "New" });
    await runAgentTick({ max: 1, orgId, onlyRunId: next.runId });
    expect(seen[0]!.system).toContain("V2 INSTRUCTIONS");
  });

  test("withdrawing the grant stops new runs", async () => {
    await db
      .update(studioAgentGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(studioAgentGrants.blueprintId, blueprintId), eq(studioAgentGrants.orgId, orgId)),
      );
    s.clearStudioCache();
    await expect(
      startRun({ orgId, agentType: type, principalUserId: userId, goal: "Again" }),
    ).rejects.toThrow("not available");
  });

  test("a sample-data test approves its own write request, even with no role in the test org", async () => {
    const { runStudioTests } = await import("../src/server/agents/studio-test.server");
    registry.registerTool({
      name: "stub_write",
      description: "Write something",
      input: z.object({ text: z.string(), candidateId: z.string().optional() }),
      risk: "write",
      run: async () => {
        executed.push("stub_write:real");
        return "written";
      },
    });
    executed.length = 0;
    const [bp] = await db.select().from(agentBlueprints).where(eq(agentBlueprints.id, blueprintId));
    const draft = {
      ...bp!,
      tools: ["stub_lookup", "stub_write"],
      toolOverrides: {},
      testScenarios: [
        {
          name: "writes after approval",
          goal: "Write a note",
          fixtures: { stub_write: { ok: true, sample: "note saved" } },
          expectCalls: ["stub_write"],
          expectApproval: true,
        },
      ],
    };
    script.push({
      ok: true,
      text: "",
      // Sample data names a candidate that does not exist in the test organisation.
      toolCalls: [
        {
          id: "w1",
          name: "stub_write",
          args: { text: "hello", candidateId: "22222222-2222-4222-8222-222222222222" },
        },
      ],
      stopReason: "tool_use",
      usage,
    });
    const result = await runStudioTests(draft, orgId, userId);
    expect(result.runs[0]!.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(executed).toHaveLength(0);
  });

  test("a test answers a request to a role it lacks; outside a live test the role is required", async () => {
    const { runStudioTests } = await import("../src/server/agents/studio-test.server");
    const [bp] = await db.select().from(agentBlueprints).where(eq(agentBlueprints.id, blueprintId));
    const draft = {
      ...bp!,
      tools: ["stub_lookup"],
      toolOverrides: {},
      testScenarios: [
        {
          name: "asks the HR head",
          goal: "Ask the HR head",
          fixtures: {},
          expectApproval: true,
        },
      ],
    };
    script.push({
      ok: true,
      text: "",
      toolCalls: [
        {
          id: "g1",
          name: "request_approval",
          args: { title: "Please decide", summary: "A decision", assignee_role: "hr_head" },
        },
      ],
      stopReason: "tool_use",
      usage,
    });
    const result = await runStudioTests(draft, orgId, userId);
    expect(result.runs[0]!.failures).toEqual([]);
    expect(result.passed).toBe(true);

    // The same kind of task on an ordinary run: the user holds no HR head role here.
    const { resolveTask } = await import("../src/server/agents/runtime.server");
    const { agentTasks } = schema;
    const [plain] = await db
      .insert(agentRuns)
      .values({ orgId, agentType: "requisition", principalUserId: userId, goal: "x" })
      .returning({ id: agentRuns.id });
    const [task] = await db
      .insert(agentTasks)
      .values({
        orgId,
        runId: plain!.id,
        kind: "gate",
        title: "Decide",
        body: "b",
        assigneeRole: "hr_head",
      } as never)
      .returning({ id: agentTasks.id });
    await expect(
      resolveTask({ orgId, taskId: task!.id, userId, decision: { status: "approved" } }),
    ).rejects.toThrow();
  });

  test("a type named like a test run is renamed", () => {
    expect(s.studioTypeFor("Test agent")).toBe("studio:agent_test_agent");
  });

  test("a sample-data test runs stand-ins, never the real tool, and cleans up", async () => {
    const { runStudioTests } = await import("../src/server/agents/studio-test.server");
    executed.length = 0;
    const [bp] = await db.select().from(agentBlueprints).where(eq(agentBlueprints.id, blueprintId));
    const draft = {
      ...bp!,
      toolOverrides: { stub_lookup: { name: "read_regulation", description: "Read." } },
      testScenarios: [
        {
          name: "reads R9",
          goal: "Check R9",
          fixtures: { stub_lookup: { title: "Sample regulation R9" } },
          expectCalls: ["stub_lookup"],
        },
      ],
    };
    script.push({
      ok: true,
      text: "",
      toolCalls: [{ id: "c9", name: "read_regulation", args: { id: "R9" } }],
      stopReason: "tool_use",
      usage,
    });
    const result = await runStudioTests(draft, orgId, userId);
    expect(result.passed).toBe(true);
    expect(result.runs[0]!.calls).toEqual(["stub_lookup"]);
    expect(executed).toHaveLength(0); // the real tool never ran
    const steps = await db
      .select({ output: agentSteps.output })
      .from(agentSteps)
      .where(and(eq(agentSteps.runId, result.runs[0]!.runId!), eq(agentSteps.kind, "tool")));
    expect(JSON.stringify(steps)).toContain("Sample regulation R9");
    expect(registry.listTools().some((t) => t.name.startsWith("stest_"))).toBe(false);
    expect(s.studioTestDefinitions.size).toBe(0);
    const leftover = await db
      .select()
      .from(agentPolicies)
      .where(and(eq(agentPolicies.orgId, orgId)));
    expect(leftover.some((p) => p.agentType.startsWith("studio:test_"))).toBe(false);
  });
});
