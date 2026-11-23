/**
 * Agent studio server functions — platform super admin only
 * (`requirePlatformAdmin`; docs/agent-studio.md).
 *
 * Studio agents are built here (adapted from a stock agent or new, from the
 * tool catalogue), tested with sample data, approved, published as immutable
 * versions and granted to the organisations the super admin picks, where they
 * run inside the app. They can also be delivered as a package, hosted API or
 * MCP. Every change is audited (`platform.studio_agent.*`).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  agentBlueprintKeys,
  agentBlueprints,
  agentRuns,
  orgMembers,
  organizations,
  studioAgentGrants,
  studioAgentVersions,
  type AgentType,
  type StudioTestResult,
  type StudioTestScenario,
} from "@db/schema";
import { db } from "../server/db";
import { requirePlatformAdmin } from "./auth.middleware";

async function audit(
  userId: string,
  action: string,
  entityId: string,
  detail: unknown,
  orgId: string | null = null,
) {
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId,
    action: `platform.studio_agent.${action}`,
    entityType: "studio_agent",
    entityId,
    detail,
  });
}

async function registry() {
  const { ensureAgentsRegistered } = await import("../server/agents");
  ensureAgentsRegistered();
  return import("../server/agents/registry");
}

const studio = () => import("../server/agents/blueprints.server");

export type StudioToolField = { name: string; type: string; required: boolean };

export type StudioTool = {
  name: string;
  description: string;
  risk: string;
  needsPersonApproval: boolean;
  fields: StudioToolField[];
};

export type StudioStockAgent = {
  type: string;
  name: string;
  version: string;
  responsibility: string;
  instructions: string;
  mustNever: string[];
  maxSteps: number;
  riskTier: "low" | "medium" | "high";
  owner: string;
  gates: string[];
  scope: { reads: string[]; writes: string[]; external: string[] };
  tools: string[];
};

export type StudioAgentRow = {
  id: string;
  origin: "adapted" | "new";
  baseType: string | null;
  type: string | null;
  name: string;
  description: string;
  responsibility: string;
  instructions: string;
  mustNever: string[];
  tools: string[];
  toolOverrides: Record<string, { name: string; description: string }>;
  maxSteps: number | null;
  stepsCap: number;
  riskTier: "low" | "medium" | "high";
  ownerRole: string;
  gates: string[];
  scope: { reads: string[]; writes: string[]; external: string[] };
  /** Sample data travels as JSON text (one object per tool). */
  testScenarios: {
    name: string;
    goal: string;
    fixturesJson: string;
    expectCalls: string[];
    expectApproval: boolean;
  }[];
  lastTest: StudioTestResult | null;
  status: "draft" | "tested" | "approved" | "published" | "archived";
  version: number;
  publishedVersion: number | null;
  approvedAt: string | null;
  outOfDate: boolean;
  workspaceOrgId: string | null;
  grants: { orgId: string; grantedAt: string }[];
  updatedAt: string;
  keys: { id: string; label: string; prefix: string; lastUsedAt: string | null }[];
};

export type StudioView = {
  lockedRules: string;
  roles: readonly string[];
  gateKinds: string[];
  catalogue: { agent: string; tools: StudioTool[] }[];
  stockAgents: StudioStockAgent[];
  agents: StudioAgentRow[];
  /** Every organisation (grant targets). */
  organisations: { id: string; name: string; status: string }[];
  /** Organisations the super admin owns: test runs and hosted workspaces. */
  owned: { id: string; name: string }[];
};

function fieldsOf(parameters: Record<string, unknown>): StudioToolField[] {
  const props = (parameters["properties"] ?? {}) as Record<string, { type?: unknown }>;
  const required = new Set((parameters["required"] as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, p]) => ({
    name,
    type: Array.isArray(p?.type) ? p.type.join(" | ") : String(p?.type ?? "object"),
    required: required.has(name),
  }));
}

