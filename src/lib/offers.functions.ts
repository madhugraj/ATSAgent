/**
 * Org-scoped offer lifecycle: raising an offer against an application and
 * walking it through the HR → CBO → release → acceptance approval chain.
 * Every read/write is predicated on the caller's verified organisation.
 */
import { and, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { applications, candidates, offers, organizations, requisitions } from "@db/schema";
import { assertRole, requireOrg, requireRole, type AppRole } from "./auth.middleware";
import { resolveAiConfig, aiJson } from "./ai-gateway.server";
import { resolveTemplate, stripUnreplacedPlaceholders } from "./templates.server";

const OfferStatus = z.enum([
  "draft",
  "pending_hr",
  "pending_cbo",
  "approved",
  "released",
  "accepted",
  "declined",
  "revoked",
]);

/**
 * Offer approval chain (HR → CBO → release), enforced server-side: each target
 * status names the legal source statuses and the role that may make the hop.
 */
const OFFER_TRANSITIONS: Partial<
  Record<(typeof OfferStatus.options)[number], { from: string[]; role?: AppRole | AppRole[] }>
> = {
  draft: { from: ["draft", "declined", "revoked"] },
  pending_hr: { from: ["draft"] },
  pending_cbo: { from: ["pending_hr"], role: "hr_head" },
  approved: { from: ["pending_cbo"], role: "president_cbo" },
  released: { from: ["approved"], role: "hr_head" },
  accepted: { from: ["released"] },
  declined: { from: ["released"] },
  revoked: { from: ["released", "accepted"], role: ["hr_head", "president_cbo"] },
};

/**
 * Raise an offer: verify the application belongs to the caller's org, file the
 * offer at "pending_hr", then park the candidate on "offer_pending". The
 * legacy client ignored failures of that stage bump, so it stays best-effort.
 */
/** Shared by the server function and the agents (acting member in `actor`). */
export async function createOfferCore(
  actor: { orgId: string; userId: string; memberEmail: string },
  data: { applicationId: string; offeredCtc: string; joiningDate?: string | null | undefined },
  /** Agents start at "draft" so the letter is generated before approval. */
  status: "draft" | "pending_hr" = "pending_hr",
): Promise<{ ok: true; id: string }> {
  // Raising an offer is a recruiting-team action — hiring managers and
  // department heads consume offers through approvals, they don't create them.
  await assertRole(
    actor.userId,
    actor.orgId,
    ["recruiter", "hr_head", "president_cbo"],
    "Only the recruiting team (recruiter, HR head or the CBO) can raise an offer.",
  );

  const [application] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, data.applicationId), eq(applications.orgId, actor.orgId)))
    .limit(1);
  if (!application) throw new Error("Application not found");

  const [created] = await db
    .insert(offers)
    .values({
      applicationId: data.applicationId,
      orgId: actor.orgId,
      offeredCtc: String(Number(data.offeredCtc) || 0),
      joiningDate: data.joiningDate || null,
      status,
    })
    .returning({ id: offers.id });

  // Raising the offer is what puts the candidate in "offer pending approval".
  try {
    await db
      .update(applications)
      .set({ stage: "offer_pending" })
      .where(and(eq(applications.id, data.applicationId), eq(applications.orgId, actor.orgId)));
  } catch {
    /* stage bump is best-effort, exactly as before */
  }
  return { ok: true as const, id: created!.id };
}

export const createOffer = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        applicationId: z.string().uuid(),
        offeredCtc: z.string().min(1),
        joiningDate: z.string().nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) =>
    createOfferCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      data,
    ),
  );

/**
 * Advance an offer one step: append the trail entry and set the next status.
 * The step that submits the creator's offer for its first approval
 * (pending_hr → pending_cbo) requires a generated offer letter — the creator
 * must have produced and reviewed one before the offer moves on. When the
 * step also moves the candidate (release → offer_released, acceptance →
 * offer_accepted) the caller passes `applicationStage` and the linked
 * application is updated the same best-effort way as before.
 */
