/**
 * Hidden-text stripping for CVs and documents (docs/guardrails.md, P1-1).
 *
 * A CV can carry text a person reading the rendered page never sees — white on
 * white, a 1-point font, PDF "invisible" text, hidden Word runs — but a text
 * extractor (and so the AI) reads it. That is the classic way to plant
 * instructions or keyword-stuff a CV. The visible text is kept; hidden text is
 * dropped and replaced by one marker line (`HIDDEN_TEXT_MARKER`) so reviewers
 * see that something was removed and the injection tripwire flags the
 * candidate. The hidden words themselves never reach a prompt.
 *
 * Shared by the server extractor (src/lib/cv-text.server.ts) and the browser
 * one (src/lib/cv-extract.ts) — no imports, pdf.js is passed in.
 *
 * Kept on purpose (false positives are worse than a missed trick):
 *   - white text on a page that painted a coloured shape or an image first
 *     (a dark banner, a photo background);
 *   - invisible text on a page with an image (the OCR layer of a scanned CV).
 */

export const HIDDEN_TEXT_MARKER = "[Hidden text removed from this document";

/** Fewer hidden characters than this (after trimming) is noise, not a trick. */
const MIN_HIDDEN_CHARS = 3;
/** Effective font size (points) below which text cannot be read on the page. */
const TINY_FONT_PT = 3;
/** Relative luminance at or above which text is treated as white. */
const NEAR_WHITE = 0.92;

export function hiddenTextMarker(chars: number): string {
  return `${HIDDEN_TEXT_MARKER}: ${chars} characters]`;
}

/** Visible text plus the marker when anything was removed. */
export function withHiddenMarker(visible: string, hidden: string[]): string {
  const chars = hidden.join("").replace(/\s+/g, "").length;
  if (chars < MIN_HIDDEN_CHARS) return visible;
  return `${visible}\n${hiddenTextMarker(chars)}`.trim();
}

