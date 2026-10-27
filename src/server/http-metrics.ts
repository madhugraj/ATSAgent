/**
 * HTTP request metrics for src/server.ts — kept in process memory and exposed
 * as OpenMetrics on `/metrics` (token-protected), plus per-minute SLI counts
 * that src/server/slo.server.ts persists for the SLO panel and burn alerts.
 *
 * Cardinality rules (README → Observability): metric labels come from a short,
 * fixed set only —
 *   route_group  server_fn | page | api_public | api_auth | api | metrics | static
 *   method       GET | HEAD | POST | PUT | PATCH | DELETE | OPTIONS | OTHER
 *   status_class 1xx | 2xx | 3xx | 4xx | 5xx
 * Never a raw path, id, token, org, user, server-function id or model name.
 * The per-request log line may carry the normalised route template (ids
 * replaced by `:id`) because logs are not aggregated by label.
 */
import { LATENCY_THRESHOLD_MS } from "./slo";

export const ROUTE_GROUPS = [
  "server_fn",
  "page",
  "api_public",
  "api_auth",
  "api",
  "metrics",
  "static",
] as const;
export type RouteGroup = (typeof ROUTE_GROUPS)[number];

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Histogram upper bounds in seconds (fixed; +Inf is implied). */
export const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;

/** Route groups whose requests count toward the request SLIs. */
export const SLI_GROUPS: readonly RouteGroup[] = ["server_fn", "page", "api_public", "api_auth"];

export function routeGroup(path: string): RouteGroup {
  if (path === "/_serverFn" || path.startsWith("/_serverFn/")) return "server_fn";
  if (path === "/metrics") return "metrics";
  if (path === "/api/public" || path.startsWith("/api/public/")) return "api_public";
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return "api_auth";
  if (path === "/api" || path.startsWith("/api/")) return "api";
  if (
    path.startsWith("/assets/") ||
    path.startsWith("/_build/") ||
    /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|txt|xml|json|webmanifest)$/i.test(
      path,
    )
  )
    return "static";
  return "page";
}

export function methodLabel(method: string): string {
  const m = method.toUpperCase();
  return METHODS.has(m) ? m : "OTHER";
}

