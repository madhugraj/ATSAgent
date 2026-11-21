import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Bot, Check, Loader2, MessageSquareText, ShieldCheck, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AGENT_LABEL, ROLE_NAME } from "@/lib/agents.catalog";
import {
  decideAgentTask,
  listWorkflowRunTasks,
  type AgentDecisionInput,
  type AgentTaskView,
} from "@/lib/agents.functions";
import { withStepUp } from "@/lib/step-up-client";

const KIND_META: Record<AgentTaskView["kind"], { label: string; icon: typeof Check }> = {
  gate: { label: "Needs your decision", icon: ShieldCheck },
  approval: { label: "Approve an action", icon: Bot },
  clarification: { label: "Question", icon: MessageSquareText },
};

/**
 * One open agent request — a question to answer, an action to approve, or a
 * gate to decide — decided through `decideAgentTask` (same rules and audit
 * wherever it is shown: Waiting for you, or inside a workflow run).
 */
export function AgentTaskCard({
  task,
  onDecided,
}: {
  task: AgentTaskView;
  onDecided?: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [args, setArgs] = useState(task.action?.argsJson ?? "");
  const meta = KIND_META[task.kind];
  const Icon = meta.icon;

  async function decide(decision: AgentDecisionInput) {
    setBusy(true);
    try {
      const res = await withStepUp(() => decideAgentTask({ data: { taskId: task.id, decision } }));
      if (res.noLongerRelevant) toast.info(res.noLongerRelevant);
      else
        toast.success(
          decision.status === "rejected"
            ? "Declined — the agent has been told"
            : "Sent to the agent",
        );
      qc.invalidateQueries({ queryKey: ["agent_tasks"] });
      qc.invalidateQueries({ queryKey: ["agent_runs"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
      onDecided?.();
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

      {task.action ? (
        // The title says what the agent will do in plain words; the exact
        // details stay one click away for anyone who wants to check or edit them.
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium">
            Review or edit the details before approving
          </summary>
          <Textarea
            className="mt-1 font-mono text-xs"
            rows={Math.min(12, Math.max(3, args.split("\n").length))}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </details>
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
              {task.subjectType === "panel_review" ? "Approve — go with the panel" : "Approve"}
            </Button>
            {task.subjectType === "org_profile" ? (
              // A profile version is usually sent back with what to change.
              <Button
                size="sm"
                variant="outline"
                disabled={busy || note.trim().length < 3}
                title="Write what should change in the note first"
                onClick={() => decide({ status: "rejected", reason: note.trim(), changes: true })}
              >
                Send back for changes
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || (task.subjectType === "panel_review" && note.trim().length < 3)}
              title={
                task.subjectType === "panel_review"
                  ? "Puts the candidate on hold — write why in the note first"
                  : undefined
              }
              onClick={() =>
                decide({ status: "rejected", ...(note.trim() ? { reason: note.trim() } : {}) })
              }
            >
              <X className="size-4" />{" "}
              {task.subjectType === "panel_review"
                ? "Decline — put on hold"
                : task.subjectType === "requisition"
                  ? "Decline — closes the requisition"
                  : "Decline"}
            </Button>
            {task.subjectType === "panel_review" ? (
              // A panel review may end with rejecting the candidate: the HR head's decision, with a reason.
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || note.trim().length < 3}
                title="Rejects the candidate for this role — write why in the note first"
                onClick={() =>
                  decide({ status: "rejected", reason: note.trim(), rejectCandidate: true })
                }
              >
                Reject candidate
              </Button>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

/**
 * A workflow run's open requests, decided right where the run is shown —
 * not in the whole Waiting for you inbox.
 */
export function WorkflowRunRequests({
  workflowRunId,
  onDecided,
}: {
  workflowRunId: string;
  onDecided?: () => void;
}) {
  const q = useQuery({
    queryKey: ["workflow_run_tasks", workflowRunId],
    queryFn: () => listWorkflowRunTasks({ data: { workflowRunId } }),
    refetchInterval: 15_000,
  });
  const qc = useQueryClient();
  if (!q.data?.length) return null;
  return (
    <div className="space-y-2">
      {q.data.map((t) => (
        <AgentTaskCard
          key={t.id}
          task={t}
          onDecided={() => {
            void qc.invalidateQueries({ queryKey: ["workflow_run_tasks", workflowRunId] });
            onDecided?.();
          }}
        />
      ))}
    </div>
  );
}
