/**
 * The chat with the Organisation context agent, embedded in the Organisation
 * profile page (tab "Chat with the agent"). One thread per organisation; the
 * server layer lives in src/server/desk/org-desk.server.ts and
 * src/lib/org-desk.functions.ts. Only the HR head, the CBO and the owner see
 * this tab.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Globe, RefreshCw, Send, Sparkles } from "lucide-react";

import {
  buildFromDesk,
  clearOrgDeskChat,
  getOrgDeskThread,
  readWebsiteFromDesk,
  retryOrgDeskRun,
  sendOrgDeskMessage,
  type OrgDeskMessageView,
} from "@/lib/org-desk.functions";
import { decideAgentTask } from "@/lib/agents.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const when = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const ACTIVE = new Set(["queued", "running", "awaiting_human"]);

export function OrgDeskChat({ onProfileChanged }: { onProfileChanged?: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["org_desk"],
    queryFn: () => getOrgDeskThread(),
    // While the agent is working (or waiting on a decision), keep the thread
    // and its activity strip live; poll gently otherwise.
    refetchInterval: (query) =>
      query.state.data && ACTIVE.has(query.state.data.activity?.status ?? "") ? 4000 : 15_000,
  });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const thread = q.data;
  const activity = thread?.activity ?? null;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [thread?.messages.length, activity?.status]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["org_desk"] });
    onProfileChanged?.();
  };

  async function send() {
    const text = draft.trim();
    if (!text || !thread) return;
    setBusy(true);
    setDraft("");
    try {
      await sendOrgDeskMessage({ data: { id: thread.id, message: text } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send");
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function decide(
    taskId: string,
    decision: "approve" | "send_back" | "decline",
    note?: string,
  ) {
    try {
      if (decision === "approve")
        await decideAgentTask({
          data: { taskId, decision: { status: "approved", comment: note } },
        });
      else
        await decideAgentTask({
          data: {
            taskId,
            decision: { status: "rejected", reason: note, changes: decision === "send_back" },
          },
        });
      toast.success(
        decision === "approve"
          ? "Approved — the version is now the organisation profile."
          : decision === "send_back"
            ? "Sent back for changes."
            : "Declined.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the decision");
    } finally {
      refresh();
    }
  }

  async function answer(taskId: string, text: string) {
    try {
      await decideAgentTask({ data: { taskId, decision: { status: "answered", answer: text } } });
      toast.success("Sent — the agent continues with your answer.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the answer");
    } finally {
      refresh();
    }
  }

  async function clearChat() {
    if (!thread) return;
    if (!window.confirm("Clear this chat? The agent's open work stops and a fresh thread starts."))
      return;
    setBusy(true);
    try {
      await clearOrgDeskChat({ data: { id: thread.id } });
      toast.success("Chat cleared.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not clear the chat");
    } finally {
      setBusy(false);
      refresh();
    }
  }

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Opening the chat…</p>;
  if (q.error || !thread)
    return <p className="text-sm text-destructive">Could not open the chat.</p>;

  return (
    <>
      <p className="mt-4 text-sm text-muted-foreground">
        Describe your organisation — what it does, its products and tech stacks, its projects, how
        it hires. What you settle here becomes the approved profile every hiring agent works from:
        the JD agent's “About us”, the requisition drafts, and candidate matching. The agent's
        requests and questions appear as cards in this thread, and a person always decides.
      </p>

      <div
        ref={scroller}
        className="panel mt-3 max-h-[52vh] space-y-3 overflow-y-auto p-4"
        aria-live="polite"
      >
        {thread.messages.map((m) => (
          <Message
            key={m.id}
            m={m}
            tasks={thread.tasks}
            deciders={thread.deciders}
            onDecide={decide}
            onAnswer={answer}
          />
        ))}
      </div>

      {activity ? (
        <ActivityStrip
          activity={activity}
          busy={busy}
          threadId={thread.id}
          onRetry={async () => {
            setBusy(true);
            try {
              await retryOrgDeskRun({ data: { id: thread.id, runId: activity.runId } });
              toast.success("Trying the agent again.");
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not try again");
            } finally {
              setBusy(false);
              refresh();
            }
          }}
        />
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          title="The agent fetches your saved website (own domain only) and proposes what it states as draft items, quoting each page"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await readWebsiteFromDesk({ data: { id: thread.id } });
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not start the read");
            } finally {
              setBusy(false);
              refresh();
            }
          }}
        >
          <Globe className="size-3.5" /> Read the website
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          title="The agent reads your records, the website and every uploaded document, proposes what it finds as draft items with exact quotes, then submits the draft for the HR head's approval"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await buildFromDesk({ data: { id: thread.id } });
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not start the build");
            } finally {
              setBusy(false);
              refresh();
            }
          }}
        >
          <Sparkles className="size-3.5" /> Build the draft
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-muted-foreground"
          title="Stop the agent's open work and start a fresh thread"
          disabled={busy}
          onClick={() => void clearChat()}
        >
          Clear chat
        </Button>
      </div>

      <div className="mt-2 flex gap-2">
        <Textarea
          rows={2}
          className="flex-1"
          placeholder="Describe the organisation… (Enter to send)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button disabled={busy || !draft.trim()} onClick={() => void send()} aria-label="Send">
          <Send className="size-4" />
        </Button>
      </div>
    </>
  );
}

function ActivityStrip({
  activity,
  busy,
  threadId,
  onRetry,
}: {
  activity: NonNullable<NonNullable<Awaited<ReturnType<typeof getOrgDeskThread>>>["activity"]>;
  busy: boolean;
  threadId: string;
  onRetry: () => void;
}) {
  const ago = Math.round((Date.now() - new Date(activity.updatedAt).getTime()) / 60000);
  const since = activity.lastStep
    ? Math.round((Date.now() - new Date(activity.lastStep.at).getTime()) / 60000)
    : null;
  if (activity.status === "running" || activity.status === "queued")
    return (
      <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <RefreshCw className="size-3 animate-spin" />
        {activity.status === "queued" ? "Starting…" : "Working"}
        {activity.lastStep ? ` — ${activity.lastStep.text}` : ""}
        {since !== null && since >= 1 ? ` (last step ${since} min ago)` : ""}. Its results and its
        approval request will appear in the thread.
      </p>
    );
  if (activity.status === "awaiting_human")
    return (
      <p className="px-1 text-xs text-amber-600">
        Waiting for you — the agent's request is in the thread above.
      </p>
    );
  if (activity.status === "failed")
    return (
      <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-destructive">
        <span>
          The agent stopped: {activity.error ?? "something went wrong"}
          {ago >= 1 ? ` (${ago} min ago)` : ""}
        </span>
        <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  return (
    <p className="px-1 text-xs text-muted-foreground">
      Last run {activity.status}
      {activity.result ? `: ${activity.result.slice(0, 160)}` : ""}
      {ago >= 1 ? ` · ${ago} min ago` : ""}
    </p>
  );
}

function Message({
  m,
  tasks,
  deciders,
  onDecide,
  onAnswer,
}: {
  m: OrgDeskMessageView;
  tasks: Record<string, string>;
  deciders: Record<string, { canDecide: boolean; waitingFor: string | null }>;
  onDecide: (taskId: string, decision: "approve" | "send_back" | "decline", note?: string) => void;
  onAnswer: (taskId: string, answer: string) => void;
}) {
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  const mine = m.role === "user";
  if (mine)
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
          {m.body}
        </div>
      </div>
    );
  const card = m.card;
  const taskId = card && typeof card["taskId"] === "string" ? card["taskId"] : null;
  const kind = card && typeof card["kind"] === "string" ? card["kind"] : null;
  return (
    <div className="max-w-[85%] space-y-1">
      <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
        <span>{m.agentType ? `${m.agentType.replace(/_/g, " ")} agent` : "Desk"}</span>
        <span>{when(m.at)}</span>
      </div>
      <div className="whitespace-pre-wrap rounded-lg border bg-background px-3 py-2 text-sm">
        {m.body}
      </div>
      {card?.type === "task" && taskId ? (
        kind === "clarification" ? (
          <QuestionCard
            taskId={taskId}
            title={typeof card["title"] === "string" ? card["title"] : "The agent has a question"}
            body={typeof card["body"] === "string" ? card["body"] : ""}
            status={tasks[taskId] ?? "open"}
            canAnswer={deciders[taskId]?.canDecide ?? false}
            waitingFor={deciders[taskId]?.waitingFor ?? null}
            answer={answer}
            setAnswer={setAnswer}
            onAnswer={onAnswer}
          />
        ) : (
          <GateCard
            taskId={taskId}
            title={typeof card["title"] === "string" ? card["title"] : "Approval request"}
            body={typeof card["body"] === "string" ? card["body"] : ""}
            status={tasks[taskId] ?? "open"}
            canDecide={deciders[taskId]?.canDecide ?? false}
            waitingFor={deciders[taskId]?.waitingFor ?? null}
            note={note}
            setNote={setNote}
            onDecide={onDecide}
          />
        )
      ) : null}
    </div>
  );
}

/** The agent paused to ask something: read it, answer it, the run carries on. */
function QuestionCard({
  taskId,
  title,
  body,
  status,
  canAnswer,
  waitingFor,
  answer,
  setAnswer,
  onAnswer,
}: {
  taskId: string;
  title: string;
  body: string;
  status: string;
  canAnswer: boolean;
  waitingFor: string | null;
  answer: string;
  setAnswer: (v: string) => void;
  onAnswer: (taskId: string, answer: string) => void;
}) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <p className="font-medium">{title}</p>
      <p className="mt-1 whitespace-pre-wrap text-xs">{body}</p>
      {status !== "open" ? (
        <Badge variant="outline" className="mt-2">
          Answered
        </Badge>
      ) : canAnswer ? (
        <div className="mt-2 flex gap-2">
          <Textarea
            rows={2}
            className="flex-1"
            maxLength={2000}
            value={answer}
            placeholder="Type your answer… (the agent continues with it)"
            onChange={(e) => setAnswer(e.target.value)}
          />
          <Button
            size="sm"
            disabled={answer.trim().length < 1}
            onClick={() => onAnswer(taskId, answer.trim())}
          >
            Reply
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Waiting for {waitingFor ?? "the HR head or an owner"}.
        </p>
      )}
    </div>
  );
}

