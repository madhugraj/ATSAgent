/**
 * The one CV upload: pick files, each is read, parsed and saved to the talent
 * pool (and applied to a requisition when one is given), with a live per-file
 * log. Used by the talent pool's bulk upload and a requisition's sourcing panel.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { intakeCvs, type IntakeStatus } from "@/lib/cv-intake";

export function CvUpload({
  label,
  source = "direct",
  requisitionId,
  destination,
}: {
  label: string;
  source?: string;
  requisitionId?: string | null;
  /** Where the CVs land, for the success toast: "the talent pool", "this requisition". */
  destination: string;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<IntakeStatus[]>([]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setBusy(true);
    setLog(list.map((f) => ({ file: f.name, state: "pending" as const, message: "Queued" })));
    try {
      const summary = await intakeCvs({
        files: list,
        source,
        requisitionId: requisitionId || null,
        onUpdate: (i, patch) =>
          setLog((l) => l.map((row, idx) => (idx === i ? { ...row, ...patch } : row))),
      });
      await qc.invalidateQueries({ queryKey: ["candidates"] });
      await qc.invalidateQueries({ queryKey: ["applications"] });
      if (summary.failed === 0)
        toast.success(`${summary.ok} CV${summary.ok === 1 ? "" : "s"} added to ${destination}`);
      else toast.warning(`${summary.ok} parsed · ${summary.failed} failed — see the list`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const ok = log.filter((l) => l.state === "ok").length;
  const failed = log.filter((l) => l.state === "error").length;
  return (
    <div className="space-y-2">
      <Label className="block text-xs text-muted-foreground">{label}</Label>
      <Input
        type="file"
        multiple
        disabled={busy}
        accept=".pdf,.docx,.txt,.md"
        onChange={(e) => {
          void upload(e.target.files);
          e.target.value = "";
        }}
      />
      <p className="text-xs text-muted-foreground">
        Text-based PDF, DOCX, TXT or MD. Scanned/image-only PDFs cannot be read.
      </p>
      {log.length > 0 && (
        <>
          <p className="num text-xs text-muted-foreground">
            {ok} parsed · {failed} failed · {log.length} total
          </p>
          <ul className="max-h-60 space-y-1 overflow-y-auto text-xs">
            {log.map((l, i) => (
              <li
                key={i}
                className={
                  l.state === "error"
                    ? "text-destructive"
                    : l.state === "ok"
                      ? "text-muted-foreground"
                      : "text-foreground"
                }
              >
                <span className="font-medium">{l.file}</span> — {l.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
