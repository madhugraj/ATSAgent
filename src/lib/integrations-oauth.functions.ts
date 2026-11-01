import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireOrg } from "./auth.middleware";
import {
  buildAuthorizeUrl,
  emailDomainOf,
  oauthConfigured,
  type MeetingOAuthProvider,
} from "./meetings-oauth.server";
import { assertAllowedOrigin, signOAuthState } from "./oauth-state";

/**
 * One-click delegated OAuth connects for the meeting providers. The start fn
 * signs the caller's identity into the state (the only identity carrier for a
 * full-page browser navigation) and returns the provider's authorize URL; the
 * public callback exchanges the code and stores tokens org-scoped.
 */

async function connectUrl(
  provider: MeetingOAuthProvider,
  origin: string,
  orgId: string,
  userId: string,
  memberEmail: string,
): Promise<{ url: string }> {
  if (!oauthConfigured(provider)) {
    throw new Error(
      "This meeting provider's connect flow is not set up on this platform yet — ask your ATSIQ administrator.",
    );
  }
  const safeOrigin = assertAllowedOrigin(origin);
  // Pins the callback to the organisation's own domain — the connected
  // meeting account must share it (organisation-specific invites).
  const expectedDomain = emailDomainOf(memberEmail);
  const state = signOAuthState({
    orgId,
    userId,
    provider,
    origin: safeOrigin,
    ts: Date.now(),
    ...(expectedDomain ? { emailDomain: expectedDomain } : {}),
  });
  // The silent panel agent reads interview transcripts: ask for that too.
  const { panelAgentPolicyOf } = await import("../server/panel/transcripts.server");
  const transcripts = (await panelAgentPolicyOf(orgId)).enabled;
  return { url: buildAuthorizeUrl(provider, state, safeOrigin, { transcripts }) };
}

export const startMicrosoftConnect = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ origin: z.string().url() }).parse(d))
  .handler(async ({ data, context }) =>
    connectUrl("microsoft", data.origin, context.orgId, context.userId, context.memberEmail),
  );

export const startGoogleMeetConnect = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ origin: z.string().url() }).parse(d))
  .handler(async ({ data, context }) =>
    connectUrl("google", data.origin, context.orgId, context.userId, context.memberEmail),
  );

export const startZoomConnect = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ origin: z.string().url() }).parse(d))
  .handler(async ({ data, context }) =>
    connectUrl("zoom", data.origin, context.orgId, context.userId, context.memberEmail),
  );