function GateCard({
  taskId,
  title,
  body,
  status,
  canDecide,
  waitingFor,
  note,
  setNote,
  onDecide,
}: {
  taskId: string;
  title: string;
  body: string;
  status: string;
  canDecide: boolean;
  waitingFor: string | null;
  note: string;
  setNote: (v: string) => void;
  onDecide: (taskId: string, decision: "approve" | "send_back" | "decline", note?: string) => void;
}) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
      <p className="font-medium">{title}</p>
      <p className="mt-1 whitespace-pre-wrap text-xs">{body}</p>
      {status !== "open" ? (
        <Badge variant="outline" className="mt-2">
          {status === "approved" ? "Approved" : status === "rejected" ? "Decided" : status}
        </Badge>
      ) : canDecide ? (
        <div className="mt-2 space-y-2">
          <Textarea
            rows={2}
            maxLength={2000}
            value={note}
            placeholder="What should change, or why you decline (required for both); optional when approving"
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onDecide(taskId, "approve", note.trim() || undefined)}>
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={note.trim().length < 3}
              onClick={() => onDecide(taskId, "send_back", note.trim())}
            >
              Send back for changes
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={note.trim().length < 3}
              onClick={() => onDecide(taskId, "decline", note.trim())}
            >
              Decline
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Waiting for {waitingFor ?? "the HR head or an owner"}.
        </p>
      )}
    </div>
  );
}
