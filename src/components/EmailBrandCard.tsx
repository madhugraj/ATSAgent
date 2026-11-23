import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Palette } from "lucide-react";

import {
  getEmailBrand,
  removeEmailBrandLogo,
  setEmailBrandColor,
  uploadEmailBrandLogo,
} from "@/lib/email-brand.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const DEFAULT = "#4f46e5";

function initials(name: string) {
  const w = name.split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0]![0]! + w[1]![0]! : (w[0] ?? "?").slice(0, 2)).toUpperCase();
}

/** The logo and colour every e-mail from this organisation carries. */
export function EmailBrandCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["email_brand"], queryFn: () => getEmailBrand() });
  const [color, setColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  if (!q.data) return null;
  const d = q.data;
  const current = color ?? d.color ?? DEFAULT;
  const refresh = () => qc.invalidateQueries({ queryKey: ["email_brand"] });

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(f: File) {
    if (!["image/png", "image/jpeg"].includes(f.type)) {
      toast.error("Use a PNG or JPEG logo.");
      return;
    }
    if (f.size > 1_000_000) {
      toast.error("Logos are limited to 1 MB.");
      return;
    }
    const base64 = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] ?? "");
      r.onerror = () => rej(new Error("Could not read the file"));
      r.readAsDataURL(f);
    });
    await run(
      () =>
        uploadEmailBrandLogo({
          data: { base64, contentType: f.type as "image/png" | "image/jpeg" },
        }),
      "Logo saved",
    );
  }

  return (
    <section className="panel space-y-4 p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Palette className="size-4 text-muted-foreground" /> E-mail branding
      </h2>

      <div className="overflow-hidden rounded-lg border bg-white text-slate-900">
        <div style={{ backgroundColor: current, height: 4 }} />
        <div className="flex items-center gap-3 border-b px-5 py-4">
          {d.logo ? (
            <img
              src={`data:${d.logo.contentType};base64,${d.logo.base64}`}
              alt={d.orgName}
              className="h-10 w-auto max-w-[220px] object-contain"
            />
          ) : (
            <>
              <span
                className="inline-flex size-9 items-center justify-center rounded-lg text-sm font-bold text-white"
                style={{ backgroundColor: current }}
              >
                {initials(d.orgName)}
              </span>
              <span className="text-sm font-semibold">{d.orgName}</span>
            </>
          )}
        </div>
        <div className="space-y-3 px-5 py-4">
          <p className="text-base font-bold">Today at {d.orgName}: 2 waiting for you</p>
          <span
            className="inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white"
            style={{ backgroundColor: current }}
          >
            Open in ATSIQ
          </span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Logo (PNG or JPEG, up to 1 MB)</Label>
          <div className="flex flex-wrap gap-2">
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void onFile(f);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit || busy || !d.storage}
              onClick={() => file.current?.click()}
            >
              {d.logo ? "Replace logo" : "Upload logo"}
            </Button>
            {d.logo ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={!canEdit || busy}
                onClick={() => run(() => removeEmailBrandLogo(), "Logo removed")}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-color" className="text-xs">
            Brand colour
          </Label>
          <div className="flex items-center gap-2">
            <input
              id="brand-color"
              type="color"
              disabled={!canEdit}
              value={current}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded border bg-transparent"
            />
            <Input
              className="w-28 font-mono text-xs"
              disabled={!canEdit}
              value={current}
              onChange={(e) => setColor(e.target.value)}
            />
            <Button
              size="sm"
              disabled={
                !canEdit || busy || !/^#[0-9a-fA-F]{6}$/.test(current) || current === d.color
              }
              onClick={() =>
                run(async () => {
                  await setEmailBrandColor({ data: { color: current } });
                  setColor(null);
                }, "Brand colour saved")
              }
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
