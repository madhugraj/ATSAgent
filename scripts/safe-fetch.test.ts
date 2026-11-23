/**
 * safeFetch (src/server/safe-fetch.ts): private addresses stay refused, and only
 * connect-phase failures (nothing sent) move on to the host's next vetted address.
 */
import { describe, expect, test } from "bun:test";

const { isConnectFailure, safeFetch } = await import("../src/server/safe-fetch");

const failure = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

describe("safeFetch", () => {
  test("connect-phase failures fall back to the next address", () => {
    for (const code of ["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"])
      expect(isConnectFailure(failure(code))).toBe(true);
  });
  test("failures after sending never retry (no replayed requests)", () => {
    for (const code of [
      "ECONNRESET",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_ABORTED",
    ])
      expect(isConnectFailure(failure(code))).toBe(false);
    expect(isConnectFailure(new Error("Blocked address"))).toBe(false);
    expect(isConnectFailure(null)).toBe(false);
  });
  test("private, loopback and metadata addresses are refused", async () => {
    for (const u of [
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://localhost/",
    ])
      await expect(safeFetch(u, { timeoutMs: 2000 })).rejects.toThrow(/Blocked address/);
  });
});