/** Shared by the server function and the agents (acting member in `actor`). */
export async function advanceOfferCore(
  actor: { orgId: string; userId: string; memberEmail: string; via?: "agent" },
  data: {
    id: string;
    status: z.infer<typeof OfferStatus>;
    applicationStage?: "offer_released" | "offer_accepted" | undefined;
  },
) {
  const [current] = await db
    .select({ status: offers.status, letter: offers.letter, approvalTrail: offers.approvalTrail })
    .from(offers)
    .where(and(eq(offers.id, data.id), eq(offers.orgId, actor.orgId)))
    .limit(1);
  if (!current) throw new Error("Offer not found");

  const rule = OFFER_TRANSITIONS[data.status];
  if (!rule || !rule.from.includes(current.status)) {
    throw new Error(`An offer cannot move from ${current.status} to ${data.status}.`);
  }
  if (rule.role) {
    await assertRole(actor.userId, actor.orgId, rule.role);
  }
  if (data.status === "pending_hr" && !current.letter) {
    throw new Error("Generate and review the offer letter before sending this offer for approval.");
  }
  // Release gate: pre-onboarding documents must be collected and validated
  // before the letter goes out. The checklist is evaluated server-side.
  if (data.status === "released") {
    const [target] = await db
      .select({ applicationId: offers.applicationId })
      .from(offers)
      .where(and(eq(offers.id, data.id), eq(offers.orgId, actor.orgId)))
      .limit(1);
    if (target) {
      const { readinessFor, docTypeLabel } = await import("./onboarding.server");
      const readiness = await readinessFor(actor.orgId, target.applicationId);
      if (!readiness.ready) {
        throw new Error(
          `Pre-onboarding is incomplete — validate these documents first: ${readiness.missing
            .map((m) => docTypeLabel(m))
            .join(", ")}.`,
        );
      }
    }
  }
  if (data.applicationStage === "offer_released" && data.status !== "released") {
    throw new Error("The application stage can only move to offer_released on release.");
  }
  if (data.applicationStage === "offer_accepted" && data.status !== "accepted") {
    throw new Error("The application stage can only move to offer_accepted on acceptance.");
  }

  // The approval trail is evidence — rebuilt server-side, never client-supplied.
  const prior = Array.isArray(current.approvalTrail) ? current.approvalTrail : [];
  const trail = [
    ...prior,
    {
      from: current.status,
      to: data.status,
      actor: actor.memberEmail,
      decision: data.status,
      ...(actor.via ? { via: actor.via } : {}),
      at: new Date().toISOString(),
    },
  ];

  await db
    .update(offers)
    .set({ status: data.status, approvalTrail: trail as never })
    .where(and(eq(offers.id, data.id), eq(offers.orgId, actor.orgId)));

  if (data.applicationStage) {
    const [offer] = await db
      .select({ applicationId: offers.applicationId })
      .from(offers)
      .where(and(eq(offers.id, data.id), eq(offers.orgId, actor.orgId)))
      .limit(1);
    if (offer) {
      try {
        await db
          .update(applications)
          .set({ stage: data.applicationStage })
          .where(
            and(eq(applications.id, offer.applicationId), eq(applications.orgId, actor.orgId)),
          );
      } catch {
        /* stage bump is best-effort, exactly as before */
      }
    }
  }

  /* The released offer goes to the candidate with the letter attached.
   * Best-effort: release must not fail because the email could not be queued. */
  if (data.status === "released") {
    try {
      const [offerRow] = await db
        .select({
          applicationId: offers.applicationId,
          letter: offers.letter,
          candidateEmail: candidates.email,
          candidateName: candidates.fullName,
          jobTitle: requisitions.title,
          orgName: organizations.name,
        })
        .from(offers)
        .innerJoin(applications, eq(offers.applicationId, applications.id))
        .innerJoin(candidates, eq(applications.candidateId, candidates.id))
        .innerJoin(requisitions, eq(applications.requisitionId, requisitions.id))
        .innerJoin(organizations, eq(applications.orgId, organizations.id))
        .where(and(eq(offers.id, data.id), eq(offers.orgId, actor.orgId)))
        .limit(1);
      if (offerRow?.candidateEmail && offerRow.letter) {
        const { enqueueEmail } = await import("./email-outbox.server");
        const { buildOfferLetterPdf } = await import("./offer-letter-pdf");
        const pdf = buildOfferLetterPdf(offerRow.letter as OfferLetterPayload);
        await enqueueEmail({
          orgId: actor.orgId,
          kind: "offer_released",
          templateName: "offer_released",
          toEmail: offerRow.candidateEmail,
          applicationId: offerRow.applicationId,
          templateData: {
            candidateName: offerRow.candidateName,
            orgName: offerRow.orgName,
            jobTitle: offerRow.jobTitle,
          },
          attachments: [
            {
              filename: `offer-letter-${data.id.slice(0, 8)}.pdf`,
              contentBase64: Buffer.from(pdf.output("arraybuffer")).toString("base64"),
              contentType: "application/pdf",
            },
          ],
          idempotencyKey: `offer-released:${data.id}`,
        });
      }
    } catch {
      /* best-effort, exactly like the stage bump above */
    }
  }
  {
    const [o] = await db
      .select({ applicationId: offers.applicationId })
      .from(offers)
      .where(and(eq(offers.id, data.id), eq(offers.orgId, actor.orgId)))
      .limit(1);
    if (o) {
      const { emitAgentEvent } = await import("../server/agents/events");
      await emitAgentEvent({
        orgId: actor.orgId,
        type: "offer.status_changed",
        subjectType: "offer",
        subjectId: data.id,
        actorUserId: actor.userId,
        payload: {
          from: current.status,
          to: data.status,
          applicationId: o.applicationId,
          via: actor.via ?? null,
        },
      });
    }
  }
  return { ok: true as const };
}

