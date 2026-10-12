import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { BrainCircuit } from "lucide-react";

import {
  deleteTrainingData,
  getTrainingStatus,
  setTrainingConsent,
} from "@/lib/training.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Whether this organisation's AI work is kept to train a future HR model.
 * Off until an owner agrees; owners can withdraw and delete what was kept.
 */
export function TrainingDataCard({ isOwner }: { isOwner: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["training_status"], queryFn: () => getTrainingStatus() });
  const [days, setDays] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const s = q.data;
  if (!s) return null;
  const retention = days === "" ? s.retentionDays : Number(days);
  const valid = Number.isInteger(retention) && retention >= 30 && retention <= 3650;

  async function save(enabled: boolean) {
    setBusy(true);
    try {
      await setTrainingConsent({ data: { enabled, retentionDays: retention } });
      toast.success(enabled ? "Training-data capture is on." : "Training-data capture is off.");
      qc.invalidateQueries({ queryKey: ["training_status"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  async function wipe() {
    if (
      !window.confirm("Delete all training data kept for this organisation? This cannot be undone.")
    )
      return;
    setBusy(true);
    try {
      const r = await deleteTrainingData();
      toast.success(`Deleted ${r.inferences} model calls and ${r.feedback} judgements.`);
      qc.invalidateQueries({ queryKey: ["training_status"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel space-y-3 p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <BrainCircuit className="size-4" /> Model training data
      </h2>
      <p className="text-sm text-muted-foreground">
        When on, the AI work done for your organisation is kept to train and improve a dedicated HR
        model: every AI request and answer, the agents&apos; steps, and how people judged them —
        approvals, edits, declines with reasons, document checks, scorecards, offer answers and
        final outcomes. It includes candidate data, so it stays off until an owner agrees. Exports
        are pseudonymised; data is deleted after the retention period, with the candidate it belongs
        to, or when you delete it here.
      </p>
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Status</dt>
          <dd className="font-medium">
            {s.enabled
              ? `On${s.consentedAt ? ` since ${new Date(s.consentedAt).toLocaleDateString()}` : ""}`
              : "Off"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">AI requests kept</dt>
          <dd className="num font-medium">{s.inferences.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Judgements kept</dt>
          <dd className="num font-medium">
            {s.feedback.reduce((a, f) => a + f.count, 0).toLocaleString()}
          </dd>
        </div>
      </dl>
      {s.feedback.length ? (
        <p className="text-xs text-muted-foreground">
          {s.feedback.map((f) => `${f.source.replace(/_/g, " ")} ${f.count}`).join(" · ")}
        </p>
      ) : null}
      {isOwner ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="training-retention" className="text-xs">
              Keep for (days, 30–3650)
            </Label>
            <Input
              id="training-retention"
              className="w-32"
              inputMode="numeric"
              value={days === "" ? String(s.retentionDays) : days}
              onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          {s.enabled ? (
            <>
              <Button variant="outline" disabled={busy || !valid} onClick={() => void save(true)}>
                Save retention
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void save(false)}>
                Switch off
              </Button>
            </>
          ) : (
            <Button disabled={busy || !valid} onClick={() => void save(true)}>
              I agree — switch on
            </Button>
          )}
          {s.inferences + s.feedback.length > 0 ? (
            <Button variant="destructive" disabled={busy} onClick={() => void wipe()}>
              Delete kept data
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Only an organisation owner can change this.</p>
      )}
    </section>
  );
}
