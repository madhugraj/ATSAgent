import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { decidePlanProposal, listPlanProposals } from "@/lib/interview-plan.functions";
import { sharesOf, type PlanRoundT } from "@/lib/interview-plan";

const STATUS: Record<string, string> = {
  reviewing: "Being reviewed",
  awaiting_approval: "Waiting for the hiring manager",
  approved: "Approved",
  rejected: "Rejected",
};

/** What changed in a round, competency by competency, with each one's share of the overall. */
function Diff({ before, after }: { before: PlanRoundT; after: PlanRoundT }) {
  const was = sharesOf(before);
  const is = sharesOf(after);
  const names = [...new Set([...before.competencies, ...after.competencies])];
  const pct = (n: number | undefined) => (n === undefined ? "—" : `${Math.round(n * 100)}%`);
  return (
    <div className="space-y-1 text-xs">
      {before.focus !== after.focus ? (
        <p>
          <span className="text-muted-foreground line-through">{before.focus}</span>
          <br />
          {after.focus}
        </p>
      ) : null}
      <table className="w-full">
        <tbody>
          {names.map((c) => {
            const k = c.toLowerCase();
            const gone = !(k in is);
            const added = !(k in was);
            return (
              <tr key={c} className={gone ? "text-muted-foreground line-through" : ""}>
                <td className="py-0.5">
                  {c}
                  {added ? <span className="ml-1 text-primary">new</span> : null}
                </td>
                <td className="text-right tabular-nums">
                  {pct(was[k])} → {pct(is[k])}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Panelists' proposed scorecard changes for the role, with the AI review and the decision. */
export function PlanProposals({ requisitionId }: { requisitionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["plan_proposals", requisitionId],
    queryFn: () => listPlanProposals({ data: { requisitionId } }),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (!q.data?.length) return null;

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    try {
      const r = await decidePlanProposal({
        data: { proposalId: id, approve, note: notes[id]?.trim() || null },
      });
      if (!r.ok) toast.error(r.error);
      else toast.success(approve ? "Change applied to the plan" : "Change rejected");
      await qc.invalidateQueries({ queryKey: ["plan_proposals", requisitionId] });
      await qc.invalidateQueries({ queryKey: ["interview_plan", requisitionId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the decision");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold">Panel proposals</h4>
      {q.data.map((p) => (
        <div key={p.id} className="space-y-2 rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              L{p.level} · {p.name ?? p.email}
            </span>
            <Badge variant="outline">{STATUS[p.status] ?? p.status}</Badge>
            {p.review ? (
              <Badge variant={p.review.verdict === "fits" ? "secondary" : "destructive"}>
                {p.review.verdict === "fits" ? "Fits the job" : "Concerns"}
              </Badge>
            ) : p.status === "awaiting_approval" ? (
              <Badge variant="outline">Not reviewed</Badge>
            ) : null}
          </div>
          <p className="text-xs italic">“{p.reason}”</p>
          <Diff before={p.before} after={p.round} />
          {p.review ? (
            <div className="text-xs">
              <p>{p.review.summary}</p>
              {p.review.findings.length ? (
                <ul className="mt-1 list-disc pl-4">
                  {p.review.findings.map((f, n) => (
                    <li key={n}>
                      <span className="capitalize">{f.kind}</span>: {f.text}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {p.status === "awaiting_approval" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 max-w-xs text-xs"
                maxLength={500}
                placeholder="Note to the panelist (optional)"
                value={notes[p.id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [p.id]: e.target.value }))}
              />
              <Button size="sm" disabled={busy === p.id} onClick={() => void decide(p.id, true)}>
                {busy === p.id ? <Loader2 className="size-4 animate-spin" /> : null} Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === p.id}
                onClick={() => void decide(p.id, false)}
              >
                Reject
              </Button>
            </div>
          ) : p.decisionNote ? (
            <p className="text-xs text-muted-foreground">{p.decisionNote}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
