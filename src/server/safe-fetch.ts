import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * The only way server code may fetch an external URL. Candidate CVs, profile
 * texts and integration configs are attacker-controlled, so every server-side
 * fetch of a user-supplied URL must go through here:
 *   - http/https only
 *   - the hostname is resolved first and every resolved address is checked
 *     against private / loopback / link-local / shared ranges (SSRF + cloud
 *     metadata protection), and the connection dials the vetted address —
 *     a DNS rebind between the check and the connect cannot smuggle the
 *     socket to a private address (2026-11 audit N-2)
 *   - redirects are not followed automatically; each hop must be re-validated
 *   - a hard timeout and a response-size cap bound the fetch
 *   - methods are restricted to an allow-list (GET default; POST/PUT/PATCH/
 *     DELETE for API integrations)
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 512_000;

function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map((n) => Number(n));
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (some VPC paths)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(address)) {
    const low = address.toLowerCase();
    if (low === "::" || low === "::1") return true; // unspecified, loopback
    if (low.startsWith("fe80")) return true; // link-local
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique-local
    if (low.startsWith("ff")) return true; // multicast
    // IPv4-mapped (::ffff:10.0.0.1 etc.) — check the embedded v4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return false;
  }
  return true; // not an IP we understand — block
}

/**
 * Every address the host resolves to, all vetted (one private address refuses
 * the host). Returned in resolver order so the caller can fall back to the
 * next address when one is unreachable — hosts often publish a dead record.
 */
async function assertPublicHost(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error(`Blocked address: ${hostname}`);
    return [hostname];
  }
  const looked = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!looked.length) throw new Error(`Could not resolve ${hostname}`);
  for (const { address } of looked) {
    if (isBlockedAddress(address)) throw new Error(`Blocked address for ${hostname}`);
  }
  return [...new Set(looked.map((l) => l.address))].slice(0, MAX_ADDRESSES);
}

/** At most this many vetted addresses are tried per request. */
const MAX_ADDRESSES = 4;
/** Per-address connect timeout, so one dead address cannot eat the whole budget. */
const CONNECT_TIMEOUT_MS = 4_000;

/**
 * Failures that happen before the request is sent (no byte reached the server),
 * so trying the next vetted address can never replay a request.
 */
const CONNECT_FAILURES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ETIMEDOUT",
]);

export function isConnectFailure(e: unknown): boolean {
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" && CONNECT_FAILURES.has(cause.code);
}

export type SafeFetchResponse = Response & { __resolvedIp?: string };

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * One dispatcher per vetted address: its lookup ignores the hostname and
 * returns the address that was checked, so the TLS handshake and Host header
 * still use the real hostname (certificate validation stays correct) while
 * the socket can only connect to the address assertPublicHost vetted. Agents
 * are cached per address — the pin is the address itself, so reuse is safe,
 * and a later rebind simply vetts into a different (or refused) address.
 */
const pinnedAgents = new Map<string, Agent>();
const MAX_PINNED_AGENTS = 32;

function pinnedAgentFor(ip: string): Agent {
  let agent = pinnedAgents.get(ip);
  if (!agent) {
    agent = new Agent({
      connect: {
        timeout: CONNECT_TIMEOUT_MS,
        lookup: (_hostname, _options, callback) => {
          callback(null, [{ address: ip, family: net.isIP(ip) as 4 | 6 }]);
        },
      },
    });
    if (pinnedAgents.size >= MAX_PINNED_AGENTS) {
      const oldest = pinnedAgents.keys().next().value;
      if (oldest !== undefined) {
        const evicted = pinnedAgents.get(oldest);
        pinnedAgents.delete(oldest);
        void evicted?.close().catch(() => {});
      }
    }
    pinnedAgents.set(ip, agent);
  }
  return agent;
}

export async function safeFetch(
  rawUrl: string,
  opts?: {
    timeoutMs?: number;
    maxBytes?: number;
    /** Defaults to GET. Redirects are never followed, so POSTs are never replayed. */
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<SafeFetchResponse> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Malformed URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http/https URLs can be fetched.");
  }
  if (url.username || url.password) throw new Error("Credentials in URLs are not allowed.");
  const method = (opts?.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new Error(`Method not allowed: ${method}`);

  const addresses = await assertPublicHost(url.hostname);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Dial the resolved, vetted IP for this request through a dispatcher whose
    // lookup only ever returns that address: a rebind between the check and
    // the connection cannot smuggle us to a private address. The URL keeps its
    // hostname, so the Host header and TLS certificate validation are correct.
    // The dispatcher is honoured on Node (the production runtime); Bun's fetch
    // ignores it, so under `bun test`/Bun dev the pre-connect vetting below is
    // the only guard — production dials the vetted address regardless of DNS.
    // Each vetted address in turn: the next is tried only when the connection
    // itself failed (nothing was sent), within the one overall timeout.
    let lastError: unknown;
    for (const resolvedIp of addresses) {
      try {
        const res = (await undiciFetch(url, {
          method,
          headers: opts?.headers ?? {},
          ...(opts?.body !== undefined ? { body: opts.body } : {}),
          redirect: "manual",
          signal: controller.signal,
          dispatcher: pinnedAgentFor(resolvedIp),
        } as Parameters<typeof undiciFetch>[1])) as unknown as SafeFetchResponse;
        res.__resolvedIp = resolvedIp;
        return res;
      } catch (e) {
        lastError = e;
        if (controller.signal.aborted || !isConnectFailure(e)) throw e;
      }
    }
    throw lastError;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Follow up to `hops` redirects, re-validating every location; then read the
 * body with a hard size cap. Returns text plus the final content-type.
 */
export async function safeFetchText(
  rawUrl: string,
  opts?: {
    timeoutMs?: number;
    maxBytes?: number;
    hops?: number;
    /** Forwarded to safeFetch (e.g. an Authorization header for hosted documents). */
    headers?: Record<string, string>;
  },
): Promise<{ text: string; contentType: string; finalUrl: string }> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  let current = rawUrl;
  for (let hop = 0; hop <= (opts?.hops ?? 2); hop++) {
    const res = await safeFetch(current, opts);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Redirect without a location.");
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Upstream returned ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader)
      return { text: "", contentType: res.headers.get("content-type") ?? "", finalUrl: current };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel();
        throw new Error(`Response exceeded ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(merged),
      contentType: res.headers.get("content-type") ?? "",
      finalUrl: current,
    };
  }
  throw new Error("Too many redirects.");
}
