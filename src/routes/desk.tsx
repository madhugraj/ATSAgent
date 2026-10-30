import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { RECENT_MESSAGES, SCREENABLE, foldText, supersededMessages } from "@/lib/desk-view";
import { AgentMarkdown } from "@/components/AgentMarkdown";
import { ScreeningResultSummary, WhyThisScore } from "@/components/ScreeningRationale";
import { z } from "zod";
import {
  Bot,
  CheckCircle2,
  Circle,
  CircleDot,
  Columns2,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ats";
import { OrgProfileNotice } from "@/components/OrgProfileNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HiringManagerPicker } from "@/components/HiringManagerPicker";
import { InterviewPlanCard } from "@/components/InterviewPlanCard";
import { getPanelChoices } from "@/lib/panels.functions";
import { AGENT_LABEL } from "@/lib/agents.catalog";
import { decideAgentTask, type AgentDecisionInput } from "@/lib/agents.functions";
import {
  acceptDeskProposal,
  enableDeskAgent,
  raiseDeskAgentBudget,
  rescoreDeskCandidates,
  startDeskSourcing,
  startDeskDistribution,
  startDeskExpertInterview,
  chooseDeskRole,
  chooseHiringManagerOption,
  closeDeskRole,
  deleteDeskConversation,
  getDeskConversation,
  getDeskThreads,
  listDeletedDeskConversations,
  restoreDeskConversation,
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
  type DeskConversationSummary,
  type DeskConversationView,
  type DeskMessageView,
} from "@/lib/hiring-desk.functions";

export const Route = createFileRoute("/desk")({
  validateSearch: z.object({ c: z.string().optional(), split: z.string().optional() }),
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
  const { c, split } = Route.useSearch();
  const navigate = useNavigate({ from: "/desk" });
  const splitIds = (split ?? "")
    .split(",")
    .filter((s) => /^[-0-9a-f]{36}$/.test(s))
    .slice(0, 3);
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
      <div className="mt-4">
        <OrgProfileNotice />
      </div>
      {splitIds.length >= 2 ? (
        <SplitDesk ids={splitIds} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <aside className="panel h-fit max-h-[70vh] overflow-y-auto p-2">
            {list.isLoading ? (
              <p className="p-3 text-sm text-muted-foreground">Loading…</p>
            ) : !list.data?.length ? (
              <p className="p-3 text-sm text-muted-foreground">No conversations yet.</p>
            ) : (
              <ThreadList
                rows={list.data}
                current={c}
                onSelect={(id) => select(id)}
                onSideBySide={(ids) => void navigate({ search: { split: ids.join(",") } })}
              />
            )}
            <RecentlyDeleted onRestored={(id) => select(id)} />
          </aside>
          {c ? (
            <Thread id={c} onDeleted={() => select(undefined)} />
          ) : (
            <NewThread onStarted={(id) => select(id)} />
          )}
        </div>
      )}
    </>
  );
}

/**
 * The conversation list. The threads of one fan-out sit together under one
 * heading with a "Side by side" action — listed loose, a few splits made a
 * wall of near-identical titles with no way to tell which belonged together.
 */
function ThreadList({
  rows,
  current,
  onSelect,
  onSideBySide,
}: {
  rows: DeskConversationSummary[];
  current: string | undefined;
  onSelect: (id: string) => void;
  onSideBySide: (ids: string[]) => void;
}) {
  // Groups keep the position of their most recently updated thread.
  const blocks: { group: string | null; items: DeskConversationSummary[] }[] = [];
  const byGroup = new Map<string, DeskConversationSummary[]>();
  for (const r of rows) {
    if (!r.splitGroupId) {
      blocks.push({ group: null, items: [r] });
      continue;
    }
    const g = byGroup.get(r.splitGroupId);
    if (g) g.push(r);
    else {
      const items = [r];
      byGroup.set(r.splitGroupId, items);
      blocks.push({ group: r.splitGroupId, items });
    }
  }
  const row = (t: DeskConversationSummary, inGroup: boolean) => (
    <li key={t.id}>
      <button
        type="button"
        onClick={() => onSelect(t.id)}
        className={`w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted ${
          current === t.id ? "bg-muted" : ""
        } ${inGroup ? "pl-5" : ""}`}
      >
        <p className="truncate font-medium">{t.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {t.requisitionCode ?? STATUS_LABEL[t.status] ?? t.status} ·{" "}
          {new Date(t.updatedAt).toLocaleDateString()}
          {t.mine ? "" : " · team"}
        </p>
      </button>
    </li>
  );
  return (
    <ul className="space-y-1">
      {blocks.map((b) =>
        b.group && b.items.length >= 2 ? (
          <li key={b.group} className="rounded-md border border-border/70 py-1">
            <div className="flex items-center gap-1 px-3 py-1">
              <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {b.items.length} needs in parallel
              </span>
              <button
                type="button"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10"
                onClick={() => onSideBySide(b.items.slice(0, 3).map((i) => i.id))}
              >
                <Columns2 className="size-3" /> Side by side
              </button>
            </div>
            <ul className="space-y-0.5">{b.items.map((t) => row(t, true))}</ul>
          </li>
        ) : (
          b.items.map((t) => row(t, false))
        ),
      )}
    </ul>
  );
}

/**
 * Fan-outs whose side-by-side view this tab already opened, so Exit sticks —
 * kept for the tab's session (a reload must not snap the person back in).
 */
const AUTO_SPLIT_KEY = "desk.autoSplitShown";
function autoSplitSeen(id: string): boolean {
  try {
    return (JSON.parse(sessionStorage.getItem(AUTO_SPLIT_KEY) ?? "[]") as string[]).includes(id);
  } catch {
    return false;
  }
}
function markAutoSplitSeen(id: string) {
  try {
    const seen = JSON.parse(sessionStorage.getItem(AUTO_SPLIT_KEY) ?? "[]") as string[];
    sessionStorage.setItem(AUTO_SPLIT_KEY, JSON.stringify([...seen, id].slice(-50)));
  } catch {
    // Storage unavailable: the view simply may open again.
  }
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

/**
 * Side-by-side supervision for 2–3 parallel hiring needs: one column per
 * thread, each an independent live view (messages, cards, composer). The
 * entrance is the fan-out made visible — the columns rise in sequence.
 *
 * All columns are fed by ONE poll (getDeskThreads) that seeds each pane's
 * cache: one poll per pane hit the server-function rate limit, and a throttled
 * pane silently froze — a reply showed in one column and not in another.
 */
function SplitDesk({ ids }: { ids: string[] }) {
  const navigate = useNavigate({ from: "/desk" });
  const qc = useQueryClient();
  const key = ids.join(",");
  const all = useQuery({
    queryKey: ["desk_split", key],
    queryFn: async () => {
      const rows = await getDeskThreads({ data: { ids } });
      for (const r of rows) if (r.view) qc.setQueryData(["desk", r.id], r.view);
      return rows;
    },
    refetchInterval: 4_000,
  });
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setEntered(true), 30);
    return () => clearTimeout(t);
  }, []);
  // Deleting one track drops that one from the view; the others stay side by
  // side. Fewer than two left — back to the normal single-thread desk.
  const drop = (gone: string[]) => {
    const rest = ids.filter((x) => !gone.includes(x));
    if (rest.length >= 2) void navigate({ search: { split: rest.join(",") } });
    else void navigate({ search: rest.length ? { c: rest[0] } : {} });
  };
  // A thread deleted elsewhere (another tab, another person) leaves the view.
  const missing = (all.data ?? []).filter((r) => r.missing).map((r) => r.id);
  useEffect(() => {
    if (missing.length) drop(missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing.join(",")]);
  const views = new Map((all.data ?? []).map((r) => [r.id, r.view]));
  const waiting = [...views.values()].filter((v) => v && v.tracks.find((t) => t.self)?.needsYou);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="flex-1 text-xs text-muted-foreground">
          {ids.length} hiring needs side by side — each column is its own thread, with its own
          questions, agents and approvals.
          {waiting.length ? (
            <span className="ml-1 font-medium text-amber-700">
              {waiting.length} waiting for you.
            </span>
          ) : null}
          {all.isError ? <span className="ml-1 text-destructive">Reconnecting…</span> : null}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          onClick={() => void navigate({ search: { c: ids[0] } })}
        >
          <X className="size-3.5" /> Exit side by side
        </Button>
      </div>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${ids.length}, minmax(0, 1fr))` }}
      >
        {ids.map((id, i) => (
          <div
            key={id}
            className={`min-w-0 transition-all duration-500 ${
              entered ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
            }`}
            style={{ transitionDelay: `${i * 180}ms` }}
          >
            <Thread
              id={id}
              compact
              onDeleted={(also) => drop([id, ...(also ?? [])])}
              onFocus={() => void navigate({ search: { c: id } })}
              onChangedAll={() => void qc.invalidateQueries({ queryKey: ["desk_split", key] })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The desk fanned a multi-need message out. The card lists the tracks as
 * they are NOW (a deleted one says so) and opens the live ones side by side.
 */
function NeedsFanoutCard({
  card,
  conv,
  inSplit,
}: {
  card: DeskCardView;
  conv: DeskConversationView;
  /** Rendered inside one of the side-by-side panes: the split is already on. */
  inSplit?: boolean | undefined;
}) {
  const navigate = useNavigate({ from: "/desk" });
  const items = (card["items"] as unknown as { id: string; title: string }[]) ?? [];
  const live = new Map(conv.tracks.map((t) => [t.id, t]));
  const liveIds = items.map((i) => i.id).filter((id) => live.has(id) || id === conv.id);
  return (
    <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
      <p className="font-medium">Running {items.length} hiring needs in parallel</p>
      <ul className="space-y-1">
        {items.map((i, n) => {
          const t = live.get(i.id);
          return (
            <li key={i.id} className="flex items-center gap-2 text-xs">
              <span className={t ? "" : "text-muted-foreground line-through"}>
                {n + 1}. {t?.title ?? i.title}
              </span>
              <span className="text-muted-foreground">
                {t ? (STATUS_LABEL[t.status] ?? t.status) : "deleted"}
              </span>
            </li>
          );
        })}
      </ul>
      {!inSplit && liveIds.length >= 2 ? (
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          onClick={() => void navigate({ search: { split: liveIds.join(",") } })}
        >
          <Columns2 className="size-3.5" /> Open side by side
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The one control for a fan-out: the tracks chip. In the header of any
 * thread of a split, it shows how many tracks are running and what needs
 * the person; the dropdown lists every track (open it, or all side by side).
 * In side-by-side view it carries the Focus action instead of Exit.
 */
function TracksChip({
  tracks,
  compact,
  onOpenTrack,
  onSideBySide,
}: {
  tracks: { id: string; title: string; status: string; needsYou: number; self: boolean }[];
  compact?: boolean | undefined;
  onOpenTrack: (id: string) => void;
  onSideBySide: () => void;
}) {
  const [open, setOpen] = useState(false);
  const waiting = tracks.filter((t) => !t.self && t.needsYou > 0);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
          waiting.length
            ? "border-amber-500/60 bg-amber-500/10 text-amber-700"
            : "border-border text-muted-foreground"
        }`}
      >
        {tracks.length} tracks
        {waiting.length ? (
          <>
            <span className="inline-block size-1.5 rounded-full bg-amber-500" />
            {waiting.length} need{waiting.length === 1 ? "s" : ""} you
          </>
        ) : null}
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-72 space-y-1 rounded-md border border-border bg-background p-2 shadow-lg">
          {tracks.map((t) => (
            <div
              key={t.id}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ${
                t.self ? "bg-muted/60" : ""
              }`}
            >
              <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
              <span className="shrink-0 text-muted-foreground">
                {STATUS_LABEL[t.status] ?? t.status}
              </span>
              {t.needsYou > 0 ? (
                <span className="shrink-0 font-medium text-amber-600">
                  {t.needsYou} need{t.needsYou === 1 ? "s" : ""} you
                </span>
              ) : null}
              {t.self ? (
                <span className="shrink-0 text-muted-foreground">this thread</span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setOpen(false);
                    onOpenTrack(t.id);
                  }}
                >
                  Open
                </Button>
              )}
            </div>
          ))}
          <div className="border-t border-border pt-1">
            <Button
              size="sm"
              variant="ghost"
              className="w-full text-xs"
              onClick={() => {
                setOpen(false);
                onSideBySide();
              }}
            >
              {compact ? "Show all side by side" : "Run side by side"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- thread */

/** Chats deleted in the last 30 days, with Restore — shown to owners only (the server checks). */
function RecentlyDeleted({ onRestored }: { onRestored: (id: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["desk_deleted"],
    queryFn: () => listDeletedDeskConversations(),
    refetchInterval: 60_000,
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = q.data ?? [];
  if (!rows.length) return null;
  async function restore(id: string) {
    setBusy(id);
    try {
      await restoreDeskConversation({ data: { id } });
      toast.success("Chat restored");
      void qc.invalidateQueries({ queryKey: ["desk_deleted"] });
      void qc.invalidateQueries({ queryKey: ["desk_list"] });
      onRestored(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not restore");
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        <Trash2 className="size-3.5" /> Recently deleted ({rows.length})
      </button>
      {open ? (
        <ul className="mt-1 space-y-1">
          {rows.map((t) => (
            <li key={t.id} className="rounded-md px-3 py-2 text-xs">
              <p className="truncate font-medium">{t.title}</p>
              <p className="text-muted-foreground">
                {t.daysLeft} {t.daysLeft === 1 ? "day" : "days"} left to restore
                {t.reason ? ` · "${t.reason}"` : ""}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-1 h-6 gap-1 text-xs"
                disabled={busy === t.id}
                onClick={() => void restore(t.id)}
              >
                <RotateCcw className="size-3" /> Restore
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The dustbin: what it deletes, who decided, and that it can be restored for 30 days. */
function DeleteThreadButton({
  conv,
  onDeleted,
}: {
  conv: DeskConversationView;
  onDeleted: (also?: string[]) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const others = conv.tracks.filter((t) => !t.self);
  const [scope, setScope] = useState<"track" | "split">("track");
  const what = conv.canDelete;
  if (!what) return null;
  const draft = what.kind === "draft";
  async function confirm() {
    setBusy(true);
    try {
      const res = await deleteDeskConversation({
        data: { id: conv.id, reason: reason.trim(), scope: others.length ? scope : "track" },
      });
      toast.success(
        res.alsoDeleted
          ? `${res.alsoDeleted + 1} tracks deleted`
          : draft
            ? `Chat and draft ${what && "code" in what ? what.code : ""} deleted`
            : "Chat deleted",
      );
      // A track that could not go (in approval, or someone else's) stays — say why.
      for (const k of res.kept) toast.warning(`${k.title} was kept: ${k.why}`);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["desk_list"] });
      void qc.invalidateQueries({ queryKey: ["desk_deleted"] });
      const keptTitles = new Set(res.kept.map((k) => k.title));
      onDeleted(
        scope === "split" ? others.filter((t) => !keptTitles.has(t.title)).map((t) => t.id) : [],
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        aria-label="Delete this chat"
        title={draft ? "Delete this chat and its draft requisition" : "Delete this chat"}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-4" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {draft && "code" in what
                ? `Delete this chat and draft ${what.code}?`
                : "Delete this chat?"}
            </DialogTitle>
            <DialogDescription>
              {draft && "code" in what
                ? `The draft requisition ${what.code} was never approved and has no applicants; it is deleted permanently. `
                : "Nothing has been created from it yet. "}
              The chat disappears for everyone now; an owner can restore it for 30 days, then it is
              removed for good. The deletion is recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          {others.length ? (
            <fieldset className="space-y-1 rounded-md border border-border p-2 text-sm">
              <legend className="px-1 text-xs font-medium">
                This chat is one of {others.length + 1} needs started together
              </legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="delete-scope"
                  checked={scope === "track"}
                  onChange={() => setScope("track")}
                />
                Only {conv.title}
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="delete-scope"
                  className="mt-1"
                  checked={scope === "split"}
                  onChange={() => setScope("split")}
                />
                <span>
                  All {others.length + 1}: also {others.map((t) => t.title).join(", ")}
                  <span className="block text-xs text-muted-foreground">
                    A track already in approval or later is kept — you will be told which.
                  </span>
                </span>
              </label>
            </fieldset>
          ) : null}
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="delete-reason">
              {draft ? "Why? (required)" : "Why? (optional)"}
            </label>
            <Textarea
              id="delete-reason"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || (draft && reason.trim().length < 3)}
              onClick={() => void confirm()}
            >
              <Trash2 className="size-4" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Thread({
  id,
  onDeleted,
  compact,
  onFocus,
  onChangedAll,
}: {
  id: string;
  /** This thread was deleted (with `also`: the other tracks deleted with it). */
  onDeleted: (also?: string[]) => void;
  /** Split-screen column: no journey panel, taller conversation. */
  compact?: boolean;
  /** Split-screen column: open this thread on its own. */
  onFocus?: () => void;
  /** Split-screen column: refresh every pane (the split's one poll). */
  onChangedAll?: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["desk", id],
    queryFn: () => getDeskConversation({ data: { id } }),
    // In a split the columns are fed by the split's one poll (SplitDesk);
    // a pane polling on its own multiplied the calls into the rate limit.
    refetchInterval: compact ? false : 4_000,
    staleTime: compact ? 60_000 : 0,
  });
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const count = q.data?.messages.length ?? 0;
  useEffect(() => {
    // Scroll the conversation itself, never the page.
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, pending]);

  const refresh = () => {
    if (onChangedAll) onChangedAll();
    else qc.invalidateQueries({ queryKey: ["desk", id] });
    qc.invalidateQueries({ queryKey: ["desk_list"] });
  };

  // While focused on one track, the others still move: when a sibling's
  // open requests rise, say so — nobody should have to remember to look.
  const prevNeeds = useRef<Record<string, number>>({});
  useEffect(() => {
    const tracks = q.data?.tracks ?? [];
    if (!tracks.length) return;
    const prev = prevNeeds.current;
    for (const t of tracks) {
      if (t.self) continue;
      const before = prev[t.id];
      if (before !== undefined && t.needsYou > before) toast(`${t.title} is waiting for you`);
    }
    prevNeeds.current = Object.fromEntries(tracks.map((t) => [t.id, t.needsYou]));
  }, [q.data?.tracks]);

  // The fan-out made visible: when the desk splits a multi-need message into
  // parallel tracks, open them side by side — once per fan-out, and only the
  // tracks still alive (a deleted track must not come back as a column).
  const navigate = useNavigate({ from: "/desk" });
  const fanout = [...(q.data?.messages ?? [])]
    .reverse()
    .find((m) => (m.card as { type?: string } | null)?.type === "needs_fanout");
  const liveTracks = (q.data?.tracks ?? []).map((t) => t.id);
  useEffect(() => {
    if (compact || !fanout || liveTracks.length < 2 || autoSplitSeen(fanout.id)) return;
    // Only right after the fan-out: an old split reopened later is just a thread.
    if (Date.now() - new Date(fanout.at).getTime() > 10 * 60_000) return;
    markAutoSplitSeen(fanout.id);
    void navigate({ search: { split: liveTracks.slice(0, 3).join(",") } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, fanout?.id, liveTracks.length]);

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

  // Deleted from somewhere else (another view, another tab): leave the
  // thread instead of sitting on an error. (In a split, SplitDesk does this.)
  const missing = q.error instanceof Error && /not found/i.test(q.error.message);
  useEffect(() => {
    if (missing && !compact) onDeleted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing, compact]);

  if (q.isLoading || (compact && !q.data && !q.error))
    return <section className="panel p-6 text-sm text-muted-foreground">Loading…</section>;
  if (!q.data)
    return (
      <section className="panel p-6 text-sm text-muted-foreground">
        {q.error instanceof Error ? q.error.message : "Not found."}
      </section>
    );
  const d = q.data;
  const isOpenTask = (m: DeskMessageView) => {
    const t = (m.card as { taskId?: string } | null)?.taskId;
    return Boolean(t && (d.tasks[t] ?? "open") === "open");
  };
  const openTasks = d.messages.filter(isOpenTask).length;
  const superseded = supersededMessages(d);
  // Long threads: the latest messages, plus every request still waiting; the rest folds.
  const hidden = showAll ? 0 : Math.max(0, d.messages.length - RECENT_MESSAGES);
  const visible = d.messages.filter((m, i) => i >= hidden || isOpenTask(m));
  const folded = d.messages.length - visible.length;
  // The person's message (or a button they pressed — "Research … from the
  // market") is the last word and the desk has not answered yet: it is still
  // working. Shown to every viewer and every pane, not only the one that
  // clicked — research takes up to a minute and looked like nothing happened.
  const last = d.messages.at(-1);
  const deskWorking =
    !pending && last?.role === "user" && Date.now() - new Date(last.at).getTime() < 3 * 60_000;
  return (
    <div className={compact ? "" : "grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]"}>
      {/* The journey: first on small screens, a sticky column on wide ones. */}
      {!compact ? (
        <div className="xl:order-2">
          <JourneyPanel conv={d} onChanged={refresh} />
        </div>
      ) : null}
      {/* The conversation: fixed height, scrolls inside, composer always visible. */}
      <section
        className={`panel flex ${
          compact ? "h-[calc(100vh-7.5rem)]" : "h-[calc(100vh-13rem)]"
        } min-h-[460px] flex-col xl:order-1`}
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <h2 className="font-semibold">{d.title}</h2>
          <Badge variant="outline">{STATUS_LABEL[d.status] ?? d.status}</Badge>
          {!compact && (d.tracks?.length ?? 0) >= 2 ? (
            <TracksChip
              tracks={d.tracks}
              onOpenTrack={(id) => void navigate({ search: { c: id } })}
              onSideBySide={() =>
                void navigate({ search: { split: d.tracks.map((t) => t.id).join(",") } })
              }
            />
          ) : null}
          {openTasks > 0 ? (
            <span
              className="inline-block size-2 rounded-full bg-amber-500"
              title={`${openTasks} request${openTasks === 1 ? "" : "s"} waiting for you`}
            />
          ) : null}
          <DeleteThreadButton conv={d} onDeleted={onDeleted} />
          {onFocus ? (
            <button
              type="button"
              aria-label="Open this thread on its own"
              title="Open this thread on its own"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onFocus}
            >
              <Maximize2 className="size-4" />
            </button>
          ) : null}
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
        {compact ? (
          <details className="border-b border-border px-4 py-2 text-xs">
            <summary className="cursor-pointer select-none font-medium text-muted-foreground">
              Hiring journey
            </summary>
            <div className="mt-2">
              <JourneyPanel conv={d} onChanged={refresh} />
            </div>
          </details>
        ) : null}
        <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {folded > 0 ? (
            <button
              type="button"
              className="w-full rounded-md border border-dashed border-border py-1.5 text-xs text-muted-foreground hover:bg-muted"
              onClick={() => setShowAll(true)}
            >
              Show {folded} earlier {folded === 1 ? "message" : "messages"}
            </button>
          ) : null}
          {visible.map((m) => (
            <Message
              key={m.id}
              m={m}
              conv={d}
              onChanged={refresh}
              superseded={superseded.get(m.id) ?? null}
              compact={compact}
            />
          ))}
          {pending ? (
            <>
              <Bubble role="user" body={pending} />
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> The desk is thinking…
              </p>
            </>
          ) : deskWorking ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> The desk is working on it — research can
              take up to a minute…
            </p>
          ) : null}
        </div>
        <footer className="border-t border-border p-3">
          {/* Requests can be posted while other agents keep writing; never let
              one scroll out of sight unnoticed. */}
          {openTasks > 0 ? (
            <button
              type="button"
              className="mb-2 w-full rounded-md border border-primary/40 bg-primary/5 px-3 py-1.5 text-left text-xs font-medium text-primary"
              onClick={() =>
                list.current
                  ?.querySelector("[data-open-task]")
                  ?.scrollIntoView({ block: "center", behavior: "smooth" })
              }
            >
              {openTasks} request{openTasks === 1 ? "" : "s"} waiting for you in this conversation —
              show
            </button>
          ) : null}
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
  const [expanded, setExpanded] = useState(false);
  const { head, folded } = foldText(body);
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
        <AgentMarkdown text={folded && !expanded ? head : body} />
        {folded ? (
          <button
            type="button"
            className="mt-1 text-xs font-medium text-primary underline"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
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
  superseded,
  compact,
}: {
  m: DeskMessageView;
  conv: DeskConversationView;
  onChanged: () => void;
  /** Why this message's card no longer applies (it is folded), or null. */
  superseded?: string | null;
  /** Rendered inside a side-by-side pane: cards drop actions that manage the view. */
  compact?: boolean | undefined;
}) {
  const [reopen, setReopen] = useState(false);
  if (superseded && !reopen)
    return (
      <p className="ml-9 text-xs text-muted-foreground">
        {superseded}{" "}
        <button type="button" className="underline" onClick={() => setReopen(true)}>
          Show it
        </button>
      </p>
    );
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
          <Card card={m.card} conv={conv} onChanged={onChanged} compact={compact} />
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
  compact,
}: {
  card: DeskCardView;
  conv: DeskConversationView;
  onChanged: () => void;
  /** Inside a side-by-side pane: no view-managing actions on cards. */
  compact?: boolean | undefined;
}) {
  if (card.type === "similar_roles")
    return <SimilarRolesCard card={card} conv={conv} onChanged={onChanged} />;
  if (card.type === "needs_fanout")
    return <NeedsFanoutCard card={card} conv={conv} inSplit={compact} />;
  if (card.type === "hiring_manager_options")
    return <HiringManagerOptionsCard card={card} conv={conv} onChanged={onChanged} />;
  if (card.type === "ranked_candidates")
    return <RankedCard card={card} conv={conv} onChanged={onChanged} />;
  if (card.type === "task") return <TaskCard card={card} conv={conv} onChanged={onChanged} />;
  if (card.type === "screening_result")
    return (
      <ScreeningResultSummary
        runId={String(card["runId"])}
        applicationId={String(card["applicationId"])}
      />
    );
  if (card.type === "reasoning")
    return <Thinking why={card as unknown as Why} conv={conv} onChanged={onChanged} />;
  if (card.type === "jd") return <JdCard card={card} />;
  if (card.type === "interview_plan")
    return (
      <InterviewPlanThreadCard
        requisitionId={String(card["requisitionId"])}
        conv={conv}
        onChanged={onChanged}
      />
    );
  if (card.type === "next_steps")
    return <NextStepsCard card={card} conv={conv} onChanged={onChanged} />;
  if (card.type === "rescore") return <RescoreCard card={card} conv={conv} onChanged={onChanged} />;
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
              {r.location || "—"} · {r.openings} {r.openings === 1 ? "opening" : "openings"} ·{" "}
              {r.status.replace(/_/g, " ")}
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
  const screenable = items.filter((i) => SCREENABLE.has(conv.stages[i.applicationId] ?? i.stage));
  async function screen(ids: string[]) {
    setBusy(true);
    try {
      const r = await screenDeskCandidates({ data: { id: conv.id, applicationIds: ids } });
      toast.success(`Screening ${r.screening} ${r.screening === 1 ? "candidate" : "candidates"}`);
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
          {items.map((snap) => {
            // The list is a snapshot from when it was posted; score, fit and stage are live.
            const live = conv.reasoning[snap.applicationId];
            const r = {
              ...snap,
              score: live?.overall ?? snap.score,
              recommendation: live?.recommendation ?? snap.recommendation,
              matched: live?.matched ?? snap.matched,
              missing: live?.missing ?? snap.missing,
              risks: live ? live.risks.length : snap.risks,
              stage: conv.stages[snap.applicationId] ?? snap.stage,
            };
            return (
              <Fragment key={r.applicationId}>
                <tr className="border-b border-border/60 align-top">
                  <td className="px-2 py-2">
                    {SCREENABLE.has(r.stage) ? (
                      <Checkbox
                        checked={picked.includes(r.applicationId)}
                        onCheckedChange={(v) => toggle(r.applicationId, Boolean(v))}
                        aria-label={`Select ${r.name}`}
                      />
                    ) : null}
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
                      <p className="mt-1 text-xs text-muted-foreground">
                        {r.risks} risk {r.risks === 1 ? "flag" : "flags"}
                      </p>
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
            );
          })}
        </tbody>
      </table>
      {screenable.length ? (
        <div className="flex flex-wrap gap-2 border-t border-border p-2">
          <Button size="sm" disabled={busy || !picked.length} onClick={() => screen(picked)}>
            Screen selected ({picked.length})
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => screen(screenable.slice(0, 5).map((i) => i.applicationId))}
          >
            Screen the top {Math.min(5, screenable.length)}
          </Button>
        </div>
      ) : (
        <p className="border-t border-border p-2 text-xs text-muted-foreground">
          Everyone on this list is past screening.
        </p>
      )}
    </div>
  );
}

const TASK_STATUS: Record<string, string> = {
  open: "Waiting for you",
  approved: "Approved",
  rejected: "Declined",
  changes_requested: "Changes requested",
  stale: "No longer applies — the candidate moved on",
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
  // A requisition in approval, or an organisation profile version, can be sent
  // back for changes instead of declined for good.
  const subjectType = card["subjectType"] ?? conv.taskSubjects[taskId];
  const sendable =
    kind === "gate" && (subjectType === "requisition" || subjectType === "org_profile");
  // A screening decision: approve moves the candidate on; declining keeps them
  // in screening or, with a reason, rejects them (the person's decision).
  const screening = kind === "gate" && card["subjectType"] === "screening_decision";
  const proceed = card["recommendation"] === "proceed";
  // A panel proposal: approve it, or change the people (the decider's choice).
  const panel = kind === "gate" && card["subjectType"] === "panel_approval";
  const [changing, setChanging] = useState(false);
  const status = conv.tasks[taskId] ?? "open";
  const details =
    conv.taskDetails[taskId] ??
    (Array.isArray(card["details"]) ? (card["details"] as { label: string; value: string }[]) : []);
  const [answer, setAnswer] = useState("");
  const [declining, setDeclining] = useState(false);
  const [why, setWhy] = useState("");
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
      data-open-task={status === "open" ? taskId : undefined}
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
      {screening && card["applicationId"] ? (
        <div className="mt-2">
          <ScreeningResultSummary applicationId={String(card["applicationId"])} />
        </div>
      ) : null}
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
        ) : declining ? (
          // A decision people (and the agent) act on: say why. Required for gates.
          <div className="mt-2 space-y-2">
            <Textarea
              value={why}
              rows={2}
              maxLength={1000}
              placeholder={
                screening
                  ? "Why? (required — e.g. the evaluation depth is not enough for this role)"
                  : sendable
                    ? "What should change? (e.g. social profiling 25%) — or why you are declining"
                    : kind === "gate"
                      ? "Why are you declining? (required — the agent and the team act on it)"
                      : "Why? (optional — tells the agent what to change)"
              }
              onChange={(e) => setWhy(e.target.value)}
            />
            {screening ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || why.trim().length < 3}
                  title="Nothing moves; your reason is noted on the candidate"
                  onClick={() => decide({ status: "rejected", reason: why.trim() })}
                >
                  Keep in screening
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy || why.trim().length < 3}
                  title="Rejects the candidate for this role, with your reason on record"
                  onClick={() =>
                    decide({ status: "rejected", reason: why.trim(), rejectCandidate: true })
                  }
                >
                  Reject candidate
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDeclining(false)}
                >
                  Back
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {sendable ? (
                  <Button
                    size="sm"
                    disabled={busy || why.trim().length < 3}
                    title="Back to draft with your change; the agent applies it and the approvals start over"
                    onClick={() =>
                      decide({ status: "rejected", reason: why.trim(), changes: true })
                    }
                  >
                    Send back for changes
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy || (kind === "gate" && why.trim().length < 3)}
                  onClick={() =>
                    decide({
                      status: "rejected",
                      ...(why.trim() ? { reason: why.trim() } : {}),
                    })
                  }
                >
                  {sendable ? "Decline (final)" : "Decline"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDeclining(false)}
                >
                  Back
                </Button>
              </div>
            )}
          </div>
        ) : changing ? (
          <PanelChange
            requisitionId={String(card["requisitionId"])}
            level={Number(card["level"])}
            proposed={(card["memberIds"] as string[] | undefined) ?? []}
            busy={busy}
            onSave={(memberIds) => decide({ status: "approved", args: { memberIds } })}
            onBack={() => setChanging(false)}
          />
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => decide({ status: "approved" })}>
              {panel
                ? "Approve this panel"
                : screening
                  ? proceed
                    ? "Approve — move to interview (L1)"
                    : "Approve — put on hold"
                  : "Approve"}
            </Button>
            {panel ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setChanging(true)}>
                Change the people
              </Button>
            ) : null}
            {sendable ? (
              // A change is the common answer to a requisition in approval —
              // offered directly, not hidden behind Decline.
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setDeclining(true)}
              >
                Send back for changes
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setDeclining(true)}>
              {screening ? "Decline" : sendable ? "Decline (final)" : "Decline"}
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

/** Pick the panel yourself: eligible interviewers first, then any active member. */
function PanelChange(props: {
  requisitionId: string;
  level: number;
  proposed: string[];
  busy: boolean;
  onSave: (memberIds: string[]) => void;
  onBack: () => void;
}) {
  const q = useQuery({
    queryKey: ["panel_choices", props.requisitionId, props.level],
    queryFn: () =>
      getPanelChoices({ data: { requisitionId: props.requisitionId, level: props.level } }),
  });
  const [picked, setPicked] = useState<string[]>(props.proposed);
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  if (!q.data) return <p className="mt-2 text-xs text-muted-foreground">Loading interviewers…</p>;
  const row = (m: { memberId: string; name: string; note?: string }) => (
    <label key={m.memberId} className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={picked.includes(m.memberId)}
        disabled={!picked.includes(m.memberId) && picked.length >= 3}
        onChange={() => toggle(m.memberId)}
      />
      <span className="font-medium">{m.name}</span>
      {m.note ? <span className="text-muted-foreground">{m.note}</span> : null}
    </label>
  );
  return (
    <div className="mt-2 space-y-2 rounded-md border border-border p-2">
      <p className="text-xs font-medium">Who interviews for L{props.level}? (one to three)</p>
      {q.data.eligible.length ? (
        <div className="space-y-1">{q.data.eligible.map(row)}</div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No registered interviewer takes this round — pick from the team below.
        </p>
      )}
      {q.data.others.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Other members (not registered for this round)
          </summary>
          <div className="mt-1 space-y-1">{q.data.others.map(row)}</div>
        </details>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={props.busy || picked.length < 1 || picked.length > 3}
          onClick={() => props.onSave(picked)}
        >
          Approve with these people
        </Button>
        <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ progress */

type BoardRow = NonNullable<DeskConversationView["progress"]["screening"]>[number];

const BOARD_TONE: Record<BoardRow["tone"], string> = {
  decide: "font-semibold text-primary",
  working: "text-muted-foreground",
  done: "text-emerald-600",
  stopped: "text-muted-foreground",
};

/** Everyone in screening for this role at a glance: where they are, the score, what waits. */
function ScreeningBoard({ rows }: { rows: BoardRow[] }) {
  const waiting = rows.filter((r) => r.tone === "decide").length;
  return (
    <div
      className="mt-1.5 rounded-md border border-border p-2 text-xs"
      aria-label="Screening board"
    >
      <p className="mb-1 flex items-center justify-between font-medium">
        <span>
          {rows.length} {rows.length === 1 ? "candidate" : "candidates"} in screening
        </span>
        {waiting ? <span className="text-primary">{waiting} waiting for you</span> : null}
      </p>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.applicationId} className="py-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              {r.score != null ? (
                <span className="num rounded border border-border px-1 font-semibold">
                  {r.score}
                </span>
              ) : null}
            </div>
            <p className={BOARD_TONE[r.tone]}>{r.status}</p>
            {r.recommendation || r.coverage ? (
              <p className="text-muted-foreground">
                {[r.recommendation, r.coverage].filter(Boolean).join(" · ")}
              </p>
            ) : null}
            <div className="mt-0.5 flex flex-wrap gap-2">
              {r.taskId ? (
                <button
                  type="button"
                  className="font-medium text-primary underline"
                  onClick={() =>
                    document
                      .querySelector(`[data-open-task="${r.taskId}"]`)
                      ?.scrollIntoView({ block: "center", behavior: "smooth" })
                  }
                >
                  Decide
                </button>
              ) : null}
              {r.runId ? <WhyThisScore runId={r.runId} label="Why this score" link /> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
                      <button
                        type="button"
                        className="text-left font-medium text-primary underline"
                        onClick={() =>
                          document
                            .querySelector("[data-open-task]")
                            ?.scrollIntoView({ block: "center", behavior: "smooth" })
                        }
                      >
                        {n.waitingForYou} {n.waitingForYou === 1 ? "request" : "requests"} waiting
                        for you — show
                      </button>
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
                {s.key === "screening" && p.screening?.length ? (
                  <ScreeningBoard rows={p.screening} />
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
  const [busy, setBusy] = useState<null | "upload" | "publish" | "source" | "distribute">(null);
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
      toast.success(`${r.scored} ${r.scored === 1 ? "candidate" : "candidates"} scored`);
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

  async function distribute() {
    setBusy("distribute");
    try {
      await startDeskDistribution({ data: { id: conv.id } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the Distribution agent");
    } finally {
      setBusy(null);
    }
  }

  async function source() {
    setBusy("source");
    try {
      await startDeskSourcing({ data: { id: conv.id } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start sourcing");
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
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={publish}>
              {busy === "publish" ? <Loader2 className="size-4 animate-spin" /> : null}
              Publish
            </Button>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={distribute}>
              {busy === "distribute" ? <Loader2 className="size-4 animate-spin" /> : null}
              Advertise on job portals
            </Button>
          </div>
        </div>
        <div className="rounded-md border border-border p-2.5">
          <p className="font-medium">Find more candidates</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The Sourcing agent searches your talent pool and past candidates, and invites the best
            to apply with your approval. Emailed CVs land in the Careers inbox.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={source}>
              {busy === "source" ? <Loader2 className="size-4 animate-spin" /> : null}
              Ask the Sourcing agent
            </Button>
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

type Why = {
  understood?: { label: string; value: string }[];
  missing?: string[];
  next?: string;
  /** The optional JD details can be drafted from market practice — one press. */
  jdResearch?: boolean;
};

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
  async function draftFromMarket() {
    if (!conv) return;
    setBusy(true);
    try {
      await sendDeskMessage({ data: { id: conv.id, message: "research it" } });
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not draft");
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
      {why.jdResearch && conv ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 gap-1"
          disabled={busy}
          onClick={() => void draftFromMarket()}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          Draft responsibilities from market practice
        </Button>
      ) : null}
    </details>
  );
}

/** The team as tappable options — the hiring manager is picked, never typed. */
function HiringManagerOptionsCard({
  card,
  conv,
  onChanged,
}: {
  card: DeskCardView;
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const why = (card["why"] ?? {}) as Why;
  const options =
    (card["options"] as unknown as { memberId: string; name: string; email: string }[]) ?? [];
  const open = conv.status === "gathering";
  // Skills / experience can still be researched even while the hiring
  // manager is the question on the card — research stays available for as
  // long as those details are missing, not only on the turn that asked.
  const missing = why.missing ?? [];
  const canResearch = open && missing.some((m) => m === "must-have skills" || m === "experience");
  async function research() {
    setBusy(true);
    try {
      await researchDeskRole({
        data: {
          id: conv.id,
          fields: missing.includes("experience") ? ["skills", "experience"] : ["skills"],
        },
      });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not research this");
    } finally {
      setBusy(false);
    }
  }
  async function pick(memberId: string) {
    setBusy(true);
    try {
      await chooseHiringManagerOption({ data: { id: conv.id, memberId } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not set the hiring manager");
    } finally {
      setBusy(false);
    }
  }
  const understood = why.understood ?? [];
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
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
              : "Asking who manages this hire"}
          </dd>
          <dt className="text-muted-foreground">Still missing</dt>
          <dd>{(why.missing ?? []).join(", ") || "Nothing — all required details are in"}</dd>
          {why.next ? (
            <>
              <dt className="text-muted-foreground">Next</dt>
              <dd>{why.next}</dd>
            </>
          ) : null}
        </dl>
      </details>
      {options.length ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Pick the hiring manager from your team — they approve this role&apos;s interview panels:
          </p>
          {options.map((o) => (
            <Button
              key={o.memberId}
              size="sm"
              variant="outline"
              className="w-full justify-start"
              disabled={busy || !open}
              onClick={() => void pick(o.memberId)}
            >
              <span className="truncate">{o.name}</span>
              <span className="ml-auto truncate text-xs text-muted-foreground">{o.email}</span>
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No active team members found — the admin adds people on the Team page.
        </p>
      )}
      {canResearch ? (
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          disabled={busy}
          onClick={() => void research()}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          Research it from the market
        </Button>
      ) : null}
    </div>
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

/** A job description shown in the thread: the saved text of one version. */
/** The role's hiring manager and interview plan, editable in the thread. */
/**
 * The Role expert interview agent, from the thread: ask the role's hiring
 * manager what it really needs. Once their brief is approved, say so —
 * screening kits and the interview rounds work from it.
 */
function ExpertInterviewAction({
  conv,
  onChanged,
}: {
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const at = conv.requisition?.expertBriefAt ?? null;
  async function start() {
    setBusy(true);
    try {
      await startDeskExpertInterview({ data: { id: conv.id } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the interview");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1 rounded-md border border-dashed border-border p-2">
      <p className="text-xs text-muted-foreground">
        {at
          ? `Expert brief approved by the hiring manager on ${new Date(at).toLocaleDateString()} — screening and interviews work from it.`
          : "Ask the hiring manager what this role really needs: must-haves and why, deal-breakers, and the questions that tell strong from weak. They approve the brief before screening uses it."}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="gap-1"
        disabled={busy}
        onClick={() => void start()}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <UserRound className="size-4" />}
        {at ? "Interview the hiring manager again" : "Ask the hiring manager what this role needs"}
      </Button>
    </div>
  );
}

function InterviewPlanThreadCard({
  requisitionId,
  conv,
  onChanged,
}: {
  requisitionId: string;
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">Interview plan</p>
        <Link
          to="/requisitions/$id"
          params={{ id: requisitionId }}
          className="ml-auto text-xs text-primary hover:underline"
        >
          Open the requisition
        </Link>
      </div>
      <div className="max-w-xs space-y-1">
        <p className="text-xs text-muted-foreground">Hiring manager</p>
        <HiringManagerPicker requisitionId={requisitionId} />
      </div>
      <ExpertInterviewAction conv={conv} onChanged={onChanged} />
      <InterviewPlanCard requisitionId={requisitionId} />
    </div>
  );
}

function JdCard({ card }: { card: DeskCardView }) {
  return (
    <div className="rounded-lg border border-border text-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <p className="font-medium">
          {String(card["code"])} · version {String(card["version"])}
        </p>
        <Badge variant="outline">{String(card["status"])}</Badge>
        {card["templateName"] ? (
          <span className="text-xs text-muted-foreground">
            Template: {String(card["templateName"])}
          </span>
        ) : null}
        <Link
          to="/requisitions/$id"
          params={{ id: String(card["requisitionId"]) }}
          className="ml-auto text-xs text-primary hover:underline"
        >
          Open the requisition
        </Link>
      </div>
      <div className="max-h-96 overflow-y-auto whitespace-pre-wrap px-3 py-2 text-[13px] leading-relaxed">
        <AgentMarkdown text={String(card["text"] ?? "")} />
      </div>
    </div>
  );
}

type NextItem = {
  agentType: "intake" | "publishing" | "sourcing" | "distribution";
  name: string;
  text: string;
  enabled: boolean;
};

/** After JD approval: who works next, and a switch for the ones that are off. */
function NextStepsCard({
  card,
  conv,
  onChanged,
}: {
  card: DeskCardView;
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  const items = (card["items"] as NextItem[] | undefined) ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [turnedOn, setTurnedOn] = useState<Set<string>>(new Set());
  async function enable(agentType: NextItem["agentType"]) {
    setBusy(agentType);
    try {
      await enableDeskAgent({ data: { id: conv.id, agentType } });
      setTurnedOn((s) => new Set(s).add(agentType));
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not switch it on");
    } finally {
      setBusy(null);
    }
  }
  return (
    <ol className="space-y-2 rounded-lg border border-border p-3 text-sm">
      {items.map((it, i) => {
        const on = it.enabled || turnedOn.has(it.agentType);
        return (
          <li key={it.agentType} className="flex gap-2">
            <span className="num text-muted-foreground">{i + 1}.</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {it.name}{" "}
                <Badge variant={on ? "outline" : "secondary"} className="ml-1">
                  {on ? "on" : "switched off"}
                </Badge>
              </p>
              <p className="text-xs text-muted-foreground">{it.text}</p>
              {!on ? (
                conv.canEditAgents ? (
                  <Button
                    size="sm"
                    className="mt-1 h-7"
                    disabled={busy !== null}
                    onClick={() => enable(it.agentType)}
                  >
                    {busy === it.agentType ? <Loader2 className="size-4 animate-spin" /> : null}
                    Switch on and start
                  </Button>
                ) : (
                  <p className="mt-1 text-xs font-medium text-primary">
                    Ask your HR head or CBO to switch it on.
                  </p>
                )
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The JD changed after candidates were scored: offer to score them again. */
function RescoreCard({
  card,
  conv,
  onChanged,
}: {
  card: DeskCardView;
  conv: DeskConversationView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  async function go() {
    setBusy(true);
    try {
      const r = await rescoreDeskCandidates({ data: { id: conv.id } });
      setDone(r.scored);
      toast.success(`${r.scored} ${r.scored === 1 ? "candidate" : "candidates"} re-scored`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not re-score");
    } finally {
      setBusy(false);
    }
  }
  if (done !== null)
    return (
      <p className="text-xs text-muted-foreground">
        Re-scored {done} {done === 1 ? "candidate" : "candidates"}; the ranked list above is
        updated.
      </p>
    );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 p-3 text-sm">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        Their old scores are replaced; nobody's stage changes.
      </p>
      <Button size="sm" disabled={busy} onClick={go}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        Re-score {String(card["count"])} against version {String(card["version"])}
      </Button>
    </div>
  );
}
