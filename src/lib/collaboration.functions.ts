import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, ilike, inArray, isNotNull, or } from "drizzle-orm";
import { z } from "zod";

import { requireIdentity } from "@/lib/auth.middleware";
import { db } from "../server/db";
import {
  applications,
  candidateNotes,
  candidateOwnershipEvents,
  candidateReferrals,
  candidates,
  orgMembers,
  orgPoolShares,
  organizations,
  talentRequestSuggestions,
  talentRequests,
} from "@db/schema";

/**
 * Recruiter-to-recruiter collaboration on a shared talent pool: every candidate
 * can have an owning recruiter, be referred to a colleague's role, be handed
 * over with an audit trail, or be suggested against a colleague's open request.
 * The pool itself stays visible to the whole organisation.
 */

/** The signed-in user's active organisation, and whether they own it. */
async function membership(userId: string) {
  const [row] = await db
    .select({
      orgId: orgMembers.orgId,
      isOwner: orgMembers.isOwner,
      fullName: orgMembers.fullName,
      email: orgMembers.email,
    })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.status, "active")))
    .orderBy(orgMembers.createdAt)
    .limit(1);
  if (!row) throw new Error("You are not a member of an organisation yet.");
  return row;
}

export type PoolTeammate = {
  userId: string;
  name: string;
  email: string;
  isOwner: boolean;
};

/** Colleagues who can own, receive or be mentioned on a candidate. */
export const poolTeam = createServerFn({ method: "GET" })
  .middleware([requireIdentity])
  .handler(async ({ context }): Promise<PoolTeammate[]> => {
    const me = await membership(context.userId);
    const rows = await db
      .select({
        userId: orgMembers.userId,
        fullName: orgMembers.fullName,
        email: orgMembers.email,
        isOwner: orgMembers.isOwner,
      })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, me.orgId),
          eq(orgMembers.status, "active"),
          isNotNull(orgMembers.userId),
        ),
      )
      .orderBy(orgMembers.fullName);
    return rows.map((m) => ({
      userId: m.userId as string,
      name: m.fullName || m.email,
      email: m.email,
      isOwner: m.isOwner,
    }));
  });

/** Assign, hand over or release ownership of candidates, with an audit trail. */
export const setCandidateOwner = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z
      .object({
        candidateIds: z.array(z.string().uuid()).min(1).max(500),
        ownerId: z.string().uuid().nullable(),
        reason: z.string().trim().max(400).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const me = await membership(context.userId);

    if (data.ownerId) {
      const [target] = await db
        .select({ id: orgMembers.id })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.orgId, me.orgId),
            eq(orgMembers.userId, data.ownerId),
            eq(orgMembers.status, "active"),
          ),
        )
        .limit(1);
      if (!target) throw new Error("That colleague is not an active member of your organisation.");
    }

    const rows = await db
      .select({ id: candidates.id, ownerId: candidates.ownerId })
      .from(candidates)
      .where(and(eq(candidates.orgId, me.orgId), inArray(candidates.id, data.candidateIds)));
    if (!rows.length) throw new Error("No candidates in your organisation matched that selection.");

    const ids = rows.map((r) => r.id);
    await db.update(candidates).set({ ownerId: data.ownerId }).where(inArray(candidates.id, ids));

    await db.insert(candidateOwnershipEvents).values(
      rows.map((r) => ({
        orgId: me.orgId,
        candidateId: r.id,
        fromOwner: r.ownerId,
        toOwner: data.ownerId,
        actor: context.userId,
        reason: data.reason ?? null,
      })),
    );

    return { updated: ids.length };
  });

