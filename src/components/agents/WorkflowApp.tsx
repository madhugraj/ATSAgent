import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CircleX, Copy, KeyRound, Play, Trash2 } from "lucide-react";

import { PageHeader } from "@/components/ats";
import { WorkflowRunRequests } from "@/components/agents/AgentTaskCard";
import { RunFlow } from "@/components/agents/RunFlow";
import { StoppedStepActions } from "@/components/agents/StoppedStepActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  issueWorkflowKey,
  listWorkflowKeys,
  orgWorkflowApp,
  revokeWorkflowKey,
  startOrgWorkflowRun,
  type AppRun,
} from "@/lib/org-workflows.functions";

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const triggerText = (t: string) =>
  t === "manual" ? "Starts when you enter a hiring need" : `Starts on ${t.replace(/[._]/g, " ")}`;

/**
 * The workflow app: one granted workflow, on its own — start it, follow each
 * run as its flow, and answer its questions and approvals right here.
 */
export function WorkflowApp({ workflowId, focus }: { workflowId: string; focus?: string | undefined }) {
  const q = useQuery({
    queryKey: ["workflow_app", workflowId],
    queryFn: () => orgWorkflowApp({ data: { workflowId } }),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === "waiting" || r.status === "running")
        ? 10_000
        : false,
  });
  useEffect(() => {
    if (focus && q.data)
      document.getElementById(`run-${focus}`)?.scrollIntoView({ block: "start" });
  }, [focus, q.data]);

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data)
    return (
      <>
        <PageHeader title="Workflow" />
        <p className="mt-4 text-sm text-muted-foreground">
          {errorText(q.error, "This workflow is not available.")}
        </p>
      </>
    );
  const v = q.data;
  const manual = v.workflow.trigger === "manual";
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={v.orgName}
        title={v.workflow.name}
        description={v.workflow.description}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="secondary">v{v.workflow.version}</Badge>
            <Badge variant={v.ready ? "default" : "outline"}>
              {v.ready ? "Live" : "Not ready"}
            </Badge>
          </div>
        }
      />

      <p className="text-sm text-muted-foreground">{triggerText(v.workflow.trigger)}</p>

      {!v.ready ? (
        <section className="panel space-y-2 p-4">
          <ul className="space-y-1 text-sm">
            {v.items
              .filter((i) => !i.ok)
              .map((i) => (
                <li key={i.key} className="flex items-center gap-2">
                  <CircleX className="size-4 text-destructive" />
                  {i.label}
                  <span className="text-muted-foreground">· {i.detail}</span>
                </li>
              ))}
          </ul>
          <Button asChild size="sm" variant="outline">
            <Link to="/agents/settings" hash="workflows">
              Agent settings
            </Link>
          </Button>
        </section>
      ) : null}

      {manual && v.canStart && v.ready ? <StartRun workflowId={v.workflow.id} /> : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Runs</h2>
        {v.runs.length ? (
          v.runs.map((r) => (
            <RunCard
              key={r.id}
              run={r}
              fallbackGraph={v.workflow.graph}
              focused={r.id === focus}
              workflowId={v.workflow.id}
              canManage={v.canStart}
            />
          ))
        ) : (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        )}
      </section>

      {v.canManage ? <ApiKeys workflowId={v.workflow.id} manual={manual} /> : null}
    </div>
  );
}

