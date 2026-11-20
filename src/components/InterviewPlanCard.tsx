import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getInterviewPlan, saveInterviewPlan } from "@/lib/interview-plan.functions";
import { pruneRubric, weightOf, type InterviewPlan } from "@/lib/interview-plan";
import { PlanProposals } from "./PlanProposals";

/** The role's interview rounds, rubric, panel size and verdict policy — view and edit. */
export function InterviewPlanCard({ requisitionId }: { requisitionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["interview_plan", requisitionId],
    queryFn: () => getInterviewPlan({ data: { requisitionId } }),
  });
  const [draft, setDraft] = useState<InterviewPlan | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading || !q.data)
    return <p className="text-xs text-muted-foreground">Loading the interview plan…</p>;
  const plan = draft ?? q.data.plan;
  const editing = draft !== null;

  async function save(next: InterviewPlan | null) {
    setBusy(true);
    try {
      await saveInterviewPlan({ data: { requisitionId, plan: next } });
      toast.success(next ? "Interview plan saved" : "Back to the plan from the must-haves");
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["interview_plan", requisitionId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the plan");
    } finally {
      setBusy(false);
    }
  }
  const setRound = (i: number, patch: Partial<InterviewPlan["rounds"][number]>) =>
    setDraft({
      ...plan,
      rounds: plan.rounds.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    });

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{plan.rounds.length} round(s)</Badge>
        <Badge variant="outline">
          {plan.verdictPolicy === "recommend"
            ? "Interviewer verdicts are recommendations"
            : "Interviewer verdicts move the candidate"}
        </Badge>
        {!q.data.saved ? (
          <span className="text-xs text-muted-foreground">Default from the must-haves</span>
        ) : null}
      </div>
      {editing ? null : <PlanProposals requisitionId={requisitionId} />}
      <ol className="space-y-3">
        {plan.rounds.map((r, i) => (
          <li key={r.level} className="rounded-md border border-border p-3">
            {editing ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    value={r.name}
                    onChange={(e) => setRound(i, { name: e.target.value })}
                    aria-label={`Round ${r.level} name`}
                  />
                  <select
                    className="rounded-md border border-border bg-background px-2 text-xs"
                    value={r.panelSize}
                    onChange={(e) => setRound(i, { panelSize: Number(e.target.value) })}
                    aria-label={`Round ${r.level} panel size`}
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n} interviewer{n > 1 ? "s" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <Input
                  value={r.focus}
                  onChange={(e) => setRound(i, { focus: e.target.value })}
                  placeholder="What this round is for"
                  aria-label={`Round ${r.level} focus`}
                />
                <Label className="text-xs text-muted-foreground">
                  Competencies (comma separated)
                  <Input
                    className="mt-1"
                    value={r.competencies.join(", ")}
                    onChange={(e) =>
                      setRound(i, {
                        competencies: e.target.value
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Label>
                <RubricEditor round={r} onChange={(patch) => setRound(i, patch)} />
              </div>
            ) : (
              <>
                <p className="font-medium">
                  L{r.level} · {r.name}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    · {r.panelSize} interviewer{r.panelSize > 1 ? "s" : ""}
                  </span>
                </p>
                {r.focus ? <p className="text-xs text-muted-foreground">{r.focus}</p> : null}
                <p className="mt-1 text-xs">
                  Rated on:{" "}
                  {r.competencies
                    .map((c) => (weightOf(r, c) > 1 ? `${c} ×${weightOf(r, c)}` : c))
                    .join(", ")}
                </p>
              </>
            )}
          </li>
        ))}
      </ol>
      {editing ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={plan.rounds.length >= 3}
              onClick={() =>
                setDraft({
                  ...plan,
                  rounds: [
                    ...plan.rounds,
                    {
                      level: plan.rounds.length + 1,
                      name: "Further round",
                      focus: "",
                      competencies: ["Judgement"],
                      panelSize: 1,
                    },
                  ],
                })
              }
            >
              <Plus className="size-4" /> Add a round
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={plan.rounds.length <= 1}
              onClick={() => setDraft({ ...plan, rounds: plan.rounds.slice(0, -1) })}
            >
              <Trash2 className="size-4" /> Remove the last round
            </Button>
          </div>
          <Label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={plan.verdictPolicy === "recommend"}
              onChange={(e) =>
                setDraft({ ...plan, verdictPolicy: e.target.checked ? "recommend" : "immediate" })
              }
            />
            A hold or reject from the interviewers is a recommendation — the hiring manager decides
          </Label>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void save(pruneRubric(plan))}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null} Save plan
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setDraft(plan)}>
            Edit plan
          </Button>
          {q.data.saved ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
              Reset to the default
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

type Round = InterviewPlan["rounds"][number];

/** Per competency: its weight toward the overall and what a 1, 3 and 5 look like. */
function RubricEditor({
  round,
  onChange,
}: {
  round: Round;
  onChange: (patch: Partial<Round>) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorOf = (c: string) => round.anchors?.[c] ?? { low: "", mid: "", high: "" };
  return (
    <div>
      <button
        type="button"
        className="text-xs font-medium text-primary"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Hide" : "Weights and rating guide"}
      </button>
      {open ? (
        <div className="mt-2 space-y-3">
          {round.competencies.map((c) => {
            const a = anchorOf(c);
            const setAnchor = (k: "low" | "mid" | "high", v: string) =>
              onChange({ anchors: { ...round.anchors, [c]: { ...a, [k]: v } } });
            return (
              <div key={c} className="space-y-1.5 rounded border border-border p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{c}</span>
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                    value={weightOf(round, c)}
                    aria-label={`${c} weight`}
                    onChange={(e) =>
                      onChange({ weights: { ...round.weights, [c]: Number(e.target.value) } })
                    }
                  >
                    {[...new Set([1, 2, 3, 4, 5, weightOf(round, c)])].map((n) => (
                      <option key={n} value={n}>
                        ×{n}
                      </option>
                    ))}
                  </select>
                </div>
                {(
                  [
                    ["low", "1"],
                    ["mid", "3"],
                    ["high", "5"],
                  ] as const
                ).map(([k, label]) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="w-3 text-xs font-medium text-muted-foreground">{label}</span>
                    <Input
                      className="h-8 text-xs"
                      maxLength={200}
                      value={a[k]}
                      aria-label={`${c}: what a ${label} looks like`}
                      onChange={(e) => setAnchor(k, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
