import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Star } from "lucide-react";
import { JobCard, ZoneOverlay, type JobCardZone } from "@/components/job-card";

import { templatesQuery, type TemplateWire } from "@/lib/data";
import { errorToastMessage } from "@/lib/errors";
import {
  analyzeTemplateFile,
  deleteTemplate,
  saveTemplate,
  setTemplateDefault,
  uploadTemplateBackground,
  uploadTemplateLogo,
  uploadTemplateSource,
} from "@/lib/templates.functions";
import { extractResumeText } from "@/lib/cv-extract";
import { PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/templates")({
  head: () => ({
    meta: [
      { title: "Content templates — ATS" },
      {
        name: "description",
        content:
          "Organisation-defined templates for AI-drafted LinkedIn posts, job descriptions and branded job-card images.",
      },
    ],
  }),
  component: Templates,
});

const KINDS = [
  {
    kind: "linkedin_post" as const,
    title: "LinkedIn post templates",
    hint: "Tone, must-include lines, hashtags and disclaimers for AI-drafted hiring posts.",
  },
  {
    kind: "jd" as const,
    title: "Job description templates",
    hint: "Section headings, order and boilerplate for AI-drafted JDs.",
  },
  {
    kind: "job_card" as const,
    title: "Job card themes",
    hint: "Accent colour, layout and logo for the shareable job advert image.",
  },
  {
    kind: "offer_letter" as const,
    title: "Offer letter templates",
    hint: "Letter structure, clauses and conventions for offer letters.",
  },
];

const PLACEHOLDER_CHIPS = [
  "{{role}}",
  "{{company}}",
  "{{location}}",
  "{{experience}}",
  "{{openings}}",
  "{{salary}}",
];

type EditorState = {
  id?: string;
  kind: (typeof KINDS)[number]["kind"];
  name: string;
  instructions: string;
  tone: "professional" | "warm" | "bold";
  mustInclude: string;
  hashtags: string;
  disclaimer: string;
  sectionHeadings: string;
  boilerplate: string;
  /** offer_letter — fixed furniture captured verbatim. */
  letterHeader: string;
  letterFooter: string;
  letterSalutation: string;
  letterRefFormat: string;
  signatoryName: string;
  signatoryDesignation: string;
  accentColor: string;
  layout: "banner" | "side";
  overlayOpacity: number;
  zones: JobCardZone[];
  logoFile: File | null;
  backgroundFile: File | null;
  backgroundPreview: { base64: string; contentType: string } | null;
  sourceFile: File | null;
};

type TemplateAnalysis = {
  name: string;
  summary: string;
  confidence: string;
  config: unknown;
  instructions: string;
  placeholders: string[];
};

function emptyEditor(kind: (typeof KINDS)[number]["kind"]): EditorState {
  return {
    kind,
    name: "",
    instructions: "",
    tone: "professional",
    mustInclude: "",
    hashtags: "",
    disclaimer: "",
    sectionHeadings: "",
    boilerplate: "",
    letterHeader: "",
    letterFooter: "",
    letterSalutation: "",
    letterRefFormat: "",
    signatoryName: "",
    signatoryDesignation: "",
    accentColor: "#4f46e5",
    layout: "banner",
    overlayOpacity: 38,
    zones: [],
    logoFile: null,
    backgroundFile: null,
    backgroundPreview: null,
    sourceFile: null,
  };
}

function contentTypeFor(file: File) {
  if (file.type) return file.type;
  if (/\.(txt|md)$/i.test(file.name)) return "text/plain";
  return "application/octet-stream";
}

async function fileToBase64(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
  return dataUrl.split(",")[1] ?? "";
}

