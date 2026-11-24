/**
 * The interviewer's own invite and brief, sent whenever a round is booked or
 * re-scheduled (Interviews page, Interview coordinator, or a candidate picking
 * a time): when and where, a calendar file, who the candidate is, how they
 * matched and screened, and the links to their profile and the scorecard.
 * Internal mail to an organisation member — governed by the email master
 * switch only.
 */
import { and, asc, desc, eq, lt } from "drizzle-orm";

import { latestRoundTime, type Stage } from "./lifecycle";
import { db } from "../server/db";
import {
  applications,
  candidates,
  evaluations,
  matchScores,
  organizations,
  requisitions,
  screeningRuns,
} from "@db/schema";
import { env } from "../server/env";
import { buildIcs } from "./ics";

/** The first sentence — a brief never ends mid-word on "…". */
export const firstSentence = (s: string | null | undefined): string | undefined => {
  const t = s?.trim();
  if (!t) return undefined;
  const m = t.match(/^.+?[.!?](?=\s|$)/s);
  return (m ? m[0] : t).replace(/\s+/g, " ");
};

/** "Dindigul, Tamil Nadu - 624005" → "Dindigul, Tamil Nadu". */
export const placeOnly = (s: string | null | undefined): string | undefined =>
  s?.replace(/[\s,-]*\b\d{5,6}\b\s*$/, "").trim() || undefined;

/** How the round's time was set, for the panel — from the booking's actor label. */
export function bookedTextOf(actor: string | undefined): string | undefined {
  if (!actor) return undefined;
  if (/AI scheduling call/i.test(actor)) return "Confirmed by the candidate on a scheduling call";
  if (/^candidate/i.test(actor)) return "Picked by the candidate";
  return `Booked by ${actor}; the candidate is sent the invite once the whole panel accepts`;
}