async function ownedOrgs(userId: string) {
  return db
    .select({ id: organizations.id, name: organizations.name })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(
      and(
        eq(orgMembers.userId, userId),
        eq(orgMembers.status, "active"),
        eq(orgMembers.isOwner, true),
      ),
    )
    .orderBy(organizations.name);
}

export const agentStudio = createServerFn({ method: "GET" })
  .middleware([requirePlatformAdmin])
  .handler(async ({ context }): Promise<StudioView> => {
    const { listAgents, getTool } = await registry();
    const s = await studio();
    const { toolParameters } = await import("./ai-gateway.server");
    const rows = await db
      .select()
      .from(agentBlueprints)
      .where(inArray(agentBlueprints.status, ["draft", "tested", "approved", "published"]))
      .orderBy(desc(agentBlueprints.updatedAt));
    const ids = rows.map((r) => r.id);
    const [keys, grants, orgs] = await Promise.all([
      ids.length
        ? db
            .select()
            .from(agentBlueprintKeys)
            .where(
              and(
                inArray(agentBlueprintKeys.blueprintId, ids),
                isNull(agentBlueprintKeys.revokedAt),
              ),
            )
            .orderBy(desc(agentBlueprintKeys.createdAt))
        : [],
      ids.length
        ? db
            .select()
            .from(studioAgentGrants)
            .where(
              and(inArray(studioAgentGrants.blueprintId, ids), isNull(studioAgentGrants.revokedAt)),
            )
        : [],
      db
        .select({ id: organizations.id, name: organizations.name, status: organizations.status })
        .from(organizations)
        .orderBy(organizations.name),
    ]);
    const toolView = (name: string): StudioTool => {
      const t = getTool(name);
      return {
        name,
        description: t?.description ?? "",
        risk: t?.risk ?? "read",
        needsPersonApproval: Boolean(t?.templateOf || t?.approverRole || t?.proposes),
        fields: t ? fieldsOf(toolParameters(t.input)) : [],
      };
    };
    const catalogue = s.studioCatalogue();
    const inCatalogue = new Set(catalogue.flatMap((g) => g.tools));
    return {
      lockedRules: s.LOCKED_RULES,
      roles: s.STUDIO_ROLES,
      gateKinds: s.studioGateKinds(),
      catalogue: catalogue.map((g) => ({ agent: g.agent, tools: g.tools.map(toolView) })),
      stockAgents: listAgents()
        .filter((d) => !s.isStudioType(d.type) && d.tools.some((t) => inCatalogue.has(t)))
        .map((d) => ({
          type: d.type,
          name: d.name,
          version: d.version,
          responsibility: d.responsibility,
          instructions: d.system,
          mustNever: d.mustNever,
          maxSteps: d.maxSteps ?? 20,
          riskTier: d.riskTier,
          owner: d.owner,
          gates: d.gates,
          scope: d.scope,
          tools: d.tools.filter((t) => inCatalogue.has(t)),
        })),
      organisations: orgs,
      owned: await ownedOrgs(context.userId),
      agents: rows.map((r) => ({
        id: r.id,
        origin: r.origin,
        baseType: r.origin === "adapted" ? r.agentType : null,
        type: r.typeSlug,
        name: r.name,
        description: r.description,
        responsibility: r.responsibility,
        instructions: r.instructions,
        mustNever: r.mustNever,
        tools: r.tools,
        toolOverrides: r.toolOverrides,
        maxSteps: r.maxSteps,
        stepsCap: s.stepsCap(r),
        riskTier: r.riskTier,
        ownerRole: r.ownerRole,
        gates: r.gates,
        scope: r.scope,
        testScenarios: r.testScenarios.map((t: StudioTestScenario) => ({
          name: t.name,
          goal: t.goal,
          fixturesJson: JSON.stringify(t.fixtures ?? {}, null, 2),
          expectCalls: t.expectCalls ?? [],
          expectApproval: Boolean(t.expectApproval),
        })),
        lastTest: r.lastTest ?? null,
        status: r.status,
        version: r.version,
        publishedVersion: r.publishedVersion,
        approvedAt: r.approvedAt?.toISOString() ?? null,
        outOfDate: s.isOutOfDate(r),
        workspaceOrgId: r.workspaceOrgId,
        grants: grants
          .filter((g) => g.blueprintId === r.id)
          .map((g) => ({ orgId: g.orgId, grantedAt: g.grantedAt.toISOString() })),
        updatedAt: r.updatedAt.toISOString(),
        keys: keys
          .filter((k) => k.blueprintId === r.id)
          .map((k) => ({
            id: k.id,
            label: k.label,
            prefix: k.keyPrefix,
            lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          })),
      })),
    };
  });