function StartRun({ workflowId }: { workflowId: string }) {
  const qc = useQueryClient();
  const [need, setNeed] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      await startOrgWorkflowRun({ data: { workflowId, need } });
      toast.success("Started");
      setNeed("");
      await qc.invalidateQueries({ queryKey: ["workflow_app", workflowId] });
    } catch (e) {
      toast.error(errorText(e, "Could not start"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel space-y-2 p-4">
      <Textarea
        rows={3}
        placeholder="Hiring need, e.g. We need two AI engineers in Chennai, hybrid, by March"
        value={need}
        maxLength={4000}
        onChange={(e) => setNeed(e.target.value)}
      />
      <Button size="sm" disabled={busy || need.trim().length < 5} onClick={start}>
        <Play className="size-4" /> Start
      </Button>
    </section>
  );
}

/** The end a finished run reached, by its name ("Workflow completed", "Stopped early"). */
function endLabel(run: AppRun, label: (id: string) => string): string | null {
  const last = run.history.at(-1);
  return last && last.note === "Ended." ? label(last.node) : null;
}

function RunCard({
  run,
  fallbackGraph,
  focused,
  workflowId,
  canManage,
}: {
  run: AppRun;
  canManage: boolean;
  fallbackGraph: AppRun["graph"] & object;
  focused: boolean;
  workflowId: string;
}) {
  const qc = useQueryClient();
  const graph = run.graph ?? fallbackGraph;
  const label = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n ? n.data.label || n.data.agentType || n.kind : id;
  };
  return (
    <article
      id={`run-${run.id}`}
      className={`panel space-y-2 p-4 ${focused ? "ring-2 ring-primary/40" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            run.status === "failed"
              ? "destructive"
              : run.status === "done"
                ? "default"
                : "secondary"
          }
        >
          {run.status === "done" ? (endLabel(run, label) ?? "done") : run.status}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {new Date(run.createdAt).toLocaleString()}
        </span>
        {run.need ? <span className="truncate text-sm">{run.need}</span> : null}
      </div>
      {run.waitingOn ? (
        <div
          className={`text-xs font-medium ${run.waitingOn.kind === "person" || run.waitingOn.kind === "stopped" ? "text-amber-700" : ""}`}
        >
          {run.waitingOn.text}
        </div>
      ) : null}
      <RunFlow run={run} graph={graph} label={label} />
      {run.error ? <div className="text-xs text-destructive">{run.error}</div> : null}
      {run.waitingOn?.kind === "stopped" && canManage ? (
        <StoppedStepActions workflowRunId={run.id} invalidate={["workflow_app", workflowId]} />
      ) : null}
      {run.waitingOn?.kind === "person" ? (
        <WorkflowRunRequests
          workflowRunId={run.id}
          onDecided={() => void qc.invalidateQueries({ queryKey: ["workflow_app", workflowId] })}
        />
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">History</summary>
        <ol className="mt-1 space-y-0.5">
          {run.history.map((h, i) => (
            <li key={i}>
              {new Date(h.at).toLocaleTimeString()} · {label(h.node)}: {h.note}
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}

function ApiKeys({ workflowId, manual }: { workflowId: string; manual: boolean }) {
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: ["workflow_keys", workflowId],
    queryFn: () => listWorkflowKeys({ data: { workflowId } }),
  });
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const refresh = () => qc.invalidateQueries({ queryKey: ["workflow_keys", workflowId] });
  const issue = async () => {
    setBusy(true);
    try {
      const r = await issueWorkflowKey({ data: { workflowId, label } });
      setShown(r.key);
      setLabel("");
      await refresh();
    } catch (e) {
      toast.error(errorText(e, "Could not issue a key"));
    } finally {
      setBusy(false);
    }
  };
  const example = manual
    ? `curl -X POST ${origin}/api/workflows/${workflowId}/runs \\\n  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \\\n  -d '{"need": "Two AI engineers in Chennai, hybrid"}'`
    : `curl ${origin}/api/workflows/${workflowId}/runs -H "Authorization: Bearer <key>"`;
  const status = `curl ${origin}/api/workflows/runs/<runId> -H "Authorization: Bearer <key>"`;
  return (
    <section className="panel space-y-3 p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <KeyRound className="size-4" /> API
      </h2>
      {shown ? (
        <div className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
          <div className="font-medium">Copy this key now — it is shown once.</div>
          <div className="flex items-center gap-2">
            <code className="break-all">{shown}</code>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Copy key"
              onClick={() =>
                void navigator.clipboard.writeText(shown).then(() => toast.success("Copied"))
              }
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
        </div>
      ) : null}
      <ul className="divide-y rounded-md border text-sm">
        {(keys.data ?? []).map((k) => (
          <li key={k.id} className="flex items-center gap-3 px-3 py-2">
            <code className="text-xs">{k.prefix}…</code>
            <span className="flex-1">{k.label || "—"}</span>
            <span className="text-xs text-muted-foreground">
              {k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleString()}` : "not used yet"}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-destructive"
              aria-label="Revoke key"
              onClick={async () => {
                try {
                  await revokeWorkflowKey({ data: { keyId: k.id } });
                  toast.success("Revoked");
                  await refresh();
                } catch (e) {
                  toast.error(errorText(e, "Could not revoke"));
                }
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </li>
        ))}
        {!keys.data?.length ? (
          <li className="px-3 py-2 text-xs text-muted-foreground">No keys.</li>
        ) : null}
      </ul>
      <div className="flex gap-2">
        <Input
          className="h-8 max-w-xs"
          placeholder="Label, e.g. HRMS"
          value={label}
          maxLength={80}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={issue}>
          Issue key
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{`${example}\n\n${status}`}</pre>
    </section>
  );
}
