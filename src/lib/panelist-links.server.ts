/**
 * An external panelist's private scorecard link (docs/panel-directory.md):
 * /scorecard/<token>, one per panelist per interview, issued with their
 * interviewer brief and valid until seven days after the interview. Only the
 * SHA-256 of the token is stored; the token is the only key on the public side,
 * and it opens that one round's scorecard — nothing else about the organisation.
 * Every public call is rate-limited per caller (src/server.ts).
 */
import { createHash, createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import {
  applications,
  candidates,
  evaluations,
  interviews,
  organizations,
  panelistScorecardLinks,
  panelists,
  requisitions,
} from "@db/schema";
import { db } from "../server/db";

/** How long after the interview the link still opens. */
export const LINK_DAYS_AFTER = 7;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * The directory panelist with this e-mail who scores through a private link,
 * or null: an external panelist, or an internal one without a login (no active
 * org member with that e-mail). Org members score signed in.
 */
export async function linkPanelist(orgId: string, email: string) {
  const e = email.trim().toLowerCase();
  const [p] = await db
    .select({
      id: panelists.id,
      name: panelists.fullName,
      email: panelists.email,
      kind: panelists.kind,
    })
    .from(panelists)
    .where(
      and(
        eq(panelists.orgId, orgId),
        eq(panelists.active, true),
        sql`lower(${panelists.email}) = ${e}`,
        sql`(${panelists.kind} = 'external' or not exists (
          select 1 from org_members m
          where m.org_id = ${orgId} and m.status = 'active' and lower(m.email) = ${e}))`,
      ),
    )
    .limit(1);
  return p ?? null;
}

/**
 * Issue an external panelist's scorecard link for one interview. Returns the
 * token to put in their brief — it is never stored. The token is derived (HMAC
 * of the server secret, interview, panelist and booked time), so a brief sent
 * twice carries the same link, and a reschedule replaces it.
 */
export async function issueScorecardLink(
  orgId: string,
  interviewId: string,
  panelistId: string,
  scheduledAt: Date,
): Promise<string> {
  const { env } = await import("../server/env");
  const token = createHmac("sha256", `scorecard-link:${env.SESSION_SECRET}`)
    .update(`${orgId}:${interviewId}:${panelistId}:${scheduledAt.toISOString()}`)
    .digest("hex");
  const expiresAt = new Date(scheduledAt.getTime() + LINK_DAYS_AFTER * 864e5);
  await db
    .insert(panelistScorecardLinks)
    .values({ orgId, interviewId, panelistId, tokenHash: hashToken(token), expiresAt })
    .onConflictDoUpdate({
      target: [panelistScorecardLinks.interviewId, panelistScorecardLinks.panelistId],
      // Same booked time: the same token, still usable. A new time: a new link.
      set: { tokenHash: hashToken(token), expiresAt },
    });
  return token;
}

type Resolved = {
  linkId: string;
  orgId: string;
  interviewId: string;
  applicationId: string;
  level: number;
  scheduledAt: Date | null;
  panelist: { name: string; email: string };
  candidateName: string;
  jobTitle: string;
  orgName: string;
  used: boolean;
  expired: boolean;
};

async function resolve(token: string): Promise<Resolved | null> {
  const [r] = await db
    .select({
      linkId: panelistScorecardLinks.id,
      orgId: panelistScorecardLinks.orgId,
      interviewId: interviews.id,
      applicationId: interviews.applicationId,
      level: interviews.level,
      scheduledAt: interviews.scheduledAt,
      name: panelists.fullName,
      email: panelists.email,
      active: panelists.active,
      candidateName: candidates.fullName,
      jobTitle: requisitions.title,
      orgName: organizations.name,
      usedAt: panelistScorecardLinks.usedAt,
      expiresAt: panelistScorecardLinks.expiresAt,
    })
    .from(panelistScorecardLinks)
    .innerJoin(
      interviews,
      and(
        eq(interviews.id, panelistScorecardLinks.interviewId),
        eq(interviews.orgId, panelistScorecardLinks.orgId),
      ),
    )
    .innerJoin(
      panelists,
      and(
        eq(panelists.id, panelistScorecardLinks.panelistId),
        eq(panelists.orgId, panelistScorecardLinks.orgId),
      ),
    )
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, panelistScorecardLinks.orgId))
    .where(eq(panelistScorecardLinks.tokenHash, hashToken(token)))
    .limit(1);
  if (!r || !r.active) return null;
  return {
    linkId: r.linkId,
    orgId: r.orgId,
    interviewId: r.interviewId,
    applicationId: r.applicationId,
    level: r.level,
    scheduledAt: r.scheduledAt,
    panelist: { name: r.name, email: r.email.toLowerCase() },
    candidateName: r.candidateName,
    jobTitle: r.jobTitle,
    orgName: r.orgName,
    used: Boolean(r.usedAt),
    expired: r.expiresAt.getTime() < Date.now(),
  };
}

