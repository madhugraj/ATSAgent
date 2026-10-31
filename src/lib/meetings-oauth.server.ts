import { and, eq } from "drizzle-orm";

import { env } from "../server/env";
import { verifyOAuthState } from "./oauth-state";
import { readSecrets, writeSecrets } from "./integrations.server";
import { db } from "../server/db";
import { sourceIntegrations } from "@db/schema";

/**
 * Delegated OAuth configuration for the three meeting providers. The product
 * owner registers ONE app per vendor; HR users connect their own work account
 * with a single click (no Entra portals, no secrets, no PowerShell).
 *
 * Tokens are stored org-scoped in integration_credentials.secrets and meetings
 * are created as the connected user (delegated authority).
 */

export type MeetingOAuthProvider = "microsoft" | "google" | "zoom";

type OAuthTokenResponse = {
  id_token?: string;
  refresh_token?: string;
  access_token?: string;
  expires_in?: string | number;
  scope?: string;
};

type ProviderOAuth = {
  authorize: string;
  scope: string;
  envId: string | undefined;
  envSecret: string | undefined;
  extraAuthorize?: Record<string, string>;
  /**
   * Added when the organisation has the silent panel agent on
   * (docs/silent-panel-agent-plan.md): switch a meeting's transcription on and
   * read the transcript back. Not asked otherwise — Teams' needs admin consent.
   */
  transcriptScope: string;
};

const OAUTH: Record<MeetingOAuthProvider, ProviderOAuth> = {
  microsoft: {
    authorize: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    // delegated OnlineMeetings.ReadWrite + Calendars.ReadWrite — no access policy needed
    scope:
      "offline_access openid profile email https://graph.microsoft.com/OnlineMeetings.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite",
    transcriptScope: "https://graph.microsoft.com/OnlineMeetingTranscript.Read.All",
    envId: env.MICROSOFT_OAUTH_CLIENT_ID,
    envSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "openid email https://www.googleapis.com/auth/calendar",
    transcriptScope:
      "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/meetings.space.settings",
    envId: env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID ?? env.GOOGLE_OAUTH_CLIENT_ID,
    envSecret: env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET ?? env.GOOGLE_OAUTH_CLIENT_SECRET,
    extraAuthorize: { access_type: "offline", prompt: "consent" },
  },
  zoom: {
    authorize: "https://zoom.us/oauth/authorize",
    scope: "meeting:write meeting:read user:read:user",
    // Zoom grants the scopes configured on the Zoom app (cloud recordings included there).
    transcriptScope: "",
    envId: env.ZOOM_OAUTH_CLIENT_ID,
    envSecret: env.ZOOM_OAUTH_CLIENT_SECRET,
  },
};

export function oauthConfigured(provider: MeetingOAuthProvider): boolean {
  const cfg = OAUTH[provider];
  return Boolean(cfg?.envId && cfg?.envSecret);
}

export function oauthCredentials(provider: MeetingOAuthProvider) {
  const cfg = OAUTH[provider];
  if (!cfg?.envId || !cfg?.envSecret)
    throw new Error(
      "This meeting provider's connect flow is not set up on this platform yet — ask your ATSIQ administrator.",
    );
  return { clientId: cfg.envId, clientSecret: cfg.envSecret };
}

/** Where the provider sends the user back after consent. */
export function callbackPath(provider: MeetingOAuthProvider): string {
  return `/api/public/integrations/${provider}/callback`;
}

export function callbackUrl(provider: MeetingOAuthProvider, origin: string): string {
  return `${origin.replace(/\/$/, "")}${callbackPath(provider)}`;
}

export function buildAuthorizeUrl(
  provider: MeetingOAuthProvider,
  state: string,
  origin: string,
  opts: { transcripts?: boolean } = {},
): string {
  const { clientId } = oauthCredentials(provider);
  const cfg = OAUTH[provider];
  const scope = [cfg.scope, opts.transcripts ? cfg.transcriptScope : ""].filter(Boolean).join(" ");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callbackUrl(provider, origin),
    state,
    scope,
    ...cfg.extraAuthorize,
  });
  return `${cfg.authorize}?${params.toString()}`;
}

