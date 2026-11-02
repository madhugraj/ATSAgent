/**
 * Org-scoped CRUD for content templates plus brand-logo round-trips through
 * the private object store. Writes are gated to hr_head+ (owners pass every
 * role check), matching the governance nav that exposes the manager page.
 */
import { and, asc, eq, ne } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { contentTemplates } from "@db/schema";
import { requireOrg, requireRole } from "./auth.middleware";
import { deleteObject, getObject, isStorageConfigured, putObject } from "../server/storage";
import { resolveAiConfig, aiJson, type AiImage } from "./ai-gateway.server";
import {
  TEMPLATE_EXTRACTION_HINT,
  TEMPLATE_KINDS,
  JdTemplateConfig,
  LinkedinPostTemplateConfig,
  JobCardTemplateConfig,
  JobCardZone,
  OfferLetterTemplateConfig,
  type TemplateKind,
} from "./templates.server";

type TemplateRow = typeof contentTemplates.$inferSelect;

/** PostgREST-style snake_case wire row, matching the shapes routes read. */
function toWire(row: TemplateRow) {
  return {
    id: row.id,
    kind: row.kind as TemplateKind,
    name: row.name,
    is_default: row.isDefault,
    config: row.config ?? {},
    instructions: row.instructions,
    logo_path: row.logoPath,
    logo_content_type: row.logoContentType,
    has_logo: Boolean(row.logoPath),
    background_path: row.backgroundPath,
    background_content_type: row.backgroundContentType,
    has_background: Boolean(row.backgroundPath),
    source_path: row.sourcePath,
    source_name: row.sourceName,
    source_content_type: row.sourceContentType,
    has_source: Boolean(row.sourcePath),
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
  };
}

export type TemplateWire = ReturnType<typeof toWire>;

/* ---------------------------------------------------- import from file */

const ANALYST_CONFIG_SPEC: Record<TemplateKind, string> = {
  linkedin_post:
    'config: { tone: "professional" | "warm" | "bold", mustInclude: string[] (lines that must appear verbatim, [] if none), hashtags: string[] (without the # symbol, [] if none), disclaimer: string | null }',
  jd: "config: { sections: [{ key: short_snake_case_key, heading: exact heading text }] in document order ([] if unclear), boilerplate: string | null (recurring paragraph that appears in every JD) }",
  job_card:
    'config: { accentColor: "#rrggbb" (dominant brand accent), layout: "artwork" for image-based templates, overlayOpacity: 0-75 dark scrim percent so overlaid text stays readable, textColor: "#rrggbb" for overlaid text, zones: text slots reserved in the artwork as [{slot, x, y, w, h, fontSize, align, color}] where coordinates are PERCENT of the image size (x/y = top-left of the text box, w/h = box size), fontSize = px assuming a 1080px-wide render, align = "left" | "center" | "right". slot is one of: "role" (the job-title box, e.g. a pill or headline slot), "skills" (the skills/bullet list area), "experience" (the experience value area), "location" (the location value area), "contact" (the apply/email/footer area), "org" (the organisation-name slot). Only include slots the artwork actually reserves space for; keep each zone text colour consistent with the artwork.',
  offer_letter:
    "config: { accentColor: \"#rrggbb\" (the dominant brand accent colour used in the letterhead rule, headings or logo), sections: [{ key: short_snake_case_key, heading: exact heading or paragraph label }] in letter order ([] if unclear), boilerplate: string | null (fixed legal/clause text that belongs in every letter), headerLines: string[] (letterhead lines under the company name — address, phone, email, website, CIN — [] if none), footerLines: string[] (page-footer lines such as confidentiality or registered-office notices, [] if none), refFormat: string | null (the reference-number pattern e.g. 'Ref: HR/{year}/{seq}', null if absent), salutation: string | null (the salutation style e.g. 'Dear Ms. {candidate_name},', null if absent), signatory: { name: string, designation: string } | null (the named signatory block, null if absent) }",
};

