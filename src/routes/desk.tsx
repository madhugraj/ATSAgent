import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
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
  acceptDeskProposal,
  raiseDeskAgentBudget,
  chooseDeskRole,
  closeDeskRole,
  getDeskConversation,
  listDeskConversations,
  publishDeskRole,
  researchDeskRole,
  retryDeskRun,
  scoreDeskCandidates,
  startDeskStage,
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
    if (!message.trim()) return;
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
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string | undefined;
}) {
  return (
    <div className="flex w-full items-end gap-2">
      <Textarea
        value={value}
        disabled={busy || disabled}
        placeholder={placeholder ?? "Type a message…"}
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
      <Button onClick={onSend} disabled={busy || disabled || !value.trim()}>
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
  const list = useRef<HTMLDivElement>(null);
  const count = q.data?.messages.length ?? 0;
  useEffect(() => {
    // Scroll the conversation itself, never the page.
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, pending]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["desk", id] });
    qc.invalidateQueries({ queryKey: ["desk_list"] });
  };

  async function send() {
    const message = text.trim();
    if (!message) return;
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
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      {/* The journey: first on small screens, a sticky column on wide ones. */}
      <div className="xl:order-2">
        <JourneyPanel conv={d} onChanged={refresh} />
      </div>
      {/* The conversation: fixed height, scrolls inside, composer always visible. */}
      <section className="panel flex h-[calc(100vh-13rem)] min-h-[460px] flex-col xl:order-1">
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
        <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
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
        </div>
        <footer className="border-t border-border p-3">
          <Composer
            value={text}
            onChange={setText}
            onSend={send}
            busy={pending !== null}
            placeholder={
              d.status === "closed" ? "This role is closed — you can still ask about it" : undefined
            }
          />
        </footer>
      </section>
    </div>
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
        <div className="whitespace-pre-wrap">{renderMarkdown(body)}</div>
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
        <div className="ml-9 space-y-2">
          <Card card={m.card} conv={conv} onChanged={onChanged} />
          {m.card.type !== "reasoning" && m.card["why"] ? (
            <Thinking why={m.card["why"] as Why} />
          ) : null}
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
  if (card.type === "reasoning")
    return <Thinking why={card as unknown as Why} conv={conv} onChanged={onChanged} />;
  if (card.type === "proposal")
    return <ProposalCard card={card} conv={conv} onChanged={onChanged} />;
  if (card.type === "close_role")
    return <CloseRoleCard card={card} conv={conv} onChanged={onChanged} />;
  if (card.type === "role_ended")
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/desk" search={{}}>
          Start a new hiring need
        </Link>
      </Button>
    );
  if (card.type === "bring_candidates")
    return <BringCandidatesCard conv={conv} onChanged={onChanged} />;
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
  const [openWhy, setOpenWhy] = useState<string | null>(null);
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
            <Fragment key={r.applicationId}>
              <tr className="border-b border-border/60 align-top">
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
                  {conv.reasoning[r.applicationId] ? (
                    <button
                      type="button"
                      className="mt-1 text-primary underline"
                      onClick={() =>
                        setOpenWhy(openWhy === r.applicationId ? null : r.applicationId)
                      }
                    >
                      {openWhy === r.applicationId ? "Hide reasoning" : "Why this score?"}
                    </button>
                  ) : null}
                </td>
              </tr>
              {openWhy === r.applicationId && conv.reasoning[r.applicationId] ? (
                <tr className="border-b border-border/60 bg-muted/30">
                  <td colSpan={6} className="px-3 py-3">
                    <Reasoning why={conv.reasoning[r.applicationId]!} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
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
  changes_requested: "Changes requested",
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
  const details =
    conv.taskDetails[taskId] ??
    (Array.isArray(card["details"]) ? (card["details"] as { label: string; value: string }[]) : []);
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
      {card["revision"] ? <RevisionNote revision={card["revision"] as Revision} /> : null}
      {details.length ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-muted/40 p-2 text-xs">
          {details.map((d) => (
            <div key={d.label} className="contents">
              <dt className="text-muted-foreground">{d.label}</dt>
              <dd className={d.label === "What it does" ? "" : "num font-medium"}>{d.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
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
      {status === "open" && conv.deciders[taskId]?.canDecide === false ? (
        <p className="mt-2 text-xs font-medium text-primary">
          Waiting for {conv.deciders[taskId]?.waitingFor} to decide.
        </p>
      ) : status === "open" ? (
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

/** The hiring journey, top to bottom: done, now (with what happens next), to come. */
function JourneyPanel({ conv, onChanged }: { conv: DeskConversationView; onChanged: () => void }) {
  const p = conv.progress;
  const n = p.next;
  const runState =
    n?.run?.status === "failed"
      ? "stopped"
      : n?.run?.paused
        ? "paused"
        : n?.run && ["queued", "running"].includes(n.run.status)
          ? "working"
          : n?.run?.status === "awaiting_human"
            ? "waiting"
            : n?.run?.status === "done"
              ? "finished"
              : null;
  return (
    <aside className="panel p-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-13rem)] xl:overflow-y-auto">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Hiring journey
      </h3>
      <ol className="mt-3" aria-label="Hiring progress">
        {p.stages.map((s, i) => {
          const last = i === p.stages.length - 1;
          const isNow = s.state === "current";
          return (
            <li key={s.key} className="relative flex gap-3 pb-3">
              {!last ? (
                <span
                  aria-hidden
                  className={`absolute left-[9px] top-6 bottom-0 w-px ${s.state === "done" ? "bg-primary/50" : "bg-border"}`}
                />
              ) : null}
              <span className="relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-card">
                {s.state === "done" ? (
                  <CheckCircle2 className="size-5 text-primary" aria-label="done" />
                ) : isNow ? (
                  <CircleDot className="size-5 text-primary" aria-label="current step" />
                ) : (
                  <Circle className="size-5 text-muted-foreground/40" aria-label="to come" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm ${isNow ? "font-semibold" : s.state === "done" ? "" : "text-muted-foreground"}`}
                >
                  <span className="num mr-1 text-xs text-muted-foreground">{i + 1}.</span>
                  {s.label}
                </p>
                {isNow && n ? (
                  <div className="mt-1.5 space-y-2 rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs">
                    <p className="text-foreground">
                      <span className="font-medium">Next: </span>
                      {n.text}
                    </p>
                    {n.agentName ? (
                      <p className="text-muted-foreground">
                        {n.agentName}:{" "}
                        {n.agentEnabled === false ? (
                          <span className="font-medium text-destructive">switched off</span>
                        ) : runState === "stopped" ? (
                          <span className="font-medium text-destructive">stopped</span>
                        ) : runState === "paused" ? (
                          <span className="font-medium text-destructive">
                            paused — it reached its monthly token budget
                          </span>
                        ) : runState === "working" ? (
                          "working on it"
                        ) : runState === "waiting" ? (
                          "waiting for a person"
                        ) : runState === "finished" ? (
                          "finished its last run"
                        ) : conv.canStart ? (
                          "on, not started yet"
                        ) : (
                          "on, starts automatically when this step is reached"
                        )}
                      </p>
                    ) : null}
                    {n.waitingForYou ? (
                      <p className="font-medium text-primary">
                        {n.waitingForYou} request(s) waiting for you in the conversation
                      </p>
                    ) : null}
                    {runState === "paused" && n.run?.budget ? (
                      <BudgetPaused conv={conv} budget={n.run.budget} onChanged={onChanged} />
                    ) : n.agentEnabled === false || runState === "paused" ? (
                      <Button asChild size="sm" variant="outline" className="h-7">
                        <Link to="/agents/settings">
                          {runState === "paused" ? "Raise the budget" : "Switch it on"}
                        </Link>
                      </Button>
                    ) : runState === "stopped" && n.run ? (
                      <RetryButton conv={conv} runId={n.run.id} onChanged={onChanged} />
                    ) : conv.canStart ? (
                      <StartButton
                        conv={conv}
                        onChanged={onChanged}
                        label={
                          runState === "finished"
                            ? n.stage === "candidates"
                              ? "Search again"
                              : "Run again"
                            : "Start now"
                        }
                      />
                    ) : null}
                    {conv.activity ? <ActivityList a={conv.activity} /> : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {p.ended ? (
        <div className="mt-1 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs">
          <p className="font-semibold text-destructive">
            This role was {p.ended.status}
            {p.ended.by ? ` by ${p.ended.by}` : ""}.
          </p>
          {p.ended.reason ? <p className="mt-0.5">Reason: {p.ended.reason}</p> : null}
          <p className="mt-1 text-muted-foreground">
            Agents have stopped. A {p.ended.status} role cannot be reopened.
          </p>
          <Button asChild size="sm" variant="outline" className="mt-2 h-7">
            <Link to="/desk" search={{}}>
              Start a new hiring need
            </Link>
          </Button>
        </div>
      ) : !n ? (
        <p className="text-sm text-muted-foreground">All steps are done for this hire.</p>
      ) : null}
    </aside>
  );
}

/** The agent at work: its latest steps, so a long run never looks like nothing is happening. */
function ActivityList({ a }: { a: NonNullable<DeskConversationView["activity"]> }) {
  const working = a.status === "running" || a.status === "queued";
  return (
    <div className="rounded-md border border-dashed border-border bg-card p-2 text-xs">
      <p className="mb-1 flex items-center gap-1.5 font-medium">
        {working ? <Loader2 className="size-3.5 animate-spin text-primary" /> : null}
        {a.agentName}
        {working
          ? " is working"
          : a.status === "awaiting_human"
            ? " is waiting for you"
            : a.status === "paused"
              ? " is paused at its monthly token budget"
              : ""}
      </p>
      <ol className="space-y-0.5">
        {a.steps.map((st, i) => (
          <li key={i} className="flex items-center gap-1.5 text-muted-foreground">
            {st.state === "done" ? (
              <CheckCircle2 className="size-3 text-primary" aria-label="done" />
            ) : st.state === "working" ? (
              <Loader2 className="size-3 animate-spin" aria-label="in progress" />
            ) : st.state === "waiting" ? (
              <CircleDot className="size-3 text-primary" aria-label="waiting for you" />
            ) : (
              <Circle className="size-3 text-destructive" aria-label="failed" />
            )}
            <span className={st.state === "working" ? "text-foreground" : ""}>
              {st.label}
              {st.state === "working" ? "…" : st.state === "waiting" ? " — waiting for you" : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StartButton({
  conv,
  onChanged,
  label = "Start now",
}: {
  conv: DeskConversationView;
  onChanged: () => void;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    try {
      await startDeskStage({ data: { id: conv.id } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size="sm" disabled={busy} onClick={start}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : null}
      {label}
    </Button>
  );
}

/**
 * Agents write a little markdown (**bold**, `code`). Render just those as
 * React nodes — never as HTML — so text stays escaped.
 */
function inlineMarkdown(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i} className="rounded bg-background/60 px-1 text-[0.9em]">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

/** Lines starting with #, ## or ### become bold lines; the rest gets inline markdown. */
function renderMarkdown(text: string): React.ReactNode[] {
  return text.split("\n").map((line, i, all) => {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const nl = i < all.length - 1 ? "\n" : "";
    return heading ? (
      <strong key={i} className="block">
        {inlineMarkdown(heading[1]!)}
      </strong>
    ) : (
      <span key={i}>
        {inlineMarkdown(line)}
        {nl}
      </span>
    );
  });
}

/* ------------------------------------------------------------ reasoning */

/** The AI's reasoning for one candidate: rationale, score per dimension, evidence, risks. */
function Reasoning({ why }: { why: DeskConversationView["reasoning"][string] }) {
  return (
    <div className="grid gap-3 text-xs md:grid-cols-[1fr_240px]">
      <div className="space-y-2">
        {why.rationale ? <p className="text-foreground">{why.rationale}</p> : null}
        {why.highlights.length ? (
          <div>
            <p className="font-medium">Evidence from the CV</p>
            <ul className="mt-0.5 list-disc pl-4 text-muted-foreground">
              {why.highlights.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {why.risks.length ? (
          <div>
            <p className="font-medium">Risk flags</p>
            <ul className="mt-0.5 list-disc pl-4 text-muted-foreground">
              {why.risks.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div>
        <p className="font-medium">
          Score breakdown{why.overall != null ? ` · overall ${why.overall}` : ""}
        </p>
        <ul className="mt-1 space-y-1">
          {why.breakdown.map((b) => (
            <li key={b.label}>
              <div className="flex justify-between">
                <span>
                  {b.label}
                  {b.weight != null ? (
                    <span className="text-muted-foreground"> · weight {b.weight}%</span>
                  ) : null}
                </span>
                <span className="num font-medium">{b.score}</span>
              </div>
              <div className="mt-0.5 h-1.5 rounded-full bg-muted">
                <div
                  className="h-1.5 rounded-full bg-primary"
                  style={{ width: `${Math.max(0, Math.min(100, b.score))}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* --------------------------------------------------- bring candidates in */

/** Too few candidates: upload CVs here, publish the role, or check the inbox. */
function BringCandidatesCard({
  conv,
  onChanged,
}: {
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<null | "upload" | "publish">(null);
  const [progress, setProgress] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const reqId = conv.requisition?.id ?? null;

  async function upload(files: File[]) {
    if (!files.length || !reqId) return;
    setBusy("upload");
    try {
      const { intakeCvs } = await import("@/lib/cv-intake");
      let done = 0;
      await intakeCvs({
        files,
        source: "hiring_desk",
        requisitionId: reqId,
        onUpdate: (_i, patch) => {
          if (patch.state === "ok" || patch.state === "error") done++;
          setProgress(`Reading CVs… ${done} of ${files.length}`);
        },
      });
      setProgress("Scoring against the job description…");
      const r = await scoreDeskCandidates({ data: { id: conv.id } });
      toast.success(`${r.scored} candidate(s) scored`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the CVs");
    } finally {
      setBusy(null);
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  }

  async function publish() {
    setBusy("publish");
    try {
      await publishDeskRole({ data: { id: conv.id } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not publish");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-primary/40 p-3 text-sm">
      <p className="font-medium">Bring candidates in</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-md border border-border p-2.5">
          <p className="font-medium">Upload CVs</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            PDF, Word or text. They are read, added to your talent pool and this role, then scored.
          </p>
          <input
            ref={input}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.txt"
            className="hidden"
            onChange={(e) => void upload([...(e.target.files ?? [])])}
          />
          <Button
            size="sm"
            className="mt-2"
            disabled={busy !== null || !reqId}
            onClick={() => input.current?.click()}
          >
            {busy === "upload" ? <Loader2 className="size-4 animate-spin" /> : null}
            Choose CVs
          </Button>
        </div>
        <div className="rounded-md border border-border p-2.5">
          <p className="font-medium">Publish the role</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Internal posting now; LinkedIn and job-board posts come back here for your approval.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={busy !== null}
            onClick={publish}
          >
            {busy === "publish" ? <Loader2 className="size-4 animate-spin" /> : null}
            Publish
          </Button>
        </div>
        <div className="rounded-md border border-border p-2.5">
          <p className="font-medium">Check other sources</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Applications by email land in the Careers inbox; the talent pool has everyone you know.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to="/inbox">Careers inbox</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/candidates">Talent pool</Link>
            </Button>
          </div>
        </div>
      </div>
      {progress ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> {progress}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ close role */

/** Close / reject / delete the role from the thread — as the person, with a reason. */
function CloseRoleCard({
  card,
  conv,
  onChanged,
}: {
  card: DeskCardView;
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  const action = String(card["action"]) as "close" | "reject" | "delete";
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const ended = Boolean(conv.progress.ended) || conv.status === "closed";
  const label = action === "delete" ? "Delete" : action === "reject" ? "Reject" : "Close";
  async function go() {
    setBusy(true);
    try {
      await closeDeskRole({ data: { id: conv.id, reason: reason.trim() } });
      toast.success(`${String(card["code"])}: done`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not complete this");
    } finally {
      setBusy(false);
    }
  }
  if (ended) return <p className="text-xs text-muted-foreground">Done — the role has ended.</p>;
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-destructive/40 p-3 text-sm">
      <label className="min-w-0 flex-1 text-xs">
        Reason (goes on the requisition's trail)
        <Textarea
          className="mt-1 min-h-10"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Position filled internally"
        />
      </label>
      <Button
        size="sm"
        variant="destructive"
        disabled={busy || reason.trim().length < 3}
        onClick={go}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {label} {String(card["code"])}
      </Button>
    </div>
  );
}

/* ------------------------------------------------- thinking & proposals */

type Why = { understood?: { label: string; value: string }[]; missing?: string[]; next?: string };

/** "How I read that": what the desk understood, what is missing, what it does next. */
function Thinking({
  why,
  conv,
  onChanged,
}: {
  why: Why;
  conv?: DeskConversationView;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const understood = why.understood ?? [];
  const missing = why.missing ?? [];
  const canResearch =
    conv?.status === "gathering" &&
    missing.some((m) => m === "must-have skills" || m === "experience");
  async function research() {
    if (!conv) return;
    setBusy(true);
    try {
      await researchDeskRole({
        data: {
          id: conv.id,
          fields: missing.includes("experience") ? ["skills", "experience"] : ["skills"],
        },
      });
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not research this");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="group rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs"
      open
    >
      <summary className="cursor-pointer select-none font-medium text-muted-foreground">
        How I read that
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Understood</dt>
        <dd>
          {understood.length
            ? understood.map((u) => `${u.label}: ${u.value}`).join(" · ")
            : "Nothing new in that message"}
        </dd>
        <dt className="text-muted-foreground">Still missing</dt>
        <dd>{missing.length ? missing.join(", ") : "Nothing — all required details are in"}</dd>
        {why.next ? (
          <>
            <dt className="text-muted-foreground">Next</dt>
            <dd>{why.next}</dd>
          </>
        ) : null}
      </dl>
      {canResearch ? (
        <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={research}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          Research it from the market
        </Button>
      ) : null}
    </details>
  );
}

type Proposal = {
  mustHaveSkills: string[];
  goodToHaveSkills: string[];
  experienceMin: number | null;
  experienceMax: number | null;
  budgetLpaMin: number | null;
  budgetLpaMax: number | null;
  reasoning: string;
  sources: { title: string; url: string }[];
};

function ProposalCard({
  card,
  conv,
  onChanged,
}: {
  card: DeskCardView;
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  const p = card["proposal"] as Proposal;
  const grounded = Boolean(card["grounded"]);
  const accepted = Boolean(card["accepted"]);
  const superseded = Boolean(card["superseded"]);
  const [busy, setBusy] = useState(false);
  async function accept() {
    setBusy(true);
    try {
      await acceptDeskProposal({ data: { id: conv.id } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not apply this");
    } finally {
      setBusy(false);
    }
  }
  const row = (label: string, value: string | null) =>
    value ? (
      <>
        <dt className="text-muted-foreground">{label}</dt>
        <dd>{value}</dd>
      </>
    ) : null;
  return (
    <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={grounded ? "default" : "secondary"}>
          {grounded ? "Live web research" : "Estimate — no live sources"}
        </Badge>
        {accepted ? <Badge variant="outline">Applied</Badge> : null}
        {superseded ? <Badge variant="outline">Replaced by your edits</Badge> : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {row("Must-have", p.mustHaveSkills.join(", ") || null)}
        {row("Good to have", p.goodToHaveSkills.join(", ") || null)}
        {row(
          "Experience",
          p.experienceMin != null ? `${p.experienceMin}–${p.experienceMax ?? "+"} years` : null,
        )}
        {row(
          "Budget",
          p.budgetLpaMax != null ? `${p.budgetLpaMin ?? "?"}–${p.budgetLpaMax} LPA` : null,
        )}
      </dl>
      {p.reasoning ? <p className="text-xs text-muted-foreground">{p.reasoning}</p> : null}
      {p.sources.length ? (
        <ul className="list-disc pl-5 text-xs">
          {p.sources.map((s) => (
            <li key={s.url}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-primary hover:underline"
              >
                {s.title || s.url}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {accepted || superseded ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={accept}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            Use these
          </Button>
          <span className="text-xs text-muted-foreground">
            …or reply with what to change (e.g. "drop Figma, add accessibility").
          </span>
        </div>
      )}
    </div>
  );
}

type Revision = { reason: string; changes: { label: string; from: string; to: string }[] };

/** On a re-proposed request: the person's change and what the agent actually changed. */
function RevisionNote({ revision }: { revision: Revision }) {
  return (
    <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
      <p className="font-medium">Revised after your change: &ldquo;{revision.reason}&rdquo;</p>
      {revision.changes.length ? (
        <ul className="mt-1 space-y-0.5">
          {revision.changes.map((c) => (
            <li key={c.label} className="num">
              {c.label}: <span className="text-muted-foreground line-through">{c.from}</span> →{" "}
              <span className="font-semibold">{c.to}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-destructive">
          Nothing in the proposal changed. Tell the desk what to change, or decline it.
        </p>
      )}
    </div>
  );
}

/** Paused on its monthly budget: how much was used, and what to do about it. */
function BudgetPaused({
  conv,
  budget,
  onChanged,
}: {
  conv: DeskConversationView;
  budget: { used: number; limit: number; suggested: number };
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function raise() {
    setBusy(true);
    try {
      const r = await raiseDeskAgentBudget({ data: { id: conv.id } });
      toast.success(
        `Budget raised to ${r.monthlyTokenBudget.toLocaleString()} tokens — continuing`,
      );
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not raise the budget");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1.5 text-xs">
      <p>
        Used {budget.used.toLocaleString()} of its {budget.limit.toLocaleString()} tokens this
        month. It continues on its own when the budget is raised, or on the 1st of next month.
      </p>
      {conv.canEditAgents ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="h-7" disabled={busy} onClick={raise}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Raise to {budget.suggested.toLocaleString()} and continue
          </Button>
          <Link to="/agents/settings" className="text-primary hover:underline">
            Set another amount
          </Link>
        </div>
      ) : (
        <p className="font-medium text-primary">
          Ask your HR head or CBO to raise it (Agent settings → monthly token budget).
        </p>
      )}
    </div>
  );
}
