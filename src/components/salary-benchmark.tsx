import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, RefreshCw, Sparkles } from "lucide-react";

import { benchmarkQuery, type BenchmarkRow } from "@/lib/data";
import { runSalaryBenchmark } from "@/lib/salary-benchmark.functions";
import { formatMoney, inferLevelKey, type BenchmarkLevel } from "@/lib/career-ladder";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type BenchmarkApply = {
  budgetCtc: string;
  ctcBandMin: string;
  ctcBandMax: string;
  careerLevel: string;
};

const CONFIDENCE_VARIANT = {
  high: "default",
  medium: "secondary",
  low: "outline",
} as const;

const CONFIDENCE_LABEL = { high: "high", medium: "med", low: "low" } as const;

/** Shared "Market benchmark" section — requisition create dialog and detail rail. */
export function MarketBenchmark({
  title,
  location,
  experienceMin,
  experienceMax,
  requisitionId,
  panel = false,
  preload = false,
  onApply,
}: {
  title: string;
  location: string | null;
  experienceMin: number;
  experienceMax: number;
  requisitionId?: string | null;
  /** Render inside a `.panel p-5` section (detail page right rail). */
  panel?: boolean;
  /** Preload the latest cached run (detail page; the dialog's title changes per keystroke). */
  preload?: boolean;
  onApply: (apply: BenchmarkApply) => void | Promise<void>;
}) {
  const cached = useQuery({
    ...benchmarkQuery({ title, location, experienceMin, experienceMax }),
    enabled: preload && title.trim().length > 0,
  });
  const [row, setRow] = useState<BenchmarkRow | null>(null);
  const [running, setRunning] = useState(false);
  const [appliedKey, setAppliedKey] = useState<string | null>(null);

  const shown = row ?? cached.data?.benchmark ?? null;
  const stale = cached.data?.stale ?? false;

  async function run(refresh: boolean) {
    if (!title.trim()) {
      toast.error("Add a role title first — the market agent needs it");
      return;
    }
    setRunning(true);
    try {
      const result = await runSalaryBenchmark({
        data: {
          title,
          location: location || null,
          experienceMin,
          experienceMax,
          requisitionId: requisitionId ?? null,
          refresh,
        },
      });
      setRow(result);
      setAppliedKey(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not run the market benchmark");
    } finally {
      setRunning(false);
    }
  }

  const sources = useMemo(() => {
    const seen = new Map<string, string>();
    for (const level of shown?.payload?.levels ?? []) {
      for (const s of level.sources ?? []) {
        if (!seen.has(s.url)) seen.set(s.url, s.title || s.url);
      }
    }
    return [...seen.entries()].map(([url, label]) => ({ url, label }));
  }, [shown]);

  const suggested = inferLevelKey(experienceMin, experienceMax, title);

  const body = (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Market benchmark</h2>
          <p className="text-xs text-muted-foreground">
            An AI agent researches public salary pages and suggests CTC ranges by level and
            experience band.
          </p>
        </div>
        <Button
          size="sm"
          variant={shown ? "outline" : "default"}
          onClick={() => run(shown != null)}
          disabled={running}
        >
          {running ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Researching the market… (up to a minute)
            </>
          ) : shown ? (
            <>
              <RefreshCw className="size-4" /> Refresh{stale ? " — data is 30+ days old" : ""}
            </>
          ) : (
            <>
              <Sparkles className="size-4" /> Run benchmark
            </>
          )}
        </Button>
      </div>

      {shown && (
        <div className="mt-4 space-y-3">
          {!shown.payload?.grounded && (
            <Alert>
              <AlertTitle>Estimate only</AlertTitle>
              <AlertDescription>
                The model had no live web access for this run — treat the ranges as a rough estimate
                and refresh once web access works.
              </AlertDescription>
            </Alert>
          )}
          {shown.payload?.notes && (
            <p className="text-xs text-muted-foreground">{shown.payload.notes}</p>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 px-1.5 text-xs">Level</TableHead>
                <TableHead className="h-8 px-1.5 text-xs">Band</TableHead>
                <TableHead className="h-8 px-1.5 text-right text-xs">Low</TableHead>
                <TableHead className="h-8 px-1.5 text-right text-xs">Median</TableHead>
                <TableHead className="h-8 px-1.5 text-right text-xs">High</TableHead>
                <TableHead className="h-8 px-1.5 text-xs">Conf.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(shown.payload?.levels ?? []).map((level) => {
                const overlaps =
                  level.expBand.min <= experienceMax && level.expBand.max >= experienceMin;
                const usable = level.median > 0 && !running;
                return (
                  <TableRow
                    key={level.key}
                    className={`${overlaps ? "bg-muted/50" : ""} ${usable ? "cursor-pointer" : ""}`}
                    title={usable ? "Set budget CTC from this level" : undefined}
                    onClick={
                      usable
                        ? async () => {
                            await onApply({
                              budgetCtc: String(level.median),
                              ctcBandMin: String(level.low),
                              ctcBandMax: String(level.high),
                              careerLevel: level.key,
                            });
                            setAppliedKey(level.key);
                          }
                        : undefined
                    }
                  >
                    <TableCell className="px-1.5 py-2 text-xs font-medium">
                      {level.label}
                      {level.key === suggested && (
                        <span className="ml-1 text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                          req.
                        </span>
                      )}
                      {appliedKey === level.key && (
                        <Check className="ml-1 inline size-3 text-primary" />
                      )}
                    </TableCell>
                    <TableCell className="px-1.5 py-2 text-xs text-muted-foreground">
                      {level.expBand.label.replace(" yrs", "")}
                    </TableCell>
                    <TableCell className="num px-1.5 py-2 text-right text-xs">
                      {formatMoney(level.low, shown.payload.currency)}
                    </TableCell>
                    <TableCell className="num px-1.5 py-2 text-right text-xs">
                      {formatMoney(level.median, shown.payload.currency)}
                    </TableCell>
                    <TableCell className="num px-1.5 py-2 text-right text-xs">
                      {formatMoney(level.high, shown.payload.currency)}
                    </TableCell>
                    <TableCell className="px-1.5 py-2">
                      <Badge
                        variant={CONFIDENCE_VARIANT[level.confidence]}
                        className="px-1.5 text-[0.625rem]"
                      >
                        {CONFIDENCE_LABEL[level.confidence]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="text-[0.625rem] text-muted-foreground">
            Click a row to set the budget CTC to its median — the band fills with low/high.
          </p>

          {sources.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="text-xs text-muted-foreground underline">
                Sources ({sources.length})
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-2 space-y-1 text-xs">
                  {sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noreferrer" className="underline">
                        {s.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
          <p className="num text-[0.625rem] text-muted-foreground">
            {new Date(shown.created_at).toLocaleString()}
          </p>
        </div>
      )}
    </>
  );

  if (!panel)
    return (
      <div className="sm:col-span-2 rounded-md border border-dashed border-border p-4">{body}</div>
    );
  return <section className="panel p-5">{body}</section>;
}

export type { BenchmarkRow } from "@/lib/data";
export type { BenchmarkLevel } from "@/lib/career-ladder";