const Scenario = z.object({
  name: z.string().max(80),
  goal: z.string().max(2000),
  /** Real tool name → sample result, as JSON text. */
  fixturesJson: z.string().max(50_000),
  expectCalls: z.array(z.string().max(80)).max(12).optional(),
  expectApproval: z.boolean().optional(),
});

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  origin: z.enum(["adapted", "new"]),
  /** Stock agent an adapted agent starts from. */
  baseType: z.string().max(40).nullable(),
  name: z.string().max(80),
  description: z.string().max(500),
  responsibility: z.string().max(600),
  instructions: z.string().max(20_000),
  mustNever: z.array(z.string().max(300)).max(30),
  tools: z.array(z.string().max(80)).max(60),
  toolOverrides: z.record(
    z.string().max(80),
    z.object({ name: z.string().max(80), description: z.string().max(1500) }),
  ),
  maxSteps: z.number().int().nullable(),
  riskTier: z.enum(["low", "medium", "high"]),
  ownerRole: z.string().max(40),
  gates: z.array(z.string().max(40)).max(12),
  scope: z.object({
    reads: z.array(z.string().max(200)).max(20),
    writes: z.array(z.string().max(200)).max(20),
    external: z.array(z.string().max(200)).max(20),
  }),
  testScenarios: z.array(Scenario).max(5),
});

export type SaveStudioAgentInput = z.infer<typeof SaveInput>;

