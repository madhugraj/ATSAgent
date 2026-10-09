/**
 * The interviewer's own invite and brief, sent whenever a round is booked or
 * re-scheduled (Interviews page, Interview coordinator, or a candidate picking
 * a time): when and where, a calendar file, who the candidate is, how they
 * matched and screened, and the links to their profile and the scorecard.
 * Internal mail to an organisation member — governed by the email master
 * switch only.
 */
import { and, desc, eq } from "drizzle-orm";

import { db } from "../server/db";
import {
  applications,
  candidates,
  matchScores,
  organizations,
  requisitions,
  screeningRuns,
} from "@db/schema";
import { env } from "../server/env";
import { buildIcs } from "./ics";

const clip = (s: string | null | undefined, n: number) =>
  s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : undefined;

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
    ctx.employer ? `currently at ${ctx.employer}` : null,
    ctx.years != null ? `${Number(ctx.years)} years` : null,
    ctx.location,
  ]
    .filter(Boolean)
    .join(" · ");
  await enqueueEmail({
    orgId,
    kind: "interviewer_brief",
    templateName: "interviewer_brief",
    toEmail: r.interviewerEmail,
    applicationId: r.applicationId,
    idempotencyKey: `interviewer-brief:${r.interviewId}:${r.interviewerEmail.toLowerCase()}:${r.scheduledAt.toISOString()}`,
    templateData: {
      interviewerName: r.interviewerName ?? undefined,
      orgName: ctx.orgName,
      candidateName: ctx.name,
      jobTitle: ctx.jobTitle,
      roundLabel,
      scheduledAtText: formatInOrgTZ(r.scheduledAt, tz),
      durationMins: String(r.durationMins),
      modeLabel,
      whereText: r.meetingLink ?? undefined,
      profile: profile || undefined,
      skills: (ctx.skills ?? []).slice(0, 8).join(", ") || undefined,
      matchText: score
        ? `${score.overall}/100${score.rationale ? ` — ${clip(score.rationale, 220)}` : ""}`
        : undefined,
      screeningText: screen?.recommendation
        ? `${screen.recommendation}${screen.reason ? ` — ${clip(screen.reason, 220)}` : ""}`
        : undefined,
      agenda: r.agenda ?? undefined,
      ...(r.panelNames && r.panelNames.length > 1
        ? { panelText: r.panelNames.filter(Boolean).join(", ") }
        : {}),
      ...(await rubricFor(orgId, r.applicationId, r.level)),
      candidateUrl: `${site}/candidates/${r.candidateId}`,
      scorecardUrl: `${site}/interviews/mine`,
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
