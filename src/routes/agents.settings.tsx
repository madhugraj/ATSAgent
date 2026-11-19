import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  CircleCheck,
  CircleX,
  Loader2,
  Pause,
  Search,
  Radio,
  ShieldCheck,
} from "lucide-react";

import { PageHeader } from "@/components/ats";
import { orgWorkflows, type OrgWorkflowRow } from "@/lib/org-workflows.functions";
import { WorkflowRunRequests } from "@/components/agents/AgentTaskCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  AGENT_CATALOG,
  AUTONOMY_OPTIONS,
  WHITELISTABLE_TEMPLATES,
  whitelistableFor,
  type AgentInfo,
} from "@/lib/agents.catalog";
import {
  agentSettings,
  startStudioAgentRun,
  runModelSafetyCheck,
  saveAgentPolicy,
  type AgentPolicyInput,
  type AgentSettingsView,
} from "@/lib/agents.functions";
import {
  agentTelemetry,
  saveAgentTelemetry,
  testAgentTelemetry,
  type AgentTelemetryView,
} from "@/lib/agents-telemetry.functions";

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
        description="Agents are off until you switch them on. Choose how much each hiring agent may do on its own. Approving requisitions, JDs and offers, releasing offers, rejecting candidates and hiring decisions always stay with people, whatever you set here."
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

          <SafetyCheckSection check={data.safetyCheck} canEdit={data.canEdit} />

          <WorkflowsSection
            canEdit={data.canEdit}
            onSwitchOn={(agentType) => save({ agentType, enabled: true })}
          />

          <AgentList
            agents={data.agents}
            allPaused={data.allPaused}
            canEdit={data.canEdit}
            onSave={save}
            onPause={(paused) => save({ agentType: "*", enabled: !paused })}
          />

          <TelemetrySection />
        </>
      )}
    </>
  );
}

const anchorOf = (type: string) => `agent-${type}`;

const FILTERS = ["all", "on", "off", "not_live"] as const;
type AgentFilter = (typeof FILTERS)[number];
const FILTER_LABEL: Record<AgentFilter, string> = {
  all: "All",
  on: "On",
  off: "Off",
  not_live: "Not live",
};
const LEVELS = AUTONOMY_OPTIONS.map((o) => o.value);

type Item = { info: (typeof AGENT_CATALOG)[number]; row: Row };

const stateOf = (row: Row): Exclude<AgentFilter, "all"> =>
  !row.live ? "not_live" : row.enabled ? "on" : "off";

/**
 * Every agent as a card in a grid (status, autonomy and the Enabled switch at a
 * glance); a card opens that agent's full settings in a side panel.
 */