function parseFixtures(name: string, json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new Error(`Test "${name}": the sample data is not valid JSON.`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error(`Test "${name}": sample data must be an object of tool name → result.`);
  return v as Record<string, unknown>;
}

async function uniqueType(name: string): Promise<`studio:${string}`> {
  const s = await studio();
  const base = s.studioTypeFor(name);
  for (let n = 0; n < 50; n++) {
    const candidate = (n ? `${base}_${n + 1}` : base) as `studio:${string}`;
    const [taken] = await db
      .select({ id: agentBlueprints.id })
      .from(agentBlueprints)
      .where(eq(agentBlueprints.typeSlug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  throw new Error("Choose a different name.");
}

/**
 * Save the working copy as a new draft version (a published version keeps
 * running until another is published). Testing and approval start again.
 */
export const saveStudioAgent = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    const { getAgent } = await registry();
    const { manifestHash } = await import("../server/agents/manifest.server");
    const s = await studio();
    const { scenarioProblem } = await import("../server/agents/studio-test.server");
    const base = data.origin === "adapted" ? getAgent((data.baseType ?? "") as AgentType) : null;
    if (data.origin === "adapted" && (!base || s.isStudioType(base.type)))
      throw new Error("Pick the stock agent to start from.");
    const keep = new Set(data.tools);
    const content = {
      name: data.name.trim(),
      description: data.description.trim(),
      responsibility: data.responsibility.trim(),
      instructions: data.instructions.trim(),
      mustNever: data.mustNever.map((m) => m.trim()).filter(Boolean),
      tools: data.tools,
      toolOverrides: Object.fromEntries(
        Object.entries(data.toolOverrides)
          .filter(([real]) => keep.has(real))
          .map(([real, o]) => [real, { name: o.name.trim(), description: o.description.trim() }]),
      ),
      maxSteps: data.maxSteps,
      riskTier: data.riskTier,
      ownerRole: data.ownerRole,
      gates: data.gates,
      scope: {
        reads: data.scope.reads.map((x) => x.trim()).filter(Boolean),
        writes: data.scope.writes.map((x) => x.trim()).filter(Boolean),
        external: data.scope.external.map((x) => x.trim()).filter(Boolean),
      },
      testScenarios: data.testScenarios.map((t) => ({
        name: t.name.trim(),
        goal: t.goal.trim(),
        fixtures: parseFixtures(t.name, t.fixturesJson),
        ...(t.expectCalls?.length ? { expectCalls: t.expectCalls } : {}),
        ...(t.expectApproval ? { expectApproval: true } : {}),
      })),
    };
    const cap = data.origin === "new" ? s.NEW_AGENT_MAX_STEPS : (base?.maxSteps ?? 20);
    const problem = s.blueprintProblem(content, { stepsCap: cap });
    if (problem) throw new Error(problem);
    for (const t of content.testScenarios) {
      const p = scenarioProblem(t, content.tools);
      if (p) throw new Error(p);
    }
    const now = new Date();
    if (data.id) {
      const current = await s.loadBlueprint(data.id);
      if (!current || current.status === "archived") throw new Error("Agent not found.");
      if (current.origin !== data.origin) throw new Error("An agent keeps its origin.");
      if (data.origin === "adapted" && current.agentType !== base!.type)
        throw new Error("An adapted agent keeps its stock agent.");
      const version = current.version + 1;
      await db
        .update(agentBlueprints)
        .set({
          ...content,
          ...(base ? { baseVersion: base.version, baseHash: manifestHash(base) } : {}),
          status: "draft",
          version,
          approvedBy: null,
          approvedAt: null,
          updatedAt: now,
        })
        .where(eq(agentBlueprints.id, data.id));
      await audit(context.userId, "saved", data.id, { version, tools: content.tools });
      return { id: data.id };
    }
    const type = await uniqueType(content.name);
    const [row] = await db
      .insert(agentBlueprints)
      .values({
        origin: data.origin,
        typeSlug: type,
        agentType: (base?.type ?? type) as AgentType,
        baseVersion: base?.version ?? "",
        baseHash: base ? manifestHash(base) : "",
        ...content,
        status: "draft",
        createdBy: context.userId,
      })
      .returning({ id: agentBlueprints.id });
    await audit(context.userId, "created", row!.id, { origin: data.origin, type });
    return { id: row!.id };
  });

const IdInput = z.object({ id: z.string().uuid() });
const TestInput = z.object({ id: z.string().uuid(), orgId: z.string().uuid() });

/**
 * Run the draft's tests with sample data in a test organisation the super
 * admin owns (on its own AI key). All passing makes the version "tested".
 */
export const testStudioAgent = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => TestInput.parse(d))
  .handler(async ({ data, context }): Promise<StudioTestResult> => {
    await registry();
    const s = await studio();
    const bp = await s.loadBlueprint(data.id);
    if (!bp || bp.status === "archived") throw new Error("Agent not found.");
    if (!bp.testScenarios.length) throw new Error("Add at least one test with sample data.");
    if (!(await s.isWorkspaceOwner(context.userId, data.orgId)))
      throw new Error("Run tests in an organisation you own.");
    const { resolveAiConfig } = await import("./ai-gateway.server");
    if (!(await resolveAiConfig(data.orgId)).apiKey)
      throw new Error("That organisation has no AI model key saved.");
    const { runStudioTests } = await import("../server/agents/studio-test.server");
    const result = await runStudioTests(bp, data.orgId, context.userId);
    // Only the version that was tested moves on; an edit meanwhile starts again.
    const [now] = await db
      .select({ version: agentBlueprints.version, status: agentBlueprints.status })
      .from(agentBlueprints)
      .where(eq(agentBlueprints.id, bp.id));
    const same = now?.version === bp.version;
    await db
      .update(agentBlueprints)
      .set({
        lastTest: result,
        ...(same && result.passed && now?.status === "draft" ? { status: "tested" } : {}),
        updatedAt: new Date(),
      })
      .where(eq(agentBlueprints.id, bp.id));
    await audit(
      context.userId,
      "tested",
      bp.id,
      {
        version: bp.version,
        passed: result.passed,
        runs: result.runs.map((r) => ({ scenario: r.scenario, passed: r.passed, runId: r.runId })),
      },
      data.orgId,
    );
    return result;
  });

/** Approve a tested version (its tests passed for exactly this version). */
export const approveStudioAgent = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    const s = await studio();
    const bp = await s.loadBlueprint(data.id);
    if (!bp) throw new Error("Agent not found.");
    const problem = s.approveProblem(bp);
    if (problem) throw new Error(problem);
    const now = new Date();
    await db
      .update(agentBlueprints)
      .set({ status: "approved", approvedBy: context.userId, approvedAt: now, updatedAt: now })
      .where(and(eq(agentBlueprints.id, bp.id), eq(agentBlueprints.version, bp.version)));
    await audit(context.userId, "approved", bp.id, {
      version: bp.version,
      // One super admin both built and approved it: recorded, allowed only after passing tests.
      selfApproved: bp.createdBy === context.userId,
    });
    return { ok: true };
  });