const AnalyzeInput = z
  .object({
    kind: z.enum(TEMPLATE_KINDS),
    fileName: z.string().min(1).max(200),
    text: z.string().max(60_000).optional(),
    image: z
      .object({
        base64: z.string().min(50).max(5_000_000),
        contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      })
      .optional(),
  })
  .refine((d) => Boolean(d.text?.trim()) !== Boolean(d.image), {
    message: "Provide exactly one of text or image",
  });

/**
 * One-time AI read of a company's existing template file (text extracted
 * client-side, or the raw image for vision). Returns a SUGGESTION for the
 * editor — never persists anything.
 */
export const analyzeTemplateFile = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) => AnalyzeInput.parse(data))
  .handler(async ({ data, context }) => {
    const cfg = await resolveAiConfig(context.orgId);
    let images: AiImage[] | undefined;
    let material: string;
    if (data.image) {
      images = [data.image];
      material = `The organisation's template is the attached image file "${data.fileName}".`;
    } else {
      material = `The organisation's template file "${data.fileName}" contains:\n\n${(data.text ?? "").slice(0, 60_000)}`;
    }

    const systemPrompt =
      "You are a formatting analyst. An organisation supplies an existing hiring-content template; " +
      "read it and describe its format so an editor can be prefilled. Never write new hiring content — " +
      `only report what the document itself establishes. For template kind "${data.kind}" capture: ` +
      TEMPLATE_EXTRACTION_HINT[data.kind] +
      ". Return ONLY JSON with keys: name (short name for this template, 2-5 words), summary " +
      '(2 sentences on what the document establishes), confidence: "high" | "medium" | "low", ' +
      `config: ${ANALYST_CONFIG_SPEC[data.kind]}, instructions (free-text instructions to an AI writer ` +
      "reproducing this format, using placeholders like {{role}} {{location}} where job-specific values " +
      "belong, or empty string), placeholders (which of role/company/location/experience/openings/salary " +
      "the document references, lowercase).";
    const callModel = (strict: boolean) =>
      aiJson<{
        name?: string;
        summary?: string;
        confidence?: string;
        config?: unknown;
        instructions?: string;
        placeholders?: string[];
      }>({
        orgId: context.orgId,
        config: cfg,
        feature: "template_import",
        ...(images ? { images } : {}),
        system: systemPrompt,
        prompt: strict
          ? material +
            "\n\nYour previous answer did not match the required config shape exactly. " +
            "Return the JSON again, following the config spec literally: lists are always arrays " +
            "(use [] when empty), enums use exactly the allowed values, nullable fields use null."
          : material,
      });
    let result = await callModel(false);
    if (!result.ok) throw new Error(result.message);

    const raw = result.data;
    const configSchema =
      data.kind === "linkedin_post"
        ? LinkedinPostTemplateConfig
        : data.kind === "jd"
          ? JdTemplateConfig
          : data.kind === "offer_letter"
            ? OfferLetterTemplateConfig
            : JobCardTemplateConfig;
    let parsedConfig = configSchema.safeParse(raw.config ?? {});
    if (!parsedConfig.success) {
      // One strict-shape retry — model output occasionally misses the spec.
      result = await callModel(true);
      if (!result.ok) throw new Error(result.message);
      parsedConfig = configSchema.safeParse(result.data.config ?? {});
    }
    if (!parsedConfig.success) {
      throw new Error(
        "Could not read a usable template from that file — try a clearer export or fill the editor manually.",
      );
    }
    const finalRaw = result.data;
    const known = new Set(["role", "company", "location", "experience", "openings", "salary"]);
    return {
      name: (finalRaw.name ?? "").trim().slice(0, 80),
      summary: (finalRaw.summary ?? "").trim(),
      confidence:
        finalRaw.confidence === "high" || finalRaw.confidence === "medium"
          ? finalRaw.confidence
          : "low",
      config: parsedConfig.data,
      instructions: (finalRaw.instructions ?? "").trim().slice(0, 4000),
      placeholders: (finalRaw.placeholders ?? []).filter((p) => known.has(String(p).toLowerCase())),
    };
  });

