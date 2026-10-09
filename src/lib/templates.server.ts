/**
 * Org content templates — resolution and prompt composition. Pure business
 * logic: no server fns, no React. A corrupt or legacy config row degrades to
 * the built-in behaviour (resolveTemplate → null), never fails a generation.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { contentTemplates } from "@db/schema";

export const TEMPLATE_KINDS = ["linkedin_post", "jd", "job_card", "offer_letter"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_PLACEHOLDERS = [
  "{{role}}",
  "{{company}}",
  "{{location}}",
  "{{experience}}",
  "{{openings}}",
  "{{salary}}",
] as const;

/** What the import analyst should look for, per template kind. */
export const TEMPLATE_EXTRACTION_HINT: Record<TemplateKind, string> = {
  linkedin_post:
    "tone of voice, lines that must appear verbatim, hashtag conventions, disclaimers or EOE statements, structural habits (opening style, emoji use, length)",
  jd: "section headings and their exact order, recurring boilerplate paragraphs, tone conventions",
  job_card:
    "brand accent colour (as hex), layout style (top banner vs side stripe), the content blocks a job advert image should carry",
  offer_letter:
    "the brand logo placement and dominant brand accent colour (as hex), letterhead address/contact lines under the company name, page footer text (confidentiality, registered office, CIN), reference-number format, salutation style, section/paragraph structure in order, annexures, fixed legal/clause language that appears in every letter, the signature block (signatory name and designation), tone conventions",
};

/* ------------------------------------------------------ per-kind configs */

export const LinkedinPostTemplateConfig = z.object({
  tone: z.enum(["professional", "warm", "bold"]).nullish(),
  mustInclude: z.preprocess((v) => v ?? [], z.array(z.string().min(1)).max(10).default([])),
  hashtags: z.preprocess((v) => v ?? [], z.array(z.string().min(1)).max(12).default([])),
  disclaimer: z.string().max(500).nullish(),
});
export type LinkedinPostTemplateConfig = z.infer<typeof LinkedinPostTemplateConfig>;

export const JdTemplateConfig = z.object({
  sections: z.preprocess(
    (v) => coerceSections(v ?? []).filter((s) => s.heading),
    z
      .array(z.object({ key: z.string(), heading: z.string().min(1) }))
      .max(12)
      .default([]),
  ),
  boilerplate: z.preprocess(
    (v) => (typeof v === "string" ? v.slice(0, 2000) : v),
    z.string().max(2000).nullish(),
  ),
});
export type JdTemplateConfig = z.infer<typeof JdTemplateConfig>;

/**
 * A text slot on the job-card artwork, in percent of the image size
 * (x/y = top-left, w/h = box size). The renderer fills each slot with the
 * new job's value for that `slot`.
 */
export const JobCardZone = z.object({
  slot: z.enum(["role", "skills", "experience", "location", "contact", "org"]),
  x: z.coerce.number().min(0).max(100),
  y: z.coerce.number().min(0).max(100),
  w: z.coerce.number().min(1).max(100),
  h: z.coerce.number().min(1).max(100),
  fontSize: z.coerce.number().int().min(8).max(200).default(36),
  align: z.enum(["left", "center", "right"]).default("left"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullish(),
  /** Fill the slot with the local artwork colour before drawing (hides baked text). */
  mask: z.boolean().default(true),
  fontFamily: z.enum(["system", "serif", "mono"]).nullish(),
});
export type JobCardZone = z.infer<typeof JobCardZone>;

export const JobCardTemplateConfig = z.object({
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#4f46e5"),
  layout: z.enum(["banner", "side", "artwork"]).default("artwork"),
  /** Dark scrim over the background image, percent 0–75 (default 38). */
  overlayOpacity: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.coerce.number().int().min(0).max(75).default(38),
  ),
  textColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullish(),
  /** Background brightness, percent 50–130 (default 100). */
  backgroundBrightness: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.coerce.number().int().min(50).max(130).default(100),
  ),
  /** Text slots on the artwork — present when the template is image-based. */
  zones: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(JobCardZone).max(12).default([])),
});
export type JobCardTemplateConfig = z.infer<typeof JobCardTemplateConfig>;