/** Publish the approved version: an immutable manifest that runs pin. */
export const publishStudioAgent = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    await registry();
    const s = await studio();
    const bp = await s.loadBlueprint(data.id);
    if (!bp) throw new Error("Agent not found.");
    const problem = s.publishProblem(bp);
    if (problem || !bp.lastTest || !bp.approvedAt || !bp.typeSlug)
      throw new Error(problem ?? "Only an approved version can be published.");
    const manifest = s.studioManifest(bp, bp.typeSlug as `studio:${string}`, bp.version);
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(studioAgentVersions).values({
        blueprintId: bp.id,
        version: bp.version,
        typeSlug: bp.typeSlug!,
        manifest: manifest as unknown as Record<string, unknown>,
        hash: s.manifestDigest(manifest),
        test: bp.lastTest!,
        approvedBy: bp.approvedBy,
        approvedAt: bp.approvedAt!,
        publishedBy: context.userId,
      });
      await tx
        .update(agentBlueprints)
        .set({ status: "published", publishedVersion: bp.version, updatedAt: now })
        .where(eq(agentBlueprints.id, bp.id));
    });
    s.clearStudioCache();
    await audit(context.userId, "published", bp.id, {
      version: bp.version,
      type: bp.typeSlug,
      hash: s.manifestDigest(manifest),
    });
    return { ok: true };
  });

const GrantInput = z.object({ id: z.string().uuid(), orgId: z.string().uuid() });

/** Make a published studio agent available to an organisation (off until they switch it on). */
export const grantStudioAgent = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => GrantInput.parse(d))
  .handler(async ({ data, context }) => {
    const s = await studio();
    const bp = await s.loadBlueprint(data.id);
    if (!bp || bp.status === "archived" || bp.publishedVersion == null)
      throw new Error("Publish the agent first.");
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, data.orgId))
      .limit(1);
    if (!org) throw new Error("Organisation not found.");
    if (await s.hasGrant(bp.id, data.orgId)) return { ok: true };
    await db
      .insert(studioAgentGrants)
      .values({ blueprintId: bp.id, orgId: data.orgId, grantedBy: context.userId });
    s.clearStudioCache();
    await audit(context.userId, "granted", bp.id, { type: bp.typeSlug }, data.orgId);
    return { ok: true };
  });

