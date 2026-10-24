/**
 * Phase 4 agent tools (docs/agentic-plan.md §4.8, §4.9): offer and
 * pre-onboarding. Offers start as drafts and stay within the requisition's
 * approved band; approvals, document validation and release are human gates
 * (request_approval with an offer / document_validation / offer_release
 * subject) — never tools.
 */
import { rupees } from "@/lib/money";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

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
  // Every copy HR rejected: a new request (with the reason) is due now.
  const rejected = types.filter((t) => have.some((d) => d.docType === t) && !received.includes(t));
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
      !rejected.includes(t) &&
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

/**
 * A person with one of `roles` answered this run's question (ask_human
 * addressed to that role). The task system checks the answerer holds it.
 */
async function answeredInRun(runId: string, roles: string[]): Promise<boolean> {
  const { agentTasks } = await import("@db/schema");
  const [t] = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.runId, runId),
        eq(agentTasks.kind, "clarification"),
        eq(agentTasks.status, "answered"),
        inArray(agentTasks.assigneeRole, roles as never[]),
      ),
    )
    .limit(1);
  return !!t;
}

const pct = (a: number, b: number) => Math.round(((a - b) / b) * 100);

/**
 * Before an offer is drafted or revised: the candidate's expected CTC and
 * notice period must be known, and an expectation above the band needs the
 * HR head's (or CBO's) answer in this run. Null = go ahead.
 */
export async function offerReadiness(
  ctx: Pick<ToolContext, "orgId" | "runId">,
  applicationId: string,
): Promise<string | null> {
  const { detailsFor, latestRequest } = await import("@/lib/compensation.server");
  const app = await loadApplication(ctx.orgId, applicationId);
  const pay = await detailsFor(ctx.orgId, applicationId);
  if (!pay.complete) {
    const missing = [
      pay.expectedCtc == null ? "expected CTC" : null,
      pay.noticePeriodDays == null ? "notice period" : null,
    ].filter(Boolean);
    const r = await latestRequest(ctx.orgId, applicationId);
    const waiting = r?.status === "sent" && (r.closesAt?.getTime() ?? Infinity) > Date.now();
    return waiting
      ? `The candidate's ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not known yet. The pay & availability form was already sent and is open — do not draft and do not send it again. Finish: you will be started again when the candidate answers (or TA enters it from a call).`
      : `The candidate's ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not known, so no offer can be drafted yet. send_compensation_form to the candidate, then finish: you will be started again when they answer (or TA enters it from a call).`;
  }
  const neg = await import("@/lib/negotiation.server");
  const latest = await neg.latestNegotiation(ctx.orgId, applicationId);
  if (latest && neg.OPEN_NEGOTIATION.includes(latest.status))
    return "A pay discussion with the candidate is in progress (the HR head approves the message; TA may call). Do not draft — finish; you will be started again when a figure is agreed.";
  // A figure agreed with the candidate settles the expectation.
  if (await neg.agreedTerms(ctx.orgId, applicationId)) return null;
  const max = num(app.bandMax);
  if (
    max != null &&
    pay.expectedCtc! > max &&
    !(await answeredInRun(ctx.runId, ["hr_head", "president_cbo"]))
  ) {
    return `The candidate expects ${rupees(pay.expectedCtc)}, ${rupees(pay.expectedCtc! - max)} (${pct(pay.expectedCtc!, max)}%) above the band maximum ${rupees(max)}. Before drafting, ask_human with assignee_role hr_head: offer at the band maximum, seek a CBO exception above the band, or stop. Draft only after they answer, and follow their answer.`;
  }
  return null;
}

/** What the application's latest offer still lacks (expected CTC, notice, joining date). */
async function termsMissingFor(orgId: string, applicationId: string): Promise<string[]> {
  const [o] = await db
    .select({ joiningDate: offers.joiningDate })
    .from(offers)
    .where(and(eq(offers.orgId, orgId), eq(offers.applicationId, applicationId)))
    .orderBy(desc(offers.createdAt))
    .limit(1);
  if (!o) return ["an offer for this candidate"];
  const { offerTermsMissing } = await import("@/lib/compensation.server");
  return offerTermsMissing(orgId, applicationId, o.joiningDate ? String(o.joiningDate) : null);
}

