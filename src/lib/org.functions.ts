import { and, eq, ilike, isNull, sql } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireIdentity } from "@/lib/auth.middleware";
import { db } from "../server/db";
import { emailVerified } from "../server/claims";
import { departments, masterItems, orgMembers, organizations, userRoles } from "@db/schema";
import { registrableDomain, workEmailProblem } from "@/lib/work-email";

export type AppRole =
  "recruiter" | "hiring_manager" | "department_head" | "hr_head" | "president_cbo";

const ROLES = [
  "recruiter",
  "hiring_manager",
  "department_head",
  "hr_head",
  "president_cbo",
] as const;

export type Organization = {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  industry: string | null;
  hq_country: string | null;
  hq_city: string | null;
  employee_band: string | null;
  currency: string;
  fiscal_year_start_month: number;
  careers_email: string | null;
  onboarding_step: string;
  onboarded_at: string | null;
  status?: string;
  archived_at?: string | null;
  rejection_reason?: string | null;
  approved_at?: string | null;
};

export type OrgMember = {
  id: string;
  userId: string | null;
  email: string;
  fullName: string | null;
  title: string | null;
  status: string;
  isOwner: boolean;
  invitedRole: AppRole | null;
  roles: AppRole[];
  createdAt: string;
  joinedAt: string | null;
};

export type MyOrg = {
  org: Organization | null;
  membership: { id: string; isOwner: boolean; status: string } | null;
  roles: AppRole[];
};

const ROLE_LABELS: Record<AppRole, string> = {
  recruiter: "Recruiter",
  hiring_manager: "Hiring manager",
  department_head: "Department head",
  hr_head: "HR head",
  president_cbo: "President / CBO",
};

/**
 * Tell an invited colleague they now have access. Best-effort: the roster entry
 * is already saved, so a mail failure must never fail the invitation.
 */
