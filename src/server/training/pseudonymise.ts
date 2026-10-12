/**
 * Pseudonymise training records before they leave the database
 * (scripts/training-export.ts). Known people — the organisation's candidates
 * and members — become stable tokens (the same person is the same token across
 * the corpus, so relationships survive); any other email address or phone
 * number is masked. Free text is best effort: a name written differently from
 * the record (a nickname, a misspelling) is not caught.
 */
import { createHash } from "node:crypto";

export function buildPseudonymiser(
  orgId: string,
  people: { name?: string | null; email?: string | null; phone?: string | null; kind: string }[],
): (v: unknown) => unknown {
  const token = (kind: string, v: string) =>
    `${kind}-${createHash("sha256").update(`${orgId}:${v.toLowerCase()}`).digest("hex").slice(0, 8)}`;
  const pairs: [RegExp, string][] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const p of people) {
    if (p.email)
      pairs.push([new RegExp(esc(p.email), "gi"), `${token(p.kind, p.email)}@example.invalid`]);
    if (p.name && p.name.trim().length >= 3) {
      const t = token(p.kind, p.name.trim());
      pairs.push([new RegExp(`\\b${esc(p.name.trim())}\\b`, "gi"), t]);
      // Each part of a multi-word name (≥ 4 letters), e.g. a first name used alone.
      for (const part of p.name.trim().split(/\s+/))
        if (part.length >= 4) pairs.push([new RegExp(`\\b${esc(part)}\\b`, "gi"), t]);
    }
    if (p.phone) {
      const digits = p.phone.replace(/\D/g, "");
      if (digits.length >= 7)
        pairs.push([new RegExp(digits.split("").join("[\\s-]?"), "g"), "[phone]"]);
    }
  }
  // Longest first, so a full name is replaced before its parts.
  pairs.sort((a, b) => b[0].source.length - a[0].source.length);
  const genericEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const genericPhone = /(?<!\d)(?:\+?\d[\s-]?){10,13}(?!\d)/g;
  return (v: unknown): unknown => {
    let s = JSON.stringify(v);
    for (const [re, to] of pairs) s = s.replace(re, to);
    s = s
      .replace(genericEmail, (m) => (m.endsWith("@example.invalid") ? m : "[email]"))
      .replace(genericPhone, "[phone]");
    return JSON.parse(s);
  };
}
