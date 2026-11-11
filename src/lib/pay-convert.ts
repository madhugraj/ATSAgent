/**
 * The only pay converter (docs/pay-terms-plan.md, Phase 1).
 *
 * Rules, never broken:
 *  - the original figure is never changed; conversions are derived values that
 *    carry the rate, its source and its date;
 *  - no guess: without the hours, payments a year or a fresh rate, a conversion
 *    is refused with a reason — never estimated;
 *  - net is never turned into gross;
 *  - decisions compare in the role's pay currency and basis, so a currency move
 *    alone never flips a decision; the reporting view is for people.
 *
 * Pure; unit-tested in scripts/pay-terms.test.ts.
 */
import type { ExchangeRate, Money, PayBasis, PayTerms, PayZone } from "./pay-terms";

/** Why a conversion or comparison could not be made — shown to a person, plain words. */
export type Refusal =
  | "net_figure"
  | "hours_unknown"
  | "payments_unknown"
  | "no_rate"
  | "stale_rate"
  | "different_contract_type"
  | "different_kind_of_work";

export const REFUSAL_WORDS: Record<Refusal, string> = {
  net_figure: "Net figure — ask for the gross amount",
  hours_unknown: "Working hours not known — cannot convert between hourly and yearly",
  payments_unknown: "Payments a year not known — cannot convert monthly to yearly",
  no_rate: "No exchange rate on record for this currency pair",
  stale_rate: "The exchange rate is out of date — refresh it before comparing",
  different_contract_type: "Different contract type — not compared",
  different_kind_of_work: "Different kind of work — not compared",
};

export type Converted =
  | { ok: true; money: Money; rate: ExchangeRate | null; notes: string[] }
  | { ok: false; refusal: Refusal };

/** How long a rate stays usable, by currency (volatile currencies refresh sooner). */
export const RATE_VALID_DAYS: Record<string, number> = { ARS: 1, TRY: 2, NGN: 2, EGP: 3 };
export const DEFAULT_RATE_VALID_DAYS = 7;

/** The conventions a conversion uses: the role's terms first, then the zone's. */
export type Conventions = {
  hoursPerWeek: number | null;
  workingDaysPerYear: number | null;
  paymentsPerYear: number | null;
};

export function conventionsOf(
  terms: Pick<PayTerms, "hoursPerWeek" | "daysPerWeek"> | null,
  zone: Pick<PayZone, "hoursPerWeek" | "workingDaysPerYear" | "paymentsPerYear"> | null,
): Conventions {
  return {
    // The role's own hours (a 20 h/week part-time role) win over the zone default.
    hoursPerWeek: terms?.hoursPerWeek ?? zone?.hoursPerWeek ?? null,
    workingDaysPerYear:
      terms?.daysPerWeek != null && zone
        ? Math.round((zone.workingDaysPerYear * terms.daysPerWeek) / 5)
        : (zone?.workingDaysPerYear ?? null),
    paymentsPerYear: zone?.paymentsPerYear ?? null,
  };
}

const WEEKS_PER_YEAR = 52;

/** The figure as a yearly amount in its own currency (or a refusal). */
function annualOf(m: Money, c: Conventions): number | Refusal {
  switch (m.basis) {
    case "annual":
      return m.amount;
    case "monthly": {
      const n = m.paymentsPerYear ?? c.paymentsPerYear;
      return n ? m.amount * n : "payments_unknown";
    }
    case "daily":
      return c.workingDaysPerYear ? m.amount * c.workingDaysPerYear : "hours_unknown";
    case "hourly":
      return c.hoursPerWeek ? m.amount * c.hoursPerWeek * WEEKS_PER_YEAR : "hours_unknown";
  }
}

function fromAnnual(annual: number, basis: PayBasis, c: Conventions): number | Refusal {
  switch (basis) {
    case "annual":
      return annual;
    case "monthly":
      return c.paymentsPerYear ? annual / c.paymentsPerYear : "payments_unknown";
    case "daily":
      return c.workingDaysPerYear ? annual / c.workingDaysPerYear : "hours_unknown";
    case "hourly":
      return c.hoursPerWeek ? annual / (c.hoursPerWeek * WEEKS_PER_YEAR) : "hours_unknown";
  }
}