/** Send a candidate to a colleague, optionally against one of their roles. */
export const referCandidate = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z
      .object({
        candidateId: z.string().uuid(),
        toUser: z.string().uuid(),
        requisitionId: z.string().uuid().nullable().optional(),
        note: z.string().trim().max(1000).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const me = await membership(context.userId);
    if (data.toUser === context.userId) throw new Error("Pick a colleague other than yourself.");

    const [cand] = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(and(eq(candidates.id, data.candidateId), eq(candidates.orgId, me.orgId)))
      .limit(1);
    if (!cand) throw new Error("That candidate is not in your organisation's pool.");

    const [peer] = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, me.orgId),
          eq(orgMembers.userId, data.toUser),
          eq(orgMembers.status, "active"),
        ),
      )
      .limit(1);
    if (!peer) throw new Error("That colleague is not an active member of your organisation.");

    if (data.requisitionId) {
      const { assertRequisitionInOrg } = await import("../server/guards");
      await assertRequisitionInOrg(data.requisitionId, me.orgId);
    }

    await db.insert(candidateReferrals).values({
      orgId: me.orgId,
      candidateId: data.candidateId,
      requisitionId: data.requisitionId ?? null,
      fromUser: context.userId,
      toUser: data.toUser,
      note: data.note ?? null,
    });
    return { ok: true };
  });

/**
 * Accept or decline a referral. Accepting also makes the receiver the owner and
 * attaches the candidate to the role when one was named, so the hand-off is real.
 */
export const respondReferral = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z
      .object({
        referralId: z.string().uuid(),
        accept: z.boolean(),
        note: z.string().trim().max(600).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const [ref] = await db
      .select({
        id: candidateReferrals.id,
        orgId: candidateReferrals.orgId,
        candidateId: candidateReferrals.candidateId,
        requisitionId: candidateReferrals.requisitionId,
        toUser: candidateReferrals.toUser,
        status: candidateReferrals.status,
      })
      .from(candidateReferrals)
      .where(eq(candidateReferrals.id, data.referralId))
      .limit(1);
    if (!ref) throw new Error("That referral no longer exists.");
    if (ref.toUser !== context.userId)
      throw new Error("Only the recruiter it was sent to can respond.");
    if (ref.status !== "pending") throw new Error("This referral has already been answered.");

    await db
      .update(candidateReferrals)
      .set({
        status: data.accept ? "accepted" : "declined",
        responseNote: data.note ?? null,
        respondedAt: new Date(),
      })
      .where(eq(candidateReferrals.id, ref.id));

    if (data.accept) {
      const [prev] = await db
        .select({ ownerId: candidates.ownerId })
        .from(candidates)
        .where(eq(candidates.id, ref.candidateId))
        .limit(1);
      await db
        .update(candidates)
        .set({ ownerId: context.userId })
        .where(eq(candidates.id, ref.candidateId));
      await db.insert(candidateOwnershipEvents).values({
        orgId: ref.orgId,
        candidateId: ref.candidateId,
        fromOwner: prev?.ownerId ?? null,
        toOwner: context.userId,
        actor: context.userId,
        reason: "Accepted referral",
      });

      if (ref.requisitionId) {
        const [existing] = await db
          .select({ id: applications.id })
          .from(applications)
          .where(
            and(
              eq(applications.candidateId, ref.candidateId),
              eq(applications.requisitionId, ref.requisitionId),
            ),
          )
          .limit(1);
        if (!existing)
          await db.insert(applications).values({
            orgId: ref.orgId,
            candidateId: ref.candidateId,
            requisitionId: ref.requisitionId,
            stage: "sourced",
            source: "internal_referral",
          });
      }
    }

    return { ok: true, accepted: data.accept };
  });

/** Leave a note on a candidate and optionally pull colleagues in by mention. */
export const addCandidateNote = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z
      .object({
        candidateId: z.string().uuid(),
        body: z.string().trim().min(1).max(4000),
        mentions: z.array(z.string().uuid()).max(20).default([]),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const me = await membership(context.userId);

    const [cand] = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(and(eq(candidates.id, data.candidateId), eq(candidates.orgId, me.orgId)))
      .limit(1);
    if (!cand) throw new Error("That candidate is not in your organisation's pool.");

    let mentions: string[] = [];
    if (data.mentions.length) {
      const peers = await db
        .select({ userId: orgMembers.userId })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.orgId, me.orgId),
            eq(orgMembers.status, "active"),
            inArray(orgMembers.userId, data.mentions),
          ),
        );
      mentions = peers.map((p) => p.userId).filter((id): id is string => id !== null);
    }

    await db.insert(candidateNotes).values({
      orgId: me.orgId,
      candidateId: data.candidateId,
      authorId: context.userId,
      authorName: me.fullName || me.email,
      body: data.body,
      mentions,
    });
    return { ok: true };
  });

