import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { PauseCircle } from "lucide-react";

import { PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AGENT_CATALOG, AUTONOMY_OPTIONS, WHITELISTABLE_TEMPLATES } from "@/lib/agents.catalog";
import {
  agentSettings,
  saveAgentPolicy,
  type AgentPolicyInput,
  type AgentSettingsView,
} from "@/lib/agents.functions";

export const Route = createFileRoute("/agents/settings")({
  head: () => ({
    meta: [
      { title: "Agent settings — ATSIQ" },
      {
        name: "description",
        content: "How much each hiring agent may do on its own in this organisation.",
      },
    ],
  }),
  component: AgentSettingsPage,
});

type Row = AgentSettingsView["agents"][number];

function AgentSettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["agent_settings"], queryFn: () => agentSettings() });
  const data = q.data;

  async function save(input: AgentPolicyInput) {
    try {
      await saveAgentPolicy({ data: input });
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["agent_settings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Agent settings"
        description="Choose how much each hiring agent may do on its own. Approving requisitions, JDs and offers, releasing offers, rejecting candidates and hiring decisions always stay with people, whatever you set here."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/agents">Agent decisions</Link>
          </Button>
        }
      />

      {q.isLoading || !data ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {!data.canEdit ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Only the HR head, President / CBO or the account owner can change these settings.
            </p>
          ) : null}

          <section className="panel mt-4 flex flex-wrap items-center gap-3 p-5">
            <PauseCircle className="size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Pause all agents</p>
              <p className="text-sm text-muted-foreground">
                Stops every agent in this organisation from picking up work. Runs already waiting
                for a person stay where they are.
              </p>
            </div>
            <Switch
              checked={data.allPaused}
              disabled={!data.canEdit}
              onCheckedChange={(paused) => save({ agentType: "*", enabled: !paused })}
            />
          </section>

          <div className="mt-4 space-y-3">
            {AGENT_CATALOG.map((info) => {
              const row = data.agents.find((a) => a.type === info.type);
              return row ? (
                <AgentRow
                  key={info.type}
                  info={info}
                  row={row}
                  canEdit={data.canEdit}
                  onSave={save}
                />
              ) : null;
            })}
          </div>
        </>
      )}
    </>
  );
}

function AgentRow({
  info,
  row,
  canEdit,
  onSave,
}: {
  info: (typeof AGENT_CATALOG)[number];
  row: Row;
  canEdit: boolean;
  onSave: (input: AgentPolicyInput) => Promise<void>;
}) {
  const [budget, setBudget] = useState(row.monthlyTokenBudget?.toString() ?? "");
  const hint = AUTONOMY_OPTIONS.find((o) => o.value === row.autonomy)?.hint;
  const base = {
    agentType: row.type,
    enabled: row.enabled,
    autonomy: row.autonomy,
    whitelistedTemplates: row.whitelistedTemplates,
  };

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{info.label}</h3>
        {row.live ? (
          <Badge>Live</Badge>
        ) : (
          <Badge variant="outline">Not live yet — arrives in phase {info.phase}</Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor={`en-${row.type}`} className="text-xs text-muted-foreground">
            Enabled
          </Label>
          <Switch
            id={`en-${row.type}`}
            checked={row.enabled}
            disabled={!canEdit}
            onCheckedChange={(enabled) => onSave({ ...base, enabled })}
          />
        </div>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{info.description}</p>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div>
          <Label className="text-xs">Autonomy</Label>
          <Select
            value={row.autonomy}
            disabled={!canEdit}
            onValueChange={(v) => onSave({ ...base, autonomy: v as Row["autonomy"] })}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTONOMY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>

        <div>
          <Label className="text-xs">Pre-approved candidate emails</Label>
          <div className="mt-2 space-y-1.5">
            {WHITELISTABLE_TEMPLATES.map((t) => {
              const on = row.whitelistedTemplates.includes(t.id);
              return (
                <label key={t.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={on}
                    disabled={!canEdit}
                    onCheckedChange={(v) =>
                      onSave({
                        ...base,
                        whitelistedTemplates: v
                          ? [...row.whitelistedTemplates, t.id]
                          : row.whitelistedTemplates.filter((x) => x !== t.id),
                      })
                    }
                  />
                  {t.label}
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Used only when autonomy is above Suggest.
          </p>
        </div>

        <div>
          <Label className="text-xs" htmlFor={`budget-${row.type}`}>
            Monthly token budget
          </Label>
          <div className="mt-1 flex gap-2">
            <Input
              id={`budget-${row.type}`}
              inputMode="numeric"
              placeholder="No limit"
              value={budget}
              disabled={!canEdit}
              onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ""))}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={() =>
                onSave({ ...base, monthlyTokenBudget: budget ? Number(budget) : null })
              }
            >
              Save
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Leave empty for no limit.</p>
        </div>
      </div>
    </section>
  );
}
