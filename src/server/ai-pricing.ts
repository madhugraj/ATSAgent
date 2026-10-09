/**
 * Published list prices for the AI models organisations connect (their own
 * keys), so hiring cost can be shown in money without anyone typing rates in.
 *
 * Only prices read from the provider's own pricing page are listed, with the
 * page and the day they were checked. A model that is not listed has no price
 * here: its tokens are reported as unpriced, never guessed. An organisation's
 * own rates (agent_cost_rates — e.g. a negotiated or local-currency price)
 * take precedence over the list price.
 *
 * Server-only: model and vendor names never reach the client outside the
 * organisation's own AI model settings (AGENTS.md).
 */

export type PricePeriod = {
  /** First day this price applies (inclusive, YYYY-MM-DD); null = since launch. */
  from: string | null;
  /** Per 1M input (prompt) tokens. */
  inputPerMillion: number;
  /** Per 1M output tokens, thinking tokens included. */
  outputPerMillion: number;
};

export type ModelPrice = {
  provider: string;
  model: string;
  currency: "USD";
  /** Which price on the page this is. */
  basis: string;
  periods: PricePeriod[];
  /** Web search grounding: free requests per month, then the price per 1,000. */
  grounding?: { freePerMonth: number; perThousand: number };
  source: string;
  checkedOn: string;
};

export const PRICE_LIST: ModelPrice[] = [
  {
    provider: "google",
    model: "gemini-3.8-flash",
    currency: "USD",
    basis: "Paid tier, standard (Gemini Developer API)",
    periods: [
      { from: null, inputPerMillion: 0.75, outputPerMillion: 3.75 },
      { from: "2027-01-01", inputPerMillion: 1.5, outputPerMillion: 7.5 },
    ],
    grounding: { freePerMonth: 5000, perThousand: 14 },
    source: "https://ai.google.dev/gemini-api/docs/pricing",
    checkedOn: "2026-10-09",
  },
];

const key = (provider: string, model: string) =>
  `${provider.toLowerCase()}::${model.toLowerCase()}`;
const BY_MODEL = new Map(PRICE_LIST.map((p) => [key(p.provider, p.model), p]));

export function priceEntry(provider: string, model: string): ModelPrice | null {
  return BY_MODEL.get(key(provider, model)) ?? null;
}

/** The list price in force for a model on a day (YYYY-MM-DD), or null if not on file. */
export function listPrice(
  provider: string,
  model: string,
  day: string,
): (PricePeriod & { currency: "USD" }) | null {
  const e = priceEntry(provider, model);
  if (!e) return null;
  const p = [...e.periods]
    .filter((x) => x.from === null || x.from <= day)
    .sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""))
    .at(-1);
  return p ? { ...p, currency: e.currency } : null;
}

export type OrgRate = { currency: string; inputPerMillion: number; outputPerMillion: number };

export type PricedBucket = {
  provider: string;
  model: string;
  /** YYYY-MM-DD */
  day: string;
  promptTokens: number;
  completionTokens: number;
};

/**
 * Money for a bucket of usage: the organisation's own rate if it set one,
 * else the model's list price that day; null when neither is known.
 */
export function priceBucket(
  b: PricedBucket,
  orgRate: OrgRate | null,
): { cost: number; currency: string; basis: "org_rate" | "list_price" } | null {
  if (orgRate)
    return {
      cost:
        (b.promptTokens / 1e6) * orgRate.inputPerMillion +
        (b.completionTokens / 1e6) * orgRate.outputPerMillion,
      currency: orgRate.currency,
      basis: "org_rate",
    };
  const p = listPrice(b.provider, b.model, b.day);
  if (!p) return null;
  return {
    cost:
      (b.promptTokens / 1e6) * p.inputPerMillion + (b.completionTokens / 1e6) * p.outputPerMillion,
    currency: p.currency,
    basis: "list_price",
  };
}
