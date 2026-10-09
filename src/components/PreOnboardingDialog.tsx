/**
 * Pre-onboarding document collection and validation for one offer.
 *
 * The left column is the checklist of documents — uploaded by TA or arrived on
 * the careers inbox. The right column shows the original document beside what
 * the extraction agent read out of it, so HR validates a figure against the
 * page it came from and never against the agent alone. Approving every required
 * document is what unlocks release of the offer letter.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  deleteOnboardingDoc,
  getCompensationReading,
  getOnboardingDocFile,
  listOnboardingDocs,
  reextractOnboardingDoc,
  reviewOnboardingDoc,
  uploadOnboardingDoc,
  type OnboardingDocWire,
} from "@/lib/onboarding.functions";
import { DOC_TYPES } from "@/lib/onboarding.catalogue";
import { inr } from "@/components/ats";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  applicationId: string;
  candidateName: string;
  roleTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const STATUS_TONE: Record<string, string> = {
  verified: "border-emerald-300 bg-emerald-50 text-emerald-700",
  rejected: "border-red-300 bg-red-50 text-red-700",
  pending: "border-amber-300 bg-amber-50 text-amber-700",
};

const STATUS_LABEL: Record<string, string> = {
  verified: "Validated",
  rejected: "Rejected",
  pending: "Awaiting validation",
};

/** Human labels for the reading the agent returns. */
const FIELD_LABELS: Record<string, string> = {
  document_kind: "Document",
  holder_name: "Name on document",
  id_number: "ID number",
  date_of_birth: "Date of birth",
  employer: "Employer",
  designation: "Designation",
  employed_from: "Employed from",
  employed_to: "Employed to",
  payslip_month: "Payslip month",
  gross_pay: "Gross pay",
  net_pay: "Net pay",
  annual_ctc: "Last drawn CTC (annual)",
  currency: "Currency",
  institution: "Institution",
  qualification: "Qualification",
  issue_date: "Issued on",
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

type Component = {
  label?: string;
  amount?: number;
  cadence?: string;
  kind?: string;
  recurring?: boolean;
};

/**
 * The employer's own breakup, line by line and unrenamed. Two employers paying
 * the same CTC structure it differently, and that structure is what the reviewer
 * has to judge — so nothing is re-bucketed into a house template here.
 */
function Breakup({ facts, title }: { facts: Record<string, unknown>; title?: string }) {
  const all = Array.isArray(facts["pay_components"])
    ? (facts["pay_components"] as Component[])
    : [];
  const lines = all.filter((c) => c?.label && typeof c.amount === "number");
  if (!lines.length) return null;
  const group = (kind: string) =>
    lines.filter((c) => (c.kind ?? "earning").toLowerCase().startsWith(kind));
  const blocks: [string, Component[]][] = [
    ["Earnings", group("earning")],
    ["Deductions", group("deduction")],
    ["Employer contributions", group("employer")],
    ["Stated totals", group("total")],
  ];
  const unclassified = lines.filter((c) => !blocks.some(([, g]) => g.includes(c)));
  if (unclassified.length) blocks.push(["Other lines", unclassified]);

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{title ?? "Salary breakup as printed"}</span>
        {typeof facts["pay_frequency"] === "string" && facts["pay_frequency"] ? (
          <span className="text-[11px] text-muted-foreground">
            stated {String(facts["pay_frequency"]).replace(/_/g, " ")}
          </span>
        ) : null}
      </div>
      {blocks
        .filter(([, g]) => g.length)
        .map(([heading, g]) => (
          <div key={heading}>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {heading}
            </div>
            <ul className="divide-y divide-border">
              {g.map((c, i) => (
                <li key={`${c.label}-${i}`} className="flex items-baseline gap-2 py-1 text-sm">
                  <span className="min-w-0 flex-1 break-words">{c.label}</span>
                  {c.recurring === false ? (
                    <span className="rounded-full border border-amber-300 bg-amber-50 px-1.5 text-[10px] text-amber-800">
                      one-off
                    </span>
                  ) : null}
                  {c.cadence && c.cadence !== "monthly" ? (
                    <span className="text-[10px] text-muted-foreground">
                      {String(c.cadence).replace(/_/g, " ")}
                    </span>
                  ) : null}
                  <span className="num font-medium">
                    {Math.round(Number(c.amount)).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      {typeof facts["breakup_notes"] === "string" && facts["breakup_notes"] ? (
        <p className="text-xs text-muted-foreground">{String(facts["breakup_notes"])}</p>
      ) : null}
    </div>
  );
}

function Extraction({ doc }: { doc: OnboardingDocWire }) {
  const e = (doc.extracted ?? null) as Record<string, unknown> | null;
  if (doc.extraction_status === "failed" || !e) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
        {doc.extraction_note ?? "Nothing could be read from this file — validate it by eye."}
      </div>
    );
  }
  const rows = Object.entries(FIELD_LABELS)
    .map(([key, label]) => [label, e[key]] as const)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "");
  const extra = Array.isArray(e["fields"])
    ? (e["fields"] as { label?: string; value?: string }[]).filter((f) => f?.label && f?.value)
    : [];
  const concerns = Array.isArray(e["concerns"]) ? (e["concerns"] as string[]) : [];
  const confidence = typeof e["confidence"] === "number" ? e["confidence"] : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Read by the agent — check each value against the document.</span>
        {confidence !== null ? (
          <span className="num">confidence {Math.round(confidence)}%</span>
        ) : null}
      </div>
      <dl className="divide-y divide-border rounded-lg border border-border">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3 p-2.5 text-sm">
            <dt className="w-44 shrink-0 text-xs text-muted-foreground">{label}</dt>
            <dd className="num min-w-0 flex-1 break-words font-medium">{String(value)}</dd>
          </div>
        ))}
        {extra.map((f) => (
          <div key={`${f.label}-${f.value}`} className="flex gap-3 p-2.5 text-sm">
            <dt className="w-44 shrink-0 text-xs text-muted-foreground">{f.label}</dt>
            <dd className="min-w-0 flex-1 break-words">{f.value}</dd>
          </div>
        ))}
        {rows.length === 0 && extra.length === 0 ? (
          <div className="p-2.5 text-sm text-muted-foreground">
            The agent found no named values on this document.
          </div>
        ) : null}
      </dl>
      <Breakup facts={e} />
      {Array.isArray(e["parts"]) && (e["parts"] as unknown[]).length ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            This file holds {(e["parts"] as unknown[]).length} separate document(s) — each one is
            read, dated and reconciled on its own.
          </p>
          {(e["parts"] as Record<string, unknown>[]).map((part, i) => (
            <details key={i} className="rounded-lg border border-border p-3 text-sm">
              <summary className="cursor-pointer">
                {typeof part["part_label"] === "string" && part["part_label"]
                  ? String(part["part_label"])
                  : `Document ${i + 1}`}
                {typeof part["pages"] === "string" && part["pages"] ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    p. {String(part["pages"])}
                  </span>
                ) : null}
              </summary>
              <div className="mt-2 space-y-2">
                <dl className="divide-y divide-border rounded-lg border border-border">
                  {Object.entries(FIELD_LABELS)
                    .map(([key, label]) => [label, part[key]] as const)
                    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
                    .map(([label, v]) => (
                      <div key={label} className="flex gap-3 p-2 text-sm">
                        <dt className="w-40 shrink-0 text-xs text-muted-foreground">{label}</dt>
                        <dd className="num min-w-0 flex-1 break-words font-medium">{String(v)}</dd>
                      </div>
                    ))}
                </dl>
                <Breakup facts={part} title="Breakup on this document" />
              </div>
            </details>
          ))}
        </div>
      ) : null}
      {typeof e["summary"] === "string" && e["summary"] ? (
        <p className="text-sm text-muted-foreground">{String(e["summary"])}</p>
      ) : null}
      {concerns.length ? (
        <ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          {concerns.map((c) => (
            <li key={c}>· {c}</li>
          ))}
        </ul>
      ) : null}
      {e["suspected_prompt_injection"] === true ? (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          This document contained text trying to instruct the agent. It was ignored — read the
          document yourself before validating.
        </p>
      ) : null}
      {doc.extraction_status === "extracted" ? (
        <p className="text-xs text-muted-foreground">
          Read automatically using your organisation's own AI key — please validate before
          submitting.
        </p>
      ) : null}
    </div>
  );
}

