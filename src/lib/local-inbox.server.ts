/**
 * Local careers inbox, one per organisation.
 *
 * Each tenant gets its own ATSIQ address (for example acme@careers.atsiq.yavar.ai).
 * Mail sent there — LinkedIn application alerts, board notifications, direct
 * applicants — arrives on the inbound webhook, is stored in inbox_messages and
 * the attached CV is parsed straight into the talent pool. HR configures nothing.
 */
import { and, desc, eq, ilike, inArray } from "drizzle-orm";

import { db } from "../server/db";
import { inboxMessages, organizations, requisitions } from "@db/schema";
import { ingestCandidate, parseCv } from "./intake.server";

export const INBOX_DOMAIN = process.env["INBOUND_EMAIL_DOMAIN"] ?? "careers.atsiq.yavar.ai";

export function inboxAddress(slug: string | null | undefined): string | null {
  const clean = (slug ?? "").trim().toLowerCase();
  return clean ? `${clean}@${INBOX_DOMAIN}` : null;
}

/** Local part of any recipient address, lower-cased. */
export function localPart(address: string): string {
  const m = /<([^>]+)>/.exec(address);
  const bare = (m?.[1] ?? address).trim().toLowerCase();
  const at = bare.indexOf("@");
  return (at === -1 ? bare : bare.slice(0, at)).replace(/\+.*$/, "");
}

/** Every plain address found in a recipient header, lower-cased. */
export function recipientAddresses(header: string): string[] {
  const out: string[] = [];
  for (const chunk of (header ?? "").split(",")) {
    const m = /<([^>]+)>/.exec(chunk);
    const bare = (m?.[1] ?? chunk).trim().toLowerCase();
    if (bare.includes("@")) out.push(bare);
  }
  return out;
}

export function displayName(from: string): { email: string; name: string | null } {
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(from);
  if (m) return { email: (m[2] ?? "").trim().toLowerCase(), name: (m[1] ?? "").trim() || null };
  return { email: from.trim().toLowerCase(), name: null };
}

const TEXT_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const RELAY_LOCAL =
  /no-?reply|donotreply|^(notifications?|alerts?|jobs|careers|hr|talent|recruit)/i;

/** First email address found in a document, lower-cased. */
export function emailInText(text: string): string | null {
  return TEXT_EMAIL.exec(text)?.[0]?.toLowerCase() ?? null;
}

/**
 * The sender, when plausibly the applicant themself. Board notifications and
 * mailbox relays (no-reply@, notifications@, careers@…) must never become a
 * candidate's identity — every applicant would collapse into one record.
 */
