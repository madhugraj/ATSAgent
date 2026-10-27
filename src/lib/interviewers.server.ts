/**
 * Interviewer profiles (docs/interview-panel-plan.md, P0): who interviews, the
 * areas they assess, the rounds they take and how many interviews a week at
 * most — registered once by the admin, used later to propose each role's panel.
 * Every query is scoped to the organisation; changes are audited.
 */
import { and, eq } from "drizzle-orm";

import { memberInterviewerProfiles, orgMembers } from "@db/schema";
import { writeAudit } from "../server/audit";
import { db } from "../server/db";

export type InterviewerProfile = {
  active: boolean;
  areas: string[];
  rounds: number[];
  weeklyCap: number;
};

export const DEFAULT_INTERVIEWER: InterviewerProfile = {
  active: false,
  areas: [],
  rounds: [1, 2, 3],
  weeklyCap: 4,
};

/** Areas as people type them: trimmed, de-duplicated (case-insensitive), at most 20 (pure). */
export function cleanAreas(areas: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of areas) {
    const a = raw.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!a || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out.slice(0, 20);
}

/** Every member of the organisation with their interviewer profile (or the default). */
export async function interviewerProfilesOf(orgId: string) {
  const rows = await db
    .select({
      memberId: orgMembers.id,
      email: orgMembers.email,
      fullName: orgMembers.fullName,
      status: orgMembers.status,
      profile: memberInterviewerProfiles,
    })
    .from(orgMembers)
    .leftJoin(
      memberInterviewerProfiles,
      and(
        eq(memberInterviewerProfiles.memberId, orgMembers.id),
        eq(memberInterviewerProfiles.orgId, orgId),
      ),
    )
    .where(eq(orgMembers.orgId, orgId));
  return rows.map((r) => ({
    memberId: r.memberId,
    email: r.email,
    fullName: r.fullName,
    status: r.status,
    profile: r.profile
      ? {
          active: r.profile.active,
          areas: r.profile.areas,
          rounds: [...r.profile.rounds].sort(),
          weeklyCap: r.profile.weeklyCap,
        }
      : DEFAULT_INTERVIEWER,
  }));
}

/** Save a member's interviewer profile (the caller has checked the role). Audited. */
export async function setInterviewerProfileCore(
  orgId: string,
  actor: { userId: string; memberEmail: string },
  memberId: string,
  input: InterviewerProfile,
): Promise<InterviewerProfile> {
  const [member] = await db
    .select({ id: orgMembers.id, email: orgMembers.email })
    .from(orgMembers)
    .where(and(eq(orgMembers.id, memberId), eq(orgMembers.orgId, orgId)))
    .limit(1);
  if (!member) throw new Error("Member not found in your organisation.");
  const rounds = [...new Set(input.rounds)].filter((r) => r >= 1 && r <= 3).sort();
  if (!rounds.length) throw new Error("Choose at least one interview round.");
  const values = {
    active: input.active,
    areas: cleanAreas(input.areas),
    rounds,
    weeklyCap: Math.min(20, Math.max(1, Math.round(input.weeklyCap))),
  };
  const now = new Date();
  await db
    .insert(memberInterviewerProfiles)
    .values({ orgId, memberId, ...values, updatedBy: actor.userId, updatedAt: now })
    .onConflictDoUpdate({
      target: memberInterviewerProfiles.memberId,
      set: { ...values, updatedBy: actor.userId, updatedAt: now },
    });
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId,
    action: "member.interviewer_profile.set",
    entityType: "org_member",
    entityId: memberId,
    detail: { member: member.email, ...values },
  });
  return values;
}
