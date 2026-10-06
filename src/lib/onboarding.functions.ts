/**
 * Pre-onboarding document workflow, org-scoped.
 *
 * TA/HR collect the candidate's proof documents here, the extraction agent
 * reads each one, and a recruiter or HR head validates the reading against the
 * stored file. An approved offer cannot be released until every required
 * document is verified (enforced in offers.functions.ts).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { applications, candidates, offers, onboardingDocuments, requisitions } from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";
import { writeAudit } from "../server/audit";
import {
  compensationReading,
  DOC_TYPES,
  DOC_TYPE_KEYS,
  docTypeLabel,
  extractDocument,
  readOnboardingFile,
  readinessFor,
  expandUpload,
  guessDocType,
  storeOnboardingDocument,
  type CompensationReading,
  type ExtractedDoc,
  type Readiness,
} from "./onboarding.server";

/** 40 MB decoded — a zipped set of proofs is bigger than a single letter. */
const MAX_ARCHIVE_BYTES = 40_000_000;

/** 15 MB decoded — a scanned experience letter is comfortably inside this. */
const MAX_UPLOAD_BYTES = 15_000_000;

export type OnboardingDocWire = {
  id: string;
  application_id: string;
  candidate_id: string;
  offer_id: string | null;
  doc_type: string;
  doc_type_label: string;
  file_name: string;
  file_bytes: number | null;
  content_type: string | null;
  source: string;
  extraction_status: string;
  extraction_note: string | null;
  extracted: ExtractedDoc | null;
  extracted_text: string | null;
  status: string;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
};

/** The document catalogue the UI renders — labels, hints and what is mandatory. */
export const listDocTypes = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async () => DOC_TYPES);

function toWire(row: typeof onboardingDocuments.$inferSelect): OnboardingDocWire {
  return {
    id: row.id,
    application_id: row.applicationId,
    candidate_id: row.candidateId,
    offer_id: row.offerId,
    doc_type: row.docType,
    doc_type_label: docTypeLabel(row.docType),
    file_name: row.fileName,
    file_bytes: row.fileBytes,
    content_type: row.contentType,
    source: row.source,
    extraction_status: row.extractionStatus,
    extraction_note: row.extractionNote,
    extracted: (row.extracted ?? null) as ExtractedDoc | null,
    extracted_text: row.extractedText ? row.extractedText.slice(0, 6000) : null,
    status: row.status,
    review_note: row.reviewNote,
    reviewed_at: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

function base64ToBytes(data: string): Uint8Array {
  const b64 = data
    .replace(/^data:[^;]+;base64,/, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Every document filed against one application, newest first, with readiness. */
export const listOnboardingDocs = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => z.object({ applicationId: z.string().uuid() }).parse(data))
  .handler(
    async ({ data, context }): Promise<{ docs: OnboardingDocWire[]; readiness: Readiness }> => {
      const rows = await db
        .select()
        .from(onboardingDocuments)
        .where(
          and(
            eq(onboardingDocuments.orgId, context.orgId),
            eq(onboardingDocuments.applicationId, data.applicationId),
          ),
        )
        .orderBy(desc(onboardingDocuments.createdAt));
      return {
        docs: rows.map(toWire),
        readiness: await readinessFor(context.orgId, data.applicationId),
      };
    },
  );

/** Pre-onboarding progress for every live offer, for the offers register. */
export const listOnboardingReadiness = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<Readiness[]> => {
    const live = await db
      .select({ applicationId: offers.applicationId })
      .from(offers)
      .where(eq(offers.orgId, context.orgId));
    const ids = [...new Set(live.map((o) => o.applicationId))];
    if (!ids.length) return [];
    const rows = await db
      .select({
        applicationId: onboardingDocuments.applicationId,
        docType: onboardingDocuments.docType,
        status: onboardingDocuments.status,
      })
      .from(onboardingDocuments)
      .where(
        and(
          eq(onboardingDocuments.orgId, context.orgId),
          inArray(onboardingDocuments.applicationId, ids),
        ),
      );
    const { REQUIRED_DOC_TYPES } = await import("./onboarding.server");
    return ids.map((applicationId) => {
      const mine = rows.filter((r) => r.applicationId === applicationId);
      const verifiedTypes = new Set(
        mine.filter((r) => r.status === "verified").map((r) => r.docType),
      );
      const missing = REQUIRED_DOC_TYPES.filter((t) => !verifiedTypes.has(t));
      return {
        applicationId,
        total: mine.length,
        verified: mine.filter((r) => r.status === "verified").length,
        pending: mine.filter((r) => r.status === "pending").length,
        rejected: mine.filter((r) => r.status === "rejected").length,
        missing,
        ready: missing.length === 0,
      };
    });
  });

/** Upload one document and read it with the organisation's own AI key. */
export const uploadOnboardingDoc = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        applicationId: z.string().uuid(),
        docType: z.enum(DOC_TYPE_KEYS),
        fileName: z.string().min(1).max(300),
        base64: z
          .string()
          .min(16)
          .refine((v) => v.length * 0.75 <= MAX_ARCHIVE_BYTES, "File too large"),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const [app] = await db
      .select({ id: applications.id, candidateId: applications.candidateId })
      .from(applications)
      .where(and(eq(applications.id, data.applicationId), eq(applications.orgId, context.orgId)))
      .limit(1);
    if (!app) throw new Error("Application not found");

    const [offer] = await db
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.orgId, context.orgId), eq(offers.applicationId, app.id)))
      .orderBy(desc(offers.createdAt))
      .limit(1);

    const bytes = base64ToBytes(data.base64);
    const isArchive = /\.zip$/i.test(data.fileName);
    const limit = isArchive ? MAX_ARCHIVE_BYTES : MAX_UPLOAD_BYTES;
    if (bytes.byteLength > limit)
      throw new Error(`That file is too large (${Math.round(limit / 1_000_000)} MB maximum).`);

    // A ZIP of proofs becomes one row per document inside it, each typed on its
    // own so HR validates documents, not an archive.
    const members = await expandUpload(data.fileName, bytes);
    const results: Awaited<ReturnType<typeof storeOnboardingDocument>>[] = [];
    for (const member of members) {
      if (member.bytes.byteLength > MAX_UPLOAD_BYTES) continue;
      const docType =
        members.length === 1 ? data.docType : guessDocType(member.fileName) || data.docType;
      const filed = await storeOnboardingDocument({
        orgId: context.orgId,
        applicationId: app.id,
        candidateId: app.candidateId,
        offerId: offer?.id ?? null,
        docType,
        fileName: member.fileName,
        bytes: member.bytes,
        source: "upload",
        uploadedBy: context.userId,
      });
      results.push(filed);
      await writeAudit({
        actor: context.memberEmail,
        actorUserId: context.userId,
        orgId: context.orgId,
        action: "onboarding_document_uploaded",
        entityType: "onboarding_document",
        entityId: filed.id,
        detail: {
          docType,
          applicationId: app.id,
          extraction: filed.extractionStatus,
          ...(members.length > 1 ? { archive: data.fileName, filed: members.length } : {}),
        },
      });
    }
    const first = results[0];
    if (!first) throw new Error("Nothing readable was found in that file.");
    return { ...first, filed: results.length };
  });

