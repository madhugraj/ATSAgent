/**
 * Agent studio blueprints (docs/agent-studio.md) — platform super admin only.
 * A blueprint may rewrite an agent for another domain, but the locked rules,
 * human tools and gate-verb ban always hold, tools stay the stock agent's own
 * (renamed calls run the real tool), packages are vendor-neutral, in-app runs
 * never see blueprints, and every studio function is super-admin only.
 * Runtime part against the disposable local database with a scripted model.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { AgentMessage, AgentStepResult } from "../src/lib/ai-gateway.server";

type Seen = { system: string; toolNames: string[]; messages: AgentMessage[] };
const script: AgentStepResult[] = [];
const seen: Seen[] = [];
const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiAgentStep: async (opts: {
    system: string;
    messages: AgentMessage[];
    tools?: { name: string }[];
  }) => {
    seen.push({
      system: opts.system,
      toolNames: (opts.tools ?? []).map((t) => t.name),
      messages: structuredClone(opts.messages),
    });
    return (
      script.shift() ?? {
        ok: true,
        text: "Done.",
        toolCalls: [],
        stopReason: "end",
        usage,
      }
    );
  },
}));

const { ensureAgentsRegistered } = await import("../src/server/agents");
ensureAgentsRegistered();
const registry = await import("../src/server/agents/registry");
const { getAgent, listAgents } = registry;
const bpLib = await import("../src/server/agents/blueprints.server");
const {
  blueprintProblem,
  buildPackage,
  effectiveDefinition,
  LOCKED_RULES,
  PACKAGE_FORMAT,
  stockContent,
} = bpLib;
const { manifestHash } = await import("../src/server/agents/manifest.server");

const labour = getAgent("labour_policy")!;

function adapted(over: Partial<ReturnType<typeof stockContent>> = {}) {
  const c = stockContent(labour);
  const first = labour.tools[0]!;
  return {
    ...c,
    name: "Environmental compliance agent",
    responsibility: "Keeps a company's environmental obligations current.",
    instructions: "You track environmental regulations for the company.",
    mustNever: ["Give legal advice as final"],
    toolOverrides: {
      ...c.toolOverrides,
      [first]: { name: "read_regulation", description: "Read one regulation source." },
    },
    ...over,
  };
}

function row(over: Partial<ReturnType<typeof stockContent>> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    agentType: labour.type,
    baseVersion: labour.version,
    baseHash: manifestHash(labour),
    status: "published" as const,
    version: 2,
    workspaceOrgId: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...adapted(over),
  };
}

describe("what a blueprint may change", () => {
  test("a domain rewrite with a renamed tool passes", () => {
    expect(blueprintProblem(labour, adapted())).toBeNull();
  });
  test("tools outside the stock agent are refused", () => {
    expect(
      blueprintProblem(labour, adapted({ tools: [...labour.tools, "start_agent"] })),
    ).toContain("Not a tool of this agent");
  });
  test("renaming a tool into a human decision is refused", () => {
    const c = adapted();
    for (const bad of ["approve_policy", "reject_finding", "hire_candidate", "release_offer"]) {
      c.toolOverrides[labour.tools[0]!] = { name: bad, description: "x" };
      expect(blueprintProblem(labour, c)).toContain("human decision");
    }
  });
  test("duplicate names, reserved human-tool names and prefix tricks are refused", () => {
    const [a, b] = labour.tools;
    const dup = adapted();
    dup.toolOverrides[a!] = { name: "read_rules", description: "" };
    dup.toolOverrides[b!] = { name: "read_rules", description: "" };
    expect(blueprintProblem(labour, dup)).toContain("Two tools");
    const human = adapted();
    human.toolOverrides[a!] = { name: "ask_human", description: "" };
    expect(blueprintProblem(labour, human)).toContain("reserved");
    const read = labour.tools.find((t) => !/^(propose|request|submit)_/.test(t))!;
    const prefix = adapted();
    prefix.toolOverrides[read] = { name: "submit_rules", description: "" };
    expect(blueprintProblem(labour, prefix)).toContain("prefix");
  });
  test("empty instructions, responsibility, must-never or tools are refused", () => {
    expect(blueprintProblem(labour, adapted({ instructions: " " }))).not.toBeNull();
    expect(blueprintProblem(labour, adapted({ responsibility: "" }))).not.toBeNull();
    expect(blueprintProblem(labour, adapted({ mustNever: [" "] }))).not.toBeNull();
    expect(blueprintProblem(labour, adapted({ tools: [] }))).not.toBeNull();
    expect(
      blueprintProblem(labour, adapted({ maxSteps: (labour.maxSteps ?? 20) + 1 })),
    ).not.toBeNull();
  });
  test("the stock agent is never changed", () => {
    const before = manifestHash(labour);
    effectiveDefinition(labour, adapted());
    expect(manifestHash(getAgent("labour_policy")!)).toBe(before);
    expect(labour.toolAliases).toBeUndefined();
  });
});

describe("packages", () => {
  const VENDOR =
    /\b(openai|anthropic|claude|gpt-?\d|gemini|google ai|mistral|llama|cohere|deepseek|vertex|bedrock)\b/i;
  test("the adapted package carries the locked rules, aliases and real inputs", () => {
    const pkg = buildPackage(labour, row());
    expect(pkg.format).toBe(PACKAGE_FORMAT);
    expect(pkg.instructions.startsWith(LOCKED_RULES)).toBe(true);
    expect(pkg.instructions).toContain("You track environmental regulations");
    expect(pkg.instructions).not.toContain(labour.system);
    const renamed = pkg.tools.find((t) => t.name === "read_regulation")!;
    expect(renamed.description).toBe("Read one regulation source.");
    expect(renamed.input).toEqual(
      realGateway.toolParameters(registry.getTool(labour.tools[0]!)!.input),
    );
    expect(pkg.tools.map((t) => t.name)).not.toContain(labour.tools[0]);
  });
  for (const d of listAgents().filter((a) => a.tools.length)) {
    test(`${d.type}: vendor-neutral, no model fields, no gate tools`, () => {
      const pkg = buildPackage(d, { ...row(stockContent(d)), agentType: d.type });
      expect(JSON.stringify(pkg)).not.toMatch(VENDOR);
      for (const obj of [pkg, pkg.agent, ...pkg.tools, ...pkg.humanTools])
        for (const k of ["model", "engine", "feature", "skills"])
          expect(Object.keys(obj)).not.toContain(k);
      for (const t of pkg.tools) expect(registry.isGateToolName(t.name)).toBe(false);
    });
  }
});

describe("super admin only", () => {
  test("every studio server function uses requirePlatformAdmin", () => {
    const src = readFileSync("src/lib/platform-agent-studio.functions.ts", "utf8");
    const fns = src.match(/createServerFn\(/g)?.length ?? 0;
    const guarded = src.match(/\.middleware\(\[requirePlatformAdmin\]\)/g)?.length ?? 0;
    expect(fns).toBeGreaterThan(5);
    expect(guarded).toBe(fns);
    expect(src).not.toMatch(/requireOrg\b|requireRole\(/);
  });
  test("no organisation route or menu reaches the studio", () => {
    const nav = readFileSync("src/components/nav-config.ts", "utf8");
    const item = nav.slice(nav.indexOf('"/platform-agent-studio"'));
    expect(item.slice(0, 200)).toContain("c.isSuperUser");
    expect(nav).not.toContain('"/agents/studio"');
  });
});

/* -------------------------------------------- runtime: aliases and isolation */

