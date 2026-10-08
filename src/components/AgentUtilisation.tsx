import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Eye, Lightbulb, PiggyBank } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  agentUtilisation,
  saveAgentCostRate,
  type UtilisationView,
} from "@/lib/agents-observability.functions";
import { AGENT_LABEL } from "@/lib/agents.catalog";

/**
 * Utilisation & efficiency: day-wise tokens (or cost at the organisation's own
 * rate) and time, per-agent efficiency, and what to change to save cost and
 * time. Colours follow the agent, never its rank: the five core pipeline
 * agents keep fixed validated slots, the rest are grouped as "Other agents".
 */
const SLOT = [
  { light: "#2a78d6", dark: "#3987e5" },
  { light: "#eb6834", dark: "#d95926" },
  { light: "#1baf7a", dark: "#199e70" },
  { light: "#eda100", dark: "#c98500" },
  { light: "#e87ba4", dark: "#d55181" },
];
const NEUTRAL = { light: "#a3a29c", dark: "#6b6a65" };
const CORE = ["requisition", "jd", "intake", "screening", "evaluation"] as const;
const OTHER = "other";

const seriesConfig: ChartConfig = Object.fromEntries([
  ...CORE.map((k, i) => [k, { label: AGENT_LABEL[k] ?? k, theme: SLOT[i]! }]),
  [OTHER, { label: "Other agents", theme: NEUTRAL }],
]);
const timeConfig = {
  agentHours: { label: "Agents working", theme: SLOT[0]! },
  waitHours: { label: "Waiting for people", theme: SLOT[1]! },
} satisfies ChartConfig;

