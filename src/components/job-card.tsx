import { useEffect, useRef } from "react";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";

export type JobCardTheme = {
  accentColor: string;
  layout: "banner" | "side" | "artwork";
  /** Dark scrim strength when a background image is used (0–0.75). */
  overlayOpacity?: number;
  /** Text colour over the background image (defaults to white). */
  textColor?: string;
  /** Background artwork brightness, percent 50–130 (default 100). */
  backgroundBrightness?: number;
  /**
   * Text slots on the artwork, in percent of the image size. Present for
   * image-based templates: each slot is filled with the new job's value.
   */
  zones?: JobCardZone[];
};

export type JobCardZone = {
  slot: "role" | "skills" | "experience" | "location" | "contact" | "org";
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  align: "left" | "center" | "right";
  color?: string | null;
  mask?: boolean;
  fontFamily?: "system" | "serif" | "mono" | null;
};

type ImageAsset = { base64: string; contentType: string } | null | undefined;

const FONTS: Record<string, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"SF Mono", Menlo, Consolas, monospace',
};
const FONT = FONTS["system"];

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  const last = lines[maxLines - 1];
  if (lines.length === maxLines && last) {
    const overflowed =
      ctx.measureText(last).width > maxWidth || words.join(" ").length > lines.join(" ").length;
    if (overflowed) {
      let clipped = last;
      while (clipped.length > 4 && ctx.measureText(`${clipped}…`).width > maxWidth) {
        clipped = clipped.slice(0, -1);
      }
      lines[maxLines - 1] = `${clipped}…`;
    }
  }
  return lines;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPills(
  ctx: CanvasRenderingContext2D,
  skills: string[],
  x: number,
  y: number,
  maxWidth: number,
  fill: string,
  ink: string,
  maxY: number,
) {
  ctx.font = `600 30px ${FONT}`;
  const padding = 24;
  const gapX = 16;
  const gapY = 18;
  const height = 56;
  let cx = x;
  let cy = y;
  for (const skill of skills.slice(0, 6)) {
    const label = skill.length > 26 ? `${skill.slice(0, 25)}…` : skill;
    const w = ctx.measureText(label).width + padding * 2;
    if (cx + w > x + maxWidth) {
      cx = x;
      cy += height + gapY;
      if (cy > maxY) break;
    }
    ctx.fillStyle = fill;
    roundRect(ctx, cx, cy, w, height, 28);
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.fillText(label, cx + padding, cy + height / 2 + 10);
    cx += w + gapX;
  }
}

