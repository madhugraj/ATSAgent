/**
 * Regenerate scripts/agents.lock.json: the version and manifest hash of every
 * built-in agent. CI (scripts/agent-governance.test.ts) fails when an agent's
 * manifest — instructions, tools, tool contracts, scope, gates, harness
 * rules — changes without a version bump, or when this lock is stale.
 *
 *   bun scripts/agents-lock.ts
 */
import { writeFileSync } from "node:fs";

process.env["DATABASE_URL"] ??= "postgres://unused@127.0.0.1:1/unused";
process.env["SESSION_SECRET"] ??= "lockfile-generation-only-0123456789abcdef";

const { registerPhase1Tools } = await import("../src/server/agents/tools");
const { registerPhase2Tools } = await import("../src/server/agents/tools-phase2");
const { registerPhase1Agents, registerPhase2Agents } =
  await import("../src/server/agents/definitions");
const { listAgents } = await import("../src/server/agents/registry");
const { manifestHash } = await import("../src/server/agents/manifest.server");

registerPhase1Tools();
registerPhase2Tools();
registerPhase1Agents();
registerPhase2Agents();

const lock = Object.fromEntries(
  listAgents()
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((a) => [a.type, { version: a.version, hash: manifestHash(a) }]),
);
writeFileSync(new URL("./agents.lock.json", import.meta.url), `${JSON.stringify(lock, null, 2)}\n`);
console.log(`agents.lock.json: ${Object.keys(lock).length} agents`);
process.exit(0);