function decodeIdTokenClaims(idToken: string | undefined): Record<string, unknown> {
  if (!idToken) return {};
  try {
    const payload = idToken.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Exchange an authorization code for tokens, normalised into the secrets shape
 * stored in integration_credentials (jsonb). The shapes deliberately match what
 * meetings.server.ts token functions consume per provider.
 */
export async function exchangeCode(
  provider: MeetingOAuthProvider,
  code: string,
  origin: string,
): Promise<Record<string, string>> {
  const { clientId, clientSecret } = oauthCredentials(provider);
  const redirectUri = callbackUrl(provider, origin);

  if (provider === "microsoft") {
    const res = await fetch("https://login.microsoftonline.com/organizations/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`Microsoft token exchange failed (${res.status}).`);
    const body = (await res.json()) as OAuthTokenResponse;
    const claims = decodeIdTokenClaims(body.id_token);
    return {
      refresh_token: body.refresh_token ?? "",
      access_token: body.access_token ?? "",
      expires_at: String(Math.floor(Date.now() / 1000) + Number(body.expires_in ?? 3600)),
      tenant_id: String(claims["tid"] ?? ""),
      connected_email: String(claims["preferred_username"] ?? claims["email"] ?? ""),
      scope: body.scope ?? "",
    };
  }

  if (provider === "google") {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`Google token exchange failed (${res.status}).`);
    const body = (await res.json()) as OAuthTokenResponse;
    const claims = decodeIdTokenClaims(body.id_token);
    return {
      refresh_token: body.refresh_token ?? "",
      access_token: body.access_token ?? "",
      expires_at: String(Math.floor(Date.now() / 1000) + Number(body.expires_in ?? 3600)),
      connected_email: String(claims["email"] ?? ""),
      scope: body.scope ?? "",
    };
  }

  // Zoom
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=authorization_code&code=${encodeURIComponent(code)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
    },
  );
  if (!res.ok) throw new Error(`Zoom token exchange failed (${res.status}).`);
  const body = (await res.json()) as OAuthTokenResponse;
  let connectedEmail = "";
  try {
    const me = (await (
      await fetch("https://api.zoom.us/v2/users/me", {
        headers: { Authorization: `Bearer ${body.access_token}` },
      })
    ).json()) as Record<string, unknown>;
    connectedEmail = String(me["email"] ?? "");
  } catch {
    /* non-fatal */
  }
  return {
    access_token: body.access_token ?? "",
    refresh_token: body.refresh_token ?? "",
    expires_at: String(Math.floor(Date.now() / 1000) + Number(body.expires_in ?? 3600)),
    connected_email: connectedEmail,
  };
}

/* --------------------------------------------- organisation-only connect */

/**
 * Free/personal mailbox providers. A connected meeting account sends candidate
 * invites on the organisation's behalf, so a personal mailbox must never
 * become it — refuse these regardless of who is connecting.
 */
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "rediffmail.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "zoho.com",
  "yandex.com",
]);