/** Withdraw it from an organisation: new runs are refused and open runs cancelled. */
export const revokeStudioAgent = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => GrantInput.parse(d))
  .handler(async ({ data, context }) => {
    const s = await studio();
    const bp = await s.loadBlueprint(data.id);
    if (!bp) throw new Error("Agent not found.");
    await revokeGrants(bp, data.orgId, context.userId);
    await audit(context.userId, "revoked", bp.id, { type: bp.typeSlug }, data.orgId);
    return { ok: true };
  });

async function revokeGrants(
  bp: { id: string; typeSlug: string | null },
  orgId: string | null,
  userId: string,
) {
  const now = new Date();
  const ended = await db
    .update(studioAgentGrants)
    .set({ revokedAt: now })
    .where(
      and(
        eq(studioAgentGrants.blueprintId, bp.id),
        isNull(studioAgentGrants.revokedAt),
        ...(orgId ? [eq(studioAgentGrants.orgId, orgId)] : []),
      ),
    )
    .returning({ orgId: studioAgentGrants.orgId });
  (await studio()).clearStudioCache();
  if (!bp.typeSlug) return;
  const { cancelRun } = await import("../server/agents/runtime.server");
  for (const g of ended) {
    const open = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, g.orgId),
          eq(agentRuns.agentType, bp.typeSlug as AgentType),
          inArray(agentRuns.status, ["queued", "running", "awaiting_human"]),
        ),
      );
    for (const r of open) await cancelRun({ orgId: g.orgId, runId: r.id, userId });
  }
}

/** A draft copy (new type, tests kept, nothing granted). */
export const duplicateStudioAgent = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    const s = await studio();
    const bp = await s.loadBlueprint(data.id);
    if (!bp || bp.status === "archived") throw new Error("Agent not found.");
    const name = `${bp.name} (copy)`.slice(0, 80);
    const type = await uniqueType(name);
    const [row] = await db
      .insert(agentBlueprints)
      .values({
        origin: bp.origin,
        typeSlug: type,
        agentType: (bp.origin === "adapted" ? bp.agentType : type) as AgentType,
        baseVersion: bp.baseVersion,
        baseHash: bp.baseHash,
        name,
        description: bp.description,
        responsibility: bp.responsibility,
        instructions: bp.instructions,
        mustNever: bp.mustNever,
        tools: bp.tools,
        toolOverrides: bp.toolOverrides,
        maxSteps: bp.maxSteps,
        riskTier: bp.riskTier,
        ownerRole: bp.ownerRole,
        gates: bp.gates,
        scope: bp.scope,
        testScenarios: bp.testScenarios,
        status: "draft",
        createdBy: context.userId,
      })
      .returning({ id: agentBlueprints.id });
    await audit(context.userId, "duplicated", row!.id, { from: bp.id });
    return { id: row!.id };
  });

/** Archive: every grant and key is withdrawn and open runs are cancelled. */
export const archiveStudioAgent = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    const s = await studio();
    const bp = await s.loadBlueprint(data.id);
    if (!bp) throw new Error("Agent not found.");
    const now = new Date();
    await db
      .update(agentBlueprints)
      .set({ status: "archived", updatedAt: now })
      .where(eq(agentBlueprints.id, bp.id));
    await db
      .update(agentBlueprintKeys)
      .set({ revokedAt: now })
      .where(and(eq(agentBlueprintKeys.blueprintId, bp.id), isNull(agentBlueprintKeys.revokedAt)));
    await revokeGrants(bp, null, context.userId);
    await audit(context.userId, "archived", bp.id, {});
    return { ok: true };
  });

/** The published version's portable package, as a JSON file body. Audited. */
export const downloadStudioPackage = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }): Promise<{ fileName: string; json: string }> => {
    await registry();
    const s = await studio();
    const bp = await s.loadBlueprint(data.id);
    if (!bp || bp.status === "archived" || !bp.typeSlug) throw new Error("Agent not found.");
    const p = await s.publishedStudioAgent(bp.typeSlug);
    if (!p) throw new Error("Publish the agent first.");
    const pkg = s.buildPackage(p.manifest, bp.description);
    await audit(context.userId, "downloaded", bp.id, { version: p.manifest.version });
    const slug =
      bp.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "agent";
    return {
      fileName: `${slug}-v${p.manifest.version}.agent.json`,
      json: JSON.stringify(pkg, null, 2),
    };
  });

