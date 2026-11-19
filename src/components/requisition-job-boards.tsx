/**
 * "Job boards" panel on the requisition page: publish the approved role to the
 * partner boards (LinkedIn / Indeed / Naukri) and track each posting. Sits
 * next to the LinkedIn feed-post designer — that one always works; this panel
 * files structured listings and reports honestly when a board's enterprise
 * contract is not open yet.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2 } from "lucide-react";

import { boardPostingStatus, closeBoardPosting, publishToBoard } from "@/lib/boards.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type PostingStatus = Awaited<ReturnType<typeof boardPostingStatus>>;

const PROVIDER_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  indeed: "Indeed",
  naukri: "Naukri",
};

const STATUS_STYLE: Record<string, string> = {
  published: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/15 text-destructive",
  closed: "bg-muted text-muted-foreground",
  withdrawn: "bg-muted text-muted-foreground",
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};

export function JobBoardsSection({
  requisitionId,
  approved,
}: {
  requisitionId: string;
  approved: boolean;
}) {
  const runStatus = useServerFn(boardPostingStatus);
  const runPublish = useServerFn(publishToBoard);
  const runClose = useServerFn(closeBoardPosting);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["board_postings", requisitionId],
    queryFn: () => runStatus({ data: { requisitionId } }),
  });
  const data = q.data as PostingStatus | undefined;

  async function act(provider: string, fn: "publish" | "close") {
    setBusy(`${provider}:${fn}`);
    try {
      if (fn === "publish") {
        await runPublish({
          data: { requisitionId, provider: provider as "linkedin" | "indeed" | "naukri" },
        });
        toast.success(`Published to ${PROVIDER_LABEL[provider] ?? provider}`);
      } else {
        await runClose({
          data: {
            requisitionId,
            provider: provider as "linkedin" | "indeed" | "naukri",
            reason: "closed",
          },
        });
        toast.success(`Posting closed on ${PROVIDER_LABEL[provider] ?? provider}`);
      }
      await queryClient.invalidateQueries({ queryKey: ["board_postings", requisitionId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The board did not accept that.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel p-5" data-testid="job-boards-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Job boards</h2>
          <p className="text-xs text-muted-foreground">
            {approved
              ? "File this role on the partner boards' job surfaces. Applicants they deliver land in this pipeline automatically."
              : "Available once the requisition is approved — only approved roles may be listed externally."}
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <a href="/integrations">Board connections</a>
        </Button>
      </div>

      {q.isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking board connections…
        </div>
      ) : q.isError ? (
        <p className="mt-4 text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Board connections could not be loaded."}
        </p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {(data?.providers ?? []).map((p) => {
            const posting = (data?.postings ?? []).find((x) => x.provider === p.provider);
            const canPublish =
              approved &&
              p.enabled &&
              p.ready.posting === true &&
              (!posting || posting.status === "failed" || posting.status === "closed");
            const canClose = posting?.status === "published";
            return (
              <li
                key={p.provider}
                className="rounded-xl border border-border bg-card p-4"
                data-testid={`board-row-${p.provider}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">
                        {PROVIDER_LABEL[p.provider] ?? p.provider}
                      </span>
                      {!p.enabled ? (
                        <Badge variant="outline">Not connected</Badge>
                      ) : p.ready.posting === true ? (
                        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                          Ready
                        </Badge>
                      ) : (
                        <Badge variant="outline">Contract pending</Badge>
                      )}
                      {posting && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${STATUS_STYLE[posting.status] ?? "bg-muted text-muted-foreground"}`}
                        >
                          {posting.status}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {p.ready.detail}
                      {posting?.status === "failed" && posting.lastError
                        ? ` Last attempt: ${posting.lastError}`
                        : ""}
                    </p>
                    {posting?.externalUrl && (
                      <a
                        className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        href={posting.externalUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View listing <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {canPublish && (
                      <Button
                        size="sm"
                        onClick={() => act(p.provider, "publish")}
                        disabled={busy !== null}
                      >
                        {busy === `${p.provider}:publish` ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : null}
                        {posting?.status === "failed" ? "Retry publish" : "Publish"}
                      </Button>
                    )}
                    {canClose && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => act(p.provider, "close")}
                        disabled={busy !== null}
                      >
                        {busy === `${p.provider}:close` ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : null}
                        Close posting
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
