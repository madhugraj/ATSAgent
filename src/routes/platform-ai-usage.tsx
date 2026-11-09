import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { Download, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  aiUsageExport,
  aiUsageOverview,
  type AiUsageEventRow,
} from "@/lib/platform-ai-usage.functions";
import { listAllOrganizations } from "@/lib/platform.functions";
import { usePlatform } from "@/hooks/usePlatform";
import { PageHeader, StatCard } from "@/components/ats";
import { AiRequestLog } from "@/components/AiRequestLog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

export const Route = createFileRoute("/platform-ai-usage")({
  head: () => ({
    meta: [
      { title: "Platform console — AI usage" },
      {
        name: "description",
        content:
          "Super-user analytics for AI spend: tokens per organisation, module and model, with a full request log.",
      },
    ],
  }),
  component: AiUsage,
});

/** Validated categorical slots 1-2 (light/dark steps), per the platform chart palette. */
const chartConfig = {
  promptTokens: {
    label: "Prompt tokens",
    theme: { light: "#2a78d6", dark: "#3987e5" },
  },
  completionTokens: {
    label: "Completion tokens",
    theme: { light: "#eb6834", dark: "#d95926" },
  },
  totalTokens: {
    label: "Total tokens",
    theme: { light: "#2a78d6", dark: "#3987e5" },
  },
} satisfies ChartConfig;

