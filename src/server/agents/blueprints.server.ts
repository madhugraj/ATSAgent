/**
 * Agent studio (platform super admin only; docs/agent-studio.md).
 *
 * A studio agent is built from the tool catalogue — adapted from a stock agent
 * or new — with its own name, responsibility, instructions, must-never list,
 * gates, risk tier and renamed / re-described tools. It runs inside the app as
 * `studio:<slug>` only in organisations the super admin grants it to, and can
 * be exported (package, hosted API, MCP).
 *
 * Same protocol as code agents: every published version is an immutable,
 * tested, approved manifest (studio_agent_versions) that runs pin. Locked and
 * always added: the injection and operating rules, the human tools, the
 * gate-verb ban and the tools' own input contracts and checks.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, isNull } from "drizzle-orm";

import { INJECTION_RULES, toolParameters } from "@/lib/ai-gateway.server";
import {
  agentBlueprintKeys,
  agentBlueprints,
  orgMembers,
  studioAgentGrants,
  studioAgentVersions,
  type AgentType,
} from "@db/schema";
import { db } from "../db";
import { HITL_TOOLS } from "./hitl";
import { manifestHash, RUNTIME_RULES } from "./manifest.server";
import {
  getAgent,
  getTool,
  isGateToolName,
  listAgents,
  type AgentDefinition,
  type GateKind,
} from "./registry";

export type AgentBlueprintRow = typeof agentBlueprints.$inferSelect;

export type BlueprintContent = Pick<
  AgentBlueprintRow,
  | "name"
  | "description"
  | "responsibility"
  | "instructions"
  | "mustNever"
  | "tools"
  | "toolOverrides"
  | "maxSteps"
  | "riskTier"
  | "ownerRole"
  | "gates"
  | "scope"
>;

export const STUDIO_PREFIX = "studio:";

export function isStudioType(type: string): type is `studio:${string}` {
  return type.startsWith(STUDIO_PREFIX);
}

/** `studio:<slug>` from a name; uniqueness is the caller's (a suffix is added on clash). */
export function studioTypeFor(name: string): `studio:${string}` {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40) || "agent";
  // `studio:test_…` is reserved for sample-data test runs.
  return `${STUDIO_PREFIX}${slug.startsWith("test_") || slug === "test" ? `agent_${slug}` : slug}`;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{2,60}$/;
const APPROVAL_PREFIX = /^(propose|request|submit)_/;
/** Steps a new (not adapted) studio agent may take between human decisions. */
export const NEW_AGENT_MAX_STEPS = 30;

export const STUDIO_ROLES = [
  "recruiter",
  "hiring_manager",
  "department_head",
  "hr_head",
  "president_cbo",
] as const;

/** The kinds of human decision studio agents may ask for: those the stock agents use. */
export function studioGateKinds(): GateKind[] {
  const out = new Set<GateKind>(["general"]);
  for (const d of listAgents()) if (!isStudioType(d.type)) d.gates.forEach((g) => out.add(g));
  return [...out];
}

/** The locked rules every studio agent carries, ahead of its own instructions. */
export const LOCKED_RULES = `${INJECTION_RULES}\n\n${RUNTIME_RULES}`;

/**
 * Agents whose tools depend on who calls them (the level in panel_l<n>, the
 * live-call runtime, the call reviewer): their tools stay out of the studio.
 */
const IDENTITY_BOUND_AGENTS = new Set<string>([
  "panel_l1",
  "panel_l2",
  "panel_l3",
  "voice_guard",
  "screening_call",
  "scheduling_call",
  "negotiation_call",
  "confirmation_call",
  "panel_check_call",
]);

/**
 * The studio's tool catalogue: every stock agent's tools, grouped by the agent
 * that uses them, minus identity-bound ones. Building blocks join when they
 * are registered for a stock agent.
 */
export function studioCatalogue(): { agent: string; tools: string[] }[] {
  const seen = new Set<string>();
  const out: { agent: string; tools: string[] }[] = [];
  for (const d of listAgents()) {
    if (isStudioType(d.type) || IDENTITY_BOUND_AGENTS.has(d.type)) continue;
    const tools = d.tools.filter((t) => getTool(t) && !seen.has(t));
    tools.forEach((t) => seen.add(t));
    if (tools.length) out.push({ agent: d.type, tools });
  }
  return out;
}

