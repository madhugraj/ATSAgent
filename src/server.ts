import "./lib/error-capture";

import { timingSafeEqual } from "node:crypto";

import { consumeLastCapturedError, isClientAbort } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { clientIp } from "./server/client-ip";
import {
  OPENMETRICS_CONTENT_TYPE,
  recordRequest,
  renderOpenMetrics,
  requestStarted,
  routeGroup,
  routeTemplate,
  serverFnId,
  statusClass,
} from "./server/http-metrics";
import { log } from "./server/log";
import { allowRequest, AUTH_RATE_LIMIT } from "./server/rate-limit";
import { env } from "./server/env";
import {
  contextFromHeaders,
  currentRequest,
  formatTraceparent,
  withRequestContext,
  type RequestContext,
} from "./server/request-context";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(
  response: Response,
  request: Request,
): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  const captured = consumeLastCapturedError();
  const trace = currentRequest();
  if (trace?.clientAborted || request.signal.aborted || isClientAbort(captured)) {
    // The browser left mid-render (navigated away): nothing failed on our side.
    if (trace) trace.clientAborted = true;
    return new Response(null, { status: 499 });
  }
  log.error("http.ssr_error", {
    error: captured instanceof Error ? captured : `h3 swallowed SSR error: ${body}`,
  });
  // Plain stderr too, so Error Reporting gets the stack trace.
  console.error(captured ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- security */

// Rate limiting: 60/min per caller per path, shared across instances when
// RATE_LIMIT_STORE=postgres (src/server/rate-limit.ts).

function isPublicApiPath(path: string): boolean {
  return path === "/api/public" || path.startsWith("/api/public/");
}

/**
 * Server-function RPCs are also public attack surface — the apply endpoint is
 * one — so they are limited per caller per function (the /_serverFn/<id> path
 * already names the function). Without this, the public apply path has no
 * throttle at all and each unauthenticated call can trigger an LLM spend.
 */
function isServerFnPath(path: string): boolean {
  return path === "/_serverFn" || path.startsWith("/_serverFn/");
}

/**
 * Unauthenticated credential endpoints (`/api/auth` mutations: sign-in,
 * registration, password reset) get a tighter budget than the general 60/min:
 * online password guessing and reset spam must not get the full allowance.
 * Reads (`session`, `me`) stay on the normal budget — they run on every page
 * load and are authenticated or harmless.
 */
function isAuthMutationPath(path: string): boolean {
  return (
    (path === "/api/auth" || path.startsWith("/api/auth/")) &&
    path !== "/api/auth/session" &&
    path !== "/api/auth/me"
  );
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Origins our own frontend posts from (plus local dev ports). */
function allowedPostOrigins(): Set<string> {
  return new Set<string>(
    [
      env.PUBLIC_SITE_URL.replace(/\/$/, ""),
      "http://localhost:3000",
      "http://localhost:8080",
      "http://localhost:8081",
      "http://localhost:9000",
    ].filter((o): o is string => Boolean(o)),
  );
}

/**
 * Cross-site request forgery guard for the state-changing browser endpoints:
 * server-function RPCs and `/api/auth` mutations. The session cookie is
 * `SameSite=None` (preview-iframe requirement), so cross-site requests carry
 * it — this closes that door for every mutating call (2026-11 audit N-5).
 * Browsers send Fetch-Metadata on every request; a client without any of
 * these headers is not a browser and is still authenticated per call anyway.
 */
function csrfGuard(request: Request, path: string): Response | null {
  if (!MUTATING_METHODS.has(request.method)) return null;
  if (!(path === "/api/auth" || path.startsWith("/api/auth/") || isServerFnPath(path))) return null;
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return null;
  if (site === "same-site" || site === "cross-site")
    return forbidden("Cross-site request refused.");
  const origin = request.headers.get("origin");
  if (!origin) return null; // not a browser — callers still authenticate per call
  if (!allowedPostOrigins().has(origin.replace(/\/$/, "")))
    return forbidden("Cross-site request refused.");
  return null;
}

function forbidden(message: string): Response {
  return new Response(message, { status: 403, headers: { "cache-control": "no-store" } });
}

/* ------------------------------------------------------------- /metrics */

/**
 * OpenMetrics scrape endpoint. Off (404) unless METRICS_TOKEN is set; the
 * scraper sends `Authorization: Bearer <METRICS_TOKEN>`. Rate-limited like
 * the other public paths. Labels are low-cardinality only (http-metrics.ts).
 */
function metricsResponse(request: Request): Response {
  const token = process.env["METRICS_TOKEN"] ?? "";
  if (token.length < 16) return new Response("Not found", { status: 404 });
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    });
  return new Response(renderOpenMetrics(), {
    status: 200,
    headers: { "content-type": OPENMETRICS_CONTENT_TYPE, "cache-control": "no-store" },
  });
}

/* ----------------------------------------------------------- correlation */

