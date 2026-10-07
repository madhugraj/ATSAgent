import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import {
  Bot,
  CheckCircle2,
  Circle,
  CircleDot,
  Loader2,
  MessageSquarePlus,
  RotateCcw,
  Send,
  Sparkles,
  UserRound,
} from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { AGENT_LABEL } from "@/lib/agents.catalog";
import { decideAgentTask, type AgentDecisionInput } from "@/lib/agents.functions";
import {
  chooseDeskRole,
  getDeskConversation,
  listDeskConversations,
  retryDeskRun,
  screenDeskCandidates,
  sendDeskMessage,
  startDeskConversation,
  type DeskCardView,
  type DeskConversationView,
  type DeskMessageView,
} from "@/lib/hiring-desk.functions";

export const Route = createFileRoute("/desk")({
  validateSearch: z.object({ c: z.string().optional() }),
  head: () => ({
    meta: [
      { title: "Hiring desk — ATSIQ" },
      {
        name: "description",
        content:
          "Describe who you need in plain words; the hiring agents gather the details, find candidates and line up screening.",
      },
    ],
  }),
  component: DeskPage,
});

const EXAMPLES = [
  "I need a Full stack developer in Chennai",
  "Two senior Java engineers for Bengaluru, 6–9 years",
  "A data analyst in Pune, SQL and Power BI, immediate joiner",
];

