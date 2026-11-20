import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { RotateCw, SkipForward } from "lucide-react";

import { Button } from "@/components/ui/button";
import { resolveWorkflowStep } from "@/lib/org-workflows.functions";

/** Retry or Skip a workflow step whose agent stopped at its run limit. */
export function StoppedStepActions({
  workflowRunId,
  invalidate,
}: {
  workflowRunId: string;
  invalidate: unknown[];
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const act = async (action: "retry" | "skip") => {
    setBusy(true);
    try {
      await resolveWorkflowStep({ data: { workflowRunId, action } });
      toast.success(action === "retry" ? "Trying the step again" : "Skipped");
      await qc.invalidateQueries({ queryKey: invalidate });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not do that");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex gap-2">
      <Button size="sm" className="h-7" disabled={busy} onClick={() => void act("retry")}>
        <RotateCw className="size-3.5" /> Retry step
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={busy}
        onClick={() => void act("skip")}
      >
        <SkipForward className="size-3.5" /> Skip
      </Button>
    </div>
  );
}
