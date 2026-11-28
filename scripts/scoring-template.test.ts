/**
 * Organisation scoring template: only the HR head / CBO / owner change it, it is
 * validated like requisition weights and audited; new requisitions start from it;
 * "apply to open roles" goes through each role's weight rules (roles in approval
 * are skipped) and the ranked shortlist then reads those weights.
 *
 * Run: DATABASE_URL=<disposable local db> bun test scripts/scoring-template.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

const { db } = await import("../src/server/db");
const { auditLog, orgMembers, organizations, requisitions, userRoles, users } =
  await import("../drizzle/schema");
const tpl = await import("../src/lib/scoring-template.server");
const { createRequisitionCore } = await import("../src/lib/requisitions.server");

const stamp = Date.now();
let orgId: string;
let hr: string;
let rec: string;
const hrEmail = `tpl-hr-${stamp}@test.local`;
const recEmail = `tpl-rec-${stamp}@test.local`;
const asHr = () => ({ orgId, userId: hr, memberEmail: hrEmail });
const asRec = () => ({ orgId, userId: rec, memberEmail: recEmail });

const TEMPLATE = {
  skills: 50,
  experience: 20,
  career: 0,
  impact: 10,
  education: 5,
  social: 0,
  custom: [
    {
      key: "site",
      label: "Site readiness",
      hint: "Has worked on site in a hot climate or remote location",
      weight: 15,
    },
  ],
};

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const mkUser = async (email: string) =>
    (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
  hr = await mkUser(hrEmail);
  rec = await mkUser(recEmail);
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Tpl", slug: `tpl-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  for (const [u, email, roles] of [
    [hr, hrEmail, ["hr_head", "recruiter"]],
    [rec, recEmail, ["recruiter"]],
  ] as const) {
    await db.insert(orgMembers).values({
      orgId,
      userId: u,
      email,
      fullName: email,
      status: "active",
      isOwner: false,
    } as never);
    for (const r of roles)
      await db.insert(userRoles).values({ userId: u, orgId, role: r as never });
  }
});

afterAll(async () => {
  if (orgId) {
    await db.delete(auditLog).where(eq(auditLog.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
  await db.delete(users).where(inArray(users.id, [hr, rec].filter(Boolean)));
});

describe("organisation scoring template", () => {
  test("starts at the platform default", async () => {
    const t = await tpl.getScoringTemplate(orgId);
    expect(t.isDefault).toBe(true);
    expect(t.template).toEqual(tpl.PLATFORM_DEFAULT_TEMPLATE);
    expect(await tpl.templateColumns(orgId)).toEqual({});
  });

  test("only leaders change it; totals and hints are validated; changes are audited", async () => {
    await expect(tpl.saveScoringTemplateCore(asRec(), TEMPLATE)).rejects.toThrow(/HR head/);
    await expect(tpl.saveScoringTemplateCore(asHr(), { ...TEMPLATE, skills: 60 })).rejects.toThrow(
      /total 100/,
    );
    await expect(
      tpl.saveScoringTemplateCore(asHr(), {
        ...TEMPLATE,
        custom: [{ ...TEMPLATE.custom[0]!, hint: "short" }],
      }),
    ).rejects.toThrow(/hint/);
    expect((await tpl.saveScoringTemplateCore(asHr(), TEMPLATE)).changed).toBe(true);
    expect((await tpl.saveScoringTemplateCore(asHr(), TEMPLATE)).changed).toBe(false);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "org.scoring_template_changed")));
    expect(audit).toHaveLength(1);
  });

  test("new requisitions start from the template", async () => {
    const { id } = await createRequisitionCore(asHr(), {
      title: "Landscape Specialist",
      departmentId: null,
      location: "Riyadh",
      openings: 1,
      experienceMin: 7,
      experienceMax: 15,
      budgetCtc: 0,
      hiringManager: null,
      mustHaveSkills: ["Irrigation"],
      goodToHaveSkills: [],
      responsibilities: "",
      educationRequirement: null,
    } as never);
    const [r] = await db.select().from(requisitions).where(eq(requisitions.id, id));
    expect(r!.weightSkills).toBe(50);
    expect(r!.weightCareer).toBe(0);
    expect(r!.customWeights).toEqual(TEMPLATE.custom);
  });

  test("apply to open roles: through each role's rules; roles in approval are skipped", async () => {
    const mk = async (code: string, status: string) =>
      (
        await db
          .insert(requisitions)
          .values({ orgId, code, title: code, status, createdBy: hr } as never)
          .returning({ id: requisitions.id })
      )[0]!.id;
    const open = await mk(`TPL-A-${stamp}`, "approved");
    await mk(`TPL-B-${stamp}`, "pending_hr");
    await expect(tpl.applyTemplateToOpenRolesCore(asRec())).rejects.toThrow(/HR head/);
    const out = await tpl.applyTemplateToOpenRolesCore(asHr());
    expect(out.applied).toContain(`TPL-A-${stamp}`);
    expect(out.skipped.map((s) => s.code)).toContain(`TPL-B-${stamp}`);
    const [r] = await db.select().from(requisitions).where(eq(requisitions.id, open));
    expect(r!.weightSkills).toBe(50);
    expect(r!.customWeights).toEqual(TEMPLATE.custom);
  });

  test("reset returns to the platform default", async () => {
    await tpl.saveScoringTemplateCore(asHr(), null);
    expect((await tpl.getScoringTemplate(orgId)).isDefault).toBe(true);
  });
});
