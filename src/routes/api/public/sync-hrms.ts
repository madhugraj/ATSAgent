/**
 * Scheduled HRMS employee-master sync.
 *
 * Iterates every enabled HRMS connection (source_integrations, category
 * "hrms") across all organisations and re-pulls the employee master into the
 * per-connection cache. Called by the platform scheduler with the cron
 * secret; never public.
 */
import { createFileRoute } from "@tanstack/react-router";
import { and, eq } from "drizzle-orm";

import { authenticateCronRequest } from "@/server/cron-auth";

async function run(request: Request) {
  const denied = await authenticateCronRequest(request);
  if (denied) return denied;

  const { db } = await import("../../../server/db");
  const { sourceIntegrations } = await import("@db/schema");
  const { syncHrmsEmployees } = await import("@/lib/hrms.server");

  try {
    const connections = await db
      .select({ id: sourceIntegrations.id, orgId: sourceIntegrations.orgId })
      .from(sourceIntegrations)
      .where(and(eq(sourceIntegrations.category, "hrms"), eq(sourceIntegrations.enabled, true)));

    const results: Array<{
      integration_id: string;
      provider: string;
      status: string;
      fetched: number;
      upserted: number;
      pages: number;
      error?: string;
    }> = [];
    for (const conn of connections) {
      if (!conn.orgId) continue;
      const r = await syncHrmsEmployees({ orgId: conn.orgId, integrationId: conn.id });
      results.push({
        integration_id: conn.id,
        provider: r.provider,
        status: r.status,
        fetched: r.fetched,
        upserted: r.upserted,
        pages: r.pages,
        ...(r.error ? { error: r.error } : {}),
      });
    }

    return Response.json({
      connections: connections.length,
      synced: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/sync-hrms")({
  server: { handlers: { POST: ({ request }) => run(request) } },
});
