/**
 * LinkedIn returns the signed-in HR admin here after the one-time consent.
 * Public by necessity (LinkedIn is the caller); the signed `state` proves which
 * organisation started the flow, so nothing is trusted from the query string.
 */
import { createFileRoute } from "@tanstack/react-router";

import { exchangeCode, fetchMember, verifyState } from "@/lib/linkedin.server";

function back(origin: string, params: Record<string, string>): Response {
  const url = new URL("/integrations", origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

export const Route = createFileRoute("/api/public/linkedin/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const state = verifyState(url.searchParams.get("state"));
        if (!state) return new Response("Invalid or expired sign-in request.", { status: 400 });

        // Session binding (2026-11 audit): only the signed-in member who
        // started the flow may complete it. Without this, an attacker can
        // initiate a connect and have a victim's browser finish it, binding
        // the attacker's LinkedIn identity to the victim's organisation.
        const { resolveSession } = await import("../../../../server/identity");
        const session = await resolveSession(request);
        if (!session || session.userId !== state.userId)
          return back(state.origin ?? url.origin, {
            linkedin: "error",
            detail:
              "Sign in as the member who started the LinkedIn connection, then try Connect again.",
          });

        const error = url.searchParams.get("error");
        if (error)
          return back(state.origin, {
            linkedin: "error",
            detail: url.searchParams.get("error_description") ?? error,
          });

        const code = url.searchParams.get("code");
        if (!code)
          return back(state.origin, { linkedin: "error", detail: "No sign-in code returned." });

        try {
          const { encryptSecret } = await import("../../../../server/crypto");
          const token = await exchangeCode(code);
          const member = await fetchMember(token.access_token);
          const { db } = await import("../../../../server/db");
          const { orgLinkedinConnections } = await import("../../../../../drizzle/schema");
          const now = new Date();
          await db
            .insert(orgLinkedinConnections)
            .values({
              orgId: state.orgId,
              memberSub: member.sub,
              memberName: member.name,
              memberEmail: member.email,
              accessToken: encryptSecret(token.access_token),
              refreshToken: token.refresh_token ? encryptSecret(token.refresh_token) : null,
              expiresAt: new Date(Date.now() + token.expires_in * 1000),
              scope: token.scope,
              connectedBy: state.userId,
              connectedAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: orgLinkedinConnections.orgId,
              set: {
                memberSub: member.sub,
                memberName: member.name,
                memberEmail: member.email,
                accessToken: encryptSecret(token.access_token),
                refreshToken: token.refresh_token ? encryptSecret(token.refresh_token) : null,
                expiresAt: new Date(Date.now() + token.expires_in * 1000),
                scope: token.scope,
                connectedBy: state.userId,
                updatedAt: now,
              },
            });
          return back(state.origin, { linkedin: "connected" });
        } catch (e) {
          return back(state.origin, {
            linkedin: "error",
            detail: e instanceof Error ? e.message : "LinkedIn sign-in failed.",
          });
        }
      },
    },
  },
});
