/**
 * Local only: create (or reset) a sign-in for a person, grant platform super
 * admin, and make them an owner of the demo organisation when it exists — so
 * one login can test the agents and the platform console.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='…' bun scripts/create-local-admin.ts
 *
 * Re-run after `bun scripts/seed-agent-demo.ts`, which recreates the demo
 * organisation. The email and password are inputs and never stored in the repo.
 */
import { and, eq, ilike } from "drizzle-orm";

const url = process.env.DATABASE_URL ?? "";
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to create an admin on a non-local database");
}
const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? "";
if (!email.includes("@")) throw new Error("Set ADMIN_EMAIL");
if (password.length < 8) throw new Error("Set ADMIN_PASSWORD (8+ characters)");

const { db, sql } = await import("../src/server/db");
const { hashPassword } = await import("../src/server/password");
const { orgMembers, organizations, platformAdmins, userRoles, users } =
  await import("../drizzle/schema");

const passwordHash = await hashPassword(password);
const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
const user = existing
  ? (
      await db
        .update(users)
        .set({ passwordHash, emailConfirmedAt: existing.emailConfirmedAt ?? new Date() })
        .where(eq(users.id, existing.id))
        .returning()
    )[0]!
  : (
      await db
        .insert(users)
        .values({
          email,
          fullName: "Local Super Admin",
          passwordHash,
          emailConfirmedAt: new Date(),
        })
        .returning()
    )[0]!;

const [grant] = await db
  .select({ id: platformAdmins.id })
  .from(platformAdmins)
  .where(ilike(platformAdmins.email, email))
  .limit(1);
if (!grant)
  await db
    .insert(platformAdmins)
    .values({ email, userId: user.id, note: "local test super admin" });

const [org] = await db
  .select({ id: organizations.id, name: organizations.name })
  .from(organizations)
  .where(eq(organizations.slug, "agent-demo"))
  .limit(1);
if (org) {
  const [member] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.email, email)))
    .limit(1);
  if (member)
    await db
      .update(orgMembers)
      .set({ userId: user.id, status: "active", isOwner: true })
      .where(eq(orgMembers.id, member.id));
  else
    await db.insert(orgMembers).values({
      orgId: org.id,
      userId: user.id,
      email,
      status: "active",
      isOwner: true,
      joinedAt: new Date(),
    });
  for (const role of ["hr_head", "president_cbo"] as const) {
    const [has] = await db
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(
        and(eq(userRoles.userId, user.id), eq(userRoles.orgId, org.id), eq(userRoles.role, role)),
      )
      .limit(1);
    if (!has) await db.insert(userRoles).values({ userId: user.id, orgId: org.id, role });
  }
}

console.log(
  `${existing ? "Updated" : "Created"} ${email}: platform super admin${org ? `, owner of ${org.name}` : " (no demo organisation — run the demo seed, then this again)"}.`,
);
await sql.end();