function drawContained(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  box: { x: number; y: number; w: number; h: number },
) {
  const iw = "width" in img ? Number(img.width) : 0;
  const ih = "height" in img ? Number(img.height) : 0;
  if (!iw || !ih) return;
  const scale = Math.min(box.w / iw, box.h / ih);
  const w = iw * scale;
  const h = ih * scale;
  ctx.drawImage(img, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
}

/** Scale-to-cover draw for full-bleed backgrounds. */
function drawCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number) {
  const iw = "width" in img ? Number(img.width) : 0;
  const ih = "height" in img ? Number(img.height) : 0;
  if (!iw || !ih) return;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

const H_DEFAULT = 1350;
const W_DEFAULT = 1080;
const M = 72; // safe margin

/** Branded job advert rendered client-side to a shareable image. */
export function JobCard({
  orgName,
  logo,
  background,
  theme,
  title,
  location,
  experienceMin,
  experienceMax,
  openings,
  skills,
  applyUrl,
  contactValue,
  fileName,
  onCanvasSize,
  overlay,
  canvasId,
}: {
  orgName: string;
  logo?: ImageAsset;
  /** Full-bleed template artwork — the job text renders on top of it. */
  background?: ImageAsset;
  theme: JobCardTheme;
  title: string;
  location: string | null;
  experienceMin: number;
  experienceMax: number;
  openings: number;
  skills: string[];
  applyUrl: string;
  /** Overrides the apply URL in the contact slot (e.g. the org careers email). */
  contactValue?: string | null;
  fileName: string;
  onCanvasSize?: (size: { width: number; height: number }) => void;
  /** Editor-only: absolutely-positioned zone handles over the canvas. */
  overlay?: React.ReactNode;
  /** Stable id for the canvas element (lets callers read the rendered image). */
  canvasId?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logoImg = useRef<HTMLImageElement | null>(null);
  const bgImg = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadImage(asset: ImageAsset, ref: React.RefObject<HTMLImageElement | null>) {
      if (!asset) return null;
      if (ref.current?.src.includes(asset.base64.slice(0, 64))) return ref.current;
      const img = new Image();
      img.src = `data:${asset.contentType};base64,${asset.base64}`;
      await img.decode().catch(() => {});
      if (cancelled || !img.complete || !img.naturalWidth) return null;
      ref.current = img;
      return img;
    }

    /** Draw a zone's value, shrinking the font until it fits the box. */
    function fillZone(
      ctx: CanvasRenderingContext2D,
      zone: JobCardZone,
      value: string,
      canvasW: number,
      canvasH: number,
    ) {
      const bx = (zone.x / 100) * canvasW;
      const by = (zone.y / 100) * canvasH;
      const bw = (zone.w / 100) * canvasW;
      const bh = (zone.h / 100) * canvasH;
      const scale = canvasW / W_DEFAULT;
      let fontPx = zone.fontSize * scale;
      const family = FONTS[zone.fontFamily ?? "system"] ?? FONT;
      ctx.font = `700 ${fontPx}px ${family}`;
      if (zone.mask !== false && bw > 4 && bh > 4) {
        // Cover the slot with the local artwork colour — hides the baked-in
        // sample text so only the new job's value shows.
        try {
          const data = ctx.getImageData(bx, by, Math.ceil(bw), Math.ceil(bh)).data;
          let r = 0;
          let g = 0;
          let b = 0;
          const step = 4 * 8;
          let n = 0;
          for (let i = 0; i < data.length; i += step) {
            r += data[i] ?? 0;
            g += data[i + 1] ?? 0;
            b += data[i + 2] ?? 0;
            n++;
          }
          if (n) {
            ctx.fillStyle = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
            roundRect(ctx, bx, by, bw, bh, 10 * scale);
            ctx.fill();
          }
        } catch {
          /* masking is best-effort */
        }
      }
      const ink = zone.color || theme.textColor || "#ffffff";
      const lines = zone.slot === "skills" ? value.split("\n") : [];
      for (;;) {
        ctx.font = `${zone.slot === "skills" ? 500 : 700} ${fontPx}px ${family}`;
        const maxLines = zone.slot === "role" ? 2 : zone.slot === "skills" ? lines.length : 1;
        const wrapped =
          zone.slot === "skills"
            ? lines.map((l) => wrapText(ctx, l.replace(/^•\s*/, `• `), bw, 1)[0] ?? "")
            : wrapText(ctx, value, bw, maxLines);
        const lineHeight = fontPx * 1.3;
        if (wrapped.length * lineHeight <= bh || fontPx <= 10 * scale) {
          ctx.fillStyle = ink;
          ctx.textAlign = zone.align;
          const tx = zone.align === "center" ? bx + bw / 2 : zone.align === "right" ? bx + bw : bx;
          wrapped.forEach((line, i) => ctx.fillText(line, tx, by + fontPx * 1.05 + i * lineHeight));
          ctx.textAlign = "left";
          return;
        }
        fontPx -= Math.max(2, fontPx * 0.08);
      }
    }

    async function draw() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await document.fonts.ready;

      const bg = await loadImage(background, bgImg);
      const logoDrawn = await loadImage(logo, logoImg);
      if (cancelled) return;

      const zones = (theme.zones ?? []).filter((z) => z.w > 0 && z.h > 0);
      const artworkMode = Boolean(bg) && zones.length > 0;

      // Artwork mode keeps the template's native size and coordinate space.
      const w = artworkMode && bg ? bg.naturalWidth : W_DEFAULT;
      const h = artworkMode && bg ? bg.naturalHeight : H_DEFAULT;
      canvas.width = w;
      canvas.height = h;
      onCanvasSize?.({ width: w, height: h });

      const accent = theme.accentColor || "#4f46e5";
      const onImage = Boolean(bg);
      const brightness = Math.min(130, Math.max(50, theme.backgroundBrightness ?? 100));
      const ink = onImage ? theme.textColor || "#ffffff" : "#111827";
      const sub = onImage ? "rgba(255,255,255,0.88)" : "#4b5563";
      const pillFill = onImage ? "rgba(255,255,255,0.16)" : `${accent}1a`;
      const pillInk = onImage ? "#ffffff" : accent;
      const overlay = Math.min(0.75, Math.max(0, theme.overlayOpacity ?? 0.38));

      if (bg) {
        ctx.fillStyle = "#111827";
        ctx.fillRect(0, 0, w, h);
        // Simple touch-up: brightness filter while the artwork is drawn.
        if (brightness !== 100) ctx.filter = `brightness(${brightness}%)`;
        drawCover(ctx, bg, w, h);
        ctx.filter = "none";
        // Scrim only for generic photo backgrounds — artwork templates keep
        // their own designed contrast, so their baked text stays readable.
        if (!artworkMode) {
          ctx.fillStyle = `rgba(0,0,0,${overlay})`;
          ctx.fillRect(0, 0, w, h);
        }
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
      }

      ctx.textBaseline = "alphabetic";

      if (artworkMode) {
        for (const zone of zones) {
          const value =
            zone.slot === "role"
              ? title
              : zone.slot === "org"
                ? orgName
                : zone.slot === "experience"
                  ? `${experienceMin}–${experienceMax} yrs${openings > 1 ? ` · ${openings} openings` : ""}`
                  : zone.slot === "location"
                    ? (location ?? "").trim()
                    : zone.slot === "contact"
                      ? (contactValue || applyUrl).replace(/^https?:\/\//, "")
                      : skills
                          .slice(0, 6)
                          .map((s) => `• ${s}`)
                          .join("\n");
          if (!value.trim()) continue;
          fillZone(ctx, zone, value, w, h);
        }
        if (logoDrawn) drawContained(ctx, logoDrawn, { x: w - M - 300, y: 24, w: 300, h: 130 });
        return;
      }

      if (bg) {
        ctx.fillStyle = `rgba(0,0,0,${overlay})`;
        ctx.fillRect(0, 0, w, h);
      }

      if (theme.layout === "banner" && !onImage) {
        ctx.fillStyle = accent;
        ctx.fillRect(0, 0, w, 230);
        ctx.fillStyle = "#ffffff";
        ctx.font = `700 44px ${FONT}`;
        wrapText(ctx, orgName, 560, 2).forEach((line, i) => ctx.fillText(line, M, 128 + i * 52));
        if (logoDrawn) drawContained(ctx, logoDrawn, { x: w - M - 320, y: 55, w: 320, h: 120 });
      } else if (!onImage) {
        ctx.fillStyle = accent;
        ctx.fillRect(0, 0, 64, h);
        if (logoDrawn) drawContained(ctx, logoDrawn, { x: w - M - 300, y: M - 10, w: 300, h: 130 });
        ctx.fillStyle = "#6b7280";
        ctx.font = `700 34px ${FONT}`;
        wrapText(ctx, orgName.toUpperCase(), w - M * 2 - 320, 1).forEach((line) =>
          ctx.fillText(line, M, M + 24),
        );
      } else {
        ctx.fillStyle = ink;
        ctx.font = `700 44px ${FONT}`;
        wrapText(ctx, orgName, w - M * 2 - (logoDrawn ? 300 : 0), 1).forEach((line) =>
          ctx.fillText(line, M, M + 24),
        );
        if (logoDrawn) drawContained(ctx, logoDrawn, { x: w - M - 300, y: M - 10, w: 300, h: 130 });
      }

      const titleTop = onImage ? 300 : theme.layout === "banner" ? 340 : 320;
      ctx.fillStyle = ink;
      ctx.font = `800 72px ${FONT}`;
      const titleLines = wrapText(ctx, title, w - M * 2, 3);
      titleLines.forEach((line, i) => ctx.fillText(line, M, titleTop + i * 84));
      let y = titleTop + titleLines.length * 84 + 16;
      ctx.font = `500 36px ${FONT}`;
      ctx.fillStyle = sub;
      const meta =
        [
          location || null,
          `${experienceMin}–${experienceMax} yrs`,
          openings > 1 ? `${openings} openings` : null,
        ]
          .filter(Boolean)
          .join("  ·  ") || "";
      if (meta)
        wrapText(ctx, meta, w - M * 2, 2).forEach((line, i) => ctx.fillText(line, M, y + i * 48));
      y += 96;
      ctx.fillStyle = ink;
      ctx.font = `700 34px ${FONT}`;
      ctx.fillText("What you'll work with", M, y);
      y += 40;
      drawPills(ctx, skills, M, y, w - M * 2, pillFill, pillInk, h - 320);

      ctx.fillStyle = onImage ? "rgba(0,0,0,0.5)" : accent;
      ctx.fillRect(0, h - 190, w, 190);
      ctx.fillStyle = "#ffffff";
      ctx.font = `800 48px ${FONT}`;
      ctx.fillText("Apply now", M, h - 118);
      ctx.font = `500 32px ${FONT}`;
      const url = applyUrl.replace(/^https?:\/\//, "");
      ctx.fillText(wrapText(ctx, url, 560, 1)[0] ?? url, M, h - 62);
    }
    void draw();
    return () => {
      cancelled = true;
    };
  }, [
    orgName,
    logo,
    background,
    theme,
    title,
    location,
    experienceMin,
    experienceMax,
    openings,
    skills,
    applyUrl,
    onCanvasSize,
  ]);

  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileName || "job-card"}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  return (
    <div className="space-y-3">
      <div className="relative inline-block">
        <canvas
          ref={canvasRef}
          id={canvasId}
          width={W_DEFAULT}
          height={H_DEFAULT}
          className="block max-h-[520px] w-auto max-w-full rounded-lg border border-border"
          aria-label={`Job card preview for ${title}`}
        />
        {overlay}
      </div>
      <div>
        <Button size="sm" variant="outline" onClick={download}>
          <Download className="size-4" /> Download image
        </Button>
      </div>
    </div>
  );
}

