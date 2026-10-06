import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Bot, Check, Loader2, MessageSquareText, ShieldCheck, X } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AGENT_LABEL, ROLE_NAME } from "@/lib/agents.catalog";
import {
  cancelAgentRun,
  decideAgentTask,
  listAgentRuns,
  listAgentTasks,
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

      <Tabs defaultValue="decisions" className="mt-4">
        <TabsList>
          <TabsTrigger value="decisions">
            Waiting for you{open.length ? ` (${open.length})` : ""}
          </TabsTrigger>
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

        <TabsContent value="activity" className="mt-4">
          <RunList runs={runs.data ?? []} loading={runs.isLoading} />
        </TabsContent>
      </Tabs>
    </>
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

function RunList({ runs, loading }: { runs: AgentRunView[]; loading: boolean }) {
  const qc = useQueryClient();
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
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{r.goal}</p>
              {r.result ? <p className="mt-1 text-sm">{r.result}</p> : null}
              {r.error ? <p className="mt-1 text-xs text-destructive">{r.error}</p> : null}
              <p className="num mt-1 text-xs text-muted-foreground">
                {new Date(r.createdAt).toLocaleString()} · {r.steps} step(s) ·{" "}
                {r.tokens.toLocaleString()} tokens
              </p>
            </div>
            {active ? (
              <Button size="sm" variant="ghost" onClick={() => stop(r.id)}>
                Stop
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
