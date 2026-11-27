/**
 * Shared untrusted-data fencing primitives (client-safe: pure string logic).
 *
 * The AI gateway (ai-gateway.server.ts) re-exports these for its own prompts;
 * template prompt composition (templates.server.ts) uses them directly so a
 * local, weaker copy can never drift from the real fence semantics.
 */

/** Zero-width, soft-hyphen and bidi-control characters: invisible, and used to split keywords. */
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/**
 * Anything that could read as an opening or closing fence tag: any case,
 * spaces, attributes, `untrusted-data` / `untrusted data`, full-width angle
 * brackets, or a tag left unclosed.
 */
const FENCE_TAG =
  /[<\uFF1C\uFE64]\s*\/?\s*untrusted[\s_-]*data[^>\uFF1E\uFE65\n]{0,200}[>\uFF1E\uFE65]?/gi;

/**
 * Untrusted text with every fence look-alike removed, so it cannot close the
 * fence early. Repeats until stable: removing one tag must not join the halves
 * around it into a new one (`<untrusted<untrusted_data>_data>`).
 */
export function sanitizeUntrusted(text: string | null | undefined): string {
  let out = (text ?? "").replace(INVISIBLE_CHARS, "");
  for (let prev = ""; prev !== out;) {
    prev = out;
    out = out.replace(FENCE_TAG, "");
  }
  return out;
}

/** Wrap untrusted text in the untrusted_data fence (gateway parity, no cap here). */
export function untrustedFence(label: string, text: string | null | undefined): string {
  const safeLabel = label.replace(/[^\w .:-]/g, "").slice(0, 80);
  return `<untrusted_data label="${safeLabel}">\n${sanitizeUntrusted(text)}\n</untrusted_data>`;
}