/**
 * Draggable/selectable zone handles over a rendered card canvas. Shared by
 * the template editor and the requisition-page TA corrections.
 */
export function ZoneOverlay({
  zones,
  selected,
  onSelect,
  onChange,
}: {
  zones: JobCardZone[];
  selected: number | null;
  onSelect: (index: number) => void;
  onChange: (index: number, patch: Partial<JobCardZone>) => void;
}) {
  const dragRef = useRef<{
    idx: number;
    startX: number;
    startY: number;
    zx: number;
    zy: number;
  } | null>(null);

  function startDrag(e: React.PointerEvent, idx: number) {
    e.preventDefault();
    e.stopPropagation();
    onSelect(idx);
    const box = (e.currentTarget as HTMLElement)
      .closest("[data-zone-overlay]")
      ?.getBoundingClientRect();
    if (!box) return;
    const zone = zones[idx];
    if (!zone) return;
    dragRef.current = {
      idx,
      startX: ((e.clientX - box.left) / box.width) * 100,
      startY: ((e.clientY - box.top) / box.height) * 100,
      zx: zone.x,
      zy: zone.y,
    };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      onChange(idx, {
        x: Math.max(0, Math.min(99, d.zx + ((ev.clientX - box.left) / box.width) * 100 - d.startX)),
        y: Math.max(0, Math.min(99, d.zy + ((ev.clientY - box.top) / box.height) * 100 - d.startY)),
      });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div data-zone-overlay className="absolute inset-0">
      {zones.map((z, i) => (
        <div
          key={`${z.slot}-${i}`}
          role="button"
          tabIndex={0}
          onPointerDown={(e) => startDrag(e, i)}
          className={`absolute cursor-move border-2 ${
            selected === i ? "border-primary bg-primary/20" : "border-dashed border-white/70"
          }`}
          style={{ left: `${z.x}%`, top: `${z.y}%`, width: `${z.w}%`, height: `${z.h}%` }}
          title={`${z.slot} — drag to position`}
        >
          <span className="absolute -top-0.5 left-0 rounded-br bg-primary px-1 text-[0.5625rem] font-medium text-primary-foreground">
            {z.slot}
          </span>
        </div>
      ))}
    </div>
  );
}
