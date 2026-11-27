import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

import { parseJdMarkdown, type JdDocument, type JdLogo } from "./jd-pdf";

/**
 * The same JD export as jd-pdf.ts, as a Word document, built in the browser
 * with the `docx` package (MIT). Same content model: letterhead (logo,
 * organisation name, header lines, accent rule), title, headings /
 * paragraphs / bullets from the full_text markdown, footer lines on every
 * page.
 *
 * docx limitations worth knowing:
 * - ImageRun needs explicit pixel dimensions (Word has no auto-size), so the
 *   logo's aspect is decoded via an Image element; on failure a 3:1 box is
 *   assumed.
 * - DOCX cannot embed WebP images, so a webp logo is skipped in the Word
 *   export (the PDF export still carries it).
 * - No WinAnsi sanitizer needed here: DOCX text is unicode, so ₹, curly
 *   quotes and real dashes survive verbatim.
 */

const MUTED = "6e6e78";
const INK = "111114";

/** Word font stack per template fontFamily — undefined keeps Word's default. */
const DOCX_FONT: Record<string, string | null> = {
  system: null,
  serif: "Times New Roman",
  mono: "Courier New",
};

/** Pixel size (docx measures at 96 dpi) that matches the PDF's ~120 pt logo. */
const LOGO_MAX_WIDTH_PX = 160;

function logoType(contentType: string): "jpg" | "png" | "gif" | "bmp" | null {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  if (contentType === "image/gif") return "gif";
  if (contentType === "image/bmp") return "bmp";
  return null; // webp (and anything else) cannot live inside a DOCX
}

function logoDims(dataUri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 300, height: 100 });
    img.src = dataUri;
  });
}

export async function buildJdDocx(doc0: JdDocument, logo?: JdLogo | null) {
  const accent = doc0.brand.accentColor.replace(/^#/, "").toUpperCase();
  const font = DOCX_FONT[doc0.brand.fontFamily];

  /** Runs sized like the PDF export; the font only when the template sets one. */
  const run = (text: string, opts: { bold?: boolean; size: number; color?: string }): TextRun =>
    new TextRun({
      text,
      size: opts.size,
      color: opts.color ?? INK,
      ...(opts.bold ? { bold: true } : {}),
      ...(font ? { font } : {}),
    });

  const children: Paragraph[] = [];

  /* letterhead */
  const type = logo ? logoType(logo.contentType) : null;
  if (logo && type) {
    const dataUri = `data:${logo.contentType};base64,${logo.base64}`;
    const dims = await logoDims(dataUri);
    const w = Math.min(LOGO_MAX_WIDTH_PX, dims.width);
    const h = Math.round((dims.height / dims.width) * w);
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            type,
            data: dataUri,
            transformation: { width: w, height: Math.max(1, h) },
          }),
        ],
      }),
    );
  } else {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [run(doc0.orgName, { bold: true, size: 30 })],
      }),
    );
  }
  for (const line of doc0.brand.headerLines) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [run(line, { size: 18, color: MUTED })],
      }),
    );
  }
  children.push(
    new Paragraph({
      spacing: { after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 9, color: accent, space: 4 } },
      children: [],
    }),
  );

  /* title */
  children.push(
    new Paragraph({
      spacing: { after: 200 },
      children: [run(doc0.title, { bold: true, size: 32 })],
    }),
  );

  /* body — same block model as the PDF export */
  for (const block of parseJdMarkdown(doc0.fullText)) {
    if (block.type === "heading") {
      children.push(
        new Paragraph({
          heading:
            block.level === 1
              ? HeadingLevel.HEADING_1
              : block.level === 2
                ? HeadingLevel.HEADING_2
                : HeadingLevel.HEADING_3,
          spacing: { before: 220, after: 100 },
          children: [
            run(block.text, {
              bold: true,
              // Mirrors the PDF's three-tier scale (13 / 11.5 / 10.5pt in half-points).
              size: block.level === 1 ? 26 : block.level === 2 ? 23 : 21,
              color: accent,
            }),
          ],
        }),
      );
    } else if (block.type === "bullet") {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 60 },
          children: [run(block.text, { size: 20 })],
        }),
      );
    } else {
      children.push(
        new Paragraph({
          spacing: { after: 120 },
          children: [run(block.text, { size: 20 })],
        }),
      );
    }
  }

  /* footer lines on every page, with page numbers */
  const pageRun = (text: string) => run(text, { size: 16, color: MUTED });
  const fieldRun = (field: typeof PageNumber.CURRENT | typeof PageNumber.TOTAL_PAGES) =>
    new TextRun({ children: [field], size: 16, color: MUTED, ...(font ? { font } : {}) });
  const footerPrefix = doc0.brand.footerLines.length
    ? `${doc0.brand.footerLines.join("  ·  ")}   ·   Page `
    : "Page ";
  const footer = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      pageRun(footerPrefix),
      fieldRun(PageNumber.CURRENT),
      pageRun(" of "),
      fieldRun(PageNumber.TOTAL_PAGES),
    ],
  });

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { size: 20, color: INK, ...(font ? { font } : {}) },
        },
      },
    },
    sections: [
      {
        properties: {},
        footers: { default: new Footer({ children: [footer] }) },
        children,
      },
    ],
  });

  return Packer.toBlob(doc);
}

export async function downloadJdDocx(doc0: JdDocument, logo?: JdLogo | null) {
  const blob = await buildJdDocx(doc0, logo);
  const url = URL.createObjectURL(blob);
  const safe = doc0.title
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const a = document.createElement("a");
  a.href = url;
  a.download = `jd-${safe || "requisition"}-${new Date().toISOString().slice(0, 10)}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}
