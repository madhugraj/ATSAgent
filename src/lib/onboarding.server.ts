/**
 * Pre-onboarding document collection, extraction and validation.
 *
 * Before an approved offer is released, the candidate's proof documents are
 * collected — uploaded by TA or received on the organisation's careers inbox —
 * read by the extraction agent, and then validated by HR/TA against the
 * original file. Nothing is trusted: the agent's reading is stored next to the
 * stored file and the reviewer's decision, so every figure that lands in the
 * database can be traced back to the page it came from.
 *
 * Tenant isolation: every query here takes an explicit orgId from the verified
 * caller context and predicates on it.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { applications, candidates, offers, onboardingDocuments } from "@db/schema";
import {
  aiJson,
  INJECTION_RULES,
  resolveAiConfig,
  untrusted,
  type AiDoc,
  type AiImage,
} from "./ai-gateway.server";
import { contentTypeFor, getObject, putObject, safeFileName } from "../server/storage";

/* ------------------------------------------------------- document catalogue */

export type DocTypeDef = {
  key: string;
  label: string;
  /** Required documents gate the release of the offer letter. */
  required: boolean;
  hint: string;
  /** What the agent should read out of this kind of document. */
  expects: string[];
};

export const DOC_TYPES: DocTypeDef[] = [
  {
    key: "id_proof",
    label: "Government photo ID",
    required: true,
    hint: "Aadhaar, passport, driving licence or PAN — name and date of birth must match the offer.",
    expects: ["holder name", "ID number", "date of birth", "issuing authority"],
  },
  {
    key: "experience_letter",
    label: "Experience / relieving letter",
    required: true,
    hint: "One per employer claimed on the CV, on company letterhead.",
    expects: ["employer", "designation", "employed from", "employed to"],
  },
  {
    key: "payslip",
    label: "Recent payslips",
    required: true,
    hint: "Last three months — this is what proves the last drawn CTC.",
    expects: ["employer", "payslip month", "gross pay", "net pay", "annualised CTC"],
  },
  {
    key: "education_certificate",
    label: "Education certificate",
    required: true,
    hint: "Highest qualification — degree certificate or final marksheet.",
    expects: ["institution", "qualification", "year of completion"],
  },
  {
    key: "salary_revision",
    label: "Salary revision / appraisal letter",
    required: false,
    hint: "Confirms the current fixed and variable split.",
    expects: ["employer", "annual CTC", "effective date"],
  },
  {
    key: "bank_details",
    label: "Bank account proof",
    required: false,
    hint: "Cancelled cheque or bank statement header for payroll setup.",
    expects: ["account holder name", "bank", "account number"],
  },
  {
    key: "address_proof",
    label: "Address proof",
    required: false,
    hint: "Current residential address for the background check.",
    expects: ["holder name", "address"],
  },
  {
    key: "background_form",
    label: "Background verification form",
    required: false,
    hint: "Signed consent and declaration.",
    expects: ["holder name", "signature date"],
  },
  {
    key: "other",
    label: "Other document",
    required: false,
    hint: "Anything else HR asked for.",
    expects: ["summary"],
  },
];

export const DOC_TYPE_KEYS = DOC_TYPES.map((d) => d.key) as [string, ...string[]];
export const REQUIRED_DOC_TYPES = DOC_TYPES.filter((d) => d.required).map((d) => d.key);

export function docTypeLabel(key: string): string {
  return DOC_TYPES.find((d) => d.key === key)?.label ?? key;
}

/** Best-guess document type from a file name, used for inbox-collected files. */
export function guessDocType(fileName: string): string {
  const n = fileName.toLowerCase();
  if (/(payslip|salary.?slip|pay.?stub)/.test(n)) return "payslip";
  if (/(experience|relieving|service.?letter|noc)/.test(n)) return "experience_letter";
  if (/(aadha?ar|passport|pan|licence|license|voter)/.test(n)) return "id_proof";
  if (/(degree|marksheet|provisional|convocation|certificate.*(b\.?tech|bsc|mca|mba))/.test(n))
    return "education_certificate";
  if (/(revision|appraisal|increment|hike)/.test(n)) return "salary_revision";
  if (/(cheque|bank|passbook)/.test(n)) return "bank_details";
  if (/(address|rent.?agreement|utility)/.test(n)) return "address_proof";
  if (/(bgv|background|declaration|consent)/.test(n)) return "background_form";
  return "other";
}

/* ---------------------------------------------------------- extraction shape */

/** What the agent reads out of a document. Everything is optional — a payslip
 *  has no qualification, an ID has no employer — and every value is a claim
 *  awaiting human validation. */
/**
 * One line of a salary breakup, exactly as the employer labels it. Every
 * organisation names and splits pay differently — basic, HRA, flexible benefit
 * plan, special allowance, city compensatory allowance, retention pay, employer
 * PF, gratuity provision — so the breakup is captured as the document's own
 * labelled lines rather than forced into a fixed set of fields.
 */
