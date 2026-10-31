/**
 * The Organisation context agent's workspace on the Profile page — one
 * surface instead of stacked cards: the agent's status bar on top, the
 * conversation on the left (text, a website address, or a document through
 * the clip) and the profile on the right, filling in as the agent writes it,
 * with the approval decided right there. One next step at a time; the same
 * instruction is never repeated in three places.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Eye,
  FileText,
  Globe,
  Loader2,
  Lock,
  MessageSquareText,
  Paperclip,
  Send,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";

import {
  buildFromDesk,
  confirmWebsiteFromDesk,
  getOrgDeskThread,
  retryOrgDeskRun,
  sendOrgDeskMessage,
  type OrgDeskMessageView,
} from "@/lib/org-desk.functions";
import {
  acceptOrgSource,
  deleteOrgDocument,
  getOrgContextAdmin,
  uploadOrgDocument,
} from "@/lib/org-context.functions";
import {
  decideOrgProfileVersion,
  getOrgProfile,
  type OrgProfileVersionView,
} from "@/lib/org-profile.functions";
import { cancelAgentRun, decideAgentTask } from "@/lib/agents.functions";
import {
  diffSections,
  PROFILE_SECTIONS,
  type OrgProfileItem,
  type SectionDef,
} from "@/lib/org-profile";
import { AgentMarkdown } from "@/components/AgentMarkdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const ACTIVE = new Set(["queued", "running", "awaiting_human"]);
const at = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Base64 for a file up to a few MB, without blowing the call stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

type Thread = NonNullable<Awaited<ReturnType<typeof getOrgDeskThread>>>;
type Admin = Awaited<ReturnType<typeof getOrgContextAdmin>>;

export function OrgAgentWorkspace({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient();
  const tq = useQuery({
    queryKey: ["org_desk"],
    queryFn: () => getOrgDeskThread(),
    refetchInterval: (q) =>
      q.state.data && ACTIVE.has(q.state.data.activity?.status ?? "") ? 3000 : 12_000,
  });
  const working = ACTIVE.has(tq.data?.activity?.status ?? "");
  // The profile and its sources move while the agent works: follow it live.
  const pq = useQuery({
    queryKey: ["org_profile"],
    queryFn: () => getOrgProfile(),
    refetchInterval: working ? 3000 : false,
  });
  const aq = useQuery({
    queryKey: ["org_context_admin"],
    queryFn: () => getOrgContextAdmin(),
    refetchInterval: working ? 5000 : false,
  });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"" | "send" | "build" | "stop" | "upload">("");
  const [pending, setPending] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["org_desk"] });
    qc.invalidateQueries({ queryKey: ["org_context_admin"] });
    onChanged();
  };
  const act = async (kind: typeof busy, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(kind);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy("");
      refresh();
    }
  };

  const thread = tq.data;
  if (tq.isLoading || pq.isLoading)
    return <p className="mt-4 text-sm text-muted-foreground">Opening the agent…</p>;
  if (!thread || !pq.data)
    return <p className="mt-4 text-sm text-destructive">Could not open the agent.</p>;
  const profile = pq.data;

  async function send(text: string) {
    const message = text.trim();
    if (!message || !thread) return;
    setPending(message);
    setDraft("");
    await act("send", () => sendOrgDeskMessage({ data: { id: thread.id, message } }));
    setPending(null);
  }
  const prefill = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      composer.current?.focus();
      composer.current?.setSelectionRange(text.length, text.length);
    });
  };
  const upload = (file: File) =>
    act("upload", async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await uploadOrgDocument({
        data: { fileName: file.name, dataBase64: bytesToBase64(bytes) },
      });
      toast.success(
        `${file.name}: ${r.itemsKept} line${r.itemsKept === 1 ? "" : "s"} added to the draft${r.ocr ? " (scanned pages read)" : ""}.`,
      );
    });

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <AgentBar
        thread={thread}
        profile={profile}
        admin={aq.data ?? null}
        busy={busy}
        onBuild={() => act("build", () => buildFromDesk({ data: { id: thread.id } }))}
        onStop={(runId) => act("stop", () => cancelAgentRun({ data: { runId } }), "Stopped.")}
        onRetry={(runId) => act("build", () => retryOrgDeskRun({ data: { id: thread.id, runId } }))}
      />
      <div className="grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:divide-x lg:divide-border">
        <Conversation
          thread={thread}
          pending={pending}
          busy={busy}
          draft={draft}
          setDraft={setDraft}
          composer={composer}
          onSend={send}
          onUpload={upload}
          onChanged={refresh}
        />
        <LiveProfile
          gateNote={openGateNote(thread)}
          profile={profile}
          admin={aq.data ?? null}
          working={working}
          busy={busy}
          onAsk={prefill}
          onChanged={refresh}
          onUpload={upload}
        />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ status bar */

