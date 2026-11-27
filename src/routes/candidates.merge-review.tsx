/**
 * Merge review queue (plan row 1): candidate pairs the identity service could
 * not resolve on its own — fuzzy evidence or a shared contact detail — wait
 * here for a person. Merge is a privileged decision (withStepUp) and can be
 * undone; nothing merges automatically.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Check, GitMerge, Loader2, Undo2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, EmptyState } from "@/components/ats";
import { CandidateSide } from "@/components/merge-review";
import {
  decideMergeSuggestionFn,
  listMergeSuggestionsFn,
  undoMergeFn,
  type MergeSuggestionView,
} from "@/lib/candidates.identity.functions";
import { withStepUp } from "@/lib/step-up-client";

export const Route = createFileRoute("/candidates/merge-review")({
  head: () => ({
    meta: [
      { title: "Merge review — ATSIQ" },
      { name: "description", content: "Candidate pairs waiting for a merge decision." },
    ],
  }),
  component: MergeReviewPage,
});

function MergeReviewPage() {
  const q = useQuery({
    queryKey: ["merge_queue"],
    queryFn: () => listMergeSuggestionsFn(),
    refetchInterval: 15_000,
  });
  const pending = q.data?.pending ?? [];
  const decided = q.data?.decided ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Talent pool"
        title="Merge review"
        description="One person, one record: pairs the identity rules could not resolve alone."
      />
      {q.isLoading ? (
        <div className="panel flex items-center gap-2 p-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading
        </div>
      ) : pending.length === 0 && decided.length === 0 ? (
        <EmptyState title="No pairs to review" />
      ) : (
        <div className="space-y-3">
          {pending.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} />
          ))}
          {decided.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionCard({ suggestion }: { suggestion: MergeSuggestionView }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [survivor, setSurvivor] = useState<"a" | "b">(
    // Oldest row wins as the default survivor (design §1.5); the reviewer can swap.
    new Date(suggestion.a.createdAt) <= new Date(suggestion.b.createdAt) ? "a" : "b",
  );
  const pending = suggestion.status === "pending";
  const survivorName = survivor === "a" ? suggestion.a.fullName : suggestion.b.fullName;
  const otherName = survivor === "a" ? suggestion.b.fullName : suggestion.a.fullName;

  async function decide(decision: "merge" | "keep_separate") {
    setBusy(true);
    try {
      await withStepUp(() =>
        decideMergeSuggestionFn({
          data: {
            suggestionId: suggestion.id,
            decision,
            ...(decision === "merge"
              ? { survivorId: survivor === "a" ? suggestion.a.id : suggestion.b.id }
              : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      );
      toast.success(decision === "merge" ? "Merged" : "Kept separate");
      qc.invalidateQueries({ queryKey: ["merge_queue"] });
      qc.invalidateQueries({ queryKey: ["candidates"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the decision");
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!suggestion.mergeId) return;
    setBusy(true);
    try {
      await withStepUp(() => undoMergeFn({ data: { mergeId: suggestion.mergeId! } }));
      toast.success("Merge undone");
      qc.invalidateQueries({ queryKey: ["merge_queue"] });
      qc.invalidateQueries({ queryKey: ["candidates"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not undo the merge");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel p-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <GitMerge className="size-4 text-primary" />
        <Badge variant={pending ? "default" : "outline"}>
          {pending
            ? "Needs your decision"
            : suggestion.status === "merged"
              ? "Merged"
              : suggestion.status === "kept_separate"
                ? "Kept separate"
                : "Stale"}
        </Badge>
        <span>·</span>
        <span className="num">{Math.round(suggestion.score * 100)}%</span>
        <span className="ml-auto num">{new Date(suggestion.createdAt).toLocaleString()}</span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <CandidateSide
          side={suggestion.a}
          survivor={pending && survivor === "a"}
          onPickSurvivor={pending ? () => setSurvivor("a") : undefined}
        />
        <CandidateSide
          side={suggestion.b}
          survivor={pending && survivor === "b"}
          onPickSurvivor={pending ? () => setSurvivor("b") : undefined}
        />
      </div>

      <ul className="mt-3 flex flex-wrap gap-1.5">
        {suggestion.reasons.map((r, i) => (
          <li
            key={i}
            className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
          >
            {r.detail}
          </li>
        ))}
      </ul>

      {pending ? (
        <>
          <Textarea
            className="mt-3"
            rows={2}
            placeholder="Optional note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void decide("merge")}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{" "}
              {"Merge " + otherName + " into " + survivorName}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void decide("keep_separate")}
            >
              <X className="size-4" /> Keep separate
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {suggestion.decisionNote ? (
            <span className="text-xs text-muted-foreground">{suggestion.decisionNote}</span>
          ) : null}
          {suggestion.status === "merged" && suggestion.mergeId ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void undo()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}{" "}
              Undo merge
            </Button>
          ) : null}
          {suggestion.decidedAt ? (
            <span className="ml-auto text-xs text-muted-foreground num">
              {new Date(suggestion.decidedAt).toLocaleString()}
            </span>
          ) : null}
        </div>
      )}
    </article>
  );
}
