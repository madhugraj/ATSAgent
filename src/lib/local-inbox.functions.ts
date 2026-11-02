/**
 * Server functions for the organisation's own careers inbox: the address, the
 * mail that has arrived, and the manual retry / remove actions.
 */
import { and, desc, eq, ilike, ne } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { inboxMessages, organizations } from "@db/schema";
import { requireOrg } from "./auth.middleware";

export type InboxRow = {
  id: string;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  attachment_name: string | null;
  status: string;
  detail: string | null;
  candidate_id: string | null;
  requisition_id: string | null;
  received_at: string;
};

export type InboxView = {
  address: string | null;
  slug: string | null;
  careersEmail: string | null;
  messages: InboxRow[];
  counts: { total: number; imported: number; updated: number; skipped: number; errors: number };
};

export const orgInbox = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<InboxView> => {
    const { inboxAddress } = await import("./local-inbox.server");
    const [org] = await db
      .select({ inboxSlug: organizations.inboxSlug, careersEmail: organizations.careersEmail })
      .from(organizations)
      .where(eq(organizations.id, context.orgId))
      .limit(1);

    const rows = await db
      .select({
        id: inboxMessages.id,
        from_email: inboxMessages.fromEmail,
        from_name: inboxMessages.fromName,
        subject: inboxMessages.subject,
        attachment_name: inboxMessages.attachmentName,
        status: inboxMessages.status,
        detail: inboxMessages.detail,
        candidate_id: inboxMessages.candidateId,
        requisition_id: inboxMessages.requisitionId,
        received_at: inboxMessages.receivedAt,
      })
      .from(inboxMessages)
      .where(eq(inboxMessages.orgId, context.orgId))
      .orderBy(desc(inboxMessages.receivedAt))
      .limit(500);

    const messages: InboxRow[] = rows.map((r) => ({
      ...r,
      received_at: r.received_at.toISOString(),
    }));
    return {
      slug: org?.inboxSlug ?? null,
      careersEmail: org?.careersEmail ?? null,
      address: inboxAddress(org?.inboxSlug),
      messages,
      counts: {
        total: messages.length,
        imported: messages.filter((m) => m.status === "imported").length,
        updated: messages.filter((m) => m.status === "updated").length,
        skipped: messages.filter((m) => m.status === "skipped").length,
        errors: messages.filter((m) => m.status === "error").length,
      },
    };
  });

export const retryInboxMessage = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ messageId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { retryMessage } = await import("./local-inbox.server");
    return retryMessage(context.orgId, data.messageId);
  });

export const removeInboxMessage = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ messageId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    await db
      .delete(inboxMessages)
      .where(and(eq(inboxMessages.id, data.messageId), eq(inboxMessages.orgId, context.orgId)));
    return { ok: true as const };
  });

/**
 * Register (or clear) the organisation's own careers address, e.g. careers@yavar.ai.
 * Mail forwarded from that address is filed against this organisation. The address
 * must belong to the organisation's own company domain, and no other organisation
 * can claim the same one.
 */
export const saveCareersEmail = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ email: z.string().max(320).nullish() }).parse(data))
  .handler(async ({ data, context }) => {
    const email = (data.email ?? "").trim().toLowerCase();
    if (!email) {
      await db
        .update(organizations)
        .set({ careersEmail: null })
        .where(eq(organizations.id, context.orgId));
      return { ok: true as const, careersEmail: null };
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error("That does not look like an email address.");
    }

    const { registrableDomain } = await import("./work-email");
    const [org] = await db
      .select({ emailDomain: organizations.emailDomain })
      .from(organizations)
      .where(eq(organizations.id, context.orgId))
      .limit(1);
    const own = org?.emailDomain ? registrableDomain(org.emailDomain) : null;
    if (own && registrableDomain(email) !== own) {
      throw new Error(`Use an address on your own domain (@${own}).`);
    }

    const [taken] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(ilike(organizations.careersEmail, email), ne(organizations.id, context.orgId)))
      .limit(1);
    if (taken) throw new Error("Another organisation has already registered that address.");

    await db
      .update(organizations)
      .set({ careersEmail: email })
      .where(eq(organizations.id, context.orgId));
    return { ok: true as const, careersEmail: email };
  });
