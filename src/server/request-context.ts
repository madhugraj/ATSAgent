/**
 * Per-request correlation (W3C Trace Context).
 *
 * src/server.ts opens one context per HTTP request: it continues the caller's
 * `traceparent` when one is sent and valid, otherwise starts a new trace. Every
 * `log.*` line written on that async call chain — server functions, AI gateway,
 * agent runs started inline — carries the request's `trace_id` / `span_id`,
 * and the response returns it as `traceparent` and `x-request-id` so a support
 * ticket's request ID finds all its log lines (and, via `agent_runs.trace_id`,
 * the agent runs it started).
 *
 * Only ids live here — never paths with ids, user ids or request bodies.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  /** 32 lowercase hex chars (W3C trace-id). */
  traceId: string;
  /** 16 lowercase hex chars — this server's span for the request. */
  spanId: string;
  /** The caller's span, when a valid `traceparent` came in. */
  parentSpanId?: string;
  /** Whether the caller asked for this trace to be sampled. */
  sampled: boolean;
  /** Set when the client hung up mid-request (see src/lib/error-capture.ts). */
  clientAborted?: boolean;
};

const scope = new AsyncLocalStorage<RequestContext>();

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Parse a W3C `traceparent` header; null when absent or malformed (never throws). */
export function parseTraceparent(
  header: string | null | undefined,
): { traceId: string; parentSpanId: string; sampled: boolean } | null {
  if (!header) return null;
  const m = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, parentSpanId, flags] = m;
  // Version ff is invalid; all-zero ids are invalid by the spec.
  if (version === "ff" || traceId === ZERO_TRACE || parentSpanId === ZERO_SPAN) return null;
  return {
    traceId: traceId!,
    parentSpanId: parentSpanId!,
    sampled: (parseInt(flags!, 16) & 1) === 1,
  };
}

/** A new context for an incoming request, continuing the caller's trace if valid. */
export function contextFromHeaders(headers: Headers): RequestContext {
  const parent = parseTraceparent(headers.get("traceparent"));
  return parent
    ? {
        traceId: parent.traceId,
        spanId: randomHex(8),
        parentSpanId: parent.parentSpanId,
        sampled: parent.sampled,
      }
    : { traceId: randomHex(16), spanId: randomHex(8), sampled: false };
}

export function formatTraceparent(ctx: RequestContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return scope.run(ctx, fn);
}

export function currentRequest(): RequestContext | undefined {
  return scope.getStore();
}

/** A W3C trace-id as the uuid stored in `agent_runs.trace_id` (both are 16 bytes). */
export function traceIdToUuid(traceId: string): string {
  const h = traceId.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The current request's trace as a uuid, for runs and rows started from it. */
export function currentTraceUuid(): string | undefined {
  const ctx = scope.getStore();
  return ctx ? traceIdToUuid(ctx.traceId) : undefined;
}

/** A context for work on an agent run: the run's trace (stored as a uuid), a fresh span. */
export function runTraceContext(traceUuid: string): RequestContext {
  return {
    traceId: traceUuid.replace(/-/g, "").toLowerCase(),
    spanId: randomHex(8),
    sampled: false,
  };
}