export function statusClass(status: number): string {
  const c = Math.floor(status / 100);
  return c >= 1 && c <= 5 ? `${c}xx` : "5xx";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a path segment looks like an id or token rather than a route word. */
function isIdLike(seg: string): boolean {
  if (UUID.test(seg)) return true;
  if (/^\d+$/.test(seg)) return true;
  if (seg.length >= 16) return true;
  return /\d/.test(seg) && seg.length >= 8;
}

/**
 * The route template for the request log: ids, tokens and slugs collapse to
 * `:id`, server functions to `/_serverFn/:fn`. Bounded length.
 */
export function routeTemplate(path: string): string {
  if (routeGroup(path) === "server_fn") return "/_serverFn/:fn";
  const segs = path.split("/").filter(Boolean).slice(0, 6);
  const out = segs.map((s) => (isIdLike(s) ? ":id" : s.slice(0, 40)));
  // Public board/feed paths carry org slugs and tokens after the first two words.
  if (out[0] === "api" && out[1] === "public") for (let i = 3; i < out.length; i++) out[i] = ":id";
  return `/${out.join("/")}`.slice(0, 120);
}

/** The server-function id (a build-time hash naming the function), for the log line only. */
export function serverFnId(path: string): string | undefined {
  if (!path.startsWith("/_serverFn/")) return undefined;
  const id = path.slice("/_serverFn/".length).split("/")[0] ?? "";
  return /^[A-Za-z0-9_\-=.]{1,128}$/.test(id) ? id : "invalid";
}

/* ----------------------------------------------------------- registry */

type Hist = { buckets: number[]; count: number; sum: number };

const requests = new Map<string, number>();
const durations = new Map<RouteGroup, Hist>();
let inFlight = 0;
const startedAt = Date.now();

export type SliMinute = {
  /** Start of the minute, epoch ms. */
  minute: number;
  routeGroup: RouteGroup;
  requests: number;
  errors: number;
  slow: number;
  /** Counts per DURATION_BUCKETS bound, plus one for +Inf (non-cumulative). */
  latency: number[];
};

const sliMinutes = new Map<string, SliMinute>();
/** Keep at most this many minutes in memory if the database is unreachable. */
const MAX_SLI_MINUTES_KEPT = 120;

export function requestStarted(): void {
  inFlight++;
}

export function recordRequest(input: {
  group: RouteGroup;
  method: string;
  status: number;
  durationMs: number;
  at?: number;
}): void {
  inFlight = Math.max(0, inFlight - 1);
  const key = `${input.group}|${methodLabel(input.method)}|${statusClass(input.status)}`;
  requests.set(key, (requests.get(key) ?? 0) + 1);

  const seconds = input.durationMs / 1000;
  let h = durations.get(input.group);
  if (!h) {
    h = { buckets: DURATION_BUCKETS.map(() => 0), count: 0, sum: 0 };
    durations.set(input.group, h);
  }
  const idx = DURATION_BUCKETS.findIndex((b) => seconds <= b);
  for (let i = idx === -1 ? DURATION_BUCKETS.length : idx; i < DURATION_BUCKETS.length; i++)
    h.buckets[i]!++;
  h.count++;
  h.sum += seconds;

  if (!SLI_GROUPS.includes(input.group) || input.method === "OPTIONS") return;
  const minute = Math.floor((input.at ?? Date.now()) / 60_000) * 60_000;
  const mk = `${minute}|${input.group}`;
  let m = sliMinutes.get(mk);
  if (!m) {
    m = {
      minute,
      routeGroup: input.group,
      requests: 0,
      errors: 0,
      slow: 0,
      latency: [...DURATION_BUCKETS.map(() => 0), 0],
    };
    sliMinutes.set(mk, m);
  }
  m.requests++;
  if (input.status >= 500) m.errors++;
  if (input.durationMs > LATENCY_THRESHOLD_MS) m.slow++;
  m.latency[idx === -1 ? DURATION_BUCKETS.length : idx]!++;
}

/**
 * Take the SLI minutes that have closed (before `now`'s minute) out of memory
 * for persisting. `putBack` returns them if the write failed.
 */
export function drainClosedSliMinutes(now = Date.now()): SliMinute[] {
  const current = Math.floor(now / 60_000) * 60_000;
  const out: SliMinute[] = [];
  for (const [k, m] of sliMinutes)
    if (m.minute < current) {
      out.push(m);
      sliMinutes.delete(k);
    }
  return out;
}

export function putBackSliMinutes(rows: SliMinute[]): void {
  for (const m of rows) {
    const k = `${m.minute}|${m.routeGroup}`;
    const cur = sliMinutes.get(k);
    if (!cur) sliMinutes.set(k, m);
    else {
      cur.requests += m.requests;
      cur.errors += m.errors;
      cur.slow += m.slow;
      cur.latency = cur.latency.map((v, i) => v + (m.latency[i] ?? 0));
    }
  }
  if (sliMinutes.size > MAX_SLI_MINUTES_KEPT * SLI_GROUPS.length) {
    const oldest = [...sliMinutes.entries()].sort((a, b) => a[1].minute - b[1].minute);
    for (const [k] of oldest.slice(0, sliMinutes.size - MAX_SLI_MINUTES_KEPT * SLI_GROUPS.length))
      sliMinutes.delete(k);
  }
}

/** For tests only. */
export function resetHttpMetrics(): void {
  requests.clear();
  durations.clear();
  sliMinutes.clear();
  inFlight = 0;
}

/* ----------------------------------------------------------- exposition */

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** OpenMetrics text exposition of the process's request metrics. */
export function renderOpenMetrics(): string {
  const lines: string[] = [];
  lines.push("# TYPE atsiq_http_requests counter");
  lines.push(
    "# HELP atsiq_http_requests HTTP requests handled, by route group, method and status class.",
  );
  for (const [key, v] of [...requests.entries()].sort()) {
    const [g, m, s] = key.split("|");
    lines.push(
      `atsiq_http_requests_total{route_group="${esc(g!)}",method="${esc(m!)}",status_class="${esc(s!)}"} ${v}`,
    );
  }
  lines.push("# TYPE atsiq_http_request_duration_seconds histogram");
  lines.push("# UNIT atsiq_http_request_duration_seconds seconds");
  lines.push("# HELP atsiq_http_request_duration_seconds HTTP request duration, by route group.");
  for (const g of ROUTE_GROUPS) {
    const h = durations.get(g);
    if (!h) continue;
    DURATION_BUCKETS.forEach((b, i) =>
      lines.push(
        `atsiq_http_request_duration_seconds_bucket{route_group="${g}",le="${b}"} ${h.buckets[i]}`,
      ),
    );
    lines.push(
      `atsiq_http_request_duration_seconds_bucket{route_group="${g}",le="+Inf"} ${h.count}`,
    );
    lines.push(`atsiq_http_request_duration_seconds_count{route_group="${g}"} ${h.count}`);
    lines.push(`atsiq_http_request_duration_seconds_sum{route_group="${g}"} ${h.sum.toFixed(6)}`);
  }
  lines.push("# TYPE atsiq_http_requests_in_flight gauge");
  lines.push("# HELP atsiq_http_requests_in_flight HTTP requests being handled now.");
  lines.push(`atsiq_http_requests_in_flight ${inFlight}`);
  lines.push("# TYPE atsiq_process_start_time_seconds gauge");
  lines.push("# UNIT atsiq_process_start_time_seconds seconds");
  lines.push(`atsiq_process_start_time_seconds ${Math.floor(startedAt / 1000)}`);
  lines.push("# EOF");
  return `${lines.join("\n")}\n`;
}

export const OPENMETRICS_CONTENT_TYPE =
  "application/openmetrics-text; version=1.0.0; charset=utf-8";
