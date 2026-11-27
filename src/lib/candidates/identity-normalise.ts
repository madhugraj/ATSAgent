/**
 * Pure normalisation and fuzzy-scoring helpers for candidate identity
 * (docs/candidate-identification/track-a-design.md §1.2–§1.3).
 *
 * No DB, no server-only imports — everything here runs anywhere so the rules
 * are unit-testable in isolation. The write path that uses it is
 * src/server/candidates/identity.server.ts.
 *
 * Deterministic and explainable by house rule: no AI decides identity.
 */

export const PLACEHOLDER_DOMAIN = "@no-email.atsiq.local";
const LEGACY_PLACEHOLDER_DOMAIN = "@import.local";

export const isPlaceholderEmail = (v: string | null | undefined) => {
  const raw = (v ?? "").trim().toLowerCase();
  return raw.endsWith(PLACEHOLDER_DOMAIN) || raw.endsWith(LEGACY_PLACEHOLDER_DOMAIN);
};

/**
 * Email → comparable key. Lowercase, `+tag` stripped, dots folded for
 * gmail/googlemail. Placeholder addresses are NOT returned as email keys —
 * the caller keys them under `placeholder` so they can never match a real
 * address (M0 verdict, design §1.2). Returns "" when nothing comparable.
 */
export const normEmail = (v: string | null | undefined) => {
  const raw = (v ?? "").trim().toLowerCase();
  if (!raw || isPlaceholderEmail(raw)) return "";
  const [user = "", domain = ""] = raw.split("@");
  const base = user.split("+")[0] ?? "";
  const canonicalUser = /^(gmail|googlemail)\.com$/.test(domain) ? base.replace(/\./g, "") : base;
  return canonicalUser && domain ? `${canonicalUser}@${domain}` : "";
};

export type PhoneKey = {
  /** Full E.164 parse — strong enough for automatic merge. */
  strong: string;
  /** Last-10-digits fallback — a signal for review, never auto-merge. */
  weak: string;
};

/**
 * Phone → E.164 (strong) plus the legacy last-10-digits fallback (weak).
 * A strong parse needs a country code: an explicit `+`, or one resolvable
 * from the tenant's default region. Numbers are not person-unique (a family
 * landline, an agency front desk), so even a strong phone hit is
 * tenant-switchable auto-merge evidence — but a weak-only hit never merges
 * automatically (design §1.2, M0 finding).
 */
export const normPhone = (
  v: string | null | undefined,
  defaultRegion?: string | null,
): PhoneKey => {
  const raw = (v ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  const weak = digits.length >= 10 ? digits.slice(-10) : "";
  if (!raw) return { strong: "", weak: "" };
  const e164Ok = (d: string) => d.length >= 8 && d.length <= 15;
  if (raw.startsWith("+") && e164Ok(digits)) return { strong: `+${digits}`, weak };
  const cc = regionCallingCode(defaultRegion);
  if (cc) {
    // Already carries the country code, or is a 10-digit local number
    // (optionally with a trunk-prefix 0) in the tenant's region.
    if (digits.startsWith(cc) && e164Ok(digits)) return { strong: `+${digits}`, weak };
    const local = digits.startsWith("0") ? digits.slice(1) : digits;
    if (local.length === 10) return { strong: `+${cc}${local}`, weak };
  }
  return { strong: "", weak };
};

/** Minimal calling-code map for the regions tenants actually set. */
const REGION_CALLING_CODES: Record<string, string> = {
  in: "91",
  us: "1",
  gb: "44",
  de: "49",
  fr: "33",
  ae: "971",
  sg: "65",
  au: "61",
  ca: "1",
  ph: "63",
  ng: "234",
  ke: "254",
  za: "27",
};

export type IdentityKeyType =
  | "email"
  | "phone"
  | "linkedin"
  | "github"
  | "file_hash"
  | "placeholder"
  | "external"
  | "shared_email"
  | "shared_phone"
  | "shared_linkedin"
  | "shared_github";

export type NewKeyInput = { keyType: IdentityKeyType; keyValue: string };

export type IdentityKeyInput = {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  fileHash?: string | null;
  externalProvider?: string | null;
  externalId?: string | null;
};

/** The auto-merge key types backed by the partial unique index. */
const STRONG_KEY_TYPES: IdentityKeyType[] = ["email", "phone", "linkedin", "github", "file_hash"];

export const regionCallingCode = (region?: string | null): string | null => {
  const r = (region ?? "").trim().toLowerCase();
  return REGION_CALLING_CODES[r] ?? null;
};

export const normName = (v: string | null | undefined) =>
  (v ?? "")
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|prof)\.?\b/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");

