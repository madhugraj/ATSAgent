/**
 * Hand posting through the ATSIQ browser companion.
 *
 * On a job portal with no integration (Internshala, Apna, …) the person posts
 * in their own browser, signed in to their own account; ATSIQ never logs in.
 * The companion asks here which roles the Distribution agent planned for that
 * portal (with the text for the portal's form), and records a posting once
 * the person has submitted it — only with a link on the portal's own site.
 * Authenticated with the organisation's capture key (same as /capture);
 * rate-limited with every /api/public route; CORS limited to our origins.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Payload = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("queue"),
    token: z.string().min(20).max(200),
    channel: z.string().min(2).max(40),
  }),
  z.object({
    action: z.literal("posted"),
    token: z.string().min(20).max(200),
    channel: z.string().min(2).max(40),
    requisitionId: z.string().uuid(),
    listingUrl: z.string().url().max(500),
  }),
]);

function allowedOrigins(): string[] {
  const origins = [process.env["PUBLIC_SITE_URL"] ?? "https://atsiq.yavar.ai"];
  for (const id of (process.env["CAPTURE_EXTENSION_IDS"] ?? "").split(",")) {
    const clean = id.trim();
    if (clean) origins.push(`chrome-extension://${clean}`);
  }
  return origins.map((o) => o.replace(/\/$/, ""));
}

function corsFor(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const headers: Record<string, string> = {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin",
  };
  if (origin && allowedOrigins().includes(origin.replace(/\/$/, ""))) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

async function handle(request: Request) {
  const cors = corsFor(request);
  let body: z.infer<typeof Payload>;
  try {
    body = Payload.parse(await request.json());
  } catch {
    return Response.json(
      { status: "error", detail: "Invalid request." },
      { status: 400, headers: cors },
    );
  }
  const { orgForCaptureToken } = await import("@/lib/capture.server");
  const org = await orgForCaptureToken(body.token);
  // Deliberately generic: no signal which part failed.
  if (!org)
    return Response.json(
      { status: "error", detail: "Not paired." },
      { status: 401, headers: cors },
    );
  const dist = await import("@/server/distribution/distribution.server");
  try {
    if (body.action === "queue") {
      return Response.json(
        { status: "ok", ...(await dist.handPostingQueue(org.id, body.channel)) },
        { headers: cors },
      );
    }
    await dist.markPosted(
      org.id,
      { memberEmail: "ATSIQ Capture (paired browser)", userId: null },
      body.requisitionId,
      body.channel,
      body.listingUrl,
      "browser_extension",
    );
    return Response.json({ status: "ok" }, { headers: cors });
  } catch (e) {
    return Response.json(
      { status: "error", detail: e instanceof Error ? e.message.slice(0, 200) : "Failed." },
      { status: 422, headers: cors },
    );
  }
}

export const Route = createFileRoute("/api/public/distribution")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      OPTIONS: ({ request }) => new Response(null, { status: 204, headers: corsFor(request) }),
    },
  },
});