/**
 * Print-QA validation agent: compares the rendered card against the approved
 * template artwork and returns corrected zone geometry. The rendered image
 * arrives from the client canvas; the template artwork is loaded server-side.
 */
export const validateJobCard = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) =>
    z
      .object({
        templateId: z.string().uuid(),
        renderedBase64: z.string().min(1_000).max(14_000_000),
        zones: z.array(z.record(z.string(), z.unknown())).max(12),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({
        backgroundPath: contentTemplates.backgroundPath,
        backgroundContentType: contentTemplates.backgroundContentType,
      })
      .from(contentTemplates)
      .where(
        and(eq(contentTemplates.id, data.templateId), eq(contentTemplates.orgId, context.orgId)),
      )
      .limit(1);
    if (!row?.backgroundPath || !row.backgroundPath.startsWith(`${context.orgId}/branding/`)) {
      throw new Error("This template has no background artwork to validate against.");
    }
    const file = await getObject(row.backgroundPath);
    if (!file) throw new Error("The template artwork could not be loaded.");

    const cfg = await resolveAiConfig(context.orgId);
    const result = await aiJson<{
      issues?: string[];
      zones?: unknown;
    }>({
      orgId: context.orgId,
      config: cfg,
      feature: "jobcard_qa",
      images: [
        {
          base64: Buffer.from(file.bytes).toString("base64"),
          contentType: (file.contentType || "image/png") as AiImage["contentType"],
        },
        { base64: data.renderedBase64, contentType: "image/png" as const },
      ],
      system:
        "You are a print-QA validator for branded job advert images. Image 1 is the approved " +
        "template artwork; Image 2 is a generated job card that reuses that artwork with a new " +
        "job's text. Compare them and find every gap: text boxes misaligned with the template's " +
        "layout, text overlapping artwork elements, values left from the template sample, missing " +
        "or wrong content, poor contrast. Then return CORRECTED zone geometry that makes Image 2 " +
        "match the template layout exactly. Coordinates are PERCENT of the image size. " +
        "Return ONLY JSON: {issues: string[] (max 6, one short sentence each), zones: [{slot, x, y, w, h, " +
        'fontSize, align, color, mask}]}. slot is one of "role" | "org" | "skills" | "experience" | ' +
        '"location" | "contact"; mask true means the zone paints over the artwork text beneath it.',
      prompt: JSON.stringify({ currentZones: data.zones }),
    });
    if (!result.ok) throw new Error(result.message);

    const zones = z
      .array(JobCardZone)
      .max(12)
      .safeParse(result.data.zones ?? []);
    return {
      issues: (result.data.issues ?? []).slice(0, 8).map((i) => String(i)),
      // Validation corrects geometry — masking always stays on so the
      // template's baked sample text never shows through.
      zones: zones.success ? zones.data.map((zone) => ({ ...zone, mask: true })) : null,
    };
  });

const SOURCE_CONTENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
const MAX_SOURCE_BASE64 = 14_000_000; // ≈10 MB decoded

/** Keep the original company file alongside the template it produced. */
export const uploadTemplateSource = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) =>
    z
      .object({
        templateId: z.string().uuid(),
        base64: z.string().min(1).max(MAX_SOURCE_BASE64),
        contentType: z.enum(SOURCE_CONTENT_TYPES),
        fileName: z.string().min(1).max(200),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    if (!isStorageConfigured()) {
      throw new Error("Object storage is not configured on this deployment.");
    }
    const [row] = await db
      .select({ id: contentTemplates.id, sourcePath: contentTemplates.sourcePath })
      .from(contentTemplates)
      .where(
        and(eq(contentTemplates.id, data.templateId), eq(contentTemplates.orgId, context.orgId)),
      )
      .limit(1);
    if (!row) throw new Error("Template not found");

    const key = `${context.orgId}/branding/source-${data.templateId}-${Date.now()}`;
    await putObject(key, Buffer.from(data.base64, "base64"), data.contentType);
    await db
      .update(contentTemplates)
      .set({
        sourcePath: key,
        sourceName: data.fileName,
        sourceContentType: data.contentType,
        updatedAt: new Date(),
      })
      .where(eq(contentTemplates.id, data.templateId));
    if (row.sourcePath && row.sourcePath !== key) {
      await deleteObject(row.sourcePath).catch(() => {});
    }
    return { ok: true as const };
  });

