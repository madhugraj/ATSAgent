import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { aiUsageEventsList } from "@/lib/platform-ai-usage.functions";
import { StatCard } from "@/components/ats";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

type BaseFilters = {
  orgId: string | null;
  feature: string | null;
  provider: string | null;
  from: string | null;
  to: null;
};

const PAGE_SIZE = 50;

const timelineConfig = {
  ok: { label: "Succeeded", theme: { light: "#2a78d6", dark: "#3987e5" } },
  errors: { label: "Failed", theme: { light: "#d03b3b", dark: "#e5534b" } },
} satisfies ChartConfig;

const latencyConfig = {
  calls: { label: "Requests", theme: { light: "#2a78d6", dark: "#3987e5" } },
} satisfies ChartConfig;

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "tokens", label: "Most tokens" },
  { value: "latency", label: "Slowest" },
] as const;

const LATENCY_OPTIONS = [
  { value: "0", label: "Any latency" },
  { value: "3000", label: "≥ 3s" },
  { value: "10000", label: "≥ 10s" },
  { value: "30000", label: "≥ 30s" },
] as const;

const secs = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Filterable, sortable request log with its own stats and charts. */
export function AiRequestLog({
  base,
  modelOptions,
}: {
  base: BaseFilters;
  modelOptions: string[];
}) {
  const fetchEvents = useServerFn(aiUsageEventsList);
  const [status, setStatus] = useState<"all" | "ok" | "error">("all");
  const [model, setModel] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [retriesOnly, setRetriesOnly] = useState(false);
  const [minLatency, setMinLatency] = useState("0");
  const [sort, setSort] = useState<(typeof SORT_OPTIONS)[number]["value"]>("newest");
  const [page, setPage] = useState(0);
  const search = useDebounced(searchText.trim(), 300);

  const filters = useMemo(
    () => ({
      ...base,
      status: status === "all" ? null : status,
      model: model === "all" ? null : model,
      search: search || null,
      retriesOnly: retriesOnly || null,
      minLatencyMs: Number(minLatency) || null,
      sort,
    }),
    [base, status, model, search, retriesOnly, minLatency, sort],
  );

  // Any filter change returns to the first page.
  useEffect(() => setPage(0), [filters]);

  const events = useQuery({
    queryKey: ["ai_usage_events", filters, page],
    queryFn: () =>
      fetchEvents({ data: { ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });

  const s = events.data?.stats;
  const total = events.data?.total ?? 0;
  const maxTokens = Math.max(1, ...(events.data?.rows ?? []).map((r) => r.totalTokens));
  const errorRate = s && s.calls ? (s.errors / s.calls) * 100 : 0;
  const narrowed =
    status !== "all" || model !== "all" || !!searchText || retriesOnly || minLatency !== "0";

  const timeline = useMemo(
    () =>
      (s?.timeline ?? []).map((t) => ({
        ...t,
        label: s?.bucket === "hour" ? t.at.slice(5).replace("T", " ") : t.at.slice(5),
      })),
    [s],
  );

  return (
    <section className="panel space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Request log</h2>
        {narrowed && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus("all");
              setModel("all");
              setSearchText("");
              setRetriesOnly(false);
              setMinLatency("0");
            }}
          >
            <X className="size-3.5" /> Clear log filters
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search org, module, model, error…"
            className="h-9 pl-8"
          />
        </div>
        <div className="inline-flex rounded-md border p-0.5">
          {(["all", "ok", "error"] as const).map((v) => (
            <Button
              key={v}
              size="sm"
              variant={status === v ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setStatus(v)}
            >
              {v === "all" ? "All" : v === "ok" ? "Succeeded" : "Failed"}
            </Button>
          ))}
        </div>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All models</SelectItem>
            {modelOptions.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={minLatency} onValueChange={setMinLatency}>
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LATENCY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant={retriesOnly ? "secondary" : "outline"}
          onClick={() => setRetriesOnly((v) => !v)}
        >
          Retries only
        </Button>
        <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
          <SelectTrigger className="ml-auto w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Matching requests" value={s ? s.calls.toLocaleString() : "—"} />
        <StatCard
          label="Error rate"
          value={s ? `${errorRate.toFixed(1)}%` : "—"}
          tone={s && s.errors > 0 ? "destructive" : "default"}
          {...(s ? { hint: `${s.errors.toLocaleString()} failed` } : {})}
        />
        <StatCard
          label="Retried"
          value={s ? s.retries.toLocaleString() : "—"}
          {...(s && s.calls
            ? { hint: `${((s.retries / s.calls) * 100).toFixed(1)}% of requests` }
            : {})}
        />
        <StatCard label="p50 latency" value={secs(s?.p50Ms ?? null)} />
        <StatCard
          label="p95 latency"
          value={secs(s?.p95Ms ?? null)}
          {...(s?.maxMs != null ? { hint: `max ${secs(s.maxMs)}` } : {})}
        />
        <StatCard
          label="Avg tokens / request"
          value={s ? s.avgTokens.toLocaleString() : "—"}
          {...(s ? { hint: `${s.grounded.toLocaleString()} web-grounded` } : {})}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <p className="mb-2 text-xs text-muted-foreground">
            Requests per {s?.bucket ?? "day"} — succeeded vs failed
          </p>
          {timeline.length ? (
            <ChartContainer config={timelineConfig} className="h-[200px] w-full">
              <BarChart data={timeline}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} />
                <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="ok" stackId="a" fill="var(--color-ok)" />
                <Bar
                  dataKey="errors"
                  stackId="a"
                  fill="var(--color-errors)"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ChartContainer>
          ) : (
            <p className="py-10 text-center text-xs text-muted-foreground">No requests.</p>
          )}
        </div>
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Latency distribution</p>
          {s && s.latency.some((l) => l.calls) ? (
            <ChartContainer config={latencyConfig} className="h-[200px] w-full">
              <BarChart data={s.latency}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="bucket" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="calls" fill="var(--color-calls)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartContainer>
          ) : (
            <p className="py-10 text-center text-xs text-muted-foreground">No timings.</p>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>
            {total ? (page * PAGE_SIZE + 1).toLocaleString() : 0}–
            {Math.min((page + 1) * PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={(page + 1) * PAGE_SIZE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
        <table className="num mt-3 w-full text-xs [&_td]:align-top">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="pb-2 pr-4 font-medium">Time</th>
              <th className="pb-2 pr-4 font-medium">Organisation</th>
              <th className="pb-2 pr-4 font-medium">Module</th>
              <th className="pb-2 pr-4 font-medium">Model</th>
              <th className="pb-2 pr-4 font-medium">Status</th>
              <th className="pb-2 text-right font-medium">Tokens</th>
              <th className="pb-2 text-right font-medium">Try</th>
              <th className="pb-2 text-right font-medium">Latency</th>
            </tr>
          </thead>
          <tbody
            className={events.isFetching && events.isPlaceholderData ? "opacity-60" : undefined}
          >
            {(events.data?.rows ?? []).map((r) => (
              <tr
                key={r.id}
                className={
                  "border-t border-border/60" + (r.status === "error" ? " bg-destructive/5" : "")
                }
              >
                <td className="whitespace-nowrap py-1.5 pr-4 font-sans">
                  {new Date(r.createdAt).toLocaleString()}
                </td>
                <td className="py-1.5 pr-4 font-sans">{r.orgName ?? "—"}</td>
                <td className="py-1.5 pr-4 font-sans">{r.feature}</td>
                <td className="whitespace-nowrap py-1.5 pr-4 font-sans">
                  {r.provider} · {r.model}
                </td>
                <td className="py-1.5 pr-4 font-sans">
                  {r.status === "ok" ? (
                    <Badge variant="outline">ok</Badge>
                  ) : (
                    <Badge variant="destructive">error</Badge>
                  )}
                  {r.grounded ? <span className="ml-1 text-muted-foreground">web</span> : null}
                  {r.errorMessage ? (
                    <span
                      className="ml-2 inline-block max-w-[260px] truncate align-middle text-destructive"
                      title={r.errorMessage}
                    >
                      {r.errorMessage}
                    </span>
                  ) : null}
                </td>
                <td
                  className="py-1.5 text-right"
                  title={`${r.promptTokens.toLocaleString()} in · ${r.completionTokens.toLocaleString()} out`}
                >
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/70"
                        style={{ width: `${(r.totalTokens / maxTokens) * 100}%` }}
                      />
                    </div>
                    <span className="w-14">{r.totalTokens.toLocaleString()}</span>
                  </div>
                </td>
                <td className="py-1.5 text-right">{r.attempt > 1 ? r.attempt : "—"}</td>
                <td
                  className={
                    "py-1.5 text-right" +
                    (r.durationMs != null && r.durationMs >= 30_000 ? " text-destructive" : "")
                  }
                >
                  {secs(r.durationMs)}
                </td>
              </tr>
            ))}
            {!events.data?.rows.length && (
              <tr>
                <td colSpan={8} className="py-3 text-muted-foreground">
                  {narrowed
                    ? "No requests match these filters."
                    : "No requests logged in this range yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
