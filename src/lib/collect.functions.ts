/**
 * One click for HR: gather everything the live job posts have brought in, read
 * each CV, file it against the right requisition, then score it in the
 * background so the pipeline is already ranked when HR looks at it.
 */
import { eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { env } from "../server/env";
import { orgLinkedinConnections, organizations } from "@db/schema";
import { requireOrg } from "./auth.middleware";

const Input = z.object({
  requisitionId: z.string().uuid().nullable().optional(),
  max: z.number().int().min(1).max(50).optional(),
});

export type CollectSummary = {
  /** CVs read out of the careers mailbox (LinkedIn application mail included). */
  scanned: number;
  imported: number;
  updated: number;
  skipped: number;
  importErrors: number;
  /** Background scoring of everything not yet scored. */
  scored: number;
  scoreErrors: number;
  /** Plain-English note when LinkedIn itself will not hand over applicants. */
  linkedinNote: string | null;
  mailboxNote: string | null;
  top: { candidate: string; requisition: string; score: number }[];
};

export const collectApplicants = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => Input.parse(data ?? {}))
  .handler(async ({ data, context }): Promise<CollectSummary> => {
    const orgId = context.orgId;

    const summary: CollectSummary = {
      scanned: 0,
      imported: 0,
      updated: 0,
      skipped: 0,
      importErrors: 0,
      scored: 0,
      scoreErrors: 0,
      linkedinNote: null,
      mailboxNote: null,
      top: [],
    };

    // 1. LinkedIn's own applicant feed, when the contract opens it.
    try {
      const { probeCapabilities } = await import("./linkedin.server");
      const [conn] = await db
        .select({
          accessToken: orgLinkedinConnections.accessToken,
          scope: orgLinkedinConnections.scope,
        })
        .from(orgLinkedinConnections)
        .where(eq(orgLinkedinConnections.orgId, orgId))
        .limit(1);
      if (!conn) {
        summary.linkedinNote = "LinkedIn is not connected for your organisation yet.";
      } else {
        const { decryptSecret } = await import("../server/crypto");
        const caps = await probeCapabilities(decryptSecret(conn.accessToken), conn.scope ?? null);
        const apps = caps.find((c) => c.id === "applications");
        summary.linkedinNote = apps?.ready
          ? null
          : (apps?.detail ??
            "LinkedIn is not handing over applicants for this account, so CVs come in through your apply link and careers mailbox.");
      }
    } catch (e) {
      summary.linkedinNote = e instanceof Error ? e.message : "Could not check LinkedIn.";
    }

    // 2a. The organisation's own ATSIQ careers address — always on, nothing to
    // configure. LinkedIn application mail and direct CVs land here.
    try {
      const { processPendingMail, inboxAddress } = await import("./local-inbox.server");
      const [org] = await db
        .select({ inboxSlug: organizations.inboxSlug })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      const address = inboxAddress(org?.inboxSlug);
      const mailReceivingLive = Boolean(env.INBOUND_EMAIL_SECRET);
      if (address) {
        const run = await processPendingMail(orgId, data.max ?? 25);
        summary.scanned += run.scanned;
        summary.imported += run.imported;
        summary.updated += run.updated;
        summary.skipped += run.skipped;
        summary.mailboxNote = mailReceivingLive
          ? `Reading your careers address ${address}. Point your LinkedIn job posts and job-board alerts there and every CV files itself.`
          : `Your careers address ${address} is reserved but not receiving mail yet — incoming mail still has to be routed to ATSIQ, so nothing can arrive here today. Until that is switched on, CVs come in through your ATSIQ apply link and the browser companion.`;
      } else {
        summary.mailboxNote =
          "Your organisation does not have a careers address yet — ask your ATSIQ administrator to finish onboarding.";
      }
    } catch (e) {
      summary.mailboxNote = e instanceof Error ? e.message : "Could not read your careers mail.";
    }

    // 3. Score everything still unscored, so HR never has to run matching by hand.
    const { scoreUnscored } = await import("./autoscore.server");
    const scoring = await scoreUnscored({
      orgId,
      requisitionId: data.requisitionId ?? null,
      limit: 25,
    });
    summary.scored = scoring.scored;
    summary.scoreErrors = scoring.errors;
    summary.top = scoring.outcomes
      .filter((o) => o.status === "scored" && o.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 5)
      .map((o) => ({ candidate: o.candidate, requisition: o.requisition, score: o.score ?? 0 }));

    return summary;
  });