/** Re-run the extraction agent on a stored document (after a clearer copy, or a key change). */
export const reextractOnboardingDoc = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select()
      .from(onboardingDocuments)
      .where(and(eq(onboardingDocuments.id, data.id), eq(onboardingDocuments.orgId, context.orgId)))
      .limit(1);
    if (!row) throw new Error("That document is no longer here.");
    const file = await readOnboardingFile(context.orgId, row.filePath);
    if (!file) throw new Error("The stored file could not be opened.");

    const read = await extractDocument({
      orgId: context.orgId,
      docType: row.docType,
      fileName: row.fileName,
      bytes: file.bytes,
    });
    await db
      .update(onboardingDocuments)
      .set({
        extracted: (read.extracted ?? null) as never,
        extractedText: read.text ? read.text.slice(0, 20_000) : null,
        extractionStatus: read.status,
        extractionNote: read.note,
        model: read.model,
        // A fresh reading must be validated again.
        status: "pending",
        reviewNote: null,
        reviewedBy: null,
        reviewedAt: null,
      })
      .where(and(eq(onboardingDocuments.id, row.id), eq(onboardingDocuments.orgId, context.orgId)));
    return { status: read.status, note: read.note };
  });

/**
 * HR/TA validation decision. Recruiters and HR heads may validate (owners pass);
 * the decision, the reviewer and the note are recorded and audited.
 */
