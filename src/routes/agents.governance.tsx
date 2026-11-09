/**
 * Agent governance (governance roles): is the harness around the agents
 * holding, and are they handing work to each other safely? Verdict, fix list,
 * hand-off map and an agent × check matrix. Deterministic: no model calls.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { AgentGovernancePanel } from "@/components/agent-governance";
import { PageHeader } from "@/components/ats";
import { Button } from "@/components/ui/button";
import { agentGovernance } from "@/lib/agent-governance.functions";

export const Route = createFileRoute("/agents/governance")({
  head: () => ({
    meta: [
      { title: "Agent governance — ATSIQ" },
      {
        name: "description",
        content:
          "Whether the harness around your hiring agents is holding, and how they hand work to each other.",
      },
    ],
  }),
  component: GovernancePage,
});

function GovernancePage() {
  const q = useQuery({
    queryKey: ["agent-governance"],
    queryFn: () => agentGovernance(),
    refetchInterval: 60_000,
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Agent governance"
        description="Is the harness around your agents holding — and are they handing work to each other safely?"
        actions={
          <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw
              className={`mr-1.5 size-3.5 ${q.isFetching ? "animate-spin" : ""}`}
              aria-hidden
            />
            {q.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />
      {q.isError && (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          Agent governance is available to the HR head and CBO.
        </p>
      )}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.data && <AgentGovernancePanel h={q.data.harness} />}
    </div>
  );
}
