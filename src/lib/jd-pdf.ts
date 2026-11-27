import { jsPDF } from "jspdf";

import type { JdTemplateConfig } from "./templates.server";

/**
 * The job description as a downloadable A4 PDF, built in the browser — the
 * offer-letter export pattern (logo bytes fetched separately, WinAnsi-safe
 * text, accent-coloured headings, per-page footer) applied to the JD's
 * full_text markdown. Headings (#/##/###), paragraphs and bullet lists; no
 * tables in v1.
 */

const INK: [number, number, number] = [17, 17, 20];
const MUTED: [number, number, number] = [110, 110, 120];
const DEFAULT_ACCENT: [number, number, number] = [79, 70, 229]; // #4f46e5

export type JdLogo = { base64: string; contentType: string };

/** The branding fields the exports draw from, leniently read off a jd config. */
export type JdBrand = {
  accentColor: string;
  headerLines: string[];
  footerLines: string[];
  fontFamily: "system" | "serif" | "mono";
};

export type JdDocument = {
  /** The requisition title — the document's own heading, above the JD text. */
  title: string;
  orgName: string;
  /** The JD's full_text markdown. */
  fullText: string;
  brand: JdBrand;
};

/**
 * Legacy or partially-filled configs must never break an export: coerce
 * leniently and fall back to the built-in branding (the same defaults the
 * JdTemplateConfig zod schema applies at read time).
 */
export function jdBrandFromConfig(config: unknown): JdBrand {
  const c = (config ?? {}) as Partial<JdTemplateConfig>;
  const lines = (v: unknown, max: number) =>
    Array.isArray(v)
      ? v
          .map((s) => String(s).trim())
          .filter(Boolean)
          .slice(0, max)
      : [];
  return {
    accentColor:
      typeof c.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(c.accentColor)
        ? c.accentColor
        : "#4f46e5",
    headerLines: lines(c.headerLines, 6),
    footerLines: lines(c.footerLines, 4),
    fontFamily: c.fontFamily === "serif" || c.fontFamily === "mono" ? c.fontFamily : "system",
  };
}

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
  if (!m?.[1]) return DEFAULT_ACCENT;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const FONT_STACK = { system: "helvetica", serif: "times", mono: "courier" } as const;

/* ------------------------------------------------------- markdown blocks */

export type JdBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "para"; text: string }
  | { type: "bullet"; text: string };

/** Strip inline markdown emphasis so the PDF draws plain text. */
function cleanInline(s: string) {
  return s
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`/g, "")
    .replace(/\[(.*?)\]\([^)]*\)/g, "$1")
    .trim();
}

/** The full_text markdown as drawable blocks — headings, paragraphs, bullets. */
export function parseJdMarkdown(text: string): JdBlock[] {
  const blocks: JdBlock[] = [];
  const para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ type: "para", text: para.join(" ").trim() });
      para.length = 0;
    }
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const hashes = (line.match(/^#+/) ?? ["#"])[0]!.length;
      blocks.push({
        type: "heading",
        level: Math.min(hashes, 3) as 1 | 2 | 3,
        text: cleanInline(h[1]!),
      });
      continue;
    }
    const b = /^[-*•]\s+(.*)$/.exec(line);
    if (b) {
      flush();
      blocks.push({ type: "bullet", text: cleanInline(b[1]!) });
      continue;
    }
    para.push(cleanInline(line));
  }
  flush();
  return blocks;
}

/* -------------------------------------------------------------- builder */

export function buildJdPdf(doc0: JdDocument, logo?: JdLogo | null) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const margin = 56;
  const textWidth = width - margin * 2;
  const accent = hexRgb(doc0.brand.accentColor);
  const font = FONT_STACK[doc0.brand.fontFamily];

  let y = margin;

  const ensure = (needed: number) => {
    if (y + needed <= height - 48) return;
    doc.addPage();
    y = margin;
  };

  /* letterhead — logo, organisation name, header lines, accent rule */
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
      const w = Math.min(120, img.width);
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
    doc.setFont(font, "bold");
    doc.setFontSize(15);
    doc.text(pdfText(doc0.orgName), width / 2, y + 15, { align: "center" });
    y += 21;
  }
  if (doc0.brand.headerLines.length) {
    doc.setFont(font, "normal");
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    const lines = doc.splitTextToSize(pdfText(doc0.brand.headerLines.join("\n")), textWidth);
    doc.text(lines, width / 2, y + 4, { align: "center" });
    y += lines.length * 11 + 4;
  }
  y += 8;
  doc.setDrawColor(...accent);
  doc.setLineWidth(1.2);
  doc.line(margin, y, width - margin, y);
  y += 24;

  /* document title */
  ensure(60);
  doc.setTextColor(...INK);
  doc.setFont(font, "bold");
  doc.setFontSize(16);
  const title = doc.splitTextToSize(pdfText(doc0.title), textWidth);
  doc.text(title, margin, y + 12);
  y += title.length * 18 + 10;

  /* body — headings accent-coloured, in the order the JD text uses them */
  const para = (text: string, opts: { indent?: number; size?: number; bullet?: boolean } = {}) => {
    const size = opts.size ?? 10;
    const indent = opts.indent ?? 0;
    doc.setFont(font, "normal");
    doc.setFontSize(size);
    doc.setTextColor(...INK);
    const inner = textWidth - indent;
    const lines = doc.splitTextToSize(pdfText(text), inner - (opts.bullet ? 14 : 0));
    const lead = size * 1.35;
    ensure(lines.length * lead + 10);
    const x = margin + indent + (opts.bullet ? 14 : 0);
    if (opts.bullet) {
      doc.text(pdfText("•"), margin + indent + 2, y + size);
    }
    doc.text(lines, x, y + size);
    y += lines.length * lead + 6;
  };

  for (const block of parseJdMarkdown(doc0.fullText)) {
    if (block.type === "heading") {
      ensure(50);
      y += 4;
      const size = block.level === 1 ? 13 : block.level === 2 ? 11.5 : 10.5;
      doc.setFont(font, "bold");
      doc.setFontSize(size);
      doc.setTextColor(...accent);
      const h = doc.splitTextToSize(pdfText(block.text), textWidth);
      doc.text(h, margin, y + size);
      y += h.length * (size * 1.35) + 6;
    } else if (block.type === "bullet") {
      para(block.text, { indent: 8, bullet: true });
    } else {
      para(block.text);
    }
  }

  /* footer — the template's footer lines repeated on every page */
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFont(font, "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    const footerText = doc0.brand.footerLines.length
      ? `${pdfText(doc0.brand.footerLines.join("  ·  "))}   ·   Page ${i} of ${pages}`
      : `Page ${i} of ${pages}`;
    // The footer band is one 8pt line above the page edge: cap the drawn text
    // to its first two wrapped lines so a long footer can never overflow it.
    const footerLines = doc.splitTextToSize(footerText, textWidth).slice(0, 2);
    doc.text(footerLines, margin, height - 24 - (footerLines.length - 1) * 10);
  }

  return doc;
}

export function downloadJdPdf(doc0: JdDocument, logo?: JdLogo | null) {
  const doc = buildJdPdf(doc0, logo);
  const safe = doc0.title
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  doc.save(`jd-${safe || "requisition"}-${new Date().toISOString().slice(0, 10)}.pdf`);
}
