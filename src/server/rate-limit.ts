/**
 * Request rate limiting for public routes and server-function RPCs
 * (src/server.ts; docs/guardrails.md P2-2).
 *
 * 60 requests per minute per caller per path. Two stores:
 *   - memory   (default): a sliding window in this process. Fine for one
 *              instance; with N instances an attacker gets N× the limit.
 *   - postgres (RATE_LIMIT_STORE=postgres, production): a sliding-window
 *              counter shared by every instance through the database
 *              (`rate_limit_hits`, an UNLOGGED table — migration 0066). Two
 *              fixed one-minute windows are weighted to approximate a sliding
 *              one. One round trip per limited request.
 * A database error never blocks traffic: the request falls back to the
 * in-memory window (fail open to the per-instance limit, logged).
 */
export const RATE_LIMIT = 60;
export const RATE_WINDOW_MS = 60_000;
const RATE_MAP_PRUNE_THRESHOLD = 5_000;
/** One request in this many also deletes windows older than five minutes. */
const CLEANUP_ONE_IN = 200;

const rateBuckets = new Map<string, number[]>();

/** Per-instance sliding window (the fallback, and the store for one instance). */
export function allowInMemory(key: string, now = Date.now()): boolean {
  const recent = (rateBuckets.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    rateBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  if (rateBuckets.size > RATE_MAP_PRUNE_THRESHOLD) {
    for (const [k, stamps] of rateBuckets) {
      if (stamps.every((t) => now - t >= RATE_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
  return true;
}

/**
 * Pure: the sliding-window estimate from two fixed windows. `elapsed` is how
 * far into the current window we are (0–1); the previous window counts for
 * the part of it still inside the last minute.
 */
export function slidingCount(previous: number, current: number, elapsed: number): number {
  return previous * (1 - Math.min(1, Math.max(0, elapsed))) + current;
}

async function allowShared(key: string, now: number): Promise<boolean> {
  const { sql } = await import("./db");
  const windowStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  // ISO strings: this client takes no Date parameters.
  const current = new Date(windowStart).toISOString();
  const previous = new Date(windowStart - RATE_WINDOW_MS).toISOString();
  const rows = (await sql`
    with up as (
      insert into rate_limit_hits (key, window_start, hits)
      values (${key}, ${current}::timestamptz, 1)
      on conflict (key, window_start) do update set hits = rate_limit_hits.hits + 1
      returning hits
    )
    select (select hits from up)::int as cur,
           coalesce((select hits from rate_limit_hits
                     where key = ${key} and window_start = ${previous}::timestamptz), 0)::int as prev`) as unknown as {
    cur: number;
    prev: number;
  }[];
  if (Math.random() * CLEANUP_ONE_IN < 1) {
    void sql`delete from rate_limit_hits where window_start < now() - interval '5 minutes'`.catch(
      () => {},
    );
  }
  const r = rows[0];
  if (!r) return true;
  // The increment already counted this request; it is allowed while the
  // estimate including it stays within the limit.
  return slidingCount(r.prev, r.cur, (now - windowStart) / RATE_WINDOW_MS) <= RATE_LIMIT;
}

let warned = false;

/** Is this request within the caller's limit? */
export async function allowRequest(key: string, now = Date.now()): Promise<boolean> {
  if (process.env["RATE_LIMIT_STORE"] !== "postgres") return allowInMemory(key, now);
  try {
    return await allowShared(key.slice(0, 300), now);
  } catch (e) {
    if (!warned) {
      warned = true;
      console.error("[rate-limit] shared store unavailable; using the per-instance limit", e);
    }
    return allowInMemory(key, now);
  }
}
