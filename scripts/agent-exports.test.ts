/**
 * Agent studio (docs/agent-studio.md): a customised export can only narrow
 * the stock agent, packages are vendor-neutral and carry no gate tools, keys
 * are stored as hashes, and every export query is scoped to the organisation.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const { ensureAgentsRegistered } = await import("../src/server/agents");
ensureAgentsRegistered();
const { getAgent, listAgents } = await import("../src/server/agents/registry");
const { buildPackage, effectiveDefinition, exportProblem, hashKey, newKey, PACKAGE_FORMAT } =
  await import("../src/server/agents/exports.server");
const { manifestHash } = await import("../src/server/agents/manifest.server");

const def = getAgent("org_context")!;

function custom(over: Partial<Parameters<typeof exportProblem>[1]> = {}) {
  return {
    name: "Company profile builder",
    description: "Builds a company profile from public sources.",
    extraInstructions: "Write in British English.",
    tools: def.tools.slice(0, 3),
    extraMustNever: ["Contact anyone outside the organisation"],
    maxSteps: null,
    maxTokens: null,
    ...over,
  };
}

function row(over: Partial<Parameters<typeof exportProblem>[1]> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    agentType: def.type,
    baseVersion: def.version,
    baseHash: manifestHash(def),
    status: "published" as const,
    version: 3,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...custom(over),
  };
}

describe("exports only narrow the stock agent", () => {
  test("a tool the agent does not have is refused", () => {
    expect(exportProblem(def, custom({ tools: [...def.tools, "start_agent"] }))).toContain(
      "Not a tool of this agent",
    );
  });
  test("no tools, duplicates and raised limits are refused", () => {
    expect(exportProblem(def, custom({ tools: [] }))).not.toBeNull();
    expect(exportProblem(def, custom({ tools: [def.tools[0]!, def.tools[0]!] }))).not.toBeNull();
    expect(exportProblem(def, custom({ maxSteps: (def.maxSteps ?? 20) + 1 }))).not.toBeNull();
    expect(exportProblem(def, custom({ name: "  " }))).not.toBeNull();
  });
  test("a valid customisation passes", () => {
    expect(exportProblem(def, custom())).toBeNull();
  });
  test("the effective definition keeps stock instructions and rules, and narrows tools", () => {
    const eff = effectiveDefinition(def, custom({ maxSteps: 3 }));
    expect(eff.system.startsWith(def.system)).toBe(true);
    expect(eff.system).toContain("never override them");
    expect(eff.tools).toEqual(def.tools.slice(0, 3));
    expect(eff.mustNever.slice(0, def.mustNever.length)).toEqual(def.mustNever);
    expect(eff.mustNever).toContain("Contact anyone outside the organisation");
    expect(eff.maxSteps).toBe(3);
    expect(eff.gates).toEqual(def.gates);
  });
  test("the stock agent is never changed", () => {
    const before = manifestHash(def);
    effectiveDefinition(def, custom());
    expect(manifestHash(getAgent("org_context")!)).toBe(before);
  });
});

describe("packages", () => {
  const VENDOR =
    /\b(openai|anthropic|claude|gpt-?\d|gemini|google ai|mistral|llama|cohere|deepseek|vertex|bedrock)\b/i;
  const GATE =
    /(^|_)(approve|approval|release|reject|hire|revoke|decline|accept|confirm|sign|advance|finalize|complete)(_|$)/;

  for (const d of listAgents().filter((a) => a.tools.length)) {
    test(`${d.type}: vendor-neutral, no model fields, no gate tools`, () => {
      const pkg = buildPackage(d, { ...row({ tools: d.tools }), agentType: d.type });
      const text = JSON.stringify(pkg);
      expect(pkg.format).toBe(PACKAGE_FORMAT);
      expect(text).not.toMatch(VENDOR);
      const banned = ["model", "engine", "feature", "skills"];
      for (const obj of [pkg, pkg.agent, ...pkg.tools, ...pkg.humanTools])
        for (const k of banned) expect(Object.keys(obj)).not.toContain(k);
      for (const t of pkg.tools)
        expect(GATE.test(t.name) && !/^(propose|request|submit)_/.test(t.name)).toBe(false);
      expect(pkg.instructions).toContain(d.system);
    });
  }
});

describe("keys", () => {
  test("only a hash and a short prefix are stored", () => {
    const k = newKey();
    expect(k.key.startsWith("atsk_")).toBe(true);
    expect(k.hash).toBe(hashKey(k.key));
    expect(k.hash).not.toContain(k.key);
    expect(k.key.startsWith(k.prefix)).toBe(true);
    expect(k.prefix.length).toBeLessThan(k.key.length / 2);
  });
});

describe("tenant scoping", () => {
  test("every export and key query in the server functions names the organisation", () => {
    const src = readFileSync("src/lib/agent-exports.functions.ts", "utf8");
    const queries = src.split(/\.(?:select|update|insert)\(/).slice(1);
    for (const q of queries) {
      const head = q.slice(0, 900);
      if (!/agentExport(s|Keys)/.test(head.split(";")[0]!)) continue;
      expect(head).toMatch(/orgId: context\.orgId|\.orgId, context\.orgId\)/);
    }
  });
  test("runs read through the hosted API are limited to the key's org and export", () => {
    const src = readFileSync("src/server/agents/hosted-api.server.ts", "utf8");
    expect(src).toContain("eq(agentRuns.orgId, k.orgId)");
    expect(src).toContain("eq(agentRuns.exportId, k.export.id)");
  });
});
