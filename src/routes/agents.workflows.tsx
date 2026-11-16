import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Download, Play, Workflow } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  orgWorkflowReport,
  orgWorkflows,
  startOrgWorkflow,
  type OrgWorkflowsView,
} from "@/lib/org-workflows.functions";

export const Route = createFileRoute("/agents/workflows")({
  head: () => ({
    meta: [
      { title: "Agent workflows — ATSIQ" },
      { name: "description", content: "Start agent workflows with a hiring need and follow them." },
    ],
  }),
  component: OrgWorkflowsPage,
});

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function OrgWorkflowsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["org_workflows"], queryFn: () => orgWorkflows(), retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ["org_workflows"] });
  const download = async (runId: string, kind: "pdf" | "xlsx") => {
    try {
      const r = await orgWorkflowReport({ data: { runId } });
      const { downloadWorkflowRunReport } = await import("@/lib/agent-reports");
      downloadWorkflowRunReport(kind, r);
    } catch (e) {
      toast.error(errorText(e, "Could not build the report"));
    }
  };
  return (
    <>
      <PageHeader eyebrow="Agent administration" title="Agent workflows" />
      {q.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <p className="mt-4 text-sm text-muted-foreground">{errorText(q.error, "Not available.")}</p>
      ) : (
        <>
          {q.data?.startable.length ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {q.data.startable.map((w) => (
                <StartCard key={w.id} workflow={w} onStarted={refresh} />
              ))}
            </div>
          ) : null}
          <h2 className="mt-6 text-sm font-semibold">Runs</h2>
          {q.data?.runs.length ? (
            <ul className="mt-2 divide-y rounded-md border text-sm">
              {q.data.runs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <Badge
                    variant={
                      r.status === "failed"
                        ? "destructive"
                        : r.status === "done"
                          ? "default"
                          : "secondary"
                    }
                  >
                    {r.status}
                  </Badge>
                  <span className="font-medium">{r.workflow}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                  <div className="ml-auto flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      onClick={() => download(r.id, "pdf")}
                    >
                      <Download className="size-3.5" /> PDF
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      onClick={() => download(r.id, "xlsx")}
                    >
                      <Download className="size-3.5" /> Excel
                    </Button>
                  </div>
                  <div className="basis-full text-xs text-muted-foreground">
                    {r.need ? `${r.need} · ` : ""}
                    {r.error ?? r.lastNote ?? ""}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No workflow runs yet" />
          )}
        </>
      )}
    </>
  );
}

function StartCard({
  workflow,
  onStarted,
}: {
  workflow: OrgWorkflowsView["startable"][number];
  onStarted: () => void;
}) {
  const [need, setNeed] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <article className="glass-card flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Workflow className="size-4 text-primary" />
        {workflow.name}
      </div>
      {workflow.description ? (
        <p className="text-xs text-muted-foreground">{workflow.description}</p>
      ) : null}
      <Textarea
        className="min-h-20 text-sm"
        placeholder="Hiring need"
        value={need}
        maxLength={4000}
        onChange={(e) => setNeed(e.target.value)}
      />
      <Button
        size="sm"
        className="self-start"
        disabled={busy || need.trim().length < 5}
        onClick={async () => {
          setBusy(true);
          try {
            await startOrgWorkflow({ data: { workflowId: workflow.id, need } });
            toast.success("Started");
            setNeed("");
            onStarted();
          } catch (e) {
            toast.error(errorText(e, "Could not start"));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Play className="size-4" /> Start
      </Button>
    </article>
  );
}