function applyAnalysis(state: EditorState, s: TemplateAnalysis): EditorState {
  const cfg = (s.config ?? {}) as Record<string, unknown>;
  const name = state.name.trim() || s.name;
  const instructions = s.instructions || state.instructions;
  if (state.kind === "linkedin_post") {
    return {
      ...state,
      name,
      instructions,
      tone: (cfg["tone"] as EditorState["tone"]) ?? state.tone,
      mustInclude: ((cfg["mustInclude"] as string[]) ?? []).join("\n"),
      hashtags: ((cfg["hashtags"] as string[]) ?? []).join(", "),
      disclaimer: (cfg["disclaimer"] as string) ?? state.disclaimer,
    };
  }
  if (state.kind === "jd" || state.kind === "offer_letter") {
    return {
      ...state,
      name,
      instructions,
      sectionHeadings: ((cfg["sections"] as { heading: string }[]) ?? [])
        .map((sec) => sec.heading)
        .join("\n"),
      boilerplate: (cfg["boilerplate"] as string) ?? state.boilerplate,
      ...(state.kind === "offer_letter"
        ? {
            accentColor: (cfg["accentColor"] as string) ?? state.accentColor,
            letterHeader: ((cfg["headerLines"] as string[]) ?? []).join("\n"),
            letterFooter: ((cfg["footerLines"] as string[]) ?? []).join("\n"),
            letterSalutation: (cfg["salutation"] as string) ?? state.letterSalutation,
            letterRefFormat: (cfg["refFormat"] as string) ?? state.letterRefFormat,
            signatoryName:
              ((cfg["signatory"] as { name?: string } | null)?.name as string) ??
              state.signatoryName,
            signatoryDesignation:
              ((cfg["signatory"] as { designation?: string } | null)?.designation as string) ??
              state.signatoryDesignation,
          }
        : {}),
    };
  }
  const zones = (cfg["zones"] as JobCardZone[]) ?? [];
  return {
    ...state,
    name,
    instructions,
    accentColor: (cfg["accentColor"] as string) ?? state.accentColor,
    layout: (cfg["layout"] as EditorState["layout"]) ?? state.layout,
    zones: zones.length ? zones : state.zones,
  };
}

