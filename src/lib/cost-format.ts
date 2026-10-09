/** Token counts and money for cost views (client-safe). */
export const fmtTokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : `${n}`;

export const fmtMoney = (cost: number | null | undefined, currency: string | null) =>
  cost == null || !currency
    ? null
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: cost < 1 ? 3 : 2,
      }).format(cost);