const compact = (v: number) =>
  Math.abs(v) >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)}M`
    : Math.abs(v) >= 1_000
      ? `${(v / 1_000).toFixed(1)}K`
      : String(Math.round(v * 100) / 100);
const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const money = (v: number | null, currency: string) =>
  v == null
    ? "—"
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: v < 1 ? 3 : 2,
      }).format(v);

export function AgentUtilisation() {
  const [days, setDays] = useState<14 | 30>(30);
  const [unit, setUnit] = useState<"tokens" | "cost">("tokens");
  const q = useQuery({
    queryKey: ["agent_utilisation", days],
    queryFn: () => agentUtilisation({ data: { days } }),
    refetchInterval: 60_000,
    retry: false,
  });
  const u = q.data;
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Utilisation &amp; efficiency · last {days} days
        </p>
        <div className="ml-auto flex gap-1">
          {u?.rate
            ? (["tokens", "cost"] as const).map((x) => (
                <Button
                  key={x}
                  size="sm"
                  variant={unit === x ? "default" : "outline"}
                  className="h-7"
                  onClick={() => setUnit(x)}
                >
                  {x === "tokens" ? "Tokens" : `Cost (${u.rate!.currency})`}
                </Button>
              ))
            : null}
          {([14, 30] as const).map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? "default" : "outline"}
              className="h-7"
              onClick={() => setDays(d)}
            >
              {d} days
            </Button>
          ))}
        </div>
      </div>
      {!u ? (
        <p className="panel p-4 text-sm text-muted-foreground">
          {q.error instanceof Error ? q.error.message : "Loading…"}
        </p>
      ) : (
        <UtilisationBody u={u} unit={u.rate ? unit : "tokens"} />
      )}
    </section>
  );
}

function UtilisationBody({ u, unit }: { u: UtilisationView; unit: "tokens" | "cost" }) {
  const rate = u.rate;
  // Cost per day uses the day's input / output split at the organisation's rate.
  const perToken =
    rate && (u.totals.tokens || 0) > 0 ? (u.totals.cost ?? 0) / u.totals.tokens : null;
  const data = u.series.map((d) => {
    const row: Record<string, number | string> = { day: d.day };
    let other = 0;
    for (const [agent, tokens] of Object.entries(d.tokens)) {
      const v = unit === "cost" && perToken != null ? tokens * perToken : tokens;
      if ((CORE as readonly string[]).includes(agent)) row[agent] = v;
      else other += v;
    }
    if (other) row[OTHER] = other;
    return row;
  });
  const any = u.series.some((d) => Object.keys(d.tokens).length || d.agentHours || d.waitHours);
  const fmt = (v: number) => (unit === "cost" && rate ? money(v, rate.currency) : compact(v));
  const keys = [...CORE, OTHER].filter((k) => data.some((r) => r[k]));
  const h = "mt-3 aspect-auto h-[220px] w-full";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Tile
          label="Tokens"
          value={compact(u.totals.tokens)}
          hint="Agent model turns + AI in tools"
        />
        <Tile
          label="Estimated cost"
          value={rate ? money(u.totals.cost, rate.currency) : "Set your rate"}
          hint={
            rate
              ? `At ${rate.currency} ${rate.inputPerMillion} / ${rate.outputPerMillion} per 1M in / out`
              : "Enter your AI token prices below"
          }
        />
        <Tile
          label="Agents working"
          value={`${u.totals.agentHours} h`}
          hint="Model turns and tools"
        />
        <Tile
          label="Waiting for people"
          value={`${u.totals.waitHours} h`}
          hint="Request to decision, summed"
        />
        <Tile
          label="Tokens on failed runs"
          value={compact(u.totals.wastedTokens)}
          hint={
            u.totals.tokens
              ? `${Math.round((u.totals.wastedTokens / u.totals.tokens) * 100)}% of all tokens`
              : undefined
          }
        />
      </div>

      {!any ? (
        <p className="panel p-6 text-center text-sm text-muted-foreground">
          No agent activity in this period.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="panel p-4">
            <h3 className="text-sm font-semibold">
              {unit === "cost" ? "Cost per day" : "Tokens per day"}, by agent
            </h3>
            <p className="text-xs text-muted-foreground">
              {unit === "cost"
                ? "Estimated at your rate — an estimate, not a bill"
                : "Every AI request made by agents, including AI used inside their tools"}
            </p>
            <ChartContainer config={seriesConfig} className={h}>
              <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={28}
                  tickFormatter={dayLabel}
                />
                <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={fmt} />
                <ChartTooltip
                  cursor={{ fillOpacity: 0.4 }}
                  content={
                    <ChartTooltipContent
                      labelFormatter={(v) => dayLabel(String(v))}
                      formatter={(value, name) => (
                        <span className="flex w-full justify-between gap-3">
                          <span>{seriesConfig[String(name)]?.label ?? String(name)}</span>
                          <span className="num font-medium">{fmt(Number(value))}</span>
                        </span>
                      )}
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                {keys.map((k, i) => (
                  <Bar
                    key={k}
                    isAnimationActive={false}
                    dataKey={k}
                    stackId="t"
                    stroke="var(--card)"
                    strokeWidth={2}
                    fill={`var(--color-${k})`}
                    maxBarSize={28}
                    {...(i === keys.length - 1
                      ? { radius: [4, 4, 0, 0] as [number, number, number, number] }
                      : {})}
                  />
                ))}
              </BarChart>
            </ChartContainer>
          </section>

          <section className="panel p-4">
            <h3 className="text-sm font-semibold">Time per day</h3>
            <p className="text-xs text-muted-foreground">
              Hours agents spent working vs hours their requests waited for a person
            </p>
            <ChartContainer config={timeConfig} className={h}>
              <BarChart data={u.series} margin={{ left: 0, right: 8, top: 8 }} barGap={2}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={28}
                  tickFormatter={dayLabel}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tickFormatter={(v: number) => `${v} h`}
                />
                <ChartTooltip
                  cursor={{ fillOpacity: 0.4 }}
                  content={<ChartTooltipContent labelFormatter={(v) => dayLabel(String(v))} />}
                />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar
                  isAnimationActive={false}
                  dataKey="agentHours"
                  fill="var(--color-agentHours)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={14}
                />
                <Bar
                  isAnimationActive={false}
                  dataKey="waitHours"
                  fill="var(--color-waitHours)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={14}
                />
              </BarChart>
            </ChartContainer>
          </section>
        </div>
      )}

      <Recommendations u={u} />
      <EfficiencyTable u={u} />
      <CostRateForm u={u} />
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="panel p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="num mt-1 text-xl font-semibold tracking-tight">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Recommendations({ u }: { u: UtilisationView }) {
  return (
    <section className="panel p-4">
      <div className="flex items-center gap-2">
        <Lightbulb className="size-4 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold">How to optimise</h3>
        <span className="text-xs text-muted-foreground">
          From your agents' last {u.days} days — each with its evidence
        </span>
      </div>
      {u.recommendations.length ? (
        <ul className="mt-3 space-y-2">
          {u.recommendations.map((r, i) => (
            <li key={i} className="rounded-md border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {r.severity === "save" ? (
                  <Badge className="gap-1">
                    <PiggyBank className="size-3" aria-hidden /> Save
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1">
                    <Eye className="size-3" aria-hidden /> Watch
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {AGENT_LABEL[r.agentType] ?? r.agentType}
                </span>
                <span className="font-medium">{r.title}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Evidence: </span>
                {r.evidence}
              </p>
              <p className="mt-0.5 text-xs">
                <span className="font-medium">What to do: </span>
                {r.action}
              </p>
              {r.saving ? (
                <p className="num mt-0.5 text-xs text-primary">
                  Estimated saving per week:{" "}
                  {[
                    r.saving.tokens ? `${compact(r.saving.tokens)} tokens` : "",
                    r.saving.approvals ? `${r.saving.approvals} approvals` : "",
                    r.saving.hours ? `${r.saving.hours} h of waiting` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing to optimise right now — no wasted runs, approval bottlenecks, repeated work or
          budget risks were found.
        </p>
      )}
    </section>
  );
}

function EfficiencyTable({ u }: { u: UtilisationView }) {
  const cur = u.rate?.currency ?? "";
  return (
    <section className="panel overflow-x-auto p-4">
      <h3 className="text-sm font-semibold">Efficiency by agent</h3>
      <table className="num mt-3 w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-1.5 pr-3 font-medium">Agent</th>
            <th className="py-1.5 pr-3 text-right font-medium">Runs (done / failed)</th>
            <th className="py-1.5 pr-3 text-right font-medium">Tokens</th>
            {u.rate ? <th className="py-1.5 pr-3 text-right font-medium">Cost / run</th> : null}
            <th className="py-1.5 pr-3 text-right font-medium">Tokens / done run</th>
            <th className="py-1.5 pr-3 text-right font-medium">Agent min / run</th>
            <th className="py-1.5 pr-3 text-right font-medium">Median wait</th>
            <th className="py-1.5 pr-3 text-right font-medium">Approvals / run</th>
            <th className="py-1.5 pr-3 text-right font-medium">Wasted tokens</th>
            <th className="py-1.5 text-right font-medium">Repeated reads / run</th>
          </tr>
        </thead>
        <tbody>
          {u.agents.map((a) => (
            <tr key={a.agentType} className="border-b border-border/60 last:border-0">
              <td className="py-1.5 pr-3 font-sans font-medium">
                {AGENT_LABEL[a.agentType] ?? a.agentType}
              </td>
              <td className="py-1.5 pr-3 text-right">
                {a.runs} ({a.done} / {a.failed})
              </td>
              <td className="py-1.5 pr-3 text-right">{compact(a.tokens)}</td>
              {u.rate ? (
                <td className="py-1.5 pr-3 text-right">{money(a.costPerRun, cur)}</td>
              ) : null}
              <td className="py-1.5 pr-3 text-right">
                {a.tokensPerDoneRun == null ? "—" : compact(a.tokensPerDoneRun)}
              </td>
              <td className="py-1.5 pr-3 text-right">{a.agentMinutesPerRun ?? "—"}</td>
              <td className="py-1.5 pr-3 text-right">
                {a.medianWaitHours == null ? "—" : `${a.medianWaitHours} h`}
              </td>
              <td className="py-1.5 pr-3 text-right">{a.approvalsPerRun ?? "—"}</td>
              <td className="py-1.5 pr-3 text-right">
                {a.wastedTokens ? compact(a.wastedTokens) : "0"}
              </td>
              <td className="py-1.5 text-right">{a.repeatedReadsPerRun ?? "—"}</td>
            </tr>
          ))}
          {!u.agents.length ? (
            <tr>
              <td colSpan={10} className="py-3 text-center text-muted-foreground">
                No agent runs in this period.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

/** The organisation's own token prices — costs are estimates at this rate, never guessed. */
function CostRateForm({ u }: { u: UtilisationView }) {
  const qc = useQueryClient();
  const [currency, setCurrency] = useState(u.rate?.currency ?? "USD");
  const [input, setInput] = useState(u.rate ? String(u.rate.inputPerMillion) : "");
  const [output, setOutput] = useState(u.rate ? String(u.rate.outputPerMillion) : "");
  const [busy, setBusy] = useState(false);
  async function save(clear = false) {
    setBusy(true);
    try {
      await saveAgentCostRate({
        data: {
          rate: clear
            ? null
            : {
                currency,
                inputPerMillion: Number(input),
                outputPerMillion: Number(output),
              },
        },
      });
      toast.success(clear ? "Rate cleared — showing tokens only" : "Rate saved");
      qc.invalidateQueries({ queryKey: ["agent_utilisation"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the rate");
    } finally {
      setBusy(false);
    }
  }
  const valid =
    /^[A-Za-z]{3}$/.test(currency) && Number(input) >= 0 && Number(output) >= 0 && input && output;
  return (
    <section className="panel flex flex-wrap items-end gap-3 p-4 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Your AI token prices</p>
        <p className="text-xs text-muted-foreground">
          Your organisation uses its own AI key, so prices depend on your model and plan. Enter them
          (per 1 million tokens) to see cost estimates; see your provider's pricing for the model
          chosen in{" "}
          <Link to="/integrations" className="text-primary underline">
            Integrations → AI model
          </Link>
          .
        </p>
      </div>
      <label className="text-xs">
        Currency
        <Input
          className="mt-1 h-8 w-20"
          value={currency}
          maxLength={3}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
        />
      </label>
      <label className="text-xs">
        Input / 1M
        <Input
          className="mt-1 h-8 w-28"
          inputMode="decimal"
          value={input}
          onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))}
        />
      </label>
      <label className="text-xs">
        Output / 1M
        <Input
          className="mt-1 h-8 w-28"
          inputMode="decimal"
          value={output}
          onChange={(e) => setOutput(e.target.value.replace(/[^0-9.]/g, ""))}
        />
      </label>
      <Button size="sm" disabled={busy || !valid} onClick={() => save()}>
        Save rate
      </Button>
      {u.rate ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => save(true)}>
          Clear
        </Button>
      ) : null}
    </section>
  );
}