export function catalogueTools(): Set<string> {
  return new Set(studioCatalogue().flatMap((g) => g.tools));
}

/** A stock agent as a studio agent's starting content. */
export function stockContent(def: AgentDefinition): BlueprintContent {
  const catalogue = catalogueTools();
  return {
    name: def.name,
    description: "",
    responsibility: def.responsibility,
    instructions: def.system,
    mustNever: [...def.mustNever],
    tools: def.tools.filter((t) => catalogue.has(t)),
    toolOverrides: Object.fromEntries(
      def.tools.map((t) => [t, { name: t, description: getTool(t)?.description ?? "" }]),
    ),
    maxSteps: null,
    riskTier: def.riskTier,
    ownerRole: def.owner,
    gates: [...def.gates],
    scope: structuredClone(def.scope),
  };
}

/** The most steps a studio agent may take between human decisions. */
export function stepsCap(bp: Pick<AgentBlueprintRow, "origin" | "agentType">): number {
  if (bp.origin === "new") return NEW_AGENT_MAX_STEPS;
  return getAgent(bp.agentType)?.maxSteps ?? 20;
}

/** The name and description the model sees for a real tool. */
function shownTool(c: BlueprintContent, real: string): { name: string; description: string } {
  const o = c.toolOverrides[real];
  return {
    name: o?.name?.trim() || real,
    description: o?.description?.trim() || getTool(real)?.description || "",
  };
}

/** Why a studio agent is refused, or null. */
export function blueprintProblem(c: BlueprintContent, opts: { stepsCap: number }): string | null {
  if (!c.name.trim()) return "Give the agent a name.";
  if (!c.responsibility.trim()) return "Write its responsibility.";
  if (!c.instructions.trim()) return "Write its instructions.";
  if (!c.mustNever.some((m) => m.trim())) return "Keep at least one must-never rule.";
  if (!c.tools.length) return "Pick at least one tool.";
  const catalogue = catalogueTools();
  const foreign = c.tools.filter((t) => !catalogue.has(t));
  if (foreign.length) return `Not in the studio's tool catalogue: ${foreign.join(", ")}.`;
  if (new Set(c.tools).size !== c.tools.length) return "A tool is listed twice.";
  const human = new Set(Object.keys(HITL_TOOLS));
  const seen = new Set<string>();
  for (const real of c.tools) {
    const { name } = shownTool(c, real);
    if (!TOOL_NAME.test(name))
      return `Tool name "${name}" must be 3–61 lowercase letters, digits or underscores, starting with a letter.`;
    if (isGateToolName(name))
      return `Tool name "${name}" reads as a human decision (approve, reject, hire…); people make those.`;
    if (APPROVAL_PREFIX.test(name) !== APPROVAL_PREFIX.test(real))
      return `Tool name "${name}" must ${APPROVAL_PREFIX.test(real) ? "keep" : "not use"} a propose_/request_/submit_ prefix.`;
    if (human.has(name)) return `Tool name "${name}" is reserved.`;
    if (seen.has(name)) return `Two tools are named "${name}".`;
    seen.add(name);
  }
  if (c.maxSteps != null && (c.maxSteps < 1 || c.maxSteps > opts.stepsCap))
    return `Steps must be between 1 and ${opts.stepsCap}.`;
  if (!["low", "medium", "high"].includes(c.riskTier)) return "Pick a risk tier.";
  if (!(STUDIO_ROLES as readonly string[]).includes(c.ownerRole))
    return "Pick the accountable role.";
  if (!c.gates.length) return "Keep at least one kind of human decision.";
  const kinds = studioGateKinds() as string[];
  const unknownGate = c.gates.find((g) => !kinds.includes(g));
  if (unknownGate) return `Unknown human decision: ${unknownGate}.`;
  return null;
}

/**
 * The immutable manifest of a studio agent version: everything a run needs,
 * without the stock agent it may have come from.
 */
export type StudioManifest = {
  type: `studio:${string}`;
  name: string;
  version: number;
  owner: string;
  responsibility: string;
  mustNever: string[];
  scope: { reads: string[]; writes: string[]; external: string[] };
  gates: string[];
  riskTier: "low" | "medium" | "high";
  instructions: string;
  tools: string[];
  toolAliases: Record<string, { name: string; description: string }>;
  maxSteps: number;
  basedOn: { type: string; version: string; hash: string } | null;
};