export const listTemplates = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const rows = await db
      .select()
      .from(contentTemplates)
      .where(eq(contentTemplates.orgId, context.orgId))
      .orderBy(asc(contentTemplates.kind), asc(contentTemplates.name));
    return rows.map(toWire);
  });

const TemplateConfigInput = z.record(z.string(), z.unknown()).default({});

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum(TEMPLATE_KINDS),
  name: z.string().min(1).max(80),
  config: TemplateConfigInput,
  instructions: z.string().max(4000).nullish(),
});

/** Create or update a template. Uniqueness trips the org+kind+name index. */
export const saveTemplate = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const payload = {
      kind: data.kind,
      name: data.name.trim(),
      config: data.config,
      instructions: data.instructions?.trim() || null,
      updatedAt: new Date(),
    };
    if (data.id) {
      const [row] = await db
        .update(contentTemplates)
        .set(payload)
        .where(and(eq(contentTemplates.id, data.id), eq(contentTemplates.orgId, context.orgId)))
        .returning();
      if (!row) throw new Error("Template not found");
      return toWire(row);
    }
    const [row] = await db
      .insert(contentTemplates)
      .values({ ...payload, orgId: context.orgId })
      .returning();
    if (!row) throw new Error("Could not save the template");
    return toWire(row);
  });

export const deleteTemplate = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .delete(contentTemplates)
      .where(and(eq(contentTemplates.id, data.id), eq(contentTemplates.orgId, context.orgId)))
      .returning({
        logoPath: contentTemplates.logoPath,
        sourcePath: contentTemplates.sourcePath,
        backgroundPath: contentTemplates.backgroundPath,
      });
    for (const key of [row?.logoPath, row?.sourcePath, row?.backgroundPath]) {
      if (key) await deleteObject(key).catch(() => {});
    }
    return { ok: true as const };
  });

/**
 * Point the org's default for this template's kind at it. The partial unique
 * index backstops the transactional clear-then-set against races.
 */
export const setTemplateDefault = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ kind: contentTemplates.kind })
        .from(contentTemplates)
        .where(and(eq(contentTemplates.id, data.id), eq(contentTemplates.orgId, context.orgId)))
        .limit(1);
      if (!row) throw new Error("Template not found");

      await tx
        .update(contentTemplates)
        .set({ isDefault: false })
        .where(
          and(
            eq(contentTemplates.orgId, context.orgId),
            eq(contentTemplates.kind, row.kind),
            ne(contentTemplates.id, data.id),
          ),
        );
      await tx
        .update(contentTemplates)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(contentTemplates.id, data.id));
    });
    return { ok: true as const };
  });

const LOGO_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const MAX_LOGO_BASE64 = 1_400_000; // ≈1 MB decoded

export const uploadTemplateLogo = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) =>
    z
      .object({
        templateId: z.string().uuid(),
        base64: z.string().min(1).max(MAX_LOGO_BASE64),
        contentType: z.enum(LOGO_CONTENT_TYPES),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    if (!isStorageConfigured()) {
      throw new Error("Object storage is not configured on this deployment.");
    }
    const [row] = await db
      .select({ id: contentTemplates.id, logoPath: contentTemplates.logoPath })
      .from(contentTemplates)
      .where(
        and(eq(contentTemplates.id, data.templateId), eq(contentTemplates.orgId, context.orgId)),
      )
      .limit(1);
    if (!row) throw new Error("Template not found");

    const key = `${context.orgId}/branding/logo-${data.templateId}-${Date.now()}`;
    await putObject(key, Buffer.from(data.base64, "base64"), data.contentType);
    await db
      .update(contentTemplates)
      .set({ logoPath: key, logoContentType: data.contentType, updatedAt: new Date() })
      .where(eq(contentTemplates.id, data.templateId));
    if (row.logoPath && row.logoPath !== key) {
      await deleteObject(row.logoPath).catch(() => {});
    }
    return { ok: true as const, logoPath: key, logoContentType: data.contentType };
  });

