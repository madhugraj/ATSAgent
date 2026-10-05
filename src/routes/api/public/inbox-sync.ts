/**
 * Scheduled careers-inbox scoring.
 *
 * Mail reaches each organisation's careers address through the signed inbound
 * webhook, which files the candidate. This run scores whatever arrived, per
 * organisation, so pipelines are ranked before anyone opens them. Called by
 * the platform scheduler with the cron secret; never public.
 */
import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/server/cron-auth";

async function run(request: Request) {
  const denied = await authenticateCronRequest(request);
  if (denied) return denied;

  try {
    const { db } = await import("../../../server/db");
    const { organizations } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const { scoreUnscored } = await import("@/lib/autoscore.server");
    const orgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.status, "active"));
    let scored = 0;
    let scoreErrors = 0;
    for (const org of orgs) {
      const run = await scoreUnscored({ orgId: org.id, limit: 25 });
      scored += run.scored;
      scoreErrors += run.errors;
    }

    return Response.json({ scored, scoreErrors });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/inbox-sync")({
  server: { handlers: { POST: ({ request }) => run(request) } },
});
