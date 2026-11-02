/**
 * Organisation-facing settings for the browser companion: the capture key it
 * signs with, and a short history of what it has brought in.
 */
import { desc, eq } from "drizzle-orm";
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";

import { db } from "../server/db";
import { env } from "../server/env";
import { captureEvents, organizations } from "@db/schema";
import { requireOrg, requireRole } from "./auth.middleware";

export type CaptureEvent = {
  id: string;
  kind: string;
  title: string | null;
  status: string;
  detail: string | null;
  sourceUrl: string | null;
  createdAt: string;
};

export type CaptureSetup = {
  token: string | null;
  endpoint: string;
  events: CaptureEvent[];
};

const endpointBase = createServerOnlyFn(function endpointBase(): string {
  return env.PUBLIC_SITE_URL;
});

const loadSetup = createServerOnlyFn(async function loadSetup(
  orgId: string,
): Promise<CaptureSetup> {
  const { decryptSecret } = await import("../server/crypto");
  const [org] = await db
    .select({ captureToken: organizations.captureToken })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const events = await db
    .select({
      id: captureEvents.id,
      kind: captureEvents.kind,
      title: captureEvents.title,
      status: captureEvents.status,
      detail: captureEvents.detail,
      sourceUrl: captureEvents.sourceUrl,
      createdAt: captureEvents.createdAt,
    })
    .from(captureEvents)
    .where(eq(captureEvents.orgId, orgId))
    .orderBy(desc(captureEvents.createdAt))
    .limit(20);
  return {
    token: org?.captureToken ? decryptSecret(org.captureToken) : null,
    endpoint: `${endpointBase()}/api/public/capture`,
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      status: e.status,
      detail: e.detail,
      sourceUrl: e.sourceUrl,
      createdAt: e.createdAt.toISOString(),
    })),
  };
});

export const captureSetup = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<CaptureSetup> => loadSetup(context.orgId));

export const rotateCaptureToken = createServerFn({ method: "POST" })
  .middleware([requireRole("president_cbo")])
  .handler(async ({ context }): Promise<CaptureSetup> => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const { encryptSecret } = await import("../server/crypto");
    const { createHash } = await import("node:crypto");
    await db
      .update(organizations)
      .set({
        captureToken: encryptSecret(token),
        captureTokenHash: createHash("sha256").update(token).digest("hex"),
      })
      .where(eq(organizations.id, context.orgId));
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "capture.token.rotate",
      entityType: "organization",
      entityId: context.orgId,
    });
    return loadSetup(context.orgId);
  });