async function notifyInvitedMember(args: {
  email: string;
  orgName: string;
  role: AppRole;
  title?: string | null;
  inviteeName?: string | null;
  inviterName?: string | null;
  memberId?: string | null;
}) {
  try {
    const { sendTemplateEmail } = await import("@/lib/email-templates/send-email");
    await sendTemplateEmail("member-invited", args.email, {
      idempotencyKey: `member-invited:${args.memberId ?? args.email}`,
      templateData: {
        orgName: args.orgName,
        roleLabel: ROLE_LABELS[args.role],
        title: args.title ?? undefined,
        inviteeName: args.inviteeName ?? undefined,
        inviterName: args.inviterName ?? undefined,
        email: args.email,
      },
    });
  } catch (e) {
    const { redactEmail } = await import("../server/audit");
    console.error("invitation email failed", redactEmail(args.email), e);
  }
}

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "org"}-${Math.random().toString(36).slice(2, 7)}`;
}

function orgRowToOrganization(o: typeof organizations.$inferSelect): Organization {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    legal_name: o.legalName,
    industry: o.industry,
    hq_country: o.hqCountry,
    hq_city: o.hqCity,
    employee_band: o.employeeBand,
    currency: o.currency,
    fiscal_year_start_month: o.fiscalYearStartMonth,
    careers_email: o.careersEmail,
    onboarding_step: o.onboardingStep,
    onboarded_at: o.onboardedAt ? o.onboardedAt.toISOString() : null,
    status: o.status,
    archived_at: o.archivedAt ? o.archivedAt.toISOString() : null,
    rejection_reason: o.rejectionReason,
    approved_at: o.approvedAt ? o.approvedAt.toISOString() : null,
  };
}

/**
 * The signed-in user's organisation. Also reports any invitation sent to their
 * email address; claiming it is an explicit action (claimInvite), so a GET
 * never mutates state.
 */
export const myOrg = createServerFn({ method: "GET" })
  .middleware([requireIdentity])
  .handler(async ({ context }): Promise<MyOrg> => {
    const [member] = await db
      .select({
        id: orgMembers.id,
        orgId: orgMembers.orgId,
        isOwner: orgMembers.isOwner,
        status: orgMembers.status,
      })
      .from(orgMembers)
      .where(and(eq(orgMembers.userId, context.userId), eq(orgMembers.status, "active")))
      .orderBy(orgMembers.createdAt)
      .limit(1);

    if (!member) return { org: null, membership: null, roles: [] };

    const [org, roles] = await Promise.all([
      db.select().from(organizations).where(eq(organizations.id, member.orgId)).limit(1),
      db
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(and(eq(userRoles.userId, context.userId), eq(userRoles.orgId, member.orgId))),
    ]);

    return {
      org: org[0] ? orgRowToOrganization(org[0]) : null,
      membership: { id: member.id, isOwner: member.isOwner, status: member.status },
      roles: roles.map((r) => r.role as AppRole),
    };
  });

/**
 * Claim a pending organisation invitation addressed to the signed-in email.
 * Invitations only convert into real users once the tenant is approved and live.
 * (Split out of the old GET myOrg so reads never mutate and cross-site GETs
 * cannot ride a session.)
 */
export const claimInvite = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .handler(async ({ context }) => {
    const email = (context.claims?.email as string | undefined)?.toLowerCase();
    if (!email) throw new Error("Your account has no email address.");

    const [invite] = await db
      .select({ id: orgMembers.id, orgId: orgMembers.orgId, invitedRole: orgMembers.invitedRole })
      .from(orgMembers)
      .where(and(ilike(orgMembers.email, email), isNull(orgMembers.userId)))
      .orderBy(orgMembers.createdAt)
      .limit(1);
    if (!invite) throw new Error("No pending invitation was found for your email address.");

    const [inviteOrg] = await db
      .select({ status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, invite.orgId))
      .limit(1);
    if ((inviteOrg?.status ?? "active") !== "active") {
      throw new Error("This organisation is not approved yet — try again once it is live.");
    }

    // `user_id is null` guard makes the claim single-use under races.
    const claimed = await db
      .update(orgMembers)
      .set({ userId: context.userId, status: "active", joinedAt: new Date() })
      .where(and(eq(orgMembers.id, invite.id), isNull(orgMembers.userId)))
      .returning({ id: orgMembers.id });
    if (!claimed.length) throw new Error("That invitation has already been claimed.");

    if (invite.invitedRole) {
      await db
        .insert(userRoles)
        .values({ userId: context.userId, role: invite.invitedRole, orgId: invite.orgId });
    }
    return { ok: true, orgId: invite.orgId };
  });

const CreateInput = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2, "Registered legal name is required").max(160),
  industry: z.string().trim().min(2, "Industry is required").max(80),
  hqCountry: z.string().trim().min(2, "HQ country is required").max(80),
  hqCity: z.string().trim().min(2, "HQ city is required").max(80),
  employeeBand: z.string().trim().min(1, "Headcount band is required").max(40),
  currency: z.string().trim().min(1).max(8).default("INR"),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(4),
  careersEmail: z.string().trim().email("A valid careers inbox is required").max(160),
  departments: z
    .array(
      z.object({ name: z.string().min(1).max(120), headName: z.string().max(120).default("") }),
    )
    .min(1, "Add at least one department"),
  locations: z.array(z.string().min(1).max(120)).min(1, "Add at least one hiring location"),
  invites: z
    .array(
      z.object({
        email: z.string().email(),
        role: z.enum(ROLES),
        title: z.string().max(120).default(""),
      }),
    )
    .default([]),
});

/**
 * Stand up a brand-new organisation: the creator becomes owner + CHRO admin,
 * departments and locations are seeded, and colleagues are invited by email.
 */
export const createOrganization = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) => CreateInput.parse(data))
  .handler(async ({ data, context }) => {
    const email = (context.claims?.email as string | undefined) ?? `${context.userId}@user`;

    // Only a verified corporate mailbox can register a tenant: the address must be
    // confirmed by the auth service and must not be a personal or disposable domain.
    // Fail closed when neither marker is present — absence is not verification.
    if (!emailVerified(context.claims as Record<string, unknown> | undefined))
      throw new Error("Confirm your work email address before registering an organisation.");
    const problem = workEmailProblem(email);
    if (problem) throw new Error(problem);

    const [existing] = await db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(and(eq(orgMembers.userId, context.userId), eq(orgMembers.status, "active")))
      .limit(1);
    if (existing) throw new Error("You already belong to an organisation.");

    // One company domain = one tenant. Every subdomain of the same company
    // (abc.as.com, sdf.as.com) collapses to the same registrable domain, so a
    // second registration is refused and the person must be invited instead.
    const companyDomain = registrableDomain(email);
    const [claimed] = await db
      .select({ id: organizations.id, name: organizations.name, status: organizations.status })
      .from(organizations)
      .where(
        and(
          eq(organizations.emailDomain, companyDomain),
          sql`${organizations.status} in ('pending', 'active')`,
        ),
      )
      .limit(1);
    if (claimed)
      throw new Error(
        claimed.status === "pending"
          ? `${companyDomain} is already registered as "${claimed.name}" and is awaiting platform approval. Ask that organisation's owner to invite you instead.`
          : `${companyDomain} already has an organisation on ATSIQ ("${claimed.name}"). Ask its owner to invite you from Users, roles & access control.`,
      );

    // The tenant's own careers address: yavar.ai -> yavar@careers.atsiq.yavar.ai
    let inboxSlug =
      companyDomain.split(".")[0]?.replace(/[^a-z0-9-]+/g, "-") ||
      data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 28) ||
      "org";
    for (let attempt = 2; attempt < 30; attempt++) {
      const [taken] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(ilike(organizations.inboxSlug, inboxSlug))
        .limit(1);
      if (!taken) break;
      inboxSlug = `${inboxSlug.replace(/-\d+$/, "")}-${attempt}`;
    }

    const [org] = await db
      .insert(organizations)
      .values({
        emailDomain: companyDomain,
        name: data.name.trim(),
        slug: slugify(data.name),
        inboxSlug,
        legalName: data.legalName.trim() || null,
        industry: data.industry.trim() || null,
        hqCountry: data.hqCountry.trim() || null,
        hqCity: data.hqCity.trim() || null,
        employeeBand: data.employeeBand.trim() || null,
        currency: data.currency.trim() || "INR",
        fiscalYearStartMonth: data.fiscalYearStartMonth,
        careersEmail: data.careersEmail.trim() || null,
        onboardingStep: "pending_approval",
        onboardedAt: null,
        // Every new tenant waits for a platform super admin to approve it.
        status: "pending",
        createdBy: context.userId,
      })
      .returning({ id: organizations.id, name: organizations.name });
    if (!org) throw new Error("The organisation could not be created.");

    // The Integrations page reads this org's own provider rows — seed them
    // now so a new tenant never opens an empty page. Best-effort by design.
    void (await import("../server/integration-seeds.server")).seedSourceIntegrations(org.id);

    await db.insert(orgMembers).values({
      orgId: org.id,
      userId: context.userId,
      email,
      status: "active",
      isOwner: true,
      joinedAt: new Date(),
    });
    await db
      .insert(userRoles)
      .values({ userId: context.userId, role: "president_cbo", orgId: org.id });

    const departmentsToCreate = data.departments.filter((d) => d.name.trim());
    if (departmentsToCreate.length) {
      await db.insert(departments).values(
        departmentsToCreate.map((d) => ({
          orgId: org.id,
          name: d.name.trim(),
          headName: d.headName.trim() || null,
        })),
      );
    }

    const locations = data.locations.map((l) => l.trim()).filter(Boolean);
    if (locations.length) {
      await db
        .insert(masterItems)
        .values(
          locations.map((name, i) => ({ orgId: org.id, kind: "location", name, sortOrder: i })),
        );
    }

    for (const invite of data.invites) {
      if (invite.email.toLowerCase() === email.toLowerCase()) continue;
      // Internal users only: colleagues must be on the organisation's own domain.
      if (registrableDomain(invite.email) !== registrableDomain(email))
        throw new Error(`${invite.email} is not on the ${registrableDomain(email)} domain.`);
      const [row] = await db
        .insert(orgMembers)
        .values({
          orgId: org.id,
          email: invite.email.toLowerCase(),
          title: invite.title.trim() || null,
          invitedRole: invite.role,
          invitedBy: context.userId,
          status: "invited",
        })
        .returning({ id: orgMembers.id });
      await notifyInvitedMember({
        email: invite.email.toLowerCase(),
        orgName: org.name,
        role: invite.role,
        title: invite.title.trim() || null,
        memberId: row?.id ?? null,
      });
    }

    return { ok: true, orgId: org.id };
  });

