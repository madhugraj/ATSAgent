/**
 * Archive import (plan rows 3–4, A3): load a large CV archive into the talent
 * pool. Zip archives are unpacked in the browser (the server never unpacks an
 * untrusted archive); files are staged in batches, then processed in the
 * background with identity resolution, CV versions and evidence extraction.
 * A trial run reads a sample without creating candidates.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, Loader2, Pause, Play, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { EmptyState, PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  archiveIssuesCsvFn,
  cancelArchiveImportFn,
  createArchiveImportFn,
  listArchiveImportsFn,
  pauseArchiveImportFn,
  stageArchiveFilesFn,
  startArchiveImportFn,
} from "@/lib/candidates.archive.functions";
import { requireRouteCapability } from "@/lib/route-guard";
import type { ArchiveImportView } from "@/server/candidates/archive-import.server";

export const Route = createFileRoute("/candidates/import")({
  beforeLoad: requireRouteCapability,
  head: () => ({ meta: [{ title: "Archive import — ATSIQ" }] }),
  component: ArchiveImportPage,
});

const ALLOWED = /\.(pdf|docx|txt|rtf)$/i;
const BATCH_BYTES = 5_000_000;
const BATCH_FILES = 25;

type LocalFile = { name: string; bytes: Uint8Array };

async function expand(files: File[]): Promise<{ files: LocalFile[]; ignored: number }> {
  const out: LocalFile[] = [];
  let ignored = 0;
  for (const f of files) {
    const buf = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) {
      const { unzipSync } = await import("fflate");
      const entries = unzipSync(buf, {
        filter: (e) => ALLOWED.test(e.name) && !/(^|\/)(__MACOSX|\.)/.test(e.name),
      });
      for (const [path, bytes] of Object.entries(entries)) {
        if (!bytes.byteLength) continue;
        out.push({ name: path.split("/").pop() ?? path, bytes });
      }
    } else if (ALLOWED.test(f.name)) out.push({ name: f.name, bytes: buf });
    else ignored++;
  }
  return { files: out, ignored };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function ArchiveImportPage() {
  const qc = useQueryClient();
  const list = useServerFn(listArchiveImportsFn);
  const create = useServerFn(createArchiveImportFn);
  const stage = useServerFn(stageArchiveFilesFn);
  const start = useServerFn(startArchiveImportFn);
  const pause = useServerFn(pauseArchiveImportFn);
  const cancel = useServerFn(cancelArchiveImportFn);
  const issues = useServerFn(archiveIssuesCsvFn);

  const imports = useQuery({
    queryKey: ["archive_imports"],
    queryFn: () => list(),
    refetchInterval: (q) => (q.state.data?.some((i) => i.status === "running") ? 5_000 : false),
  });

  const [name, setName] = useState("");
  const [trial, setTrial] = useState(true);
  const [trialLimit, setTrialLimit] = useState(250);
  const [staging, setStaging] = useState<{ done: number; total: number; waiting?: boolean } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(fileList: FileList | null) {
    if (!fileList?.length) return;
    try {
      const { files, ignored } = await expand([...fileList]);
      if (!files.length) {
        toast.error("No PDF, DOCX, TXT or RTF files found");
        return;
      }
      const { id } = await create({
        data: {
          name: name.trim() || fileList[0]!.name,
          trialRun: trial,
          ...(trial ? { trialLimit } : {}),
        },
      });
      setStaging({ done: 0, total: files.length });
      let staged = 0;
      let duplicate = 0;
      const rejected: string[] = [];
      for (let i = 0; i < files.length;) {
        const batch: { name: string; base64: string }[] = [];
        let size = 0;
        while (i < files.length && batch.length < BATCH_FILES) {
          const f = files[i]!;
          if (batch.length && size + f.bytes.byteLength > BATCH_BYTES) break;
          batch.push({ name: f.name, base64: toBase64(f.bytes) });
          size += f.bytes.byteLength;
          i++;
        }
        // Server-fn RPCs are rate-limited per caller (60/min); a large archive
        // sends more batches than that. A limited call comes back empty —
        // wait out the window and resend the same batch (staging de-duplicates
        // by content hash, so a resend never double-stages).
        let r: Awaited<ReturnType<typeof stage>> | undefined;
        for (let attempt = 0; attempt < 6; attempt++) {
          r = await stage({ data: { importId: id, files: batch } }).catch((e: unknown) => {
            if (e instanceof Error && /too many requests/i.test(e.message)) return undefined;
            throw e;
          });
          if (r) break;
          setStaging({ done: i, total: files.length, waiting: true });
          await new Promise((res) => setTimeout(res, 61_000));
        }
        if (!r) throw new Error("The server is busy — try the import again in a few minutes.");
        staged += r.staged;
        duplicate += r.duplicate;
        rejected.push(...r.rejected.map((x) => `${x.name}: ${x.reason}`));
        setStaging({ done: i, total: files.length });
      }
      await start({ data: { importId: id } });
      toast.success(
        `${staged} files queued` +
          (duplicate ? ` · ${duplicate} duplicates` : "") +
          (rejected.length + ignored ? ` · ${rejected.length + ignored} skipped` : ""),
      );
      setName("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setStaging(null);
      if (inputRef.current) inputRef.current.value = "";
      await qc.invalidateQueries({ queryKey: ["archive_imports"] });
    }
  }

  const act = useMutation({
    mutationFn: async (a: { kind: "start" | "pause" | "cancel"; id: string }) => {
      const data = { importId: a.id };
      if (a.kind === "start") return start({ data });
      if (a.kind === "pause") return pause({ data });
      return cancel({ data });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["archive_imports"] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  async function downloadIssues(imp: ArchiveImportView) {
    const { csv } = await issues({ data: { importId: imp.id } });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${imp.name}-issues.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Archive import" />

      <section className="panel space-y-4 p-5">
        <div className="grid gap-4 md:grid-cols-[1fr_auto_auto] md:items-end">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Archive" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={trial} onCheckedChange={setTrial} />
            Trial run
          </label>
          {trial ? (
            <label className="space-y-1 text-sm">
              <span className="font-medium">Files</span>
              <Input
                type="number"
                min={10}
                max={1000}
                className="w-28"
                value={trialLimit}
                onChange={(e) =>
                  setTrialLimit(Math.max(10, Math.min(1000, Number(e.target.value) || 250)))
                }
              />
            </label>
          ) : null}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".zip,.pdf,.docx,.txt,.rtf"
          className="hidden"
          onChange={(e) => void upload(e.target.files)}
        />
        {staging ? (
          <div className="space-y-1">
            <Progress value={(staging.done / staging.total) * 100} />
            <div className="num text-xs text-muted-foreground">
              {staging.done} / {staging.total}
              {staging.waiting ? " · paused a minute" : ""}
            </div>
          </div>
        ) : (
          <Button onClick={() => inputRef.current?.click()}>
            <Upload className="size-4" /> Choose zip or files
          </Button>
        )}
      </section>

      {imports.data?.length ? (
        <div className="space-y-4">
          {imports.data.map((imp) => (
            <ImportCard
              key={imp.id}
              imp={imp}
              busy={act.isPending}
              onAct={(kind) => act.mutate({ kind, id: imp.id })}
              onIssues={() => void downloadIssues(imp)}
            />
          ))}
        </div>
      ) : imports.isLoading ? null : (
        <EmptyState title="No imports yet" />
      )}
    </div>
  );
}

function ImportCard({
  imp,
  busy,
  onAct,
  onIssues,
}: {
  imp: ArchiveImportView;
  busy: boolean;
  onAct: (k: "start" | "pause" | "cancel") => void;
  onIssues: () => void;
}) {
  const c = imp.counts;
  const target = imp.trialRun ? Math.min(c.total, imp.trialLimit ?? 250) : c.total;
  const processed = c.total - c.pending - c.running;
  const pct = target ? Math.min(100, (Math.min(processed, target) / target) * 100) : 0;
  const open = imp.status === "running" || imp.status === "paused" || imp.status === "staging";
  const cells: [string, number][] = imp.trialRun
    ? [
        ["Files", c.total],
        ["Read", c.skipped],
        ["Failed", c.failed],
      ]
    : [
        ["Files", c.total],
        ["New", c.done],
        ["Merged", c.merged],
        ["Review", c.needs_review],
        ["Already held", c.skipped],
        ["Failed", c.failed],
      ];
  return (
    <section className="panel space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{imp.name}</h2>
        {imp.trialRun ? <Badge variant="outline">Trial</Badge> : null}
        <Badge variant={imp.status === "running" ? "default" : "secondary"}>{imp.status}</Badge>
        {imp.status === "running" ? <Loader2 className="size-4 animate-spin" /> : null}
        <div className="ml-auto flex gap-2">
          {imp.status === "running" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct("pause")}>
              <Pause className="size-4" /> Pause
            </Button>
          ) : null}
          {imp.status === "paused" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct("start")}>
              <Play className="size-4" /> Resume
            </Button>
          ) : null}
          {open ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAct("cancel")}>
              <X className="size-4" /> Cancel
            </Button>
          ) : null}
          {c.failed + c.needs_review > 0 ? (
            <Button size="sm" variant="outline" onClick={onIssues}>
              <Download className="size-4" /> Issues
            </Button>
          ) : null}
        </div>
      </div>
      <Progress value={pct} />
      <dl className="grid grid-cols-3 gap-3 text-sm md:grid-cols-6">
        {cells.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="num font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      {imp.report ? (
        <dl className="grid grid-cols-3 gap-3 border-t pt-3 text-sm md:grid-cols-6">
          {(
            [
              ["Parsed", `${imp.report.parsed}/${imp.report.readable}`],
              ["With email", `${imp.report.withEmail}`],
              ["With phone", `${imp.report.withPhone}`],
              ["Duplicates", `${imp.report.duplicateRate}%`],
              ["AI calls", `${imp.report.aiCalls}`],
              [
                "Tokens / CV",
                imp.report.readable
                  ? `${Math.round((imp.report.promptTokens + imp.report.completionTokens) / imp.report.readable)}`
                  : "–",
              ],
            ] as [string, string][]
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="num font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
