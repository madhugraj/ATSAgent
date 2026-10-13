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