function domainOf(address: string | null | undefined): string | null {
  const value = (address ?? "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  return at > 0 ? value.slice(at + 1) : null;
}

/**
 * Provider account addresses arrive in provider dialects. Microsoft hands over
 * guest UPNs like "user_gmail.com#EXT#@tenant.onmicrosoft.com" for personal
 * accounts invited into a tenant — rebuild the real address, or such an
 * account would pass the domain check under the tenant's fallback domain.
 */
export function normaliseAccountEmail(raw: string): string {
  const value = (raw ?? "").trim().toLowerCase();
  const guest = value.match(/^(.+)_([^#]+)#ext#@/);
  return guest ? `${guest[1]}@${guest[2]}` : value;
}

/** Lower-cased domain of an email address, or null when it has none. */
export function emailDomainOf(address: string | null | undefined): string | null {
  return domainOf(address);
}

/* ---------------------------------------------------------------- callback */

const PROVIDER_ROW: Record<MeetingOAuthProvider, "teams" | "google_meet" | "zoom"> = {
  microsoft: "teams",
  google: "google_meet",
  zoom: "zoom",
};

/**
 * Shared tail for the provider connect callbacks: verify the signed state,
 * exchange the code, store tokens org-scoped on the meeting integration row and
 * return the redirect the browser should follow. Public by necessity (the
 * provider is the caller); nothing from the query string is trusted.
 */
export async function finishProviderConnect(
  request: Request,
  oauthProvider: MeetingOAuthProvider,
): Promise<Response> {
  const url = new URL(request.url);
  const state = verifyOAuthState(url.searchParams.get("state"), oauthProvider);
  if (!state) return new Response("Invalid or expired connect request.", { status: 400 });

  const back = (params: Record<string, string>): Response => {
    const target = new URL("/integrations", state.origin);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { Location: target.toString() } });
  };

  const error = url.searchParams.get("error");
  if (error)
    return back({
      meetings: "error",
      provider: oauthProvider,
      detail: url.searchParams.get("error_description") ?? error,
    });

  const code = url.searchParams.get("code");
  if (!code)
    return back({
      meetings: "error",
      provider: oauthProvider,
      detail: "No authorisation code returned.",
    });

  try {
    const secretsPatch = await exchangeCode(oauthProvider, code, state.origin);

    // The meeting account is organisation infrastructure — invites to
    // candidates go out from it — so it must belong to the same organisation
    // as the member who started the connect: never a personal mailbox, never
    // another company's work account. The expected domain rides inside the
    // signed state, so a tampered or replayed state cannot widen it.
    const accountDomain = domainOf(
      normaliseAccountEmail(String(secretsPatch["connected_email"] ?? "")),
    );
    if (!accountDomain)
      return back({
        meetings: "error",
        provider: oauthProvider,
        detail: "Could not tell which account you signed in with — please try the connect again.",
      });
    if (PERSONAL_EMAIL_DOMAINS.has(accountDomain))
      return back({
        meetings: "error",
        provider: oauthProvider,
        detail:
          "That is a personal mailbox. Connect your organisation's own scheduling account (for example interviews@yourcompany.com) so candidate invites stay organisation-specific.",
      });
    const expectedDomain = domainOf(state.emailDomain);
    if (expectedDomain && accountDomain !== expectedDomain)
      return back({
        meetings: "error",
        provider: oauthProvider,
        detail: `Meeting invites must come from your organisation's own account — one ending in @${expectedDomain}. Sign in again with that mailbox.`,
      });

    const rowProvider = PROVIDER_ROW[oauthProvider];
    const [row] = await db
      .select({ id: sourceIntegrations.id, config: sourceIntegrations.config })
      .from(sourceIntegrations)
      .where(
        and(
          eq(sourceIntegrations.orgId, state.orgId),
          eq(sourceIntegrations.provider, rowProvider),
        ),
      )
      .limit(1);
    if (!row)
      return back({
        meetings: "error",
        provider: oauthProvider,
        detail: "Meeting provider row not found for this organisation.",
      });

    await writeSecrets(row.id, secretsPatch);
    const existingConfig = (row.config ?? {}) as Record<string, unknown>;
    await db
      .update(sourceIntegrations)
      .set({
        hasCredentials: true,
        enabled: true,
        config: {
          ...existingConfig,
          connected_email: secretsPatch["connected_email"] ?? null,
          connected_at: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(sourceIntegrations.id, row.id));

    return back({ meetings: "connected", provider: oauthProvider });
  } catch (e) {
    return back({
      meetings: "error",
      provider: oauthProvider,
      detail: e instanceof Error ? e.message : "Connect failed.",
    });
  }
}
