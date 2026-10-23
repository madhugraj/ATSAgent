/**
 * Capture endpoint for the ATSIQ browser companion.
 *
 * The companion runs in the recruiter's own browser, on a page they are already
 * signed in to, and posts the readable text here with the organisation's
 * capture key. The key decides the tenant; no other credential is involved.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Payload = z.object({
  token: z.string().min(20).max(200),
  kind: z.enum(["cv", "jd"]),
  text: z.string().max(400000).nullish(),
  file: z
    .object({
      filename: z.string().min(1).max(300),
      content: z.string().min(1).max(8000000),
    })
    .nullish(),
  sourceUrl: z.string().max(2000).nullish(),
  publicProfileUrl: z.string().max(2000).nullish(),
  title: z.string().max(400).nullish(),
  candidateName: z.string().min(2).max(200).nullish(),
  profileOnly: z.boolean().optional().default(false),
  requisitionId: z.string().uuid().nullish(),
  /** The job portal this applicant came from (credited, with its data-use rule). */
  channel: z.string().max(40).nullish(),
});

/**
 * CORS is an allowlist, not `*`: only the product origin and the shipped
 * extension origins may call the token-authenticated capture API from a
 * browser. The extension id is pinned at build/deploy time via env.
 */
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
  } catch (e) {
    return Response.json(
      {
        status: "error",
        detail: e instanceof Error ? e.message.slice(0, 200) : "Invalid capture payload.",
      },
      { status: 400, headers: cors },
    );
  }

  try {
    const { capture } = await import("@/lib/capture.server");
    const result = await capture({
      token: body.token,
      kind: body.kind,
      text: body.text ?? null,
      file: body.file ?? null,
      sourceUrl: body.sourceUrl ?? null,
      publicProfileUrl: body.publicProfileUrl ?? null,
      title: body.title ?? null,
      candidateName: body.candidateName ?? null,
      profileOnly: body.profileOnly,
      requisitionId: body.requisitionId ?? null,
      channel: body.channel ?? null,
    });
    return Response.json(result, {
      status: result.status === "error" ? 422 : 200,
      headers: cors,
    });
  } catch (e) {
    console.error("capture failed", e);
    return Response.json(
      { status: "error", detail: "Capture failed." },
      { status: 500, headers: cors },
    );
  }
}

export const Route = createFileRoute("/api/public/capture")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      OPTIONS: ({ request }) => new Response(null, { status: 204, headers: corsFor(request) }),
    },
  },
});
