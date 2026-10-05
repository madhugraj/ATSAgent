/**
 * Drives the agent runtime: reclaims expired leases, claims queued runs and
 * advances each one (docs/agentic-plan.md §3.2). Called by the platform
 * scheduler with the cron secret every minute; never public.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticateCronRequest } from "@/server/cron-auth";

const Body = z.object({
  max: z.number().min(1).max(50).optional(),
});

async function run(request: Request) {
  const denied = await authenticateCronRequest(request);
  if (denied) return denied;

  let opts: z.infer<typeof Body> = {};
  try {
    const raw = await request.text();
    if (raw) opts = Body.parse(JSON.parse(raw));
  } catch {
    /* no body is fine — defaults apply */
  }

  const { runAgentTick } = await import("@/server/agents/runtime.server");

  try {
    const counts = await runAgentTick({ max: opts.max ?? 10 });
    return Response.json(counts);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/agent-tick")({
  server: { handlers: { POST: ({ request }) => run(request) } },
});