function AgentBar({
  thread,
  profile,
  admin,
  busy,
  onBuild,
  onStop,
  onRetry,
}: {
  thread: Thread;
  profile: Awaited<ReturnType<typeof getOrgProfile>>;
  admin: Admin | null;
  busy: string;
  onBuild: () => void;
  onStop: (runId: string) => void;
  onRetry: (runId: string) => void;
}) {
  const a = thread.activity;
  const status = a?.status ?? "idle";
  const waitingApproval = profile.open?.status === "pending";
  const working = status === "queued" || status === "running";
  const off = admin ? !admin.agentEnabled : false;
  const hasSources = Boolean(admin?.website) || (admin?.sources ?? []).some((s) => !s.deleted);
  const line = off
    ? "Switched off — switch it on in Agent settings to build the profile."
    : working
      ? status === "queued"
        ? "Starting…"
        : `Working — ${a?.lastStep?.text ?? "thinking"}…`
      : status === "awaiting_human"
        ? waitingApproval
          ? profile.canDecide
            ? "Waiting for your approval — the draft and the decision are on the right."
            : "Waiting for the HR head or an owner to approve the draft."
          : "Waiting for your answer in the conversation."
        : status === "failed"
          ? `Stopped: ${a?.error ?? "something went wrong"}`
          : waitingApproval
            ? profile.canDecide
              ? "The draft is waiting for your approval — on the right."
              : "The draft is waiting for the HR head or an owner."
            : profile.approved
              ? "Ready. Tell me what changed, or update the profile from your sources."
              : hasSources
                ? "Ready to write your profile from what you've shared."
                : "Ready. Paste your website, attach a document, or tell me about the organisation.";
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border bg-gradient-to-r from-primary/10 via-primary/5 to-transparent px-4 py-3">
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground ${
          working ? "animate-pulse" : ""
        }`}
      >
        <Sparkles className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Organisation context agent</p>
        <p
          className={`truncate text-xs ${
            status === "failed" ? "text-destructive" : "text-muted-foreground"
          }`}
          aria-live="polite"
        >
          {line}
        </p>
      </div>
      {off ? null : working && a ? (
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          disabled={busy !== ""}
          onClick={() => onStop(a.runId)}
        >
          <Square className="size-3.5" /> Stop
        </Button>
      ) : status === "failed" && a ? (
        <Button size="sm" className="gap-1" disabled={busy !== ""} onClick={() => onRetry(a.runId)}>
          Try again
        </Button>
      ) : status === "awaiting_human" || waitingApproval ? null : (
        <Button
          size="sm"
          className="gap-1"
          disabled={busy !== "" || (!hasSources && !thread.messages.some((m) => m.role === "user"))}
          title={
            hasSources
              ? "Read everything you've shared and write the profile, then send it for approval"
              : "Share a website, a document or a few facts first"
          }
          onClick={onBuild}
        >
          {busy === "build" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {profile.approved || profile.open ? "Update the profile" : "Write my profile"}
        </Button>
      )}
    </header>
  );
}

/* ---------------------------------------------------------- conversation */

function Conversation({
  thread,
  pending,
  busy,
  draft,
  setDraft,
  composer,
  onSend,
  onUpload,
  onChanged,
}: {
  thread: Thread;
  pending: string | null;
  busy: string;
  draft: string;
  setDraft: (v: string) => void;
  composer: React.RefObject<HTMLTextAreaElement | null>;
  onSend: (text: string) => void;
  onUpload: (file: File) => void;
  onChanged: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [thread.messages.length, pending]);
  return (
    <div className="flex h-[calc(100vh-15rem)] min-h-[520px] flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
        aria-live="polite"
      >
        {thread.messages.map((m) => (
          <ChatMessage key={m.id} m={m} thread={thread} onChanged={onChanged} />
        ))}
        {pending ? (
          <>
            <UserBubble body={pending} />
            <p className="flex items-center gap-2 pl-9 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Reading that…
            </p>
          </>
        ) : null}
      </div>
      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-lg border border-border bg-background p-1.5 focus-within:ring-2 focus-within:ring-primary/30">
          <input
            ref={file}
            type="file"
            accept=".pdf,.docx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) onUpload(f);
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0"
            aria-label="Attach a document (PDF or DOCX)"
            title="Attach a brochure, handbook or policy (PDF or DOCX, up to 10 MB)"
            disabled={busy !== ""}
            onClick={() => file.current?.click()}
          >
            {busy === "upload" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Paperclip className="size-4" />
            )}
          </Button>
          <Textarea
            ref={composer}
            rows={2}
            className="min-h-10 flex-1 resize-none border-0 shadow-none focus-visible:ring-0"
            placeholder="Tell me about the organisation, or paste your website…"
            value={draft}
            disabled={busy === "send"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend(draft);
              }
            }}
          />
          <Button
            size="icon"
            className="shrink-0"
            aria-label="Send"
            disabled={busy !== "" || !draft.trim()}
            onClick={() => onSend(draft)}
          >
            {busy === "send" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ body }: { body: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
        {body}
      </div>
    </div>
  );
}

function ChatMessage({
  m,
  thread,
  onChanged,
}: {
  m: OrgDeskMessageView;
  thread: Thread;
  onChanged: () => void;
}) {
  if (m.role === "user") return <UserBubble body={m.body} />;
  const card = m.card as Record<string, unknown> | null;
  const taskId = typeof card?.["taskId"] === "string" ? (card["taskId"] as string) : null;
  const isQuestion = card?.["type"] === "task" && card["kind"] === "clarification" && taskId;
  const isGate = card?.["type"] === "task" && card["kind"] !== "clarification" && taskId;
  return (
    <div className="flex gap-2">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 max-w-[88%] space-y-2">
        {/* An agent's request card carries its own words; its generic line adds nothing. */}
        {!isQuestion && !isGate ? (
          <div className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm">
            <AgentMarkdown text={m.body} />
            <p className="mt-1 text-[10px] text-muted-foreground">{at(m.at)}</p>
          </div>
        ) : null}
        {isQuestion ? (
          <QuestionCard
            taskId={taskId}
            title={String(card?.["title"] ?? "A question")}
            body={String(card?.["body"] ?? "")}
            status={thread.tasks[taskId] ?? "open"}
            canAnswer={thread.deciders[taskId]?.canDecide ?? false}
            waitingFor={thread.deciders[taskId]?.waitingFor ?? null}
            onChanged={onChanged}
          />
        ) : null}
        {isQuestion && thread.answers[taskId] ? <UserBubble body={thread.answers[taskId]} /> : null}
        {isGate ? (
          <div className="rounded-2xl rounded-tl-sm border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
            {(thread.tasks[taskId] ?? "open") === "open"
              ? "I've sent the draft for approval — it's on the right, with the decision."
              : thread.tasks[taskId] === "approved"
                ? "The draft was approved — it's now the profile every agent works from."
                : "The draft was sent back — I'll rework it from the note."}
          </div>
        ) : null}
        {card?.["type"] === "website_confirm" ? (
          <WebsiteConfirm
            threadId={thread.id}
            url={String(card["url"] ?? "")}
            onChanged={onChanged}
          />
        ) : null}
      </div>
    </div>
  );
}

function WebsiteConfirm({
  threadId,
  url,
  onChanged,
}: {
  threadId: string;
  url: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (done) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background p-2 text-sm">
      <Globe className="size-4 text-muted-foreground" />
      <span className="font-medium">{url.replace(/^https?:\/\//, "")}</span>
      <Button
        size="sm"
        className="ml-auto gap-1"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await confirmWebsiteFromDesk({ data: { id: threadId, url } });
            setDone(true);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not confirm");
          } finally {
            setBusy(false);
            onChanged();
          }
        }}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        Yes, it&apos;s ours — read it
      </Button>
    </div>
  );
}

function QuestionCard({
  taskId,
  title,
  body,
  status,
  canAnswer,
  waitingFor,
  onChanged,
}: {
  taskId: string;
  title: string;
  body: string;
  status: string;
  canAnswer: boolean;
  waitingFor: string | null;
  onChanged: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const open = status === "open";
  return (
    <div
      className={`rounded-2xl rounded-tl-sm border px-3 py-2 text-sm ${
        open ? "border-amber-500/50 bg-amber-500/5" : "border-border bg-muted/40"
      }`}
    >
      <p className="font-medium">{title}</p>
      <div className="mt-1 text-sm">
        <AgentMarkdown text={body} />
      </div>
      {!open ? null : canAnswer ? (
        <div className="mt-2 flex items-end gap-2">
          <Textarea
            rows={2}
            maxLength={2000}
            value={answer}
            placeholder="Your answer…"
            className="flex-1"
            onChange={(e) => setAnswer(e.target.value)}
          />
          <Button
            size="sm"
            disabled={busy || !answer.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await decideAgentTask({
                  data: { taskId, decision: { status: "answered", answer: answer.trim() } },
                });
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Could not send");
              } finally {
                setBusy(false);
                onChanged();
              }
            }}
          >
            Reply
          </Button>
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          Waiting for {waitingFor ?? "the HR head or an owner"}.
        </p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- live profile */

/** The agent's own words on its open approval request (what it wrote, what is thin). */
function openGateNote(thread: Thread): string | null {
  for (const m of [...thread.messages].reverse()) {
    const c = m.card as Record<string, unknown> | null;
    const id = typeof c?.["taskId"] === "string" ? (c["taskId"] as string) : null;
    if (c?.["type"] === "task" && c["kind"] !== "clarification" && id) {
      if ((thread.tasks[id] ?? "open") !== "open") return null;
      return typeof c["body"] === "string" ? (c["body"] as string) : null;
    }
  }
  return null;
}

function LiveProfile({
  gateNote,
  profile,
  admin,
  working,
  busy,
  onAsk,
  onChanged,
  onUpload,
}: {
  gateNote: string | null;
  profile: Awaited<ReturnType<typeof getOrgProfile>>;
  admin: Admin | null;
  working: boolean;
  busy: string;
  onAsk: (text: string) => void;
  onChanged: () => void;
  onUpload: (file: File) => void;
}) {
  const version: OrgProfileVersionView | null = profile.open ?? profile.approved;
  const sections = version?.sections ?? {};
  const approvedSections = profile.approved?.sections ?? null;
  // New against the approved version: what the agent (or you) just added.
  const added = useMemo(() => {
    if (!profile.open) return new Set<string>();
    return new Set(
      diffSections(approvedSections, profile.open.sections).flatMap((d) => [
        ...d.added.map((i) => i.id),
        ...d.changed.map((c) => c.after.id),
      ]),
    );
  }, [profile.open, approvedSections]);
  const covered = PROFILE_SECTIONS.filter((s) => (sections[s.key] ?? []).length > 0).length;
  const sourceName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of admin?.sources ?? []) {
      if (s.kind === "website_page" && s.url) {
        try {
          const u = new URL(s.url);
          m.set(s.id, u.pathname === "/" ? u.hostname.replace(/^www\./, "") : u.pathname);
        } catch {
          m.set(s.id, s.url);
        }
      } else if (s.fileName) m.set(s.id, s.fileName);
    }
    return m;
  }, [admin?.sources]);
  const pending = profile.open?.status === "pending" ? profile.open : null;

  const label = !version
    ? "No profile yet"
    : profile.open
      ? `Draft · version ${profile.open.version}${
          pending ? " · waiting for approval" : working ? " · being written" : ""
        }`
      : `Approved · version ${version.version}`;

  return (
    <div className="flex h-[calc(100vh-15rem)] min-h-[520px] flex-col bg-muted/20">
      <div className="space-y-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{label}</p>
          <span className="ml-auto text-xs text-muted-foreground">
            {covered} of {PROFILE_SECTIONS.length} sections
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-700"
            style={{ width: `${(covered / PROFILE_SECTIONS.length) * 100}%` }}
          />
        </div>
        <Sources admin={admin} busy={busy} onChanged={onChanged} onUpload={onUpload} />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {pending ? (
          <Approval
            note={gateNote}
            version={pending}
            canDecide={profile.canDecide}
            onChanged={onChanged}
            added={added.size}
          />
        ) : null}
        {PROFILE_SECTIONS.map((def) => (
          <SectionBlock
            key={def.key}
            def={def}
            items={sections[def.key] ?? []}
            added={added}
            sourceName={sourceName}
            onAsk={onAsk}
          />
        ))}
      </div>
    </div>
  );
}

function Sources({
  admin,
  busy,
  onChanged,
  onUpload,
}: {
  admin: Admin | null;
  busy: string;
  onChanged: () => void;
  onUpload: (file: File) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const live = (admin?.sources ?? []).filter((s) => !s.deleted);
  const pages = live.filter((s) => s.kind === "website_page");
  const docs = live.filter((s) => s.kind === "document");
  const flagged = live.filter((s) => s.injectionFlagged);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {admin?.website ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5">
            <span
              className={`size-1.5 rounded-full ${
                admin.website.lastRereadStatus === "failed" ? "bg-red-500" : "bg-emerald-500"
              }`}
            />
            <Globe className="size-3" />
            {admin.website.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
            <span className="text-muted-foreground">
              · {pages.length ? `${pages.length} pages read` : "not read yet"}
            </span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-muted-foreground">
            <Globe className="size-3" /> No website — paste it in the chat
          </span>
        )}
        {docs.map((d) => (
          <span
            key={d.id}
            className="inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5"
          >
            <FileText className="size-3 shrink-0" />
            <span className="truncate" title={d.fileName ?? ""}>
              {d.fileName}
            </span>
            <button
              type="button"
              aria-label={`Remove ${d.fileName}`}
              className="text-muted-foreground hover:text-destructive"
              disabled={busy !== ""}
              onClick={async () => {
                try {
                  await deleteOrgDocument({ data: { sourceId: d.id } });
                  toast.success("Document removed.");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Could not remove");
                } finally {
                  onChanged();
                }
              }}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={file}
          type="file"
          accept=".pdf,.docx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onUpload(f);
          }}
        />
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-primary hover:bg-primary/10"
          disabled={busy !== ""}
          onClick={() => file.current?.click()}
        >
          <Paperclip className="size-3" /> Add a document
        </button>
      </div>
      {flagged.map((f) => (
        <div
          key={f.id}
          className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs"
        >
          <TriangleAlert className="size-3.5 text-amber-600" />
          <span className="min-w-0 flex-1 truncate">
            {f.url ?? f.fileName} reads like instructions to an AI — nothing was kept from it.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs"
            onClick={async () => {
              try {
                await acceptOrgSource({ data: { sourceId: f.id } });
                toast.success("Accepted — read into the draft.");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Could not accept");
              } finally {
                onChanged();
              }
            }}
          >
            I've read it — use it
          </Button>
        </div>
      ))}
    </div>
  );
}

function SectionBlock({
  def,
  items,
  added,
  sourceName,
  onAsk,
}: {
  def: SectionDef;
  items: OrgProfileItem[];
  added: Set<string>;
  sourceName: Map<string, string>;
  onAsk: (text: string) => void;
}) {
  if (!items.length)
    return (
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground"
        onClick={() => onAsk(`${def.title}: `)}
        title="Tell the agent about this in the chat"
      >
        <MessageSquareText className="size-4 shrink-0" />
        <span className="font-medium">{def.title}</span>
        <span className="truncate text-xs">— nothing yet; tell me</span>
      </button>
    );
  return (
    <section className="rounded-lg border border-border bg-background p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-sm font-semibold">{def.title}</h3>
        <span className="text-xs text-muted-foreground">{items.length}</span>
        <button
          type="button"
          className="ml-auto text-xs text-primary hover:underline"
          onClick={() => onAsk(`${def.title}: `)}
        >
          Add or correct
        </button>
      </div>
      <ul className="space-y-1.5">
        {items.map((i) => {
          const fresh = added.has(i.id);
          const internal = i.visibility !== "candidate" || def.internalOnly;
          const from =
            i.source.kind === "website" || i.source.kind === "document"
              ? (i.source.ref && sourceName.get(i.source.ref)) || i.source.kind
              : i.source.kind === "conversation"
                ? "you said"
                : "added by a person";
          return (
            <li
              key={i.id}
              className={`flex items-start gap-2 rounded-md px-1.5 py-1 text-sm transition-colors ${
                fresh ? "bg-emerald-500/10" : ""
              }`}
            >
              <span
                className="mt-0.5 shrink-0 text-muted-foreground"
                title={
                  internal ? "Internal — never said to candidates" : "May be said to candidates"
                }
              >
                {internal ? <Lock className="size-3.5" /> : <Eye className="size-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                {i.text}
                <span
                  className="ml-1.5 text-[11px] text-muted-foreground"
                  title={i.source.quote ? `“${i.source.quote}”` : undefined}
                >
                  · {from}
                </span>
              </span>
              {fresh ? (
                <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                  new
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The decision, where the draft is — not buried in the chat. */
function Approval({
  note: agentNote,
  version,
  canDecide,
  added,
  onChanged,
}: {
  note: string | null;
  version: OrgProfileVersionView;
  canDecide: boolean;
  added: number;
  onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function decide(decision: "approve" | "send_back" | "decline") {
    setBusy(true);
    try {
      await decideOrgProfileVersion({
        data: { versionId: version.id, decision, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      toast.success(
        decision === "approve"
          ? "Approved — every agent now works from this profile."
          : decision === "send_back"
            ? "Sent back — the agent reworks it from your note."
            : "Declined.",
      );
      setNote("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the decision");
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  return (
    <section className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
      <p className="font-semibold">Ready for approval</p>
      {agentNote ? (
        <details className="rounded-md bg-background/70 px-2 py-1 text-xs">
          <summary className="cursor-pointer select-none font-medium">
            The agent&apos;s summary — what it wrote and what is still thin
          </summary>
          <div className="mt-1">
            <AgentMarkdown text={agentNote} />
          </div>
        </details>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {added ? `${added} new or changed line${added === 1 ? "" : "s"} are marked below. ` : ""}
        Lines with an eye may be said to candidates; locked lines stay internal.
        {version.injectionFlagged
          ? " Some text reads like instructions to an AI — read it first."
          : ""}
      </p>
      {canDecide ? (
        <>
          <Textarea
            rows={2}
            maxLength={2000}
            value={note}
            placeholder="Anything to change? e.g. “Go deeper on how we work” — needed to send it back"
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || note.trim().length < 3}
              onClick={() => void decide("send_back")}
            >
              Send back with my note
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={busy || note.trim().length < 3}
              onClick={() => void decide("decline")}
            >
              Decline
            </Button>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Waiting for the HR head or an owner.</p>
      )}
    </section>
  );
}
