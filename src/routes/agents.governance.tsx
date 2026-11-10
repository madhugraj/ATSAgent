/**
 * Agent governance (governance roles): is the harness around the agents
 * holding, and are they handing work to each other safely? Verdict, fix list,
 * hand-off map and an agent × check matrix for the chosen period and agent,
 * with the same window downloadable as a PDF or Excel report. Deterministic.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";

import { AgentGovernancePanel } from "@/components/agent-governance";
import { PageHeader } from "@/components/ats";
import { ReportBar, useReportWindow } from "@/components/report-bar";
import { agentActivityReport, agentGovernance } from "@/lib/agent-governance.functions";
import { downloadGovernanceReport } from "@/lib/agent-reports";

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
  const rw = useReportWindow({ withAgent: true });
  const q = useQuery({
    queryKey: ["agent-governance", rw.window],
    queryFn: () => agentGovernance({ data: rw.window }),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  // the agent list stays complete while one agent is selected
  const allAgents = useRef<string[]>([]);
  if (q.data && !q.data.window.agent && q.data.window.modality === "all")
    allAgents.current = q.data.harness.agents.map((a) => a.agent).sort();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Agent governance"
        description="Is the harness around your agents holding — and are they handing work to each other safely?"
        actions={
          <ReportBar
            rw={rw}
            agents={allAgents.current}
            disabled={!q.data}
            onDownload={async (kind) => {
              if (!q.data) return;
              const activity = await agentActivityReport({ data: rw.window });
              downloadGovernanceReport(kind, q.data.harness, activity, rw.window);
            }}
          />
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