async function assertOwner(userId: string) {
  const [membership] = await db
    .select({ orgId: orgMembers.orgId, isOwner: orgMembers.isOwner })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.status, "active")))
    .limit(1);
  if (!membership) throw new Error("You do not belong to an organisation yet.");
  if (!membership.isOwner) throw new Error("Only an organisation owner can do this.");
  return membership.orgId;
}

/**
 * User administration is not owner-only: the organisation owner and anyone
 * holding the President/CBO (CHRO admin) role can invite colleagues and
 * grant or revoke approval roles.
 */
async function assertAdmin(userId: string) {
  const [membership] = await db
    .select({ orgId: orgMembers.orgId, isOwner: orgMembers.isOwner })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.status, "active")))
    .limit(1);
  if (!membership) throw new Error("You do not belong to an organisation yet.");
  if (membership.isOwner) return membership.orgId;
  const [role] = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(userRoles.orgId, membership.orgId),
        eq(userRoles.role, "president_cbo"),
      ),
    )
    .limit(1);
  if (!role)
    throw new Error(
      "Only the organisation owner or a President/CBO admin can manage users and roles.",
    );
  return membership.orgId;
}

async function orgOf(userId: string) {
  const [membership] = await db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.status, "active")))
    .limit(1);
  if (!membership) throw new Error("You do not belong to an organisation yet.");
  return membership.orgId;
}

