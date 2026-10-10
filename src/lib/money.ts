/** Rupee amounts in Indian digit grouping (₹1,10,00,000), for server-written text. */
export const rupees = (n: number | string | null | undefined): string =>
  n == null || Number.isNaN(Number(n))
    ? "—"
    : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
