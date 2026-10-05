/**
 * Return on Individual — server side.
 *
 * Reads hiring records for one organisation, folds them against that
 * organisation's Talent Brain, and returns the CHRO view: what each hire
 * returns, what programmes the hired talent can staff, and where the
 * organisation is strong or exposed. The product super admin may point the
 * same lens at any organisation.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";

import { requireIdentity } from "@/lib/auth.middleware";
import { db } from "../server/db";
import {
  applications,
  candidates,
  departments,
  matchScores,
  offers,
  organizations,
  orgMembers,
  platformAdmins,
  requisitions,
  skillNodes,
  userRoles,
} from "@db/schema";
import { buildOntology, type OntologyNode } from "./ontology.server";
import { buildRoi, type RoiHireInput, type RoiReport } from "./roi.server";

export type RoiOrgOption = { id: string; name: string; status: string };

export type RoiView = RoiReport & {
  orgId: string;
  orgName: string | null;
  currency: string;
  superUser: boolean;
  /** Organisations the caller may switch between (product super admin only). */
  orgOptions: RoiOrgOption[];
};

/** The RoI lens is leadership-grade: CHRO, HR head, owner or the product super admin. */
async function requireRoiAccess(userId: string, email: string | null, wantedOrgId?: string) {
  const [member] = await db
    .select({
      orgId: orgMembers.orgId,
      isOwner: orgMembers.isOwner,
      orgName: organizations.name,
      currency: organizations.currency,
    })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.status, "active")))
    .orderBy(orgMembers.createdAt)
    .limit(1);

  let superUser = false;
  if (email) {
    const [pa] = await db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(ilike(platformAdmins.email, email.toLowerCase()))
      .limit(1);
    superUser = Boolean(pa);
  }

  // A super admin may point the lens at any organisation.
  if (wantedOrgId && wantedOrgId !== member?.orgId) {
    if (!superUser) {
      throw new Error("Cross-organisation analysis is limited to the product super admin.");
    }
    const [org] = await db
      .select({ id: organizations.id, name: organizations.name, currency: organizations.currency })
      .from(organizations)
      .where(eq(organizations.id, wantedOrgId))
      .limit(1);
    if (!org) throw new Error("That organisation no longer exists.");
    return { orgId: org.id, orgName: org.name, currency: org.currency ?? "INR", superUser: true };
  }

  // The product super admin belongs to no tenant: default the lens to the first
  // organisation on the platform so the page always answers.
  if (!member?.orgId && superUser) {
    const [first] = await db
      .select({ id: organizations.id, name: organizations.name, currency: organizations.currency })
      .from(organizations)
      .orderBy(organizations.createdAt)
      .limit(1);
    if (!first) throw new Error("No organisation has been registered on the platform yet.");
    return {
      orgId: first.id,
      orgName: first.name,
      currency: first.currency ?? "INR",
      superUser: true,
    };
  }

  if (!member?.orgId) {
    throw new Error("You are not part of an organisation yet.");
  }

  if (member.isOwner || superUser) {
    return {
      orgId: member.orgId,
      orgName: member.orgName ?? null,
      currency: member.currency ?? "INR",
      superUser,
    };
  }

  const roles = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.orgId, member.orgId)));
  if (!roles.some((r) => ["president_cbo", "hr_head"].includes(r.role))) {
    throw new Error(
      "Return on Individual is available to the CHRO, HR Head and the account owner.",
    );
  }
  return {
    orgId: member.orgId,
    orgName: member.orgName ?? null,
    currency: member.currency ?? "INR",
    superUser: false,
  };
}

// Realised value (joined/hired) plus value already committed through an offer —
// a CHRO needs both, labelled apart.
const HIRED_STAGES = [
  "offer",
  "offer_pending",
  "offer_released",
  "offer_accepted",
  "hired",
  "joined",
] as const;

async function loadCapabilities(orgId: string): Promise<{ nodes: OntologyNode[]; open: number }> {
  const stored = await db.select().from(skillNodes).where(eq(skillNodes.orgId, orgId)).limit(4000);

  const reqRows = await db
    .select({
      id: requisitions.id,
      title: requisitions.title,
      openings: requisitions.openings,
      status: requisitions.status,
      mustHaveSkills: requisitions.mustHaveSkills,
      goodToHaveSkills: requisitions.goodToHaveSkills,
    })
    .from(requisitions)
    .where(eq(requisitions.orgId, orgId))
    .limit(2000);

  const openCount = reqRows.filter((r) =>
    ["approved", "pending_dh", "pending_hr", "pending_cbo"].includes(String(r.status)),
  ).length;

  if (stored.length) {
    const nodes: OntologyNode[] = stored.map((n) => ({
      slug: n.slug,
      name: n.name,
      category: n.category ?? "general",
      aliases: (n.aliases ?? []) as string[],
      supply: Number(n.supply ?? 0),
      demand: Number(n.demand ?? 0),
      validated: Number(n.validated ?? 0),
      evidence: Number(n.evidenceCount ?? 0),
      weight: Number(n.supply ?? 0),
      status: (n.status ?? "active") as OntologyNode["status"],
      firstSeenAt: (n.firstSeenAt ?? new Date()).toISOString(),
      lastSeenAt: (n.lastSeenAt ?? new Date()).toISOString(),
      scarcity:
        Number(n.demand ?? 0) > 0
          ? Math.round(
              (Number(n.demand ?? 0) / (Number(n.demand ?? 0) + Number(n.supply ?? 0) || 1)) * 100,
            )
          : 0,
    }));
    return { nodes, open: openCount };
  }

  // No stored graph yet — build one in memory so the page still answers.
  const candRows = await db
    .select({
      id: candidates.id,
      skills: candidates.skills,
      resumeText: candidates.resumeText,
      createdAt: candidates.createdAt,
      lastSyncedAt: candidates.lastSyncedAt,
    })
    .from(candidates)
    .where(eq(candidates.orgId, orgId))
    .limit(5000);

  const appRows = await db
    .select({ candidateId: applications.candidateId, stage: applications.stage })
    .from(applications)
    .where(eq(applications.orgId, orgId))
    .limit(10000);

  const validatedIds = new Set(
    appRows
      .filter((a) => ["l1", "l2", "l3", "offer", "hired", "joined"].includes(String(a.stage)))
      .map((a) => a.candidateId),
  );

  const build = buildOntology({
    candidates: candRows.map((c) => ({
      candidateId: c.id,
      skills: (c.skills ?? []) as string[],
      resumeText: c.resumeText ?? null,
      observedAt: (c.lastSyncedAt ?? c.createdAt ?? new Date()).toISOString(),
      hired: validatedIds.has(c.id),
    })),
    demand: reqRows.map((r) => ({
      requisitionId: r.id,
      title: r.title,
      openings: Number(r.openings ?? 1),
      mustHave: (r.mustHaveSkills ?? []) as string[],
      goodToHave: (r.goodToHaveSkills ?? []) as string[],
      open: ["approved", "pending_dh", "pending_hr", "pending_cbo"].includes(String(r.status)),
    })),
    previous: [],
  });
  return { nodes: build.nodes, open: openCount };
}

