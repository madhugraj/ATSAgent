import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../server/env";

/**
 * Shared OAuth handshake state for all provider connect flows (LinkedIn,
 * Microsoft, Google, Zoom). The signed state is the only identity carrier: the
 * app's auth is Bearer-per-RPC, so a full-page browser navigation to a provider
 * (and its callback) carries nothing else. HMAC-signed + 30-minute window.
 */

export type OAuthState = {
  orgId: string;
  userId: string;
  provider: "linkedin" | "microsoft" | "google" | "zoom";
  origin: string;
  ts: number;
  /**
   * Email domain of the member who started the connect, captured server-side at
   * start time so the callback can pin the provider account to the
   * organisation. Optional: states signed before this field existed simply
   * skip the domain pinning (the personal-mailbox block still applies).
   */
  emailDomain?: string;
};

function stateKey(): string {
  const key = env.OAUTH_STATE_SECRET ?? env.LINKEDIN_STATE_SECRET;
  // Fail closed: an empty HMAC key would make connect-state forgeable, letting
  // an attacker bind their provider tokens into any org.
  if (!key || key.length < 32) {
    throw new Error(
      "OAuth connect is not configured: set OAUTH_STATE_SECRET (min 32 chars) in the server environment.",
    );
  }
  return key;
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

export function signOAuthState(payload: OAuthState): string {
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac("sha256", stateKey()).update(body).digest("hex");
  return `${body}.${mac}`;
}

/** Verifies the HMAC, the 30-minute window and (when given) the provider binding. */
export function verifyOAuthState(
  state: string | null,
  expectedProvider?: string,
): OAuthState | null {
  if (!state || !state.includes(".")) return null;
  const [body, mac] = state.split(".") as [string, string];
  let expected: string;
  try {
    expected = createHmac("sha256", stateKey()).update(body).digest("hex");
  } catch {
    // Unconfigured/weak secret — fail closed, accept nothing.
    return null;
  }
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
    if (!parsed.orgId || !parsed.userId) return null;
    if (expectedProvider && parsed.provider !== expectedProvider) return null;
    if (Date.now() - parsed.ts > 30 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The Integrations page URL is a redirect target for provider callbacks, so the
 * origin the client claims at connect time must be allowlisted — otherwise a
 * crafted state could 302 our users anywhere.
 */
export function assertAllowedOrigin(origin: string): string {
  const allowed = new Set<string>([
    env.PUBLIC_SITE_URL.replace(/\/$/, ""),
    "http://localhost:8080",
    "http://localhost:8081",
  ]);
  const cleaned = origin.replace(/\/$/, "");
  // Local dev servers run on arbitrary ports; Vite compiles this out of builds.
  if (import.meta.env?.DEV && /^http:\/\/localhost:\d+$/.test(cleaned)) return cleaned;
  if (!allowed.has(cleaned)) throw new Error("Unrecognised application origin.");
  return cleaned;
}
