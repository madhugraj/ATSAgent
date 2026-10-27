/**
 * The number the voice worker dials for a candidate, from the free text the
 * candidate (or a job board) gave. v1 dials Indian mobiles only, in the
 * 10-digit national form the PBX dial plan expects; anything else is refused
 * and the candidate gets the e-mailed assessment instead. Phone numbers never
 * go to a log or to the client — only their last 4 digits are shown.
 */

export type DialNumber = { dial: string; last4: string };

/** An Indian mobile: 10 digits starting 6–9. */
const MOBILE = /^[6-9]\d{9}$/;

function fromDigits(raw: string): string | null {
  const plus = raw.trim().startsWith("+");
  const d = raw.replace(/\D/g, "");
  if (plus) return d.length === 12 && d.startsWith("91") ? d.slice(2) : null;
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith("0")) return d.slice(1);
  if (d.length === 12 && d.startsWith("91")) return d.slice(2);
  if (d.length === 13 && d.startsWith("091")) return d.slice(3);
  return null;
}

/**
 * The dialable number in `phone`, or null when there is none we may call.
 * Several numbers ("98400 12345 / 044 2345 6789") → the first mobile.
 */
export function dialNumber(phone: string | null | undefined): DialNumber | null {
  for (const part of (phone ?? "").split(/[,/;|]|\bor\b/i)) {
    const n = fromDigits(part);
    if (n && MOBILE.test(n)) return { dial: n, last4: n.slice(-4) };
  }
  return null;
}
