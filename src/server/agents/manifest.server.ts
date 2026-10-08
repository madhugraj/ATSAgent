/**
 * Agent definition snapshots (docs/agentic-plan.md §6). A manifest's canonical
 * form — identity, accountability, scope, gates, instructions, the exact tool
 * contracts (names, descriptions, risk, input schemas, skills) and the shared
 * harness rules — is hashed; each distinct hash is stored once in
 * agent_definitions and every run records the one it executed under.
 */
import { createHash } from "node:crypto";

import { INJECTION_RULES, toolParameters } from "@/lib/ai-gateway.server";
import { db } from "../db";
import { agentDefinitions } from "@db/schema";
import { HITL_TOOLS } from "./hitl";
import { getTool, skillsOf, type AgentDefinition } from "./registry";

/** Shared operating rules prepended to every agent (part of each hash). */
export const RUNTIME_RULES = [
  "Operating rules:",
  "- You act on behalf of the person who started this run and can only use the tools provided.",
  "- Never claim an action happened unless a tool result confirms it.",
  "- Approvals of requisitions, JDs and offers, offer release, rejecting a candidate and the hiring decision belong to people: use request_approval, never work around it.",
  "- If an action is declined, do not retry it unchanged; adapt or hand off.",
  "- When the goal is complete, reply with a short summary and no tool calls.",
].join("\n");

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The full, auditable contract of an agent at this version. */
export function canonicalManifest(def: AgentDefinition): Record<string, unknown> {
  return {
    type: def.type,
    name: def.name,
    version: def.version,
    owner: def.owner,
    responsibility: def.responsibility,
    mustNever: def.mustNever,
    scope: def.scope,
    gates: def.gates,
    riskTier: def.riskTier,
    evals: def.evals,
    feature: def.feature,
    maxSteps: def.maxSteps ?? 20,
    system: def.system,
    skills: skillsOf(def),
    tools: def.tools.map((name) => {
      const t = getTool(name);
      return t
        ? {
            name,
            description: t.description,
            risk: t.risk,
            skills: t.skills ?? [],
            untrustedOutput: Boolean(t.untrustedOutput),
            preApprovable: Boolean(t.templateOf),
            ...(t.approverRole ? { approverRole: t.approverRole } : {}),
            input: toolParameters(t.input),
          }
        : { name, missing: true };
    }),
    harness: {
      injectionRules: INJECTION_RULES,
      runtimeRules: RUNTIME_RULES,
      humanTools: Object.entries(HITL_TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        input: toolParameters(t.input),
      })),
    },
  };
}

export function manifestHash(def: AgentDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(canonicalManifest(def))))
    .digest("hex");
}

const known = new Map<string, string>();

/** Store this manifest version once; return its id, version and hash. */
export async function ensureDefinition(
  def: AgentDefinition,
): Promise<{ id: string; version: string; hash: string }> {
  const hash = manifestHash(def);
  const cached = known.get(`${def.type}:${hash}`);
  if (cached) return { id: cached, version: def.version, hash };
  await db
    .insert(agentDefinitions)
    .values({
      agentType: def.type,
      version: def.version,
      hash,
      manifest: canonicalManifest(def),
    })
    .onConflictDoNothing({ target: [agentDefinitions.agentType, agentDefinitions.hash] });
  const { and, eq } = await import("drizzle-orm");
  const [row] = await db
    .select({ id: agentDefinitions.id })
    .from(agentDefinitions)
    .where(and(eq(agentDefinitions.agentType, def.type), eq(agentDefinitions.hash, hash)))
    .limit(1);
  known.set(`${def.type}:${hash}`, row!.id);
  return { id: row!.id, version: def.version, hash };
}