const { db } = await import("../src/server/db");
const { agentBlueprints, agentPolicies, agentRuns, organizations, users } =
  await import("../drizzle/schema");
const { runAgentTick, startRun } = await import("../src/server/agents/runtime.server");

let orgId = "";
let otherOrgId = "";
let userId = "";
let blueprintId = "";
const executed: string[] = [];

describe("hosted runs", () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? "";
    if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
      throw new Error("Refusing to run against a non-local database host");
    const stamp = Date.now();
    const [u] = await db
      .insert(users)
      .values({ email: `bp-${stamp}@test.local` })
      .returning({ id: users.id });
    userId = u!.id;
    const orgs = await db
      .insert(organizations)
      .values([
        { name: "Workspace", slug: `bp-ws-${stamp}`, status: "active" },
        { name: "Other", slug: `bp-other-${stamp}`, status: "active" },
      ])
      .returning({ id: organizations.id });
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    await db.insert(agentPolicies).values([
      { orgId, agentType: "requisition", enabled: true },
      { orgId: otherOrgId, agentType: "requisition", enabled: true },
    ]);
    registry.resetRegistry();
    registry.registerTool({
      name: "lookup",
      description: "Stock lookup",
      input: z.object({ id: z.string() }),
      risk: "read",
      run: async (_ctx, input) => {
        executed.push(`lookup:${input.id}`);
        return { ok: true };
      },
    });
    registry.registerAgent({
      type: "requisition",
      name: "Stock",
      version: "0.0.0-test",
      owner: "hr_head",
      responsibility: "Stock responsibility.",
      mustNever: ["Stock rule"],
      scope: { reads: [], writes: [], external: [] },
      gates: ["general"],
      riskTier: "low",
      evals: [],
      feature: "agent_requisition",
      system: "STOCK INSTRUCTIONS",
      tools: ["lookup"],
    });
    const def = registry.getAgent("requisition")!;
    const [bp] = await db
      .insert(agentBlueprints)
      .values({
        agentType: "requisition",
        baseVersion: def.version,
        baseHash: manifestHash(def),
        name: "Adapted",
        responsibility: "Adapted responsibility.",
        instructions: "ADAPTED INSTRUCTIONS",
        mustNever: ["Adapted rule"],
        tools: ["lookup"],
        toolOverrides: { lookup: { name: "read_regulation", description: "Read a regulation." } },
        status: "published",
        workspaceOrgId: orgId,
      })
      .returning({ id: agentBlueprints.id });
    blueprintId = bp!.id;
  });

  afterAll(async () => {
    if (blueprintId) await db.delete(agentBlueprints).where(eq(agentBlueprints.id, blueprintId));
    await db.delete(organizations).where(inArray(organizations.id, [orgId, otherOrgId]));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("the model sees the alias and adapted instructions; the real tool runs", async () => {
    const { runId } = await startRun({
      orgId,
      agentType: "requisition",
      principalUserId: userId,
      goal: "Check regulation R1",
      blueprintId,
    });
    script.push({
      ok: true,
      text: "",
      toolCalls: [{ id: "c1", name: "read_regulation", args: { id: "R1" } }],
      stopReason: "tool_use",
      usage,
    });
    await runAgentTick();
    await runAgentTick();
    expect(executed).toContain("lookup:R1");
    expect(seen[0]!.toolNames).toContain("read_regulation");
    expect(seen[0]!.toolNames).not.toContain("lookup");
    expect(seen[0]!.system.startsWith(LOCKED_RULES)).toBe(true);
    expect(seen[0]!.system).toContain("ADAPTED INSTRUCTIONS");
    expect(seen[0]!.system).not.toContain("STOCK INSTRUCTIONS");
    const toolMsg = seen[1]!.messages.find((m) => m.role === "tool") as { name?: string };
    expect(toolMsg.name).toBe("read_regulation");
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(r!.blueprintId).toBe(blueprintId);
    expect(r!.blueprintVersion).toBe(1);
  });

  test("in-app runs of the same agent never see the blueprint", async () => {
    seen.length = 0;
    await startRun({ orgId, agentType: "requisition", principalUserId: userId, goal: "Stock run" });
    await runAgentTick();
    expect(seen[0]!.toolNames).toContain("lookup");
    expect(seen[0]!.system).toContain("STOCK INSTRUCTIONS");
    expect(seen[0]!.system).not.toContain("ADAPTED");
  });

  test("a blueprint never runs outside its workspace organisation", async () => {
    await expect(
      startRun({
        orgId: otherOrgId,
        agentType: "requisition",
        principalUserId: userId,
        goal: "Elsewhere",
        blueprintId,
      }),
    ).rejects.toThrow();
  });
});
