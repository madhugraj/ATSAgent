import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";

import type { CatalogueResult } from "@/lib/catalogue.functions";
import { CATALOGUE_SUMMARY } from "@/lib/product-catalogue";

/** Downloadable catalogue documents, built in the browser from the live catalogue. */

const INK: [number, number, number] = [17, 17, 20];
const VIOLET: [number, number, number] = [88, 77, 255];

/** jsPDF's built-in fonts cover WinAnsi only, so swap glyphs they cannot draw. */
function pdfText(t: string) {
  return t.replace(/\s*\u2194\s*/g, " to ").replace(/[\u2192\u2190]/g, "-");
}

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

function price(c: CatalogueResult["modules"][number]["commercials"]) {
  if (c.listPrice === null) return "On request";
  return `${c.currency} ${c.listPrice.toLocaleString()}${c.unit ? ` ${c.unit}` : ""}`;
}

export function buildCataloguePdf(cat: CatalogueResult) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const width = doc.internal.pageSize.getWidth();
  const margin = 42;

  doc.setFillColor(...INK);
  doc.rect(0, 0, width, 96, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text(pdfText(CATALOGUE_SUMMARY.name), margin, 44);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(pdfText(`${CATALOGUE_SUMMARY.tagline} — product catalogue`), margin, 64);
  doc.setFontSize(9);
  doc.text(`Generated ${new Date(cat.generatedAt).toUTCString()}`, margin, 80);

  doc.setTextColor(...INK);
  doc.setFontSize(10);
  const intro = doc.splitTextToSize(pdfText(CATALOGUE_SUMMARY.positioning), width - margin * 2);
  doc.text(intro, margin, 126);

  autoTable(doc, {
    startY: 126 + intro.length * 13 + 14,
    head: [["Module", "Category", "Tier", "List price"]],
    body: cat.modules.map((m) => [
      pdfText(m.name),
      m.category,
      m.commercials.tier,
      price(m.commercials),
    ]),
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 9,
      cellPadding: 5,
      textColor: INK,
      lineColor: [226, 226, 232],
    },
    headStyles: { fillColor: VIOLET, textColor: [255, 255, 255], fontStyle: "bold" },
    margin: { left: margin, right: margin },
  });

  cat.modules.forEach((m) => {
    doc.addPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(...INK);
    doc.text(doc.splitTextToSize(pdfText(m.name), width - margin * 2), margin, 56);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(110, 110, 120);
    doc.text(
      `${m.category}  ·  ${m.audience}  ·  ${m.commercials.tier}  ·  ${price(m.commercials)}`,
      margin,
      74,
    );

    doc.setTextColor(...INK);
    doc.setFontSize(10);
    let y = 98;
    for (const para of [
      m.summary,
      `Outcome: ${m.outcome}`,
      m.commercials.notes ? `Commercial notes: ${m.commercials.notes}` : "",
    ]) {
      if (!para) continue;
      const lines = doc.splitTextToSize(pdfText(para), width - margin * 2);
      doc.text(lines, margin, y);
      y += lines.length * 13 + 8;
    }

    autoTable(doc, {
      startY: y + 4,
      head: [["Capabilities"]],
      body: m.capabilities.map((c) => [pdfText(c)]),
      theme: "striped",
      styles: { font: "helvetica", fontSize: 9, cellPadding: 5, textColor: INK },
      headStyles: { fillColor: INK, textColor: [255, 255, 255], fontStyle: "bold" },
      margin: { left: margin, right: margin },
    });
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 150);
    doc.text(
      `© Copyright 2026 Yavar AI. All rights reserved.   ·   Page ${i} of ${pages}`,
      margin,
      doc.internal.pageSize.getHeight() - 24,
    );
  }

  return doc;
}

export function downloadCataloguePdf(cat: CatalogueResult) {
  buildCataloguePdf(cat).save(`atsiq-product-catalogue-${stamp()}.pdf`);
}

export function downloadCatalogueXlsx(cat: CatalogueResult) {
  const wb = XLSX.utils.book_new();

  const overview = XLSX.utils.json_to_sheet(
    cat.modules.map((m) => ({
      Module: m.name,
      Category: m.category,
      "Who it serves": m.audience,
      Tier: m.commercials.tier,
      Currency: m.commercials.currency,
      "List price": m.commercials.listPrice ?? "On request",
      Unit: m.commercials.unit,
      Capabilities: m.capabilities.length,
      Summary: m.summary,
      Outcome: m.outcome,
      "Commercial notes": m.commercials.notes,
    })),
  );
  overview["!cols"] = [
    { wch: 38 },
    { wch: 16 },
    { wch: 28 },
    { wch: 12 },
    { wch: 9 },
    { wch: 12 },
    { wch: 20 },
    { wch: 12 },
    { wch: 60 },
    { wch: 48 },
    { wch: 40 },
  ];
  XLSX.utils.book_append_sheet(wb, overview, "Modules");

  const caps = XLSX.utils.json_to_sheet(
    cat.modules.flatMap((m) =>
      m.capabilities.map((c) => ({
        Module: m.name,
        Category: m.category,
        Tier: m.commercials.tier,
        Capability: c,
      })),
    ),
  );
  caps["!cols"] = [{ wch: 38 }, { wch: 16 }, { wch: 12 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, caps, "Capabilities");

  const about = XLSX.utils.aoa_to_sheet([
    [CATALOGUE_SUMMARY.name],
    [`${CATALOGUE_SUMMARY.tagline} — product catalogue`],
    [CATALOGUE_SUMMARY.positioning],
    [`Generated ${new Date(cat.generatedAt).toUTCString()}`],
    ["© Copyright 2026 Yavar AI. All rights reserved."],
  ]);
  about["!cols"] = [{ wch: 120 }];
  XLSX.utils.book_append_sheet(wb, about, "About");

  XLSX.writeFile(wb, `atsiq-product-catalogue-${stamp()}.xlsx`);
}