/** Model section lists arrive as strings, key-less objects or null — coerce leniently. */
const coerceSections = (v: unknown) =>
  Array.isArray(v)
    ? v.map((s, i) =>
        typeof s === "string"
          ? { key: `section_${i + 1}`, heading: s }
          : { key: String(s?.key ?? `section_${i + 1}`), heading: String(s?.heading ?? "") },
      )
    : [];

/** Fixed furniture of an enterprise letter — rendered verbatim, never model-written. */
const letterLines = (max: number) =>
  z.preprocess(
    (v) =>
      Array.isArray(v)
        ? v
            .map((s) => String(s).trim())
            .filter(Boolean)
            .slice(0, max)
        : typeof v === "string"
          ? v
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, max)
          : [],
    z.array(z.string().min(1).max(200)).max(max),
  );

export const OfferLetterTemplateConfig = z.object({
  /** Brand accent — letterhead rule, section headings, clause-box border. */
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#4f46e5"),
  sections: z.preprocess(
    (v) => coerceSections(v ?? []).filter((s) => s.heading),
    z
      .array(z.object({ key: z.string(), heading: z.string().min(1) }))
      .max(16)
      .default([]),
  ),
  boilerplate: z.preprocess(
    (v) => (typeof v === "string" ? v.slice(0, 4000) : v),
    z.string().max(4000).nullish(),
  ),
  /** Letterhead lines under the company name (address, phone, website…). */
  headerLines: letterLines(6).default([]),
  /** Fixed page-footer lines (confidentiality notice, registered office…). */
  footerLines: letterLines(4).default([]),
  /** e.g. "Ref: HR/{year}/{seq}" — {year} and {seq} are substituted per offer. */
  refFormat: z
    .preprocess(
      (v) => (typeof v === "string" ? v.trim().slice(0, 80) || null : null),
      z.string().max(80).nullish(),
    )
    .nullable()
    .default(null),
  /** e.g. "Dear Ms. {candidate_name}," — replaces the model's salutation. */
  salutation: z
    .preprocess(
      (v) => (typeof v === "string" ? v.trim().slice(0, 120) || null : null),
      z.string().max(120).nullish(),
    )
    .nullable()
    .default(null),
  /** Named signatory of every letter issued from this template. */
  signatory: z
    .object({ name: z.string().min(1).max(120), designation: z.string().min(1).max(120) })
    .nullish()
    .default(null),
});
export type OfferLetterTemplateConfig = z.infer<typeof OfferLetterTemplateConfig>;

const CONFIG_SCHEMA: Record<TemplateKind, z.ZodTypeAny> = {
  linkedin_post: LinkedinPostTemplateConfig,
  jd: JdTemplateConfig,
  job_card: JobCardTemplateConfig,
  offer_letter: OfferLetterTemplateConfig,
};

export type ResolvedTemplate<K extends TemplateKind = TemplateKind> = {
  id: string;
  name: string;
  kind: K;
  config: K extends "linkedin_post"
    ? LinkedinPostTemplateConfig
    : K extends "jd"
      ? JdTemplateConfig
      : K extends "offer_letter"
        ? OfferLetterTemplateConfig
        : JobCardTemplateConfig;
  instructions: string | null;
  logoPath: string | null;
  logoContentType: string | null;
};

/**
 * The template for a generation: the explicit id when the designer pinned
 * one, otherwise the org's default for the kind, otherwise null — the
 * built-in prompt behaviour.
 */