/** Return the request's trace on the response so callers can quote it. */
function withTraceHeaders(response: Response, ctx: RequestContext): Response {
  try {
    response.headers.set("traceparent", formatTraceparent(ctx));
    response.headers.set("x-request-id", ctx.traceId);
    return response;
  } catch {
    // Immutable headers (e.g. a passed-through fetch Response): copy once.
    const headers = new Headers(response.headers);
    headers.set("traceparent", formatTraceparent(ctx));
    headers.set("x-request-id", ctx.traceId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

let sliFlusherStarted = false;
function ensureSliFlusher() {
  if (sliFlusherStarted) return;
  sliFlusherStarted = true;
  void import("./server/slo.server")
    .then((m) => m.startSliFlusher())
    .catch((e: unknown) =>
      log.warn("slo.flusher_start_failed", { error: e instanceof Error ? e : String(e) }),
    );
}

async function applySecurityHeaders(response: Response, request: Request): Promise<Response> {
  // HSTS on every response: once a browser has seen it over https, plain-http
  // requests to this host are upgraded before they leave the browser.
  response.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;

  const headers = new Headers(response.headers);

  // Per-response nonce for inline scripts: stamp every <script> tag in the
  // payload, then allow only self + that nonce. Any injected inline script
  // (XSS) without the nonce is refused by the browser. `default-src 'self'`
  // bounds everything the page may load; the explicit sources re-allow what
  // the app actually uses (Google Fonts; blob: previews of uploaded files).
  const nonce = generateNonce();
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "frame-src 'self' blob:",
      "connect-src 'self'",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; "),
  );
  headers.set("X-Frame-Options", "SAMEORIGIN");

  if (!response.body)
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  return await stampNonces(response, nonce, headers);
}

function generateNonce(): string {
  return crypto
    .getRandomValues(new Uint8Array(16))
    .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
}

async function stampNonces(response: Response, nonce: string, headers: Headers): Promise<Response> {
  try {
    const html = await response.text();
    const stamped = html.replace(/<script(?![^>]*\bnonce=)([^>]*)/gi, (_m, attrs: string) => {
      // Self-closing or foreign tags are not a concern here; SSR output is ours.
      return `<script nonce="${nonce}"${attrs}`;
    });
    return new Response(stamped, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    // Transform failure must never blank a page: fall back to a nonce-less
    // policy that still bounds scripts rather than dropping script-src.
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function tooManyRequests(): Response {
  return new Response(
    JSON.stringify({ status: "error", detail: "Too many requests — slow down." }),
    {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "60" },
    },
  );
}

async function handle(request: Request, url: URL, env: unknown, ctx: unknown): Promise<Response> {
  try {
    if (url.pathname === "/metrics") return metricsResponse(request);

    const handler = await getServerEntry();
    const response = await handler.fetch(request, env, ctx);
    return await applySecurityHeaders(
      await normalizeCatastrophicSsrResponse(response, request),
      request,
    );
  } catch (error) {
    log.error("http.unhandled", { error: error instanceof Error ? error : String(error) });
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const started = performance.now();
    const trace = contextFromHeaders(request.headers);
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const group = routeGroup(url.pathname);
    ensureSliFlusher();
    requestStarted();

    return withRequestContext(trace, async () => {
      let response: Response;
      const csrf = request.method !== "OPTIONS" ? csrfGuard(request, url.pathname) : null;
      if (csrf) {
        response = csrf;
      } else if (
        request.method !== "OPTIONS" &&
        (isPublicApiPath(url.pathname) || isServerFnPath(url.pathname) || group === "metrics")
      ) {
        response = (await allowRequest(`${clientIp(request)}:${url.pathname}`))
          ? await handle(request, url, env, ctx)
          : tooManyRequests();
      } else if (
        request.method !== "OPTIONS" &&
        request.method !== "GET" &&
        isAuthMutationPath(url.pathname)
      ) {
        response = (await allowRequest(
          `${clientIp(request)}:${url.pathname}`,
          Date.now(),
          AUTH_RATE_LIMIT,
        ))
          ? await handle(request, url, env, ctx)
          : tooManyRequests();
      } else {
        response = await handle(request, url, env, ctx);
      }

      // Time to response headers; streamed bodies may still be flowing.
      const durationMs = Math.round(performance.now() - started);
      // A client that hung up gets a 500 from h3; count it as 499 (client closed),
      // not as a server failure against the availability SLO.
      const aborted = trace.clientAborted || request.signal.aborted;
      const status = aborted && response.status >= 500 ? 499 : response.status;
      recordRequest({ group, method: request.method, status, durationMs });
      if (group !== "static") {
        const fields = {
          http_method: request.method,
          http_route: routeTemplate(url.pathname),
          route_group: group,
          server_fn: serverFnId(url.pathname),
          http_status: status,
          status_class: statusClass(status),
          duration_ms: durationMs,
          // A thrown server-function error is serialised by the framework as a 500.
          fn_error:
            status >= 500 && response.headers.get("x-tss-serialized") === "true" ? true : undefined,
          client_aborted: aborted ? true : undefined,
        };
        if (status >= 500) log.error("http.request", fields);
        else if (durationMs > 10_000) log.warn("http.request", fields);
        else log.info("http.request", fields);
      }
      return withTraceHeaders(response, trace);
    });
  },
};
