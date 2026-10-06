import { and, asc, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { sourceIntegrations } from "@db/schema";
import { requireOrg } from "./auth.middleware";

export type MeetingProviderRow = {
  id: string;
  provider: "zoom" | "google_meet" | "teams";
  label: string;
  enabled: boolean;
  ready: boolean;
  last_test_status: string;
};

/** Meeting providers the HR admin has configured on the Integrations page. */
export const meetingProviders = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<MeetingProviderRow[]> => {
    const rows = await db
      .select({
        id: sourceIntegrations.id,
        provider: sourceIntegrations.provider,
        label: sourceIntegrations.label,
        enabled: sourceIntegrations.enabled,
        hasCredentials: sourceIntegrations.hasCredentials,
        lastTestStatus: sourceIntegrations.lastTestStatus,
      })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.orgId, context.orgId),
          eq(sourceIntegrations.category, "meeting"),
        ),
      )
      .orderBy(asc(sourceIntegrations.label));
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider as MeetingProviderRow["provider"],
      label: r.label,
      enabled: r.enabled,
      ready: r.enabled && r.hasCredentials,
      last_test_status: r.lastTestStatus,
    }));
  });

const CreateInput = z.object({
  provider: z.enum(["zoom", "google_meet", "teams"]),
  topic: z.string().min(1).max(200),
  startIso: z.string().min(1),
  durationMins: z.number().min(15).max(240),
  attendees: z.array(z.string().email()).max(20).default([]),
  agenda: z.string().max(2000).optional().nullable(),
});

/** Create a real meeting with the HR user's own provider credentials. */
/** Shared by the Interviews page and the Interview coordinator agent. */
export async function createMeetingLinkCore(orgId: string, data: z.infer<typeof CreateInput>) {
  const [row] = await db
    .select({
      id: sourceIntegrations.id,
      enabled: sourceIntegrations.enabled,
      hasCredentials: sourceIntegrations.hasCredentials,
      label: sourceIntegrations.label,
    })
    .from(sourceIntegrations)
    .where(and(eq(sourceIntegrations.orgId, orgId), eq(sourceIntegrations.provider, data.provider)))
    .limit(1);
  if (!row) throw new Error("That meeting provider is not set up yet.");
  if (!row.enabled || !row.hasCredentials)
    throw new Error(
      `${row.label} is not connected — add the credentials on the Integrations page first.`,
    );

  const { readSecrets } = await import("./integrations.server");
  const { createMeeting } = await import("./meetings.server");
  const secrets = await readSecrets(row.id);
  return createMeeting(data.provider, secrets, {
    topic: data.topic,
    startIso: data.startIso,
    durationMins: data.durationMins,
    attendees: data.attendees,
    agenda: data.agenda ?? null,
  });
}

export const createMeetingLink = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => CreateInput.parse(data))
  .handler(async ({ data, context }) => createMeetingLinkCore(context.orgId, data));