/** The stored file itself: PDFs and images render inline, everything else downloads. */
function FileViewer({ docId }: { docId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [type, setType] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    setUrl(null);
    setError(null);
    (async () => {
      const res = await getOnboardingDocFile({ data: { id: docId } });
      if (!live) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const bin = window.atob(res.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: res.contentType }));
      urlRef.current = objectUrl;
      setType(res.contentType);
      setUrl(objectUrl);
    })().catch(() => {
      if (live) setError("The document could not be opened.");
    });
    return () => {
      live = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [docId]);

  if (error) return <div className="p-4 text-sm text-muted-foreground">{error}</div>;
  if (!url) return <div className="p-4 text-sm text-muted-foreground">Opening the document…</div>;
  if (type.startsWith("image/")) {
    return <img src={url} alt="Uploaded document" className="max-h-[60vh] w-full object-contain" />;
  }
  if (type === "application/pdf") {
    return <iframe src={url} title="Uploaded document" className="h-[60vh] w-full" />;
  }
  return (
    <div className="space-y-3 p-4 text-sm">
      <p className="text-muted-foreground">This file type cannot be shown here.</p>
      <a href={url} download className="underline">
        Download the document
      </a>
    </div>
  );
}

/**
 * The reconciled pay reading: one dated conclusion, the basis it rests on, the
 * document timeline behind it and every disagreement left open. The reviewer
 * approves a conclusion, never a bare number.
 */
