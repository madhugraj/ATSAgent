import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getInterviewPlan, saveInterviewPlan } from "@/lib/interview-plan.functions";
import type { InterviewPlan } from "@/lib/interview-plan";

/** The role's interview rounds, rubric, panel size and verdict policy — view and edit. */
export function InterviewPlanCard({ requisitionId }: { requisitionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["interview_plan", requisitionId],
    queryFn: () => getInterviewPlan({ data: { requisitionId } }),
  });
  const [draft, setDraftState] = useState<InterviewPlan | null>(null);
  // The saved plan's stamp when editing began: a save from an older copy is refused.
  const [base, setBase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rev = q.data?.rev;
  // The plan was saved elsewhere (another card, the full editor, an agent): an open
  // draft of the older plan is dropped, so every card shows the same plan.
  useEffect(() => {
    if (draft && base && rev && rev !== base) {
      setDraftState(null);
      setBase(null);
      toast.info("The interview plan was changed elsewhere — showing the latest.");
    }
  }, [rev, base, draft]);
  const setDraft = (next: InterviewPlan | null) => {
    if (next && !draft) setBase(rev ?? null);
    if (!next) setBase(null);
    setDraftState(next);
  };
  if (q.isLoading || !q.data)
    return <p className="text-xs text-muted-foreground">Loading the interview plan…</p>;
  const plan = draft ?? q.data.plan;
  const editing = draft !== null;

  async function save(next: InterviewPlan | null) {
    setBusy(true);
    try {
      await saveInterviewPlan({
        data: { requisitionId, plan: next, ...(base ? { basedOn: base } : { basedOn: rev }) },
      });
      toast.success(next ? "Interview plan saved" : "Back to the plan from the must-haves");
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["interview_plan", requisitionId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the plan");
      if (e instanceof Error && /changed since you opened it/.test(e.message)) {
        setDraft(null);
        await qc.invalidateQueries({ queryKey: ["interview_plan", requisitionId] });
      }
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
                <p className="mt-1 text-xs">Rated on: {r.competencies.join(", ")}</p>
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
            <Button size="sm" disabled={busy} onClick={() => void save(plan)}>
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
