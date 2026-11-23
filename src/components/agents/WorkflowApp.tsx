import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Circle,
  CircleDot,
  CircleX,
  Copy,
  KeyRound,
  Play,
  Trash2,
} from "lucide-react";

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
export function WorkflowApp({
  workflowId,
  focus,
  compact = false,
}: {
  workflowId: string;
  focus?: string | undefined;
  /** The hiring desk: live runs as a journey, past runs as one line each, no API keys. */
  compact?: boolean;
}) {
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
            {compact ? null : <Badge variant="secondary">v{v.workflow.version}</Badge>}
            <Badge variant={v.ready ? "default" : "outline"}>
              {v.ready ? "Live" : "Not ready"}
            </Badge>
          </div>
        }
      />

      {compact ? null : (
        <p className="text-sm text-muted-foreground">{triggerText(v.workflow.trigger)}</p>
      )}

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

      {compact ? (
        <DeskRuns
          runs={v.runs}
          fallbackGraph={v.workflow.graph}
          workflowId={v.workflow.id}
          canAct={v.canStart}
        />
      ) : (
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
      )}

      {v.canManage && !compact ? <ApiKeys workflowId={v.workflow.id} manual={manual} /> : null}
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

export type Graph = AppRun["graph"] & object;
const isLive = (r: AppRun) => r.status === "waiting" || r.status === "running";

/**
 * The steps a person cares about, in order: the agents and waits on the main
 * path (following "yes" at each check), plus any off-path step this run took.
 */
export function journeySteps(graph: Graph, run: AppRun): { id: string; label: string }[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const name = (id: string) => {
    const n = byId.get(id);
    return n ? n.data.label || n.data.agentType || n.kind : id;
  };
  const path: string[] = [];
  const seen = new Set<string>();
  let cur = graph.nodes.find((n) => n.kind === "trigger")?.id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    const out = graph.edges.filter((e) => e.source === cur);
    cur = (out.find((e) => e.branch === "yes") ?? out.find((e) => !e.branch) ?? out[0])?.target;
  }
  const visited = new Set(run.history.map((h) => h.node));
  if (run.currentNode) visited.add(run.currentNode);
  const off = [...visited].filter((id) => !seen.has(id));
  const keep = (id: string) => {
    const k = byId.get(id)?.kind;
    return k === "agent" || k === "wait";
  };
  return [...path, ...off].filter(keep).map((id) => ({ id, label: name(id) }));
}

