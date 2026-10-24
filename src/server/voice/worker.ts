/**
 * The voice worker (docs/voice-screening-agent.md): a long-running process
 * beside the web app that places phone screening calls. Every 15 seconds it
 * recovers calls a stopped worker left behind and claims due calls up to
 * VOICE_MAX_CONCURRENT; each call runs to the end on its own. On SIGTERM it
 * stops claiming and lets calls in progress finish (a call is at most 30
 * minutes; Kubernetes' grace period should cover the policy's maximum).
 *
 * Production: `node .output/voice-worker/index.mjs` (bundled by
 * scripts/build-voice-worker.mjs). Locally: `bun src/server/voice/worker.ts`.
 */
// Events this worker emits (screening_call.ended) are handled by the app's
// agent scheduler, never by agent runs started inside the voice worker.
process.env["AGENT_INLINE_KICK"] = "0";

import { env, sipConfigured } from "../env";
import { log } from "../log";
import { runScreeningCall } from "./call-session.server";
import { claimDueCalls, recoverStuckCalls } from "./dispatcher.server";
import { beat } from "./settings.server";
import { sipLine } from "./sip-line";

const POLL_MS = 15_000;

const inFlight = new Set<Promise<unknown>>();
let stopping = false;

// One heartbeat row per worker process (pod name in Kubernetes).
const WORKER_ID = process.env["HOSTNAME"] || `worker-${process.pid}`;

async function tick() {
  try {
    await beat(WORKER_ID, env.VOICE_MAX_CONCURRENT, inFlight.size);
    const recovered = await recoverStuckCalls(new Date());
    if (recovered) log.warn("screening_call.recovered", { count: recovered });
    const claimed = await claimDueCalls(env.VOICE_MAX_CONCURRENT - inFlight.size);
    for (const c of claimed) {
      const p = runScreeningCall(c.orgId, c.callId, { line: sipLine })
        .then((r) =>
          log.info("screening_call.done", {
            org_id: c.orgId,
            call_id: c.callId,
            status: r.status,
            reason: r.endReason,
          }),
        )
        .catch((e) =>
          log.error("screening_call.crashed", {
            org_id: c.orgId,
            call_id: c.callId,
            error: e as Error,
          }),
        )
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
  } catch (e) {
    log.error("voice_worker.tick_failed", { error: e as Error });
  }
}

async function main() {
  if (!sipConfigured()) {
    log.error("voice_worker.no_phone_line", {
      detail: "Set SIP_SERVER, SIP_USER and SIP_PASSWORD; the worker has nothing to do.",
    });
    process.exit(1);
  }
  log.info("voice_worker.started", { max_concurrent: env.VOICE_MAX_CONCURRENT });
  const timer = setInterval(() => {
    if (!stopping) void tick();
  }, POLL_MS);
  void tick();

  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log.info("voice_worker.stopping", { signal, calls_in_progress: inFlight.size });
    await Promise.allSettled([...inFlight]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

void main();