export const advanceOffer = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        status: OfferStatus,
        applicationStage: z.enum(["offer_released", "offer_accepted"]).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) =>
    advanceOfferCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      data,
    ),
  );

/* --------------------------------------------------------- offer letter */

/** What the model composes. Legal boilerplate never passes through it. */
export const OfferLetterBody = z.object({
  subject: z.string().min(1).max(300),
  greeting: z.string().min(1).max(200),
  opening: z.string().min(1).max(4000),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(200),
        body: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(16),
  closing: z.string().min(1).max(1000),
});
export type OfferLetterBody = z.infer<typeof OfferLetterBody>;

/** Persisted on the offer, returned by generateOfferLetter, and rendered by preview + PDF. */
export const OfferLetterPayload = OfferLetterBody.extend({
  version: z.literal(1),
  generatedAt: z.string(),
  templateId: z.string().uuid().nullable(),
  templateName: z.string().nullable(),
  hasLogo: z.boolean(),
  /** Brand accent from the template — rule, headings, clause box. */
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#4f46e5"),
  boilerplate: z.string().max(4000).nullable(),
  /** Template letterhead lines; empty = derive from the organisation record. */
  headerLines: z.array(z.string().max(200)).max(6).default([]),
  /** Fixed page-footer lines from the template. */
  footerLines: z.array(z.string().max(200)).max(4).default([]),
  /** Reference number rendered near the date, from the template's refFormat. */
  refText: z.string().max(120).nullish().default(null),
  /** Named signatory from the template; null = generic signatory block. */
  signatory: z
    .object({ name: z.string().max(120), designation: z.string().max(120) })
    .nullish()
    .default(null),
  letterhead: z.object({
    orgName: z.string(),
    legalName: z.string().nullable(),
    hqCity: z.string().nullable(),
    careersEmail: z.string().nullable(),
  }),
  candidate: z.object({
    fullName: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    location: z.string().nullable(),
  }),
  role: z.object({ title: z.string(), location: z.string().nullable() }),
  ctc: z.string(),
  joiningDate: z.string().nullable(),
});
export type OfferLetterPayload = z.infer<typeof OfferLetterPayload>;