export async function resolveTemplate<K extends TemplateKind>(
  orgId: string,
  kind: K,
  templateId?: string | null,
): Promise<ResolvedTemplate<K> | null> {
  const where = templateId
    ? and(
        eq(contentTemplates.orgId, orgId),
        eq(contentTemplates.kind, kind),
        eq(contentTemplates.id, templateId),
      )
    : and(
        eq(contentTemplates.orgId, orgId),
        eq(contentTemplates.kind, kind),
        eq(contentTemplates.isDefault, true),
      );
  const [row] = await db.select().from(contentTemplates).where(where).limit(1);
  if (!row) return null;

  const parsed = CONFIG_SCHEMA[kind].safeParse(row.config ?? {});
  if (!parsed.success) return null;
  return {
    id: row.id,
    name: row.name,
    kind,
    config: parsed.data,
    instructions: row.instructions,
    logoPath: row.logoPath,
    logoContentType: row.logoContentType,
  } as ResolvedTemplate<K>;
}

/**
 * Choose a template for a generation when none is pinned, and say why: the
 * org's default for the kind; else its only template; else the one whose name
 * best matches the hint (role title, department); else the oldest. Null when
 * the org has no template of this kind.
 */
/**
 * A template the person asked for by name ("the Yavar template"): exact name,
 * else a name containing the words asked for. Also returns the names that
 * exist, so a miss can be answered honestly.
 */
export async function findTemplateByName(
  orgId: string,
  kind: TemplateKind,
  asked: string,
): Promise<{
  match: { id: string; name: string; by: "name" | "content"; evidence: string | null } | null;
  names: string[];
  /** Several templates mention what was asked for in their content: ask which. */
  ambiguous: string[];
}> {
  const rows = await db
    .select({
      id: contentTemplates.id,
      name: contentTemplates.name,
      config: contentTemplates.config,
    })
    .from(contentTemplates)
    .where(and(eq(contentTemplates.orgId, orgId), eq(contentTemplates.kind, kind)));
  const names = rows.map((r) => r.name);
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/\btemplates?\b/g, " ")
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length >= 2);
  const q = words(asked);
  const exact = rows.find((r) => r.name.trim().toLowerCase() === asked.trim().toLowerCase());
  const partial = q.length
    ? rows.find((r) => {
        const n = new Set(words(r.name));
        return q.every((w) => n.has(w));
      })
    : undefined;
  const byName = exact ?? partial;
  if (byName)
    return {
      match: { id: byName.id, name: byName.name, by: "name", evidence: null },
      names,
      ambiguous: [],
    };
  if (!q.length) return { match: null, names, ambiguous: [] };
  // People name a template by what it is ("the Yavar one"), not by its title:
  // look inside — section headings, standard wording, instructions.
  const inContent = rows.filter((r) => {
    const n = new Set(words(JSON.stringify(r.config ?? {})));
    return q.every((w) => n.has(w));
  });
  if (inContent.length > 1) return { match: null, names, ambiguous: inContent.map((r) => r.name) };
  const hit = inContent[0];
  if (!hit) return { match: null, names, ambiguous: [] };
  const cfg = (hit.config ?? {}) as { sections?: { heading?: string }[] };
  const headings = (cfg.sections ?? [])
    .map((x) => x.heading ?? "")
    .filter((h) => q.every((w) => new Set(words(h)).has(w)));
  return {
    match: {
      id: hit.id,
      name: hit.name,
      by: "content",
      evidence: headings.length
        ? `its sections ${headings.map((h) => `"${h}"`).join(", ")}`
        : `its standard wording mentions "${asked}"`,
    },
    names,
    ambiguous: [],
  };
}