/** Luminance (0–1) of "#rrggbb"; null when the colour cannot be read. */
export function luminance(hex: unknown): number | null {
  if (typeof hex !== "string") return null;
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/* ------------------------------------------------------------------ PDF */

type PdfOps = Record<string, number>;
type PdfTextItem = { str?: string; transform?: number[]; height?: number };
type PdfPage = {
  view: number[];
  getTextContent: () => Promise<{ items: unknown[] }>;
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Text of one glyph array from a show-text operator (spacing numbers ignored, wide gaps as spaces). */
function glyphText(glyphs: unknown): string {
  if (!Array.isArray(glyphs)) return "";
  let out = "";
  for (const g of glyphs) {
    if (typeof g === "number") {
      if (g < -200) out += " ";
    } else if (g && typeof g === "object" && "unicode" in g) {
      out += String((g as { unicode: unknown }).unicode ?? "");
    }
  }
  return out;
}

/**
 * Walk a page's drawing operators and return the text runs drawn hidden and
 * those drawn visible (colour, render mode and what was painted behind them).
 */
async function classifyRuns(
  page: PdfPage,
  OPS: PdfOps,
): Promise<{ hidden: string[]; visible: Set<string> }> {
  const list = await page.getOperatorList();
  const FILL_OPS = new Set(
    ["fill", "eoFill", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"]
      .map((k) => OPS[k])
      .filter((v): v is number => typeof v === "number"),
  );
  const IMAGE_OPS = new Set(
    [
      "paintImageXObject",
      "paintInlineImageXObject",
      "paintImageMaskXObject",
      "paintJpegXObject",
      "paintImageXObjectRepeat",
      "paintInlineImageXObjectGroup",
      "paintImageMaskXObjectGroup",
      "paintImageMaskXObjectRepeat",
      "paintSolidColorImageMask",
    ]
      .map((k) => OPS[k])
      .filter((v): v is number => typeof v === "number"),
  );
  const SHOW_OPS = new Set(
    ["showText", "showSpacedText", "nextLineShowText", "nextLineSetSpacingShowText"]
      .map((k) => OPS[k])
      .filter((v): v is number => typeof v === "number"),
  );

  type State = { fill: number | null; mode: number };
  let st: State = { fill: 0, mode: 0 };
  const stack: State[] = [];
  let paintedBackground = false; // a coloured shape or image was drawn on this page
  let paintedImage = false;
  const hidden: string[] = [];
  const visible = new Set<string>();

  list.fnArray.forEach((fn, i) => {
    const args = list.argsArray[i] ?? [];
    if (fn === OPS["save"]) stack.push({ ...st });
    else if (fn === OPS["restore"]) st = stack.pop() ?? st;
    else if (fn === OPS["setFillRGBColor"]) st.fill = luminance(args[0]);
    else if (fn === OPS["setFillGray"])
      st.fill = typeof args[0] === "number" ? Number(args[0]) : null;
    else if (fn === OPS["setTextRenderingMode"]) st.mode = Number(args[0]) || 0;
    else if (IMAGE_OPS.has(fn)) {
      paintedBackground = true;
      paintedImage = true;
    } else if (
      FILL_OPS.has(fn) ||
      (fn === OPS["constructPath"] && typeof args[0] === "number" && FILL_OPS.has(args[0]))
    ) {
      if (st.fill === null || st.fill < NEAR_WHITE) paintedBackground = true;
    } else if (SHOW_OPS.has(fn)) {
      const text = norm(glyphText(args[fn === OPS["nextLineSetSpacingShowText"] ? 2 : 0]));
      if (!text) return;
      // Render modes 3 (invisible) and 7 (clip only) draw nothing — unless an
      // image sits under them, which is how scanned CVs carry their OCR text.
      const invisible = (st.mode === 3 || st.mode === 7) && !paintedImage;
      const whiteOnWhite = st.fill !== null && st.fill >= NEAR_WHITE && !paintedBackground;
      if (invisible || whiteOnWhite) hidden.push(text);
      else visible.add(text);
    }
  });
  return { hidden, visible };
}

/**
 * The visible text of a PDF page and the hidden runs removed from it.
 * Text items come from pdf.js `getTextContent` (as before); an item is
 * dropped when it is tiny, off the page, or drawn hidden per `classifyRuns`.
 */
export async function pdfPageVisibleText(
  page: PdfPage,
  OPS: PdfOps,
): Promise<{ text: string; hidden: string[] }> {
  const [content, runs] = await Promise.all([
    page.getTextContent(),
    classifyRuns(page, OPS).catch(() => ({ hidden: [] as string[], visible: new Set<string>() })),
  ]);
  // Hidden runs that never also appear visibly (same words drawn both ways stay).
  const hiddenRuns = runs.hidden.filter((h) => !runs.visible.has(h) && h.length >= 2);
  const [x0, y0, x1, y1] = page.view.length === 4 ? page.view : [0, 0, 1e6, 1e6];
  const out: string[] = [];
  const removed: string[] = [];
  for (const raw of content.items) {
    const it = raw as PdfTextItem;
    if (typeof it.str !== "string") continue;
    let str = it.str;
    const t = it.transform ?? [];
    const size = t.length >= 4 ? Math.hypot(t[2]!, t[3]!) : (it.height ?? 12);
    const x = t[4] ?? 0;
    const y = t[5] ?? 0;
    const offPage = x < x0! - 5 || x > x1! + 5 || y < y0! - 5 || y > y1! + 5;
    if (str.trim() && (size < TINY_FONT_PT || offPage)) {
      removed.push(str);
      continue;
    }
    const n = norm(str);
    // A whole hidden run, or a piece of one pdf.js split off (never a piece
    // that also appears in visible text).
    const pieceOfHidden =
      n.length >= 4 &&
      hiddenRuns.some((h) => h.includes(n)) &&
      ![...runs.visible].some((v) => v.includes(n));
    if (n && (hiddenRuns.includes(n) || pieceOfHidden)) {
      removed.push(str);
      continue;
    }
    // pdf.js may merge a hidden run into a neighbouring item: cut it out.
    for (const h of hiddenRuns) {
      if (h.length >= 4 && n.includes(h)) {
        removed.push(h);
        str = norm(str).replace(h, " ");
      }
    }
    out.push(str);
  }
  return { text: out.join(" "), hidden: removed };
}

/** Whole-document helper: visible text of every page, joined, plus everything removed. */
export async function pdfVisibleText(
  doc: { numPages: number; getPage: (n: number) => Promise<unknown> },
  OPS: PdfOps,
  pageSeparator = " ",
): Promise<{ text: string; hidden: string[] }> {
  const pages: string[] = [];
  const hidden: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const r = await pdfPageVisibleText((await doc.getPage(i)) as PdfPage, OPS);
    pages.push(r.text.replace(/\s+/g, " "));
    hidden.push(...r.hidden);
  }
  return { text: pages.join(pageSeparator).trim(), hidden };
}

/* ----------------------------------------------------------------- DOCX */

/**
 * Word runs a reader never sees: hidden (`w:vanish`, `w:webHidden`), white /
 * near-white text, or a font under 3 points (`w:sz` is in half-points).
 * Returns the document XML without them, plus their text.
 */
export function stripHiddenDocxRuns(xml: string): { xml: string; hidden: string[] } {
  const hidden: string[] = [];
  const cleaned = xml.replace(/<w:r[ >][\s\S]*?<\/w:r>/g, (run) => {
    const props = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? "";
    const vanish = /<w:(vanish|webHidden)(\s*\/>|\s+w:val="(true|1|on)"\s*\/>)/.test(props);
    const color = /<w:color\s+w:val="([0-9A-Fa-f]{6})"/.exec(props)?.[1];
    const white = color ? (luminance(`#${color}`) ?? 0) >= NEAR_WHITE : false;
    const sz = Number(/<w:sz\s+w:val="(\d+)"/.exec(props)?.[1] ?? NaN);
    const tiny = Number.isFinite(sz) && sz / 2 < TINY_FONT_PT;
    // White text is kept when the run has its own shading (text on a coloured box).
    const shaded = /<w:shd\b[^>]*w:fill="(?!auto|FFFFFF|ffffff)[0-9A-Fa-f]{6}"/.test(props);
    if (vanish || tiny || (white && !shaded)) {
      const text = (run.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? [])
        .map((t) => t.replace(/<[^>]+>/g, ""))
        .join("");
      if (text.trim()) hidden.push(text);
      return "";
    }
    return run;
  });
  return { xml: cleaned, hidden };
}
