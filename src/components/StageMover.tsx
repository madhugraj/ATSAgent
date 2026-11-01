/**
 * The single UI entry point for changing a candidate's pipeline stage.
 * Only legal transitions are offered, and closing stages force a reason.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { byKind, masterItemsQuery } from "@/lib/data";
import {
  allowedTransitions,
  REASON_REQUIRED,
  reasonsForStage,
  STAGE_LABEL,
  type Stage,
} from "@/lib/lifecycle";
import { moveStage, moveStages } from "@/lib/lifecycle.functions";
import { withStepUp } from "@/lib/step-up-client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export function StageMover({
  open,
  onOpenChange,
  applicationIds,
  currentStage,
  onDone,
  presetToStage,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** One id for a single move, many for a bulk move. */
  applicationIds: string[];
  /** Known when moving exactly one application — narrows the legal options. */
  currentStage?: Stage;
  onDone?: () => void;
  /** Keyboard shortcuts pre-seed the destination; still fully editable. */
  presetToStage?: Stage | null;
}) {
  const masters = useQuery(masterItemsQuery);
  const move = useServerFn(moveStage);
  const moveMany = useServerFn(moveStages);

  const [toStage, setToStage] = useState<Stage | "">("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setReason("");
      setNote("");
      // An illegal preset (e.g. "shortlisted" while already shortlisted)
      // silently degrades to "Choose a stage", never to an illegal move.
      const legal = currentStage ? allowedTransitions(currentStage) : null;
      setToStage(presetToStage && (!legal || legal.includes(presetToStage)) ? presetToStage : "");
    }
    // Seed only at open, exactly like the reset this replaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A reason belongs to a stage — clearing it when the stage changes keeps them paired.
  useEffect(() => {
    setReason("");
  }, [toStage]);

  const options = useMemo<Stage[]>(() => {
    if (currentStage) return allowedTransitions(currentStage);
    // Bulk move across mixed stages: offer every stage, the server rejects illegal rows.
    return Object.keys(STAGE_LABEL).filter((s) => !["offer", "hired"].includes(s)) as Stage[];
  }, [currentStage]);

  // Reasons are driven by the destination stage, so the two fields stay logically paired.
  const masterRejectReasons = byKind(masters.data, "rejection_reason").map((r) => r.name);
  const reasons = useMemo(() => {
    if (!toStage) return [];
    const base = reasonsForStage(toStage);
    const extra = toStage === "rejected" ? masterRejectReasons : [];
    return Array.from(new Set([...base, ...extra]));
  }, [toStage, masterRejectReasons.join("|")]);
  const needsReason = toStage ? REASON_REQUIRED.includes(toStage) : false;

  async function submit() {
    if (!toStage) return;
    setBusy(true);
    try {
      if (applicationIds.length === 1) {
        await move({
          data: {
            applicationId: applicationIds[0]!,
            toStage,
            reason: reason || null,
            note: note || null,
          },
        });
        toast.success(`Moved to ${STAGE_LABEL[toStage]}`);
      } else {
        // Bulk rejection asks for the password first (step-up).
        const out = await withStepUp(() =>
          moveMany({
            data: { applicationIds, toStage, reason: reason || null, note: note || null },
          }),
        );
        if (out.blocked > 0)
          toast.warning(
            `${out.moved} moved · ${out.blocked} skipped (transition not allowed from their stage)`,
          );
        else toast.success(`${out.moved} moved to ${STAGE_LABEL[toStage]}`);
      }
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Stage change failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move stage</DialogTitle>
          <DialogDescription>
            {applicationIds.length === 1
              ? `Currently ${currentStage ? STAGE_LABEL[currentStage] : "—"}. Every change is written to the audit trail.`
              : `${applicationIds.length} applications selected. Rows whose current stage disallows the move are skipped.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="mb-1.5 block text-xs text-muted-foreground">New stage</Label>
            <Select value={toStage} onValueChange={(v) => setToStage(v as Stage)}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a stage" />
              </SelectTrigger>
              <SelectContent>
                {options.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STAGE_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="mb-1.5 block text-xs text-muted-foreground">
              Reason {needsReason ? <span className="text-destructive">*</span> : "(optional)"}
            </Label>
            <Select
              value={reason}
              onValueChange={setReason}
              disabled={!toStage || reasons.length === 0}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    !toStage
                      ? "Choose the new stage first"
                      : reasons.length === 0
                        ? "No reason needed — add a note instead"
                        : `Why ${STAGE_LABEL[toStage]}?`
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {reasons.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="mb-1.5 block text-xs text-muted-foreground">Note</Label>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !toStage || (needsReason && !reason)}>
            {busy ? "Saving…" : "Move stage"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
