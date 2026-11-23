import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { callReviewSummary } from "@/lib/call-reviews.functions";

const PURPOSE: Record<string, string> = {
  screening: "Screening",
  scheduling: "Scheduling",
  negotiation: "Pay discussion",
};

/**
 * The Voice Guard at a glance on the agent health page: the last 7 days of
 * call reviews — verdicts, what is still to read, the checks that fail most.
 */
export function CallReviewsSummary() {
  const q = useQuery({
    queryKey: ["call_review_summary"],
    queryFn: () => callReviewSummary(),
    refetchInterval: 60_000,
    retry: false,
  });
  // Nothing to show where no AI phone call was ever reviewed (or the person may not read them).
  if (q.error || !q.data || (q.data.reviewed === 0 && q.data.pending === 0)) return null;
  const d = q.data;
  const tile = (label: string, value: string | number, tone?: "bad" | "warn") => (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`text-xl font-semibold tabular-nums ${
          tone === "bad"
            ? "text-destructive"
            : tone === "warn"
              ? "text-amber-600 dark:text-amber-400"
              : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Call reviews</h2>
          <p className="text-sm text-muted-foreground">
            The Voice Guard's review of every answered AI phone call — last {d.days} days.
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/agents/call-reviews">Open call reviews</Link>
        </Button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {tile("Reviewed", d.reviewed)}
        {tile("Breach", d.breach, d.breach ? "bad" : undefined)}
        {tile("Attention", d.attention, d.attention ? "warn" : undefined)}
        {tile("Not yet read", d.unread, d.unread ? "warn" : undefined)}
        {tile("Waiting or failed", d.pending, d.failed ? "bad" : undefined)}
        {tile("Avg quality", d.avgQuality != null ? `${d.avgQuality}/5` : "—")}
      </div>
      <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">By call</h3>
          <ul className="space-y-0.5">
            {d.byPurpose.map((p) => (
              <li key={p.purpose}>
                {PURPOSE[p.purpose] ?? p.purpose}: {p.breach} of {p.reviewed} with a breach
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Most frequent breaches</h3>
          {d.topChecks.length ? (
            <ul className="space-y-0.5">
              {d.topChecks.map((c) => (
                <li key={c.check}>
                  {c.title} — {c.n}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">None.</p>
          )}
        </div>
      </div>
    </section>
  );
}