function DeskRuns({
  runs,
  fallbackGraph,
  workflowId,
  canAct,
}: {
  runs: AppRun[];
  fallbackGraph: Graph;
  workflowId: string;
  canAct: boolean;
}) {
  const live = runs.filter(isLive);
  const past = runs.filter((r) => !isLive(r));
  const name = (r: AppRun, id: string) => {
    const n = (r.graph ?? fallbackGraph).nodes.find((x) => x.id === id);
    return n ? n.data.label || n.data.agentType || n.kind : id;
  };
  return (
    <div className="space-y-4">
      {live.map((r) => (
        <JourneyRun
          key={r.id}
          run={r}
          graph={r.graph ?? fallbackGraph}
          workflowId={workflowId}
          canAct={canAct}
        />
      ))}
      {past.length ? (
        <details className="panel p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Past runs <span className="num text-muted-foreground">{past.length}</span>
          </summary>
          <ul className="mt-2 divide-y text-sm">
            {past.map((r) => {
              const last = r.history.at(-1);
              const outcome =
                r.status === "failed"
                  ? "Failed"
                  : last?.note === "Ended."
                    ? name(r, last.node)
                    : "Done";
              return (
                <li key={r.id} className="flex items-center gap-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate">{r.need ?? "—"}</span>
                  <Badge variant={r.status === "failed" ? "destructive" : "secondary"}>
                    {outcome}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** One live run as the hiring journey: done, now (with what it needs), to come. */
function JourneyRun({
  run,
  graph,
  workflowId,
  canAct,
}: {
  run: AppRun;
  graph: Graph;
  workflowId: string;
  canAct: boolean;
}) {
  const qc = useQueryClient();
  const steps = journeySteps(graph, run);
  const done = new Set(
    run.history
      .filter((h) => h.note === "Agent done." || h.note.endsWith(" happened."))
      .map((h) => h.node),
  );
  const nowId =
    steps.find((s) => s.id === run.currentNode)?.id ?? steps.find((s) => !done.has(s.id))?.id;
  const nowIndex = steps.findIndex((s) => s.id === nowId);
  return (
    <article id={`run-${run.id}`} className="panel p-4">
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{run.need ?? "Run"}</p>
        <span className="num text-xs text-muted-foreground">
          Step {nowIndex + 1} of {steps.length}
        </span>
      </div>
      <ol className="mt-3" aria-label="Workflow progress">
        {steps.map((s, i) => {
          const last = i === steps.length - 1;
          const isNow = s.id === nowId;
          const isDone = done.has(s.id) && !isNow;
          return (
            <li key={s.id} className="relative flex gap-3 pb-3">
              {!last ? (
                <span
                  aria-hidden
                  className={`absolute left-[9px] top-6 bottom-0 w-px ${isDone ? "bg-primary/50" : "bg-border"}`}
                />
              ) : null}
              <span className="relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-card">
                {isDone ? (
                  <CheckCircle2 className="size-5 text-primary" aria-label="done" />
                ) : isNow ? (
                  <CircleDot className="size-5 text-primary" aria-label="current step" />
                ) : (
                  <Circle className="size-5 text-muted-foreground/40" aria-label="to come" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm ${isNow ? "font-semibold" : isDone ? "" : "text-muted-foreground"}`}
                >
                  <span className="num mr-1 text-xs text-muted-foreground">{i + 1}.</span>
                  {s.label}
                </p>
                {isNow && run.waitingOn ? (
                  <div
                    className={`mt-1.5 space-y-2 rounded-md border p-2.5 text-xs ${
                      run.waitingOn.kind === "person" || run.waitingOn.kind === "stopped"
                        ? "border-amber-500/50 bg-amber-500/10"
                        : "border-primary/30 bg-primary/5"
                    }`}
                  >
                    <p>{run.waitingOn.text}</p>
                    {run.waitingOn.kind === "stopped" && canAct ? (
                      <StoppedStepActions
                        workflowRunId={run.id}
                        invalidate={["workflow_app", workflowId]}
                      />
                    ) : null}
                    {run.waitingOn.kind === "person" ? (
                      <WorkflowRunRequests
                        workflowRunId={run.id}
                        onDecided={() =>
                          void qc.invalidateQueries({ queryKey: ["workflow_app", workflowId] })
                        }
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </article>
  );
}

/** The run's steps as the desk's hiring journey: done, now, to come (no actions). */
export type JourneySubstep = {
  label: string;
  state: "done" | "now" | "todo" | "back";
  note?: string;
};

export function WorkflowJourney({
  run,
  graph,
  onReview,
  substeps,
  needsYou,
}: {
  run: AppRun;
  graph: Graph;
  /** Shows the run's waiting request in the conversation. */
  onReview?: () => void;
  /** What is happening inside the current step (e.g. the approval chain). */
  substeps?: JourneySubstep[];
  /** Something in this run waits on the viewer (highlight + Review). */
  needsYou?: boolean;
}) {
  const steps = journeySteps(graph, run);
  const done = new Set(
    run.history
      .filter((h) => h.note === "Agent done." || h.note.endsWith(" happened."))
      .map((h) => h.node),
  );
  const live = isLive(run);
  const nowId = live
    ? (steps.find((s) => s.id === run.currentNode)?.id ?? steps.find((s) => !done.has(s.id))?.id)
    : undefined;
  return (
    <aside className="panel p-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-13rem)] xl:overflow-y-auto">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Workflow journey
      </h3>
      <ol className="mt-3" aria-label="Workflow progress">
        {steps.map((s, i) => {
          const last = i === steps.length - 1;
          const isNow = s.id === nowId;
          const isDone = done.has(s.id) && !isNow;
          return (
            <li key={s.id} className="relative flex gap-3 pb-3">
              {!last ? (
                <span
                  aria-hidden
                  className={`absolute left-[9px] top-6 bottom-0 w-px ${isDone ? "bg-primary/50" : "bg-border"}`}
                />
              ) : null}
              <span className="relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-card">
                {isDone ? (
                  <CheckCircle2 className="size-5 text-primary" aria-label="done" />
                ) : isNow ? (
                  <CircleDot className="size-5 text-primary" aria-label="current step" />
                ) : (
                  <Circle className="size-5 text-muted-foreground/40" aria-label="to come" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm ${isNow ? "font-semibold" : isDone ? "" : "text-muted-foreground"}`}
                >
                  <span className="num mr-1 text-xs text-muted-foreground">{i + 1}.</span>
                  {s.label}
                </p>
                {isNow && substeps?.length ? (
                  <ul className="mt-1.5 space-y-1 border-l border-border pl-3">
                    {substeps.map((x, j) => (
                      <li key={j} className="text-xs">
                        <span
                          className={
                            x.state === "done"
                              ? "text-foreground"
                              : x.state === "now"
                                ? "font-semibold text-foreground"
                                : x.state === "back"
                                  ? "text-amber-700"
                                  : "text-muted-foreground"
                          }
                        >
                          {x.state === "done"
                            ? "✓ "
                            : x.state === "now"
                              ? "● "
                              : x.state === "back"
                                ? "↩ "
                                : "○ "}
                          {x.label}
                        </span>
                        {x.note ? (
                          <span className="block pl-3 text-muted-foreground">{x.note}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {isNow && run.waitingOn ? (
                  <div
                    className={`mt-1.5 flex items-start gap-2 rounded-md border-l-[3px] p-2 text-xs ${
                      needsYou ||
                      run.waitingOn.kind === "person" ||
                      run.waitingOn.kind === "stopped"
                        ? "border-l-amber-500 bg-amber-500/10"
                        : "border-l-border bg-muted/40"
                    }`}
                  >
                    <p className="min-w-0 flex-1 text-foreground">{run.waitingOn.text}</p>
                    {(needsYou ||
                      run.waitingOn.kind === "person" ||
                      run.waitingOn.kind === "stopped") &&
                    onReview ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[0.6875rem]"
                        onClick={onReview}
                      >
                        Review
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