export const PayComponent = z.object({
  label: z.string().max(120),
  amount: z.number(),
  /** monthly | annual | one_off — what period this amount covers. */
  cadence: z.string().max(20).nullish(),
  /** earning | deduction | employer_contribution | total */
  kind: z.string().max(30).nullish(),
  /** False for arrears, bonus, incentive, reimbursement and other one-time lines. */
  recurring: z.boolean().nullish(),
});
export type PayComponent = z.infer<typeof PayComponent>;

const DocFacts = z.object({
  document_kind: z.string().max(120).nullish(),
  holder_name: z.string().max(200).nullish(),
  id_number: z.string().max(80).nullish(),
  date_of_birth: z.string().max(40).nullish(),
  employer: z.string().max(200).nullish(),
  designation: z.string().max(200).nullish(),
  employed_from: z.string().max(40).nullish(),
  employed_to: z.string().max(40).nullish(),
  payslip_month: z.string().max(40).nullish(),
  gross_pay: z.number().nullish(),
  net_pay: z.number().nullish(),
  annual_ctc: z.number().nullish(),
  currency: z.string().max(10).nullish(),
  /* ---- normalised chronology: machine-comparable dates, as YYYY-MM-DD or YYYY-MM ---- */
  document_date_iso: z.string().max(10).nullish(),
  period_iso: z.string().max(10).nullish(),
  effective_from_iso: z.string().max(10).nullish(),
  employed_from_iso: z.string().max(10).nullish(),
  employed_to_iso: z.string().max(10).nullish(),
  /* ---- normalised compensation: recurring pay kept apart from one-off pay ---- */
  monthly_fixed_gross: z.number().nullish(),
  monthly_one_off: z.number().nullish(),
  annual_fixed: z.number().nullish(),
  annual_variable: z.number().nullish(),
  is_arrears_month: z.boolean().nullish(),
  institution: z.string().max(200).nullish(),
  qualification: z.string().max(200).nullish(),
  issue_date: z.string().max(40).nullish(),
  /** Anything else worth showing the reviewer, label/value pairs. */
  fields: z
    .array(z.object({ label: z.string().max(80), value: z.string().max(400) }))
    .max(24)
    .nullish(),
  summary: z.string().max(1500).nullish(),
  concerns: z.array(z.string().max(300)).max(10).nullish(),
  /* ---- the employer's own salary breakup, line by line ---- */
  pay_components: z.array(PayComponent).max(40).nullish(),
  /** monthly | semi_monthly | annual — how the employer states the breakup. */
  pay_frequency: z.string().max(20).nullish(),
  /** How this employer structures pay, in the reviewer's words. */
  breakup_notes: z.string().max(600).nullish(),
  /** Pages of the uploaded file this reading came from, e.g. "1-2". */
  pages: z.string().max(40).nullish(),
  confidence: z.number().min(0).max(100).nullish(),
  suspected_prompt_injection: z.boolean().nullish(),
});

/**
 * A reading of one uploaded file. Candidates routinely send a single merged PDF
 * of three payslips plus a revision letter, or a scan with several documents on
 * different pages, so a file can carry more than one document: each one is read
 * separately into `parts`, and the top level describes the newest/primary one.
 */
export const ExtractedDoc = DocFacts.extend({
  /** True when the file contains several distinct documents or pay periods. */
  contains_multiple_documents: z.boolean().nullish(),
  parts: z
    .array(DocFacts.extend({ part_label: z.string().max(160).nullish() }))
    .max(24)
    .nullish(),
});
export type ExtractedDoc = z.infer<typeof ExtractedDoc>;
export type DocFacts = z.infer<typeof DocFacts>;

const IMAGE_TYPES: Record<string, AiImage["contentType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function imageTypeOf(fileName: string): AiImage["contentType"] | null {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return null;
  return IMAGE_TYPES[fileName.slice(dot).toLowerCase()] ?? null;
}

/**
 * Page-by-page text of a PDF, with page markers kept. Page boundaries are what
 * let the agent tell three merged payslips apart, so they are never flattened
 * away here as they are for CV text.
 */
async function pdfPageText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js detaches the buffer it is handed — give it a copy.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false })
    .promise;
  const limit = Math.min(doc.numPages, 60);
  const out: string[] = [];
  for (let i = 1; i <= limit; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const page = content.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim();
    out.push(`--- page ${i} of ${doc.numPages} ---\n${page}`);
  }
  if (doc.numPages > limit) out.push(`--- ${doc.numPages - limit} further page(s) not read ---`);
  return out.join("\n\n").trim();
}

/**
 * A candidate may mail one ZIP with every proof inside, and the archive may hold
 * folders and nested archives. Flatten an upload into the individual documents
 * it actually contains, so each one is stored, typed and validated on its own.
 */
