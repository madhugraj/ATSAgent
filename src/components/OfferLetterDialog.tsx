/**
 * Generate, hand-correct, preview and download the offer letter for one offer.
 * The letter is composed server-side against an offer_letter template (or the
 * org default), persisted on the offer row, editable inline, and reused for
 * every preview and download until regenerated or saved over.
 */
import { OfferPolicyCheck } from "@/components/OfferPolicyCheck";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { templatesQuery, type Offer } from "@/lib/data";
import {
  generateOfferLetter,
  OfferLetterPayload,
  fmtLetterDate,
  updateOfferLetter,
  deleteOfferLetter,
  type EditableOfferLetter,
  type OfferLetterPayload as Letter,
} from "@/lib/offers.functions";
import { downloadOfferLetterPdf, type LetterLogo } from "@/lib/offer-letter-pdf";
import { getTemplateLogo } from "@/lib/templates.functions";
import { useRoles } from "@/hooks/useRoles";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const logoSrc = (logo: LetterLogo) => `data:${logo.contentType};base64,${logo.base64}`;

/* Edit-mode field chrome — labelled controls inside the paper look. */
function EditLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-violet-600">
      {children}
    </span>
  );
}

export function OfferLetterDialog({
  offer,
  candidateName,
  open,
  onOpenChange,
}: {
  offer: Offer;
  candidateName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [letter, setLetter] = useState<Letter | null>(null);
  const [logo, setLogo] = useState<LetterLogo | null>(null);
  const [busy, setBusy] = useState(false);
  /** Template for the NEXT generation — "" means the org default. */
  const [templateId, setTemplateId] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditableOfferLetter | null>(null);
  /** Governed deletion — visible to HR head+, always reason-backed. */
  const [deleting, setDeleting] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  /** Set once a letter was deleted here so the dialog does not auto-regenerate. */
  const [deleted, setDeleted] = useState(false);

  const { roles, isAdmin } = useRoles();
  const canGovern = isAdmin || roles.includes("hr_head");

  const offerTemplates = (useQuery(templatesQuery).data ?? []).filter(
    (t) => t.kind === "offer_letter",
  );

  async function generate() {
    setBusy(true);
    setDeleted(false);
    try {
      // "" / " " = let the server resolve the org default (Radix forbids "" item values).
      const payload = await generateOfferLetter({
        data: { offerId: offer.id, templateId: templateId.trim() || undefined },
      });
      setLetter(payload);
      setLogo(null);
      setTemplateId(payload.templateId ?? "");
      setEditing(false);
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["offers"] });
      toast.success("Offer letter generated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not generate the offer letter");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const parsed = OfferLetterPayload.safeParse(offer.letter);
    if (parsed.success) {
      setLetter(parsed.data);
      return;
    }
    if (!busy && !deleted) void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, offer.letter]);

  // Letterhead logo is only referenced by id — fetch its bytes lazily.
  useEffect(() => {
    if (!letter?.hasLogo || !letter.templateId || logo) return;
    let cancelled = false;
    void getTemplateLogo({ data: { templateId: letter.templateId } }).then((res) => {
      if (!cancelled && res.ok) setLogo({ base64: res.base64, contentType: res.contentType });
    });
    return () => {
      cancelled = true;
    };
  }, [letter, logo]);

  function startEdit() {
    if (!letter) return;
    setDraft({
      subject: letter.subject,
      greeting: letter.greeting,
      opening: letter.opening,
      sections: letter.sections.map((s) => ({ ...s })),
      closing: letter.closing,
      boilerplate: letter.boilerplate,
      headerLines: [...letter.headerLines],
      footerLines: [...letter.footerLines],
      refText: letter.refText,
    });
    setEditing(true);
  }

  async function saveEdit() {
    if (!draft) return;
    setBusy(true);
    try {
      const updated = await updateOfferLetter({ data: { offerId: offer.id, letter: draft } });
      setLetter(updated);
      setEditing(false);
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["offers"] });
      toast.success("Letter updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the letter");
    } finally {
      setBusy(false);
    }
  }

  function discardEdit() {
    setEditing(false);
    setDraft(null);
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      await deleteOfferLetter({
        data: { offerId: offer.id, reason: deleteReason.trim() },
      });
      setLetter(null);
      setDeleted(true);
      setDeleting(false);
      setDeleteReason("");
      qc.invalidateQueries({ queryKey: ["offers"] });
      toast.success("Offer letter deleted — the deletion is recorded in the offer trail");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the letter");
    } finally {
      setBusy(false);
    }
  }

  const dset = <K extends keyof EditableOfferLetter>(key: K, value: EditableOfferLetter[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  const setSection = (i: number, patch: Partial<{ heading: string; body: string }>) =>
    setDraft((d) =>
      d ? { ...d, sections: d.sections.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) } : d,
    );
  const moveSection = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      if (!d) return d;
      const j = i + dir;
      if (j < 0 || j >= d.sections.length) return d;
      const a = d.sections[i];
      const b = d.sections[j];
      if (!a || !b) return d;
      const sections = [...d.sections];
      sections[i] = b;
      sections[j] = a;
      return { ...d, sections };
    });
  const removeSection = (i: number) =>
    setDraft((d) =>
      d && d.sections.length > 1 ? { ...d, sections: d.sections.filter((_, idx) => idx !== i) } : d,
    );
  const addSection = () =>
    setDraft((d) => (d ? { ...d, sections: [...d.sections, { heading: "", body: "" }] } : d));

  async function download() {
    if (!letter) return;
    try {
      downloadOfferLetterPdf(letter, logo);
    } catch {
      toast.error("Could not build the PDF");
    }
  }

  const head = letter?.letterhead;
  const paperLines = letter
    ? [letter.candidate.location, letter.candidate.email, letter.candidate.phone].filter(Boolean)
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Offer letter — {candidateName}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Editing the letter — changes apply to the preview, the PDF and what approvers see."
              : letter
                ? `Generated ${fmtLetterDate(letter.generatedAt)} · ` +
                  `Template: ${letter.templateName ?? "built-in structure"} · ` +
                  "Regenerating replaces the stored letter."
                : "Composing the letter against your offer-letter template…"}
          </DialogDescription>
        </DialogHeader>

        {letter && head && draft && editing ? (
          <div className="mx-auto w-full space-y-3 rounded-md border bg-white p-6 text-[13px] leading-6 text-zinc-900">
            <div>
              <EditLabel>Letterhead lines (one per line)</EditLabel>
              <Textarea
                rows={3}
                value={draft.headerLines.join("\n")}
                onChange={(e) => dset("headerLines", e.target.value.split("\n"))}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <EditLabel>Reference number</EditLabel>
                <Input
                  value={draft.refText ?? ""}
                  onChange={(e) => dset("refText", e.target.value || null)}
                />
              </div>
              <div>
                <EditLabel>Letter date</EditLabel>
                <Input value={fmtLetterDate(letter.generatedAt) ?? ""} disabled />
              </div>
            </div>
            <div>
              <EditLabel>Subject</EditLabel>
              <Input value={draft.subject} onChange={(e) => dset("subject", e.target.value)} />
            </div>
            <div>
              <EditLabel>Salutation</EditLabel>
              <Input value={draft.greeting} onChange={(e) => dset("greeting", e.target.value)} />
            </div>
            <div>
              <EditLabel>Opening</EditLabel>
              <Textarea
                rows={3}
                value={draft.opening}
                onChange={(e) => dset("opening", e.target.value)}
              />
            </div>

            <div className="space-y-3">
              <EditLabel>Sections</EditLabel>
              {draft.sections.map((s, i) => (
                <div key={i} className="rounded-md border border-zinc-200 p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <Input
                        className="font-semibold"
                        value={s.heading}
                        placeholder="Section heading"
                        onChange={(e) => setSection(i, { heading: e.target.value })}
                      />
                    </div>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={i === 0}
                        onClick={() => moveSection(i, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={i === draft.sections.length - 1}
                        onClick={() => moveSection(i, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={draft.sections.length === 1}
                        onClick={() => removeSection(i)}
                      >
                        ✕
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    className="mt-2"
                    rows={4}
                    value={s.body}
                    placeholder="Body — blank lines split paragraphs, lines starting with “- ” render as list items"
                    onChange={(e) => setSection(i, { body: e.target.value })}
                  />
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addSection}>
                + Add section
              </Button>
            </div>

            <div>
              <EditLabel>Fixed clauses (rendered as the boxed block)</EditLabel>
              <Textarea
                rows={3}
                value={draft.boilerplate ?? ""}
                onChange={(e) => dset("boilerplate", e.target.value)}
              />
            </div>
            <div>
              <EditLabel>Closing</EditLabel>
              <Textarea
                rows={2}
                value={draft.closing}
                onChange={(e) => dset("closing", e.target.value)}
              />
            </div>
            <div>
              <EditLabel>Page footer lines (one per line)</EditLabel>
              <Textarea
                rows={2}
                value={draft.footerLines.join("\n")}
                onChange={(e) => dset("footerLines", e.target.value.split("\n"))}
              />
            </div>
          </div>
        ) : letter && head ? (
          <div className="mx-auto w-full rounded-md border bg-white p-8 text-[13px] leading-6 text-zinc-900">
            <div className="text-center">
              {logo ? (
                <img src={logoSrc(logo)} alt="" className="mx-auto mb-3 max-h-14 object-contain" />
              ) : (
                <div className="text-lg font-semibold">{head.orgName}</div>
              )}
              <div className="mt-0.5 text-xs text-zinc-500">
                {(letter.headerLines.length
                  ? letter.headerLines
                  : [
                      head.legalName !== head.orgName ? head.legalName : null,
                      head.hqCity,
                      head.careersEmail,
                    ].filter(Boolean)
                ).map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </div>
            <hr className="my-5" style={{ borderColor: letter.accentColor }} />
            <div className="flex justify-between text-xs text-zinc-500">
              <span>{letter.refText}</span>
              <span>{fmtLetterDate(letter.generatedAt)}</span>
            </div>
            <div className="mt-3">
              <div className="font-medium">{letter.candidate.fullName}</div>
              {paperLines.map((l) => (
                <div key={l} className="text-zinc-600">
                  {l}
                </div>
              ))}
            </div>
            <p className="mt-5 font-semibold">Subject: {letter.subject}</p>
            <p className="mt-4 whitespace-pre-line">{letter.greeting}</p>
            <p className="mt-3 whitespace-pre-line">{letter.opening}</p>
            {letter.sections.map((s) => (
              <div key={s.heading} className="mt-4">
                <h3 className="font-semibold" style={{ color: letter.accentColor }}>
                  {s.heading}
                </h3>
                <p className="mt-1 whitespace-pre-line">{s.body}</p>
              </div>
            ))}
            {letter.boilerplate ? (
              <div
                className="mt-5 whitespace-pre-line rounded border bg-zinc-50 p-3 text-xs italic text-zinc-700"
                style={{ borderColor: letter.accentColor }}
              >
                {letter.boilerplate}
              </div>
            ) : null}
            <p className="mt-4 whitespace-pre-line">{letter.closing}</p>
            <div className="mt-10">
              <p>For {head.orgName}</p>
              {letter.signatory ? (
                <div className="mt-10">
                  <p className="font-semibold">{letter.signatory.name}</p>
                  <p>{letter.signatory.designation}</p>
                </div>
              ) : null}
              <p className="mt-6">Authorised Signatory</p>
            </div>
            {letter.footerLines.length ? (
              <div className="mt-8 border-t border-zinc-200 pt-2 text-center text-[10px] leading-4 text-zinc-500">
                {letter.footerLines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
            {busy
              ? "Drafting the letter…"
              : deleted
                ? "Letter deleted. Generate a new one when you are ready."
                : "No letter yet."}
          </div>
        )}

        <OfferPolicyCheck offerId={offer.id} hasLetter={Boolean(letter)} />
        <DialogFooter className="gap-3 sm:justify-between">
          {deleting ? (
            <div className="w-full sm:w-96">
              <Label className="mb-1.5 block text-xs font-medium text-destructive">
                Reason for deleting the letter (recorded in the offer trail)
              </Label>
              <Textarea
                rows={2}
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="e.g. Wrong CTC entered — the offer will be corrected and re-raised"
              />
            </div>
          ) : editing && draft ? (
            <p className="self-center text-xs text-muted-foreground">
              Candidate facts (name, role, CTC) come from the offer — regenerate or edit the
              template for those.
            </p>
          ) : offerTemplates.length > 0 ? (
            <div className="w-full sm:w-72">
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                Offer-letter template
              </Label>
              <Select value={templateId} onValueChange={setTemplateId} disabled={busy}>
                <SelectTrigger>
                  <SelectValue placeholder="Organisation default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value=" ">Organisation default</SelectItem>
                  {offerTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                      {t.is_default ? " (default)" : ""}
                      {t.has_logo ? " · logo" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="self-center text-xs text-muted-foreground">
              No offer-letter templates yet — the built-in structure is used. Create one under
              Governance → Content templates.
            </p>
          )}
          <div className="flex gap-2">
            {deleting ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setDeleting(false);
                    setDeleteReason("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy || deleteReason.trim().length < 8}
                  onClick={() => void confirmDelete()}
                >
                  Delete letter
                </Button>
              </>
            ) : editing && draft ? (
              <>
                <Button variant="outline" disabled={busy} onClick={discardEdit}>
                  Cancel
                </Button>
                <Button disabled={busy} onClick={() => void saveEdit()}>
                  Save changes
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" disabled={busy || !letter} onClick={startEdit}>
                  Edit
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => void generate()}>
                  {letter ? "Regenerate" : "Generate"}
                </Button>
                <Button disabled={busy || !letter} onClick={() => void download()}>
                  Download PDF
                </Button>
                {letter && canGovern ? (
                  <Button
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10"
                    disabled={busy}
                    onClick={() => setDeleting(true)}
                  >
                    Delete
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