/** LinkedIn / profile URL → canonical form (protocol, www, /in/, trailing /). */
export const normProfileUrl = (v: string | null | undefined) =>
  (v ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/in\//, "/")
    .replace(/\/+$/, "");

/** Tokens of a normalised name, for set similarity. */
export const nameTokens = (v: string | null | undefined) => {
  const n = normName(v);
  return n ? n.split(" ") : [];
};

/** Jaccard similarity over token sets, 0–1. Empty vs anything is 0. */
export const tokenJaccard = (a: string[], b: string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
};

export type TimelineEntry = {
  company?: string | null;
  employer?: string | null;
  start?: string | number | null;
  title?: string | null;
};

const normEmployer = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

const normYear = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  const m = s.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
};

/** (employer, start year) pairs — the part of a career tailored CVs rarely change. */
export const timelinePairs = (history: TimelineEntry[] | null | undefined): Set<string> => {
  const out = new Set<string>();
  for (const h of history ?? []) {
    const employer = normEmployer(h.company ?? h.employer);
    const year = normYear(h.start);
    if (employer && year !== null) out.add(`${employer}@${year}`);
    else if (employer) out.add(`${employer}@`);
  }
  return out;
};

/**
 * Fuzzy identity score, 0–1: name similarity, employment-timeline overlap and
 * education evidence, with location as a tie-breaker only. Weights are fixed
 * in code — only the decision *thresholds* are tenant settings (design §1.3).
 */
export type FuzzyInput = {
  fullNameA: string;
  fullNameB: string;
  timelineA: TimelineEntry[];
  timelineB: TimelineEntry[];
  educationA: string | null;
  educationB: string | null;
  locationA: string | null;
  locationB: string | null;
};

export type FuzzyBreakdown = {
  score: number;
  signals: { signal: string; detail: string }[];
};

export const FUZZY_WEIGHTS = { name: 0.4, timeline: 0.4, education: 0.15, location: 0.05 } as const;

export function fuzzyIdentityScore(input: FuzzyInput): FuzzyBreakdown {
  const nameSim = tokenJaccard(nameTokens(input.fullNameA), nameTokens(input.fullNameB));
  const ta = timelinePairs(input.timelineA);
  const tb = timelinePairs(input.timelineB);
  let timelineSim = 0;
  if (ta.size > 0 && tb.size > 0) {
    let inter = 0;
    for (const p of ta) if (tb.has(p)) inter++;
    timelineSim = inter / Math.min(ta.size, tb.size);
  }
  const eduSim = tokenJaccard(
    (input.educationA ?? "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean),
    (input.educationB ?? "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean),
  );
  const locA = (input.locationA ?? "").trim().toLowerCase();
  const locB = (input.locationB ?? "").trim().toLowerCase();
  const locSim = locA && locB ? (locA.includes(locB) || locB.includes(locA) ? 1 : 0) : 0;

  const w = FUZZY_WEIGHTS;
  const score =
    nameSim * w.name + timelineSim * w.timeline + eduSim * w.education + locSim * w.location;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return {
    score,
    signals: [
      { signal: "name", detail: `similar ${pct(nameSim)}` },
      { signal: "timeline", detail: `employers+start years overlap ${pct(timelineSim)}` },
      { signal: "education", detail: `overlap ${pct(eduSim)}` },
      ...(locA && locB ? [{ signal: "location", detail: locSim ? "same area" : "different" }] : []),
    ],
  };
}

/**
 * Normalised identity keys for one person. Placeholder addresses key under
 * `placeholder` (they match each other by equality exactly as today's lookup
 * does, never a real address); a phone that only parses to last-10-digits
 * keys under `shared_phone` — a collision there may be two people sharing a
 * number, so it reviews instead of merging (design §1.2).
 */
export function computeIdentityKeys(
  input: IdentityKeyInput,
  defaultRegion?: string | null,
): NewKeyInput[] {
  const keys: NewKeyInput[] = [];
  const rawEmail = (input.email ?? "").trim();
  const email = normEmail(rawEmail);
  if (email) keys.push({ keyType: "email", keyValue: email });
  else if (rawEmail && isPlaceholderEmail(rawEmail))
    keys.push({ keyType: "placeholder", keyValue: rawEmail.toLowerCase() });
  const phone = normPhone(input.phone, defaultRegion);
  if (phone.strong) keys.push({ keyType: "phone", keyValue: phone.strong });
  else if (phone.weak) keys.push({ keyType: "shared_phone", keyValue: phone.weak });
  const linkedin = normProfileUrl(input.linkedinUrl);
  if (linkedin) keys.push({ keyType: "linkedin", keyValue: linkedin });
  const github = normProfileUrl(input.githubUrl);
  if (github) keys.push({ keyType: "github", keyValue: github });
  if (input.fileHash) keys.push({ keyType: "file_hash", keyValue: input.fileHash });
  if (input.externalProvider && input.externalId)
    keys.push({
      keyType: "external",
      keyValue: `${input.externalProvider}:${input.externalId}`,
    });
  return keys;
}

export const isStrongKeyType = (t: IdentityKeyType) => STRONG_KEY_TYPES.includes(t);