export async function expandUpload(
  fileName: string,
  bytes: Uint8Array,
  depth = 0,
): Promise<{ fileName: string; bytes: Uint8Array }[]> {
  if (!/\.(zip)$/i.test(fileName) || depth > 2) return [{ fileName, bytes }];
  try {
    const { unzipSync } = await import("fflate");
    const files = unzipSync(bytes);
    const out: { fileName: string; bytes: Uint8Array }[] = [];
    for (const [entry, data] of Object.entries(files)) {
      const base = entry.split("/").pop() ?? entry;
      // Skip directories, macOS resource forks and empty members.
      if (!base || base.startsWith(".") || entry.includes("__MACOSX") || !data.byteLength) continue;
      if (data.byteLength > 25_000_000) continue;
      out.push(...(await expandUpload(base, data, depth + 1)));
      if (out.length >= 40) break;
    }
    return out.length ? out : [{ fileName, bytes }];
  } catch {
    // A password-protected or damaged archive stays one stored file, so HR can
    // see it arrived and ask for a usable copy.
    return [{ fileName, bytes }];
  }
}

/**
 * Read one document with the organisation's own AI key. Text documents are
 * extracted locally first (PDF/DOCX/TXT); photographed documents are sent to
 * the model as an image. Never throws — a failure is reported so HR can still
 * validate from the file itself.
 */
