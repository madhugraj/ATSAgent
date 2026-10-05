/**
 * Scheduled board sync — the polling half of job-board application ingestion.
 * Walks every enabled board connection (and orgs with a live LinkedIn
 * connection), pulls applications where the contract allows it, retries stuck
 * webhook events and purges old ones. Called by the platform scheduler with
 * the cron secret; never public.
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

  const { pollAllBoards } = await import("@/server/boards/poll.server");
  try {
    const summary = await pollAllBoards(opts.max !== undefined ? { max: opts.max } : {});
    return Response.json(summary);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Board sync failed." },
      { status: 500 },
    );
  }
}

export const Route = createFileRoute("/api/public/board-sync")({
  server: { handlers: { POST: ({ request }) => run(request) } },
});
