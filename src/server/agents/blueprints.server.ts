/**
 * Agent studio (platform super admin only; docs/agent-studio.md). A blueprint
 * adapts a stock agent to another domain for use in other applications: its
 * name, responsibility, instructions and must-never list are rewritten, and
 * its tools may be dropped, renamed and re-described. Locked and always added:
 * the injection and operating rules, the human tools, the gate-verb ban, and
 * the stock tools' input contracts (so hosted runs still execute them).
 * In-app runs never use blueprints.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { INJECTION_RULES, toolParameters } from "@/lib/ai-gateway.server";
import { agentBlueprintKeys, agentBlueprints, orgMembers, type AgentType } from "@db/schema";
import { db } from "../db";
import { HITL_TOOLS } from "./hitl";
import { manifestHash, RUNTIME_RULES } from "./manifest.server";
import { getAgent, getTool, isGateToolName, type AgentDefinition } from "./registry";

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
>;

export const BLUEPRINT_LIMITS = {
  name: 80,
  description: 500,
  responsibility: 600,
  instructions: 20_000,
  mustNeverItems: 30,
  mustNeverItem: 300,
  toolDescription: 1500,
} as const;

const TOOL_NAME = /^[a-z][a-z0-9_]{2,60}$/;
const APPROVAL_PREFIX = /^(propose|request|submit)_/;

/** The locked rules every blueprint carries, ahead of its own instructions. */
export const LOCKED_RULES = `${INJECTION_RULES}\n\n${RUNTIME_RULES}`;

/** The stock agent as a blueprint's starting content. */
export function stockContent(def: AgentDefinition): BlueprintContent {
  return {
    name: def.name,
    description: "",
    responsibility: def.responsibility,
    instructions: def.system,
    mustNever: [...def.mustNever],
    tools: [...def.tools],
    toolOverrides: Object.fromEntries(
      def.tools.map((t) => [t, { name: t, description: getTool(t)?.description ?? "" }]),
    ),
    maxSteps: null,
  };
}

/** The name and description the model sees for a real tool. */
function shownTool(c: BlueprintContent, real: string): { name: string; description: string } {
  const o = c.toolOverrides[real];
  return {
    name: o?.name?.trim() || real,
    description: o?.description?.trim() || getTool(real)?.description || "",
  };
}

/** Why a blueprint is refused, or null. */
export function blueprintProblem(def: AgentDefinition, c: BlueprintContent): string | null {
  if (!c.name.trim()) return "Give the blueprint a name.";
  if (!c.responsibility.trim()) return "Write its responsibility.";
  if (!c.instructions.trim()) return "Write its instructions.";
  if (!c.mustNever.some((m) => m.trim())) return "Keep at least one must-never rule.";
  if (!c.tools.length) return "Keep at least one tool.";
  const stock = new Set(def.tools);
  const foreign = c.tools.filter((t) => !stock.has(t));
  if (foreign.length) return `Not a tool of this agent: ${foreign.join(", ")}.`;
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
  const stockSteps = def.maxSteps ?? 20;
  if (c.maxSteps != null && (c.maxSteps < 1 || c.maxSteps > stockSteps))
    return `Steps must be between 1 and ${stockSteps}.`;
  return null;
}

/** The stock agent adapted by a blueprint. Used for packages and hosted runs alike. */
export function effectiveDefinition(def: AgentDefinition, c: BlueprintContent): AgentDefinition {
  const keep = new Set(c.tools);
  const tools = def.tools.filter((t) => keep.has(t));
  return {
    ...def,
    name: c.name.trim(),
    responsibility: c.responsibility.trim(),
    system: c.instructions.trim(),
    mustNever: c.mustNever.map((m) => m.trim()).filter(Boolean),
    tools,
    toolAliases: Object.fromEntries(tools.map((t) => [t, shownTool(c, t)])),
    maxSteps: Math.min(c.maxSteps ?? def.maxSteps ?? 20, def.maxSteps ?? 20),
  };
}

/** alias → real tool name for a definition (identity for stock agents). */
export function aliasToReal(def: AgentDefinition): Map<string, string> {
  return new Map(def.tools.map((t) => [def.toolAliases?.[t]?.name ?? t, t]));
}

export const PACKAGE_FORMAT = "ats-agent-package/2";

/**
 * The portable package: everything another application needs to run the
 * adapted agent on its own data. Vendor-neutral by construction — no model,
 * engine or AI-feature fields.
 */
export function buildPackage(def: AgentDefinition, bp: AgentBlueprintRow) {
  const eff = effectiveDefinition(def, bp);
  return {
    format: PACKAGE_FORMAT,
    exportedAt: new Date().toISOString(),
    agent: {
      name: eff.name,
      description: bp.description,
      responsibility: eff.responsibility,
      riskTier: def.riskTier,
      mustNever: eff.mustNever,
      humanDecisions: def.gates,
      limits: { maxSteps: eff.maxSteps ?? 20 },
      blueprintVersion: bp.version,
      basedOn: { type: def.type, name: def.name, version: def.version, hash: bp.baseHash },
    },
    lockedRules: LOCKED_RULES,
    instructions: `${LOCKED_RULES}\n\n${eff.system}`,
    tools: eff.tools.map((real) => {
      const t = getTool(real);
      const shown = eff.toolAliases![real]!;
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

/** True when the stock agent changed since the blueprint was saved. */
export function isOutOfDate(def: AgentDefinition, bp: Pick<AgentBlueprintRow, "baseHash">) {
  return manifestHash(def) !== bp.baseHash;
}

export async function loadBlueprint(id: string): Promise<AgentBlueprintRow | null> {
  const [row] = await db.select().from(agentBlueprints).where(eq(agentBlueprints.id, id)).limit(1);
  return row ?? null;
}

/**
 * The definition a run executes under: the stock agent, or its blueprint for
 * hosted runs — only inside the blueprint's workspace organisation.
 */
export async function runDefinition(
  orgId: string,
  agentType: AgentType,
  blueprintId: string | null | undefined,
): Promise<{ def: AgentDefinition; blueprintVersion: number | null } | null> {
  const def = getAgent(agentType);
  if (!def) return null;
  if (!blueprintId) return { def, blueprintVersion: null };
  const bp = await loadBlueprint(blueprintId);
  if (!bp || bp.agentType !== agentType || bp.workspaceOrgId !== orgId) return null;
  return { def: effectiveDefinition(def, bp), blueprintVersion: bp.version };
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
  blueprint: AgentBlueprintRow;
};

/**
 * The live key, its published blueprint and workspace, or null. Refused when
 * the blueprint's workspace changed since the key was issued. Records last use.
 */
export async function resolveKey(key: string): Promise<ResolvedKey | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length > 100) return null;
  const [row] = await db
    .select({ key: agentBlueprintKeys, bp: agentBlueprints })
    .from(agentBlueprintKeys)
    .innerJoin(agentBlueprints, eq(agentBlueprints.id, agentBlueprintKeys.blueprintId))
    .where(and(eq(agentBlueprintKeys.keyHash, hashKey(key)), isNull(agentBlueprintKeys.revokedAt)))
    .limit(1);
  if (!row || row.bp.status !== "published" || row.bp.workspaceOrgId !== row.key.orgId) return null;
  await db
    .update(agentBlueprintKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentBlueprintKeys.id, row.key.id));
  return {
    keyId: row.key.id,
    orgId: row.key.orgId,
    principalUserId: row.key.principalUserId,
    blueprint: row.bp,
  };
}