const DAY_FILTERS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 0, label: "All time" },
] as const;

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function downloadCsv(rows: AiUsageEventRow[]) {
  const headers = [
    "created_at",
    "organisation",
    "feature",
    "provider",
    "model",
    "status",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "attempt",
    "duration_ms",
    "grounded",
    "error",
  ];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(","),
    ...rows.map((r) =>
      [
        r.createdAt,
        r.orgName ?? r.orgId ?? "",
        r.feature,
        r.provider,
        r.model,
        r.status,
        r.promptTokens,
        r.completionTokens,
        r.totalTokens,
        r.attempt,
        r.durationMs ?? "",
        r.grounded ?? "",
        r.errorMessage ?? "",
      ]
        .map(esc)
        .join(","),
    ),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `ai-usage-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

function AiUsage() {
  const { isSuperUser, isLoading } = usePlatform();
  const fetchOverview = useServerFn(aiUsageOverview);
  const fetchExport = useServerFn(aiUsageExport);
  const fetchOrgs = useServerFn(listAllOrganizations);

  const [days, setDays] = useState(30);
  const [orgId, setOrgId] = useState("all");
  const [feature, setFeature] = useState("all");
  const [provider, setProvider] = useState("all");

  const filters = useMemo(
    () => ({
      orgId: orgId === "all" ? null : orgId,
      feature: feature === "all" ? null : feature,
      provider: provider === "all" ? null : provider,
      from: days ? isoDaysAgo(days) : null,
      to: null,
    }),
    [days, orgId, feature, provider],
  );

  const orgs = useQuery({
    queryKey: ["platform_orgs"],
    queryFn: () => fetchOrgs({}),
    enabled: isSuperUser,
  });
  const overview = useQuery({
    queryKey: ["ai_usage_overview", filters],
    queryFn: () => fetchOverview({ data: filters }),
    enabled: isSuperUser,
    placeholderData: keepPreviousData,
  });
  const featureOptions = useMemo(
    () => (overview.data?.byFeature ?? []).map((f) => f.feature),
    [overview.data],
  );
  const providerOptions = useMemo(
    () => Array.from(new Set((overview.data?.byModel ?? []).map((m) => m.provider))).sort(),
    [overview.data],
  );
  const modelOptions = useMemo(
    () => Array.from(new Set((overview.data?.byModel ?? []).map((m) => m.model))).sort(),
    [overview.data],
  );
  const topFeatures = useMemo(() => (overview.data?.byFeature ?? []).slice(0, 12), [overview.data]);

  if (isLoading) return <p className="text-sm text-muted-foreground">Checking platform access…</p>;

  if (!isSuperUser) {
    return (
      <>
        <PageHeader eyebrow="Platform" title="AI usage" description="Cross-tenant AI analytics." />
        <section className="panel max-w-lg space-y-3 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4 text-muted-foreground" /> Super-user access only
          </h2>
          <p className="text-sm text-muted-foreground">
            AI spend analytics are limited to the platform console&apos;s super users.
          </p>
        </section>
      </>
    );
  }

  const t = overview.data?.totals;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Platform"
        title="AI usage"
        description="Every AI request across the platform — tokens per organisation, module and model."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const out = await fetchExport({ data: filters });
                if (!out.rows.length) {
                  toast.error("Nothing to export for this filter.");
                  return;
                }
                downloadCsv(out.rows);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Export failed");
              }
            }}
          >
            <Download className="size-4" /> Export CSV
          </Button>
        }
      />

      {/* One filter row scoping everything below; date range first. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={String(days)}
          onValueChange={(v) => {
            setDays(Number(v));
          }}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DAY_FILTERS.map((f) => (
              <SelectItem key={f.days} value={String(f.days)}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={orgId}
          onValueChange={(v) => {
            setOrgId(v);
          }}
        >
          <SelectTrigger className="w-[210px]">
            <SelectValue placeholder="Organisation" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All organisations</SelectItem>
            {(orgs.data ?? []).map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={feature}
          onValueChange={(v) => {
            setFeature(v);
          }}
        >
          <SelectTrigger className="w-[190px]">
            <SelectValue placeholder="Module" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All modules</SelectItem>
            {featureOptions.map((f) => (
              <SelectItem key={f} value={f}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={provider}
          onValueChange={(v) => {
            setProvider(v);
          }}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            {providerOptions.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDays(30);
            setOrgId("all");
            setFeature("all");
            setProvider("all");
          }}
        >
          Reset
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Total tokens"
          value={t ? fmt(t.totalTokens) : "—"}
          {...(t
            ? {
                hint: `${t.promptTokens.toLocaleString()} in · ${t.completionTokens.toLocaleString()} out`,
              }
            : {})}
        />
        <StatCard label="AI calls" value={t ? t.calls.toLocaleString() : "—"} />
        <StatCard
          label="Failed calls"
          value={t ? t.errors.toLocaleString() : "—"}
          tone={t && t.errors > 0 ? "destructive" : "default"}
        />
        <StatCard
          label="Avg latency"
          value={t && t.avgDurationMs ? `${(t.avgDurationMs / 1000).toFixed(1)}s` : "—"}
        />
        <StatCard label="Organisations using AI" value={t ? t.orgs.toLocaleString() : "—"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Tokens over time</h2>
          <p className="text-xs text-muted-foreground">Daily prompt vs completion tokens</p>
          <ChartContainer config={chartConfig} className="mt-3 h-[260px] w-full">
            <AreaChart data={overview.data?.daily ?? []} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: string) => v.slice(5)}
                minTickGap={24}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => fmt(v)}
                width={46}
              />
              <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Area
                type="monotone"
                dataKey="promptTokens"
                stackId="tokens"
                stroke="var(--color-promptTokens)"
                strokeWidth={2}
                fill="var(--color-promptTokens)"
                fillOpacity={0.15}
              />
              <Area
                type="monotone"
                dataKey="completionTokens"
                stackId="tokens"
                stroke="var(--color-completionTokens)"
                strokeWidth={2}
                fill="var(--color-completionTokens)"
                fillOpacity={0.15}
              />
            </AreaChart>
          </ChartContainer>
        </section>

        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Tokens by module</h2>
          <p className="text-xs text-muted-foreground">Top modules by total tokens</p>
          <ChartContainer config={chartConfig} className="mt-3 h-[260px] w-full">
            <BarChart data={topFeatures} layout="vertical" margin={{ left: 8, right: 16, top: 4 }}>
              <CartesianGrid horizontal={false} />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => fmt(v)}
              />
              <YAxis
                type="category"
                dataKey="feature"
                tickLine={false}
                axisLine={false}
                width={110}
                tick={{ fontSize: 11 }}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar
                dataKey="totalTokens"
                fill="var(--color-totalTokens)"
                barSize={14}
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ChartContainer>
        </section>
      </div>

      <section className="panel overflow-x-auto p-4">
        <h2 className="text-sm font-semibold">By organisation</h2>
        <table className="num mt-3 w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="pb-2 font-medium">Organisation</th>
              <th className="pb-2 text-right font-medium">Calls</th>
              <th className="pb-2 text-right font-medium">Prompt</th>
              <th className="pb-2 text-right font-medium">Completion</th>
              <th className="pb-2 text-right font-medium">Total tokens</th>
              <th className="pb-2 text-right font-medium">Failed</th>
            </tr>
          </thead>
          <tbody>
            {(overview.data?.byOrg ?? []).map((r) => (
              <tr key={r.orgId ?? "none"} className="border-t border-border/60">
                <td className="py-1.5 font-sans">{r.orgName}</td>
                <td className="py-1.5 text-right">{r.calls.toLocaleString()}</td>
                <td className="py-1.5 text-right">{r.promptTokens.toLocaleString()}</td>
                <td className="py-1.5 text-right">{r.completionTokens.toLocaleString()}</td>
                <td className="py-1.5 text-right font-medium">{r.totalTokens.toLocaleString()}</td>
                <td className={`py-1.5 text-right ${r.errors ? "text-destructive" : ""}`}>
                  {r.errors.toLocaleString()}
                </td>
              </tr>
            ))}
            {!overview.data?.byOrg.length && (
              <tr>
                <td colSpan={6} className="py-3 text-muted-foreground">
                  No AI usage in this range yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel overflow-x-auto p-4">
        <h2 className="text-sm font-semibold">By model</h2>
        <table className="num mt-3 w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="pb-2 font-medium">Provider</th>
              <th className="pb-2 font-medium">Model</th>
              <th className="pb-2 text-right font-medium">Calls</th>
              <th className="pb-2 text-right font-medium">Prompt</th>
              <th className="pb-2 text-right font-medium">Completion</th>
              <th className="pb-2 text-right font-medium">Total tokens</th>
            </tr>
          </thead>
          <tbody>
            {(overview.data?.byModel ?? []).map((r) => (
              <tr key={`${r.provider}/${r.model}`} className="border-t border-border/60">
                <td className="py-1.5 font-sans">{r.provider}</td>
                <td className="py-1.5 font-sans">{r.model}</td>
                <td className="py-1.5 text-right">{r.calls.toLocaleString()}</td>
                <td className="py-1.5 text-right">{r.promptTokens.toLocaleString()}</td>
                <td className="py-1.5 text-right">{r.completionTokens.toLocaleString()}</td>
                <td className="py-1.5 text-right font-medium">{r.totalTokens.toLocaleString()}</td>
              </tr>
            ))}
            {!overview.data?.byModel.length && (
              <tr>
                <td colSpan={6} className="py-3 text-muted-foreground">
                  No AI usage in this range yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <AiRequestLog base={filters} modelOptions={modelOptions} />

      <p className="text-xs text-muted-foreground">
        Token counts come from the providers&apos; own usage reports; web-search tool fees are not
        included in chat token totals. A missing usage frame is recorded as zero, never estimated.
      </p>
    </div>
  );
}
