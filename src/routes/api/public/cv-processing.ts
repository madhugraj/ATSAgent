/**
 * Drains background CV work: claims extraction for new CV versions (A2) and,
 * from A3, archive-import items. Called by the platform scheduler with the cron
 * secret; never public. Rate-limited with every /api/public route (src/server.ts).
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticateCronRequest } from "@/server/cron-auth";

const Body = z.object({
  max: z.number().min(1).max(100).optional(),
});

/** Parallel AI calls per stage; override with CV_PROCESSING_CONCURRENCY. */
const CONCURRENCY = Math.min(
  Math.max(Number(process.env["CV_PROCESSING_CONCURRENCY"]) || 8, 1),
  16,
);

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

  try {
    const { drainArchiveImports } = await import("@/server/candidates/archive-import.server");
    const { drainClaimsExtraction } = await import("@/server/candidates/versions.server");
    const { drainProfileMatches } = await import("@/server/candidates/profile-match.server");
    // The three stages drain independent queues, so they run side by side; each
    // works through its batch with bounded parallel AI calls. Ranking holds off
    // for an organisation until its import and evidence queues are empty.
    const [archive, claims, matching] = await Promise.all([
      drainArchiveImports({ limit: Math.min(opts.max ?? 24, 48), concurrency: CONCURRENCY }),
      drainClaimsExtraction({ limit: opts.max ?? 24, concurrency: CONCURRENCY }),
      drainProfileMatches({ limit: 2 }),
    ]);
    return Response.json({ archive, claims, matching });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/cv-processing")({
  server: { handlers: { POST: ({ request }) => run(request) } },
});