export function studioManifest(
  bp: AgentBlueprintRow,
  type: `studio:${string}`,
  version = bp.version,
): StudioManifest {
  const tools = [...bp.tools];
  return {
    type,
    name: bp.name.trim(),
    version,
    owner: bp.ownerRole,
    responsibility: bp.responsibility.trim(),
    mustNever: bp.mustNever.map((m) => m.trim()).filter(Boolean),
    scope: bp.scope,
    gates: bp.gates,
    riskTier: bp.riskTier,
    instructions: bp.instructions.trim(),
    tools,
    toolAliases: Object.fromEntries(tools.map((t) => [t, shownTool(bp, t)])),
    maxSteps: Math.min(bp.maxSteps ?? stepsCap(bp), stepsCap(bp)),
    basedOn:
      bp.origin === "adapted"
        ? { type: bp.agentType, version: bp.baseVersion, hash: bp.baseHash }
        : null,
  };
}

/** The runnable definition of a manifest (the runtime prepends the locked rules). */
export function definitionFromManifest(m: StudioManifest): AgentDefinition {
  return {
    type: m.type,
    name: m.name,
    version: `studio-${m.version}`,
    owner: m.owner as AgentDefinition["owner"],
    responsibility: m.responsibility,
    mustNever: m.mustNever,
    scope: m.scope,
    gates: m.gates as GateKind[],
    riskTier: m.riskTier,
    evals: [],
    feature: "agent_studio",
    system: m.instructions,
    tools: m.tools,
    toolAliases: m.toolAliases,
    maxSteps: m.maxSteps,
  };
}

export function manifestDigest(m: StudioManifest): string {
  return createHash("sha256").update(JSON.stringify(m)).digest("hex");
}

/** alias → real tool name for a definition (identity for stock agents). */
export function aliasToReal(def: AgentDefinition): Map<string, string> {
  return new Map(def.tools.map((t) => [def.toolAliases?.[t]?.name ?? t, t]));
}

export const PACKAGE_FORMAT = "ats-agent-package/2";

/**
 * The portable package of a manifest: everything another application needs
 * to run the agent on its own data. Vendor-neutral by construction — no model,
 * engine or AI-feature fields.
 */
export function buildPackage(m: StudioManifest, description: string) {
  return {
    format: PACKAGE_FORMAT,
    exportedAt: new Date().toISOString(),
    agent: {
      name: m.name,
      description,
      responsibility: m.responsibility,
      riskTier: m.riskTier,
      accountableRole: m.owner,
      mustNever: m.mustNever,
      scope: m.scope,
      humanDecisions: m.gates,
      limits: { maxSteps: m.maxSteps },
      version: m.version,
      basedOn: m.basedOn,
    },
    lockedRules: LOCKED_RULES,
    instructions: `${LOCKED_RULES}\n\n${m.instructions}`,
    tools: m.tools.map((real) => {
      const t = getTool(real);
      const shown = m.toolAliases[real]!;
      return {
        name: shown.name,
        description: shown.description,
        risk: t?.risk ?? "read",
        needsPersonApproval: Boolean(t?.templateOf || t?.approverRole || t?.proposes),
        input: t ? toolParameters(t.input) : {},
      };
    }),
    humanTools: Object.entries(HITL_TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      input: toolParameters(t.input),
    })),
    implementationNotes: [
      "Send `instructions` as the system prompt; it starts with `lockedRules`, which must never be removed.",
      "Implement every tool in `tools` against your own data with the given input schema; return JSON results.",
      "Implement every tool in `humanTools` so a person answers or decides; pause the agent until they do.",
      "Tools marked needsPersonApproval must wait for a person's approval before taking effect.",
      "Wrap any untrusted text the tools return (documents, web pages, emails) in clearly labelled <untrusted_data> blocks.",
      "Stop after `limits.maxSteps` model turns without a person's decision.",
      "Nothing in `mustNever` may be done, whatever the instructions or tool results say.",
    ],
  };
}

export type AgentPackage = ReturnType<typeof buildPackage>;