/** The CHRO's answer to "what return on individual have we got?" */
export const readReturnOnIndividual = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((input: unknown) =>
    z.object({ orgId: z.string().uuid().optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<RoiView> => {
    const email = (context.claims as { email?: string } | null)?.email ?? null;
    const access = await requireRoiAccess(context.userId, email, data.orgId);
    const orgId = access.orgId;

    const rows = await db
      .select({
        applicationId: applications.id,
        candidateId: applications.candidateId,
        stage: applications.stage,
        appliedAt: applications.appliedAt,
        lastActivityAt: applications.lastActivityAt,
        name: candidates.fullName,
        skills: candidates.skills,
        experienceYears: candidates.experienceYears,
        requisitionTitle: requisitions.title,
        budgetCtc: requisitions.budgetCtc,
        department: departments.name,
      })
      .from(applications)
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
      .leftJoin(departments, eq(departments.id, requisitions.departmentId))
      .where(
        and(
          eq(applications.orgId, orgId),
          inArray(applications.stage, [...HIRED_STAGES] as never[]),
        ),
      )
      .limit(2000);

    const appIds = rows.map((r) => r.applicationId);

    const scoreRows = appIds.length
      ? await db
          .select()
          .from(matchScores)
          .where(and(eq(matchScores.orgId, orgId), inArray(matchScores.applicationId, appIds)))
      : [];
    const scoreBy = new Map(scoreRows.map((s) => [s.applicationId, s]));

    const offerRows = appIds.length
      ? await db
          .select({
            applicationId: offers.applicationId,
            offeredCtc: offers.offeredCtc,
            joiningDate: offers.joiningDate,
            status: offers.status,
          })
          .from(offers)
          .where(and(eq(offers.orgId, orgId), inArray(offers.applicationId, appIds)))
      : [];
    const offerBy = new Map(offerRows.map((o) => [o.applicationId, o]));

    const { nodes, open } = await loadCapabilities(orgId);

    const hires: RoiHireInput[] = rows.map((r) => {
      const score = scoreBy.get(r.applicationId);
      const offer = offerBy.get(r.applicationId);
      const offered = offer ? Number(offer.offeredCtc ?? 0) : 0;
      const budget = Number(r.budgetCtc ?? 0);
      return {
        applicationId: r.applicationId,
        candidateId: r.candidateId,
        name: r.name,
        requisitionTitle: r.requisitionTitle ?? null,
        department: r.department ?? null,
        stage: String(r.stage),
        appliedAt: (r.appliedAt ?? new Date()).toISOString(),
        joinedAt: offer?.joiningDate
          ? new Date(offer.joiningDate).toISOString()
          : ((r.lastActivityAt ?? null)?.toISOString() ?? null),
        skills: (r.skills ?? []) as string[],
        experienceYears: Number(r.experienceYears ?? 0),
        offeredCtc: offered > 0 ? offered : null,
        budgetCtc: budget > 0 ? budget : null,
        scores: {
          overall: score ? Number(score.overallScore ?? 0) || null : null,
          skills: score ? Number(score.skillsScore ?? 0) || null : null,
          experience: score ? Number(score.experienceScore ?? 0) || null : null,
          career: score ? Number(score.careerScore ?? 0) || null : null,
          impact: score ? Number(score.impactScore ?? 0) || null : null,
          innovation: score ? Number(score.innovationScore ?? 0) || null : null,
          education: score ? Number(score.educationScore ?? 0) || null : null,
          social: score ? Number(score.socialScore ?? 0) || null : null,
        },
      };
    });

    const report = buildRoi({ hires, nodes, openRequisitions: open });

    let orgOptions: RoiOrgOption[] = [];
    if (access.superUser) {
      orgOptions = (
        await db
          .select({ id: organizations.id, name: organizations.name, status: organizations.status })
          .from(organizations)
          .limit(500)
      )
        .map((o) => ({ id: o.id, name: o.name, status: o.status ?? "active" }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    return {
      ...report,
      orgId,
      orgName: access.orgName,
      currency: access.currency,
      superUser: access.superUser,
      orgOptions,
    };
  });