/** Letters live with the offer from the moment it is raised. */
const CLOSED_OFFER_STATUSES = new Set(["declined", "revoked"]);

/** What the creator may hand-correct on a stored letter. Facts (candidate,
 * role, CTC, template identity) are not editable — regenerate instead. */
export const EditableOfferLetter = z.object({
  subject: z.string().min(1).max(300),
  greeting: z.string().min(1).max(200),
  opening: z.string().min(1).max(4000),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(200),
        body: z.string().min(1).max(6000),
      }),
    )
    .min(1)
    .max(20),
  closing: z.string().min(1).max(1000),
  boilerplate: z.string().max(4000).nullish(),
  headerLines: z.array(z.string().max(200)).max(6).default([]),
  footerLines: z.array(z.string().max(200)).max(4).default([]),
  refText: z.string().max(120).nullish().default(null),
});
export type EditableOfferLetter = z.infer<typeof EditableOfferLetter>;

/**
 * Persist hand corrections to the stored letter. The stored payload stays the
 * base — facts and template identity come from it — so the edited letter
 * remains exactly what preview and PDF render.
 */
export const updateOfferLetter = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z.object({ offerId: z.string().uuid(), letter: EditableOfferLetter }).parse(data),
  )
  .handler(async ({ data, context }): Promise<OfferLetterPayload> => {
    const [row] = await db
      .select({ letter: offers.letter, status: offers.status })
      .from(offers)
      .where(and(eq(offers.id, data.offerId), eq(offers.orgId, context.orgId)))
      .limit(1);
    if (!row) throw new Error("Offer not found");
    if (CLOSED_OFFER_STATUSES.has(row.status)) {
      throw new Error("This offer was declined or revoked — its letter can no longer be edited.");
    }
    const stored = OfferLetterPayload.safeParse(row.letter);
    if (!stored.success) throw new Error("Generate the letter before editing it.");

    const updated: OfferLetterPayload = {
      ...stored.data,
      subject: data.letter.subject,
      greeting: data.letter.greeting,
      opening: data.letter.opening,
      sections: data.letter.sections,
      closing: data.letter.closing,
      boilerplate: data.letter.boilerplate?.trim() || null,
      headerLines: data.letter.headerLines,
      footerLines: data.letter.footerLines,
      refText: data.letter.refText,
    };
    await db
      .update(offers)
      .set({ letter: updated })
      .where(and(eq(offers.id, data.offerId), eq(offers.orgId, context.orgId)));
    return updated;
  });

const DEFAULT_LETTER_SECTIONS = [
  "Role and Responsibilities",
  "Compensation and Benefits",
  "Terms of Employment",
  "Next Steps",
];

/** Deterministic "17 October 2026" from an ISO date — no ICU/TZ drift. */
export const fmtLetterDate = (iso: string | null | undefined) => {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d || m > 12 || d > 31) return null;
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Offer stages past which a letter may no longer be destroyed. */
const LETTER_LOCKED_STATUSES = new Set(["released", "accepted", "declined", "revoked"]);

/**
 * Governed deletion of a stored letter: HR-head or above only (owners pass),
 * a reason is mandatory, and the deletion is audited in the approval trail.
 * A letter that has already gone out (released+) is not deletable — the
 * offer itself must be revoked instead.
 */