export async function pickTemplate(
  orgId: string,
  kind: TemplateKind,
  hint: string,
  /** A template the reviewer asked for by name; wins when it exists. */
  preferred?: string,
): Promise<{ id: string; name: string; reason: string } | null> {
  if (preferred?.trim()) {
    const { match, names } = await findTemplateByName(orgId, kind, preferred);
    if (!match)
      throw new Error(
        `There is no template named "${preferred}". Templates of this kind: ${names.join(", ") || "none"}.`,
      );
    return { id: match.id, name: match.name, reason: "the template the reviewer asked for" };
  }
  const rows = await db
    .select({
      id: contentTemplates.id,
      name: contentTemplates.name,
      isDefault: contentTemplates.isDefault,
      createdAt: contentTemplates.createdAt,
    })
    .from(contentTemplates)
    .where(and(eq(contentTemplates.orgId, orgId), eq(contentTemplates.kind, kind)));
  if (!rows.length) return null;
  const def = rows.find((r) => r.isDefault);
  if (def) return { id: def.id, name: def.name, reason: "your default template" };
  if (rows.length === 1)
    return { id: rows[0]!.id, name: rows[0]!.name, reason: "your only template of this kind" };
  const words = new Set(
    hint
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length >= 3),
  );
  const scored = rows
    .map((r) => ({
      r,
      hits: r.name
        .toLowerCase()
        .split(/[^a-z0-9+#]+/)
        .filter((w) => words.has(w)).length,
    }))
    .sort((a, b) => b.hits - a.hits || a.r.createdAt.getTime() - b.r.createdAt.getTime());
  const best = scored[0]!;
  return {
    id: best.r.id,
    name: best.r.name,
    reason: best.hits
      ? "the closest match to this role by name"
      : "your oldest template (none is marked default)",
  };
}

/* ------------------------------------------------------- prompt building */

type PromptTemplate = ResolvedTemplate<"linkedin_post"> | ResolvedTemplate<"jd">;

/**
 * Compose the system prompt for a generation: the built-in rules, then the
 * org's template layered on top — structured config first, free-text
 * instructions verbatim, and the placeholder contract last.
 */
export function buildTemplateSystemPrompt(opts: {
  base: string;
  template: PromptTemplate | null;
  tone?: string | null;
}) {
  const t = opts.template;
  if (!t) return opts.base;

  const parts: string[] = [
    opts.base,
    "Follow this organisation's content template strictly — it overrides your default style choices.",
  ];

  const tone = (t.config as LinkedinPostTemplateConfig).tone ?? opts.tone;
  if (t.kind === "linkedin_post") {
    const cfg = t.config as LinkedinPostTemplateConfig;
    if (tone) parts.push(`Tone of voice: ${tone}.`);
    if (cfg.mustInclude.length)
      parts.push(
        `These exact lines MUST appear in the post, in this order:\n${cfg.mustInclude.map((l) => `- ${l}`).join("\n")}`,
      );
    if (cfg.hashtags.length)
      parts.push(
        `Use EXACTLY these hashtags (no # symbol, keep the casing): ${cfg.hashtags.join(", ")}.`,
      );
    if (cfg.disclaimer)
      parts.push(`Append this disclaimer verbatim at the end: "${cfg.disclaimer}"`);
  } else {
    const cfg = t.config as JdTemplateConfig;
    if (tone) parts.push(`Tone of voice: ${tone}.`);
    if (cfg.sections.length)
      parts.push(
        `The full_text JD must use these section headings in this exact order: ${cfg.sections
          .map((s) => s.heading)
          .join(" → ")}. Each heading covers its listed aspect.`,
      );
    if (cfg.boilerplate)
      parts.push(`Include this boilerplate verbatim in the JD:\n"""${cfg.boilerplate}"""`);
  }

  if (t.instructions?.trim())
    parts.push(`Extra organisation instructions:\n"""${t.instructions.trim()}"""`);

  parts.push(
    `Placeholders you may use: ${TEMPLATE_PLACEHOLDERS.join(" ")} — replace each with the real value ` +
      "from the job data ({{salary}} only when the data includes one), or drop the sentence it appears in. " +
      "Never emit a literal {{placeholder}} in the output.",
  );
  return parts.join("\n\n");
}

/** Remove any {{placeholder}} the model failed to substitute, plus the debris. */
export function stripUnreplacedPlaceholders(text: string) {
  return text
    .replace(/\{\{\s*[a-z_]+\s*\}\}/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+$/gm, "");
}