function AgentList({
  agents,
  allPaused,
  canEdit,
  onSave,
  onPause,
}: {
  agents: Row[];
  allPaused: boolean;
  canEdit: boolean;
  onSave: (input: AgentPolicyInput) => Promise<void>;
  onPause: (paused: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [openType, setOpenType] = useState<string | null>(null);
  const items: Item[] = [
    ...AGENT_CATALOG.flatMap((info) => {
      const row = agents.find((a) => a.type === info.type);
      return row ? [{ info, row }] : [];
    }),
    // Agent studio agents the platform granted this organisation.
    ...agents.flatMap((row) =>
      row.studio
        ? [
            {
              info: {
                type: row.type as AgentInfo["type"],
                label: row.studio.label,
                description: row.studio.description,
                phase: 4 as const,
              },
              row,
            },
          ]
        : [],
    ),
  ];
  const count = (f: AgentFilter) =>
    f === "all" ? items.length : items.filter((x) => stateOf(x.row) === f).length;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter(
    ({ info, row }) =>
      (filter === "all" || stateOf(row) === filter) &&
      words.every((w) =>
        [info.label, row.type, info.description].join(" ").toLowerCase().includes(w),
      ),
  );
  const opened = items.find((x) => x.row.type === openType) ?? null;

  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.replace(/^#agent-/, "");
      if (h && agents.some((a) => a.type === h)) setOpenType(h);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [agents]);

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">Agents</h2>
        <div
          role="radiogroup"
          aria-label="Show agents"
          className="inline-flex rounded-full border bg-muted/40 p-0.5"
        >
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                filter === f
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {FILTER_LABEL[f]} <span className="num text-muted-foreground">{count(f)}</span>
            </button>
          ))}
        </div>
        <label
          title="Stops every agent from picking up work. Runs already waiting for a person stay where they are."
          className={`ml-auto flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            allPaused
              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Pause className="size-3.5" />
          {allPaused ? "All agents paused" : "Pause all"}
          <Switch
            className="scale-75"
            aria-label="Pause all agents"
            checked={allPaused}
            disabled={!canEdit}
            onCheckedChange={onPause}
          />
        </label>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search agents"
            placeholder="Search agents"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-8"
          />
        </div>
      </div>

      {shown.length ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((item) => (
            <AgentCard
              key={item.row.type}
              {...item}
              allPaused={allPaused}
              canEdit={canEdit}
              onSave={onSave}
              selected={openType === item.row.type}
              onOpen={() => setOpenType(item.row.type)}
            />
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">No agent matches.</p>
      )}

      <Sheet
        open={!!opened}
        onOpenChange={(o) => {
          if (o) return;
          setOpenType(null);
          if (window.location.hash.startsWith("#agent-"))
            history.replaceState(null, "", window.location.pathname + window.location.search);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {opened ? (
            <AgentSettingsPanel
              key={opened.row.type}
              {...opened}
              canEdit={canEdit}
              onSave={onSave}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

const STATE_STYLE: Record<
  Exclude<AgentFilter, "all"> | "paused",
  { label: string; dot: string; bar: string; chip: string }
> = {
  on: {
    label: "On",
    dot: "bg-emerald-500",
    bar: "bg-emerald-500",
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  paused: {
    label: "Paused",
    dot: "bg-amber-500",
    bar: "bg-amber-500",
    chip: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  off: {
    label: "Off",
    dot: "bg-muted-foreground/50",
    bar: "bg-muted-foreground/30",
    chip: "bg-muted text-muted-foreground",
  },
  not_live: {
    label: "Not live",
    dot: "bg-sky-500",
    bar: "bg-sky-500/60",
    chip: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  },
};

function AgentCard({
  info,
  row,
  allPaused,
  canEdit,
  onSave,
  selected,
  onOpen,
}: Item & {
  allPaused: boolean;
  canEdit: boolean;
  onSave: (input: AgentPolicyInput) => Promise<void>;
  selected: boolean;
  onOpen: () => void;
}) {
  const state = stateOf(row);
  const style = STATE_STYLE[state === "on" && allPaused ? "paused" : state];
  const level = LEVELS.indexOf(row.autonomy);
  const rec = row.enabled ? row.recommendation : null;
  const active = row.live && row.enabled;
  return (
    <article
      id={anchorOf(row.type)}
      onClick={onOpen}
      className={`glass-card group flex cursor-pointer flex-col overflow-hidden p-3.5 pb-4 ${
        selected ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <div className="flex items-center gap-2 text-[0.6875rem]">
        <span className="num font-medium text-muted-foreground">
          {row.studio ? `Studio · v${row.studio.version}` : `Phase ${info.phase}`}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium ${style.chip}`}
        >
          <span className={`size-1.5 rounded-full ${style.dot}`} />
          {style.label}
        </span>
        {rec?.to ? (
          <span
            className={`ml-auto inline-flex items-center gap-0.5 font-medium ${
              rec.action === "lower" ? "text-destructive" : "text-primary"
            }`}
            title={`Recommended: ${rec.action} to ${LEVEL_LABEL[rec.to]}`}
          >
            {rec.action === "lower" ? (
              <ArrowDownRight className="size-3.5" />
            ) : (
              <ArrowUpRight className="size-3.5" />
            )}
            {LEVEL_LABEL[rec.to]}
          </span>
        ) : null}
      </div>

      <h3 className="mt-2.5 text-sm font-semibold leading-snug">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          {info.label}
        </button>
      </h3>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{info.description}</p>

      <div className="mt-auto pt-3">
        <div className="flex items-center justify-between text-[0.6875rem]">
          <span className="text-muted-foreground">Autonomy</span>
          <span className={active ? "font-medium" : "text-muted-foreground"}>
            {LEVEL_LABEL[row.autonomy] ?? row.autonomy}
          </span>
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-1" aria-hidden>
          {LEVELS.map((l, i) => (
            <span
              key={l}
              className={`h-1.5 rounded-full ${
                i <= level ? (active ? "bg-foreground" : "bg-muted-foreground/40") : "bg-muted"
              }`}
            />
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2 border-t border-foreground/5 pt-3">
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <Switch
              id={`en-${row.type}`}
              checked={row.enabled}
              disabled={!canEdit || !row.live}
              onCheckedChange={(enabled) =>
                onSave({
                  agentType: row.type,
                  enabled,
                  autonomy: row.autonomy,
                  whitelistedTemplates: row.whitelistedTemplates,
                })
              }
            />
            <Label htmlFor={`en-${row.type}`} className="text-xs text-muted-foreground">
              Enabled
            </Label>
          </div>
          <Button
            size="icon"
            className="ml-auto size-6 shrink-0 rounded-full"
            aria-label={`Open ${info.label} settings`}
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
      <span className={`absolute inset-x-3.5 bottom-0 h-1 rounded-t-full ${style.bar}`} />
    </article>
  );
}

function AgentSettingsPanel({
  info,
  row,
  canEdit,
  onSave,
}: Item & {
  canEdit: boolean;
  onSave: (input: AgentPolicyInput) => Promise<void>;
}) {
  const [budget, setBudget] = useState(row.monthlyTokenBudget?.toString() ?? "");
  const [legSteps, setLegSteps] = useState(row.maxStepsPerLeg?.toString() ?? "");
  const [legTokens, setLegTokens] = useState(row.maxTokensPerLeg?.toString() ?? "");
  const hint = AUTONOMY_OPTIONS.find((o) => o.value === row.autonomy)?.hint;
  const base = {
    agentType: row.type,
    enabled: row.enabled,
    autonomy: row.autonomy,
    whitelistedTemplates: row.whitelistedTemplates,
  };

  return (
    <>
      <SheetHeader className="pr-8 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle>{info.label}</SheetTitle>
          {row.studio ? <Badge variant="secondary">Studio · v{row.studio.version}</Badge> : null}
          {row.live ? (
            <Badge>Live</Badge>
          ) : (
            <Badge variant="outline">Not live yet — arrives in phase {info.phase}</Badge>
          )}
        </div>
        <SheetDescription>{info.description}</SheetDescription>
      </SheetHeader>

      <div className="mt-4 flex items-center justify-between rounded-lg border px-4 py-3">
        <Label htmlFor={`sheet-en-${row.type}`} className="font-medium">
          Enabled
        </Label>
        <Switch
          id={`sheet-en-${row.type}`}
          checked={row.enabled}
          disabled={!canEdit || !row.live}
          onCheckedChange={(enabled) => onSave({ ...base, enabled })}
        />
      </div>

      {row.recommendation && row.enabled ? (
        <Recommendation row={row} canEdit={canEdit} onSave={onSave} base={base} />
      ) : null}

      <div className="mt-5 space-y-6">
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

        {row.studio ? <StudioRun row={row} canEdit={canEdit} /> : null}

        {(["email", "board"] as const)
          .map((group) => [group, whitelistableFor(row.type, group)] as const)
          .filter(([, items]) => items.length > 0)
          .map(([group, items]) => (
            <div key={group}>
              <Label className="text-xs">
                {group === "email" ? "Pre-approved candidate emails" : "Pre-approved job boards"}
              </Label>
              <div className="mt-2 space-y-1.5">
                {items.map((t) => {
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
                {group === "email"
                  ? "Used at Act and notify. At Autonomous every candidate email template sends on its own."
                  : "Used at Autonomous only. Otherwise every post goes to the HR head for approval, and is published as that HR head."}
              </p>
            </div>
          ))}

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

        <div>
          <Label className="text-xs" htmlFor={`legsteps-${row.type}`}>
            Run limits (per stretch of work)
          </Label>
          <div className="mt-1 grid grid-cols-[1fr_1fr_auto] gap-2">
            <Input
              id={`legsteps-${row.type}`}
              inputMode="numeric"
              aria-label="AI turns per stretch"
              placeholder={`${row.defaultStepsPerLeg} AI turns`}
              value={legSteps}
              disabled={!canEdit}
              onChange={(e) => setLegSteps(e.target.value.replace(/[^0-9]/g, ""))}
            />
            <Input
              inputMode="numeric"
              aria-label="Tokens per stretch"
              placeholder="200000 tokens"
              value={legTokens}
              disabled={!canEdit}
              onChange={(e) => setLegTokens(e.target.value.replace(/[^0-9]/g, ""))}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={() =>
                onSave({
                  ...base,
                  maxStepsPerLeg: legSteps ? Number(legSteps) : null,
                  maxTokensPerLeg: legTokens ? Number(legTokens) : null,
                })
              }
            >
              Save
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            A stretch is the work between two decisions by a person; each decision gives a fresh
            allowance, and a run stops for good at four stretches&apos; worth (a loop guard). Turns
            4–60, tokens 20,000–1,000,000; leave empty for the agent&apos;s default. The monthly
            token budget is still the cost limit.
          </p>
        </div>
      </div>
    </>
  );
}

const LEVEL_LABEL: Record<string, string> = Object.fromEntries(
  AUTONOMY_OPTIONS.map((o) => [o.value, o.label]),
);
const TEMPLATE_LABEL: Record<string, string> = Object.fromEntries(
  WHITELISTABLE_TEMPLATES.map((t) => [t.id, t.label]),
);

/** Measured autonomy recommendation (30 days). Only a person applies it. */
function Recommendation({
  row,
  canEdit,
  onSave,
  base,
}: {
  row: Row;
  canEdit: boolean;
  onSave: (input: AgentPolicyInput) => Promise<void>;
  base: AgentPolicyInput;
}) {
  const r = row.recommendation!;
  const s = r.stats;
  const tone =
    r.action === "lower"
      ? "border-destructive/40 bg-destructive/5"
      : r.action === "raise"
        ? "border-primary/40 bg-primary/5"
        : "border-border bg-muted/30";
  return (
    <div className={`mt-3 rounded-md border p-3 text-sm ${tone}`}>
      <div className="flex flex-wrap items-center gap-2">
        {r.action === "raise" ? (
          <ArrowUpRight className="size-4 text-primary" />
        ) : r.action === "lower" ? (
          <ArrowDownRight className="size-4 text-destructive" />
        ) : null}
        <span className="font-medium">
          {r.action === "raise"
            ? `Recommended: raise to ${LEVEL_LABEL[r.to!]}`
            : r.action === "lower"
              ? `Recommended: lower to ${LEVEL_LABEL[r.to!]}`
              : "Recommendation: keep the current level"}
        </span>
        {r.to && canEdit ? (
          <Button
            size="sm"
            variant={r.action === "lower" ? "destructive" : "default"}
            className="ml-auto h-7"
            onClick={() => onSave({ ...base, autonomy: r.to!, viaRecommendation: true })}
          >
            Apply
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-muted-foreground">{r.reason}</p>
      <p className="num mt-1 text-xs text-muted-foreground">
        Last 30 days: {s.decided} decided request(s) · {s.approvedUnedited} approved unchanged ·{" "}
        {s.edited} edited · {s.rejected} rejected · {s.notifiedActions} reported action(s) ·{" "}
        {s.toolErrors}/{s.toolCalls} tool errors · {s.runsFailed}/{s.runsFinished} failed runs
        {s.daysAtLevel !== null ? ` · ${s.daysAtLevel} day(s) at this level` : ""}
      </p>
      {r.templates.map((t) => (
        <div key={t.id} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span>
            <span className="font-medium">{TEMPLATE_LABEL[t.id] ?? t.id}</span> was approved
            unchanged {t.approvedUnedited} of {t.decided} times — consider pre-approving it.
          </span>
          {canEdit ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6"
              onClick={() =>
                onSave({
                  ...base,
                  whitelistedTemplates: [...row.whitelistedTemplates, t.id],
                  viaRecommendation: true,
                })
              }
            >
              Pre-approve
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Trace export to the org's own OpenTelemetry collector, and alert channels. */
function TelemetrySection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["agent_telemetry"], queryFn: () => agentTelemetry() });
  const t = q.data;
  if (!t) return null;
  return (
    <TelemetryForm
      key={JSON.stringify(t)}
      t={t}
      onSaved={() => qc.invalidateQueries({ queryKey: ["agent_telemetry"] })}
    />
  );
}

function TelemetryForm({ t, onSaved }: { t: AgentTelemetryView; onSaved: () => void }) {
  const [otlpEnabled, setOtlpEnabled] = useState(t.otlpEnabled);
  const [endpoint, setEndpoint] = useState(t.otlpEndpoint ?? "");
  const [headers, setHeaders] = useState("");
  const [emailOn, setEmailOn] = useState(t.alertEmailEnabled);
  const [webhook, setWebhook] = useState(t.alertWebhookUrl ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    let parsedHeaders: Record<string, string> | undefined;
    if (headers.trim()) {
      try {
        parsedHeaders = Object.fromEntries(
          headers
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const i = l.indexOf(":");
              if (i < 1) throw new Error(l);
              return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
            }),
        );
      } catch {
        toast.error("Write one header per line as Name: value");
        return;
      }
    }
    setBusy(true);
    try {
      await saveAgentTelemetry({
        data: {
          otlpEnabled,
          otlpEndpoint: endpoint.trim() || null,
          ...(parsedHeaders ? { otlpHeaders: parsedHeaders } : {}),
          alertEmailEnabled: emailOn,
          alertWebhookUrl: webhook.trim() || null,
          ...(secret.trim() ? { alertWebhookSecret: secret.trim() } : {}),
        },
      });
      toast.success("Saved");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function test(target: "otlp" | "webhook" | "email") {
    setBusy(true);
    try {
      const r = await testAgentTelemetry({ data: { target } });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(false);
    }
  }

  const disabled = !t.canEdit || busy;
  return (
    <Fold
      className="mt-6"
      icon={<Radio className="size-4 text-primary" />}
      title="Trace export and alerts"
      summary={
        <span className="text-xs text-muted-foreground">
          Traces {t.otlpEnabled ? "on" : "off"} · Alert e-mail {t.alertEmailEnabled ? "on" : "off"}
          {t.alertWebhookUrl ? " · Webhook" : ""}
        </span>
      }
    >
      <p className="text-sm text-muted-foreground">
        Send each finished agent run to your own OpenTelemetry collector as a trace (ids, steps,
        timings and token counts only — no candidate content or prompts), and choose how serious and
        critical agent health issues reach you besides the notification bell.
      </p>

      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Switch
              id="otlp-on"
              checked={otlpEnabled}
              disabled={disabled}
              onCheckedChange={setOtlpEnabled}
            />
            <Label htmlFor="otlp-on">Export traces (OTLP/HTTP JSON)</Label>
          </div>
          <div>
            <Label className="text-xs" htmlFor="otlp-endpoint">
              Collector traces address
            </Label>
            <Input
              id="otlp-endpoint"
              className="mt-1"
              placeholder="https://collector.example.com/v1/traces"
              value={endpoint}
              disabled={disabled}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs" htmlFor="otlp-headers">
              Headers (one per line, Name: value){" "}
              {t.otlpHeaderNames.length ? `— saved: ${t.otlpHeaderNames.join(", ")}` : ""}
            </Label>
            <textarea
              id="otlp-headers"
              className="mt-1 min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
              placeholder={
                t.otlpHeaderNames.length ? "Leave empty to keep the saved headers" : "x-api-key: …"
              }
              value={headers}
              disabled={disabled}
              onChange={(e) => setHeaders(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Stored encrypted and never shown again.</p>
          </div>
          <p className="text-xs text-muted-foreground">
            {t.lastExportError
              ? `Last attempt failed: ${t.lastExportError}`
              : t.lastExportAt
                ? `Last export ${new Date(t.lastExportAt).toLocaleString()}`
                : "Nothing exported yet."}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !t.otlpEndpoint}
            onClick={() => test("otlp")}
          >
            Send a test trace
          </Button>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Switch
              id="alert-email"
              checked={emailOn}
              disabled={disabled}
              onCheckedChange={setEmailOn}
            />
            <Label htmlFor="alert-email">E-mail the owner, HR heads and CBOs</Label>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !t.alertEmailEnabled}
            title={t.alertEmailEnabled ? undefined : "Switch on alert e-mail and save first"}
            onClick={() => test("email")}
          >
            Send a test alert e-mail
          </Button>
          <div>
            <Label className="text-xs" htmlFor="alert-webhook">
              Alert webhook (optional — e.g. your paging or chat tool)
            </Label>
            <Input
              id="alert-webhook"
              className="mt-1"
              placeholder="https://hooks.example.com/…"
              value={webhook}
              disabled={disabled}
              onChange={(e) => setWebhook(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs" htmlFor="alert-secret">
              Signing secret{" "}
              {t.hasWebhookSecret ? "(saved — enter a new one to replace it)" : "(16+ characters)"}
            </Label>
            <Input
              id="alert-secret"
              className="mt-1"
              type="password"
              autoComplete="off"
              value={secret}
              disabled={disabled}
              onChange={(e) => setSecret(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Each call carries <code>X-ATSAgent-Signature: sha256=…</code> (HMAC of the body).
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !t.alertWebhookUrl}
            onClick={() => test("webhook")}
          >
            Send a test alert
          </Button>
        </div>
      </div>

      {t.canEdit ? (
        <div className="mt-4 flex justify-end">
          <Button disabled={busy} onClick={save}>
            Save
          </Button>
        </div>
      ) : null}
    </Fold>
  );
}

/** A settings panel that opens on its header; the summary and actions stay visible when closed. */
function Fold({
  icon,
  title,
  summary,
  actions,
  className = "",
  children,
}: {
  icon: ReactNode;
  title: string;
  summary?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section className={`panel ${className}`}>
        <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
            />
            {icon}
            <span className="font-medium">{title}</span>
            {summary}
          </CollapsibleTrigger>
          {actions}
        </div>
        <CollapsibleContent className="border-t px-5 pb-5 pt-4">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/**
 * Model safety check (docs/red-team.md): attacks planted in a test CV are run
 * against the organisation's own AI model. Autonomous needs a pass for the
 * model in use, from the last 30 days.
 */
function SafetyCheckSection({
  check,
  canEdit,
}: {
  check: AgentSettingsView["safetyCheck"];
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "");
  const label: Record<typeof check.status, { text: string; tone: "ok" | "warn" | "bad" }> = {
    none: { text: "Not run yet", tone: "warn" },
    passed: { text: `Passed — valid until ${day(check.validUntil)}`, tone: "ok" },
    failed: { text: `Failed on ${day(check.checkedAt)}`, tone: "bad" },
    expired: { text: `Expired on ${day(check.validUntil)}`, tone: "warn" },
    model_changed: { text: "The AI model changed since the last check", tone: "warn" },
  };
  const s = label[check.status];

  async function run() {
    setBusy(true);
    try {
      const view = await runModelSafetyCheck();
      if (view.status === "passed") toast.success("The model passed every safety probe");
      else toast.error("The model did not pass — Autonomous stays unavailable");
      qc.invalidateQueries({ queryKey: ["agent_settings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The safety check could not run");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Fold
      className="mt-4"
      icon={<ShieldCheck className="size-4 text-muted-foreground" />}
      title="Model safety check"
      summary={
        <Badge
          variant={s.tone === "ok" ? "default" : s.tone === "bad" ? "destructive" : "secondary"}
        >
          {s.text}
        </Badge>
      }
      actions={
        <Button size="sm" variant="outline" onClick={run} disabled={!canEdit || busy}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} Run check
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        Plants {check.results.length || 6} known attacks in a test CV — hidden instructions, fake
        system messages, requests to leak data or reveal instructions — and checks your AI model
        ignores them with this product&apos;s defences on. An agent can be set to Autonomous only
        after a pass for the model you use now; it is valid for 30 days.
      </p>
      {check.results.length ? (
        <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
          {check.results.map((r) => (
            <li key={r.probe} className="flex items-start gap-2">
              <span className={r.complied ? "text-destructive" : "text-emerald-600"}>
                {r.complied ? "✗" : "✓"}
              </span>
              <span>
                {r.title}
                {r.error ? (
                  <span className="text-muted-foreground"> — could not run</span>
                ) : r.complied ? (
                  <span className="text-muted-foreground"> — the model followed the attack</span>
                ) : r.flagged ? (
                  <span className="text-muted-foreground"> — ignored and flagged</span>
                ) : (
                  <span className="text-muted-foreground"> — ignored</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Fold>
  );
}

/** A granted Agent studio agent runs when a person starts it here (workflows come later). */
function StudioRun({ row, canEdit }: { row: Row; canEdit: boolean }) {
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  if (!canEdit) return null;
  const start = async () => {
    setBusy(true);
    try {
      await startStudioAgentRun({ data: { agentType: row.type, goal } });
      toast.success("Started — follow it in Agent activity");
      setGoal("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <Label className="text-xs" htmlFor={`studio-goal-${row.type}`}>
        Start a run
      </Label>
      <Textarea
        id={`studio-goal-${row.type}`}
        className="mt-1 min-h-20"
        placeholder="What should it do?"
        value={goal}
        maxLength={4000}
        onChange={(e) => setGoal(e.target.value)}
      />
      <Button
        size="sm"
        className="mt-2"
        disabled={busy || !row.enabled || goal.trim().length < 5}
        onClick={start}
      >
        {busy ? "Starting…" : "Start"}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------- workflows */

const triggerLabel = (t: string) =>
  t === "manual"
    ? "Started by the platform team (hiring need)"
    : `Starts on ${t.replace(/[._]/g, " ")}`;

/**
 * Workflows the platform granted this organisation: what each needs before it
 * can run here, with a switch-on shortcut, and its latest runs.
 */
function WorkflowsSection({
  canEdit,
  onSwitchOn,
}: {
  canEdit: boolean;
  onSwitchOn: (agentType: string) => Promise<void>;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["org_workflows"],
    queryFn: () => orgWorkflows(),
    retry: false,
    enabled: canEdit,
  });
  if (!canEdit || !q.data?.length) return null;
  const switchOn = async (type: string) => {
    await onSwitchOn(type);
    await qc.invalidateQueries({ queryKey: ["org_workflows"] });
  };
  return (
    <section id="workflows" className="mt-6 space-y-3">
      <h2 className="text-sm font-semibold">Workflows</h2>
      {q.data.map((w) => (
        <WorkflowCard key={w.id} w={w} onSwitchOn={switchOn} />
      ))}
    </section>
  );
}

function WorkflowCard({
  w,
  onSwitchOn,
}: {
  w: OrgWorkflowRow;
  onSwitchOn: (agentType: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const qc = useQueryClient();
  return (
    <div className="panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{w.name}</span>
        <Badge variant="secondary">v{w.version}</Badge>
        <Badge variant={w.ready ? "default" : "outline"}>{w.ready ? "Live" : "Not ready"}</Badge>
        <span className="ml-auto text-xs text-muted-foreground">{triggerLabel(w.trigger)}</span>
        <Button asChild size="sm" className="h-7">
          <Link to="/w/$workflowId" params={{ workflowId: w.id }}>
            Open
          </Link>
        </Button>
      </div>
      {w.description ? <p className="mt-1 text-sm text-muted-foreground">{w.description}</p> : null}
      <ul className="mt-3 divide-y rounded-md border text-sm">
        {w.items.map((i) => {
          const type = i.key.startsWith("agent:") ? i.key.slice(6) : null;
          return (
            <li key={i.key} className="flex items-center gap-2 px-3 py-1.5">
              {i.ok ? (
                <CircleCheck className="size-4 text-emerald-600" />
              ) : (
                <CircleX className="size-4 text-destructive" />
              )}
              <span className="flex-1">{i.label}</span>
              <span className="text-xs text-muted-foreground">{i.detail}</span>
              {!i.ok && type ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={busy === type}
                  onClick={async () => {
                    setBusy(type);
                    try {
                      await onSwitchOn(type);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Switch on
                </Button>
              ) : null}
              {!i.ok && i.key === "ai_key" ? (
                <Button asChild size="sm" variant="outline" className="h-7">
                  <Link to="/integrations">Add key</Link>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {w.runs.length ? (
        <ul className="mt-3 space-y-1 text-xs">
          {w.runs.map((r) => (
            <li key={r.id} className="space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-5">
                  {r.status}
                </Badge>
                <span className="text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
                <span className="truncate">{r.error ?? r.waitingOn?.text ?? r.lastNote ?? ""}</span>
              </div>
              {r.waitingOn?.kind === "person" ? (
                <WorkflowRunRequests
                  workflowRunId={r.id}
                  onDecided={() => void qc.invalidateQueries({ queryKey: ["org_workflows"] })}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
