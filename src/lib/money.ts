/** Rupee amounts in Indian digit grouping (₹1,10,00,000), for server-written text. */
export const rupees = (n: number | string | null | undefined): string =>
  n == null || Number.isNaN(Number(n))
    ? "—"
    : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/** Lakhs per annum as typed (e.g. "18.5") → rupees, or null when blank. */
export function lakhsToRupees(v: string): number | null {
  const t = v.replace(/,/g, "").trim();
  if (!t) return null;
  const x = Number(t);
  return Number.isFinite(x) && x >= 0 ? Math.round(x * 100_000) : Number.NaN;
}

const PER: Record<string, string> = {
  annual: " a year",
  monthly: " a month",
  daily: " a day",
  hourly: " an hour",
};

/**
 * An amount in its own currency for server-written text (docs/pay-terms-plan.md):
 * rupees keep Indian grouping (₹18,50,000); others use their own symbol or code
 * (€52,000, US$65, £550). `basis` adds " a year" / " an hour" when given.
 */
export function money(
  n: number | string | null | undefined,
  currency = "INR",
  basis?: string | null,
): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  const text =
    currency === "INR"
      ? rupees(v)
      : new Intl.NumberFormat("en-GB", {
          style: "currency",
          currency,
          maximumFractionDigits: Number.isInteger(v) ? 0 : 2,
        }).format(v);
  return basis ? `${text}${PER[basis] ?? ""}` : text;
}