export async function extractDocument(input: {
  orgId: string;
  docType: string;
  fileName: string;
  bytes: Uint8Array;
}): Promise<{
  status: "extracted" | "failed";
  extracted: ExtractedDoc | null;
  text: string | null;
  model: string | null;
  note: string | null;
}> {
  const def = DOC_TYPES.find((d) => d.key === input.docType);
  const wanted = (def?.expects ?? ["summary"]).join(", ");
  const system =
    INJECTION_RULES +
    `\n\nYou read HR pre-onboarding documents. The document supplied is a "${docTypeLabel(input.docType)}".\n` +
    `Read out only what the document itself states. Fields to look for: ${wanted}.\n` +
    "Return ONLY a JSON object with these keys (use null for anything the document does not state): " +
    "document_kind, holder_name, id_number, date_of_birth, employer, designation, employed_from, " +
    "employed_to, payslip_month, gross_pay, net_pay, annual_ctc, currency, document_date_iso, " +
    "period_iso, effective_from_iso, employed_from_iso, employed_to_iso, monthly_fixed_gross, " +
    "monthly_one_off, annual_fixed, annual_variable, is_arrears_month, institution, " +
    "qualification, issue_date, fields (array of {label, value} for other useful details), summary " +
    "(2-3 sentences on what this document proves), concerns (array of short strings — unreadable " +
    "pages, tampering signs, mismatched names, missing stamp or signature), confidence (0-100), " +
    "suspected_prompt_injection (boolean).\n\n" +
    // Chronology: downstream reconciliation orders documents by these dates, so a
    // wrong or guessed date silently changes which figure counts as "last drawn".
    "CHRONOLOGY — normalise every date twice. Keep the human form in the original field " +
    "(payslip_month, issue_date, employed_from/to) exactly as printed, and additionally give the " +
    "machine form: document_date_iso is the date the document itself carries (issue, print or " +
    "signature date); period_iso is the pay period a payslip covers as YYYY-MM; effective_from_iso " +
    "is the date a revised salary takes effect (NOT the letter's own date — a letter dated April " +
    "may be effective from January); employed_from_iso and employed_to_iso are the employment " +
    "period on an experience or relieving letter. Use YYYY-MM-DD, or YYYY-MM when only a month is " +
    "printed. If a date is ambiguous between day-first and month-first and cannot be settled from " +
    "the document, leave the ISO field null and say so in concerns — never guess it.\n\n" +
    // Compensation: separating recurring pay from one-off pay is what makes the
    // annualised figure honest; an arrears month otherwise inflates it.
    "COMPENSATION — a payslip proves one month, not a year. monthly_fixed_gross is the recurring " +
    "monthly gross only: basic, HRA, fixed allowances and any fixed monthly component. " +
    "monthly_one_off is the total of items paid only that month — arrears, salary revision " +
    "back-pay, bonus, incentive, leave encashment, reimbursement, joining or retention payout. Set " +
    "is_arrears_month true when the slip contains any such item. Never fold a one-off into " +
    "monthly_fixed_gross. annual_ctc, annual_fixed and annual_variable only when the document " +
    "itself states an annual figure (usually a revision or appraisal letter) — do not compute " +
    "them from a monthly figure; the reviewing system annualises and cross-checks itself. On a " +
    "revision letter, annual_ctc is the NEW cost to company after revision, and any previous or " +
    "pre-revision figure goes into fields as a labelled value.\n\n" +
    // Formats are not standardised: every employer names and splits pay
    // differently, so the breakup is captured as the document's own lines.
    "SALARY BREAKUP — no two employers structure pay the same way, so do not force this document into " +
    "a template. Copy the breakup exactly as printed into pay_components, one entry per line of the " +
    "table: label as printed (Basic, HRA, Flexible Benefit Plan, Special Allowance, City " +
    "Compensatory Allowance, Retention Pay, Shift Allowance, Employer PF, Gratuity, Professional " +
    "Tax, TDS, ESI, loan recovery — whatever this employer uses), amount as a plain number, cadence " +
    "(monthly, annual or one_off), kind (earning, deduction, employer_contribution or total) and " +
    "recurring (false for arrears, back-pay, bonus, incentive, leave encashment, reimbursement, " +
    "joining or retention payouts). Never rename, merge or re-bucket a component, never drop a line " +
    "you cannot classify — set kind null and keep the label. Set pay_frequency to the period the " +
    "breakup is stated in, and use breakup_notes to explain in one or two sentences how this " +
    "employer structures pay (for example a flexible benefit pot the employee allocates, or a " +
    "variable paid quarterly). monthly_fixed_gross must equal the sum of the recurring monthly " +
    "earnings you listed, and monthly_one_off the sum of the non-recurring ones.\n\n" +
    // Merged and multi-page uploads: one file is not one document.
    "MERGED AND MULTI-PAGE FILES — the file may hold several documents: three monthly payslips in " +
    "one PDF, a payslip followed by a revision letter, an ID scanned on page 1 with a certificate " +
    "on page 2, or the same document repeated. Read the WHOLE file. When it carries more than one " +
    "document or more than one pay period, set contains_multiple_documents true and return one entry " +
    "in parts for EACH document or pay period, each with its own dates, figures and pay_components, " +
    'a part_label naming it ("Payslip Mar 2026", "Revision letter effective Apr 2026") and pages ' +
    "giving the page range it occupies. Put the most recent or most significant document at the top " +
    "level as well, so a reader that ignores parts still gets the current position. Never average, " +
    "merge or total figures across different documents or months.\n\n" +
    "RELEVANCE — record in concerns anything that weakens this document as proof: the holder name " +
    "differs from the name elsewhere on the document, the employer differs between pages, the " +
    "period is older than it should be, the figures are inconsistent (components do not add up to " +
    "the stated gross, net exceeds gross), the copy is partial, unsigned, unstamped or looks " +
    "edited. Money as plain numbers without separators or symbols, and state the currency " +
    "separately. NEVER invent a value that is not on the document — an invented figure would be " +
    "approved as proof of pay.";

  let text: string | null = null;
  const images: AiImage[] = [];
  const docs: AiDoc[] = [];
  const imageType = imageTypeOf(input.fileName);
  const isPdf = /\.pdf$/i.test(input.fileName);
  try {
    if (imageType) {
      images.push({ base64: Buffer.from(input.bytes).toString("base64"), contentType: imageType });
    } else if (isPdf) {
      const read = await pdfPageText(input.bytes);
      text = read.trim() ? read.slice(0, 120_000) : null;
      // A scan, a photographed slip printed to PDF, or a breakup table that is
      // an image: hand the whole PDF to the model so it reads the pages itself.
      if (
        (!text || text.replace(/--- page[^\n]*\n/g, "").trim().length < 400) &&
        input.bytes.byteLength < 18_000_000
      ) {
        docs.push({
          base64: Buffer.from(input.bytes).toString("base64"),
          contentType: "application/pdf",
          fileName: safeFileName(input.fileName),
        });
      }
    } else {
      const { attachmentText } = await import("./cv-text.server");
      const read = await attachmentText(input.fileName, input.bytes);
      text = read.trim() ? read.slice(0, 120_000) : null;
    }
  } catch (e) {
    return {
      status: "failed",
      extracted: null,
      text: null,
      model: null,
      note: e instanceof Error ? e.message : "The file could not be read.",
    };
  }

  if (!text && !images.length && !docs.length) {
    return {
      status: "failed",
      extracted: null,
      text: null,
      model: null,
      note: /\.(doc|xls|ppt|heic|heif)$/i.test(input.fileName)
        ? "This file format cannot be read automatically. Ask for a PDF, DOCX, JPG or PNG copy, or validate it by eye."
        : "No readable text in the file — it may be a scan. Validate it by eye, or ask for a clearer copy.",
    };
  }

  const cfg = await resolveAiConfig(input.orgId);
  const result = await aiJson<ExtractedDoc>({
    orgId: input.orgId,
    config: cfg,
    feature: "doc_extract",
    schema: ExtractedDoc,
    system,
    ...(images.length ? { images } : {}),
    ...(docs.length ? { docs } : {}),
    prompt: `File name: ${safeFileName(input.fileName)}\n\n${untrusted("pre_onboarding_document", text ?? "(photographed document — read the attached image)")}`,
  });
  if (!result.ok) {
    return { status: "failed", extracted: null, text, model: null, note: result.message };
  }
  return { status: "extracted", extracted: result.data, text, model: result.model, note: null };
}

/* ----------------------------------------------------------------- storage */

