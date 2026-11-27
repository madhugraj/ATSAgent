/**
 * A JD's structured requirements and the pure rules that compare two of them
 * (docs/candidate-identification/track-b-design.md §3.3, §4.3). Client-safe:
 * no database, no AI — the server modules build on these.
 */
import { z } from "zod";

const loose = <T extends z.ZodTypeAny>(inner: T) => inner.nullish().catch(null);
const list = z
  .array(z.string())
  .nullish()
  .catch(null)
  .transform((v) =>
    (v ?? [])
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 40),
  );

export const SENIORITIES = [
  "unknown",
  "entry",
  "ic",
  "senior",
  "staff",
  "lead",
  "manager",
  "director",
  "executive",
] as const;
export const EMPLOYMENT_TYPES = [
  "unknown",
  "permanent",
  "fixed_term",
  "contract",
  "part_time",
  "intern",
] as const;
export const REMOTE_POLICIES = ["unknown", "onsite", "hybrid", "remote"] as const;
export const PAY_PERIODS = ["hour", "day", "month", "year"] as const;
export const PAY_BOUNDS = ["up_to", "range", "exact"] as const;

const enumOr = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z
    .string()
    .nullish()
    .catch(null)
    .transform((v): T[number] =>
      v && (values as readonly string[]).includes(v.toLowerCase())
        ? (v.toLowerCase() as T[number])
        : fallback,
    );

const num = z
  .union([z.number(), z.string()])
  .nullish()
  .catch(null)
  .transform((v) => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  });

/** What the model returns; normalised into RequirementProfile. */
export const RequirementProfileSchema = z
  .object({
    title: loose(z.string()),
    role_family: loose(z.string()),
    seniority: enumOr(SENIORITIES, "unknown"),
    sector: loose(z.string()),
    employment_type: enumOr(EMPLOYMENT_TYPES, "unknown"),
    location: loose(
      z.object({
        city: loose(z.string()),
        country: loose(z.string()),
        remote_policy: enumOr(REMOTE_POLICIES, "unknown"),
      }),
    ),
    right_to_work: loose(z.string()),
    languages: loose(z.array(z.object({ name: z.string(), level: loose(z.string()) }))),
    experience_years: loose(z.object({ min: num, max: num })),
    must_have: list,
    nice_to_have: list,
    responsibilities: list,
    hiring_client: loose(z.string()),
    job_code: loose(z.string()),
    pay: loose(
      z.object({
        stated: loose(z.boolean()),
        currency: loose(z.string()),
        period: loose(z.string()),
        bound: loose(z.string()),
        min: num,
        max: num,
        exact: num,
      }),
    ),
    suspected_prompt_injection: loose(z.boolean()),
  })
  .transform((v): RequirementProfile => normaliseProfile(v));

export type Pay =
  | { status: "unknown" }
  | {
      status: "known";
      currency: string | null;
      period: (typeof PAY_PERIODS)[number] | null;
      bound: (typeof PAY_BOUNDS)[number] | null;
      min: number | null;
      max: number | null;
      exact: number | null;
    };

export type RequirementProfile = {
  title: string;
  roleFamily: string | null;
  seniority: (typeof SENIORITIES)[number];
  sector: string;
  employmentType: (typeof EMPLOYMENT_TYPES)[number];
  location: {
    city: string | null;
    country: string | null;
    remotePolicy: (typeof REMOTE_POLICIES)[number];
  };
  rightToWork: string | null;
  languages: { name: string; level: string | null }[];
  experienceYears: { min: number | null; max: number | null } | null;
  mustHave: string[];
  niceToHave: string[];
  responsibilities: string[];
  hiringClient: string | null;
  jobCode: string | null;
  pay: Pay;
  suspectedPromptInjection: boolean;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type RawPay = {
  stated?: any;
  currency?: any;
  period?: any;
  bound?: any;
  min?: any;
  max?: any;
  exact?: any;
};
type RawProfile = {
  title?: any;
  role_family?: any;
  seniority?: any;
  sector?: any;
  employment_type?: any;
  location?: { city?: any; country?: any; remote_policy?: any } | null | undefined;
  right_to_work?: any;
  languages?: any;
  experience_years?: { min: number | null; max: number | null } | null | undefined;
  must_have?: any;
  nice_to_have?: any;
  responsibilities?: any;
  hiring_client?: any;
  job_code?: any;
  pay?: RawPay | null | undefined;
  suspected_prompt_injection?: any;
};

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 40)
    : [];

