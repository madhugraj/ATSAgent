/**
 * The Team page's "Interviews" cell (docs/interview-panel-plan.md, P0): whether
 * a member interviews, the areas they assess, the rounds they take and their
 * weekly limit — set once by the owner, the CBO or the HR head.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { setInterviewerProfile } from "@/lib/interviewers.functions";

export type InterviewerProfileView = {
  active: boolean;
  areas: string[];
  rounds: number[];
  weeklyCap: number;
};

export function InterviewerProfileCell(props: {
  memberId: string;
  name: string;
  profile: InterviewerProfileView | undefined;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const save = useServerFn(setInterviewerProfile);
  const p = props.profile ?? { active: false, areas: [], rounds: [1, 2, 3], weeklyCap: 4 };
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(p);
  const [areasText, setAreasText] = useState(p.areas.join(", "));
  const [busy, setBusy] = useState(false);

  function start() {
    setDraft(p);
    setAreasText(p.areas.join(", "));
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    try {
      await save({
        data: {
          memberId: props.memberId,
          profile: {
            ...draft,
            areas: areasText
              .split(/[,;\n]/)
              .map((a) => a.trim())
              .filter(Boolean),
          },
        },
      });
      toast.success("Interviewer profile saved");
      await qc.invalidateQueries({ queryKey: ["interviewer_profiles"] });
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {p.active ? (
          <>
            <Badge variant="outline" className="text-[10px]">
              {p.rounds.map((r) => `L${r}`).join(" · ")}
            </Badge>
            {p.areas.slice(0, 3).map((a) => (
              <Badge key={a} variant="secondary" className="text-[10px]">
                {a}
              </Badge>
            ))}
            {p.areas.length > 3 ? (
              <span className="text-xs text-muted-foreground">+{p.areas.length - 3}</span>
            ) : null}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
        {props.canEdit ? (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={start}>
            {p.active ? "Edit" : "Set up"}
          </Button>
        ) : null}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Interviewer — {props.name}</DialogTitle>
            <DialogDescription>
              Panels for each role and round are proposed from the people who interview here,
              matched to the round's focus, and approved by the role's hiring manager.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="ip-active">Interviews candidates</Label>
              <Switch
                id="ip-active"
                checked={draft.active}
                onCheckedChange={(active) => setDraft({ ...draft, active })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ip-areas">Areas they assess</Label>
              <Input
                id="ip-areas"
                value={areasText}
                placeholder="e.g. Machine learning, MLOps, System design, Leadership"
                onChange={(e) => setAreasText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Separate with commas. Matched against each round's competencies.
              </p>
            </div>
            <div className="space-y-1">
              <Label>Rounds they take</Label>
              <div className="flex gap-4">
                {[1, 2, 3].map((r) => (
                  <label key={r} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.rounds.includes(r)}
                      onCheckedChange={(on) =>
                        setDraft({
                          ...draft,
                          rounds: on
                            ? [...draft.rounds, r].sort()
                            : draft.rounds.filter((x) => x !== r),
                        })
                      }
                    />
                    L{r}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ip-cap">Interviews a week, at most</Label>
              <Input
                id="ip-cap"
                type="number"
                min={1}
                max={20}
                className="w-24"
                value={draft.weeklyCap}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    weeklyCap: Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                  })
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !draft.rounds.length} onClick={() => void submit()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