export function documentObjectPath(orgId: string, candidateId: string, fileName: string): string {
  return `${orgId}/onboarding/${candidateId}/${Date.now()}-${safeFileName(fileName)}`;
}

/**
 * File one document against an application: store the bytes privately, run the
 * extraction agent, and leave the row "pending" for HR/TA validation.
 */
export async function storeOnboardingDocument(input: {
  orgId: string;
  applicationId: string;
  candidateId: string;
  offerId: string | null;
  docType: string;
  fileName: string;
  bytes: Uint8Array;
  source: "upload" | "careers_inbox";
  inboxMessageId?: string | null;
  uploadedBy?: string | null;
}): Promise<{ id: string; extractionStatus: string; note: string | null }> {
  const filePath = documentObjectPath(input.orgId, input.candidateId, input.fileName);
  const contentType = contentTypeFor(input.fileName);
  await putObject(filePath, input.bytes, contentType);

  const read = await extractDocument({
    orgId: input.orgId,
    docType: input.docType,
    fileName: input.fileName,
    bytes: input.bytes,
  });

  const [row] = await db
    .insert(onboardingDocuments)
    .values({
      orgId: input.orgId,
      applicationId: input.applicationId,
      candidateId: input.candidateId,
      offerId: input.offerId,
      docType: input.docType,
      fileName: safeFileName(input.fileName),
      filePath,
      fileBytes: input.bytes.byteLength,
      contentType,
      source: input.source,
      inboxMessageId: input.inboxMessageId ?? null,
      extractedText: read.text ? read.text.slice(0, 20_000) : null,
      extracted: (read.extracted ?? null) as never,
      extractionStatus: read.status,
      extractionNote: read.note,
      model: read.model,
      uploadedBy: input.uploadedBy ?? null,
      status: "pending",
    })
    .returning({ id: onboardingDocuments.id });
  if (!row) throw new Error("The document could not be filed.");
  return { id: row.id, extractionStatus: read.status, note: read.note };
}

/** Load a stored document's bytes, refusing any path outside the org's folder. */
export async function readOnboardingFile(
  orgId: string,
  filePath: string | null,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!filePath || !filePath.startsWith(`${orgId}/`)) return null;
  try {
    return await getObject(filePath);
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- readiness */

export type Readiness = {
  applicationId: string;
  total: number;
  verified: number;
  pending: number;
  rejected: number;
  missing: string[];
  ready: boolean;
};

/** Pre-onboarding is complete when every required document type has a verified row. */
export async function readinessFor(orgId: string, applicationId: string): Promise<Readiness> {
  const rows = await db
    .select({ docType: onboardingDocuments.docType, status: onboardingDocuments.status })
    .from(onboardingDocuments)
    .where(
      and(
        eq(onboardingDocuments.orgId, orgId),
        eq(onboardingDocuments.applicationId, applicationId),
      ),
    );
  const verifiedTypes = new Set(rows.filter((r) => r.status === "verified").map((r) => r.docType));
  const missing = REQUIRED_DOC_TYPES.filter((t) => !verifiedTypes.has(t));
  return {
    applicationId,
    total: rows.length,
    verified: rows.filter((r) => r.status === "verified").length,
    pending: rows.filter((r) => r.status === "pending").length,
    rejected: rows.filter((r) => r.status === "rejected").length,
    missing,
    ready: missing.length === 0,
  };
}

/**
 * Where a candidate's documents should be filed when mail arrives from them:
 * their most recent application that is at or past the offer stage.
 */
export async function offerContextForEmail(
  orgId: string,
  email: string,
): Promise<{ applicationId: string; candidateId: string; offerId: string | null } | null> {
  const [row] = await db
    .select({
      applicationId: applications.id,
      candidateId: candidates.id,
      stage: applications.stage,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.orgId, orgId), eq(candidates.email, email.toLowerCase())))
    .orderBy(desc(applications.appliedAt))
    .limit(1);
  if (!row) return null;
  const OFFERING = [
    "l3",
    "offer",
    "offer_pending",
    "offer_released",
    "offer_accepted",
    "hired",
    "joined",
  ];
  if (!OFFERING.includes(row.stage)) return null;
  const [offer] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.orgId, orgId), eq(offers.applicationId, row.applicationId)))
    .orderBy(desc(offers.createdAt))
    .limit(1);
  return {
    applicationId: row.applicationId,
    candidateId: row.candidateId,
    offerId: offer?.id ?? null,
  };
}

/* ------------------------------------------- chronological compensation reading */

/**
 * Last drawn salary is a conclusion, not a field. One payslip proves one month,
 * an arrears month overstates the year, a revision letter can predate the
 * payslips it applies to, and a stale set of slips proves a salary the candidate
 * has since left behind.
 *
 * So the figures the agent read out of each document are reconciled here, in
 * code, on an explicit timeline: documents are ordered by the dates they carry,
 * recurring pay is annualised apart from one-off pay, a revision letter is only
 * allowed to override payslips when it is effective on or before them, and every
 * disagreement is surfaced instead of averaged away. The reviewer sees the basis,
 * the evidence chain and the doubts — never a bare number.
 */
