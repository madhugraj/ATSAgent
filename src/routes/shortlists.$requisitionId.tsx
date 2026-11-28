/**
 * One role's ranked shortlist (C2): candidates in score order with the factor
 * breakdown, each requirement's verdict and the CV passages behind it,
 * knock-outs and the rationale. Shortlist / Reject are recorded decisions only.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Check, ChevronDown, Download, RefreshCw, Target, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState, PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  decideShortlistFn,
  getShortlistFn,
  evaluateShortlistFn,
  rerankFn,
  shortlistCsvFn,
  type EvaluationResult,
  type ShortlistRow,
} from "@/lib/shortlist.functions";
import { requireRouteCapability } from "@/lib/route-guard";

export const Route = createFileRoute("/shortlists/$requisitionId")({
  beforeLoad: requireRouteCapability,
  head: () => ({ meta: [{ title: "Shortlist — ATSIQ" }] }),
  component: ShortlistPage,
});

const FILTERS = [
  ["all", "All"],
  ["open", "Undecided"],
  ["shortlisted", "Shortlisted"],
  ["rejected", "Rejected"],
] as const;
type Filter = (typeof FILTERS)[number][0];

const FACTOR_LABEL: Record<string, string> = {
  must: "Must-haves",
  career: "Career progression",
  impact: "Impact",
  education: "Education",
  nice: "Nice-to-haves",
  experience: "Experience",
  sector: "Sector",
  location: "Location",
};
const VERDICT_TONE = {
  met: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  partial: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  missing: "border-border text-muted-foreground line-through decoration-muted-foreground/40",
} as const;

function ShortlistPage() {
  const { requisitionId } = Route.useParams();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const get = useServerFn(getShortlistFn);
  const decide = useServerFn(decideShortlistFn);
  const rerank = useServerFn(rerankFn);
  const csv = useServerFn(shortlistCsvFn);
  const evaluate = useServerFn(evaluateShortlistFn);
  const [evalOpen, setEvalOpen] = useState(false);
  const [truth, setTruth] = useState("");
  const [evalResult, setEvalResult] = useState<EvaluationResult | null>(null);
  const evalM = useMutation({
    mutationFn: () =>
      evaluate({
        data: {
          requisitionId,
          entries: truth
            .split(/\n|,|;/)
            .map((x) => x.trim())
            .filter((x) => x.length >= 2),
        },
      }),
    onSuccess: setEvalResult,
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const key = ["shortlist", requisitionId, filter];
  const q = useQuery({
    queryKey: key,
    queryFn: () => get({ data: { requisitionId, filter, limit: 150 } }),
    refetchInterval: (s) =>
      s.state.data?.run?.status === "queued" || s.state.data?.run?.status === "running"
        ? 10_000
        : false,
  });
  const decideM = useMutation({
    mutationFn: (v: { candidateId: string; decision: "shortlisted" | "rejected" | "clear" }) =>
      decide({ data: { requisitionId, ...v } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shortlist", requisitionId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const rerankM = useMutation({
    mutationFn: () => rerank({ data: { requisitionId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shortlist", requisitionId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  async function exportCsv() {
    const { csv: text } = await csv({ data: { requisitionId } });
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${q.data?.requisition.code ?? "shortlist"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const busy = q.data?.run?.status === "queued" || q.data?.run?.status === "running";
  return (
    <div className="space-y-6">
      <PageHeader
        title={q.data?.requisition.title ?? "Shortlist"}
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || rerankM.isPending}
              onClick={() => rerankM.mutate()}
            >
              <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} /> Re-rank
            </Button>
            <Button variant="outline" size="sm" onClick={() => void exportCsv()}>
              <Download className="size-4" /> CSV
            </Button>
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link to="/shortlists" className="text-muted-foreground hover:underline">
          Shortlists
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="num">{q.data?.requisition.code}</span>
        {q.data?.run ? (
          <span className="num ml-auto text-xs text-muted-foreground">Pool {q.data.run.pool}</span>
        ) : null}
      </div>
      {evalOpen ? (
        <section className="panel space-y-3 p-4">
          <Textarea
            rows={4}
            value={truth}
            onChange={(e) => setTruth(e.target.value)}
            placeholder="Emails or names, one per line"
          />
          <Button
            size="sm"
            disabled={evalM.isPending || !truth.trim()}
            onClick={() => evalM.mutate()}
          >
            Compare
          </Button>
          {evalResult ? (
            <div className="space-y-2 text-sm">
              <dl className="grid grid-cols-4 gap-3">
                {evalResult.atK.map((x) => (
                  <div key={x.k}>
                    <dt className="text-xs text-muted-foreground">Top {x.k}</dt>
                    <dd className="num">
                      P {Math.round(x.precision * 100)}% · R {Math.round(x.recall * 100)}%
                    </dd>
                  </div>
                ))}
              </dl>
              <ul className="num text-xs text-muted-foreground">
                {evalResult.positions.map((p) => (
                  <li key={p.entry}>
                    {p.entry}: {p.rank ? `#${p.rank}` : "not in the ranked pool"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
      <div className="flex gap-1">
        {FILTERS.map(([k, label]) => (
          <Button
            key={k}
            size="sm"
            variant={filter === k ? "default" : "ghost"}
            onClick={() => setFilter(k)}
          >
            {label}
          </Button>
        ))}
      </div>
      {q.data?.rows.length ? (
        <ol className="space-y-3">
          {q.data.rows.map((r) => (
            <CandidateRow
              key={r.candidateId}
              row={r}
              versionNames={q.data!.versionNames}
              busy={decideM.isPending}
              onDecide={(decision) => decideM.mutate({ candidateId: r.candidateId, decision })}
            />
          ))}
        </ol>
      ) : q.isLoading ? null : (
        <EmptyState title={busy ? "Ranking…" : "No candidates"} />
      )}
    </div>
  );
}

function CandidateRow({
  row,
  versionNames,
  busy,
  onDecide,
}: {
  row: ShortlistRow;
  versionNames: Record<string, string>;
  busy: boolean;
  onDecide: (d: "shortlisted" | "rejected" | "clear") => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li
      className={`panel p-4 ${
        row.decision === "shortlisted"
          ? "border-emerald-500/50"
          : row.decision === "rejected"
            ? "opacity-60"
            : ""
      }`}
    >
      <div className="flex flex-wrap items-start gap-4">
        <div className="num w-8 pt-1 text-sm text-muted-foreground">{row.rank}</div>
        <div className="w-14 text-center">
          <div
            className={`num text-2xl font-semibold ${row.reviewed ? "" : "text-muted-foreground"}`}
          >
            {row.score}
          </div>
          {row.reviewed ? null : (
            <div className="text-[10px] text-muted-foreground">evidence only</div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/candidates/$id"
              params={{ id: row.candidateId }}
              className="font-medium hover:underline"
            >
              {row.name}
            </Link>
            <span className="text-xs text-muted-foreground">
              {[
                row.currentRole,
                row.location,
                row.experienceYears ? `${row.experienceYears} yrs` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {row.knockouts.map((k) => (
              <Badge
                key={k.kind}
                variant="outline"
                className="gap-1 border-amber-500/50 text-amber-700"
              >
                <AlertTriangle className="size-3" /> {k.detail}
              </Badge>
            ))}
          </div>
          {row.rationale ? <p className="text-sm">{row.rationale}</p> : null}
          {row.requirements.length ? (
            <div className="flex flex-wrap gap-1.5">
              {row.requirements.map((q, i) => (
                <span
                  key={i}
                  title={q.requirement}
                  className={`max-w-[18rem] truncate rounded-md border px-2 py-0.5 text-xs ${VERDICT_TONE[q.verdict]}`}
                >
                  {q.kind === "nice" ? "+ " : ""}
                  {q.requirement}
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {row.factors.map((f) => (
              <span key={f.key} className="num">
                {f.label ?? FACTOR_LABEL[f.key] ?? f.key} {Math.round(f.score * 100)}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {row.decision ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide("clear")}>
              {row.decision === "shortlisted" ? "Shortlisted" : "Rejected"} · Undo
            </Button>
          ) : (
            <>
              <Button size="sm" disabled={busy} onClick={() => onDecide("shortlisted")}>
                <Check className="size-4" /> Shortlist
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onDecide("rejected")}
              >
                <X className="size-4" /> Reject
              </Button>
            </>
          )}
          {row.requirements.length ? (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setOpen(!open)}
              aria-label="Evidence"
            >
              <ChevronDown className={`size-4 transition ${open ? "rotate-180" : ""}`} />
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <table className="mt-4 w-full text-sm">
          <tbody className="divide-y">
            {row.requirements.map((q, i) => (
              <tr key={i} className="align-top">
                <td className="w-1/3 py-2 pr-3">
                  <span
                    className={`mr-2 rounded border px-1.5 text-[10px] uppercase ${VERDICT_TONE[q.verdict]}`}
                  >
                    {q.verdict}
                  </span>
                  {q.requirement}
                </td>
                <td className="py-2 text-xs text-muted-foreground">
                  {q.evidence.length
                    ? q.evidence.map((e) => (
                        <blockquote
                          key={e.claimId}
                          className="mb-1 border-l-2 border-primary/40 pl-2"
                        >
                          “{e.passage}”
                          <span className="ml-1 not-italic opacity-70">
                            — {versionNames[e.versionId] ?? "CV"}
                            {q.strength ? ` · ${q.strength}` : ""}
                          </span>
                        </blockquote>
                      ))
                    : (q.note ?? "—")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </li>
  );
}
