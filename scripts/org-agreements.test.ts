/**
 * Organisation agreements (migration 0052), against the disposable database:
 *  - registration input is refused without an accepted, signed agreement;
 *  - acceptance is stored per document and version with the signatory's
 *    name, title and email, the IP only as an HMAC, and is audited;
 *  - accepting again is a no-op; a stale version is refused;
 *  - a new document version is outstanding again until it is accepted;
 *  - status is scoped to the organisation; the platform listing shows every
 *    organisation; deleting an organisation removes its rows.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/org-agreements.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const { auditLog, orgAgreements, organizations, users } = await import("../drizzle/schema");
const legal = await import("../src/lib/legal/agreements");
const { AgreementAcceptanceInput, agreementMissing, agreementPayload, EMPTY_AGREEMENT } =
  await import("../src/lib/legal/acceptance");
const { CreateInput } = await import("../src/lib/org.functions");
const core = await import("../src/server/org-agreements.server");

const stamp = Date.now();
let orgId: string;
let otherOrgId: string;
let owner: string;
const ownerEmail = `agree-owner-${stamp}@test.local`;

const signed = () =>
  agreementPayload({
    accepted: true,
    signatoryName: "Priya Raman",
    signatoryTitle: "Chief Human Resources Officer",
  });

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  owner = (await db.insert(users).values({ email: ownerEmail }).returning({ id: users.id }))[0]!.id;
  [orgId, otherOrgId] = await Promise.all(
    ["a", "b"].map(
      async (tag) =>
        (
          await db
            .insert(organizations)
            .values({ name: `Agreement Org ${tag}`, slug: `agree-${tag}-${stamp}` })
            .returning({ id: organizations.id })
        )[0]!.id,
    ),
  );
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, otherOrgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, owner));
});

describe("registration input", () => {
  const base = {
    name: "Acme",
    legalName: "Acme Pvt Ltd",
    industry: "IT services",
    hqCountry: "India",
    hqCity: "Chennai",
    employeeBand: "51-200",
    careersEmail: "careers@acme.example",
    departments: [{ name: "Engineering", headName: "" }],
    locations: ["Chennai"],
  };

  test("refuses an organisation without the agreement", () => {
    expect(() => CreateInput.parse(base)).toThrow();
    expect(() =>
      CreateInput.parse({ ...base, agreement: { ...signed(), accepted: false } }),
    ).toThrow();
    expect(() =>
      CreateInput.parse({ ...base, agreement: { ...signed(), signatoryTitle: "" } }),
    ).toThrow();
    expect(CreateInput.parse({ ...base, agreement: signed() }).agreement.signatoryName).toBe(
      "Priya Raman",
    );
  });

  test("the form lists what is missing and sends the current versions", () => {
    expect(agreementMissing(EMPTY_AGREEMENT)).toEqual([
      "Signatory name",
      "Signatory title",
      "Agreement acceptance",
    ]);
    expect(signed().versions).toEqual(legal.currentAgreementVersions());
    expect(AgreementAcceptanceInput.safeParse(signed()).success).toBe(true);
  });

  test("a stale version is refused", () => {
    expect(() => core.assertCurrentVersions({ ...signed().versions, dpa: "2000-01-01" })).toThrow(
      /updated after you opened them/,
    );
  });
});

describe("recording acceptance", () => {
  test("nothing accepted means every document is outstanding", async () => {
    const status = await core.orgAgreementStatus(orgId);
    expect(status.outstanding).toEqual(["terms", "privacy", "dpa"]);
    expect(status.history).toEqual([]);
  });

  test("stores each document with the signatory and an IP hash, and audits it", async () => {
    const ipHash = core.hashIp("203.0.113.9");
    const { recorded } = await core.recordAgreementAcceptance({
      orgId,
      userId: owner,
      email: ownerEmail.toUpperCase(),
      acceptance: signed(),
      ipHash,
    });
    expect(recorded.sort()).toEqual(["dpa", "privacy", "terms"]);

    const rows = await db.select().from(orgAgreements).where(eq(orgAgreements.orgId, orgId));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.version).toBe(legal.AGREEMENTS[r.kind as "terms"].version);
      expect(r.acceptedBy).toBe(owner);
      expect(r.accepterName).toBe("Priya Raman");
      expect(r.accepterTitle).toBe("Chief Human Resources Officer");
      expect(r.accepterEmail).toBe(ownerEmail);
      expect(r.ipHash).toBe(ipHash);
      expect(r.ipHash).not.toContain("203.0.113.9");
    }

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "org.agreement.accepted")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorUserId).toBe(owner);
    expect((audits[0]!.detail as { documents: Record<string, string> }).documents).toEqual(
      legal.currentAgreementVersions(),
    );

    expect((await core.orgAgreementStatus(orgId)).outstanding).toEqual([]);
  });

  test("accepting again is a no-op and is not audited twice", async () => {
    const { recorded } = await core.recordAgreementAcceptance({
      orgId,
      userId: owner,
      email: ownerEmail,
      acceptance: signed(),
      ipHash: null,
    });
    expect(recorded).toEqual([]);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "org.agreement.accepted")));
    expect(audits).toHaveLength(1);
  });

  test("a new version is outstanding again until the owner accepts it", async () => {
    const bumped = { ...legal.currentAgreementVersions(), dpa: "2099-01-01" };
    expect((await core.orgAgreementStatus(orgId, bumped)).outstanding).toEqual(["dpa"]);

    // The old version no longer passes once the document has moved on.
    await expect(
      core.recordAgreementAcceptance({
        orgId,
        userId: owner,
        email: ownerEmail,
        acceptance: signed(),
        ipHash: null,
        current: bumped,
      }),
    ).rejects.toThrow(/updated after you opened them/);

    const { recorded } = await core.recordAgreementAcceptance({
      orgId,
      userId: owner,
      email: ownerEmail,
      acceptance: { ...signed(), versions: bumped },
      ipHash: null,
      current: bumped,
    });
    expect(recorded).toEqual(["dpa"]);
    const status = await core.orgAgreementStatus(orgId, bumped);
    expect(status.outstanding).toEqual([]);
    // Both DPA versions stay in the history.
    expect(status.history.filter((h) => h.kind === "dpa").map((h) => h.version)).toContain(
      legal.AGREEMENTS.dpa.version,
    );
    expect(status.history).toHaveLength(4);
  });

  test("status is scoped to the organisation", async () => {
    expect((await core.orgAgreementStatus(otherOrgId)).outstanding).toEqual([
      "terms",
      "privacy",
      "dpa",
    ]);
  });

  test("the platform listing shows who accepted what for every organisation", async () => {
    const all = await core.listAllOrgAgreements();
    const mine = all.find((o) => o.orgId === orgId)!;
    const other = all.find((o) => o.orgId === otherOrgId)!;
    expect(mine.outstanding).toEqual([]);
    expect(mine.history[0]!.accepterEmail).toBe(ownerEmail);
    expect(other.outstanding).toHaveLength(3);
    expect(other.history).toEqual([]);
  });

  test("the IP hash is keyed and never reversible to the address", () => {
    expect(core.hashIp("203.0.113.9")).toBe(core.hashIp("203.0.113.9"));
    expect(core.hashIp("203.0.113.9")).not.toBe(core.hashIp("203.0.113.10"));
    expect(core.hashIp("unknown")).toBeNull();
    expect(core.hashIp(null)).toBeNull();
  });

  test("deleting the organisation removes its agreement rows", async () => {
    const [tmp] = await db
      .insert(organizations)
      .values({ name: "Agreement Org tmp", slug: `agree-tmp-${stamp}` })
      .returning({ id: organizations.id });
    await core.recordAgreementAcceptance({
      orgId: tmp!.id,
      userId: owner,
      email: ownerEmail,
      acceptance: signed(),
      ipHash: null,
    });
    await db.delete(organizations).where(eq(organizations.id, tmp!.id));
    expect(
      await db.select().from(orgAgreements).where(eq(orgAgreements.orgId, tmp!.id)),
    ).toHaveLength(0);
  });
});
