import { createFileRoute } from "@tanstack/react-router";

import { WorkflowApp } from "@/components/agents/WorkflowApp";

export const Route = createFileRoute("/w/$workflowId")({
  validateSearch: (s: Record<string, unknown>): { run?: string } =>
    typeof s["run"] === "string" ? { run: s["run"] } : {},
  head: () => ({ meta: [{ title: "Workflow — ATSIQ" }] }),
  component: WorkflowAppPage,
});

/** The workflow app on its own page; the hiring desk shows the same app inline. */
function WorkflowAppPage() {
  const { workflowId } = Route.useParams();
  const { run } = Route.useSearch();
  return <WorkflowApp workflowId={workflowId} focus={run} />;
}
