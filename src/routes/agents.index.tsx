import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  Bot,
  Check,
  FlaskConical,
  Loader2,
  MessageSquareText,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AGENT_LABEL, ROLE_NAME } from "@/lib/agents.catalog";
import {
  agentSettings,
  agentSummary,
  askAgents,
  cancelAgentRun,
  compareAgentRun,
  decideAgentTask,
  exportAgentRun,
  getAgentRun,
  listAgentRuns,
  listAgentTasks,
  markAgentActionsSeen,
  myAgentActions,
  replayAgentRun,
  type AgentActionView,
  type AgentDecisionInput,
  type AgentRunView,
  type AgentTaskView,
} from "@/lib/agents.functions";

export const Route = createFileRoute("/agents/")({
  head: () => ({
    meta: [
      { title: "Agent decisions — ATSIQ" },
      {
        name: "description",
        content: "Requests from hiring agents that need a person: approvals, gates and questions.",
      },
    ],
  }),
  component: AgentsPage,
});

const KIND_META: Record<AgentTaskView["kind"], { label: string; icon: typeof Check }> = {
  gate: { label: "Needs your decision", icon: ShieldCheck },
  approval: { label: "Approve an action", icon: Bot },
  clarification: { label: "Question", icon: MessageSquareText },
};

function AgentsPage() {
  const tasks = useQuery({
    queryKey: ["agent_tasks"],
    queryFn: () => listAgentTasks(),
    refetchInterval: 15_000,
  });
  const runs = useQuery({
    queryKey: ["agent_runs"],
    queryFn: () => listAgentRuns(),
    refetchInterval: 15_000,
  });
  const open = tasks.data ?? [];
  const actions = useQuery({
    queryKey: ["agent_actions"],
    queryFn: () => myAgentActions(),
    refetchInterval: 30_000,
  });
  const unseen = (actions.data ?? []).filter((a) => !a.seen).length;

  return (
    <>
      <PageHeader
        eyebrow="Agents"
        title="Agent decisions"
        description="Hiring agents prepare the work and stop here whenever a person has to decide, approve an action, or answer a question. Nothing they ask for happens until you respond."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/agents/settings">Agent settings</Link>
          </Button>
        }
      />

      <AskAgents />

      <Tabs defaultValue="decisions" className="mt-4">
        <TabsList>
          <TabsTrigger value="decisions">
            Waiting for you{open.length ? ` (${open.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="acted">Acted for you{unseen ? ` (${unseen})` : ""}</TabsTrigger>
          <TabsTrigger value="activity">Agent activity</TabsTrigger>
        </TabsList>

        <TabsContent value="decisions" className="mt-4 space-y-3">
          {tasks.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : open.length ? (
            open.map((t) => <TaskCard key={t.id} task={t} />)
          ) : (
            <EmptyState
              title="Nothing is waiting for you"
              hint="When an agent needs an approval, a decision or an answer from you, it appears here and in your notifications."
            />
          )}
        </TabsContent>

        <TabsContent value="acted" className="mt-4 space-y-3">
          <ActedForYou actions={actions.data ?? []} loading={actions.isLoading} />
        </TabsContent>

        <TabsContent value="activity" className="mt-4 space-y-4">
          <SummaryTiles />
          <RunList runs={runs.data ?? []} loading={runs.isLoading} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function AskAgents() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["agent_settings"], queryFn: () => agentSettings() });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const copilot = settings.data?.agents.find((a) => a.type === "copilot");
  const ready = Boolean(copilot?.live && copilot.enabled && !settings.data?.allPaused);

  async function send() {
    setBusy(true);
    try {
      await askAgents({ data: { message } });
      setMessage("");
      toast.success("The copilot is on it — its plan will appear under Waiting for you.");
      qc.invalidateQueries({ queryKey: ["agent_runs"] });
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["agent_tasks"] });
        qc.invalidateQueries({ queryKey: ["agent_runs"] });
      }, 6000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the copilot");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel mt-4 p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <h2 className="font-semibold">Ask the agents</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Describe what you need, for example “Open 2 backend engineer roles for the Bengaluru
        platform team, 4–8 years, Go and Kubernetes.” The copilot plans it and asks you to confirm
        before any agent starts.
      </p>
      <Textarea
        className="mt-3"
        rows={3}
        placeholder="What do you need?"
        value={message}
        disabled={!ready || busy}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={!ready || busy || message.trim().length < 5} onClick={send}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send
        </Button>
        {!ready && settings.data ? (
          <p className="text-xs text-muted-foreground">
            {settings.data.allPaused
              ? "Agents are paused for this organisation."
              : "Switch on the Copilot (and the agents it should use) in"}{" "}
            {!settings.data.allPaused ? (
              <Link to="/agents/settings" className="underline">
                Agent settings
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function TaskCard({ task }: { task: AgentTaskView }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [args, setArgs] = useState(task.action?.argsJson ?? "");
  const meta = KIND_META[task.kind];
  const Icon = meta.icon;

  async function decide(decision: AgentDecisionInput) {
    setBusy(true);
    try {
      await decideAgentTask({ data: { taskId: task.id, decision } });
      toast.success(
        decision.status === "rejected" ? "Declined — the agent has been told" : "Sent to the agent",
      );
      qc.invalidateQueries({ queryKey: ["agent_tasks"] });
      qc.invalidateQueries({ queryKey: ["agent_runs"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the decision");
    } finally {
      setBusy(false);
    }
  }

  function approve() {
    if (task.action) {
      const edited = args.trim() !== task.action.argsJson.trim();
      let parsed: Record<string, unknown> | undefined;
      if (edited) {
        try {
          parsed = JSON.parse(args) as Record<string, unknown>;
        } catch {
          toast.error("The edited details are not valid JSON");
          return;
        }
      }
      void decide({
        status: "approved",
        ...(parsed ? { args: parsed } : {}),
        ...(note.trim() ? { comment: note.trim() } : {}),
      });
      return;
    }
    void decide({ status: "approved", ...(note.trim() ? { comment: note.trim() } : {}) });
  }

  return (
    <article className="panel p-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-4 text-primary" />
        <span className="font-medium text-foreground">{meta.label}</span>
        <span>·</span>
        <span>{AGENT_LABEL[task.agentType] ?? "Agent"}</span>
        {task.assigneeRole ? (
          <Badge variant="outline">For {ROLE_NAME[task.assigneeRole] ?? task.assigneeRole}</Badge>
        ) : null}
        <span className="ml-auto">{new Date(task.createdAt).toLocaleString()}</span>
      </div>
      <h3 className="mt-2 font-semibold">{task.title}</h3>
      {task.body ? (
        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{task.body}</p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">Goal: {task.goal}</p>

      {task.action ? (
        <div className="mt-3">
          <p className="text-xs font-medium">
            Action: <code>{task.action.name}</code> — review or edit the details before approving
          </p>
          <Textarea
            className="mt-1 font-mono text-xs"
            rows={Math.min(12, Math.max(3, args.split("\n").length))}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </div>
      ) : null}

      <Textarea
        className="mt-3"
        rows={2}
        placeholder={
          task.kind === "clarification" ? "Your answer" : "Optional note or reason for the agent"
        }
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        {task.kind === "clarification" ? (
          <Button
            size="sm"
            disabled={busy || !note.trim()}
            onClick={() => decide({ status: "answered", answer: note.trim() })}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Send
            answer
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={approve}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{" "}
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                decide({ status: "rejected", ...(note.trim() ? { reason: note.trim() } : {}) })
              }
            >
              <X className="size-4" /> Decline
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

const RUN_STATUS: Record<
  string,
  { label: string; tone: "default" | "outline" | "destructive" | "secondary" }
> = {
  queued: { label: "Queued", tone: "outline" },
  running: { label: "Working", tone: "secondary" },
  awaiting_human: { label: "Waiting for a person", tone: "secondary" },
  done: { label: "Done", tone: "default" },
  failed: { label: "Stopped", tone: "destructive" },
  cancelled: { label: "Cancelled", tone: "outline" },
};

function SummaryTiles() {
  const q = useQuery({ queryKey: ["agent_summary"], queryFn: () => agentSummary() });
  const d = q.data;
  if (!d) return null;
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");
  const tiles: { label: string; value: string; hint: string }[] = [
    {
      label: "Runs",
      value: d.runsStarted.toLocaleString(),
      hint: `${d.runsDone} done · ${d.runsFailed} stopped`,
    },
    { label: "Tokens used", value: d.tokens.toLocaleString(), hint: `${d.toolErrors} tool errors` },
    {
      label: "Decisions by people",
      value: d.decisions.toLocaleString(),
      hint: `${pct(d.approved, d.decisions)} approved · ${pct(d.rejected, d.decisions)} declined`,
    },
    {
      label: "Edited before approval",
      value: pct(d.edited, d.approved),
      hint: "How often people changed what an agent proposed",
    },
    {
      label: "Average wait for a person",
      value: d.avgWaitMinutes == null ? "—" : `${d.avgWaitMinutes} min`,
      hint: "From request to decision",
    },
  ];
  return (
    <section>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Last {d.days} days
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className="panel p-4">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className="num mt-1 text-xl font-semibold">{t.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t.hint}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

async function downloadTrail(runId: string) {
  try {
    const { fileName, json } = await exportAgentRun({ data: { runId } });
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Could not export the trail");
  }
}

function RunSteps({ runId }: { runId: string }) {
  const q = useQuery({
    queryKey: ["agent_run", runId],
    queryFn: () => getAgentRun({ data: { runId } }),
  });
  if (q.isLoading) return <p className="mt-2 text-xs text-muted-foreground">Loading steps…</p>;
  if (!q.data) return null;
  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="num text-[11px] text-muted-foreground">Trace {q.data.traceId}</p>
        <Button size="sm" variant="outline" onClick={() => downloadTrail(runId)}>
          Export trail (JSON)
        </Button>
      </div>
      {!q.data.steps.length ? (
        <p className="text-xs text-muted-foreground">No steps recorded yet.</p>
      ) : null}
      <ol className="space-y-1.5">
        {q.data.steps.map((s) => (
          <li key={s.seq} className="text-xs">
            <span className="num text-muted-foreground">#{s.seq}</span>{" "}
            <span className="font-medium">{s.kind}</span>
            {s.tool ? (
              <>
                {" "}
                · <code>{s.tool}</code>
              </>
            ) : null}{" "}
            ·{" "}
            <span className={s.status === "error" ? "text-destructive" : "text-muted-foreground"}>
              {s.status}
            </span>
            <span className="num text-muted-foreground">
              {s.tokens ? ` · ${s.tokens.toLocaleString()} tokens` : ""}
              {s.durationMs ? ` · ${s.durationMs} ms` : ""}
            </span>
            {s.detail ? (
              <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                {s.detail}
              </pre>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function RunList({ runs, loading }: { runs: AgentRunView[]; loading: boolean }) {
  const qc = useQueryClient();
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [compare, setCompare] = useState<string | null>(null);
  const settings = useQuery({ queryKey: ["agent_settings"], queryFn: () => agentSettings() });
  const canReplay = settings.data?.canEdit ?? false;
  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!runs.length) {
    return (
      <EmptyState
        title="No agent runs yet"
        hint="Agents start working from Phase 1 of the rollout. Their runs, results and the decisions that unblocked them will be listed here."
      />
    );
  }
  async function stop(runId: string) {
    try {
      await cancelAgentRun({ data: { runId } });
      toast.success("Run stopped");
      qc.invalidateQueries({ queryKey: ["agent_runs"] });
      qc.invalidateQueries({ queryKey: ["agent_tasks"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not stop the run");
    }
  }
  async function replay(runId: string) {
    try {
      await replayAgentRun({ data: { runId } });
      toast.success("Dry-run replay queued — it appears at the top of this list");
      qc.invalidateQueries({ queryKey: ["agent_runs"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the replay");
    }
  }
  return (
    <div className="panel divide-y divide-border">
      {runs.map((r) => {
        const s = RUN_STATUS[r.status] ?? { label: r.status, tone: "outline" as const };
        const active =
          r.status === "queued" || r.status === "running" || r.status === "awaiting_human";
        return (
          <div key={r.id} className="flex flex-wrap items-start gap-3 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{AGENT_LABEL[r.agentType] ?? "Agent"}</span>
                <Badge variant={s.tone}>{s.label}</Badge>
                {r.mode === "replay" ? (
                  <Badge variant="outline" className="gap-1">
                    <FlaskConical className="size-3" /> Dry-run replay
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{r.goal}</p>
              {r.result ? <p className="mt-1 text-sm">{r.result}</p> : null}
              {r.error ? <p className="mt-1 text-xs text-destructive">{r.error}</p> : null}
              <p className="num mt-1 text-xs text-muted-foreground">
                {new Date(r.createdAt).toLocaleString()} · {r.steps} step(s) ·{" "}
                {r.tokens.toLocaleString()} tokens
              </p>
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
              >
                {openRun === r.id ? "Hide steps" : "Steps"}
              </Button>
              {r.mode === "replay" && !active ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCompare(compare === r.id ? null : r.id)}
                >
                  {compare === r.id ? "Hide comparison" : "Compare"}
                </Button>
              ) : null}
              {r.mode === "live" && !active && canReplay ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Replay as a dry run (changes and messages are simulated)"
                  onClick={() => replay(r.id)}
                >
                  Replay
                </Button>
              ) : null}
              {active ? (
                <Button size="sm" variant="ghost" onClick={() => stop(r.id)}>
                  Stop
                </Button>
              ) : null}
            </div>
            {openRun === r.id ? (
              <div className="w-full">
                <RunSteps runId={r.id} />
              </div>
            ) : null}
            {compare === r.id ? (
              <div className="w-full">
                <RunCompare runId={r.id} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A dry-run replay next to the live run it re-executed. */
function RunCompare({ runId }: { runId: string }) {
  const q = useQuery({
    queryKey: ["agent_run_compare", runId],
    queryFn: () => compareAgentRun({ data: { runId } }),
  });
  if (q.isLoading) return <p className="mt-2 text-xs text-muted-foreground">Comparing…</p>;
  if (q.error) return <p className="mt-2 text-xs text-destructive">{(q.error as Error).message}</p>;
  const c = q.data;
  if (!c) return null;
  const side = (label: string, x: typeof c.original) => (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs font-medium">{label}</p>
      <p className="num mt-1 text-xs text-muted-foreground">
        {x.status} · {x.definitionVersion ? `v${x.definitionVersion}` : "version not recorded"} ·{" "}
        {x.steps} step(s) · {x.tokens.toLocaleString()} tokens
        {x.durationMs != null ? ` · ${Math.round(x.durationMs / 1000)} s` : ""}
      </p>
      {x.result ? <p className="mt-1 text-xs">{x.result}</p> : null}
    </div>
  );
  const OP = {
    same: { sign: "=", cls: "text-muted-foreground" },
    removed: { sign: "−", cls: "text-destructive" },
    added: { sign: "+", cls: "text-primary" },
  } as const;
  return (
    <div className="mt-3 space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">
        {c.sameSequence
          ? "The replay called the same tools in the same order."
          : "The replay took a different path — see the tool sequence below."}{" "}
        {c.definitionChanged
          ? "The agent's definition changed since the original run."
          : "Same agent definition as the original run."}{" "}
        Changes, messages and human steps in a replay are simulated.
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        {side("Original run", c.original)}
        {side("Dry-run replay", c.replay)}
      </div>
      <ol className="space-y-0.5 font-mono text-xs">
        {c.diff.map((d, i) => (
          <li key={i} className={OP[d.op].cls}>
            {OP[d.op].sign} {d.tool}
            <span className="text-muted-foreground">
              {d.op === "same" ? ` (${d.was} → ${d.now})` : ` (${d.was ?? d.now})`}
            </span>
          </li>
        ))}
        {!c.diff.length ? (
          <li className="text-muted-foreground">No tool calls in either run.</li>
        ) : null}
      </ol>
    </div>
  );
}

/** "Act and notify": what agents changed on the signed-in person's behalf. */
function ActedForYou({ actions, loading }: { actions: AgentActionView[]; loading: boolean }) {
  const qc = useQueryClient();
  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!actions.length)
    return (
      <EmptyState
        title="No actions reported"
        hint="Agents set to “Act and notify” list the changes they made for you here (last 14 days)."
      />
    );
  async function markSeen() {
    try {
      await markAgentActionsSeen();
      qc.invalidateQueries({ queryKey: ["agent_actions"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update");
    }
  }
  const unseen = actions.some((a) => !a.seen);
  return (
    <div className="panel">
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <p className="text-sm text-muted-foreground">
          Changes agents made on your behalf without asking first, because their autonomy is set to
          “Act and notify”.
        </p>
        <Button size="sm" variant="outline" disabled={!unseen} onClick={markSeen}>
          Mark all seen
        </Button>
      </div>
      <ul className="divide-y divide-border">
        {actions.map((a) => (
          <li key={a.stepId} className="flex flex-wrap items-start gap-2 p-4 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{AGENT_LABEL[a.agentType] ?? "Agent"}</span>
                <code className="text-xs">{a.tool}</code>
                {!a.seen ? <Badge>New</Badge> : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{a.goal}</p>
            </div>
            <span className="num text-xs text-muted-foreground">
              {new Date(a.at).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
