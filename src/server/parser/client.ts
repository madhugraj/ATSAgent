/**
 * App side of the sandboxed document parser (docs/guardrails.md P2-1).
 *
 * POSTs the file to PARSER_URL/parse. On Cloud Run the request carries a
 * Google-signed ID token for the parser's URL (the parser service only admits
 * this app's service account), plus PARSER_TOKEN as a second, shared check.
 * PARSER_URL is deployment configuration, never user input, so this is not a
 * safeFetch case. Any failure yields "" (no text) and is logged: parsing
 * never falls back into the app process.
 */
import { log } from "../log";

export const PARSE_TIMEOUT_MS = 45_000;

/** A Google-signed ID token for `audience`, from the metadata server (Cloud Run only). */
async function idToken(audience: string): Promise<string | null> {
  if (!process.env["K_SERVICE"]) return null; // not on Cloud Run (local / tests)
  const res = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
    { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) },
  );
  return res.ok ? (await res.text()).trim() : null;
}

export async function parseRemote(
  baseUrl: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/parse`;
  try {
    const token = await idToken(baseUrl.replace(/\/+$/, ""));
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(filename.slice(0, 300)),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(process.env["PARSER_TOKEN"] ? { "x-parser-token": process.env["PARSER_TOKEN"] } : {}),
      },
      body: new Uint8Array(bytes), // a copy backed by a plain ArrayBuffer (BodyInit)
      signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`parser answered ${res.status}`);
    const out = (await res.json()) as { text?: unknown };
    return typeof out.text === "string" ? out.text : "";
  } catch (e) {
    log.error("parser.unavailable", { error: e instanceof Error ? e.message : String(e) });
    return "";
  }
}
