/** CV/document attachment detection and text extraction shared by the careers inbox, Capture and onboarding. */

const CV_EXT = /\.(pdf|docx|txt|rtf)$/i;

export function looksLikeCv(filename: string): boolean {
  return CV_EXT.test(filename);
}

/**
 * Server-side CV text extraction (worker-safe: no pdf.js worker, no mammoth).
 * Hidden text (white on white, tiny, invisible, hidden Word runs) is removed and
 * replaced by one marker line — see src/lib/document-hidden-text.ts.
 */
export async function attachmentText(filename: string, bytes: Uint8Array): Promise<string> {
  const name = filename.toLowerCase();
  const MAX_INPUT_BYTES = 15_000_000;
  if (bytes.byteLength > MAX_INPUT_BYTES) return "";
  const { pdfVisibleText, stripHiddenDocxRuns, withHiddenMarker } =
    await import("./document-hidden-text");

  if (name.endsWith(".pdf")) {
    // pdfjs-dist legacy build, no worker: unpdf's bundled mega-module blows the
    // build's TypeScript AST walker (stack overflow) when it enters the graph.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // pdf.js transfers (detaches) the buffer it is given — hand it a copy so the
    // caller keeps usable bytes for the resume vault and size reporting.
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
    }).promise;
    // Page cap: a multi-thousand-page PDF must not eat the worker.
    if (doc.numPages > 30) return "";
    const { text, hidden } = await pdfVisibleText(doc, pdfjs.OPS as Record<string, number>);
    return withHiddenMarker(text.replace(/\s+/g, " ").trim(), hidden);
  }

  if (name.endsWith(".docx")) {
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(bytes);
    const xml = files["word/document.xml"];
    if (!xml) return "";
    // Cap the decompressed XML we are willing to decode — a docx bomb inflates
    // word/document.xml far beyond anything a real CV contains.
    if (xml.byteLength > 20_000_000) return "";
    const { xml: visibleXml, hidden } = stripHiddenDocxRuns(strFromU8(xml));
    const text = visibleXml
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ")
      .trim();
    return withHiddenMarker(text, hidden);
  }

  return new TextDecoder().decode(bytes).trim();
}