export type CompensationEvidence = {
  docId: string;
  docType: string;
  docTypeLabel: string;
  fileName: string;
  status: string;
  /** Date the reconciliation ordered this document by. */
  onIso: string | null;
  employer: string | null;
  /** What this document contributes to the reading, in words. */
  reads: string;
  annualised: number | null;
  oneOff: number | null;
};

export type CompensationReading = {
  currency: string;
  lastDrawnAnnual: number | null;
  basis: string;
  /** How much of the reading rests on validated (not merely uploaded) documents. */
  validatedEvidence: number;
  totalEvidence: number;
  offeredAnnual: number | null;
  hikePct: number | null;
  timeline: CompensationEvidence[];
  conflicts: string[];
  gaps: string[];
  confident: boolean;
};

/** YYYY-MM or YYYY-MM-DD → sortable YYYY-MM-DD; anything else is unusable. */
function isoDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}-${m[3] ?? "01"}`;
}

function monthsBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

function sameEmployer(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(
        /\b(private|pvt|limited|ltd|llp|inc|corp|corporation|technologies|technology|solutions|services|india)\b/g,
        "",
      )
      .replace(/[^a-z0-9]/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return true;
  return x.includes(y) || y.includes(x);
}

function money(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export async function compensationReading(
  orgId: string,
  applicationId: string,
): Promise<CompensationReading> {
  const rows = await db
    .select({
      id: onboardingDocuments.id,
      docType: onboardingDocuments.docType,
      fileName: onboardingDocuments.fileName,
      status: onboardingDocuments.status,
      extracted: onboardingDocuments.extracted,
      createdAt: onboardingDocuments.createdAt,
    })
    .from(onboardingDocuments)
    .where(
      and(
        eq(onboardingDocuments.orgId, orgId),
        eq(onboardingDocuments.applicationId, applicationId),
      ),
    );

  const [offer] = await db
    .select({ offeredCtc: offers.offeredCtc })
    .from(offers)
    .where(and(eq(offers.orgId, orgId), eq(offers.applicationId, applicationId)))
    .orderBy(desc(offers.createdAt))
    .limit(1);
  const offeredAnnual = offer ? money(Number(offer.offeredCtc)) : null;

  type Parsed = (typeof rows)[number] & { e: ExtractedDoc };

  /**
   * A merged upload — three payslips and a revision letter in one PDF — was read
   * as several documents. Each one is reconciled in its own right, otherwise the
   * timeline would show one file and the months inside it would be lost. The top
   * level repeats the newest part, so when parts exist only the parts are used.
   */
  const classify = (facts: ExtractedDoc, fallback: string): string => {
    if (isoDay(facts.period_iso)) return "payslip";
    if (isoDay(facts.effective_from_iso) && (facts.annual_ctc || facts.annual_fixed))
      return "salary_revision";
    if (isoDay(facts.employed_from_iso) || isoDay(facts.employed_to_iso))
      return "experience_letter";
    return fallback;
  };

  const parsed: Parsed[] = rows
    .filter((r) => r.extracted)
    .flatMap((r) => {
      const e = r.extracted as unknown as ExtractedDoc;
      const parts = (e.parts ?? []).filter(Boolean);
      if (!parts.length) return [{ ...r, e }];
      return parts.map((part, i) => ({
        ...r,
        docType: classify(part as ExtractedDoc, r.docType),
        fileName: part.part_label
          ? `${r.fileName} — ${part.part_label}`
          : `${r.fileName} (part ${i + 1}${part.pages ? `, p. ${part.pages}` : ""})`,
        e: part as ExtractedDoc,
      }));
    });

  const conflicts: string[] = [];
  const gaps: string[] = [];
  const timeline: CompensationEvidence[] = [];

  const currencies = new Set(
    parsed.map((p) => (p.e.currency ?? "").toUpperCase().trim()).filter(Boolean),
  );
  if (currencies.size > 1) {
    conflicts.push(`Documents quote more than one currency (${[...currencies].join(", ")}).`);
  }
  const currency = [...currencies][0] ?? "INR";

  /* ------------------------------------------------------------- payslips */
  const payslips = parsed
    .filter((p) => p.docType === "payslip")
    .map((p) => {
      const on = isoDay(p.e.period_iso) ?? isoDay(p.e.document_date_iso);
      const fixed = money(p.e.monthly_fixed_gross);
      const gross = money(p.e.gross_pay);
      const oneOff = money(p.e.monthly_one_off);
      // Fall back to gross minus one-off only when the agent did not separate the
      // recurring pay itself; never annualise a gross that still carries arrears.
      const recurring = fixed ?? (gross !== null && oneOff !== null ? gross - oneOff : gross);
      return { p, on, recurring: money(recurring), oneOff, gross };
    })
    .sort((a, b) => (b.on ?? "").localeCompare(a.on ?? ""));

  const dated = payslips.filter((s) => s.on);
  if (payslips.length && !dated.length) {
    conflicts.push(
      "No payslip carries a readable pay period, so none of them can be ordered in time.",
    );
  }
  const undatedSlips = payslips.length - dated.length;
  if (dated.length && undatedSlips > 0) {
    gaps.push(`${undatedSlips} payslip(s) could not be dated and were left out of the reading.`);
  }

  const latest = dated[0] ?? null;
  const todayIso = new Date().toISOString().slice(0, 10);
  if (latest?.on) {
    const age = monthsBetween(latest.on, todayIso);
    if (age > 3) {
      conflicts.push(
        `The most recent payslip covers ${latest.on.slice(0, 7)}, ${age} months ago — ask for the latest months before relying on this figure.`,
      );
    }
  }
  if (dated.length < 3) {
    gaps.push(
      `${dated.length} dated payslip(s) on file; three consecutive months make the reading reliable.`,
    );
  }
  // Consecutive-month check across the three most recent slips.
  for (let i = 0; i < Math.min(dated.length, 3) - 1; i++) {
    const newer = dated[i]!;
    const older = dated[i + 1]!;
    const step = monthsBetween(older.on!, newer.on!);
    if (step > 1) {
      gaps.push(
        `Payslip months are not consecutive: ${older.on!.slice(0, 7)} then ${newer.on!.slice(0, 7)}.`,
      );
    }
  }
  // A recurring gross that moves between adjacent months means either a mid-period
  // revision or a mis-read slip — both are decisions for the reviewer, not for us.
  for (let i = 0; i < Math.min(dated.length, 3) - 1; i++) {
    const a = dated[i]!.recurring;
    const b = dated[i + 1]!.recurring;
    if (a && b && Math.abs(a - b) / b > 0.05) {
      conflicts.push(
        `Recurring monthly pay changes between ${dated[i + 1]!.on!.slice(0, 7)} and ${dated[i]!.on!.slice(0, 7)} (${b} → ${a}) — confirm which month reflects the current salary.`,
      );
    }
  }

  const payslipEmployer = latest?.p.e.employer ?? null;
  for (const s of dated) {
    if (!sameEmployer(payslipEmployer, s.p.e.employer ?? null)) {
      conflicts.push(
        `Payslips name different employers (${payslipEmployer} vs ${s.p.e.employer}) — separate them by employment period.`,
      );
      break;
    }
  }

  for (const s of dated.slice(0, 6)) {
    timeline.push({
      docId: s.p.id,
      docType: s.p.docType,
      docTypeLabel: docTypeLabel(s.p.docType),
      fileName: s.p.fileName,
      status: s.p.status,
      onIso: s.on,
      employer: s.p.e.employer ?? null,
      reads: s.oneOff
        ? `Recurring gross ${s.recurring ?? "?"} plus ${s.oneOff} paid once that month (excluded from the annual figure).`
        : `Recurring monthly gross ${s.recurring ?? "?"}.`,
      annualised: s.recurring ? s.recurring * 12 : null,
      oneOff: s.oneOff,
    });
  }

  /* ---------------------------------------------------- revision letters */
  const revisions = parsed
    .filter((p) => p.docType === "salary_revision")
    .map((p) => ({
      p,
      on: isoDay(p.e.effective_from_iso) ?? isoDay(p.e.document_date_iso),
      annual: money(p.e.annual_ctc) ?? money(p.e.annual_fixed),
      usedLetterDate: !isoDay(p.e.effective_from_iso) && Boolean(isoDay(p.e.document_date_iso)),
    }))
    .sort((a, b) => (b.on ?? "").localeCompare(a.on ?? ""));

  for (const r of revisions) {
    if (r.usedLetterDate) {
      gaps.push(
        `A revision letter states no effective date; its own date (${r.on?.slice(0, 7)}) was used instead.`,
      );
    }
    timeline.push({
      docId: r.p.id,
      docType: r.p.docType,
      docTypeLabel: docTypeLabel(r.p.docType),
      fileName: r.p.fileName,
      status: r.p.status,
      onIso: r.on,
      employer: r.p.e.employer ?? null,
      reads: r.annual
        ? `Revised annual cost to company ${r.annual}, effective ${r.on?.slice(0, 7) ?? "date unclear"}.`
        : "No annual figure could be read from this letter.",
      annualised: r.annual,
      oneOff: null,
    });
  }

  /* -------------------------------------------------- employment history */
  const service = parsed
    .filter((p) => p.docType === "experience_letter")
    .map((p) => ({
      p,
      from: isoDay(p.e.employed_from_iso),
      to: isoDay(p.e.employed_to_iso),
    }))
    .sort((a, b) => (b.to ?? b.from ?? "").localeCompare(a.to ?? a.from ?? ""));

  for (const s of service) {
    timeline.push({
      docId: s.p.id,
      docType: s.p.docType,
      docTypeLabel: docTypeLabel(s.p.docType),
      fileName: s.p.fileName,
      status: s.p.status,
      onIso: s.to ?? s.from,
      employer: s.p.e.employer ?? null,
      reads: `${s.p.e.designation ?? "Employed"} at ${s.p.e.employer ?? "employer not stated"} ${
        s.from ? `from ${s.from.slice(0, 7)}` : "from date unclear"
      } ${s.to ? `to ${s.to.slice(0, 7)}` : "to date not stated (current employer)"}.`,
      annualised: null,
      oneOff: null,
    });
  }
  // Employment gaps between consecutive service periods, newest first.
  for (let i = 0; i < service.length - 1; i++) {
    const newer = service[i]!;
    const older = service[i + 1]!;
    if (newer.from && older.to) {
      const gapMonths = monthsBetween(older.to, newer.from);
      if (gapMonths > 3) {
        gaps.push(
          `${gapMonths} months unaccounted for between ${older.p.e.employer ?? "previous employer"} (to ${older.to.slice(0, 7)}) and ${newer.p.e.employer ?? "current employer"} (from ${newer.from.slice(0, 7)}).`,
        );
      }
    }
  }
  const currentService = service.find((s) => !s.to) ?? service[0] ?? null;
  if (currentService && !sameEmployer(payslipEmployer, currentService.p.e.employer ?? null)) {
    conflicts.push(
      `The payslips are from ${payslipEmployer}, but the most recent service letter is from ${currentService.p.e.employer} — confirm which employment the pay proof belongs to.`,
    );
  }

  /* ------------------------------------------------------- the conclusion */
  const payslipAnnual = latest?.recurring ? latest.recurring * 12 : null;
  // A revision letter only governs the pay actually being drawn when it took
  // effect on or before the latest payslip month.
  const governing = revisions.find((r) => r.annual && r.on && (!latest?.on || r.on <= latest.on));
  const futureRevision = revisions.find((r) => r.annual && r.on && latest?.on && r.on > latest.on);
  if (futureRevision) {
    gaps.push(
      `A revision effective ${futureRevision.on!.slice(0, 7)} is later than the newest payslip, so it is not yet proven as drawn pay.`,
    );
  }

  let lastDrawnAnnual: number | null = null;
  let basis: string;
  if (governing?.annual && payslipAnnual) {
    const drift = Math.abs(governing.annual - payslipAnnual) / payslipAnnual;
    lastDrawnAnnual = governing.annual;
    basis = `Revision letter effective ${governing.on!.slice(0, 7)}, cross-checked against the ${latest!.on!.slice(0, 7)} payslip (recurring pay annualised: ${payslipAnnual}).`;
    if (drift > 0.12) {
      conflicts.push(
        `The revision letter (${governing.annual}) and the annualised payslip (${payslipAnnual}) differ by ${Math.round(drift * 100)}% — the gap is usually employer PF, gratuity or variable pay, but confirm it before quoting the figure.`,
      );
    }
  } else if (governing?.annual) {
    lastDrawnAnnual = governing.annual;
    basis = `Revision letter effective ${governing.on!.slice(0, 7)}. No dated payslip to confirm it was actually drawn.`;
  } else if (payslipAnnual) {
    lastDrawnAnnual = payslipAnnual;
    basis = `Recurring pay on the ${latest!.on!.slice(0, 7)} payslip, annualised over 12 months${
      latest!.oneOff ? " with that month's one-off pay excluded" : ""
    }. Employer PF, gratuity and variable pay are not included unless a letter states them.`;
  } else {
    basis = "No payslip or revision letter yields a figure yet — collect the last three payslips.";
  }

  const hikePct =
    lastDrawnAnnual && offeredAnnual
      ? Math.round(((offeredAnnual - lastDrawnAnnual) / lastDrawnAnnual) * 1000) / 10
      : null;
  if (hikePct !== null && hikePct < 0) {
    gaps.push(
      `The offer is ${Math.abs(hikePct)}% below the last drawn figure — confirm this is intended.`,
    );
  }

  const evidenceDocs = parsed.filter((p) =>
    ["payslip", "salary_revision", "experience_letter"].includes(p.docType),
  );

  return {
    currency,
    lastDrawnAnnual,
    basis,
    validatedEvidence: evidenceDocs.filter((p) => p.status === "verified").length,
    totalEvidence: evidenceDocs.length,
    offeredAnnual,
    hikePct,
    timeline: timeline.sort((a, b) => (b.onIso ?? "").localeCompare(a.onIso ?? "")),
    conflicts,
    gaps,
    confident:
      lastDrawnAnnual !== null &&
      conflicts.length === 0 &&
      dated.length >= 3 &&
      evidenceDocs.every((p) => p.status === "verified"),
  };
}
