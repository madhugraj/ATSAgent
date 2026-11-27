import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { extractResumeText } from "@/lib/cv-extract";
import {
  closeJdImport,
  decideJdImportItem,
  importJdFile,
  listJdImport,
  listSectorTerms,
  saveSectorTerms,
} from "@/lib/jd-import.functions";
import { profileRows, type RequirementProfile, type Verdict } from "@/lib/jd-requirements";
import type { ImportItemView } from "@/lib/jd-import.server";
import { requireRouteCapability } from "@/lib/route-guard";
import { mapWithLimit } from "@/lib/shortlist";

export const Route = createFileRoute("/jd-import")({
  beforeLoad: requireRouteCapability,
  validateSearch: z.object({ session: z.string().uuid().optional() }),
  head: () => ({ meta: [{ title: "JD import" }] }),
  component: JdImportPage,
});

const VERDICT_LABEL: Record<Verdict, string> = {
  duplicate: "Duplicate",
  variant: "Variant",
  distinct: "Distinct",
};

function JdImportPage() {
  const { session } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const importFile = useServerFn(importJdFile);
  const list = useServerFn(listJdImport);
  const close = useServerFn(closeJdImport);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);

  const items = useQuery({
    queryKey: ["jd_import", session],
    queryFn: () => list({ data: { importId: session! } }),
    enabled: Boolean(session),
  });

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const importId = session ?? crypto.randomUUID();
    if (!session) await navigate({ to: "/jd-import", search: { session: importId } });
    const all = Array.from(files);
    setBusy({ done: 0, total: all.length });
    let done = 0;
    await mapWithLimit(all, 3, async (file) => {
      try {
        const text = await extractResumeText(file);
        await importFile({ data: { importId, fileName: file.name, text } });
      } catch (e) {
        toast.error(`${file.name}: ${e instanceof Error ? e.message : "failed"}`);
      } finally {
        done += 1;
        setBusy({ done, total: all.length });
        await qc.invalidateQueries({ queryKey: ["jd_import", importId] });
      }
    });
    setBusy(null);
  }

  async function finish() {
    if (!session) return;
    await close({ data: { importId: session } });
    await qc.invalidateQueries({ queryKey: ["requisitions"] });
    await navigate({ to: "/jd-import", search: {} });
  }

  const rows = items.data ?? [];
  const count = (s: string) => rows.filter((r) => r.status === s).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Requisitions & JD"
        title="JD import"
        actions={
          session ? (
            <Button variant="outline" onClick={() => void finish()} disabled={Boolean(busy)}>
              Finish import
            </Button>
          ) : null
        }
      />

      <section className="panel space-y-3 p-5">
        <Input
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md"
          disabled={Boolean(busy)}
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = "";
          }}
        />
        {busy && (
          <p className="num text-xs text-muted-foreground">
            {busy.done} / {busy.total}
          </p>
        )}
        {rows.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary" className="num">
              Created {count("created")}
            </Badge>
            <Badge variant="secondary" className="num">
              To review {count("review")}
            </Badge>
            <Badge variant="secondary" className="num">
              Linked {count("linked")}
            </Badge>
            <Badge variant={count("error") ? "destructive" : "secondary"} className="num">
              Failed {count("error")}
            </Badge>
          </div>
        )}
      </section>

      {rows.map((row) => (
        <ImportRow key={row.id} row={row} session={session!} />
      ))}

      <SectorList />
    </div>
  );
}

