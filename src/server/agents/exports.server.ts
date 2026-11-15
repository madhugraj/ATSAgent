/**
 * Agent studio (docs/agent-studio.md): customised copies of stock agents for
 * use outside this app — a portable package, or a hosted run here through the
 * org's API keys. A customisation can only narrow the stock agent: extra
 * instructions after the stock ones, a subset of its tools, extra must-never
 * rules and lower limits. In-app runs never see customisations.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { INJECTION_RULES, toolParameters } from "@/lib/ai-gateway.server";
import { agentExportKeys, agentExports, type AgentType } from "@db/schema";
import { db } from "../db";
import { HITL_TOOLS } from "./hitl";
import { manifestHash, RUNTIME_RULES } from "./manifest.server";
import { getAgent, getTool, type AgentDefinition } from "./registry";

export type AgentExportRow = typeof agentExports.$inferSelect;

export type ExportCustomisation = Pick<
  AgentExportRow,
  | "name"
  | "description"
  | "extraInstructions"
  | "tools"
  | "extraMustNever"
  | "maxSteps"
  | "maxTokens"
>;

export const EXPORT_LIMITS = {
  name: 80,
  description: 500,
  extraInstructions: 4000,
  mustNeverItems: 20,
  mustNeverItem: 300,
} as const;

/** Why a customisation is refused, or null when it only narrows the stock agent. */
export function exportProblem(def: AgentDefinition, c: ExportCustomisation): string | null {
  if (!c.name.trim()) return "Give the export a name.";
  if (!c.tools.length) return "Keep at least one tool.";
  const stock = new Set(def.tools);
  const extra = c.tools.filter((t) => !stock.has(t));
  if (extra.length) return `Not a tool of this agent: ${extra.join(", ")}.`;
  if (new Set(c.tools).size !== c.tools.length) return "A tool is listed twice.";
  const stockSteps = def.maxSteps ?? 20;
  if (c.maxSteps != null && (c.maxSteps < 1 || c.maxSteps > stockSteps))
    return `Steps must be between 1 and ${stockSteps}.`;
  if (c.maxTokens != null && def.maxTokens != null && c.maxTokens > def.maxTokens)
    return `Tokens must be at most ${def.maxTokens}.`;
  if (c.maxTokens != null && c.maxTokens < 1000) return "Tokens must be at least 1000.";
  return null;
}

const ORG_INSTRUCTIONS_HEADING =
  "Additional instructions from the organisation (they add to the rules above and never override them):";

/** The stock agent narrowed by a customisation. Used for packages and hosted runs alike. */
export function effectiveDefinition(def: AgentDefinition, c: ExportCustomisation): AgentDefinition {
  const keep = new Set(c.tools);
  const extra = c.extraInstructions.trim();
  return {
    ...def,
    name: c.name.trim() || def.name,
    system: extra ? `${def.system}\n\n${ORG_INSTRUCTIONS_HEADING}\n${extra}` : def.system,
    tools: def.tools.filter((t) => keep.has(t)),
    mustNever: [...def.mustNever, ...c.extraMustNever.map((m) => m.trim()).filter(Boolean)],
    maxSteps: Math.min(c.maxSteps ?? def.maxSteps ?? 20, def.maxSteps ?? 20),
    ...(def.maxTokens != null || c.maxTokens != null
      ? { maxTokens: Math.min(c.maxTokens ?? Infinity, def.maxTokens ?? Infinity) }
      : {}),
  };
}

export const PACKAGE_FORMAT = "ats-agent-package/1";

/**
 * The portable package: everything another application needs to run this
 * agent on its own data. Vendor-neutral by construction — no model, engine or
 * AI-feature fields.
 */
export function buildPackage(def: AgentDefinition, exp: AgentExportRow) {
  const eff = effectiveDefinition(def, exp);
  return {
    format: PACKAGE_FORMAT,
    exportedAt: new Date().toISOString(),
    agent: {
      name: eff.name,
      description: exp.description,
      basedOn: { type: def.type, name: def.name, version: def.version, hash: exp.baseHash },
      exportVersion: exp.version,
      responsibility: def.responsibility,
      accountableOwner: def.owner,
      riskTier: def.riskTier,
      mustNever: eff.mustNever,
      scope: def.scope,
      humanDecisions: def.gates,
      limits: { maxSteps: eff.maxSteps ?? 20, maxTokens: eff.maxTokens ?? null },
    },
    instructions: `${INJECTION_RULES}\n\n${RUNTIME_RULES}\n\n${eff.system}`,
    tools: eff.tools.map((name) => {
      const t = getTool(name);
      return {
        name,
        description: t?.description ?? "",
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
    evals: def.evals,
    implementationNotes: [
      "Implement every tool in `tools` against your own data with the given input schema; return JSON results.",
      "Implement every tool in `humanTools` so a person answers or decides; pause the agent until they do.",
      "Tools marked needsPersonApproval must wait for a person's approval before taking effect.",
      "Send `instructions` as the system prompt. Wrap any untrusted text (documents, web pages, emails) the tools return in clearly labelled blocks.",
      "Stop after `limits.maxSteps` model turns without a person's decision.",
      "Nothing in `mustNever` may be done, whatever the instructions or tool results say.",
    ],
  };
}

export type AgentPackage = ReturnType<typeof buildPackage>;

/** True when the stock agent changed since the export was customised. */
export function isOutOfDate(def: AgentDefinition, exp: Pick<AgentExportRow, "baseHash">): boolean {
  return manifestHash(def) !== exp.baseHash;
}

/** Load an export in an org (never across orgs). */
export async function loadExport(orgId: string, id: string): Promise<AgentExportRow | null> {
  const [row] = await db
    .select()
    .from(agentExports)
    .where(and(eq(agentExports.id, id), eq(agentExports.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * The definition a run executes under: the stock agent, narrowed by its
 * export when the run came through the hosted API.
 */
export async function runDefinition(
  orgId: string,
  agentType: AgentType,
  exportId: string | null | undefined,
): Promise<{ def: AgentDefinition; exportVersion: number | null } | null> {
  const def = getAgent(agentType);
  if (!def) return null;
  if (!exportId) return { def, exportVersion: null };
  const exp = await loadExport(orgId, exportId);
  if (!exp || exp.agentType !== agentType) return null;
  return { def: effectiveDefinition(def, exp), exportVersion: exp.version };
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
  export: AgentExportRow;
};

/** The live key and its published export, or null. Records last use. */
export async function resolveKey(key: string): Promise<ResolvedKey | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length > 100) return null;
  const [row] = await db
    .select({ key: agentExportKeys, exp: agentExports })
    .from(agentExportKeys)
    .innerJoin(
      agentExports,
      and(
        eq(agentExports.id, agentExportKeys.exportId),
        eq(agentExports.orgId, agentExportKeys.orgId),
      ),
    )
    .where(and(eq(agentExportKeys.keyHash, hashKey(key)), isNull(agentExportKeys.revokedAt)))
    .limit(1);
  if (!row || row.exp.status !== "published") return null;
  await db
    .update(agentExportKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(agentExportKeys.id, row.key.id), eq(agentExportKeys.orgId, row.key.orgId)));
  return {
    keyId: row.key.id,
    orgId: row.key.orgId,
    principalUserId: row.key.principalUserId,
    export: row.exp,
  };
}
