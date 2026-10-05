/** CV/document attachment detection and text extraction shared by the careers inbox, Capture and onboarding. */

const CV_EXT = /\.(pdf|docx|txt|rtf)$/i;

export function looksLikeCv(filename: string): boolean {
  return CV_EXT.test(filename);
}

/** Server-side CV text extraction (worker-safe: no pdf.js worker, no mammoth). */
export async function attachmentText(filename: string, bytes: Uint8Array): Promise<string> {
  const name = filename.toLowerCase();
  const MAX_INPUT_BYTES = 15_000_000;
  if (bytes.byteLength > MAX_INPUT_BYTES) return "";

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
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
    }
    return pages.join(" ").replace(/\s+/g, " ").trim();
  }

  if (name.endsWith(".docx")) {
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(bytes);
    const xml = files["word/document.xml"];
    if (!xml) return "";
    // Cap the decompressed XML we are willing to decode — a docx bomb inflates
    // word/document.xml far beyond anything a real CV contains.
    if (xml.byteLength > 20_000_000) return "";
    return strFromU8(xml)
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  return new TextDecoder().decode(bytes).trim();
}