function configFromEditor(e: EditorState) {
  if (e.kind === "linkedin_post") {
    return {
      tone: e.tone,
      mustInclude: e.mustInclude
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      hashtags: e.hashtags
        .split(/[,\n]/)
        .map((s) => s.trim().replace(/^#/, ""))
        .filter(Boolean),
      disclaimer: e.disclaimer.trim() || undefined,
    };
  }
  if (e.kind === "jd" || e.kind === "offer_letter") {
    const signatory =
      e.signatoryName.trim() && e.signatoryDesignation.trim()
        ? { name: e.signatoryName.trim(), designation: e.signatoryDesignation.trim() }
        : undefined;
    return {
      sections: e.sectionHeadings
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((heading, i) => ({ key: `section_${i + 1}`, heading })),
      boilerplate: e.boilerplate.trim() || undefined,
      ...(e.kind === "offer_letter"
        ? {
            accentColor: e.accentColor,
            headerLines: e.letterHeader
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            footerLines: e.letterFooter
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            salutation: e.letterSalutation.trim() || undefined,
            refFormat: e.letterRefFormat.trim() || undefined,
            signatory,
          }
        : {}),
    };
  }
  return {
    accentColor: e.accentColor,
    layout: e.layout,
    overlayOpacity: e.overlayOpacity,
    zones: e.zones,
  };
}

function editorFromTemplate(t: TemplateWire): EditorState {
  const base = emptyEditor(t.kind);
  const cfg = (t.config ?? {}) as Record<string, unknown>;
  if (t.kind === "linkedin_post") {
    return {
      ...base,
      id: t.id,
      name: t.name,
      instructions: t.instructions ?? "",
      tone: (cfg["tone"] as EditorState["tone"]) ?? "professional",
      mustInclude: ((cfg["mustInclude"] as string[]) ?? []).join("\n"),
      hashtags: ((cfg["hashtags"] as string[]) ?? []).join(", "),
      disclaimer: (cfg["disclaimer"] as string) ?? "",
    };
  }
  if (t.kind === "jd" || t.kind === "offer_letter") {
    return {
      ...base,
      id: t.id,
      name: t.name,
      instructions: t.instructions ?? "",
      sectionHeadings: ((cfg["sections"] as { heading: string }[]) ?? [])
        .map((s) => s.heading)
        .join("\n"),
      boilerplate: (cfg["boilerplate"] as string) ?? "",
      ...(t.kind === "offer_letter"
        ? {
            accentColor: (cfg["accentColor"] as string) ?? "#4f46e5",
            letterHeader: ((cfg["headerLines"] as string[]) ?? []).join("\n"),
            letterFooter: ((cfg["footerLines"] as string[]) ?? []).join("\n"),
            letterSalutation: (cfg["salutation"] as string) ?? "",
            letterRefFormat: (cfg["refFormat"] as string) ?? "",
            signatoryName: ((cfg["signatory"] as { name?: string } | null)?.name as string) ?? "",
            signatoryDesignation:
              ((cfg["signatory"] as { designation?: string } | null)?.designation as string) ?? "",
          }
        : {}),
    };
  }
  return {
    ...base,
    id: t.id,
    name: t.name,
    instructions: t.instructions ?? "",
    accentColor: (cfg["accentColor"] as string) ?? "#4f46e5",
    layout: (cfg["layout"] as EditorState["layout"]) ?? "banner",
    overlayOpacity: (cfg["overlayOpacity"] as number) ?? 38,
    zones: (cfg["zones"] as JobCardZone[]) ?? [],
  };
}

function TemplateEditor({ editor, onClose }: { editor: EditorState; onClose: () => void }) {
  const qc = useQueryClient();
  const [state, setState] = useState(editor);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisNote, setAnalysisNote] = useState<string | null>(null);
  const [selectedZone, setSelectedZone] = useState<number | null>(null);
  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    setState((s) => ({ ...s, [key]: value }));

  function updateZone(i: number, patch: Partial<JobCardZone>) {
    setState((s) => ({
      ...s,
      zones: s.zones.map((z, idx) => (idx === i ? { ...z, ...patch } : z)),
    }));
  }

  const zoneBeingEdited =
    state.kind === "job_card" && selectedZone !== null ? state.zones[selectedZone] : undefined;

  const zoneOverlay =
    state.kind === "job_card" && state.zones.length > 0 ? (
      <ZoneOverlay
        zones={state.zones}
        selected={selectedZone}
        onSelect={setSelectedZone}
        onChange={updateZone}
      />
    ) : undefined;

  async function analyze(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Keep the template file under 10 MB");
      return;
    }
    setAnalyzing(true);
    setAnalysisNote(null);
    try {
      let suggestion: TemplateAnalysis;
      if (file.type.startsWith("image/")) {
        suggestion = await analyzeTemplateFile({
          data: {
            kind: state.kind,
            fileName: file.name,
            image: {
              base64: await fileToBase64(file),
              contentType: file.type as "image/png" | "image/jpeg" | "image/webp",
            },
          },
        });
      } else {
        const text = await extractResumeText(file);
        suggestion = await analyzeTemplateFile({
          data: { kind: state.kind, fileName: file.name, text },
        });
      }
      setState((s) => applyAnalysis(s, suggestion));
      setAnalysisNote(
        suggestion.summary || "Template analysed — review the prefilled fields before saving.",
      );
      toast.success(`Analysed (${suggestion.confidence} confidence) — review and save.`);
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : "Could not analyse the file — fill the editor manually instead.",
      );
    } finally {
      setAnalyzing(false);
    }
  }

  async function save() {
    if (!state.name.trim()) {
      toast.error("Give the template a name");
      return;
    }
    setSaving(true);
    try {
      const row = await saveTemplate({
        data: {
          id: state.id,
          kind: state.kind,
          name: state.name,
          config: configFromEditor(state),
          instructions: state.instructions || null,
        },
      });
      let uploadNote: string | null = null;
      try {
        if (state.logoFile) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error("Could not read the logo file"));
            reader.readAsDataURL(state.logoFile!);
          });
          const base64 = dataUrl.split(",")[1] ?? "";
          await uploadTemplateLogo({
            data: { templateId: row.id, base64, contentType: state.logoFile.type },
          });
        }
        if (state.backgroundFile) {
          await uploadTemplateBackground({
            data: {
              templateId: row.id,
              base64: await fileToBase64(state.backgroundFile),
              contentType: state.backgroundFile.type || "image/png",
            },
          });
        }
        if (state.sourceFile) {
          await uploadTemplateSource({
            data: {
              templateId: row.id,
              base64: await fileToBase64(state.sourceFile),
              contentType: contentTypeFor(state.sourceFile),
              fileName: state.sourceFile.name,
            },
          });
        }
      } catch {
        uploadNote =
          "The template was saved, but the file couldn't be kept (storage not configured here).";
      }
      toast.success(state.id ? "Template updated" : "Template created");
      if (uploadNote) toast.warning(uploadNote);
      qc.invalidateQueries({ queryKey: ["templates"] });
      onClose();
    } catch (e) {
      toast.error(errorToastMessage(e, "Could not save the template"));
    } finally {
      setSaving(false);
    }
  }

  const previewTheme = {
    accentColor: state.accentColor,
    layout: state.layout,
    overlayOpacity: state.overlayOpacity,
  };

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {state.id
            ? "Edit template"
            : `New ${KINDS.find((k) => k.kind === state.kind)?.title.toLowerCase()}`}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-4">
        <div className="rounded-md border border-dashed border-border p-3">
          <Label className="mb-1 block text-xs text-muted-foreground">
            Have this template as a file? (PDF, Word, TXT or image)
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="file"
              accept=".pdf,.docx,.doc,.txt,.md,image/png,image/jpeg,image/webp"
              className="h-9 max-w-xs text-xs"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                set("sourceFile", file);
                if (file && state.kind === "job_card" && file.type.startsWith("image/")) {
                  // An image imported into a job-card theme doubles as its background.
                  set("backgroundFile", file);
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = String(reader.result);
                    set("backgroundPreview", {
                      base64: dataUrl.split(",")[1] ?? "",
                      contentType: file.type,
                    });
                  };
                  reader.readAsDataURL(file);
                }
                if (file) void analyze(file);
              }}
            />
            {analyzing && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Reading the template…
              </span>
            )}
          </div>
          {analysisNote && <p className="mt-2 text-xs text-muted-foreground">{analysisNote}</p>}
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            The AI only proposes a format — nothing is saved until you press Save. The original file
            is kept with the template for reference.
          </p>
        </div>
        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">Name</Label>
          <Input
            value={state.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Campus hiring — warm"
          />
        </div>

        {state.kind === "linkedin_post" && (
          <>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Tone</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={state.tone}
                onChange={(e) => set("tone", e.target.value as EditorState["tone"])}
              >
                <option value="professional">Professional</option>
                <option value="warm">Warm</option>
                <option value="bold">Bold</option>
              </select>
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                Must-include lines (one per line, appear verbatim)
              </Label>
              <Textarea
                rows={3}
                value={state.mustInclude}
                onChange={(e) => set("mustInclude", e.target.value)}
                placeholder={
                  "We are an equal-opportunity employer.\nRefer a friend and get a bonus!"
                }
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Hashtags (comma-separated)
                </Label>
                <Input
                  value={state.hashtags}
                  onChange={(e) => set("hashtags", e.target.value)}
                  placeholder="hiring, engineering"
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Disclaimer (appended verbatim)
                </Label>
                <Input
                  value={state.disclaimer}
                  onChange={(e) => set("disclaimer", e.target.value)}
                  placeholder="EOE statement…"
                />
              </div>
            </div>
          </>
        )}

        {(state.kind === "jd" || state.kind === "offer_letter") && (
          <>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                Section headings, one per line, in order
              </Label>
              <Textarea
                rows={5}
                value={state.sectionHeadings}
                onChange={(e) => set("sectionHeadings", e.target.value)}
                placeholder={"About the team\nWhat you'll do\nWhat we look for\nPerks & benefits"}
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                Boilerplate (included verbatim)
              </Label>
              <Textarea
                rows={3}
                value={state.boilerplate}
                onChange={(e) => set("boilerplate", e.target.value)}
                placeholder="Our benefits, EOE statement, office address…"
              />
            </div>
          </>
        )}

        {state.kind === "offer_letter" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Brand accent (letterhead rule, headings, clause box)
                </Label>
                <input
                  type="color"
                  className="h-9 w-full cursor-pointer rounded-md border bg-background px-1"
                  value={state.accentColor}
                  onChange={(e) => set("accentColor", e.target.value)}
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Org logo (PNG / JPEG / WebP, ≤1 MB)
                </Label>
                <Input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => set("logoFile", e.target.files?.[0] ?? null)}
                />
              </div>
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                Letterhead lines (rendered under the company name)
              </Label>
              <Textarea
                rows={3}
                value={state.letterHeader}
                onChange={(e) => set("letterHeader", e.target.value)}
                placeholder={
                  "Registered Office: 4th Floor, Tower B, …\nPhone: +91 …  ·  Web: …  ·  CIN: …"
                }
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Salutation {"({candidate_name} allowed)"}
                </Label>
                <Input
                  value={state.letterSalutation}
                  onChange={(e) => set("letterSalutation", e.target.value)}
                  placeholder="Dear Ms. {candidate_name},"
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Reference number format {"({year}, {seq} allowed)"}
                </Label>
                <Input
                  value={state.letterRefFormat}
                  onChange={(e) => set("letterRefFormat", e.target.value)}
                  placeholder="Ref: HR/{year}/{seq}"
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">Signatory name</Label>
                <Input
                  value={state.signatoryName}
                  onChange={(e) => set("signatoryName", e.target.value)}
                  placeholder="Saranya RaviKumar"
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Signatory designation
                </Label>
                <Input
                  value={state.signatoryDesignation}
                  onChange={(e) => set("signatoryDesignation", e.target.value)}
                  placeholder="Assistant Manager – HR"
                />
              </div>
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                Page footer lines (every page)
              </Label>
              <Textarea
                rows={2}
                value={state.letterFooter}
                onChange={(e) => set("letterFooter", e.target.value)}
                placeholder={
                  "This communication is confidential and intended only for the addressee.\nRegistered Office: …"
                }
              />
            </div>
          </>
        )}

        {state.kind === "job_card" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">Accent colour</Label>
                <input
                  type="color"
                  value={state.accentColor}
                  onChange={(e) => set("accentColor", e.target.value)}
                  className="h-9 w-full cursor-pointer rounded-md border bg-background p-1"
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">Layout</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={state.layout}
                  onChange={(e) => set("layout", e.target.value as EditorState["layout"])}
                >
                  <option value="banner">Top banner</option>
                  <option value="side">Side accent</option>
                </select>
              </div>
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                Background image (PNG/JPEG, ≤10 MB) — job text renders on top
              </Label>
              <Input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  set("backgroundFile", file);
                  if (!file) {
                    set("backgroundPreview", null);
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = String(reader.result);
                    set("backgroundPreview", {
                      base64: dataUrl.split(",")[1] ?? "",
                      contentType: file.type || "image/png",
                    });
                  };
                  reader.readAsDataURL(file);
                }}
              />
              <Label className="mt-3 mb-1.5 block text-xs text-muted-foreground">
                Dark overlay for text readability ({state.overlayOpacity}%)
              </Label>
              <input
                type="range"
                min={0}
                max={75}
                value={state.overlayOpacity}
                onChange={(e) => set("overlayOpacity", Number(e.target.value))}
                className="w-full"
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                Logo (PNG / JPEG / WebP, ≤1 MB)
              </Label>
              <Input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => set("logoFile", e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="rounded-md border border-dashed border-border p-4">
              {zoneBeingEdited && (
                <div className="mb-3 grid grid-cols-4 gap-2">
                  {(["x", "y", "w", "h", "fontSize"] as const).map((field) => (
                    <div key={field}>
                      <Label className="mb-1 block text-[10px] uppercase text-muted-foreground">
                        {field}
                      </Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={Math.round(zoneBeingEdited[field])}
                        onChange={(e) =>
                          updateZone(selectedZone!, {
                            [field]: Number(e.target.value),
                          } as Partial<JobCardZone>)
                        }
                      />
                    </div>
                  ))}
                  <div>
                    <Label className="mb-1 block text-[10px] uppercase text-muted-foreground">
                      align
                    </Label>
                    <select
                      className="h-8 w-full rounded-md border bg-background px-1 text-xs"
                      value={zoneBeingEdited.align}
                      onChange={(e) =>
                        updateZone(selectedZone!, {
                          align: e.target.value as JobCardZone["align"],
                        })
                      }
                    >
                      <option value="left">left</option>
                      <option value="center">center</option>
                      <option value="right">right</option>
                    </select>
                  </div>
                </div>
              )}
              {state.kind === "job_card" && state.backgroundPreview && (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    value=""
                    onChange={(e) => {
                      const slot = e.target.value as JobCardZone["slot"];
                      if (!slot) return;
                      const nextIndex = state.zones.length;
                      setState((s) => ({
                        ...s,
                        zones: [
                          ...s.zones,
                          {
                            slot,
                            x: 10,
                            y: 10 + s.zones.length * 12,
                            w: 40,
                            h: 10,
                            fontSize: 36,
                            align: "left" as const,
                          },
                        ],
                      }));
                      setSelectedZone(nextIndex);
                    }}
                  >
                    <option value="">+ Add text zone…</option>
                    {(["role", "org", "skills", "experience", "location", "contact"] as const).map(
                      (sl) => (
                        <option key={sl} value={sl}>
                          {sl}
                        </option>
                      ),
                    )}
                  </select>
                  {zoneBeingEdited && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => {
                        setState((s) => ({
                          ...s,
                          zones: s.zones.filter((_, i) => i !== selectedZone),
                        }));
                        setSelectedZone(null);
                      }}
                    >
                      Remove zone
                    </Button>
                  )}
                  <span className="text-[10px] text-muted-foreground">
                    Drag boxes on the preview to match the artwork's text areas.
                  </span>
                </div>
              )}
              <JobCard
                orgName="Your company"
                logo={null}
                background={state.backgroundPreview}
                theme={{ ...previewTheme, zones: state.zones }}
                overlay={zoneOverlay}
                title="Senior Backend Engineer"
                location="Bengaluru"
                experienceMin={3}
                experienceMax={6}
                openings={2}
                skills={["Go", "Postgres", "Kubernetes", "React"]}
                applyUrl="atsiq.app/apply/DEMO"
                fileName="template-preview"
              />
            </div>
          </>
        )}

        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">
            Extra instructions for the AI
          </Label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {PLACEHOLDER_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                onClick={() =>
                  set(
                    "instructions",
                    `${state.instructions}${state.instructions ? " " : ""}${chip}`,
                  )
                }
              >
                {chip}
              </button>
            ))}
          </div>
          <Textarea
            rows={4}
            value={state.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            placeholder="e.g. Always mention the {{salary}} band if present. Never use the word 'rockstar'. Close with a question to drive comments."
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save template"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function KindSection({
  group,
  templates,
  onEdit,
  onNew,
}: {
  group: (typeof KINDS)[number];
  templates: TemplateWire[];
  onEdit: (t: TemplateWire) => void;
  onNew: () => void;
}) {
  const qc = useQueryClient();
  const rows = templates.filter((t) => t.kind === group.kind);

  async function makeDefault(id: string) {
    try {
      await setTemplateDefault({ data: { id } });
      toast.success("Default template updated");
      qc.invalidateQueries({ queryKey: ["templates"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not set the default");
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this template? Generators fall back to the built-in format."))
      return;
    try {
      await deleteTemplate({ data: { id } });
      toast.success("Template deleted");
      qc.invalidateQueries({ queryKey: ["templates"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the template");
    }
  }

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{group.title}</h2>
          <p className="text-xs text-muted-foreground">{group.hint}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onNew}>
          New template
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No templates yet — generators use the built-in format.
        </p>
      ) : (
        <ul className="mt-4 divide-y border-t text-sm">
          {rows.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium">
                  {t.name}
                  {t.is_default && (
                    <Badge className="gap-1">
                      <Star className="size-3" /> Default
                    </Badge>
                  )}
                  {t.has_logo && <Badge variant="outline">logo</Badge>}
                  {t.has_background && <Badge variant="outline">bg image</Badge>}
                  {t.has_source && (
                    <Badge variant="outline" className="max-w-48 truncate">
                      source: {t.source_name}
                    </Badge>
                  )}
                </div>
                {t.instructions ? (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.instructions}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {!t.is_default && (
                  <Button size="sm" variant="ghost" onClick={() => makeDefault(t.id)}>
                    Set default
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => onEdit(t)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => remove(t.id)}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Templates() {
  const templates = useQuery(templatesQuery);
  const [editor, setEditor] = useState<EditorState | null>(null);

  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title="Content templates"
        description="How your organisation sounds and looks — templates steer every AI-drafted LinkedIn post, job description and branded job-card image. The default template applies automatically; recruiters can pick another while designing."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {KINDS.map((group) => (
          <KindSection
            key={group.kind}
            group={group}
            templates={templates.data ?? []}
            onEdit={(t) => setEditor(editorFromTemplate(t))}
            onNew={() => setEditor(emptyEditor(group.kind))}
          />
        ))}
      </div>
      {editor && (
        <Dialog open onOpenChange={(o) => !o && setEditor(null)}>
          <TemplateEditor editor={editor} onClose={() => setEditor(null)} />
        </Dialog>
      )}
    </>
  );
}
