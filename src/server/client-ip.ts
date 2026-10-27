/**
 * How many reverse-proxy hops sit in front of this server (GKE L7 LB = 1).
 * Only that many right-most X-Forwarded-For entries are proxy-set; the client
 * controls everything further left, so trusting the left-most value would let
 * any caller rotate IPs past the limiter. Direct (unproxied) deployments have
 * no XFF at all and fall through to the socket-less fallback.
 */
const TRUSTED_PROXY_COUNT = Math.max(0, Number(process.env["TRUSTED_PROXY_COUNT"] ?? "1"));

/** The caller's IP as the trusted proxy saw it, or "unknown". */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    const idx = hops.length - TRUSTED_PROXY_COUNT;
    if (idx >= 0 && hops[idx]) return hops[idx]!;
  }
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