/** The usable rate from → to at `now`, direct or inverse; or why not. */
export function rateFor(
  rates: ExchangeRate[],
  from: string,
  to: string,
  now: Date,
): ExchangeRate | Refusal {
  if (from === to) return { from, to, rate: 1, source: "same currency", at: now.toISOString() };
  const candidates = rates
    .flatMap((r): ExchangeRate[] =>
      r.from === from && r.to === to
        ? [r]
        : r.from === to && r.to === from && r.rate > 0
          ? [{ ...r, from, to, rate: 1 / r.rate }]
          : [],
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const best = candidates[0];
  if (!best) return "no_rate";
  const validDays = Math.min(
    RATE_VALID_DAYS[from] ?? DEFAULT_RATE_VALID_DAYS,
    RATE_VALID_DAYS[to] ?? DEFAULT_RATE_VALID_DAYS,
  );
  if (now.getTime() - Date.parse(best.at) > validDays * 86_400_000) return "stale_rate";
  return best;
}

/**
 * `m` in `currency` and `basis`, using the conventions and rates given. The
 * result says how it was derived; `m` itself is untouched.
 */
export function convert(
  m: Money,
  to: { currency: string; basis: PayBasis },
  c: Conventions,
  rates: ExchangeRate[],
  now: Date,
): Converted {
  if (m.gross === false) return { ok: false, refusal: "net_figure" };
  const annual = annualOf(m, c);
  if (typeof annual === "string") return { ok: false, refusal: annual };
  const rate = rateFor(rates, m.currency, to.currency, now);
  if (typeof rate === "string") return { ok: false, refusal: rate };
  const inBasis = fromAnnual(annual * rate.rate, to.basis, c);
  if (typeof inBasis === "string") return { ok: false, refusal: inBasis };
  const notes: string[] = [];
  if (m.basis !== to.basis) notes.push(`converted from ${m.basis} to ${to.basis}`);
  if (m.currency !== to.currency)
    notes.push(
      `at ${round(rate.rate, 6)} ${to.currency} per ${m.currency} (${rate.source}, ${rate.at.slice(0, 10)})`,
    );
  if (m.currencyAssumed) notes.push("currency not said — assumed");
  return {
    ok: true,
    money: {
      ...m,
      amount: round(inBasis, 2),
      currency: to.currency,
      basis: to.basis,
      paymentsPerYear: to.basis === "monthly" ? c.paymentsPerYear : null,
      saidAs: m.saidAs,
      currencyAssumed: m.currencyAssumed,
    },
    rate: m.currency === to.currency ? null : rate,
    notes,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** A band in the role's pay currency and basis. */
export type Band = { min: number | null; max: number | null };

export type BandCheck = {
  /** Compared in the role's pay currency and basis. */
  comparable: boolean;
  refusal: Refusal | null;
  /** The candidate's figure in pay currency/basis, when comparable. */
  inPay: Money | null;
  /** The same figure in the organisation's reporting currency, when a rate allows. */
  inReporting: Money | null;
  position: "below" | "inside" | "above" | "far_above" | null;
  flags: string[];
};

/**
 * A candidate's figure against the role's band (pure). The decision is made in
 * the role's pay currency and basis; the reporting view never decides.
 * `farAbovePct`: over the ceiling by more than this is "far_above" (the
 * organisation's tolerance; 20 by default, as the logistics blocker today).
 */
export function checkAgainstBand(input: {
  figure: Money;
  /** The candidate's kind of work / contract type, when known (a 1099 rate vs a W-2 band). */
  figureKind?: string | null;
  figureContractType?: string | null;
  terms: PayTerms;
  zone: PayZone | null;
  band: Band;
  rates: ExchangeRate[];
  reportingCurrency: string;
  now: Date;
  farAbovePct?: number;
}): BandCheck {
  const { figure, terms, zone, band, rates, now } = input;
  const flags: string[] = [];
  const none = (refusal: Refusal): BandCheck => ({
    comparable: false,
    refusal,
    inPay: null,
    inReporting: null,
    position: null,
    flags: [...flags, REFUSAL_WORDS[refusal]],
  });
  if (input.figureKind && input.figureKind !== terms.kind) return none("different_kind_of_work");
  if (
    input.figureContractType &&
    terms.contractType &&
    input.figureContractType !== terms.contractType
  )
    return none("different_contract_type");
  if (figure.currency !== terms.currency)
    flags.push(`Quoted in ${figure.currency}; the role pays in ${terms.currency}`);
  if (figure.currencyAssumed) flags.push("Currency not said — confirm with the candidate");
  if (
    zone &&
    figure.includes &&
    figure.includes.slice().sort().join() !== zone.includes.slice().sort().join()
  )
    flags.push("Different pay definitions — check what the figure includes");

  const c = conventionsOf(terms, zone);
  const inPay = convert(figure, { currency: terms.currency, basis: terms.basis }, c, rates, now);
  if (!inPay.ok) return none(inPay.refusal);
  const rep = convert(
    figure,
    { currency: input.reportingCurrency, basis: "annual" },
    c,
    rates,
    now,
  );
  const amount = inPay.money.amount;
  const pct = input.farAbovePct ?? 20;
  const position =
    band.max != null && amount > band.max * (1 + pct / 100)
      ? "far_above"
      : band.max != null && amount > band.max
        ? "above"
        : band.min != null && amount < band.min
          ? "below"
          : "inside";
  return {
    comparable: true,
    refusal: null,
    inPay: inPay.money,
    inReporting: rep.ok ? rep.money : null,
    position,
    flags: [...flags, ...inPay.notes.filter((n) => !n.startsWith("currency not said"))],
  };
}

/**
 * A pay rise between two figures, only when both are in the same currency and
 * basis after conversion (a raw INR → EUR percentage is meaningless).
 */
export function hikePct(
  current: Money,
  expected: Money,
  c: Conventions,
  rates: ExchangeRate[],
  now: Date,
): number | Refusal {
  const cur = convert(
    current,
    { currency: expected.currency, basis: expected.basis },
    c,
    rates,
    now,
  );
  if (!cur.ok) return cur.refusal;
  if (cur.money.amount <= 0) return "no_rate";
  return round(((expected.amount - cur.money.amount) / cur.money.amount) * 100, 1);
}

/* ---------------------------------------------------------------- speech */

const NAMES: Record<string, { one: string; many: string; minor?: string }> = {
  INR: { one: "rupee", many: "rupees" },
  USD: { one: "dollar", many: "dollars" },
  EUR: { one: "euro", many: "euros" },
  GBP: { one: "pound", many: "pounds" },
  AED: { one: "dirham", many: "dirhams" },
  SGD: { one: "Singapore dollar", many: "Singapore dollars" },
  AUD: { one: "Australian dollar", many: "Australian dollars" },
  CAD: { one: "Canadian dollar", many: "Canadian dollars" },
  JPY: { one: "yen", many: "yen" },
  CHF: { one: "Swiss franc", many: "Swiss francs" },
  BRL: { one: "real", many: "reais" },
  PLN: { one: "zloty", many: "zloty" },
};

const PER: Record<PayBasis, string> = {
  annual: "a year",
  monthly: "a month",
  daily: "a day",
  hourly: "an hour",
};

/** Indian grouping for rupees: "18 lakh 50 thousand". */
function indian(n: number): string {
  const r = Math.round(n);
  const crore = Math.floor(r / 1e7);
  const lakh = Math.floor((r % 1e7) / 1e5);
  const thousand = Math.floor((r % 1e5) / 1e3);
  const rest = r % 1e3;
  const parts = [
    crore ? `${crore} crore` : "",
    lakh ? `${lakh} lakh` : "",
    thousand ? `${thousand} thousand` : "",
    rest ? String(rest) : "",
  ].filter(Boolean);
  return parts.join(" ") || "0";
}

/** International grouping: "1.2 million", "90 thousand", "65.50". */
function international(n: number): string {
  if (n >= 1e6) return `${round(n / 1e6, 2)} million`;
  if (n >= 1e4) return `${round(n / 1e3, 1)} thousand`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * A figure as the assistant says it on a call: "18 lakh 50 thousand rupees a
 * year", "90 thousand pounds a year", "65.50 dollars an hour". Unknown
 * currencies are spelled by code ("4 million ARS a year").
 */
export function spokenMoney(m: Pick<Money, "amount" | "currency" | "basis">): string {
  const name = NAMES[m.currency];
  const amount = m.currency === "INR" ? indian(m.amount) : international(m.amount);
  const unit = name ? (m.amount === 1 ? name.one : name.many) : m.currency;
  return `${amount} ${unit} ${PER[m.basis]}`;
}

/* ---------------------------------------------------------------- parsing */

const SCALE: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  lacs: 1e5,
  l: 1e5,
  lpa: 1e5,
  crore: 1e7,
  crores: 1e7,
  cr: 1e7,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
};

const SYMBOL: Record<string, string> = { "₹": "INR", $: "USD", "€": "EUR", "£": "GBP" };
const WORD_CCY: [RegExp, string][] = [
  [/\b(rupees?|inr|rs\.?)\b/i, "INR"],
  [/\b(dollars?|usd)\b/i, "USD"],
  [/\b(euros?|eur)\b/i, "EUR"],
  [/\b(pounds?|gbp|sterling)\b/i, "GBP"],
  [/\b(dirhams?|aed)\b/i, "AED"],
];

/**
 * Figures in a phrase as said ("€52k", "95 lakhs to 1 crore", "1.2 M dollars",
 * "65 an hour"). Returns the amounts (a range gives two) and the currency when
 * said. Pure; the voice tools keep their own stricter checks.
 */
export function parseAmounts(text: string): {
  amounts: number[];
  currency: string | null;
  basis: PayBasis | null;
} {
  const t = text.toLowerCase().replace(/,(?=\d{3}\b)/g, "");
  let currency: string | null = null;
  for (const [sym, code] of Object.entries(SYMBOL)) if (text.includes(sym)) currency = code;
  if (!currency) for (const [re, code] of WORD_CCY) if (re.test(text)) currency = code;
  const basis: PayBasis | null = /\b(an?|per)\s+hour|hourly|\/\s*h(ou)?r\b/.test(t)
    ? "hourly"
    : /\b(a|per)\s+day|day rate|daily\b/.test(t)
      ? "daily"
      : /\b(a|per)\s+month|monthly|\/\s*month\b/.test(t)
        ? "monthly"
        : /\b(a|per)\s+year|annual|yearly|lpa|ctc|ral\b|p\.?a\.?\b/.test(t)
          ? "annual"
          : null;
  const amounts: number[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|lpa|l|crores?|cr|mn|m|million)?\b/g;
  for (const m of t.matchAll(re)) {
    const n = Number(m[1]);
    const unit = m[2] ?? "";
    const value = n * (SCALE[unit] ?? 1);
    // Bare small numbers without a scale are months, days or dates — not pay.
    if (!unit && n < 100 && !currency && basis !== "hourly" && basis !== "daily") continue;
    amounts.push(value);
  }
  return { amounts, currency, basis };
}
