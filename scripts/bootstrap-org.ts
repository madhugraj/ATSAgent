/**
 * Local only: create an organisation with its owner, who is also the platform
 * super admin, and email them the link to set their password.
 *
 *   ORG_NAME="Yavar" OWNER_EMAIL=you@example.com bun scripts/bootstrap-org.ts
 *
 * No password is ever set or seen here: the owner sets it from the emailed
 * link (single use, valid 60 minutes), which also confirms their email. Needs
 * SMTP_URL (and EMAIL_FROM on a verified sending domain) to send the link;
 * without them everything else is created and the owner can use
 * "Forgot password" on the sign-in page once email is configured.
 * Idempotent: re-running updates nothing that already exists.
 */
import { and, eq, ilike } from "drizzle-orm";

const url = process.env.DATABASE_URL ?? "";
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to bootstrap an organisation on a non-local database");
}
const orgName = (process.env.ORG_NAME ?? "").trim();
const email = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
if (!orgName) throw new Error("Set ORG_NAME");
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Set OWNER_EMAIL");

const { db, sql } = await import("../src/server/db");
const { orgMembers, organizations, platformAdmins, userRoles, users } =
  await import("../drizzle/schema");
const { writeAudit } = await import("../src/server/audit");

const slug = orgName
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

// The person: no password until they set one from the link.
const [found] = await db.select().from(users).where(eq(users.email, email)).limit(1);
const user = found ?? (await db.insert(users).values({ email }).returning())[0]!;

// Platform super admin (granted by email, so nobody else can claim it first).
const [grant] = await db
  .select({ id: platformAdmins.id })
  .from(platformAdmins)
  .where(ilike(platformAdmins.email, email))
  .limit(1);
if (!grant)
  await db
    .insert(platformAdmins)
    .values({ email, userId: user.id, note: "Product owner (bootstrap)", createdBy: user.id });

// The organisation, active.
const [existingOrg] = await db
  .select()
  .from(organizations)
  .where(eq(organizations.slug, slug))
  .limit(1);
const org =
  existingOrg ??
  (
    await db
      .insert(organizations)
      .values({ name: orgName, slug, status: "active", createdBy: user.id } as never)
      .returning()
  )[0]!;

// Owner, with every approver role so one person can act at each gate.
const [member] = await db
  .select({ id: orgMembers.id })
  .from(orgMembers)
  .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.email, email)))
  .limit(1);
if (!member)
  await db.insert(orgMembers).values({
    orgId: org.id,
    userId: user.id,
    email,
    status: "active",
    isOwner: true,
    joinedAt: new Date(),
  } as never);
for (const role of [
  "hr_head",
  "president_cbo",
  "department_head",
  "hiring_manager",
  "recruiter",
] as const) {
  const [has] = await db
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(
      and(eq(userRoles.userId, user.id), eq(userRoles.orgId, org.id), eq(userRoles.role, role)),
    )
    .limit(1);
  if (!has) await db.insert(userRoles).values({ userId: user.id, orgId: org.id, role });
}

if (!existingOrg)
  await writeAudit({
    actor: "platform:bootstrap",
    orgId: org.id,
    action: "organization.bootstrapped",
    entityType: "organization",
    entityId: org.id,
    detail: { name: orgName, owner: email, platformAdmin: true },
  });

console.log(
  `${existingOrg ? "Found" : "Created"} organisation "${org.name}" (${org.slug}); ${email} is its owner and the platform super admin.`,
);

// The set-password link, through the same path as "Forgot password".
if (!process.env["SMTP_URL"]) {
  console.log(
    "Email is not configured (SMTP_URL is not set), so no link was sent. Set SMTP_URL and EMAIL_FROM in .env.local, then re-run this or use “Forgot password” on the sign-in page.",
  );
} else if (user.passwordHash) {
  console.log("This person already has a password; use “Forgot password” to change it.");
} else {
  const { signActionToken } = await import("../src/server/action-token");
  const { sendTemplateEmail } = await import("../src/lib/email-templates/send-email");
  const siteUrl = (process.env["PUBLIC_SITE_URL"] ?? "http://localhost:9000").replace(/\/$/, "");
  const token = signActionToken(user.id, "password-reset", 60 * 60 * 1000);
  await sendTemplateEmail("password-recovery", email, {
    templateData: { siteName: "ATSIQ", confirmationUrl: `${siteUrl}/auth/reset?token=${token}` },
  });
  console.log(`Sent the set-password link to ${email} (valid 60 minutes).`);
}
await sql.end();
