/**
 * Organisation scoring template: the weights every new requisition starts from.
 * Six built-ins (0 switches one off) plus up to four of the organisation's own
 * dimensions, totalling 100. "Apply to open roles" pushes it to existing roles
 * through each role's own weight rules.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applyScoringTemplateFn,
  getScoringTemplateFn,
  saveScoringTemplateFn,
} from "@/lib/scoring-template.functions";

type Custom = { key: string; label: string; hint: string; weight: number };
type Template = {
  skills: number;
  experience: number;
  career: number;
  impact: number;
  education: number;
  social: number;
  custom: Custom[];
};

const BUILTINS: [keyof Omit<Template, "custom">, string][] = [
  ["skills", "Skills"],
  ["experience", "Experience"],
  ["career", "Career progression"],
  ["impact", "Impact"],
  ["education", "Education"],
  ["social", "Social"],
];

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 0)));

export function ScoringTemplateCard() {
  const qc = useQueryClient();
  const get = useServerFn(getScoringTemplateFn);
  const save = useServerFn(saveScoringTemplateFn);
  const apply = useServerFn(applyScoringTemplateFn);
  const q = useQuery({ queryKey: ["scoring-template"], queryFn: () => get() });
  const [draft, setDraft] = useState<Template | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data.template);
  }, [q.data]);

  const saveM = useMutation({
    mutationFn: (template: Template | null) => save({ data: { template } }),
    onSuccess: () => {
      toast.success("Scoring template saved");
      void qc.invalidateQueries({ queryKey: ["scoring-template"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });
  const applyM = useMutation({
    mutationFn: () => apply(),
    onSuccess: (r) => {
      const parts = [
        r.applied.length ? `Applied to ${r.applied.join(", ")}` : "",
        r.unchanged.length ? `${r.unchanged.length} already match` : "",
        r.skipped.length
          ? `Skipped ${r.skipped.map((s) => `${s.code} (${s.reason})`).join(", ")}`
          : "",
      ].filter(Boolean);
      toast.success(parts.join(" · ") || "No open roles");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not apply"),
  });

  if (!draft || !q.data) return null;
  const canEdit = q.data.canEdit;
  const total =
    BUILTINS.reduce((s, [k]) => s + draft[k], 0) + draft.custom.reduce((s, d) => s + d.weight, 0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data.template);
  const setCustom = (i: number, patch: Partial<Custom>) =>
    setDraft({ ...draft, custom: draft.custom.map((d, j) => (j === i ? { ...d, ...patch } : d)) });

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {BUILTINS.map(([k, label]) => (
          <label key={k} className="flex items-center justify-between gap-3 text-sm">
            <span className={draft[k] === 0 ? "text-muted-foreground line-through" : ""}>
              {label}
            </span>
            <Input
              type="number"
              min={0}
              max={100}
              disabled={!canEdit}
              value={draft[k]}
              onChange={(e) => setDraft({ ...draft, [k]: clamp(Number(e.target.value)) })}
              className="num h-8 w-20 text-right"
            />
          </label>
        ))}
      </div>

      {draft.custom.map((d, i) => (
        <div key={d.key} className="grid grid-cols-[minmax(0,1fr)_5rem_auto] gap-2">
          <Input
            placeholder="Dimension"
            value={d.label}
            disabled={!canEdit}
            onChange={(e) => setCustom(i, { label: e.target.value })}
            className="h-8"
          />
          <Input
            type="number"
            min={0}
            max={100}
            disabled={!canEdit}
            value={d.weight}
            onChange={(e) => setCustom(i, { weight: clamp(Number(e.target.value)) })}
            className="num h-8 text-right"
          />
          <Button
            size="icon"
            variant="ghost"
            disabled={!canEdit}
            aria-label={`Remove ${d.label || "dimension"}`}
            onClick={() => setDraft({ ...draft, custom: draft.custom.filter((_, j) => j !== i) })}
          >
            <Trash2 className="size-4" />
          </Button>
          <Input
            placeholder="What counts as evidence"
            value={d.hint}
            disabled={!canEdit}
            onChange={(e) => setCustom(i, { hint: e.target.value })}
            className="col-span-3 h-8 text-xs"
          />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        {canEdit && draft.custom.length < 4 ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setDraft({
                ...draft,
                custom: [
                  ...draft.custom,
                  { key: `custom_${Date.now().toString(36)}`, label: "", hint: "", weight: 0 },
                ],
              })
            }
          >
            <Plus className="size-4" /> Add dimension
          </Button>
        ) : null}
        <span
          className={`num ml-auto text-sm ${total === 100 ? "text-muted-foreground" : "font-semibold text-amber-600"}`}
        >
          {total} / 100
        </span>
      </div>

      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!dirty || total !== 100 || saveM.isPending}
            onClick={() => saveM.mutate(draft)}
          >
            Save template
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={dirty || applyM.isPending}
            onClick={() => applyM.mutate()}
          >
            Apply to open roles
          </Button>
          {q.data.isDefault ? null : (
            <Button
              size="sm"
              variant="ghost"
              disabled={saveM.isPending}
              onClick={() => saveM.mutate(null)}
            >
              Reset to platform default
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
