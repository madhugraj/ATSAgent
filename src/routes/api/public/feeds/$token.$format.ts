/**
 * An organisation's public job feed, read by job aggregators:
 * /api/public/feeds/<feed-token>/<jooble|adzuna|jora>.
 *
 * Public by necessity (the aggregator's crawler is the caller) and
 * rate-limited with every /api/public route in src/server.ts. The token only
 * names the organisation's feed — it lists roles a person put on that
 * aggregator, nothing else — and the HR head can replace it at any time.
 * An unknown token, format or paused organisation is a plain 404.
 */
import { createFileRoute } from "@tanstack/react-router";

async function handle(token: string, format: string): Promise<Response> {
  const { feedXml } = await import("@/server/distribution/distribution.server");
  const xml = await feedXml(token, format);
  if (xml === null) return new Response("Not found", { status: 404 });
  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=900",
      "x-robots-tag": "noindex",
    },
  });
}

export const Route = createFileRoute("/api/public/feeds/$token/$format")({
  server: {
    handlers: {
      GET: ({ params }) => handle(params.token, params.format),
    },
  },
});