const MAX_BACKGROUND_BASE64 = 14_000_000; // ≈10 MB decoded — full-bleed artwork

/** Store the job-card background artwork (replaces any previous one). */
export const uploadTemplateBackground = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) =>
    z
      .object({
        templateId: z.string().uuid(),
        base64: z.string().min(1).max(MAX_BACKGROUND_BASE64),
        contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    if (!isStorageConfigured()) {
      throw new Error("Object storage is not configured on this deployment.");
    }
    const [row] = await db
      .select({ id: contentTemplates.id, backgroundPath: contentTemplates.backgroundPath })
      .from(contentTemplates)
      .where(
        and(eq(contentTemplates.id, data.templateId), eq(contentTemplates.orgId, context.orgId)),
      )
      .limit(1);
    if (!row) throw new Error("Template not found");

    const key = `${context.orgId}/branding/background-${data.templateId}-${Date.now()}`;
    await putObject(key, Buffer.from(data.base64, "base64"), data.contentType);
    await db
      .update(contentTemplates)
      .set({ backgroundPath: key, backgroundContentType: data.contentType, updatedAt: new Date() })
      .where(eq(contentTemplates.id, data.templateId));
    if (row.backgroundPath && row.backgroundPath !== key) {
      await deleteObject(row.backgroundPath).catch(() => {});
    }
    return { ok: true as const };
  });

/** Authenticated background delivery for the canvas preview. */
export const getTemplateBackground = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ templateId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({
        backgroundPath: contentTemplates.backgroundPath,
        backgroundContentType: contentTemplates.backgroundContentType,
      })
      .from(contentTemplates)
      .where(
        and(eq(contentTemplates.id, data.templateId), eq(contentTemplates.orgId, context.orgId)),
      )
      .limit(1);
    if (!row?.backgroundPath || !row.backgroundPath.startsWith(`${context.orgId}/branding/`)) {
      return { ok: false as const };
    }
    let file: { bytes: Uint8Array; contentType: string } | null;
    try {
      file = await getObject(row.backgroundPath);
    } catch {
      return { ok: false as const };
    }
    if (!file || file.bytes.byteLength > 10 * 1024 * 1024) return { ok: false as const };
    return {
      ok: true as const,
      base64: Buffer.from(file.bytes).toString("base64"),
      contentType: file.contentType || row.backgroundContentType || "image/png",
    };
  });

/** Authenticated logo delivery for the canvas preview — bytes never leave ATSIQ. */
export const getTemplateLogo = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ templateId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({
        logoPath: contentTemplates.logoPath,
        logoContentType: contentTemplates.logoContentType,
      })
      .from(contentTemplates)
      .where(
        and(eq(contentTemplates.id, data.templateId), eq(contentTemplates.orgId, context.orgId)),
      )
      .limit(1);
    if (!row?.logoPath || !row.logoPath.startsWith(`${context.orgId}/branding/`)) {
      return { ok: false as const };
    }
    let file: { bytes: Uint8Array; contentType: string } | null;
    try {
      file = await getObject(row.logoPath);
    } catch {
      return { ok: false as const };
    }
    if (!file || file.bytes.byteLength > 5 * 1024 * 1024) return { ok: false as const };
    return {
      ok: true as const,
      base64: Buffer.from(file.bytes).toString("base64"),
      contentType: file.contentType || row.logoContentType || "image/png",
    };
  });
