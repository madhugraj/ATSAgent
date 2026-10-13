import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ClipboardCheck } from "lucide-react";

import { getAssessmentPolicy, setAssessmentPolicy } from "@/lib/nudges.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const FIELDS = [
  { key: "dueWorkingDays", label: "Due after (working days)", min: 1, max: 15 },
  { key: "firstReminderDays", label: "First reminder after (days)", min: 1, max: 14 },
  { key: "maxReminders", label: "Reminders at most", min: 0, max: 3 },
  { key: "overdueAfterDays", label: "Overdue after the due date (days)", min: 0, max: 14 },
  { key: "closeAfterDays", label: "Link closes after (days)", min: 2, max: 30 },
] as const;
type Key = (typeof FIELDS)[number]["key"];

/** The organisation's written-assessment timeline (what candidates are told and what follows). */
export function AssessmentPolicyCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["assessment_policy"], queryFn: () => getAssessmentPolicy() });
  const [draft, setDraft] = useState<Partial<Record<Key, string>>>({});
  const [busy, setBusy] = useState(false);
  if (!q.data) return null;
  const value = (k: Key) => draft[k] ?? String(q.data[k]);
  const parsed = Object.fromEntries(FIELDS.map((f) => [f.key, Number(value(f.key))])) as Record<
    Key,
    number
  >;
  const valid = FIELDS.every(
    (f) => Number.isInteger(parsed[f.key]) && parsed[f.key] >= f.min && parsed[f.key] <= f.max,
  );

  async function save() {
    setBusy(true);
    try {
      await setAssessmentPolicy({ data: parsed });
      toast.success("Assessment timeline saved — it applies to assessments sent from now on.");
      setDraft({});
      qc.invalidateQueries({ queryKey: ["assessment_policy"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel space-y-3 p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <ClipboardCheck className="size-4" /> Candidate assessments
      </h2>
      <p className="text-sm text-muted-foreground">
        When a written assessment is sent, the candidate is told this due date. Reminders go out on
        working days; once it is overdue, the Screening agent pops up for TA and HR to give more
        time, screen by phone, or decide without it. When the candidate submits, it is graded at
        once and you decide who moves on.
      </p>
      <div className="grid items-end gap-3 sm:grid-cols-5">
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-1">
            <Label htmlFor={`ap-${f.key}`} className="text-xs">
              {f.label}
            </Label>
            <Input
              id={`ap-${f.key}`}
              inputMode="numeric"
              disabled={!canEdit}
              value={value(f.key)}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value.replace(/\D/g, "") })}
            />
          </div>
        ))}
      </div>
      {canEdit ? (
        <Button
          variant="outline"
          disabled={busy || !valid || Object.keys(draft).length === 0}
          onClick={() => void save()}
        >
          Save timeline
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Only the HR head, the CBO or an owner can change this.
        </p>
      )}
    </section>
  );
}
