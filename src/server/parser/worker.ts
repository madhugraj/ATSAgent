/**
 * Sandboxed document parser (docs/guardrails.md P2-1).
 *
 * Runs as its own Cloud Run service from the same image
 * (`node .output/parser-worker/index.mjs`). The sandbox comes from how it is
 * deployed (infra/network/parser-sandbox.sh):
 *   - Direct VPC egress into a network with a deny-all egress firewall and no
 *     NAT — a hijacked parser has nowhere to send anything;
 *   - IAM invoker only for the app's service account (no public access);
 *   - its own service account with no roles, no secrets, no database;
 *   - one request per instance, a hard per-request time limit, small memory.
 * Here: one endpoint, size and time limits, an optional shared token, and the
 * process exits after a timeout so a stuck parse cannot linger.
 *
 *   POST /parse   body: the file bytes; header x-file-name → { text }
 *   GET  /healthz → ok
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { extractTextLocal } from "@/lib/cv-text.server";

// pdf.js in Node runs a "fake worker" it normally loads from a file beside it;
// this bundle has no such file, so the worker module is bundled in and
// registered where pdf.js looks first.
// @ts-expect-error — the worker module ships without type declarations.
const pdfWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfWorker;

const PORT = Number(process.env["PORT"] ?? 8080);
const MAX_BYTES = 15_000_000;
const PARSE_LIMIT_MS = Number(process.env["PARSE_LIMIT_MS"] ?? 30_000);
const TOKEN = process.env["PARSER_TOKEN"] ?? "";
/** True when running as a deployed Cloud Run service (not local dev). */
const DEPLOYED = Boolean(process.env["K_SERVICE"]);

// A deployed parser without its token would admit any caller that reaches it,
// with only IAM in front — refuse to serve instead (2026-11 audit N-7).
function tokenOk(given: string | undefined): boolean {
  if (!TOKEN) {
    if (DEPLOYED) {
      console.error("[parser] PARSER_TOKEN is not set in a deployed service; refusing requests");
      return false;
    }
    return true;
  }
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true });
  if (req.method !== "POST" || req.url !== "/parse") return send(404, { error: "not found" });
  if (!tokenOk(req.headers["x-parser-token"] as string | undefined))
    return send(401, { error: "unauthorised" });

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BYTES) return send(413, { error: "too large" });
    chunks.push(c as Buffer);
  }
  const filename = decodeURIComponent(String(req.headers["x-file-name"] ?? "document"));
  const bytes = new Uint8Array(Buffer.concat(chunks));

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      extractTextLocal(filename, bytes),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), PARSE_LIMIT_MS);
      }),
    ]);
    send(200, { text });
  } catch (e) {
    const timeout = e instanceof Error && e.message === "timeout";
    // The reason only — never document content.
    console.error("parse failed:", e instanceof Error ? e.message : String(e));
    send(timeout ? 504 : 422, { error: timeout ? "parse timed out" : "could not parse" });
    // A parse that hung may still be spinning: drop the whole instance.
    if (timeout) setTimeout(() => process.exit(1), 100);
  } finally {
    clearTimeout(timer);
  }
});

server.listen(PORT, () => console.log(`parser worker listening on ${PORT}`));