function PayReading({ applicationId }: { applicationId: string }) {
  const q = useQuery({
    queryKey: ["onboarding_pay", applicationId],
    queryFn: () => getCompensationReading({ data: { applicationId } }),
  });
  const r = q.data;
  if (!r) return null;
  const amount = (n: number | null) =>
    n === null
      ? "not established"
      : r.currency === "INR"
        ? inr(n)
        : `${r.currency} ${n.toLocaleString()}`;

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-xs text-muted-foreground">Last drawn salary (annual)</div>
          <div className="num text-2xl font-semibold">{amount(r.lastDrawnAnnual)}</div>
        </div>
        {r.offeredAnnual !== null ? (
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Offered · change</div>
            <div className="num text-sm font-medium">
              {amount(r.offeredAnnual)}
              {r.hikePct !== null ? (
                <span className={r.hikePct < 0 ? "ml-2 text-red-600" : "ml-2 text-emerald-700"}>
                  {r.hikePct > 0 ? "+" : ""}
                  {r.hikePct}%
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] ${
            r.confident
              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
              : "border-amber-300 bg-amber-50 text-amber-700"
          }`}
        >
          {r.confident ? "Fully evidenced" : "Needs a human call"}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">{r.basis}</p>
      <p className="text-xs text-muted-foreground">
        {r.validatedEvidence} of {r.totalEvidence} pay-evidence document(s) validated.
      </p>

      {r.conflicts.length ? (
        <ul className="space-y-1 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {r.conflicts.map((c) => (
            <li key={c}>· {c}</li>
          ))}
        </ul>
      ) : null}
      {r.gaps.length ? (
        <ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          {r.gaps.map((g) => (
            <li key={g}>· {g}</li>
          ))}
        </ul>
      ) : null}

      {r.timeline.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Evidence timeline ({r.timeline.length})
          </summary>
          <ol className="mt-2 space-y-2 border-l border-border pl-4">
            {r.timeline.map((t) => (
              <li key={`${t.docId}-${t.onIso}-${t.docType}`} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="num text-xs text-muted-foreground">
                    {t.onIso ? t.onIso.slice(0, 7) : "date unclear"}
                  </span>
                  <span className="font-medium">{t.docTypeLabel}</span>
                  {t.employer ? (
                    <span className="text-xs text-muted-foreground">{t.employer}</span>
                  ) : null}
                  <span
                    className={`rounded-full border px-1.5 text-[10px] ${STATUS_TONE[t.status] ?? ""}`}
                  >
                    {STATUS_LABEL[t.status] ?? t.status}
                  </span>
                </div>
                <div className="text-muted-foreground">{t.reads}</div>
                {t.annualised ? (
                  <div className="num text-xs text-muted-foreground">
                    annualised {amount(t.annualised)}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

export function PreOnboardingDialog({
  applicationId,
  candidateName,
  roleTitle,
  open,
  onOpenChange,
}: Props) {
  const qc = useQueryClient();
  const [docType, setDocType] = useState("id_proof");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const list = useQuery({
    queryKey: ["onboarding_docs", applicationId],
    queryFn: () => listOnboardingDocs({ data: { applicationId } }),
    enabled: open,
  });

  const docs = list.data?.docs ?? [];
  const readiness = list.data?.readiness;
  const selected = docs.find((d) => d.id === selectedId) ?? docs[0] ?? null;

  useEffect(() => {
    setNote(selected?.review_note ?? "");
  }, [selected?.id, selected?.review_note]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["onboarding_docs", applicationId] });
    qc.invalidateQueries({ queryKey: ["onboarding_pay", applicationId] });
  };

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const base64 = await fileToBase64(file);
      return uploadOnboardingDoc({ data: { applicationId, docType, fileName: file.name, base64 } });
    },
    onSuccess: (res) => {
      if (res.duplicate) {
        toast.info(res.note ?? "This file is already filed.");
        return;
      }
      toast.success(
        res.extractionStatus === "extracted"
          ? "Document filed and read — validate the extract."
          : `Document filed. ${res.note ?? "It could not be read automatically."}`,
      );
      refresh();
      qc.invalidateQueries({ queryKey: ["onboarding_readiness"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "The document could not be filed."),
  });

  const review = useMutation({
    mutationFn: (decision: "verified" | "rejected" | "pending") =>
      reviewOnboardingDoc({ data: { id: selected!.id, decision, note: note || null } }),
    onSuccess: () => {
      toast.success("Decision recorded.");
      refresh();
      qc.invalidateQueries({ queryKey: ["onboarding_readiness"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "The decision could not be saved."),
  });

  const reextract = useMutation({
    mutationFn: () => reextractOnboardingDoc({ data: { id: selected!.id } }),
    onSuccess: (res) => {
      toast.success(
        res.status === "extracted" ? "Read again." : (res.note ?? "It could not be read."),
      );
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "It could not be read again."),
  });

  const remove = useMutation({
    mutationFn: () => deleteOnboardingDoc({ data: { id: selected!.id } }),
    onSuccess: () => {
      toast.success("Document removed.");
      setSelectedId(null);
      refresh();
      qc.invalidateQueries({ queryKey: ["onboarding_readiness"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "It could not be removed."),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Pre-onboarding documents — {candidateName}</DialogTitle>
          <DialogDescription>
            {roleTitle} · Collect the proof documents, check the agent's reading against each
            original, and validate. The offer letter can only be released once every mandatory
            document is validated.
          </DialogDescription>
        </DialogHeader>

        {readiness ? (
          <div
            className={`rounded-lg border p-3 text-sm ${
              readiness.ready
                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                : "border-amber-300 bg-amber-50 text-amber-800"
            }`}
          >
            {readiness.ready
              ? "All mandatory documents validated — this offer can be released."
              : `Still needed: ${readiness.missing
                  .map((m) => DOC_TYPES.find((d) => d.key === m)?.label ?? m)
                  .join(", ")}.`}{" "}
            <span className="num">
              {readiness.verified} validated · {readiness.pending} awaiting · {readiness.rejected}{" "}
              rejected
            </span>
          </div>
        ) : null}

        <PayReading applicationId={applicationId} />

        <div className="grid gap-5 lg:grid-cols-[19rem_1fr]">
          <div className="space-y-4">
            <div className="space-y-2 rounded-lg border border-border p-3">
              <Label className="text-xs text-muted-foreground">Add a document</Label>
              <Select value={docType} onValueChange={setDocType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_TYPES.map((d) => (
                    <SelectItem key={d.key} value={d.key}>
                      {d.label}
                      {d.required ? " *" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {DOC_TYPES.find((d) => d.key === docType)?.hint}
              </p>
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                accept=".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.webp,.zip"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload.mutate(file);
                  e.target.value = "";
                }}
              />
              <Button
                className="w-full"
                disabled={upload.isPending}
                onClick={() => fileInput.current?.click()}
              >
                {upload.isPending ? "Reading the document…" : "Choose file"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Documents the candidate mails to your careers address are filed here automatically.
              </p>
            </div>

            <ul className="space-y-2">
              {docs.map((d) => (
                <li key={d.id}>
                  <button
                    onClick={() => setSelectedId(d.id)}
                    className={`w-full rounded-lg border p-3 text-left text-sm transition ${
                      selected?.id === d.id
                        ? "border-foreground"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{d.doc_type_label}</span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] ${STATUS_TONE[d.status] ?? ""}`}
                      >
                        {STATUS_LABEL[d.status] ?? d.status}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{d.file_name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {d.source === "careers_inbox" ? "Received by mail" : "Uploaded"} ·{" "}
                      {new Date(d.created_at).toLocaleDateString()}
                    </div>
                  </button>
                </li>
              ))}
              {docs.length === 0 ? (
                <li className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                  No documents yet. Upload them here, or ask the candidate to mail them to your
                  careers address.
                </li>
              ) : null}
            </ul>
          </div>

          {selected ? (
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="border-b border-border p-2.5 text-xs text-muted-foreground">
                  Original document · {selected.file_name}
                </div>
                <FileViewer docId={selected.id} />
              </div>

              <div className="space-y-4">
                <Extraction doc={selected} />

                <div className="space-y-2 rounded-lg border border-border p-3">
                  <Label className="text-xs text-muted-foreground">
                    Validation note (mandatory when rejecting)
                  </Label>
                  <Textarea
                    rows={3}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Name matches the ID, CTC matches the payslip…"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={review.isPending}
                      onClick={() => review.mutate("verified")}
                    >
                      Validate
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={review.isPending}
                      onClick={() => review.mutate("rejected")}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={reextract.isPending}
                      onClick={() => reextract.mutate()}
                    >
                      {reextract.isPending ? "Reading…" : "Read again"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate()}
                    >
                      Remove
                    </Button>
                  </div>
                  {selected.reviewed_at ? (
                    <p className="text-xs text-muted-foreground">
                      Last decision {new Date(selected.reviewed_at).toLocaleString()}.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
              Pick a document on the left to see the original beside what was read from it.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