export const updateOrganization = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z
      .object({
        name: z.string().min(2).max(120).optional(),
        legalName: z.string().max(160).optional(),
        industry: z.string().max(80).optional(),
        hqCountry: z.string().max(80).optional(),
        hqCity: z.string().max(80).optional(),
        employeeBand: z.string().max(40).optional(),
        currency: z.string().max(8).optional(),
        fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
        careersEmail: z.string().max(160).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const orgId = await assertOwner(context.userId);
    type OrgPatch = Partial<typeof organizations.$inferInsert>;
    const patch: OrgPatch = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.legalName !== undefined) patch.legalName = data.legalName.trim() || null;
    if (data.industry !== undefined) patch.industry = data.industry.trim() || null;
    if (data.hqCountry !== undefined) patch.hqCountry = data.hqCountry.trim() || null;
    if (data.hqCity !== undefined) patch.hqCity = data.hqCity.trim() || null;
    if (data.employeeBand !== undefined) patch.employeeBand = data.employeeBand.trim() || null;
    if (data.currency !== undefined) patch.currency = data.currency.trim() || "INR";
    if (data.fiscalYearStartMonth !== undefined)
      patch.fiscalYearStartMonth = data.fiscalYearStartMonth;
    if (data.careersEmail !== undefined) patch.careersEmail = data.careersEmail.trim() || null;

    await db.update(organizations).set(patch).where(eq(organizations.id, orgId));
    return { ok: true };
  });

/** Everyone in the organisation, invited or active, with their granted roles. */
export const listMembers = createServerFn({ method: "GET" })
  .middleware([requireIdentity])
  .handler(async ({ context }): Promise<OrgMember[]> => {
    const orgId = await orgOf(context.userId);
    const [members, roles] = await Promise.all([
      db
        .select({
          id: orgMembers.id,
          userId: orgMembers.userId,
          email: orgMembers.email,
          fullName: orgMembers.fullName,
          title: orgMembers.title,
          status: orgMembers.status,
          isOwner: orgMembers.isOwner,
          invitedRole: orgMembers.invitedRole,
          createdAt: orgMembers.createdAt,
          joinedAt: orgMembers.joinedAt,
        })
        .from(orgMembers)
        .where(eq(orgMembers.orgId, orgId))
        .orderBy(orgMembers.createdAt),
      db
        .select({ userId: userRoles.userId, role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.orgId, orgId)),
    ]);

    return members.map((m) => ({
      id: m.id,
      userId: m.userId,
      email: m.email,
      fullName: m.fullName,
      title: m.title,
      status: m.status,
      isOwner: m.isOwner,
      invitedRole: (m.invitedRole as AppRole | null) ?? null,
      createdAt: m.createdAt.toISOString(),
      joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
      roles: roles.filter((r) => r.userId && r.userId === m.userId).map((r) => r.role as AppRole),
    }));
  });