export const deleteOfferLetter = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .inputValidator((data: unknown) =>
    z.object({ offerId: z.string().uuid(), reason: z.string().trim().min(8).max(400) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({ letter: offers.letter, status: offers.status, trail: offers.approvalTrail })
      .from(offers)
      .where(and(eq(offers.id, data.offerId), eq(offers.orgId, context.orgId)))
      .limit(1);
    if (!row) throw new Error("Offer not found");
    if (!row.letter) throw new Error("This offer has no letter to delete.");
    if (LETTER_LOCKED_STATUSES.has(row.status)) {
      throw new Error(
        "The letter can no longer be deleted at this stage — revoke the offer instead.",
      );
    }

    const trail = Array.isArray(row.trail) ? [...row.trail] : [];
    trail.push({
      action: "letter_deleted",
      reason: data.reason,
      by: context.userId,
      at: new Date().toISOString(),
    });

    await db
      .update(offers)
      .set({ letter: null, letterTemplateId: null, approvalTrail: trail })
      .where(and(eq(offers.id, data.offerId), eq(offers.orgId, context.orgId)));
    return { ok: true as const };
  });

/**
 * Compose the offer letter for a live offer against an offer_letter template —
 * the explicitly chosen one, else the org default, else the built-in structure.
 * The model writes the prose; fixed clause text (template boilerplate) is
 * injected here so it reaches the letter verbatim. The composed payload is
 * persisted on the offer and returned for the creator to review before the
 * offer advances to the next approval level.
 */
/** Shared by the server function and the agents (acting member in `actor`). */
export async function generateOfferLetterCore(
  actor: { orgId: string; userId: string; memberEmail: string },
  data: { offerId: string; templateId?: string | null | undefined },
): Promise<OfferLetterPayload> {
  const [row] = await db
    .select({
      offer: offers,
      candidate: candidates,
      requisition: requisitions,
      org: organizations,
    })
    .from(offers)
    .innerJoin(applications, eq(applications.id, offers.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, offers.orgId))
    .where(and(eq(offers.id, data.offerId), eq(offers.orgId, actor.orgId)))
    .limit(1);
  if (!row) throw new Error("Offer not found");
  if (CLOSED_OFFER_STATUSES.has(row.offer.status)) {
    throw new Error("This offer was declined or revoked — its letter can no longer be generated.");
  }

  const template = await resolveTemplate(actor.orgId, "offer_letter", data.templateId ?? null);
  if (data.templateId && !template) {
    throw new Error("That offer-letter template is no longer available — pick another.");
  }
  const headings = template?.config.sections.length
    ? template.config.sections.map((s) => s.heading)
    : DEFAULT_LETTER_SECTIONS;

  const system = template
    ? // Template chosen — the letter must read like the organisation's own
      // template: its headings, its brief (instructions), its fixed language.
      `You are an HR offer-letter writer for ${row.org.name}. Draft the offer letter so it ` +
      "reads like this organisation's own offer-letter template, using ONLY the supplied JSON " +
      "data for names, dates and figures. Return ONLY a JSON object with keys subject, greeting, " +
      "opening, sections, closing. sections is an array of {heading, body} — use EXACTLY these " +
      `headings, in this order: ${headings.join(" | ")}.\n` +
      "Follow the template's writing brief (supplied as templateInstructions) faithfully: fixed " +
      "phrases, clause lists, annexure references, acceptance lines, salary-structure notes and " +
      "the signature block it specifies belong in the letter under the matching heading, in the " +
      "template's own wording wherever the brief gives it. A section body may be several short " +
      "paragraphs or a plain-text list; separate paragraphs and list items with a single newline " +
      'character and start list lines with "- ".\n' +
      "Never invent numbers, dates, names or salary figures beyond the data and the brief; when " +
      "stating compensation use annualCtcFormatted exactly. No markdown syntax, no emojis, no " +
      "{{placeholder}} tokens — replace each placeholder with the real value or drop the sentence. " +
      "The letterhead address block, reference number, page footer and signature block are fixed " +
      "furniture rendered by the system — never write company addresses, ref numbers or a " +
      "sign-off signature block yourself. Fixed legal boilerplate is appended automatically after " +
      "your sections; do not duplicate it."
    : // Built-in fallback — keep the letter short and generic.
      `You are an HR offer-letter writer for ${row.org.name}. Write a formal, warm offer letter ` +
      "using ONLY the supplied JSON data. Return ONLY a JSON object with keys subject, greeting, " +
      "opening, sections, closing. sections is an array of {heading, body} — use EXACTLY these " +
      `headings, in this order: ${headings.join(" | ")}. Each heading's body is 1-3 plain-text ` +
      "sentences; when stating compensation use the supplied annualCtcFormatted figure exactly " +
      '(e.g. "INR 20,00,000 per annum"), never the raw annualCtcInr digits. Never invent numbers, ' +
      "dates or names beyond the data. No markdown, no emojis, no {{placeholder}} tokens. " +
      'closing is a short sign-off line such as "Sincerely," — do not repeat the organisation ' +
      "name there, the signature block already carries it. Do not add legal clauses or " +
      "boilerplate — fixed clauses are appended automatically after your sections.";

  const cfg = await resolveAiConfig(actor.orgId);
  const result = await aiJson<unknown>({
    orgId: actor.orgId,
    config: cfg,
    feature: "offer_letter",
    system,
    prompt: JSON.stringify({
      candidate: {
        name: row.candidate.fullName,
        location: row.candidate.location,
        email: row.candidate.email,
      },
      role: {
        title: row.requisition.title,
        location: row.requisition.location,
        code: row.requisition.code,
      },
      organisation: {
        name: row.org.name,
        legalName: row.org.legalName,
        city: row.org.hqCity,
      },
      compensation: {
        annualCtcInr: row.offer.offeredCtc,
        annualCtcFormatted: Number(row.offer.offeredCtc || 0).toLocaleString("en-IN"),
      },
      joiningDate: row.offer.joiningDate,
      joiningDateFormatted: fmtLetterDate(row.offer.joiningDate),
      templateInstructions: template?.instructions ?? null,
    }),
  });
  if (!result.ok) throw new Error(result.message);

  const parsed = OfferLetterBody.safeParse(result.data);
  if (!parsed.success) {
    throw new Error("The drafted letter could not be read — try generating again.");
  }
  const clean = (s: string) => stripUnreplacedPlaceholders(s).trim();
  const body: OfferLetterBody = {
    subject: clean(parsed.data.subject),
    greeting: clean(parsed.data.greeting),
    opening: clean(parsed.data.opening),
    sections: parsed.data.sections.map((s) => ({
      heading: clean(s.heading),
      body: clean(s.body),
    })),
    closing: clean(parsed.data.closing),
  };

  // Fixed furniture from the template — substituted here, never model-written.
  const tpl = template?.config;
  const year = String(new Date().getFullYear());
  const seq = row.offer.id.slice(0, 8).toUpperCase();
  const refText =
    tpl?.refFormat
      ?.replaceAll("{year}", year)
      .replaceAll("{seq}", seq)
      .replaceAll("{candidate_name}", row.candidate.fullName) ?? null;
  const salutation = tpl?.salutation?.replaceAll("{candidate_name}", row.candidate.fullName);

  const payload: OfferLetterPayload = {
    ...body,
    greeting: salutation || body.greeting,
    version: 1,
    generatedAt: new Date().toISOString(),
    templateId: template?.id ?? null,
    templateName: template?.name ?? null,
    hasLogo: Boolean(template?.logoPath),
    accentColor: tpl?.accentColor ?? "#4f46e5",
    boilerplate: tpl?.boilerplate?.trim() || null,
    headerLines: tpl?.headerLines ?? [],
    footerLines: tpl?.footerLines ?? [],
    refText,
    signatory: tpl?.signatory ?? null,
    letterhead: {
      orgName: row.org.name,
      legalName: row.org.legalName,
      hqCity: row.org.hqCity,
      careersEmail: row.org.careersEmail,
    },
    candidate: {
      fullName: row.candidate.fullName,
      email: row.candidate.email,
      phone: row.candidate.phone,
      location: row.candidate.location,
    },
    role: { title: row.requisition.title, location: row.requisition.location },
    ctc: row.offer.offeredCtc,
    joiningDate: row.offer.joiningDate,
  };

  await db
    .update(offers)
    .set({ letter: payload, letterTemplateId: template?.id ?? null })
    .where(and(eq(offers.id, data.offerId), eq(offers.orgId, actor.orgId)));

  return payload;
}

export const generateOfferLetter = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        offerId: z.string().uuid(),
        templateId: z.string().uuid().nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<OfferLetterPayload> =>
    generateOfferLetterCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      data,
    ),
  );
