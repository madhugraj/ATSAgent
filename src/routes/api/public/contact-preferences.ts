/**
 * A pool member's opt-out link (src/lib/pool-contact.server.ts). GET shows a
 * confirm button — mail scanners prefetch links, so a GET never changes
 * anything; POST records the opt-out. The signed token is the only key.
 * Rate-limited with every /api/public path (src/server.ts).
 */
import { createFileRoute } from "@tanstack/react-router";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.25rem;color:#1f2937;line-height:1.5}button{background:#4f46e5;color:#fff;border:0;border-radius:6px;padding:.6rem 1.1rem;font-size:1rem;cursor:pointer}</style></head><body><h1 style="font-size:1.35rem">${esc(title)}</h1>${body}</body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

const invalid = () =>
  page(
    "This link is not valid",
    "<p>The link may be incomplete. Reply to the email instead and we will update your preferences.</p>",
    400,
  );

async function show(request: Request) {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const { candidateForToken } = await import("@/lib/pool-contact.server");
  const c = await candidateForToken(token);
  if (!c) return invalid();
  if (c.optedOutAt)
    return page(
      "You are unsubscribed",
      `<p>${esc(c.orgName)} will not email you about new roles.</p>`,
    );
  return page(
    "Stop emails about new roles",
    `<p>${esc(c.orgName)} will stop matching your profile to new roles and will not email you about them. Messages about an application you are already in will still reach you.</p>
<form method="post"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Stop these emails</button></form>`,
  );
}

async function record(request: Request) {
  const form = await request.formData().catch(() => null);
  const token = String(form?.get("t") ?? "");
  const { recordOptOut } = await import("@/lib/pool-contact.server");
  const orgName = await recordOptOut(token);
  if (!orgName) return invalid();
  return page("You are unsubscribed", `<p>${esc(orgName)} will not email you about new roles.</p>`);
}

export const Route = createFileRoute("/api/public/contact-preferences")({
  server: {
    handlers: { GET: ({ request }) => show(request), POST: ({ request }) => record(request) },
  },
});