export type PublicScorecard = {
  orgName: string;
  candidateName: string;
  jobTitle: string;
  level: number;
  panelistName: string;
  scheduledAt: string | null;
  competencies: string[];
  weights: Record<string, number>;
  anchors: Record<string, { low: string; mid: string; high: string }>;
  state: "open" | "submitted" | "expired" | "not_yet";
  /** The candidate's profile, CV and the round's focus — only while the link is valid. */
  brief: import("./panel-brief").PanelBrief | null;
};

/**
 * What the external panelist's page shows: the round, its rubric and the
 * candidate's profile and CV (no match or screening — internal material).
 * Nothing about the candidate once the link has expired.
 */
export async function publicScorecard(token: string): Promise<PublicScorecard | null> {
  const r = await resolve(token);
  if (!r) return null;
  const [done] = await db
    .select({ id: evaluations.id })
    .from(evaluations)
    .where(
      and(
        eq(evaluations.orgId, r.orgId),
        eq(evaluations.interviewId, r.interviewId),
        sql`lower(coalesce(${evaluations.evaluatorEmail}, ${evaluations.evaluator})) = ${r.panelist.email}`,
      ),
    )
    .limit(1);
  const { planFor } = await import("./interview-plan.server");
  const { roundOf } = await import("./interview-plan");
  const [app] = await db
    .select({ requisitionId: applications.requisitionId })
    .from(applications)
    .where(and(eq(applications.id, r.applicationId), eq(applications.orgId, r.orgId)))
    .limit(1);
  const round = app ? roundOf((await planFor(r.orgId, app.requisitionId)).plan, r.level) : null;
  const { panelBrief } = await import("./panel-brief.server");
  const brief = r.expired ? null : await panelBrief(r.orgId, r.interviewId, { internal: false });
  return {
    orgName: r.orgName,
    candidateName: r.candidateName,
    jobTitle: r.jobTitle,
    level: r.level,
    panelistName: r.panelist.name,
    scheduledAt: r.scheduledAt?.toISOString() ?? null,
    competencies: round?.competencies ?? [],
    weights: round?.weights ?? {},
    anchors: round?.anchors ?? {},
    brief,
    state:
      done || r.used
        ? "submitted"
        : r.expired
          ? "expired"
          : r.scheduledAt && r.scheduledAt.getTime() > Date.now()
            ? "not_yet"
            : "open",
  };
}

/** Submit the external panelist's one, final scorecard for the round. Audited. */
export async function submitByLink(
  token: string,
  input: {
    verdict: "select" | "hold" | "reject";
    comments: string | null;
    reason: string | null;
    competencies: { name: string; rating: number }[];
  },
) {
  const r = await resolve(token);
  if (!r) throw new Error("This link is not valid.");
  if (r.used) throw new Error("You have already scored this round — scorecards are final.");
  if (r.expired) throw new Error("This link has expired. Please contact the hiring team.");
  const { submitScorecardCore } = await import("./interviews.functions");
  const result = await submitScorecardCore(
    {
      orgId: r.orgId,
      userId: null,
      email: r.panelist.email,
      actor: `external:${r.panelist.email}`,
    },
    {
      interviewId: r.interviewId,
      applicationId: r.applicationId,
      level: r.level,
      verdict: input.verdict,
      comments: input.comments,
      reason: input.reason,
      competencies: input.competencies,
    },
  );
  await db
    .update(panelistScorecardLinks)
    .set({ usedAt: new Date() })
    .where(eq(panelistScorecardLinks.id, r.linkId));
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `external:${r.panelist.email}`,
    orgId: r.orgId,
    action: "scorecard.submitted_by_link",
    entityType: "interview",
    entityId: r.interviewId,
    detail: { level: r.level, verdict: input.verdict },
  });
  return { ok: true as const, roundComplete: result.roundComplete };
}