const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t && !/^(unknown|n\/a|none|null|not stated)$/i.test(t) ? t : null;
};

/**
 * Normalise model output. Pay is never defaulted: a JD that states no figure
 * is `unknown`, and a currency is kept only as a real ISO-4217 code read from
 * the JD — never the tenant's reporting currency.
 */
export function normaliseProfile(r: RawProfile): RequirementProfile {
  const payIn = r.pay;
  const min = payIn?.min ?? null;
  const max = payIn?.max ?? null;
  const exact = payIn?.exact ?? null;
  const hasFigure = [min, max, exact].some((n) => typeof n === "number" && n > 0);
  const currency = clean(payIn?.currency)?.toUpperCase() ?? null;
  const period = clean(payIn?.period)?.toLowerCase() ?? null;
  const bound = clean(payIn?.bound)?.toLowerCase() ?? null;
  const pay: Pay =
    payIn && payIn.stated !== false && hasFigure
      ? {
          status: "known",
          currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
          period: (PAY_PERIODS as readonly string[]).includes(period ?? "")
            ? (period as (typeof PAY_PERIODS)[number])
            : null,
          bound: (PAY_BOUNDS as readonly string[]).includes(bound ?? "")
            ? (bound as (typeof PAY_BOUNDS)[number])
            : null,
          min: typeof min === "number" ? min : null,
          max: typeof max === "number" ? max : null,
          exact: typeof exact === "number" ? exact : null,
        }
      : { status: "unknown" };
  const loc = r.location ?? {};
  const exp = r.experience_years;
  return {
    title: clean(r.title) ?? "Untitled role",
    roleFamily: clean(r.role_family)?.toLowerCase() ?? null,
    seniority: (SENIORITIES as readonly string[]).includes(r.seniority) ? r.seniority : "unknown",
    sector: clean(r.sector) ?? "unknown",
    employmentType: (EMPLOYMENT_TYPES as readonly string[]).includes(r.employment_type)
      ? r.employment_type
      : "unknown",
    location: {
      city: clean(loc.city),
      country: clean(loc.country),
      remotePolicy: (REMOTE_POLICIES as readonly string[]).includes(loc.remote_policy)
        ? loc.remote_policy
        : "unknown",
    },
    rightToWork: clean(r.right_to_work),
    languages: Array.isArray(r.languages)
      ? (r.languages as { name: string; level?: string | null }[])
          .filter((l) => clean(l?.name))
          .map((l) => ({ name: l.name.trim(), level: clean(l.level) }))
          .slice(0, 10)
      : [],
    experienceYears:
      exp && (exp.min != null || exp.max != null) ? { min: exp.min, max: exp.max } : null,
    mustHave: strList(r.must_have),
    niceToHave: strList(r.nice_to_have),
    responsibilities: strList(r.responsibilities),
    hiringClient: clean(r.hiring_client),
    jobCode: clean(r.job_code)?.replace(/\s+/g, "") ?? null,
    pay,
    suspectedPromptInjection: Boolean(r.suspected_prompt_injection),
  };
}

/** Platform default sector taxonomy, seeded into a tenant on first use. */
export const DEFAULT_SECTORS = [
  "AI & Data",
  "IT & Software",
  "Telecoms",
  "Engineering",
  "Digital Media",
  "Social Media",
  "E-commerce",
  "Automotive",
  "Renewable Energy",
  "Energy & Utilities",
  "Financial Services",
  "Healthcare & Life Sciences",
  "Manufacturing",
  "Retail & Consumer",
  "Public Sector",
] as const;

/** Map an extracted sector to the tenant taxonomy; anything else is unknown. */
export function mapSector(raw: string | null | undefined, terms: string[]): string {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "unknown";
  const hit = terms.find((t) => t.toLowerCase() === v);
  return hit ?? "unknown";
}

/* ------------------------------------------------------------ comparison */

export type Verdict = "duplicate" | "variant" | "distinct";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

const SENIORITY_BAND: Record<string, number> = {
  entry: 0,
  ic: 1,
  senior: 2,
  staff: 3,
  lead: 3,
  manager: 3,
  director: 4,
  executive: 5,
};

