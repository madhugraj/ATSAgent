/**
 * Agent observability → Voice agents: the live phone calls over 14 days, measured
 * as calls — reached, completed, length, how they ended and how smoothly the
 * assistant's voice went out — never as AI request latency.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Phone } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { voiceObservability, type VoiceAgentStats } from "@/lib/voice-observability.functions";
import { CHOPPY_GAPS_PER_MINUTE } from "@/lib/voice-quality";

const LABEL: Record<VoiceAgentStats["purpose"], string> = {
  screening: "Screening call agent",
  scheduling: "Scheduling call agent",
  negotiation: "Pay call agent",
};
const callsConfig = {
  screening: { label: "Screening", theme: { light: "#2a78d6", dark: "#3987e5" } },
  scheduling: { label: "Scheduling", theme: { light: "#eb6834", dark: "#d95926" } },
  negotiation: { label: "Pay", theme: { light: "#3b9c63", dark: "#4cae74" } },
} satisfies ChartConfig;
const gapsConfig = {
  gapsPerMinute: { label: "Gaps a minute", theme: { light: "#2a78d6", dark: "#3987e5" } },
} satisfies ChartConfig;

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");
const words = (r: string) => r.replace(/_/g, " ");

export function VoiceObservability() {
  const load = useServerFn(voiceObservability);
  const q = useQuery({ queryKey: ["voice_observability"], queryFn: () => load({}) });
  if (!q.data) return null;
  const { agents, daily } = q.data;
  const any = agents.some((a) => a.placed > 0);
  const day = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const rows = daily.map((d) => ({ ...d, label: day(d.day) }));

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Phone className="size-4" /> Voice agents
      </h2>
      <p className="text-xs text-muted-foreground">
        Live phone calls over the last 14 days. A call is measured by how it went — not as an AI
        request, so calls never count towards AI latency above.
      </p>
      {!any ? (
        <div className="panel p-4 text-sm text-muted-foreground">No calls in the last 14 days.</div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            {agents.map((a) => (
              <div key={a.purpose} className="panel space-y-1 p-4 text-sm">
                <div className="font-semibold">{LABEL[a.purpose]}</div>
                <div className="text-xs text-muted-foreground">
                  {a.placed} placed · {a.reached} answered ({pct(a.reached, a.placed)}) ·{" "}
                  {a.completed} completed
                </div>
                <div className="text-xs">
                  Length: median {a.medianMinutes ?? "—"} min · p95 {a.p95Minutes ?? "—"} min
                </div>
                <div className="text-xs">
                  Voice quality:{" "}
                  {a.audioCalls
                    ? `${a.gapsPerMinute ?? 0} gaps a minute · ${a.choppyCalls} of ${a.audioCalls} calls broke up`
                    : "not measured yet"}
                </div>
                {a.noAnswer || a.failed ? (
                  <div className="text-xs text-muted-foreground">
                    {a.noAnswer} not answered · {a.failed} could not be placed
                  </div>
                ) : null}
                {a.endReasons.length ? (
                  <div className="text-xs text-muted-foreground">
                    Ended: {a.endReasons.map((r) => `${words(r.reason)} ${r.calls}`).join(" · ")}
                  </div>
                ) : null}
                <div className="text-xs text-muted-foreground">
                  {a.tokens.toLocaleString()} tokens
                </div>
              </div>
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <section className="panel p-4">
              <h3 className="text-sm font-semibold">Calls a day</h3>
              <p className="text-xs text-muted-foreground">By voice agent</p>
              <ChartContainer config={callsConfig} className="mt-3 aspect-auto h-[220px] w-full">
                <BarChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={28} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  {(["screening", "scheduling", "negotiation"] as const).map((k) => (
                    <Bar
                      key={k}
                      isAnimationActive={false}
                      dataKey={k}
                      stackId="calls"
                      fill={`var(--color-${k})`}
                    />
                  ))}
                </BarChart>
              </ChartContainer>
            </section>
            <section className="panel p-4">
              <h3 className="text-sm font-semibold">Voice quality</h3>
              <p className="text-xs text-muted-foreground">
                Gaps a minute in the assistant&apos;s speech · above {CHOPPY_GAPS_PER_MINUTE} a
                minute a call sounds broken up
              </p>
              <ChartContainer config={gapsConfig} className="mt-3 aspect-auto h-[220px] w-full">
                <LineChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis tickLine={false} axisLine={false} width={28} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line
                    isAnimationActive={false}
                    type="monotone"
                    dataKey="gapsPerMinute"
                    stroke="var(--color-gapsPerMinute)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    connectNulls
                  />
                </LineChart>
              </ChartContainer>
            </section>
          </div>
        </>
      )}
    </section>
  );
}
