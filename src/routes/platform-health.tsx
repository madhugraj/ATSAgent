import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { KeyRound } from "lucide-react";

import { PageHeader, StatCard } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { usePlatform } from "@/hooks/usePlatform";
import { platformServiceHealth, type ServiceHealth } from "@/lib/platform-health.functions";

export const Route = createFileRoute("/platform-health")({
  head: () => ({
    meta: [
      { title: "Platform console — Service health" },
      {
        name: "description",
        content:
          "Super-user view of service level objectives: availability, latency and agent run success against target, error budget and burn rate.",
      },
    ],
  }),
  component: PlatformHealth,
});

const pct = (v: number | null, digits = 2) => (v == null ? "—" : `${(v * 100).toFixed(digits)} %`);
const burnFmt = (v: number | null) =>
  v == null ? "—" : Number.isFinite(v) ? `${v.toFixed(1)}×` : "∞";
const secs = (v: number | null) => (v == null ? "—" : v >= 60 ? "> 30 s" : `≤ ${v} s`);
const n = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(1)}K` : String(v));

type SloRow = ServiceHealth["slos"][number];

function budgetTone(s: SloRow): "default" | "success" | "warning" | "destructive" {
  if (s.budgetRemaining == null) return "default";
  if (s.budgetRemaining < 0) return "destructive";
  if (s.budgetRemaining < 0.25) return "warning";
  return "success";
}

function BudgetBar({ remaining }: { remaining: number | null }) {
  const w = remaining == null ? 0 : Math.max(0, Math.min(1, remaining)) * 100;
  return (
    <div
      className="h-2 w-full overflow-hidden rounded bg-muted"
      role="meter"
      aria-label="Error budget remaining"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(w)}
    >
      <div
        className={`h-full ${remaining != null && remaining < 0.25 ? "bg-destructive" : "bg-primary"}`}
        style={{ width: `${w}%` }}
      />
    </div>
  );
}

function SloCard({ s, data }: { s: SloRow; data: ServiceHealth }) {
  // Highest alert threshold each window is compared with (the short and long windows of a rule).
  const threshold = (minutes: number) =>
    data.thresholds.burnAlerts.find((a) => a.longMinutes === minutes || a.shortMinutes === minutes)
      ?.burnRate ?? null;
  return (
    <section className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{s.name}</h2>
          <p className="text-xs text-muted-foreground">{s.sli}</p>
        </div>
        {s.alert ? (
          <Badge variant={s.alert.severity === "critical" ? "destructive" : "default"}>
            {s.alert.severity} burn · {burnFmt(s.alert.burnRate)}
          </Badge>
        ) : (
          <Badge variant="outline">No burn alert</Badge>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label={`SLI (${s.windowDays} days)`}
          value={pct(s.sli30d)}
          hint={`${n(s.events)} events · ${n(s.badEvents)} bad`}
        />
        <StatCard label="Objective" value={pct(s.target, 1)} />
        <StatCard
          label="Error budget left"
          value={pct(s.budgetRemaining, 0)}
          tone={budgetTone(s)}
          {...(s.events ? {} : { hint: "no events yet" })}
        />
      </div>
      <BudgetBar remaining={s.budgetRemaining} />
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-2 py-1 font-medium">Burn rate over</th>
            {s.burn.map((b) => (
              <th key={b.label} className="px-2 py-1 text-right font-medium">
                {b.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="px-2 py-1 text-muted-foreground">Budget spend × allowed</td>
            {s.burn.map((b) => {
              const t = threshold(b.minutes);
              const hot = t != null && b.rate != null && b.rate >= t;
              return (
                <td
                  key={b.label}
                  className={`num px-2 py-1 text-right ${hot ? "font-semibold text-destructive" : ""}`}
                  title={`${b.events} events${t ? ` · alert threshold ${t}×` : ""}`}
                >
                  {b.events < data.thresholds.minEvents && b.rate != null ? (
                    <span className="text-muted-foreground">{burnFmt(b.rate)}*</span>
                  ) : (
                    burnFmt(b.rate)
                  )}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function PlatformHealth() {
  const { isSuperUser, isLoading } = usePlatform();
  const fetchHealth = useServerFn(platformServiceHealth);
  const q = useQuery({
    queryKey: ["platform_service_health"],
    queryFn: () => fetchHealth({}),
    enabled: isSuperUser,
    refetchInterval: 60_000,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Checking platform access…</p>;
  if (!isSuperUser) {
    return (
      <>
        <PageHeader
          eyebrow="Platform"
          title="Service health"
          description="Service level objectives."
        />
        <section className="panel max-w-lg space-y-3 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4 text-muted-foreground" /> Super-user access only
          </h2>
          <p className="text-sm text-muted-foreground">
            Service health is limited to the platform console&apos;s super users.
          </p>
        </section>
      </>
    );
  }

  const d = q.data;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Platform"
        title="Service health"
        description="Each objective against its target over a rolling window, how much error budget is left, and how fast it is burning. A burn rate of 1× spends the whole budget in exactly one window; alerts fire when a long and a short window both burn too fast."
      />
      {!d ? (
        <p className="text-sm text-muted-foreground">
          {q.error ? (q.error as Error).message : "Loading…"}
        </p>
      ) : (
        <>
          {d.slos.map((s) => (
            <SloCard key={s.id} s={s} data={d} />
          ))}

          <section className="panel p-4">
            <h2 className="mb-2 text-sm font-semibold">Requests by route group (24 h)</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Route group</th>
                  <th className="px-2 py-1 text-right font-medium">Requests</th>
                  <th className="px-2 py-1 text-right font-medium">5xx</th>
                  <th className="px-2 py-1 text-right font-medium">p95 (1 h)</th>
                  <th className="px-2 py-1 text-right font-medium">p95 (24 h)</th>
                </tr>
              </thead>
              <tbody>
                {d.routeGroups.length ? (
                  d.routeGroups.map((g) => (
                    <tr key={g.routeGroup} className="border-b border-border/60 last:border-0">
                      <td className="px-2 py-1">{g.routeGroup}</td>
                      <td className="num px-2 py-1 text-right">{n(g.requests24h)}</td>
                      <td className="num px-2 py-1 text-right">{n(g.errors24h)}</td>
                      <td className="num px-2 py-1 text-right">{secs(g.p95Seconds1h)}</td>
                      <td className="num px-2 py-1 text-right">{secs(g.p95Seconds24h)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="px-2 py-3 text-center text-muted-foreground">
                      No requests recorded yet — each app instance writes its counts once a minute.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">
              p95 is the upper bound of the latency bucket holding the 95th percentile. * marks a
              burn rate from fewer than {d.thresholds.minEvents} events (never alerted on).
            </p>
          </section>

          <section className="panel p-4">
            <h2 className="mb-2 text-sm font-semibold">Burn-rate alerts (30 days)</h2>
            {d.recentAlerts.length ? (
              <ul className="space-y-1 text-sm">
                {d.recentAlerts.map((a, i) => (
                  <li key={i} className="flex flex-wrap gap-2">
                    <Badge variant={a.severity === "critical" ? "destructive" : "default"}>
                      {a.severity}
                    </Badge>
                    <span>{d.slos.find((s) => s.id === a.slo)?.name ?? a.slo}</span>
                    <span className="text-muted-foreground">
                      {burnFmt(a.burnRate)} · opened {new Date(a.openedAt).toLocaleString()}
                      {a.resolvedAt
                        ? ` · resolved ${new Date(a.resolvedAt).toLocaleString()}`
                        : " · open"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No burn-rate alerts in the last 30 days.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