export const inviteMember = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z
      .object({
        email: z.string().email(),
        role: z.enum(ROLES),
        title: z.string().max(120).default(""),
        fullName: z.string().max(120).default(""),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const orgId = await assertAdmin(context.userId);
    const [org] = await db
      .select({ status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if ((org?.status ?? "active") !== "active")
      throw new Error(
        "Your organisation is not approved yet — internal users can be added after approval.",
      );
    const email = data.email.toLowerCase();
    const problem = workEmailProblem(email);
    if (problem) throw new Error(problem);

    // The owner's verified domain defines who counts as an internal user.
    const [owner] = await db
      .select({ email: orgMembers.email })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.isOwner, true)))
      .limit(1);
    if (owner?.email && registrableDomain(owner.email) !== registrableDomain(email))
      throw new Error(
        `Only ${registrableDomain(owner.email)} addresses can be invited into this organisation.`,
      );

    const [existingUser] = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), ilike(orgMembers.email, email)))
      .limit(1);
    if (existingUser) throw new Error("That email is already on the roster.");

    const [row] = await db
      .insert(orgMembers)
      .values({
        orgId,
        email,
        fullName: data.fullName.trim() || null,
        title: data.title.trim() || null,
        invitedRole: data.role,
        invitedBy: context.userId,
        status: "invited",
      })
      .returning({ id: orgMembers.id });

    const [orgRow] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const [inviter] = await db
      .select({ fullName: orgMembers.fullName, email: orgMembers.email })
      .from(orgMembers)
      .where(and(eq(orgMembers.userId, context.userId), eq(orgMembers.orgId, orgId)))
      .limit(1);
    await notifyInvitedMember({
      email,
      orgName: orgRow?.name ?? "your organisation",
      role: data.role,
      title: data.title.trim() || null,
      inviteeName: data.fullName.trim() || null,
      inviterName: inviter?.fullName ?? inviter?.email ?? null,
      memberId: row?.id ?? null,
    });
    return { ok: true, notified: true };
  });