/** Ask the rest of the team for people matching a skill or role. */
export const createTalentRequest = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z
      .object({
        title: z.string().trim().min(2).max(160),
        skills: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
        note: z.string().trim().max(1000).optional(),
        requisitionId: z.string().uuid().nullable().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const me = await membership(context.userId);
    if (data.requisitionId) {
      const { assertRequisitionInOrg } = await import("../server/guards");
      await assertRequisitionInOrg(data.requisitionId, me.orgId);
    }
    await db.insert(talentRequests).values({
      orgId: me.orgId,
      requesterId: context.userId,
      requisitionId: data.requisitionId ?? null,
      title: data.title,
      skills: data.skills,
      note: data.note ?? null,
    });
    return { ok: true };
  });

/** Suggest one of your candidates against a colleague's request. */
export const suggestToRequest = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z
      .object({
        requestId: z.string().uuid(),
        candidateId: z.string().uuid(),
        note: z.string().trim().max(600).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const me = await membership(context.userId);
    const [req] = await db
      .select({ id: talentRequests.id, orgId: talentRequests.orgId, status: talentRequests.status })
      .from(talentRequests)
      .where(eq(talentRequests.id, data.requestId))
      .limit(1);
    if (!req || req.orgId !== me.orgId)
      throw new Error("That request is not open in your organisation.");
    if (req.status !== "open") throw new Error("This request has already been closed.");

    const [cand] = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(and(eq(candidates.id, data.candidateId), eq(candidates.orgId, me.orgId)))
      .limit(1);
    if (!cand) throw new Error("That candidate is not in your organisation's pool.");

    try {
      await db.insert(talentRequestSuggestions).values({
        orgId: me.orgId,
        requestId: data.requestId,
        candidateId: data.candidateId,
        suggestedBy: context.userId,
        note: data.note ?? null,
      });
    } catch (e) {
      if (/duplicate|unique/i.test((e as Error).message))
        throw new Error("That candidate has already been suggested for this request.");
      throw e;
    }
    return { ok: true };
  });

/** Close your own request once you have what you need. */
export const closeTalentRequest = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) => z.object({ requestId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const me = await membership(context.userId);
    const [req] = await db
      .select({
        id: talentRequests.id,
        orgId: talentRequests.orgId,
        requesterId: talentRequests.requesterId,
      })
      .from(talentRequests)
      .where(eq(talentRequests.id, data.requestId))
      .limit(1);
    if (!req || req.orgId !== me.orgId) throw new Error("Request not found.");
    if (req.requesterId !== context.userId && !me.isOwner)
      throw new Error("Only the recruiter who raised it, or an organisation owner, can close it.");
    await db
      .update(talentRequests)
      .set({ status: "closed", closedAt: new Date() })
      .where(eq(talentRequests.id, req.id));
    return { ok: true };
  });

export type PoolShare = {
  id: string;
  direction: "outgoing" | "incoming";
  status: string;
  scope: string | null;
  partnerName: string;
  partnerOrg: string;
  createdAt: string;
};