const WorkspaceInput = z.object({ id: z.string().uuid(), orgId: z.string().uuid().nullable() });

/**
 * Where hosted runs execute: an organisation the super admin owns that holds
 * a grant (its data, AI key and Agent settings). Changing it revokes keys.
 */
export const setStudioWorkspace = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => WorkspaceInput.parse(d))
  .handler(async ({ data, context }) => {
    const s = await studio();
    const bp = await s.loadBlueprint(data.id);
    if (!bp || bp.status === "archived") throw new Error("Agent not found.");
    if (data.orgId && !(await s.isWorkspaceOwner(context.userId, data.orgId)))
      throw new Error("Pick an organisation you own.");
    if (data.orgId && !(await s.hasGrant(bp.id, data.orgId)))
      throw new Error("Grant the agent to that organisation first.");
    const now = new Date();
    await db
      .update(agentBlueprints)
      .set({ workspaceOrgId: data.orgId, updatedAt: now })
      .where(eq(agentBlueprints.id, bp.id));
    if (bp.workspaceOrgId !== data.orgId)
      await db
        .update(agentBlueprintKeys)
        .set({ revokedAt: now })
        .where(
          and(eq(agentBlueprintKeys.blueprintId, bp.id), isNull(agentBlueprintKeys.revokedAt)),
        );
    await audit(context.userId, "workspace_set", bp.id, { orgId: data.orgId }, data.orgId);
    return { ok: true };
  });

const KeyInput = z.object({ id: z.string().uuid(), label: z.string().max(80) });

/** Issue a hosted-API key (shown once; only its hash is kept). Runs act as the caller. */
export const createStudioKey = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => KeyInput.parse(d))
  .handler(async ({ data, context }): Promise<{ key: string }> => {
    const s = await studio();
    const bp = await s.loadBlueprint(data.id);
    if (!bp || bp.status === "archived" || bp.publishedVersion == null)
      throw new Error("Publish the agent first.");
    if (!bp.workspaceOrgId) throw new Error("Pick a workspace first.");
    if (!(await s.isWorkspaceOwner(context.userId, bp.workspaceOrgId)))
      throw new Error("You must own the workspace organisation.");
    const k = s.newKey();
    const [row] = await db
      .insert(agentBlueprintKeys)
      .values({
        blueprintId: bp.id,
        orgId: bp.workspaceOrgId,
        label: data.label.trim(),
        keyPrefix: k.prefix,
        keyHash: k.hash,
        principalUserId: context.userId,
        createdBy: context.userId,
      })
      .returning({ id: agentBlueprintKeys.id });
    await audit(
      context.userId,
      "key_created",
      bp.id,
      { keyId: row!.id, prefix: k.prefix },
      bp.workspaceOrgId,
    );
    return { key: k.key };
  });

const RevokeInput = z.object({ keyId: z.string().uuid() });

export const revokeStudioKey = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => RevokeInput.parse(d))
  .handler(async ({ data, context }) => {
    const done = await db
      .update(agentBlueprintKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(agentBlueprintKeys.id, data.keyId), isNull(agentBlueprintKeys.revokedAt)))
      .returning({
        blueprintId: agentBlueprintKeys.blueprintId,
        orgId: agentBlueprintKeys.orgId,
        prefix: agentBlueprintKeys.keyPrefix,
      });
    if (!done.length) throw new Error("Key not found.");
    await audit(
      context.userId,
      "key_revoked",
      done[0]!.blueprintId,
      { keyId: data.keyId, prefix: done[0]!.prefix },
      done[0]!.orgId,
    );
    return { ok: true };
  });