/** Annualised midpoint of a known pay, in its own currency. */
function annualMid(p: Pay): { currency: string | null; value: number } | null {
  if (p.status !== "known") return null;
  const mid =
    p.exact ?? (p.min != null && p.max != null ? (p.min + p.max) / 2 : (p.max ?? p.min ?? null));
  if (mid == null) return null;
  const factor = { hour: 2080, day: 260, month: 12, year: 1 }[p.period ?? "year"] ?? 1;
  return { currency: p.currency, value: mid * factor };
}

/**
 * Differences that make two JDs separate roles whatever the wording says
 * (§4.3): a pair with any of these can never be a duplicate. Unknown on
 * either side is never a difference.
 */
export function hardDifferences(
  a: RequirementProfile,
  b: RequirementProfile,
  opts: { payVarianceTolerance: number },
): string[] {
  const out: string[] = [];
  const ca = norm(a.location.country);
  const cb = norm(b.location.country);
  if (ca && cb && ca !== cb) out.push("country");
  const sa = SENIORITY_BAND[a.seniority];
  const sb = SENIORITY_BAND[b.seniority];
  if (sa != null && sb != null && sa !== sb) out.push("seniority");
  if (
    a.employmentType !== "unknown" &&
    b.employmentType !== "unknown" &&
    a.employmentType !== b.employmentType
  )
    out.push("employment_type");
  const ha = norm(a.hiringClient);
  const hb = norm(b.hiringClient);
  if (ha && hb && ha !== hb) out.push("hiring_client");
  const pa = annualMid(a.pay);
  const pb = annualMid(b.pay);
  if (pa && pb) {
    if (pa.currency && pb.currency && pa.currency !== pb.currency) out.push("pay_currency");
    else {
      const hi = Math.max(pa.value, pb.value);
      if (hi > 0 && Math.abs(pa.value - pb.value) / hi > opts.payVarianceTolerance)
        out.push("pay_band");
    }
  }
  return out;
}

/** Thresholds turning a similarity into a proposal. */
export const DUPLICATE_AT = 0.8;
export const VARIANT_AT = 0.5;

/** The proposal for a pair: similarity first, then the hard-difference cap. */
export function proposeVerdict(similarity: number, hard: string[]): Verdict {
  if (similarity >= DUPLICATE_AT) return hard.length ? "variant" : "duplicate";
  if (similarity >= VARIANT_AT) return "variant";
  return "distinct";
}

/** Requisition statuses that count as live for the duplicate check. */
export const LIVE_REQ_STATUSES = [
  "draft",
  "pending_dh",
  "pending_hr",
  "pending_cbo",
  "approved",
  "on_hold",
] as const;

/** Fields shown side by side in the review UI, in order. */
export function profileRows(p: RequirementProfile): { label: string; value: string }[] {
  const pay =
    p.pay.status === "unknown"
      ? "Not stated"
      : [
          p.pay.bound === "up_to" ? "Up to" : null,
          p.pay.exact ?? [p.pay.min, p.pay.max].filter((n) => n != null).join("–"),
          p.pay.currency,
          p.pay.period ? `per ${p.pay.period}` : null,
        ]
          .filter((x) => x != null && x !== "")
          .join(" ");
  return [
    { label: "Title", value: p.title },
    { label: "Job code", value: p.jobCode ?? "—" },
    { label: "Sector", value: p.sector },
    { label: "Seniority", value: p.seniority },
    { label: "Employment", value: p.employmentType },
    {
      label: "Location",
      value:
        [p.location.city, p.location.country].filter(Boolean).join(", ") +
        (p.location.remotePolicy !== "unknown" ? ` (${p.location.remotePolicy})` : ""),
    },
    { label: "Pay", value: pay },
    {
      label: "Experience",
      value: p.experienceYears
        ? `${p.experienceYears.min ?? 0}–${p.experienceYears.max ?? "+"} yrs`
        : "—",
    },
    { label: "Hiring client", value: p.hiringClient ?? "—" },
    { label: "Must-have", value: p.mustHave.join(", ") || "—" },
    { label: "Responsibilities", value: p.responsibilities.join("; ") || "—" },
  ];
}

const STOP = new Set(["the", "a", "an", "and", "of", "for", "to", "in", "with", "&", "-", "–"]);
function titleTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((t) => t && !STOP.has(t)),
  );
}

/** Token Jaccard of two titles (the cheap fallback when no comparison ran). */
export function titleSimilarity(a: string, b: string): number {
  const x = titleTokens(a);
  const y = titleTokens(b);
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const t of x) if (y.has(t)) hit += 1;
  return hit / (x.size + y.size - hit);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
