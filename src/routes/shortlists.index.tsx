/**
 * Shortlists (C2): every requisition ranked by profile matching, with how many
 * candidates were reviewed and shortlisted.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { listRankedRequisitionsFn } from "@/lib/shortlist.functions";
import { requireRouteCapability } from "@/lib/route-guard";

export const Route = createFileRoute("/shortlists/")({
  beforeLoad: requireRouteCapability,
  head: () => ({ meta: [{ title: "Shortlists — ATSIQ" }] }),
  component: ShortlistsPage,
});

function ShortlistsPage() {
  const list = useServerFn(listRankedRequisitionsFn);
  const q = useQuery({
    queryKey: ["ranked_requisitions"],
    queryFn: () => list(),
    refetchInterval: (s) =>
      s.state.data?.some((r) => r.runStatus === "queued" || r.runStatus === "running")
        ? 10_000
        : false,
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Shortlists" />
      {q.data?.length ? (
        <div className="panel divide-y">
          {q.data.map((r) => (
            <Link
              key={r.id}
              to="/shortlists/$requisitionId"
              params={{ requisitionId: r.id }}
              className="flex flex-wrap items-center gap-3 p-4 hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.title}</div>
                <div className="num text-xs text-muted-foreground">{r.code}</div>
              </div>
              {r.runStatus === "queued" || r.runStatus === "running" ? (
                <Badge variant="secondary" className="gap-1">
                  <Loader2 className="size-3 animate-spin" /> ranking
                </Badge>
              ) : null}
              <dl className="grid grid-cols-4 gap-6 text-right text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Pool</dt>
                  <dd className="num">{r.pool}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Reviewed</dt>
                  <dd className="num">{r.reviewed}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Shortlisted</dt>
                  <dd className="num">{r.shortlisted}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Top</dt>
                  <dd className="num font-medium">{r.topScore ?? "–"}</dd>
                </div>
              </dl>
            </Link>
          ))}
        </div>
      ) : q.isLoading ? null : (
        <EmptyState title="No ranked roles yet" />
      )}
    </div>
  );
}
