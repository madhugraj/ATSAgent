/**
 * Drains the screening-kit preparation queue (backfill + build + retry).
 * Called by the platform scheduler with the cron secret; never public.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticateCronRequest } from "@/server/cron-auth";

const Body = z.object({
  max: z.number().min(1).max(100).optional(),
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

  const { runScreeningPrep } = await import("@/lib/screening-prep.server");

  try {
    const counts = await runScreeningPrep({ max: opts.max ?? 25 });
    return Response.json(counts);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/screening-prep")({
  server: { handlers: { POST: ({ request }) => run(request) } },
});
