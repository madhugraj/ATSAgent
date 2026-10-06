/**
 * Run the agent eval scenarios against a live model.
 *
 *   DATABASE_URL=postgres://...127.0.0.1... SESSION_SECRET=... \
 *   EVAL_PROVIDER=openai|anthropic|google EVAL_API_KEY=... EVAL_MODEL=... \
 *   bun scripts/agent-eval.ts
 *
 * Uses a throwaway organisation per scenario on a local database. The key is
 * a test key supplied by the person running the eval; it is never stored.
 * Exits non-zero when any scenario fails.
 */
const url = process.env.DATABASE_URL ?? "";
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to run evals against a non-local database");
}
const provider = process.env.EVAL_PROVIDER as "openai" | "anthropic" | "google" | undefined;
const apiKey = process.env.EVAL_API_KEY;
const model = process.env.EVAL_MODEL;
if (!provider || !apiKey || !model) {
  console.error("Set EVAL_PROVIDER, EVAL_API_KEY and EVAL_MODEL to run live evals.");
  process.exit(2);
}

const { setEvalModelOverride } = await import("../src/server/agents/runtime.server");
const { resetRegistry } = await import("../src/server/agents/registry");
const { runScenario } = await import("../src/server/agents/eval.server");
const { scenarios } = await import("./evals/scenarios");
const { sql } = await import("../src/server/db");

setEvalModelOverride({ provider, model, apiKey });
let failed = 0;
for (const s of scenarios()) {
  resetRegistry();
  const r = await runScenario(s);
  if (!r.passed) failed++;
  console.log(
    `${r.passed ? "PASS" : "FAIL"}  ${r.name}\n      status=${r.status} steps=${r.steps} tokens=${r.tokens} human_requests=${r.humanRequests}\n      calls: ${r.calls.join(" → ") || "none"}${r.failures.map((f) => `\n      ✗ ${f}`).join("")}`,
  );
}
await sql.end();
console.log(`\n${scenarios().length - failed}/${scenarios().length} scenarios passed`);
process.exit(failed ? 1 : 0);
