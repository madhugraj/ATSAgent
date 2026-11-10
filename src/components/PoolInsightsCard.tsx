import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, RefreshCw, ThumbsDown, ThumbsUp, TrendingUp } from "lucide-react";
import { toast } from "sonner";

import { poolInsights, rateDemandOutlook, refreshDemandOutlook } from "@/lib/copilot.functions";
import type { CoverageStatus } from "@/lib/pool-coverage";
import { Button } from "@/components/ui/button";

const DOT: Record<CoverageStatus, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-rose-500",
};

/**
 * Talent-pool coverage (strong fits per opening for open roles) and the
 * demand outlook (roles likely to grow next two quarters), above the pool
 * table. Hidden for people whose role does not include the pool.
 */
export function PoolInsightsCard() {
  const qc = useQueryClient();
  const load = useServerFn(poolInsights);
  const refresh = useServerFn(refreshDemandOutlook);
  const rate = useServerFn(rateDemandOutlook);
  const [open, setOpen] = useState(false);
  const [rated, setRated] = useState<Record<string, boolean>>({});

  const q = useQuery({
    queryKey: ["pool-insights"],
    queryFn: () => load(),
    retry: false,
    staleTime: 60_000,
  });
  const build = useMutation({
    mutationFn: () => refresh(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pool-insights"] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not build the outlook"),
  });
  const feedback = useMutation({
    mutationFn: (v: { role: string; useful: boolean }) => rate({ data: v }),
    onSuccess: (_r, v) => setRated((p) => ({ ...p, [v.role]: v.useful })),
  });

  if (!q.data) return null;
  const { coverage, outlook, canRefresh } = q.data;
  const rows = coverage.requisitions.length ? coverage.requisitions : coverage.roles;

  return (
    <section className="rounded-2xl border border-border/60 bg-card/60 p-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="font-medium">Pool coverage</span>
          <span className="text-muted-foreground">{coverage.poolSize} people</span>
          {(["red", "amber", "green"] as const).map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className={`size-2 rounded-full ${DOT[s]}`} />
              {coverage.summary[s]} {coverage.requisitions.length ? "open roles" : "roles"}
            </span>
          ))}
          {outlook?.rows[0] ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <TrendingUp className="size-3.5" /> Likely demand: {outlook.rows[0].role}
            </span>
          ) : null}
        </div>
        <ChevronDown
          className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Strong fits per opening
            </h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Green 3 or more, amber 1–3, red under 1. A strong fit covers 80% of the must-haves.
            </p>
            <ul className="space-y-1.5 text-sm">
              {rows.slice(0, 10).map((r) => (
                <li key={r.key} className="flex items-start gap-2">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[r.status]}`} />
                  <div className="min-w-0">
                    <div className="truncate">
                      {r.label}{" "}
                      <span className="text-muted-foreground">
                        · {r.strong} strong, {r.partial} partial for {r.demand} · {r.internal}{" "}
                        internal
                      </span>
                    </div>
                    {r.missingSkills.length ? (
                      <div className="text-xs text-muted-foreground">
                        Scarce: {r.missingSkills.slice(0, 4).join(", ")}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
              {!rows.length ? (
                <li className="text-muted-foreground">No open roles with must-have skills yet.</li>
              ) : null}
            </ul>
            {coverage.summary.topSkillGaps.length ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Skills the pool lacks most:{" "}
                {coverage.summary.topSkillGaps
                  .slice(0, 6)
                  .map((g) => g.skill)
                  .join(", ")}
              </p>
            ) : null}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Demand outlook · next two quarters
              </h3>
              {!outlook || canRefresh ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={build.isPending}
                  onClick={() => build.mutate()}
                >
                  <RefreshCw className={`size-3 ${build.isPending ? "animate-spin" : ""}`} />
                  {outlook ? "Refresh" : "Build outlook"}
                </Button>
              ) : null}
            </div>
            {outlook ? (
              <>
                <p className="mb-2 text-xs text-muted-foreground">
                  Built {new Date(outlook.generatedAt).toLocaleDateString()} from{" "}
                  {outlook.historyQuarters} quarter(s) of your requisitions
                  {outlook.marketAvailable
                    ? outlook.marketGrounded
                      ? " and live market research."
                      : " and a market estimate without live sources."
                    : "; the market signal was unavailable."}
                  {outlook.thinHistory
                    ? " Your history is thin, so treat this as a low-confidence early read."
                    : ""}
                </p>
                <ul className="space-y-2 text-sm">
                  {outlook.rows.map((r) => (
                    <li key={r.role} className="rounded-lg border border-border/50 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{r.role}</span>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          {r.confidence} confidence
                          {r.coverage ? (
                            <span className={`ml-1 size-2 rounded-full ${DOT[r.coverage]}`} />
                          ) : null}
                        </span>
                      </div>
                      <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                        {r.evidence.map((e) => (
                          <li key={e}>{e}</li>
                        ))}
                      </ul>
                      <div className="mt-1 flex items-center gap-1">
                        {rated[r.role] === undefined ? (
                          <>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6"
                              aria-label="Useful"
                              onClick={() => feedback.mutate({ role: r.role, useful: true })}
                            >
                              <ThumbsUp className="size-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6"
                              aria-label="Not useful"
                              onClick={() => feedback.mutate({ role: r.role, useful: false })}
                            >
                              <ThumbsDown className="size-3" />
                            </Button>
                          </>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">Thanks</span>
                        )}
                      </div>
                    </li>
                  ))}
                  {!outlook.rows.length ? (
                    <li className="text-muted-foreground">No role shows rising demand yet.</li>
                  ) : null}
                </ul>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Not built yet. Building it reads your requisition history and runs one market
                research request.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
