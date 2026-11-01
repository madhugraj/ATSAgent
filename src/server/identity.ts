import { and, eq, gt } from "drizzle-orm";

import { db } from "./db";
import { sessions, users } from "@db/schema";

/**
 * Identity layer for the cookie-session era.
 *
 * Authn resolution for every server function: the `atsiq_session` httpOnly
 * cookie → sessions table (7-day sliding window). Nothing else.
 */

export const SESSION_COOKIE = "atsiq_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// node:crypto is imported lazily: this module is (transitively) parsed by the
// client bundle for middleware introspection, and must never pull node builtins.
async function hashToken(token: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(token).digest("hex");
}

/** Create a DB-backed session; returns the raw cookie token (never stored). */
export async function createSession(
  userId: string,
  meta?: { ip?: string | null; userAgent?: string | null },
): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    userId,
    tokenHash: await hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent?.slice(0, 300) ?? null,
  });
  return token;
}

/**
 * Cookie attributes. The app may also be rendered inside preview iframes,
 * which are third-party contexts: a SameSite=Lax cookie is never sent back
 * there, so over HTTPS we issue `SameSite=None; Secure`. Plain HTTP
 * (local dev) keeps Lax because Chrome drops `None` without `Secure`.
 */
function cookieFlags(request?: Request): string {
  const proto =
    request?.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
    (request?.url.startsWith("https") ? "https" : "");
  const https = proto === "https" || process.env["PUBLIC_SITE_URL"]?.startsWith("https") === true;
  return https ? "SameSite=None; Secure" : "SameSite=Lax";
}

export function sessionCookie(token: string, request?: Request): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; ${cookieFlags(request)}; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookie(request?: Request): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; ${cookieFlags(request)}; Max-Age=0`;
}

export async function destroySession(request: Request): Promise<void> {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, await hashToken(raw)));
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** sha256 of this request's session cookie (the sessions.token_hash key), or null. */
export async function sessionTokenHash(request: Request): Promise<string | null> {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw || raw.length < 32) return null;
  return hashToken(raw);
}

/** Validate the cookie against the sessions table; returns the user identity. */
export async function resolveSession(
  request: Request,
): Promise<{ userId: string; email: string } | null> {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw || raw.length < 32) return null;
  const tokenHash = await hashToken(raw);
  const [row] = await db
    .select({ userId: sessions.userId, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (row) {
    const now = new Date();
    await db
      .update(sessions)
      .set({ lastUsedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(eq(sessions.tokenHash, tokenHash));
  }
  return row ?? null;
}