export const setMemberRole = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z.object({ memberId: z.string().uuid(), role: z.enum(ROLES), grant: z.boolean() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const orgId = await assertAdmin(context.userId);
    const [member] = await db
      .select({
        id: orgMembers.id,
        userId: orgMembers.userId,
        orgId: orgMembers.orgId,
        isOwner: orgMembers.isOwner,
      })
      .from(orgMembers)
      .where(and(eq(orgMembers.id, data.memberId), eq(orgMembers.orgId, orgId)))
      .limit(1);
    if (!member) throw new Error("Member not found in your organisation.");

    // Not signed up yet → adjust the role they will receive on first sign-in.
    if (!member.userId) {
      await db
        .update(orgMembers)
        .set({ invitedRole: data.grant ? data.role : null })
        .where(eq(orgMembers.id, member.id));
      return { ok: true };
    }

    if (data.grant) {
      try {
        await db.insert(userRoles).values({ userId: member.userId, role: data.role, orgId });
        const { writeAudit } = await import("../server/audit");
        await writeAudit({
          actor: context.userId,
          actorUserId: context.userId,
          orgId,
          action: "member.role.grant",
          entityType: "org_member",
          entityId: member.id,
          detail: { role: data.role, memberUserId: member.userId },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!/duplicate|unique/i.test(message)) throw new Error(message);
      }
    } else {
      if (member.userId === context.userId && data.role === "president_cbo")
        throw new Error("You cannot revoke your own CHRO access.");
      await db
        .delete(userRoles)
        .where(
          and(
            eq(userRoles.userId, member.userId),
            eq(userRoles.role, data.role),
            eq(userRoles.orgId, orgId),
          ),
        );
      const { writeAudit } = await import("../server/audit");
      await writeAudit({
        actor: context.userId,
        actorUserId: context.userId,
        orgId,
        action: "member.role.revoke",
        entityType: "org_member",
        entityId: member.id,
        detail: { role: data.role, memberUserId: member.userId },
      });
    }
    return { ok: true };
  });

export const setMemberStatus = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z.object({ memberId: z.string().uuid(), status: z.enum(["active", "disabled"]) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const orgId = await assertAdmin(context.userId);
    const [member] = await db
      .select({ id: orgMembers.id, userId: orgMembers.userId, isOwner: orgMembers.isOwner })
      .from(orgMembers)
      .where(and(eq(orgMembers.id, data.memberId), eq(orgMembers.orgId, orgId)))
      .limit(1);
    if (!member) throw new Error("Member not found in your organisation.");
    if (member.userId === context.userId) throw new Error("You cannot change your own access.");
    if (member.isOwner) throw new Error("Transfer ownership before disabling an owner.");

    await db.update(orgMembers).set({ status: data.status }).where(eq(orgMembers.id, member.id));
    return { ok: true };
  });

export const removeMember = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) => z.object({ memberId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const orgId = await assertOwner(context.userId);
    const [member] = await db
      .select({ id: orgMembers.id, userId: orgMembers.userId, isOwner: orgMembers.isOwner })
      .from(orgMembers)
      .where(and(eq(orgMembers.id, data.memberId), eq(orgMembers.orgId, orgId)))
      .limit(1);
    if (!member) throw new Error("Member not found in your organisation.");
    if (member.isOwner) throw new Error("An owner cannot be removed.");
    if (member.userId === context.userId) throw new Error("You cannot remove yourself.");

    if (member.userId) {
      await db
        .delete(userRoles)
        .where(and(eq(userRoles.userId, member.userId), eq(userRoles.orgId, orgId)));
    }
    await db.delete(orgMembers).where(eq(orgMembers.id, member.id));
    return { ok: true };
  });

/** The owner can correct a member's display name, title and (pre-signup) email. */
export const updateMember = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z
      .object({
        memberId: z.string().uuid(),
        fullName: z.string().max(120).default(""),
        title: z.string().max(120).default(""),
        email: z.string().email().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const orgId = await assertAdmin(context.userId);
    const [member] = await db
      .select({ id: orgMembers.id, userId: orgMembers.userId })
      .from(orgMembers)
      .where(and(eq(orgMembers.id, data.memberId), eq(orgMembers.orgId, orgId)))
      .limit(1);
    if (!member) throw new Error("Member not found in your organisation.");

    const patch: { fullName: string | null; title: string | null; email?: string } = {
      fullName: data.fullName.trim() || null,
      title: data.title.trim() || null,
    };
    // Changing the email only makes sense while the invitation is unclaimed —
    // and the new address must pass the same company-domain gate as the
    // original invite, or an insider could redirect a pending role outward.
    if (data.email && !member.userId) {
      const problem = workEmailProblem(data.email.toLowerCase());
      if (problem) throw new Error(problem);
      patch.email = data.email.toLowerCase();
    }

    await db.update(orgMembers).set(patch).where(eq(orgMembers.id, member.id));
    return { ok: true };
  });

/** An owner can archive their own organisation: everyone loses access, records are kept. */
export const archiveOwnOrganization = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((data: unknown) =>
    z.object({ reason: z.string().max(300).default("") }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const orgId = await assertOwner(context.userId);
    await db
      .update(organizations)
      .set({
        status: "archived",
        archivedAt: new Date(),
        archivedReason: data.reason.trim() || null,
      })
      .where(eq(organizations.id, orgId));
    return { ok: true };
  });

// Referenced so the type is checked even though sign-up has no DB dependency yet.