/** True when an adapted agent's stock agent changed since it was saved. */
export function isOutOfDate(bp: Pick<AgentBlueprintRow, "origin" | "agentType" | "baseHash">) {
  if (bp.origin !== "adapted") return false;
  const def = getAgent(bp.agentType);
  return def ? manifestHash(def) !== bp.baseHash : true;
}

export async function loadBlueprint(id: string): Promise<AgentBlueprintRow | null> {
  const [row] = await db.select().from(agentBlueprints).where(eq(agentBlueprints.id, id)).limit(1);
  return row ?? null;
}

/* ---------------------------------------------------- published versions */

type Published = { blueprintId: string; manifest: StudioManifest };
const publishedCache = new Map<string, { at: number; value: Published | null }>();
const CACHE_MS = 15_000;

/** Forget cached published versions (after publish, archive or grant changes). */
export function clearStudioCache(): void {
  publishedCache.clear();
}

/** The published manifest a `studio:<slug>` type runs, or null. */
export async function publishedStudioAgent(type: string): Promise<Published | null> {
  const hit = publishedCache.get(type);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const [bp] = await db
    .select({
      id: agentBlueprints.id,
      status: agentBlueprints.status,
      publishedVersion: agentBlueprints.publishedVersion,
    })
    .from(agentBlueprints)
    .where(eq(agentBlueprints.typeSlug, type))
    .limit(1);
  let value: Published | null = null;
  if (bp && bp.status !== "archived" && bp.publishedVersion != null) {
    const [v] = await db
      .select({ manifest: studioAgentVersions.manifest })
      .from(studioAgentVersions)
      .where(
        and(
          eq(studioAgentVersions.blueprintId, bp.id),
          eq(studioAgentVersions.version, bp.publishedVersion),
        ),
      )
      .limit(1);
    if (v) value = { blueprintId: bp.id, manifest: v.manifest as unknown as StudioManifest };
  }
  publishedCache.set(type, { at: Date.now(), value });
  return value;
}

/** True when the organisation holds a live grant for the studio agent. */
export async function hasGrant(blueprintId: string, orgId: string): Promise<boolean> {
  const [g] = await db
    .select({ id: studioAgentGrants.id })
    .from(studioAgentGrants)
    .where(
      and(
        eq(studioAgentGrants.blueprintId, blueprintId),
        eq(studioAgentGrants.orgId, orgId),
        isNull(studioAgentGrants.revokedAt),
      ),
    )
    .limit(1);
  return Boolean(g);
}

/** Published studio agents granted to an organisation. */
export async function grantedStudioAgents(
  orgId: string,
): Promise<{ blueprintId: string; type: `studio:${string}`; manifest: StudioManifest }[]> {
  const rows = await db
    .select({ blueprintId: agentBlueprints.id, type: agentBlueprints.typeSlug })
    .from(studioAgentGrants)
    .innerJoin(agentBlueprints, eq(agentBlueprints.id, studioAgentGrants.blueprintId))
    .where(and(eq(studioAgentGrants.orgId, orgId), isNull(studioAgentGrants.revokedAt)))
    .orderBy(desc(studioAgentGrants.grantedAt));
  const out: { blueprintId: string; type: `studio:${string}`; manifest: StudioManifest }[] = [];
  for (const r of rows) {
    if (!r.type) continue;
    const p = await publishedStudioAgent(r.type);
    if (p)
      out.push({
        blueprintId: r.blueprintId,
        type: r.type as `studio:${string}`,
        manifest: p.manifest,
      });
  }
  return out;
}

/**
 * Studio test runs: a draft's definition, registered for one test run in one
 * organisation only (never resolvable elsewhere), removed when the test ends.
 */
export const studioTestDefinitions = new Map<string, { orgId: string; def: AgentDefinition }>();

/**
 * The definition a run executes under. Stock types: the stock agent. Studio
 * types: a definition registered for a studio test run, else the published
 * version — only in an organisation granted it.
 */
