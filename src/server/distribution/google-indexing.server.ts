/**
 * Telling Google when a role is listed or taken down (Indexing API, the route
 * Google recommends for job pages). One platform service account owns the
 * site in Search Console, so the daily quota (200 publish requests by
 * default) is shared by every organisation: the queue is sent oldest first,
 * within GOOGLE_INDEXING_DAILY_LIMIT per Pacific day, when Google's quota
 * resets. Without the credential nothing is sent — the structured data on the
 * apply page still lists the role when Google next crawls it.
 *
 * Only the two fixed Google endpoints below are called; no URL here comes
 * from a user.
 */
import { createSign } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";

import { jobIndexNotifications } from "@db/schema";
import { db } from "../db";
import { env } from "../env";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PUBLISH_URL = "https://indexing.googleapis.com/v3/urlNotifications:publish";
const SCOPE = "https://www.googleapis.com/auth/indexing";
const MAX_ATTEMPTS = 3;
/** A notification still waiting after this long is stale: Google will have crawled by then. */
const EXPIRE_AFTER_DAYS = 3;
const PER_TICK = 20;

type ServiceAccount = { client_email: string; private_key: string };

/** The service account from the environment, or null when unset or unreadable. */
export function indexingAccount(raw = env.GOOGLE_INDEXING_CREDENTIALS): ServiceAccount | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  for (const candidate of [text, Buffer.from(text, "base64").toString("utf8")]) {
    try {
      const json = JSON.parse(candidate) as Partial<ServiceAccount>;
      if (typeof json.client_email === "string" && typeof json.private_key === "string")
        return { client_email: json.client_email, private_key: json.private_key };
    } catch {
      /* try the next form */
    }
  }
  return null;
}

export function indexingConfigured(): boolean {
  return indexingAccount() !== null;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

let cachedToken: { token: string; expires: number; email: string } | null = null;

/** Reset the cached access token (tests; a rotated credential). */
export function resetIndexingToken(): void {
  cachedToken = null;
}

async function accessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.email === account.client_email && cachedToken.expires > now + 60)
    return cachedToken.token;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(account.private_key)
    .toString("base64url");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status}).`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google sign-in returned no access token.");
  cachedToken = {
    token: body.access_token,
    expires: now + (body.expires_in ?? 3600),
    email: account.client_email,
  };
  return body.access_token;
}

/**
 * Queue a notification. A notification still waiting for the same address is
 * replaced — only the latest state of a role matters to Google.
 */
export async function queueIndexNotification(input: {
  orgId: string;
  requisitionId: string;
  url: string;
  kind: "URL_UPDATED" | "URL_DELETED";
}): Promise<void> {
  const [waiting] = await db
    .select({ id: jobIndexNotifications.id })
    .from(jobIndexNotifications)
    .where(
      and(
        eq(jobIndexNotifications.orgId, input.orgId),
        eq(jobIndexNotifications.url, input.url),
        eq(jobIndexNotifications.status, "pending"),
      ),
    )
    .limit(1);
  if (waiting) {
    await db
      .update(jobIndexNotifications)
      .set({ kind: input.kind, createdAt: new Date() })
      .where(eq(jobIndexNotifications.id, waiting.id));
    return;
  }
  await db.insert(jobIndexNotifications).values(input);
}

/** Start of the current day in Google's quota timezone (US Pacific). */
const PACIFIC_DAY = sql`(date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles')`;

export async function sentToday(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobIndexNotifications)
    .where(
      and(
        eq(jobIndexNotifications.status, "sent"),
        sql`${jobIndexNotifications.sentAt} >= ${PACIFIC_DAY}`,
      ),
    );
  return row?.n ?? 0;
}

export type IndexingRun = {
  configured: boolean;
  sent: number;
  failed: number;
  expired: number;
  /** Stopped early: the daily quota is used, or Google said to slow down. */
  stopped: "quota" | "rate_limited" | null;
};

/** Send waiting notifications within the daily quota. Platform-wide; run by the scheduler. */
export async function processIndexQueue(): Promise<IndexingRun> {
  const run: IndexingRun = { configured: false, sent: 0, failed: 0, expired: 0, stopped: null };
  const expired = await db
    .update(jobIndexNotifications)
    .set({ status: "expired" })
    .where(
      and(
        eq(jobIndexNotifications.status, "pending"),
        lt(jobIndexNotifications.createdAt, new Date(Date.now() - EXPIRE_AFTER_DAYS * 86_400_000)),
      ),
    )
    .returning({ id: jobIndexNotifications.id });
  run.expired = expired.length;

  const account = indexingAccount();
  if (!account) return run;
  run.configured = true;

  const room = env.GOOGLE_INDEXING_DAILY_LIMIT - (await sentToday());
  if (room <= 0) {
    run.stopped = "quota";
    return run;
  }
  const batch = await db
    .select()
    .from(jobIndexNotifications)
    .where(eq(jobIndexNotifications.status, "pending"))
    .orderBy(jobIndexNotifications.createdAt)
    .limit(Math.min(room, PER_TICK));
  if (!batch.length) return run;

  let token: string;
  try {
    token = await accessToken(account);
  } catch (e) {
    // Sign-in failures are the platform's to fix; nothing is charged to a notification.
    console.error("[google-indexing] sign-in failed", e instanceof Error ? e.message : e);
    run.stopped = "rate_limited";
    return run;
  }

  for (const n of batch) {
    let res: Response;
    try {
      res = await fetch(PUBLISH_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ url: n.url, type: n.kind }),
      });
    } catch (e) {
      await fail(n.id, n.attempts, e instanceof Error ? e.message : "Network error");
      run.failed++;
      continue;
    }
    if (res.ok) {
      await db
        .update(jobIndexNotifications)
        .set({ status: "sent", sentAt: new Date(), attempts: n.attempts + 1, lastError: null })
        .where(eq(jobIndexNotifications.id, n.id));
      run.sent++;
    } else if (res.status === 429) {
      run.stopped = "rate_limited";
      break;
    } else {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      await fail(n.id, n.attempts, `Google answered ${res.status}${detail ? `: ${detail}` : ""}`);
      run.failed++;
    }
  }
  return run;
}

async function fail(id: string, attempts: number, message: string): Promise<void> {
  const next = attempts + 1;
  await db
    .update(jobIndexNotifications)
    .set({
      attempts: next,
      lastError: message.slice(0, 500),
      status: next >= MAX_ATTEMPTS ? "failed" : "pending",
    })
    .where(eq(jobIndexNotifications.id, id));
}