/** Shared by the server function and the agents (acting member in `actor`). */
export async function reviewOnboardingDocCore(
  actor: { orgId: string; userId: string; memberEmail: string },
  data: {
    id: string;
    decision: "verified" | "rejected" | "pending";
    note?: string | null | undefined;
  },
) {
  await assertRole(
    actor.userId,
    actor.orgId,
    ["recruiter", "hr_head"],
    "Only TA or HR can validate pre-onboarding documents.",
  );
  const [row] = await db
    .select({ id: onboardingDocuments.id, docType: onboardingDocuments.docType })
    .from(onboardingDocuments)
    .where(and(eq(onboardingDocuments.id, data.id), eq(onboardingDocuments.orgId, actor.orgId)))
    .limit(1);
  if (!row) throw new Error("That document is no longer here.");
  if (data.decision === "rejected" && !(data.note ?? "").trim()) {
    throw new Error(
      "Say why the document is rejected — the candidate has to be told what to resend.",
    );
  }

  await db
    .update(onboardingDocuments)
    .set({
      status: data.decision,
      reviewNote: data.note?.trim() || null,
      reviewedBy: data.decision === "pending" ? null : actor.userId,
      reviewedAt: data.decision === "pending" ? null : new Date(),
    })
    .where(and(eq(onboardingDocuments.id, row.id), eq(onboardingDocuments.orgId, actor.orgId)));

  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: `onboarding_document_${data.decision}`,
    entityType: "onboarding_document",
    entityId: row.id,
    detail: { docType: row.docType, note: data.note?.trim() || null },
  });
  return { ok: true as const };
}

export const reviewOnboardingDoc = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        decision: z.enum(["verified", "rejected", "pending"]),
        note: z.string().trim().max(600).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) =>
    reviewOnboardingDocCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      data,
    ),
  );

/** Delete a wrongly filed document and its stored file. */
export const deleteOnboardingDoc = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      ["recruiter", "hr_head"],
      "Only TA or HR can remove pre-onboarding documents.",
    );
    const [row] = await db
      .select({ id: onboardingDocuments.id, filePath: onboardingDocuments.filePath })
      .from(onboardingDocuments)
      .where(and(eq(onboardingDocuments.id, data.id), eq(onboardingDocuments.orgId, context.orgId)))
      .limit(1);
    if (!row) return { ok: true as const };
    await db
      .delete(onboardingDocuments)
      .where(and(eq(onboardingDocuments.id, row.id), eq(onboardingDocuments.orgId, context.orgId)));
    if (row.filePath?.startsWith(`${context.orgId}/`)) {
      const { deleteObject } = await import("../server/storage");
      try {
        await deleteObject(row.filePath);
      } catch {
        /* the row is gone; an orphaned object is not worth failing the action */
      }
    }
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "onboarding_document_deleted",
      entityType: "onboarding_document",
      entityId: row.id,
    });
    return { ok: true as const };
  });

/**
 * The stored document itself, delivered through ATSIQ so HR reads the original
 * page beside the agent's reading. Private storage is never exposed directly.
 */
export const getOnboardingDocFile = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({
        fileName: onboardingDocuments.fileName,
        filePath: onboardingDocuments.filePath,
        contentType: onboardingDocuments.contentType,
      })
      .from(onboardingDocuments)
      .where(and(eq(onboardingDocuments.id, data.id), eq(onboardingDocuments.orgId, context.orgId)))
      .limit(1);
    if (!row) return { ok: false as const, error: "That document is no longer here." };
    const file = await readOnboardingFile(context.orgId, row.filePath);
    if (!file) return { ok: false as const, error: "The stored file could not be opened." };
    if (file.bytes.byteLength > 20 * 1024 * 1024) {
      return { ok: false as const, error: "That file is too large to open through ATSIQ." };
    }
    return {
      ok: true as const,
      base64: Buffer.from(file.bytes).toString("base64"),
      contentType: row.contentType || file.contentType || "application/octet-stream",
      filename: row.fileName,
    };
  });

/** Candidates with a live offer, for the pre-onboarding worklist. */
export const listPreOnboardingQueue = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const rows = await db
      .select({
        applicationId: applications.id,
        offerId: offers.id,
        offerStatus: offers.status,
        offeredCtc: offers.offeredCtc,
        joiningDate: offers.joiningDate,
        candidateId: candidates.id,
        candidateName: candidates.fullName,
        candidateEmail: candidates.email,
        roleTitle: requisitions.title,
      })
      .from(offers)
      .innerJoin(applications, eq(applications.id, offers.applicationId))
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
      .where(eq(offers.orgId, context.orgId))
      .orderBy(desc(offers.createdAt));
    return rows.map((r) => ({
      ...r,
      offeredCtc: String(r.offeredCtc ?? "0"),
      joiningDate: r.joiningDate ?? null,
    }));
  });

/**
 * The reconciled compensation reading for one application: last drawn salary as
 * a dated conclusion with its basis, evidence chain, conflicts and open gaps.
 */
export const getCompensationReading = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => z.object({ applicationId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }): Promise<CompensationReading> => {
    return compensationReading(context.orgId, data.applicationId);
  });