export async function runDefinition(
  orgId: string,
  agentType: AgentType,
  /** The studio version a run started on: it keeps running that version. */
  pinnedVersion?: number | null,
): Promise<{
  def: AgentDefinition;
  blueprintId: string | null;
  blueprintVersion: number | null;
} | null> {
  if (!isStudioType(agentType)) {
    const def = getAgent(agentType);
    return def ? { def, blueprintId: null, blueprintVersion: null } : null;
  }
  const testDef = studioTestDefinitions.get(agentType);
  if (testDef)
    return testDef.orgId === orgId
      ? { def: testDef.def, blueprintId: null, blueprintVersion: null }
      : null;
  const p = await publishedStudioAgent(agentType);
  if (!p || !(await hasGrant(p.blueprintId, orgId))) return null;
  const manifest =
    pinnedVersion != null && pinnedVersion !== p.manifest.version
      ? await studioVersion(p.blueprintId, pinnedVersion)
      : p.manifest;
  if (!manifest) return null;
  return {
    def: definitionFromManifest(manifest),
    blueprintId: p.blueprintId,
    blueprintVersion: manifest.version,
  };
}

/** One published version's manifest (immutable). */
export async function studioVersion(
  blueprintId: string,
  version: number,
): Promise<StudioManifest | null> {
  const [v] = await db
    .select({ manifest: studioAgentVersions.manifest })
    .from(studioAgentVersions)
    .where(
      and(
        eq(studioAgentVersions.blueprintId, blueprintId),
        eq(studioAgentVersions.version, version),
      ),
    )
    .limit(1);
  return v ? (v.manifest as unknown as StudioManifest) : null;
}

/* --------------------------------------------------------------- lifecycle */

type LifecycleRow = Pick<
  AgentBlueprintRow,
  "status" | "version" | "lastTest" | "approvedAt" | "typeSlug"
>;

/** Why this version cannot be approved, or null: only a tested version whose tests all passed. */
export function approveProblem(bp: LifecycleRow): string | null {
  if (bp.status !== "tested") return "Only a tested version can be approved.";
  if (!bp.lastTest?.passed || bp.lastTest.version !== bp.version)
    return "This version's tests have not all passed.";
  return null;
}

/** Why this version cannot be published, or null: only an approved, tested version. */
export function publishProblem(bp: LifecycleRow): string | null {
  if (bp.status !== "approved" || !bp.approvedAt || !bp.typeSlug)
    return "Only an approved version can be published.";
  if (!bp.lastTest?.passed || bp.lastTest.version !== bp.version)
    return "This version's tests have not all passed.";
  return null;
}

/** True when the person is an active owner of the organisation (any of theirs, not just the first). */
export async function isWorkspaceOwner(userId: string, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.userId, userId),
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.status, "active"),
        eq(orgMembers.isOwner, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/* -------------------------------------------------------------- API keys */

const KEY_PREFIX = "atsk_";

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** A new key: the full value (shown once) and what is stored. */
export function newKey(): { key: string; prefix: string; hash: string } {
  const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { key, prefix: key.slice(0, KEY_PREFIX.length + 6), hash: hashKey(key) };
}

export type ResolvedKey = {
  keyId: string;
  orgId: string;
  principalUserId: string;
  blueprint: AgentBlueprintRow & { typeSlug: string };
};

/**
 * The live key, its published studio agent and workspace, or null. Refused
 * when the agent is unpublished or archived, the workspace changed since the
 * key was issued, or the workspace no longer holds a grant. Records last use.
 */
export async function resolveKey(key: string): Promise<ResolvedKey | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length > 100) return null;
  const [row] = await db
    .select({ key: agentBlueprintKeys, bp: agentBlueprints })
    .from(agentBlueprintKeys)
    .innerJoin(agentBlueprints, eq(agentBlueprints.id, agentBlueprintKeys.blueprintId))
    .where(and(eq(agentBlueprintKeys.keyHash, hashKey(key)), isNull(agentBlueprintKeys.revokedAt)))
    .limit(1);
  if (
    !row ||
    row.bp.status === "archived" ||
    row.bp.publishedVersion == null ||
    !row.bp.typeSlug ||
    row.bp.workspaceOrgId !== row.key.orgId ||
    !(await hasGrant(row.bp.id, row.key.orgId))
  )
    return null;
  await db
    .update(agentBlueprintKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentBlueprintKeys.id, row.key.id));
  return {
    keyId: row.key.id,
    orgId: row.key.orgId,
    principalUserId: row.key.principalUserId,
    blueprint: row.bp as AgentBlueprintRow & { typeSlug: string },
  };
}