function ImportRow({ row, session }: { row: ImportItemView; session: string }) {
  const qc = useQueryClient();
  const decide = useServerFn(decideJdImportItem);
  const [pending, setPending] = useState(false);

  async function choose(verdict: Verdict) {
    setPending(true);
    try {
      await decide({ data: { itemId: row.id, verdict } });
      await qc.invalidateQueries({ queryKey: ["jd_import", session] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the decision");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{row.fileName}</span>
        {row.status === "created" && row.requisitionId && (
          <Link
            to="/requisitions/$id"
            params={{ id: row.requisitionId }}
            className="text-sm underline"
          >
            {row.requisitionCode}
          </Link>
        )}
        {row.status === "linked" && row.match && (
          <Badge variant="secondary">Linked to {row.match.code}</Badge>
        )}
        {row.status === "error" && <span className="text-sm text-destructive">{row.error}</span>}
        {row.status === "review" && row.proposedVerdict && (
          <Badge>
            {VERDICT_LABEL[row.proposedVerdict]}
            {row.similarity != null && (
              <span className="num ml-1">{Math.round(row.similarity * 100)}%</span>
            )}
          </Badge>
        )}
      </div>

      {row.status === "review" && row.profile && row.matchProfile && row.match && (
        <>
          <Compare
            left={row.profile}
            right={row.matchProfile}
            rightLabel={`${row.match.code} · ${row.match.status}`}
            hard={row.hardDifferences}
          />
          {(row.reasons.length > 0 || row.jobCodeMatch || row.notCompared) && (
            <ul className="list-disc pl-5 text-sm text-muted-foreground">
              {row.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {(["duplicate", "variant", "distinct"] as const).map((v) => (
              <Button
                key={v}
                size="sm"
                variant={v === row.proposedVerdict ? "default" : "outline"}
                disabled={pending}
                onClick={() => void choose(v)}
              >
                {VERDICT_LABEL[v]}
              </Button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

const HARD_FIELD: Record<string, string> = {
  country: "Location",
  seniority: "Seniority",
  employment_type: "Employment",
  hiring_client: "Hiring client",
  pay_band: "Pay",
  pay_currency: "Pay",
};

function Compare({
  left,
  right,
  rightLabel,
  hard,
}: {
  left: RequirementProfile;
  right: RequirementProfile;
  rightLabel: string;
  hard: string[];
}) {
  const a = profileRows(left);
  const b = profileRows(right);
  const flagged = new Set(hard.map((h) => HARD_FIELD[h]).filter(Boolean));
  return (
    <div className="grid gap-x-4 text-sm md:grid-cols-[8rem_1fr_1fr]">
      <span />
      <span className="text-xs font-medium text-muted-foreground">This file</span>
      <span className="text-xs font-medium text-muted-foreground">{rightLabel}</span>
      {a.map((r, i) => {
        const differs = r.value !== b[i]?.value;
        return (
          <div key={r.label} className="contents">
            <span
              className={`py-1 text-xs ${flagged.has(r.label) ? "font-semibold text-destructive" : "text-muted-foreground"}`}
            >
              {r.label}
            </span>
            <span className={`py-1 ${differs ? "font-medium" : ""}`}>{r.value}</span>
            <span className={`py-1 ${differs ? "font-medium" : ""}`}>{b[i]?.value}</span>
          </div>
        );
      })}
    </div>
  );
}

function SectorList() {
  const qc = useQueryClient();
  const load = useServerFn(listSectorTerms);
  const save = useServerFn(saveSectorTerms);
  const q = useQuery({ queryKey: ["sector_terms"], queryFn: () => load() });
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (q.data?.terms ?? []).join("\n");

  return (
    <section className="panel space-y-3 p-5">
      <h2 className="text-sm font-medium">Sectors</h2>
      <Textarea rows={8} value={value} onChange={(e) => setDraft(e.target.value)} />
      {draft != null && (
        <Button
          size="sm"
          onClick={async () => {
            try {
              await save({
                data: {
                  terms: draft
                    .split("\n")
                    .map((t) => t.trim())
                    .filter(Boolean),
                },
              });
              setDraft(null);
              await qc.invalidateQueries({ queryKey: ["sector_terms"] });
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not save");
            }
          }}
        >
          Save sectors
        </Button>
      )}
    </section>
  );
}
