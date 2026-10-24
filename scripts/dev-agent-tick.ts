/**
 * Local only: run the agent scheduler every 20 seconds, as the agent-tick cron
 * does in production (infra/DEPLOYMENT-HANDOFF.md §7) — so events raised
 * outside the web server (the voice worker's screening_call.ended, sweeps)
 * reach the agents on a dev stack.
 *
 *   bun --env-file=.env.local scripts/dev-agent-tick.ts
 */
const url = process.env.DATABASE_URL ?? "";
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to run the dev agent tick against a non-local database");
}

const { ensureAgentsRegistered } = await import("../src/server/agents/index");
const { runAgentTick } = await import("../src/server/agents/runtime.server");
ensureAgentsRegistered();

let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

console.log("dev agent tick: every 20 s (Ctrl-C to stop)");
while (!stopping) {
  try {
    const c = await runAgentTick({ max: 5 });
    const busy = Object.entries(c).filter(([, v]) => typeof v === "number" && v > 0);
    if (busy.length)
      console.log(new Date().toLocaleTimeString(), busy.map(([k, v]) => `${k} ${v}`).join(", "));
  } catch (e) {
    console.error("tick failed:", (e as Error).message);
  }
  for (let i = 0; i < 20 && !stopping; i++) await new Promise((r) => setTimeout(r, 1000));
}
process.exit(0);
