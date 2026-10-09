/**
 * Phase 4 agent tools (docs/agentic-plan.md §4.8, §4.9): offer and
 * pre-onboarding. Offers start as drafts and stay within the requisition's
 * approved band; approvals, document validation and release are human gates
 * (request_approval with an offer / document_validation / offer_release
 * subject) — never tools.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { db } from "../db";
import {
  applications,
  candidateNotes,
  candidates,
  offers,
  onboardingDocuments,
  organizations,
  requisitions,
} from "@db/schema";
import { registerTool, type ToolContext } from "./registry";

const actor = async (ctx: ToolContext) => {
  const { actorFor } = await import("@/lib/requisitions.server");
  return actorFor(ctx.orgId, ctx.principalUserId);
};

const AppId = z.object({ applicationId: z.string().uuid() });

/**
 * Document types that need no request now: already received (and not
 * rejected), or asked for in an earlier request whose due date has not
 * passed. Null = every type may be requested.
 */
async function documentsNotNeeded(
  orgId: string,
  applicationId: string,
  types: string[],
): Promise<string | null> {
  const { docTypeLabel } = await import("@/lib/onboarding.server");
  const { emailOutbox } = await import("@db/schema");
  const have = await db
    .select({ docType: onboardingDocuments.docType, status: onboardingDocuments.status })
    .from(onboardingDocuments)
    .where(
      and(
        eq(onboardingDocuments.orgId, orgId),
        eq(onboardingDocuments.applicationId, applicationId),
      ),
    );
  const received = types.filter((t) =>
    have.some((d) => d.docType === t && d.status !== "rejected"),
  );
  const asked = await db
    .select({ data: emailOutbox.templateData })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.orgId, orgId),
        eq(emailOutbox.applicationId, applicationId),
        eq(emailOutbox.kind, "document_request"),
      ),
    );
  const now = Date.now();
  const pending = types.filter(
    (t) =>
      !received.includes(t) &&
      asked.some((a) => {
        const d = (a.data ?? {}) as { documents?: string; dueDate?: string };
        const due = d.dueDate ? Date.parse(d.dueDate) + 864e5 : 0;
        return due > now && (d.documents ?? "").split("\n").includes(docTypeLabel(t));
      }),
  );
  if (!received.length && !pending.length) return null;
  return [
    received.length
      ? `Already received (check them with onboarding_status, do not ask again): ${received.join(", ")}.`
      : "",
    pending.length
      ? `Already requested and not yet due — wait for the candidate, do not chase before the due date: ${pending.join(", ")}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
const OfferId = z.object({ offerId: z.string().uuid() });
const num = (v: unknown) => (v == null ? null : Number(v));
const OFFER_STAGES = new Set(["l3", "offer_pending", "on_hold"]);

async function loadApplication(orgId: string, id: string) {
  const [row] = await db
    .select({
      id: applications.id,
      stage: applications.stage,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
      candidateName: candidates.fullName,
      candidateEmail: candidates.email,
      currentCtc: candidates.currentCtc,
      expectedCtc: candidates.expectedCtc,
      noticePeriodDays: candidates.noticePeriodDays,
      jobTitle: requisitions.title,
      bandMin: requisitions.ctcBandMin,
      bandMax: requisitions.ctcBandMax,
      budget: requisitions.budgetCtc,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(and(eq(applications.id, id), eq(applications.orgId, orgId)))
    .limit(1);
  if (!row) throw new Error("Application not found.");
  return row;
}

async function offerApplication(orgId: string, offerId: string) {
  const [o] = await db
    .select({ applicationId: offers.applicationId, status: offers.status })
    .from(offers)
    .where(and(eq(offers.id, offerId), eq(offers.orgId, orgId)))
    .limit(1);
  if (!o) throw new Error("Offer not found.");
  return o;
}

export function registerPhase4Tools(): void {
  /* ------------------------------------------------------------- offer */

  registerTool({
    name: "get_offer_context",
    description:
      "Everything needed to propose an offer for one application: candidate's current and expected CTC and notice period, the requisition's approved band and budget, the recorded hiring decision, existing offers for this application (with their revision and, when the candidate asked for changes, what they asked for), and what the organisation recently offered for the same role (internal parity).",
    input: AppId,
    risk: "read",
    untrustedOutput: true,
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      const decision = await db
        .select({ body: candidateNotes.body, at: candidateNotes.createdAt })
        .from(candidateNotes)
        .where(
          and(
            eq(candidateNotes.orgId, ctx.orgId),
            eq(candidateNotes.candidateId, app.candidateId),
            sql`${candidateNotes.body} like 'Hiring decision:%'`,
          ),
        )
        .orderBy(desc(candidateNotes.createdAt))
        .limit(1);
      const existing = await db
        .select({
          offerId: offers.id,
          status: offers.status,
          offeredCtc: offers.offeredCtc,
          joiningDate: offers.joiningDate,
          revision: offers.revision,
          counter: offers.counter,
          hasLetter: sql<boolean>`${offers.letter} is not null`,
        })
        .from(offers)
        .where(and(eq(offers.orgId, ctx.orgId), eq(offers.applicationId, app.id)))
        .orderBy(desc(offers.createdAt));
      const [parity] = (await db.execute(sql`
        select count(*)::int n,
          percentile_cont(0.5) within group (order by o.offered_ctc::numeric) median,
          min(o.offered_ctc::numeric) min, max(o.offered_ctc::numeric) max
        from offers o
        join applications a on a.id = o.application_id
        join requisitions r on r.id = a.requisition_id
        where o.org_id = ${ctx.orgId} and o.status in ('approved','released','accepted')
          and lower(r.title) = lower(${app.jobTitle})
          and o.created_at >= now() - interval '12 months'`)) as unknown as Record<
        string,
        unknown
      >[];
      return {
        candidate: app.candidateName,
        job: app.jobTitle,
        stage: app.stage,
        currentCtc: num(app.currentCtc),
        expectedCtc: num(app.expectedCtc),
        noticePeriodDays: app.noticePeriodDays,
        band: { min: num(app.bandMin), max: num(app.bandMax), budget: num(app.budget) },
        hiringDecision: decision[0]?.body ?? null,
        existingOffers: existing.map((o) => ({ ...o, offeredCtc: num(o.offeredCtc) })),
        internalParity: {
          offers12m: Number(parity?.["n"] ?? 0),
          median: num(parity?.["median"]),
          min: num(parity?.["min"]),
          max: num(parity?.["max"]),
        },
      };
    },
  });

  registerTool({
    name: "draft_offer",
    description:
      "Create a DRAFT offer for a selected candidate. The CTC must sit inside the requisition's approved band; if it cannot, ask a person instead. The person the agent works for must be on the recruiting team.",
    input: AppId.extend({
      offeredCtc: z.number().positive(),
      joiningDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    risk: "write",
    describe: (i) => `Draft an offer at ${i.offeredCtc.toLocaleString()} CTC`,
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      if (!OFFER_STAGES.has(app.stage)) {
        throw new Error(
          `Offers are drafted after the final round; this candidate is ${app.stage}.`,
        );
      }
      const min = num(app.bandMin);
      const max = num(app.bandMax);
      if (min != null && max != null && (i.offeredCtc < min || i.offeredCtc > max)) {
        throw new Error(
          `${i.offeredCtc.toLocaleString()} is outside the approved band ${min.toLocaleString()}–${max.toLocaleString()}. Ask a person (ask_human) before going outside the band.`,
        );
      }
      const open = await db
        .select({ id: offers.id })
        .from(offers)
        .where(
          and(
            eq(offers.orgId, ctx.orgId),
            eq(offers.applicationId, app.id),
            inArray(offers.status, [
              "draft",
              "pending_hr",
              "pending_cbo",
              "approved",
              "released",
              "countered",
            ]),
          ),
        )
        .limit(1);
      if (open.length) throw new Error("This application already has an active offer.");
      const { createOfferCore } = await import("@/lib/offers.functions");
      const r = await createOfferCore(
        await actor(ctx),
        {
          applicationId: app.id,
          offeredCtc: String(i.offeredCtc),
          joiningDate: i.joiningDate ?? null,
        },
        "draft",
      );
      return { offerId: r.id, status: "draft" };
    },
  });

  registerTool({
    name: "revise_offer",
    description:
      "Revise an offer the candidate asked to change (status countered): set the new CTC (inside the requisition's approved band — if the ask is above it, offer the band maximum or ask a person) and joining date, with the reasoning. The offer goes back to draft as the next revision; then generate_offer_letter and submit_offer_for_approval so it is approved again before release.",
    input: OfferId.extend({
      offeredCtc: z.number().positive(),
      joiningDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      rationale: z.string().min(10).max(1500),
    }),
    risk: "write",
    describe: (i) => `Revise the offer to ${i.offeredCtc.toLocaleString()} CTC`,
    run: async (ctx, i) => {
      const o = await offerApplication(ctx.orgId, i.offerId);
      if (o.status !== "countered")
        throw new Error(
          `Only an offer the candidate asked to change can be revised; this one is ${o.status}.`,
        );
      const app = await loadApplication(ctx.orgId, o.applicationId);
      const min = num(app.bandMin);
      const max = num(app.bandMax);
      if (min != null && max != null && (i.offeredCtc < min || i.offeredCtc > max)) {
        throw new Error(
          `${i.offeredCtc.toLocaleString()} is outside the approved band ${min.toLocaleString()}–${max.toLocaleString()}. Offer within the band, or ask a person (ask_human) before going outside it.`,
        );
      }
      const { reviseOfferCore } = await import("@/lib/offers.functions");
      const r = await reviseOfferCore(await actor(ctx), {
        offerId: i.offerId,
        offeredCtc: i.offeredCtc,
        joiningDate: i.joiningDate ?? null,
        rationale: i.rationale,
      });
      return { offerId: i.offerId, status: "draft", revision: r.revision };
    },
  });

  registerTool({
    name: "generate_offer_letter",
    description:
      "Generate the offer letter for a draft offer from the organisation's offer-letter template and save it on the offer.",
    input: OfferId.extend({ templateId: z.string().uuid().optional() }),
    risk: "write",
    skills: ["offer_letter"],
    describe: () => "Generate the offer letter",
    run: async (ctx, i) => {
      const o = await offerApplication(ctx.orgId, i.offerId);
      if (o.status !== "draft")
        throw new Error(`Letters are generated on draft offers; this one is ${o.status}.`);
      const { generateOfferLetterCore } = await import("@/lib/offers.functions");
      const letter = await generateOfferLetterCore(await actor(ctx), {
        offerId: i.offerId,
        templateId: i.templateId ?? null,
      });
      return { subject: letter.subject, sections: letter.sections.map((s) => s.heading) };
    },
  });

  registerTool({
    name: "submit_offer_for_approval",
    description: "Send a draft offer with its letter into the approval chain (HR head → CBO).",
    input: OfferId,
    risk: "write",
    describe: () => "Submit the offer for HR head approval",
    run: async (ctx, i) => {
      const { advanceOfferCore } = await import("@/lib/offers.functions");
      await advanceOfferCore(await actor(ctx), { id: i.offerId, status: "pending_hr" });
      return { ok: true, status: "pending_hr" };
    },
  });

  /* ---------------------------------------------------- pre-onboarding */

  registerTool({
    name: "onboarding_status",
    description:
      "Pre-onboarding readiness for one application: its current offer (offerId, status, revision), which required documents are missing, and every document received with its type, status and what was extracted from it.",
    input: AppId,
    risk: "read",
    untrustedOutput: true,
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      const { readinessFor, docTypeLabel } = await import("@/lib/onboarding.server");
      const readiness = await readinessFor(ctx.orgId, app.id);
      const docs = await db
        .select({
          documentId: onboardingDocuments.id,
          docType: onboardingDocuments.docType,
          fileName: onboardingDocuments.fileName,
          status: onboardingDocuments.status,
          extractionStatus: onboardingDocuments.extractionStatus,
          extracted: onboardingDocuments.extracted,
          reviewNote: onboardingDocuments.reviewNote,
        })
        .from(onboardingDocuments)
        .where(
          and(
            eq(onboardingDocuments.orgId, ctx.orgId),
            eq(onboardingDocuments.applicationId, app.id),
          ),
        )
        .orderBy(desc(onboardingDocuments.createdAt));
      // The offer these documents are for (its id is what a release request names).
      const [offer] = await db
        .select({ offerId: offers.id, status: offers.status, revision: offers.revision })
        .from(offers)
        .where(and(eq(offers.orgId, ctx.orgId), eq(offers.applicationId, app.id)))
        .orderBy(desc(offers.createdAt))
        .limit(1);
      return {
        candidate: app.candidateName,
        offer: offer ?? null,
        ready: readiness.ready,
        missingRequired: readiness.missing.map((m) => ({ type: m, label: docTypeLabel(m) })),
        documents: docs.map((d) => ({
          ...d,
          type: docTypeLabel(d.docType),
          extracted: JSON.stringify(d.extracted ?? {}).slice(0, 800),
        })),
      };
    },
  });

  registerTool({
    name: "compensation_cross_check",
    description:
      "Cross-check the candidate's last drawn pay from their documents against the offer: evidence timeline, conflicts, gaps and the resulting hike.",
    input: AppId,
    risk: "read",
    untrustedOutput: true,
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      const { compensationReading } = await import("@/lib/onboarding.server");
      const r = await compensationReading(ctx.orgId, app.id);
      return { ...r, timeline: r.timeline.slice(0, 12) };
    },
  });

  registerTool({
    name: "request_documents",
    description:
      "Email the candidate the list of pre-onboarding documents still needed, asking them to reply with the files (they are filed automatically). Leaves the organisation, so a person approves it unless the document request email is pre-approved.",
    input: AppId.extend({
      documentTypes: z.array(z.string().min(2).max(60)).min(1).max(12),
      dueInDays: z.number().int().min(1).max(21).default(5),
    }),
    risk: "external",
    templateOf: () => "document_request",
    describe: (i) => `Email the candidate for ${i.documentTypes.length} document(s)`,
    precheck: (ctx, i) => documentsNotNeeded(ctx.orgId, i.applicationId, i.documentTypes),
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      if (!app.candidateEmail) throw new Error("The candidate has no email address.");
      // Re-checked at send time: documents may have arrived while it waited.
      const stale = await documentsNotNeeded(ctx.orgId, i.applicationId, i.documentTypes);
      if (stale) throw new Error(stale);
      const { DOC_TYPE_KEYS, docTypeLabel } = await import("@/lib/onboarding.server");
      const unknown = i.documentTypes.filter((t) => !DOC_TYPE_KEYS.includes(t));
      if (unknown.length)
        throw new Error(
          `Unknown document types: ${unknown.join(", ")}. Use onboarding_status types.`,
        );
      const [org] = await db
        .select({ name: organizations.name, careersEmail: organizations.careersEmail })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      const due = new Date(Date.now() + i.dueInDays * 864e5);
      const { enqueueEmail } = await import("@/lib/email-outbox.server");
      await enqueueEmail({
        orgId: ctx.orgId,
        kind: "document_request",
        templateName: "document_request",
        toEmail: app.candidateEmail,
        applicationId: app.id,
        idempotencyKey: `docs:${app.id}:${[...i.documentTypes].sort().join(",")}:${new Date().toISOString().slice(0, 10)}`,
        templateData: {
          candidateName: app.candidateName ?? undefined,
          orgName: org?.name,
          jobTitle: app.jobTitle,
          documents: i.documentTypes.map(docTypeLabel).join("\n"),
          replyTo: org?.careersEmail ?? undefined,
          dueDate: due.toDateString(),
        },
      });
      return { requested: i.documentTypes.length, due: due.toISOString().slice(0, 10) };
    },
  });
}
