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
    const archive = await drainArchiveImports({ limit: Math.min(opts.max ?? 10, 25) });
    const claims = await drainClaimsExtraction({ limit: opts.max ?? 20 });
    const { drainProfileMatches } = await import("@/server/candidates/profile-match.server");
    const matching = await drainProfileMatches({ limit: 2 });
    return Response.json({ archive, claims, matching });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/cv-processing")({
  server: { handlers: { POST: ({ request }) => run(request) } },
});