export function applicantSender(sender: {
  email: string | null | undefined;
  name: string | null | undefined;
}): { email: string; name: string | null } | null {
  const email = (sender.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return null;
  if (RELAY_LOCAL.test(email.split("@")[0] ?? "")) return null;
  return { email, name: sender.name ?? null };
}

export type InboundAttachment = {
  filename: string;
  content: string;
  contentType?: string | undefined;
};

export type InboundMail = {
  to: string;
  from: string;
  subject?: string | null | undefined;
  text?: string | null | undefined;
  messageId?: string | null | undefined;
  attachments?: InboundAttachment[] | undefined;
};

export type InboundResult = {
  status: "imported" | "updated" | "stored" | "skipped" | "error";
  detail: string;
  messageId: string | null;
  candidateId?: string | null;
};

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

/** The open role whose title appears in the mail, so the CV joins the right pipeline. */
async function matchRequisition(orgId: string, haystack: string): Promise<string | null> {
  const rows = await db
    .select({ id: requisitions.id, title: requisitions.title })
    .from(requisitions)
    .where(and(eq(requisitions.orgId, orgId), eq(requisitions.status, "approved")));
  const text = haystack.toLowerCase();
  let best: { id: string; len: number } | null = null;
  for (const r of rows) {
    const title = (r.title ?? "").trim().toLowerCase();
    if (title.length > 3 && text.includes(title) && (!best || title.length > best.len)) {
      best = { id: r.id, len: title.length };
    }
  }
  return best?.id ?? null;
}

/**
 * Handle one inbound mail: resolve the tenant from the recipient, record it and
 * import any CV attachment. Never throws — every outcome is stored on the row so
 * HR can see exactly what happened to each mail.
 */
export async function receiveMail(mail: InboundMail): Promise<InboundResult> {
  const addresses = recipientAddresses(mail.to ?? "");
  const slug = localPart(mail.to ?? "");
  if (!slug)
    return { status: "error", detail: "No recipient address on the mail.", messageId: null };

  // Mail sent straight to the ATSIQ address, or forwarded from the organisation's
  // own careers address (careers@company.com) which it registered here.
  let org: { id: string; status: string | null } | null = null;
  if (addresses.length) {
    const [row] = await db
      .select({ id: organizations.id, status: organizations.status })
      .from(organizations)
      .where(inArray(organizations.careersEmail, addresses))
      .limit(1);
    org = row ?? null;
  }
  if (!org) {
    const [row] = await db
      .select({ id: organizations.id, status: organizations.status })
      .from(organizations)
      .where(ilike(organizations.inboxSlug, slug))
      .limit(1);
    org = row ?? null;
  }
  if (!org) {
    return {
      status: "error",
      detail: `No organisation owns the address ${slug}.`,
      messageId: null,
    };
  }

  if (org.status && org.status !== "active") {
    return { status: "error", detail: "That organisation is not active.", messageId: null };
  }

  const sender = displayName(mail.from ?? "");
  const { attachmentText, looksLikeCv } = await import("./cv-text.server");
  const attachments = (mail.attachments ?? []).filter((a) => looksLikeCv(a.filename ?? ""));
  const cv = attachments[0] ?? null;

  const row = {
    orgId: org.id,
    toAddress: mail.to,
    fromEmail: sender.email || null,
    fromName: sender.name,
    subject: mail.subject ?? null,
    body: (mail.text ?? "").slice(0, 20000) || null,
    attachmentName: cv?.filename ?? null,
    providerMessageId: mail.messageId ?? null,
    status: "received",
    receivedAt: new Date(),
  };

  let savedId: string;
  try {
    const [saved] = await db.insert(inboxMessages).values(row).returning({ id: inboxMessages.id });
    if (!saved) throw new Error("Could not record the mail.");
    savedId = saved.id;
  } catch (e) {
    // A duplicate delivery from the mail provider is not a failure.
    if ((e as { code?: string } | null)?.code === "23505") {
      return { status: "skipped", detail: "Already received.", messageId: null };
    }
    return {
      status: "error",
      detail: e instanceof Error ? e.message : "Could not record the mail.",
      messageId: null,
    };
  }

  const finish = async (result: InboundResult) => {
    await db
      .update(inboxMessages)
      .set({
        status: result.status === "stored" ? "received" : result.status,
        detail: result.detail,
        candidateId: result.candidateId ?? null,
      })
      .where(eq(inboxMessages.id, savedId));
    return { ...result, messageId: savedId };
  };

  // Pre-onboarding: a candidate who already has an offer mails their ID,
  // experience letters and payslips to the same careers address. Those files are
  // filed against their offer and read by the extraction agent for HR to validate.
  const filedDocs = await filePreOnboardingAttachments({
    orgId: org.id,
    senderEmail: sender.email,
    attachments: (mail.attachments ?? []).filter((a) => a.filename !== cv?.filename),
    inboxMessageId: savedId,
  });

  if (!cv) {
    return finish({
      status: filedDocs.length ? "stored" : "skipped",
      detail: filedDocs.length
        ? `${filedDocs.length} pre-onboarding document(s) filed for validation: ${filedDocs.join(", ")}.`
        : "No CV attached — nothing to file.",
      messageId: savedId,
    });
  }

  try {
    const bytes = base64ToBytes(cv.content);
    const text = await attachmentText(cv.filename, bytes);
    if (text.trim().length < 40) {
      return finish({
        status: "error",
        detail: "The attachment could not be read.",
        messageId: savedId,
      });
    }
    const requisitionId = await matchRequisition(
      org.id,
      `${mail.subject ?? ""} ${mail.text ?? ""} ${cv.filename}`,
    );
    const parsed = await parseCv(text, org.id);
    if (!parsed) {
      console.warn(
        `[careers-inbox] CV parse failed for ${cv.filename}; filing from the mail's own identity.`,
      );
    }
    // Identity must survive a failed AI parse: the CV text, then the sender —
    // but only when they plausibly are the applicant, never a board relay.
    const applicant = applicantSender(sender);
    const ingested = await ingestCandidate({
      resumeText: text,
      fileName: cv.filename,
      requisitionId,
      orgId: org.id,
      source: "careers_inbox",
      parsed,
      fullName: parsed?.full_name || applicant?.name || null,
      email: parsed?.email ?? emailInText(text) ?? applicant?.email ?? null,
      resumeFile: { filename: cv.filename, bytes },
    });
    await db
      .update(inboxMessages)
      .set({ requisitionId, attachmentBytes: bytes.length })
      .where(eq(inboxMessages.id, savedId));
    return finish({
      status: ingested.alreadyApplied ? "updated" : "imported",
      detail: `${ingested.name} (${ingested.email})${requisitionId ? " added to the matching role" : " filed in the talent pool"}.`,
      messageId: savedId,
      candidateId: ingested.candidateId,
    });
  } catch (e) {
    return finish({
      status: "error",
      detail: e instanceof Error ? e.message : "The CV could not be imported.",
      messageId: savedId,
    });
  }
}

/** Retry a stored mail whose import failed, using the attachment text we kept. */
export async function retryMessage(orgId: string, messageId: string): Promise<InboundResult> {
  const [msg] = await db
    .select({
      id: inboxMessages.id,
      orgId: inboxMessages.orgId,
      subject: inboxMessages.subject,
      body: inboxMessages.body,
      attachmentName: inboxMessages.attachmentName,
      fromEmail: inboxMessages.fromEmail,
      fromName: inboxMessages.fromName,
    })
    .from(inboxMessages)
    .where(and(eq(inboxMessages.id, messageId), eq(inboxMessages.orgId, orgId)))
    .limit(1);
  if (!msg) return { status: "error", detail: "That mail is no longer here.", messageId };

  const text = (msg.body ?? "").trim();
  if (text.length < 40) {
    return {
      status: "error",
      detail: "There is no readable CV text on this mail to retry.",
      messageId,
    };
  }
  try {
    const requisitionId = await matchRequisition(orgId, `${msg.subject ?? ""} ${text}`);
    const parsed = await parseCv(text, orgId);
    const applicant = applicantSender({ email: msg.fromEmail, name: msg.fromName });
    const ingested = await ingestCandidate({
      resumeText: text,
      fileName: msg.attachmentName ?? "mail-body.txt",
      requisitionId,
      orgId,
      source: "careers_inbox",
      parsed,
      fullName: parsed?.full_name || applicant?.name || null,
      email: parsed?.email ?? emailInText(text) ?? applicant?.email ?? null,
    });
    await db
      .update(inboxMessages)
      .set({
        status: ingested.alreadyApplied ? "updated" : "imported",
        detail: `${ingested.name} (${ingested.email}) filed from the mail body.`,
        candidateId: ingested.candidateId,
        requisitionId,
      })
      .where(eq(inboxMessages.id, msg.id));
    return {
      status: ingested.alreadyApplied ? "updated" : "imported",
      detail: `${ingested.name} filed.`,
      messageId,
      candidateId: ingested.candidateId,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Retry failed.";
    await db
      .update(inboxMessages)
      .set({ status: "error", detail })
      .where(eq(inboxMessages.id, msg.id));
    return { status: "error", detail, messageId };
  }
}

/**
 * Work through the mail that arrived at this organisation's own careers address
 * but has not yet produced a candidate — anything still "received", "stored" or
 * in error. Nothing to configure: the address is created with the organisation.
 */
export async function processPendingMail(
  orgId: string,
  max = 25,
): Promise<{
  scanned: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
}> {
  const rows = await db
    .select({ id: inboxMessages.id })
    .from(inboxMessages)
    .where(
      and(
        eq(inboxMessages.orgId, orgId),
        inArray(inboxMessages.status, ["received", "stored", "error"]),
      ),
    )
    .orderBy(desc(inboxMessages.receivedAt))
    .limit(max);

  const out = { scanned: 0, imported: 0, updated: 0, skipped: 0, errors: 0 };
  for (const row of rows) {
    out.scanned++;
    const result = await retryMessage(orgId, row.id);
    if (result.status === "imported") out.imported++;
    else if (result.status === "updated") out.updated++;
    else if (result.status === "error") out.skipped++;
    else out.skipped++;
  }
  return out;
}

/**
 * File the proof documents an offer-stage candidate mails to the careers
 * address. Anything that is not a CV, from a sender who already has an offer in
 * flight, becomes a pre-onboarding document awaiting HR validation.
 */
async function filePreOnboardingAttachments(input: {
  orgId: string;
  senderEmail: string;
  attachments: { filename?: string; content: string }[];
  inboxMessageId: string;
}): Promise<string[]> {
  if (!input.senderEmail) return [];
  const docs = input.attachments.filter((a) => a.filename && a.content);
  if (!docs.length) return [];

  const {
    offerContextForEmail,
    storeOnboardingDocument,
    guessDocType,
    docTypeLabel,
    expandUpload,
  } = await import("./onboarding.server");
  const ctx = await offerContextForEmail(input.orgId, input.senderEmail);
  if (!ctx) return [];

  const filed: string[] = [];
  for (const att of docs) {
    const fileName = att.filename as string;
    try {
      const bytes = base64ToBytes(att.content);
      if (!bytes.byteLength) continue;
      // A zipped bundle of proofs is filed as the documents inside it.
      for (const member of await expandUpload(fileName, bytes)) {
        const docType = guessDocType(member.fileName);
        await storeOnboardingDocument({
          orgId: input.orgId,
          applicationId: ctx.applicationId,
          candidateId: ctx.candidateId,
          offerId: ctx.offerId,
          docType,
          fileName: member.fileName,
          bytes: member.bytes,
          source: "careers_inbox",
          inboxMessageId: input.inboxMessageId,
        });
        filed.push(docTypeLabel(docType));
      }
    } catch {
      // One unreadable attachment must not fail the whole delivery.
    }
  }
  return filed;
}
