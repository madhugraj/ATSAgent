import { jsPDF } from "jspdf";

import {
  FIRST_RUN_JOURNEY,
  MANUAL_SECTIONS,
  type FlowActor,
  type ManualFlow,
} from "@/lib/user-manual";

/** Downloadable user manual, built in the browser from the same source as the help page. */

type RGB = [number, number, number];
const INK: RGB = [17, 17, 20];

/** Box fill and edge per actor, matching the help page's diagram colours. */
const ACTOR_PDF: Record<FlowActor, { fill: RGB; edge: RGB; label: string }> = {
  person: { fill: [240, 236, 255], edge: [110, 80, 220], label: "Person" },
  agent: { fill: [230, 248, 240], edge: [16, 160, 110], label: "Agent" },
  system: { fill: [242, 242, 245], edge: [150, 150, 160], label: "System" },
  candidate: { fill: [255, 245, 225], edge: [217, 150, 30], label: "Candidate" },
};

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

  /** Numbered boxes in rows of up to four, joined by arrows; outcomes listed under it. */
  const flow = (f: ManualFlow) => {
    const perRow = 4;
    const gap = 16;
    const boxW = (text - gap * (perRow - 1)) / perRow;
    const rows = Math.ceil(f.steps.length / perRow);
    doc.setFontSize(8);
    const lineSets = f.steps.map(
      (st, i) => doc.splitTextToSize(`${i + 1}. ${plain(st.label)}`, boxW - 10) as string[],
    );
    const boxH = Math.max(...lineSets.map((l) => l.length)) * 10 + 10;
    ensure(22 + rows * (boxH + 10) + (f.outcomes?.length ?? 0) * 12);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(plain(f.title), margin, y);
    let lx = margin + text;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    for (const a of [...new Set(f.steps.map((st) => st.by))].reverse()) {
      const w = doc.getTextWidth(ACTOR_PDF[a].label);
      lx -= w;
      doc.setTextColor(110, 110, 120);
      doc.text(ACTOR_PDF[a].label, lx, y);
      doc.setFillColor(...ACTOR_PDF[a].edge);
      doc.circle(lx - 5, y - 2.5, 2.2, "F");
      lx -= 16;
    }
    doc.setTextColor(...INK);
    y += 10;
    f.steps.forEach((st, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const x = margin + col * (boxW + gap);
      const top = y + row * (boxH + 10);
      const c = ACTOR_PDF[st.by];
      doc.setFillColor(...c.fill);
      doc.setDrawColor(...c.edge);
      doc.roundedRect(x, top, boxW, boxH, 3, 3, "FD");
      doc.setFontSize(8);
      doc.text(lineSets[i] ?? [], x + 5, top + 12);
      if (i < f.steps.length - 1) {
        doc.setDrawColor(120, 120, 130);
        if (col < perRow - 1) {
          const ay = top + boxH / 2;
          doc.line(x + boxW + 2, ay, x + boxW + gap - 3, ay);
          doc.line(x + boxW + gap - 6, ay - 2.5, x + boxW + gap - 3, ay);
          doc.line(x + boxW + gap - 6, ay + 2.5, x + boxW + gap - 3, ay);
        } else {
          // Wrap to the next row: down from the last box, back to the first column.
          const ay = top + boxH + 5;
          doc.line(x + boxW / 2, top + boxH, x + boxW / 2, ay);
          doc.line(x + boxW / 2, ay, margin + boxW / 2, ay);
          doc.line(margin + boxW / 2, ay, margin + boxW / 2, ay + 5);
        }
      }
    });
    y += rows * (boxH + 10) + 4;
    for (const o of f.outcomes ?? []) {
      para(`-> ${o}`, 8, "normal", 6, 1);
    }
    y += 6;
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
    for (const f of s.flows ?? []) flow(f);
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
