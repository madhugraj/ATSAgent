import { jsPDF } from "jspdf";

import { FIRST_RUN_JOURNEY, MANUAL_SECTIONS } from "@/lib/user-manual";

/** Downloadable user manual, built in the browser from the same source as the help page. */

const INK: [number, number, number] = [17, 17, 20];

/** jsPDF's built-in fonts cover WinAnsi only; drop markdown and swap glyphs they cannot draw. */
function plain(t: string) {
  return t
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s*↔\s*/g, " to ")
    .replace(/[→←]/g, "-")
    .replace(/[≤]/g, "<=")
    .replace(/[≥]/g, ">=");
}

export function downloadManualPdf() {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const margin = 48;
  const text = width - margin * 2;
  let y = 0;

  const ensure = (needed: number) => {
    if (y + needed > height - 48) {
      doc.addPage();
      y = 56;
    }
  };
  const para = (t: string, size: number, style: "normal" | "bold", indent = 0, gap = 6) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(plain(t), text - indent) as string[];
    const lh = size * 1.35;
    for (const line of lines) {
      ensure(lh);
      doc.text(line, margin + indent, y);
      y += lh;
    }
    y += gap;
  };

  doc.setFillColor(...INK);
  doc.rect(0, 0, width, 96, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("ATSIQ user manual", margin, 46);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`Generated ${new Date().toUTCString()}`, margin, 70);
  doc.setTextColor(...INK);
  y = 132;

  para("First-login journey", 14, "bold", 0, 4);
  FIRST_RUN_JOURNEY.forEach((step, i) => {
    para(`${i + 1}. ${step.title}`, 10, "bold", 0, 2);
    para(step.detail, 10, "normal", 14);
  });

  for (const s of MANUAL_SECTIONS) {
    y += 10;
    ensure(60);
    para(s.title, 14, "bold", 0, 4);
    para(s.summary, 10, "normal");
    for (const step of s.steps) {
      ensure(14);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text("•", margin + 4, y);
      para(step, 10, "normal", 14, 4);
    }
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 150);
    doc.text(
      `© Copyright 2026 Yavar AI. All rights reserved.   ·   Page ${i} of ${pages}`,
      margin,
      height - 24,
    );
  }

  doc.save(`atsiq-user-manual-${new Date().toISOString().slice(0, 10)}.pdf`);
}