export function registerPhase4Tools(): void {
  /* ------------------------------------------------------------- offer */

  registerTool({
    name: "get_offer_context",
    description:
      "Everything needed to propose an offer for one application: candidate's current and expected CTC and notice period (compensation: fixed / variable split, earliest joining, competing offers, location and where it came from — the candidate's form, a screening call or TA; complete = expected CTC and notice are known; form = the pay & availability form's status), the requisition's approved band and budget, the recorded hiring decision, existing offers for this application (with their revision and, when the candidate asked for changes, what they asked for), and what the organisation recently offered for the same role (internal parity).",
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
          approvalTrail: offers.approvalTrail,
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
        compensation: await (async () => {
          const { detailsFor, latestRequest } = await import("@/lib/compensation.server");
          const d = await detailsFor(ctx.orgId, app.id);
          const r = await latestRequest(ctx.orgId, app.id);
          return {
            ...d,
            form: r ? { status: r.status, sentAt: r.createdAt, dueAt: r.dueAt } : null,
          };
        })(),
        negotiation: await (async () => {
          const { latestNegotiation } = await import("@/lib/negotiation.server");
          const n = await latestNegotiation(ctx.orgId, app.id);
          return n
            ? {
                negotiationId: n.id,
                status: n.status,
                ceiling: num(n.ceiling),
                ceilingApprovedBy: n.ceilingApprovedBy,
                proposedCtc: num(n.proposedCtc),
                levers: n.levers,
                answer: n.answer,
                outcome: n.outcome,
              }
            : null;
        })(),
        hiringDecision: decision[0]?.body ?? null,
        existingOffers: existing.map(({ approvalTrail, ...o }) => {
          // An approver who sent it back: their step and reason.
          const last = (Array.isArray(approvalTrail) ? approvalTrail : []).at(-1) as
            { decision?: string; from?: string; comment?: string; actor?: string } | undefined;
          return {
            ...o,
            offeredCtc: num(o.offeredCtc),
            sentBack:
              o.status === "draft" && last?.decision === "sent_back"
                ? { atStep: last.from ?? null, reason: last.comment ?? null }
                : null,
          };
        }),
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
    name: "send_compensation_form",
    description:
      "Email the candidate a private pay & availability form: current pay (fixed / variable), expected CTC, notice period, earliest joining date, competing offers, location and relocation. Only TA and HR see the answers. Due date, reminders and closing follow the organisation's assessment policy; reminders are automatic. Refused when the details are already known or a form is already open. Leaves the organisation, so a person approves it unless the form is pre-approved.",
    input: AppId,
    risk: "external",
    templateOf: () => "compensation_form",
    describe: () => "Send the pay & availability form to the candidate",
    precheck: async (ctx, i) => {
      const { detailsFor, latestRequest } = await import("@/lib/compensation.server");
      const d = await detailsFor(ctx.orgId, i.applicationId);
      if (d.complete)
        return "The candidate's expected CTC and notice period are already known — do not ask again.";
      const r = await latestRequest(ctx.orgId, i.applicationId);
      if (r?.status === "sent" && (r.closesAt?.getTime() ?? Infinity) > Date.now())
        return "The form was already sent and is still open; reminders are automatic — wait for the candidate.";
      return null;
    },
    run: async (ctx, i) => {
      const { requestCompensation } = await import("@/lib/compensation.server");
      const r = await requestCompensation(ctx.orgId, i.applicationId, {
        userId: ctx.principalUserId,
        memberEmail: null,
        label: ctx.actor,
      });
      return { emailed: r.emailed, alreadyOpen: r.alreadyOpen, due: r.due };
    },
  });

  registerTool({
    name: "propose_negotiation",
    description:
      "When the candidate's expected CTC is above what the HR head will pay: prepare a pay discussion — the approved ceiling, the figure you propose (at or under it), levers that cost less than base pay (joiningBonus in rupees, reviewMonths for an early pay review, other: fixed / variable split, ESOPs, title or scope), a talkTrack for a recruiter's call (her numbers, the gap, what to offer first, the walk-away), and a warm, personal message to the candidate (plain text, no amounts beyond the proposal and levers, no pressure). The ceiling must come from the HR head's answer in this run; above the band also from the CBO's. Contacts nobody: then send_negotiation_message.",
    input: z.object({
      applicationId: z.string().uuid(),
      ceiling: z.number().positive(),
      proposedCtc: z.number().positive(),
      levers: z
        .object({
          joiningBonus: z.number().min(0).nullable().optional(),
          reviewMonths: z.number().int().min(3).max(24).nullable().optional(),
          other: z.string().max(500).nullable().optional(),
        })
        .default({}),
      talkTrack: z.string().min(40).max(3000),
      message: z.string().min(80).max(3000),
    }),
    risk: "write",
    describe: (i) =>
      `Prepare a pay discussion: propose ${rupees(i.proposedCtc)} (ceiling ${rupees(i.ceiling)})`,
    run: async (ctx, i) => {
      const { prepareNegotiation } = await import("@/lib/negotiation.server");
      return prepareNegotiation(ctx, i);
    },
  });

  registerTool({
    name: "send_negotiation_message",
    description:
      "Email the candidate the prepared pay message with a private link to accept, suggest another figure or ask for a call. Always approved by the HR head first — who may edit the words — whatever the agent's autonomy; it is then sent as them.",
    input: z.object({ negotiationId: z.string().uuid(), message: z.string().min(80).max(3000) }),
    risk: "external",
    // No template: a pay message is never pre-approved, so a person always approves it.
    templateOf: () => null,
    approverRole: "hr_head",
    describe: () => "Send the pay message to the candidate",
    precheck: async (ctx, i) => {
      const { offerNegotiations } = await import("@db/schema");
      const [n] = await db
        .select({ status: offerNegotiations.status })
        .from(offerNegotiations)
        .where(
          and(eq(offerNegotiations.id, i.negotiationId), eq(offerNegotiations.orgId, ctx.orgId)),
        )
        .limit(1);
      if (!n) return "That pay discussion does not exist — propose_negotiation first.";
      return n.status === "open"
        ? null
        : `This pay discussion is ${n.status.replace(/_/g, " ")} — nothing to send.`;
    },
    run: async (ctx, i) => {
      const { sendNegotiationMessage } = await import("@/lib/negotiation.server");
      return sendNegotiationMessage(ctx.orgId, i.negotiationId, i.message, {
        userId: ctx.principalUserId,
        actor: ctx.actor,
      });
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
    describe: (i) => `Draft an offer at ${rupees(i.offeredCtc)} CTC`,
    precheck: (ctx, i) => offerReadiness(ctx, i.applicationId),
    run: async (ctx, i) => {
      const app = await loadApplication(ctx.orgId, i.applicationId);
      // After the role's final round — which is L1 or L2 when its plan has fewer rounds.
      const finalDone =
        /^l[123]$/.test(app.stage) &&
        (await (await import("@/lib/interview-plan.server")).progressOf(ctx.orgId, app.id))
          .finalComplete;
      if (!OFFER_STAGES.has(app.stage) && !finalDone) {
        throw new Error(
          `Offers are drafted after the final round; this candidate is ${app.stage}.`,
        );
      }
      const min = num(app.bandMin);
      const max = num(app.bandMax);
      // Above the band only with the CBO's answer in this run (an exception the
      // HR head asked for); never below it.
      const agreed = await (
        await import("@/lib/negotiation.server")
      ).agreedTerms(ctx.orgId, app.id);
      if (agreed && i.offeredCtc > agreed.ceiling)
        throw new Error(
          `${rupees(i.offeredCtc)} is above the ceiling ${rupees(agreed.ceiling)} agreed for this candidate. Draft at the agreed ${rupees(agreed.agreedCtc)}.`,
        );
      const cboException =
        max != null &&
        i.offeredCtc > max &&
        ((agreed?.cboApproved ?? false) || (await answeredInRun(ctx.runId, ["president_cbo"])));
      if (
        min != null &&
        max != null &&
        (i.offeredCtc < min || i.offeredCtc > max) &&
        !cboException
      ) {
        throw new Error(
          `${rupees(i.offeredCtc)} is outside the approved band ${rupees(min)}–${rupees(max)}. Ask a person (ask_human) before going outside the band; above it needs the CBO's answer (assignee_role president_cbo).`,
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
      "Revise an offer the candidate asked to change (status countered) or an approver sent back (draft with sentBack): set the new CTC (inside the requisition's approved band — if the ask is above it, offer the band maximum or ask a person) and joining date, with the reasoning. The offer goes back to draft as the next revision; then generate_offer_letter and submit_offer_for_approval so it is approved again before release.",
    input: OfferId.extend({
      offeredCtc: z.number().positive(),
      joiningDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      rationale: z.string().min(10).max(1500),
    }),
    risk: "write",
    describe: (i) => `Revise the offer to ${rupees(i.offeredCtc)} CTC`,
    // An offer sent back is revised only once the candidate's expectation is
    // known (a countered offer carries the candidate's own ask).
    precheck: async (ctx, i) => {
      const o = await offerApplication(ctx.orgId, i.offerId);
      return o.status === "draft" ? offerReadiness(ctx, o.applicationId) : null;
    },
    run: async (ctx, i) => {
      const o = await offerApplication(ctx.orgId, i.offerId);
      if (o.status !== "countered" && o.status !== "draft")
        throw new Error(
          `Only an offer the candidate asked to change, or one an approver sent back, can be revised; this one is ${o.status}.`,
        );
      const app = await loadApplication(ctx.orgId, o.applicationId);
      const min = num(app.bandMin);
      const max = num(app.bandMax);
      if (min != null && max != null && (i.offeredCtc < min || i.offeredCtc > max)) {
        throw new Error(
          `${rupees(i.offeredCtc)} is outside the approved band ${rupees(min)}–${rupees(max)}. Offer within the band, or ask a person (ask_human) before going outside it.`,
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
      "Pre-onboarding readiness for one application: its current offer (offerId, status, revision), whether the offer's terms are settled (termsMissing: the candidate's expected CTC, notice period or the offer's joining date — documents are not requested until it is empty), which required documents are missing, and every document received with its type, status and what was extracted from it.",
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
        termsMissing: await termsMissingFor(ctx.orgId, app.id),
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
      "Email the candidate the list of pre-onboarding documents still needed (with `note` saying why an earlier copy was not accepted, when HR rejected one), asking them to reply with the files (they are filed automatically). Leaves the organisation, so a person approves it unless the document request email is pre-approved.",
    input: AppId.extend({
      documentTypes: z.array(z.string().min(2).max(60)).min(1).max(12),
      dueInDays: z.number().int().min(1).max(21).default(5),
      /** Why an earlier copy was not accepted (HR's reason, in plain words). */
      note: z.string().max(600).optional(),
    }),
    risk: "external",
    templateOf: () => "document_request",
    describe: (i) => `Email the candidate for ${i.documentTypes.length} document(s)`,
    precheck: async (ctx, i) => {
      // Documents (payslips included) follow agreed terms, never precede them.
      const missing = await termsMissingFor(ctx.orgId, i.applicationId);
      if (missing.length) {
        const { listWords } = await import("@/lib/compensation.server");
        return `The offer's terms are not settled — ${listWords(missing)} ${missing.length > 1 ? "are" : "is"} missing. Do not request documents. Finish and say an HR head should send the offer back so the Offer agent collects them.`;
      }
      return documentsNotNeeded(ctx.orgId, i.applicationId, i.documentTypes);
    },
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
          ...(i.note ? { note: i.note } : {}),
        },
      });
      return { requested: i.documentTypes.length, due: due.toISOString().slice(0, 10) };
    },
  });
}