export async function sendInterviewerBrief(
  orgId: string,
  r: {
    interviewId: string;
    applicationId: string;
    candidateId: string;
    level: number;
    interviewerName: string | null;
    interviewerEmail: string;
    scheduledAt: Date;
    durationMins: number;
    mode: string;
    meetingLink: string | null;
    agenda: string | null;
    /** Everyone on the panel (names or emails), when more than one. */
    panelNames?: (string | null)[];
    /** Who set the time (the booking's actor label). */
    bookedBy?: string;
  },
): Promise<void> {
  const [ctx] = await db
    .select({
      jobTitle: requisitions.title,
      orgName: organizations.name,
      name: candidates.fullName,
      employer: candidates.currentEmployer,
      years: candidates.experienceYears,
      location: candidates.location,
      skills: candidates.skills,
      appliedAt: applications.appliedAt,
      slaDays: organizations.hiringSlaDays,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, applications.orgId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.id, r.applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!ctx) return;
  const [score] = await db
    .select({ overall: matchScores.overallScore, rationale: matchScores.rationale })
    .from(matchScores)
    .where(eq(matchScores.applicationId, r.applicationId))
    .orderBy(desc(matchScores.computedAt))
    .limit(1);
  const [screen] = await db
    .select({
      recommendation: screeningRuns.recommendation,
      reason: screeningRuns.recommendationReason,
    })
    .from(screeningRuns)
    .where(and(eq(screeningRuns.applicationId, r.applicationId), eq(screeningRuns.orgId, orgId)))
    .orderBy(desc(screeningRuns.createdAt))
    .limit(1);

  // A panelist without an account (external, or internal with no login) scores
  // through a private link. An external one's brief also leaves out
  // internal-only material: match score and screening result. The candidate
  // page needs a sign-in, so neither gets that link.
  const { linkPanelist, issueScorecardLink } = await import("./panelist-links.server");
  const byLink = await linkPanelist(orgId, r.interviewerEmail);
  const external = byLink?.kind === "external" ? byLink : null;
  const scorecardToken = byLink
    ? await issueScorecardLink(orgId, r.interviewId, byLink.id, r.scheduledAt)
    : null;
  // Their own accept / can't-make-it link for this round and time.
  let confirmUrl: string | undefined;
  let confirmToken = "";
  let confirmed = false;
  try {
    const { panelistConfirmation } = await import("./interview-confirmations.server");
    const c = await panelistConfirmation(orgId, r.interviewId, r.scheduledAt, {
      name: r.interviewerName,
      email: r.interviewerEmail,
    });
    confirmToken = c.token;
    // Still waiting on the brief they already have for this time: nothing to send.
    if (!c.created) {
      const { emailOutbox } = await import("@db/schema");
      const { like } = await import("drizzle-orm");
      const [sent] = await db
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(
          and(
            eq(emailOutbox.orgId, orgId),
            like(
              emailOutbox.idempotencyKey,
              `interviewer-brief:${r.interviewId}:${r.interviewerEmail.toLowerCase()}:${r.scheduledAt.toISOString()}%`,
            ),
          ),
        )
        .limit(1);
      if (sent) return;
    }
    // Accepted panelists keep the link: it is where they move the time or step down.
    confirmed = c.state === "accepted";
    if (c.state === "pending" || c.state === "accepted")
      confirmUrl = `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/confirm/${c.token}`;
  } catch {
    /* the brief goes out either way */
  }
  const { enqueueEmail, formatInOrgTZ, getOrgEmailSettings } =
    await import("./email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const site = env.PUBLIC_SITE_URL.replace(/\/$/, "");
  const roundLabel = `L${r.level} interview`;
  const modeLabel = r.mode === "online" ? "Online" : r.mode === "onsite" ? "Onsite" : "Phone";
  const ics = buildIcs({
    uid: `interview-${r.interviewId}-panel@atsiq`,
    title: `${roundLabel}: ${ctx.name} — ${ctx.jobTitle}`,
    description: [r.meetingLink, r.agenda].filter(Boolean).join("\n") || null,
    location: r.meetingLink ?? (r.mode === "onsite" ? ctx.orgName : null),
    startsAt: r.scheduledAt.toISOString(),
    durationMins: r.durationMins,
    attendees: [r.interviewerEmail],
  });
  const profile = [
    ctx.employer,
    ctx.years != null ? `${Number(ctx.years)} years' experience` : null,
    placeOnly(ctx.location),
  ]
    .filter(Boolean)
    .join(" · ");
  await enqueueEmail({
    orgId,
    kind: "interviewer_brief",
    templateName: "interviewer_brief",
    toEmail: r.interviewerEmail,
    applicationId: r.applicationId,
    // Each ask is its own brief: going back to an earlier time sends it again.
    idempotencyKey: `interviewer-brief:${r.interviewId}:${r.interviewerEmail.toLowerCase()}:${r.scheduledAt.toISOString()}${confirmToken ? `:${confirmToken.slice(0, 12)}` : ""}`,
    templateData: {
      interviewerName: r.interviewerName ?? undefined,
      orgName: ctx.orgName,
      candidateName: ctx.name,
      jobTitle: ctx.jobTitle,
      roundLabel,
      scheduledAtText: formatInOrgTZ(r.scheduledAt, tz),
      // The hiring SLA's latest time for this round: a move never goes past it.
      latestText: formatInOrgTZ(
        latestRoundTime(`l${r.level}` as Stage, ctx.appliedAt, r.scheduledAt, ctx.slaDays),
        tz,
      ),
      durationMins: String(r.durationMins),
      modeLabel,
      whereText: r.meetingLink ?? undefined,
      profile: profile || undefined,
      skills: (ctx.skills ?? []).slice(0, 8).join(", ") || undefined,
      matchText:
        score && !external
          ? `${score.overall}/100${score.rationale ? ` — ${firstSentence(score.rationale)}` : ""}`
          : undefined,
      screeningText:
        screen?.recommendation && !external
          ? `${screen.recommendation}${screen.reason ? ` — ${firstSentence(screen.reason)}` : ""}`
          : undefined,
      bookedText: await bookedTextFor(orgId, r),
      confirmUrl,
      confirmed: confirmed ? "yes" : undefined,
      earlierRounds: external ? undefined : await earlierRoundsOf(orgId, r.applicationId, r.level),
      ...(r.panelNames && r.panelNames.length > 1
        ? { panelText: r.panelNames.filter(Boolean).join(", ") }
        : {}),
      ...(await rubricFor(orgId, r.applicationId, r.level)),
      ...(await mobileAskFor(orgId, r.interviewerEmail)),
      ...(scorecardToken
        ? { scorecardUrl: `${site}/scorecard/${scorecardToken}` }
        : {
            candidateUrl: `${site}/candidates/${r.candidateId}`,
            scorecardUrl: `${site}/interviews/mine`,
          }),
    },
    attachments: [
      {
        filename: `interview-l${r.level}-panel.ics`,
        contentBase64: Buffer.from(ics, "utf8").toString("base64"),
        contentType: "text/calendar",
      },
    ],
  });
}

/** How the time was set, plus a warning when this panelist's calendar was never checked. */
async function bookedTextFor(
  orgId: string,
  r: { interviewerEmail: string; scheduledAt: Date; durationMins: number; bookedBy?: string },
): Promise<string | undefined> {
  const how = bookedTextOf(r.bookedBy);
  let unchecked = false;
  try {
    const { busyFor } = await import("./calendar-availability.server");
    const email = r.interviewerEmail.toLowerCase();
    const end = new Date(r.scheduledAt.getTime() + r.durationMins * 60_000);
    unchecked = (await busyFor(orgId, [email], r.scheduledAt, end)).unknown.includes(email);
  } catch {
    unchecked = true;
  }
  const warn = unchecked ? "Your calendar could not be checked for this time." : undefined;
  return [how ? `${how}.` : undefined, warn].filter(Boolean).join(" ") || undefined;
}

/**
 * Earlier rounds' scorecards, one line each: "L1 (Priya): select — RAG 4, Git 3.
 * Clear on retrieval." Internal panelists only; the caller leaves it out for
 * external ones.
 */
export async function earlierRoundsOf(
  orgId: string,
  applicationId: string,
  level: number,
): Promise<string | undefined> {
  if (level <= 1) return undefined;
  const rows = await db
    .select({
      level: evaluations.level,
      evaluator: evaluations.evaluator,
      email: evaluations.evaluatorEmail,
      recommendation: evaluations.recommendation,
      rating: evaluations.rating,
      competencies: evaluations.competencies,
      comments: evaluations.comments,
    })
    .from(evaluations)
    .where(
      and(
        eq(evaluations.orgId, orgId),
        eq(evaluations.applicationId, applicationId),
        lt(evaluations.level, level),
      ),
    )
    .orderBy(asc(evaluations.level), asc(evaluations.createdAt));
  const lines = rows.map((e) => {
    const comps = ((e.competencies ?? []) as { name?: string; rating?: number }[])
      .filter((c) => c?.name && c.rating)
      .map((c) => `${c.name} ${c.rating}`);
    const scores = comps.length ? comps.join(", ") : e.rating ? `overall ${e.rating}/5` : null;
    const note = firstSentence(e.comments);
    return `L${e.level} (${e.evaluator || e.email || "interviewer"}): ${e.recommendation}${scores ? ` — ${scores}.` : "."}${note ? ` ${note}` : ""}`;
  });
  return lines.length ? lines.join("\n") : `No scorecard from L${level - 1} yet.`;
}

/** The round's focus and competencies from the role's interview plan. */
async function rubricFor(
  orgId: string,
  applicationId: string,
  level: number,
): Promise<{ roundFocus?: string; competencies?: string }> {
  try {
    const { progressOf } = await import("./interview-plan.server");
    const { roundOf } = await import("./interview-plan");
    const { plan } = await progressOf(orgId, applicationId);
    const round = roundOf(plan, level);
    if (!round) return {};
    return {
      roundFocus: `${round.name}${round.focus ? ` — ${round.focus}` : ""}`,
      competencies: round.competencies.join(", "),
    };
  } catch {
    return {};
  }
}

/** The add-your-mobile link while the panellist has none on file (0093). */
async function mobileAskFor(orgId: string, email: string): Promise<{ mobileUrl?: string }> {
  const { panelists } = await import("@db/schema");
  const { and, eq, sql } = await import("drizzle-orm");
  const [p] = await db
    .select({ id: panelists.id, phone: panelists.phone, out: panelists.aiCallOptOutAt })
    .from(panelists)
    .where(
      and(
        eq(panelists.orgId, orgId),
        eq(panelists.active, true),
        sql`lower(${panelists.email}) = ${email.trim().toLowerCase()}`,
      ),
    )
    .limit(1);
  if (!p || p.phone || p.out) return {};
  const { mobileUrl } = await import("./panelist-mobile.server");
  return { mobileUrl: await mobileUrl(orgId, p.id) };
}
