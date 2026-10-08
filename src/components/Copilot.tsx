import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowUp, BookOpen, BrainCircuit, ChevronRight, Compass, RotateCcw, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import {
  askCopilot,
  clearCopilot,
  copilotHistory,
  type CopilotMessage,
} from "@/lib/copilot.functions";
import { FIRST_RUN_JOURNEY } from "@/lib/user-manual";
import { useMe } from "@/hooks/useMe";
import { useNavCtx } from "@/hooks/useNavCtx";
import { useOrg } from "@/hooks/useOrg";
import { Button } from "@/components/ui/button";

const PROMPTS = [
  "Which open requisitions are at risk this week?",
  "Where is my pipeline leaking the most?",
  "Which skills are scarce in my talent pool?",
  "What should I fix in my offer stage?",
];

/** Always-available HR copilot: one ongoing conversation, stored in the database. */
export function Copilot() {
  const qc = useQueryClient();
  const fetchHistory = useServerFn(copilotHistory);
  const ask = useServerFn(askCopilot);
  const reset = useServerFn(clearCopilot);

  const [open, setOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [draft, setDraft] = useState("");
  const { userId } = useMe();
  const nav = useNavCtx();
  const { isLoading: orgLoading } = useOrg();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!userId || orgLoading || !nav.inOrg) return;
    const key = `atsiq.first-journey.v1.${userId}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "seen");
    setOpen(true);
    setGuideOpen(true);
    setShowWelcome(true);
  }, [userId, orgLoading, nav.inOrg]);

  const history = useQuery({
    queryKey: ["copilot"],
    queryFn: () => fetchHistory({}),
    enabled: open,
    staleTime: 10_000,
  });

  const send = useMutation({
    mutationFn: (message: string) => ask({ data: { message } }),
    onMutate: (message) => {
      qc.setQueryData<CopilotMessage[]>(["copilot"], (prev) => [
        ...(prev ?? []),
        {
          id: `tmp-${Date.now()}`,
          role: "user",
          content: message,
          createdAt: new Date().toISOString(),
        },
      ]);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["copilot"] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Copilot failed"),
  });

  const messages = history.data ?? [];

  useEffect(() => {
    boxRef.current?.scrollTo({
      top: guideOpen ? 0 : boxRef.current.scrollHeight,
      behavior: guideOpen ? "instant" : "smooth",
    });
  }, [messages.length, send.isPending, guideOpen]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, send.isPending]);

  function submit(text: string) {
    const value = text.trim();
    if (!value || send.isPending) return;
    setDraft("");
    send.mutate(value);
  }

  if (!open) {
    return (
      <Button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open HR copilot"
        className="group fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full bg-foreground/90 px-4 py-3 text-sm font-medium text-background shadow-[0_10px_30px_-12px_color-mix(in_oklab,var(--foreground)_60%,transparent)] backdrop-blur-xl transition-all hover:bg-foreground hover:shadow-[0_16px_40px_-14px_color-mix(in_oklab,var(--primary)_55%,transparent)]"
      >
        <span className="relative flex size-5 items-center justify-center rounded-full bg-primary/90">
          <BrainCircuit className="size-3 text-primary-foreground" />
        </span>
        Copilot
      </Button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex h-[34rem] w-[min(25rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/80 shadow-[0_30px_80px_-30px_color-mix(in_oklab,var(--foreground)_45%,transparent)] backdrop-blur-2xl">
      {/* glossy top sheen */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-primary/10 via-transparent to-transparent"
      />

      <header className="relative flex items-center justify-between border-b border-border/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-primary/90 shadow-[inset_0_1px_0_color-mix(in_oklab,white_45%,transparent)]">
            <BrainCircuit className="size-3.5 text-primary-foreground" />
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold tracking-tight">HR copilot</span>
            <span className="block text-[11px] text-muted-foreground">
              Help and questions ·{" "}
              <Link to="/desk" className="text-primary underline" onClick={() => setOpen(false)}>
                hire with agents
              </Link>
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="View the first-time journey"
            aria-label="View the first-time journey"
            onClick={() => setGuideOpen((value) => !value)}
          >
            <Compass className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Start a fresh conversation"
            aria-label="Start a fresh conversation"
            className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={async () => {
              await reset({});
              qc.setQueryData(["copilot"], []);
            }}
          >
            <RotateCcw className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close copilot"
            className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div ref={boxRef} className="relative flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
        {guideOpen ? (
          <section
            aria-label="First-time journey"
            className="space-y-3 border-b border-border pb-4"
          >
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <Compass className="size-4 text-primary" />
                Your hiring journey
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {showWelcome
                  ? "Welcome to ATSIQ. Follow the story from first setup to an offer ready to release."
                  : "From first setup to an offer ready to release."}{" "}
                Each decision stays with the right person.
              </p>
            </div>
            <ol className="space-y-0.5">
              {FIRST_RUN_JOURNEY.map((step, index) => {
                const allowed =
                  step.access === "org"
                    ? nav.inOrg
                    : step.access === "governance"
                      ? nav.governance
                      : step.access === "approver"
                        ? nav.approver
                        : nav.recruiterView;
                return (
                  <li key={step.to} className="flex gap-2 border-l border-border py-1.5 pl-3">
                    <span className="w-4 shrink-0 font-mono text-xs text-primary">{index + 1}</span>
                    <div className="min-w-0">
                      {allowed ? (
                        <Link
                          to={step.to}
                          onClick={() => setOpen(false)}
                          className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
                        >
                          {step.title}
                          <ChevronRight className="size-3" />
                        </Link>
                      ) : (
                        <span className="font-medium text-foreground">{step.title}</span>
                      )}
                      <p className="text-xs leading-relaxed text-muted-foreground">{step.detail}</p>
                      {!allowed && (
                        <p className="text-xs text-primary">
                          Ask someone with access to complete this step.
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            <Link
              to="/help"
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              <BookOpen className="size-3.5" />
              Read the full user manual
            </Link>
          </section>
        ) : null}
        {messages.length === 0 ? (
          <div className="space-y-4">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Ask about your live pipeline, pool health, interviews or offers — every answer is
              grounded in your organisation's own data.
            </p>
            <div className="space-y-2">
              {PROMPTS.map((p) => (
                <Button
                  type="button"
                  variant="outline"
                  key={p}
                  onClick={() => submit(p)}
                  className="h-auto w-full justify-start whitespace-normal px-3 py-2.5 text-left text-xs leading-snug"
                >
                  {p}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((m) =>
          m.role === "user" ? (
            <div
              key={m.id}
              className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground shadow-[inset_0_1px_0_color-mix(in_oklab,white_35%,transparent)]"
            >
              {m.content}
            </div>
          ) : (
            <div
              key={m.id}
              className="max-w-[94%] whitespace-pre-wrap leading-relaxed text-foreground"
            >
              {m.content}
            </div>
          ),
        )}

        {send.isPending ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.2s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.1s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-primary" />
            <span className="ml-1">Thinking…</span>
          </div>
        ) : null}
      </div>

      <form
        className="relative p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <div className="relative rounded-2xl border border-border/60 bg-background/70 shadow-[inset_0_1px_0_color-mix(in_oklab,white_60%,transparent)] transition-colors focus-within:border-primary/50">
          <textarea
            ref={inputRef}
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            placeholder="Ask your copilot…"
            className="min-h-[3rem] w-full resize-none bg-transparent px-3.5 py-2.5 pr-12 text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Send"
            disabled={send.isPending || !draft.trim()}
            className="absolute bottom-2 right-2 flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[inset_0_1px_0_color-mix(in_oklab,white_40%,transparent)] transition-all hover:brightness-110 disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}
