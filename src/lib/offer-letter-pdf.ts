import { jsPDF } from "jspdf";

import type { OfferLetterPayload } from "./offers.functions";
import { fmtLetterDate } from "./offers.functions";

/** The offer letter as a downloadable A4 PDF, built in the browser. */

const INK: [number, number, number] = [17, 17, 20];
const MUTED: [number, number, number] = [110, 110, 120];

export type LetterLogo = { base64: string; contentType: string };

/** jsPDF's built-in fonts cover WinAnsi only, so swap glyphs they cannot draw. */
function pdfText(t: string) {
  return t
    .replace(/₹/g, "Rs. ")
    .replace(/[→←↔]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–|—/g, "-");
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m?.[1]) return [88, 77, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function buildOfferLetterPdf(payload: OfferLetterPayload, logo?: LetterLogo | null) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const margin = 56;
  const textWidth = width - margin * 2;

  let y = margin;

  const ensure = (needed: number) => {
    if (y + needed <= height - 48) return;
    doc.addPage();
    y = margin;
  };

  /* letterhead */
  const head = payload.letterhead;
  let drewLogo = false;
  if (logo) {
    try {
      const fmt =
        logo.contentType === "image/jpeg"
          ? "JPEG"
          : logo.contentType === "image/webp"
            ? "WEBP"
            : "PNG";
      const img = doc.getImageProperties(`data:${logo.contentType};base64,${logo.base64}`);
      const w = Math.min(150, img.width);
      const h = (img.height / img.width) * w;
      doc.addImage(`data:${logo.contentType};base64,${logo.base64}`, fmt, (width - w) / 2, y, w, h);
      y += h + 10;
      drewLogo = true;
    } catch {
      /* unreadable image bytes — fall through to the text letterhead */
    }
  }
  if (!drewLogo) {
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text(pdfText(head.orgName), width / 2, y + 16, { align: "center" });
    y += 22;
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  const sub: string[] = payload.headerLines.length
    ? payload.headerLines
    : [
        head.legalName && head.legalName !== head.orgName ? head.legalName : "",
        head.hqCity ?? "",
        head.careersEmail ?? "",
      ].filter(Boolean);
  if (sub.length) {
    const lines = doc.splitTextToSize(
      pdfText(sub.join(payload.headerLines.length ? "\n" : "  ·  ")),
      textWidth,
    );
    doc.text(lines, width / 2, y + 4, { align: "center" });
    y += lines.length * 11 + 4;
  }
  y += 8;
  doc.setDrawColor(...hexRgb(payload.accentColor));
  doc.setLineWidth(1.2);
  doc.line(margin, y, width - margin, y);
  y += 26;

  /* date + reference + candidate block */
  const issued = fmtLetterDate(payload.generatedAt) ?? "";
  doc.setTextColor(...MUTED);
  doc.setFontSize(10);
  doc.text(pdfText(issued), width - margin, y, { align: "right" });
  if (payload.refText) {
    doc.text(pdfText(payload.refText), margin, y);
  }
  doc.setTextColor(...INK);
  const who = [
    payload.candidate.fullName,
    payload.candidate.location ?? "",
    payload.candidate.email ?? "",
    payload.candidate.phone ?? "",
  ].filter(Boolean);
  doc.text(doc.splitTextToSize(who.map(pdfText).join("\n"), textWidth), margin, y + 14);
  y += 14 + who.length * 13 + 14;

  /* subject + salutation */
  ensure(90);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  const subj = doc.splitTextToSize(pdfText(`Subject: ${payload.subject}`), textWidth);
  doc.text(subj, margin, y);
  y += subj.length * 13 + 12;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(pdfText(payload.greeting), margin, y);
  y += 16;

  const para = (
    text: string,
    opts: {
      indent?: number;
      size?: number;
      font?: "normal" | "bold" | "italic";
      boxed?: boolean;
    } = {},
  ) => {
    const size = opts.size ?? 10;
    const indent = opts.indent ?? 0;
    doc.setFont("helvetica", opts.font ?? "normal");
    doc.setFontSize(size);
    doc.setTextColor(...INK);
    const inner = textWidth - indent - (opts.boxed ? 16 : 0);
    const lines = doc.splitTextToSize(pdfText(text), inner);
    const lead = size * 1.35;
    const boxPad = opts.boxed ? 8 : 0;
    const blockH = lines.length * lead + boxPad * 2;
    ensure(blockH + 10);
    if (opts.boxed) {
      doc.setDrawColor(...hexRgb(payload.accentColor));
      doc.setFillColor(250, 250, 251);
      doc.rect(margin, y, textWidth, blockH, "FD");
    }
    doc.text(lines, margin + indent + (opts.boxed ? 8 : 0), y + boxPad + size);
    y += blockH + 10;
  };

  para(payload.opening);

  for (const s of payload.sections) {
    ensure(60);
    y += 2;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...hexRgb(payload.accentColor));
    const h = doc.splitTextToSize(pdfText(s.heading), textWidth);
    doc.text(h, margin, y + 10);
    y += h.length * 14 + 6;
    para(s.body);
  }

  if (payload.boilerplate) {
    para(payload.boilerplate, { size: 9, font: "italic", boxed: true });
  }

  para(payload.closing);
  y += 6;

  /* signature */
  ensure(payload.signatory ? 84 : 70);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(pdfText(`For ${head.orgName}`), margin, y);
  y += 46;
  if (payload.signatory) {
    doc.setFont("helvetica", "bold");
    doc.text(pdfText(payload.signatory.name), margin, y);
    y += 13;
    doc.setFont("helvetica", "normal");
    doc.text(pdfText(payload.signatory.designation), margin, y);
    y += 13;
  }
  doc.text("Authorised Signatory", margin, y);

  /* footer */
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    const footerText = payload.footerLines.length
      ? `${pdfText(payload.footerLines.join("  ·  "))}   ·   Page ${i} of ${pages}`
      : `${pdfText(head.orgName)} — offer letter   ·   Page ${i} of ${pages}`;
    doc.text(doc.splitTextToSize(footerText, textWidth), margin, height - 24);
  }

  return doc;
}

export function downloadOfferLetterPdf(payload: OfferLetterPayload, logo?: LetterLogo | null) {
  const doc = buildOfferLetterPdf(payload, logo);
  const safe = payload.candidate.fullName
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  doc.save(`offer-letter-${safe || "candidate"}-${payload.generatedAt.slice(0, 10)}.pdf`);
}