/** Cross-organisation pool sharing agreements, both directions. */
export const listPoolShares = createServerFn({ method: "GET" })
  .middleware([requireIdentity])
  .handler(async ({ context }): Promise<PoolShare[]> => {
    const me = await membership(context.userId);
    const shares = await db
      .select({
        id: orgPoolShares.id,
        ownerOrg: orgPoolShares.ownerOrg,
        partnerOrg: orgPoolShares.partnerOrg,
        status: orgPoolShares.status,
        scope: orgPoolShares.scope,
        createdAt: orgPoolShares.createdAt,
      })
      .from(orgPoolShares)
      .where(or(eq(orgPoolShares.ownerOrg, me.orgId), eq(orgPoolShares.partnerOrg, me.orgId)))
      .orderBy(desc(orgPoolShares.createdAt));

    const ids = new Set<string>();
    for (const s of shares) {
      ids.add(s.ownerOrg);
      ids.add(s.partnerOrg);
    }
    const orgs = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(inArray(organizations.id, ids.size ? [...ids] : [me.orgId]));
    const nameOf = new Map(orgs.map((o) => [o.id, o.name]));

    return shares.map((s) => {
      const outgoing = s.ownerOrg === me.orgId;
      const partner = outgoing ? s.partnerOrg : s.ownerOrg;
      return {
        id: s.id,
        direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
        status: s.status,
        scope: s.scope,
        partnerOrg: partner,
        partnerName: nameOf.get(partner) ?? "Unknown organisation",
        createdAt: s.createdAt.toISOString(),
      };
    });
  });

/**
 * Offer your pool to another organisation. Nothing is visible to them until
 * they accept, and either side can revoke it at any time.
 */
export const offerPoolShare = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z
      .object({
        partnerName: z.string().trim().min(2).max(160),
        scope: z.string().trim().max(400).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const me = await membership(context.userId);
    if (!me.isOwner)
      throw new Error("Only an organisation owner can agree to share the talent pool.");

    const matches = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(ilike(organizations.name, `%${data.partnerName}%`))
      .limit(5);
    const found = matches.filter((o) => o.id !== me.orgId);
    if (found.length === 0) throw new Error("No active organisation matched that name.");
    if (found.length > 1)
      throw new Error(
        `Several organisations matched: ${found.map((o) => o.name).join(", ")}. Be more specific.`,
      );

    try {
      await db.insert(orgPoolShares).values({
        ownerOrg: me.orgId,
        partnerOrg: found[0]!.id,
        scope: data.scope ?? null,
        requestedBy: context.userId,
      });
    } catch (e) {
      if (/duplicate|unique/i.test((e as Error).message))
        throw new Error(`An agreement with ${found[0]!.name} already exists.`);
      throw e;
    }
    return { ok: true, partnerName: found[0]!.name };
  });

/** Accept, decline or revoke a sharing agreement. */
export const respondPoolShare = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z
      .object({ shareId: z.string().uuid(), action: z.enum(["accept", "decline", "revoke"]) })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const me = await membership(context.userId);
    if (!me.isOwner) throw new Error("Only an organisation owner can change a sharing agreement.");
    const [share] = await db
      .select({
        id: orgPoolShares.id,
        ownerOrg: orgPoolShares.ownerOrg,
        partnerOrg: orgPoolShares.partnerOrg,
        status: orgPoolShares.status,
      })
      .from(orgPoolShares)
      .where(eq(orgPoolShares.id, data.shareId))
      .limit(1);
    if (!share) throw new Error("Agreement not found.");
    const mine = share.ownerOrg === me.orgId || share.partnerOrg === me.orgId;
    if (!mine) throw new Error("This agreement does not involve your organisation.");

    if (data.action === "revoke") {
      await db
        .update(orgPoolShares)
        .set({ status: "revoked", revokedAt: new Date(), respondedBy: context.userId })
        .where(eq(orgPoolShares.id, share.id));
      return { ok: true, status: "revoked" };
    }

    if (share.partnerOrg !== me.orgId)
      throw new Error("Only the receiving organisation can accept or decline.");
    const status = data.action === "accept" ? "active" : "declined";
    await db
      .update(orgPoolShares)
      .set({ status, respondedAt: new Date(), respondedBy: context.userId })
      .where(eq(orgPoolShares.id, share.id));
    return { ok: true, status };
  });