function DeskPage() {
  const { c } = Route.useSearch();
  const navigate = useNavigate({ from: "/desk" });
  const list = useQuery({
    queryKey: ["desk_list"],
    queryFn: () => listDeskConversations(),
    refetchInterval: 15_000,
  });
  const select = (id: string | undefined) => navigate({ search: id ? { c: id } : {} });

  return (
    <>
      <PageHeader
        eyebrow="Agents"
        title="Hiring desk"
        description="Tell the desk who you need. It asks what it needs to know, checks for similar roles, gets the job description approved, ranks the best candidates and lines up screening — you decide at each checkpoint."
        actions={
          <Button size="sm" variant="outline" onClick={() => select(undefined)}>
            <MessageSquarePlus className="size-4" /> New hiring need
          </Button>
        }
      />
      <div className="mt-4 grid gap-4 lg:grid-cols-[280px_1fr]">
        <aside className="panel h-fit max-h-[70vh] overflow-y-auto p-2">
          {list.isLoading ? (
            <p className="p-3 text-sm text-muted-foreground">Loading…</p>
          ) : !list.data?.length ? (
            <p className="p-3 text-sm text-muted-foreground">No conversations yet.</p>
          ) : (
            <ul className="space-y-1">
              {list.data.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => select(t.id)}
                    className={`w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted ${c === t.id ? "bg-muted" : ""}`}
                  >
                    <p className="truncate font-medium">{t.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {t.requisitionCode ?? STATUS_LABEL[t.status] ?? t.status} ·{" "}
                      {new Date(t.updatedAt).toLocaleDateString()}
                      {t.mine ? "" : " · team"}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        {c ? <Thread id={c} /> : <NewThread onStarted={(id) => select(id)} />}
      </div>
    </>
  );
}

const STATUS_LABEL: Record<string, string> = {
  gathering: "Gathering details",
  confirming: "Choose the role",
  active: "In progress",
  closed: "Closed",
};

/* ---------------------------------------------------------------- new */

function NewThread({ onStarted }: { onStarted: (id: string) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function start(message: string) {
    if (message.trim().length < 2) return;
    setBusy(true);
    try {
      const { id } = await startDeskConversation({ data: { message: message.trim() } });
      qc.invalidateQueries({ queryKey: ["desk_list"] });
      onStarted(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the conversation");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel flex flex-col items-center justify-center gap-4 p-8 text-center">
      <Sparkles className="size-8 text-primary" aria-hidden />
      <div>
        <h2 className="text-lg font-semibold">Who do you need?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe the role in your own words — the desk will ask for anything it still needs.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {EXAMPLES.map((e) => (
          <Button key={e} size="sm" variant="outline" disabled={busy} onClick={() => start(e)}>
            {e}
          </Button>
        ))}
      </div>
      <Composer value={text} onChange={setText} busy={busy} onSend={() => start(text)} />
    </section>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  busy,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex w-full items-end gap-2">
      <Textarea
        value={value}
        disabled={busy || disabled}
        placeholder={disabled ? "This conversation is closed." : "Type a message…"}
        className="min-h-12 flex-1 resize-none"
        rows={2}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <Button onClick={onSend} disabled={busy || disabled || value.trim().length < 2}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        Send
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------- thread */

function Thread({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["desk", id],
    queryFn: () => getDeskConversation({ data: { id } }),
    refetchInterval: 4_000,
  });
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const count = q.data?.messages.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count, pending]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["desk", id] });
    qc.invalidateQueries({ queryKey: ["desk_list"] });
  };

  async function send() {
    const message = text.trim();
    if (message.length < 2) return;
    setPending(message);
    setText("");
    try {
      await sendDeskMessage({ data: { id, message } });
      refresh();
    } catch (e) {
      setText(message);
      toast.error(e instanceof Error ? e.message : "Could not send");
    } finally {
      setPending(null);
    }
  }

  if (q.isLoading)
    return <section className="panel p-6 text-sm text-muted-foreground">Loading…</section>;
  if (!q.data)
    return (
      <section className="panel p-6 text-sm text-muted-foreground">
        {q.error instanceof Error ? q.error.message : "Not found."}
      </section>
    );
  const d = q.data;
  return (
    <section className="panel flex min-h-[70vh] flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="font-semibold">{d.title}</h2>
        <Badge variant="outline">{STATUS_LABEL[d.status] ?? d.status}</Badge>
        {d.requisition ? (
          <Link
            to="/requisitions/$id"
            params={{ id: d.requisition.id }}
            className="ml-auto text-xs text-primary underline"
          >
            {d.requisition.code} · {d.requisition.status.replace(/_/g, " ")}
          </Link>
        ) : null}
      </header>
      <ProgressPanel conv={d} onChanged={refresh} />
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {d.messages.map((m) => (
          <Message key={m.id} m={m} conv={d} onChanged={refresh} />
        ))}
        {pending ? (
          <>
            <Bubble role="user" body={pending} />
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> The desk is thinking…
            </p>
          </>
        ) : null}
        <div ref={bottom} />
      </div>
      <footer className="border-t border-border p-3">
        <Composer
          value={text}
          onChange={setText}
          onSend={send}
          busy={pending !== null}
          disabled={d.status === "closed"}
        />
      </footer>
    </section>
  );
}

function Bubble({
  role,
  body,
  who,
}: {
  role: DeskMessageView["role"];
  body: string;
  who?: string;
}) {
  const mine = role === "user";
  return (
    <div className={`flex gap-2 ${mine ? "justify-end" : ""}`}>
      {!mine ? (
        <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Bot className="size-4" aria-hidden />
        </span>
      ) : null}
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${mine ? "bg-primary text-primary-foreground" : "bg-muted"}`}
      >
        {who ? <p className="mb-0.5 text-[11px] font-medium opacity-70">{who}</p> : null}
        <p className="whitespace-pre-wrap">{body}</p>
      </div>
      {mine ? (
        <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
          <UserRound className="size-4" aria-hidden />
        </span>
      ) : null}
    </div>
  );
}

function Message({
  m,
  conv,
  onChanged,
}: {
  m: DeskMessageView;
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  const who =
    m.role === "agent"
      ? (AGENT_LABEL[m.agentType ?? ""] ?? "Agent")
      : m.role === "desk"
        ? "Hiring desk"
        : undefined;
  return (
    <div className="space-y-2">
      {m.body ? <Bubble role={m.role} body={m.body} {...(who ? { who } : {})} /> : null}
      {m.card ? (
        <div className="ml-9">
          <Card card={m.card} conv={conv} onChanged={onChanged} />
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- cards */

function Card({
  card,
  conv,
  onChanged,
}: {
  card: DeskCardView;
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  if (card.type === "similar_roles")
    return <SimilarRolesCard card={card} conv={conv} onChanged={onChanged} />;
  if (card.type === "ranked_candidates")
    return <RankedCard card={card} conv={conv} onChanged={onChanged} />;
  if (card.type === "task") return <TaskCard card={card} conv={conv} onChanged={onChanged} />;
  if (card.type === "run_failed")
    return <RetryButton conv={conv} runId={String(card["runId"])} onChanged={onChanged} />;
  if (card.type === "requisition")
    return (
      <Link
        to="/requisitions/$id"
        params={{ id: String(card["requisitionId"]) }}
        className="inline-block rounded-md border border-border px-3 py-2 text-sm text-primary hover:bg-muted"
      >
        Open {String(card["code"])}
      </Link>
    );
  return null;
}

type SimilarItem = {
  requisitionId: string;
  code: string;
  title: string;
  location: string;
  status: string;
  openings: number;
  jdApproved: boolean;
  usable: boolean;
};

function SimilarRolesCard({
  card,
  conv,
  onChanged,
}: {
  card: DeskCardView;
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const items = (card["items"] as unknown as SimilarItem[]) ?? [];
  const open = conv.status === "confirming";
  async function choose(
    choice:
      { kind: "existing"; requisitionId: string } | { kind: "new"; reuseJdFrom?: string | null },
  ) {
    setBusy(true);
    try {
      await chooseDeskRole({ data: { id: conv.id, choice } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not continue");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      {items.map((r) => (
        <div
          key={r.requisitionId}
          className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2 text-sm"
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {r.code} · {r.title}
            </p>
            <p className="text-xs text-muted-foreground">
              {r.location || "—"} · {r.openings} opening(s) · {r.status.replace(/_/g, " ")}
              {r.jdApproved ? " · JD approved" : ""}
            </p>
          </div>
          {open && r.usable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => choose({ kind: "existing", requisitionId: r.requisitionId })}
            >
              Use this role
            </Button>
          ) : null}
          {open && r.jdApproved ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => choose({ kind: "new", reuseJdFrom: r.requisitionId })}
            >
              New role, reuse this JD
            </Button>
          ) : null}
        </div>
      ))}
      {open ? (
        <Button size="sm" disabled={busy} onClick={() => choose({ kind: "new" })}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Create a new role
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">Role settled.</p>
      )}
    </div>
  );
}

type RankedItem = {
  rank: number;
  applicationId: string;
  name: string;
  score: number | null;
  recommendation: string | null;
  stage: string;
  experienceYears: number;
  location: string | null;
  matched: string[];
  missing: string[];
  risks: number;
};

function RankedCard({
  card,
  conv,
  onChanged,
}: {
  card: DeskCardView;
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  const items = (card["items"] as unknown as RankedItem[]) ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));
  async function screen(ids: string[]) {
    setBusy(true);
    try {
      const r = await screenDeskCandidates({ data: { id: conv.id, applicationIds: ids } });
      toast.success(`Screening ${r.screening} candidate(s)`);
      setPicked([]);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start screening");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="w-8 px-2 py-2" />
            <th className="px-2 py-2 font-medium">#</th>
            <th className="px-2 py-2 font-medium">Candidate</th>
            <th className="px-2 py-2 text-right font-medium">Score</th>
            <th className="px-2 py-2 font-medium">Fit</th>
            <th className="px-2 py-2 font-medium">Strengths / gaps</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.applicationId} className="border-b border-border/60 align-top last:border-0">
              <td className="px-2 py-2">
                <Checkbox
                  checked={picked.includes(r.applicationId)}
                  onCheckedChange={(v) => toggle(r.applicationId, Boolean(v))}
                  aria-label={`Select ${r.name}`}
                />
              </td>
              <td className="num px-2 py-2 text-muted-foreground">{r.rank}</td>
              <td className="px-2 py-2">
                <p className="font-medium">{r.name}</p>
                <p className="text-xs text-muted-foreground">
                  {r.experienceYears} yrs{r.location ? ` · ${r.location}` : ""} ·{" "}
                  {r.stage.replace(/_/g, " ")}
                </p>
              </td>
              <td className="num px-2 py-2 text-right font-semibold">{r.score ?? "—"}</td>
              <td className="px-2 py-2">
                {r.recommendation ? <Badge variant="outline">{r.recommendation}</Badge> : "—"}
                {r.risks ? (
                  <p className="mt-1 text-xs text-muted-foreground">{r.risks} risk flag(s)</p>
                ) : null}
              </td>
              <td className="px-2 py-2 text-xs">
                {r.matched.length ? <p>✓ {r.matched.join(", ")}</p> : null}
                {r.missing.length ? (
                  <p className="text-muted-foreground">✗ {r.missing.join(", ")}</p>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap gap-2 border-t border-border p-2">
        <Button size="sm" disabled={busy || !picked.length} onClick={() => screen(picked)}>
          Screen selected ({picked.length})
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !items.length}
          onClick={() => screen(items.slice(0, 5).map((i) => i.applicationId))}
        >
          Screen the top {Math.min(5, items.length)}
        </Button>
      </div>
    </div>
  );
}

const TASK_STATUS: Record<string, string> = {
  open: "Waiting for you",
  approved: "Approved",
  rejected: "Declined",
  answered: "Answered",
  cancelled: "Cancelled",
};

function TaskCard({
  card,
  conv,
  onChanged,
}: {
  card: DeskCardView;
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  const taskId = String(card["taskId"]);
  const kind = String(card["kind"]);
  const status = conv.tasks[taskId] ?? "open";
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  async function decide(decision: AgentDecisionInput) {
    setBusy(true);
    try {
      await decideAgentTask({ data: { taskId, decision } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the decision");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${status === "open" ? "border-primary/40" : "border-border bg-muted/30"}`}
    >
      {card["step"] ? (
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary">
          {String(card["step"])}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{String(card["title"])}</p>
        <Badge variant={status === "open" ? "default" : "outline"} className="ml-auto">
          {TASK_STATUS[status] ?? status}
        </Badge>
      </div>
      {card["body"] ? (
        // Decided cards and a brief repeated from the previous step stay collapsed.
        status !== "open" || card["repeated"] ? (
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">
              {card["repeated"] && status === "open"
                ? "Show brief (same as the previous step)"
                : "Show details"}
            </summary>
            <p className="mt-1 whitespace-pre-wrap">{String(card["body"])}</p>
          </details>
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
            {String(card["body"])}
          </p>
        )
      ) : null}
      {status === "open" ? (
        kind === "clarification" ? (
          <div className="mt-2 flex gap-2">
            <Textarea
              value={answer}
              rows={2}
              className="min-h-10 flex-1"
              placeholder="Your answer"
              onChange={(e) => setAnswer(e.target.value)}
            />
            <Button
              size="sm"
              disabled={busy || !answer.trim()}
              onClick={() => decide({ status: "answered", answer: answer.trim() })}
            >
              Answer
            </Button>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => decide({ status: "approved" })}>
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => decide({ status: "rejected" })}
            >
              Decline
            </Button>
            <Link to="/agents" className="self-center text-xs text-primary underline">
              Review or edit in Agent decisions
            </Link>
          </div>
        )
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ progress */

function RetryButton({
  conv,
  runId,
  onChanged,
  label = "Try again",
}: {
  conv: DeskConversationView;
  runId: string;
  onChanged: () => void;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    try {
      await retryDeskRun({ data: { id: conv.id, runId } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not try again");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={retry}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
      {label}
    </Button>
  );
}

/** Where the hire stands and what happens next — the answer to "what now?". */
function ProgressPanel({ conv, onChanged }: { conv: DeskConversationView; onChanged: () => void }) {
  const p = conv.progress;
  const n = p.next;
  const runState =
    n?.run?.status === "failed"
      ? "stopped"
      : n?.run && ["queued", "running"].includes(n.run.status)
        ? "working"
        : n?.run?.status === "awaiting_human"
          ? "waiting"
          : null;
  return (
    <div className="border-b border-border bg-muted/30 px-4 py-3">
      <ol
        className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs"
        aria-label="Hiring progress"
      >
        {p.stages.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1">
            {s.state === "done" ? (
              <CheckCircle2 className="size-3.5 text-primary" aria-label="done" />
            ) : s.state === "current" ? (
              <CircleDot className="size-3.5 text-primary" aria-label="current" />
            ) : (
              <Circle className="size-3.5 text-muted-foreground/50" aria-label="to do" />
            )}
            <span
              className={
                s.state === "current"
                  ? "font-semibold text-foreground"
                  : s.state === "done"
                    ? "text-foreground"
                    : "text-muted-foreground"
              }
            >
              {s.label}
            </span>
            {i < p.stages.length - 1 ? (
              <span className="px-1 text-muted-foreground/40">›</span>
            ) : null}
          </li>
        ))}
      </ol>
      {n ? (
        <div className="mt-2 flex flex-wrap items-start gap-2 rounded-md border border-border bg-card p-2.5 text-sm">
          <div className="min-w-0 flex-1">
            <p>
              <span className="font-medium">Next: </span>
              {n.text}
            </p>
            {n.agentName ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {n.agentName}:{" "}
                {n.agentEnabled === false ? (
                  <span className="font-medium text-destructive">switched off</span>
                ) : runState === "stopped" ? (
                  <span className="font-medium text-destructive">stopped</span>
                ) : runState === "working" ? (
                  "working on it"
                ) : runState === "waiting" ? (
                  "waiting for a person"
                ) : (
                  "on, starts automatically when this step is reached"
                )}
                {n.waitingForYou ? ` · ${n.waitingForYou} request(s) waiting for you below` : ""}
              </p>
            ) : null}
          </div>
          {n.agentEnabled === false ? (
            <Button asChild size="sm" variant="outline">
              <Link to="/agents/settings">Switch it on</Link>
            </Button>
          ) : runState === "stopped" && n.run ? (
            <RetryButton conv={conv} runId={n.run.id} onChanged={onChanged} />
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">All steps are done for this hire.</p>
      )}
    </div>
  );
}
