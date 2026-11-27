/**
 * CV versions, claims and the consolidated profile (plan row 2, A2): version
 * dedupe by file hash, pending public-surface versions, claims extraction
 * through the gateway (mocked) with invented passages dropped, consolidation
 * across versions, the consistency flags, merge moving versions with the
 * stricter consent winning, and erasure removing versions, claims and
 * tombstones.
 *
 * Run: DATABASE_URL=<disposable local db> bun test scripts/candidate-versions.test.ts
 */
import { readFileSync } from "node:fs";
try {
  const dotEnv = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of dotEnv.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !m[1]!.startsWith("DATABASE_URL") && process.env[m[1]!] === undefined)
      process.env[m[1]!] = m[2]!;
  }
} catch {
  // no .env.local — the caller must have exported everything.
}
process.env["SECRET_ENCRYPTION_KEY"] ??= Buffer.alloc(32, 7).toString("base64");

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";

// The gateway is mocked: tests assert what is sent and how the answer is stored.
const calls: { system: string; prompt: string; feature: string }[] = [];
let nextClaims: unknown[] = [];
const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiJson: async (opts: {
    system: string;
    prompt: string;
    feature: string;
    schema?: { parse: (v: unknown) => unknown };
  }) => {
    calls.push({ system: opts.system, prompt: opts.prompt, feature: opts.feature });
    const raw = { claims: nextClaims };
    return { ok: true, data: opts.schema ? opts.schema.parse(raw) : raw };
  },
}));

const { db } = await import("../src/server/db");
const { auditLog, candidateClaims, candidateCvVersions, candidates, organizations } =
  await import("../drizzle/schema");
const versions = await import("../src/server/candidates/versions.server");
const identity = await import("../src/server/candidates/identity.server");
const { eraseCandidatesCore } = await import("../src/server/erase.server");

const stamp = Date.now();
const dom = `cv-${stamp}.test`;
let orgA: string;

async function mkOrg(name: string) {
  return (
    await db
      .insert(organizations)
      .values({
        name,
        slug: `${name}-${stamp}`.toLowerCase().replace(/\s+/g, "-"),
        status: "active",
      })
      .returning({ id: organizations.id })
  )[0]!.id;
}

async function mkCandidate(over: Partial<typeof candidates.$inferInsert> = {}) {
  return (
    await db
      .insert(candidates)
      .values({
        orgId: orgA,
        fullName: over.fullName ?? "Test Person",
        email: over.email ?? `p-${Math.random().toString(36).slice(2)}@${dom}`,
        ...over,
      })
      .returning()
  )[0]!;
}

const CV_A =
  "Jane Doe. Account Manager at Acme Ltd, 2019 - 2022. Led outbound prospecting to 40 home " +
  "and living brands, onboarding 25 sellers onto the marketplace. Skills: CRM, B2B sales, Excel.";
const CV_B =
  "Jane Doe. Account Manager at Acme Ltd, 2018 - 2022. Built the seller onboarding programme " +
  "for furniture brands. Skills: B2B sales, negotiation.";

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgA = await mkOrg("CV Versions A");
});

afterAll(async () => {
  if (orgA) {
    await db.delete(auditLog).where(eq(auditLog.orgId, orgA));
    await db.delete(organizations).where(eq(organizations.id, orgA));
  }
});

describe("pure helpers", () => {
  test("claim values normalise case, spacing and edge punctuation", () => {
    expect(versions.normaliseClaimValue("  B2B   Sales. ")).toBe("b2b sales");
  });
  test("a passage must occur in the CV (whitespace/case-insensitive)", () => {
    const hay = CV_A.toLowerCase().replace(/\s+/g, " ");
    expect(versions.passageOccurs(hay, "Led outbound   prospecting to 40 home")).toBe(true);
    expect(versions.passageOccurs(hay, "Managed a team of 200 engineers at Google")).toBe(false);
  });
  test("JD mirroring: copied sentences score high, shared skills alone do not", () => {
    const jd =
      "Proactively conduct outbound prospecting via multi-channel campaigns including email phone and social";
    const copied = `Summary. ${jd}. I also like hiking.`;
    expect(versions.shingleContainment(copied, jd)).toBeGreaterThan(0.4);
    expect(versions.shingleContainment(CV_A, jd)).toBe(0);
  });
  test("timeline flags: same employer, different dates", () => {
    const flags = versions.timelineFlags([
      {
        type: "role",
        value: "Account Manager",
        employer: "Acme Ltd",
        start: "2019",
        end: "2022",
        versionIds: ["a"],
      },
      {
        type: "role",
        value: "Account Manager",
        employer: "Acme Ltd",
        start: "2018",
        end: "2022",
        versionIds: ["b"],
      },
    ]);
    expect(flags.some((f) => f.kind === "date_conflict")).toBe(true);
  });
});

describe("versions and claims", () => {
  test("same file for the same person is one version", async () => {
    const c = await mkCandidate();
    const a = await versions.recordCvVersion({
      orgId: orgA,
      candidateId: c.id,
      source: "upload",
      fileHash: "h1",
      parsedText: CV_A,
    });
    const b = await versions.recordCvVersion({
      orgId: orgA,
      candidateId: c.id,
      source: "upload",
      fileHash: "h1",
      parsedText: CV_A,
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });

  test("extraction is fenced, uses the feature slug, drops invented passages, and consolidates", async () => {
    const c = await mkCandidate();
    const v1 = await versions.recordCvVersion({
      orgId: orgA,
      candidateId: c.id,
      source: "upload",
      fileHash: "a1",
      parsedText: CV_A,
    });
    const v2 = await versions.recordCvVersion({
      orgId: orgA,
      candidateId: c.id,
      source: "upload",
      fileHash: "a2",
      parsedText: CV_B,
    });
    nextClaims = [
      { type: "skill", value: "B2B sales", evidence: "listed", passage: "Skills: CRM, B2B sales" },
      {
        type: "skill",
        value: "Seller onboarding",
        evidence: "demonstrated",
        passage: "onboarding 25 sellers onto the marketplace",
      },
      {
        type: "skill",
        value: "Rocket science",
        evidence: "demonstrated",
        passage: "Built rockets at NASA",
      },
      {
        type: "role",
        value: "Account Manager",
        evidence: "demonstrated",
        passage: "Account Manager at Acme Ltd, 2019 - 2022",
        employer: "Acme Ltd",
        start: "2019",
        end: "2022",
      },
    ];
    calls.length = 0;
    const r1 = await versions.extractClaimsForVersion(orgA, v1.id);
    expect(r1).toEqual({ ok: true, count: 3 }); // the invented NASA passage is dropped
    expect(calls[0]!.feature).toBe("cv_claims_extract");
    expect(calls[0]!.system).toContain(realGateway.INJECTION_RULES.slice(0, 40));
    expect(calls[0]!.prompt).toContain("<untrusted_data");

    nextClaims = [
      {
        type: "skill",
        value: "b2b sales",
        evidence: "demonstrated",
        passage: "Built the seller onboarding programme",
      },
      {
        type: "role",
        value: "Account Manager",
        evidence: "demonstrated",
        passage: "Account Manager at Acme Ltd, 2018 - 2022",
        employer: "Acme Ltd",
        start: "2018",
        end: "2022",
      },
    ];
    await versions.extractClaimsForVersion(orgA, v2.id);

    const p = await versions.getConsolidatedProfile(orgA, c.id);
    const b2b = p.claims.find((x) => x.type === "skill" && x.value.toLowerCase() === "b2b sales")!;
    expect(b2b.strength).toBe("demonstrated"); // max across versions
    expect(b2b.versionIds.length).toBe(2);
    expect(p.flags.some((f) => f.kind === "date_conflict")).toBe(true);
  });

  test("a pending (public-surface) version stays out of the profile until accepted", async () => {
    const c = await mkCandidate();
    const v = await versions.recordCvVersion({
      orgId: orgA,
      candidateId: c.id,
      source: "apply",
      parsedText: CV_A,
      accepted: false,
    });
    const [row] = await db
      .select()
      .from(candidateCvVersions)
      .where(eq(candidateCvVersions.id, v.id));
    expect(row!.extractionStatus).toBe("skipped");
    nextClaims = [{ type: "skill", value: "CRM", evidence: "listed", passage: "Skills: CRM" }];
    await versions.extractClaimsForVersion(orgA, v.id);
    expect((await versions.getConsolidatedProfile(orgA, c.id)).claims).toHaveLength(0);
    expect(await versions.acceptCvVersion(orgA, v.id)).toBe(true);
    expect((await versions.getConsolidatedProfile(orgA, c.id)).claims).toHaveLength(1);
    expect(await versions.acceptCvVersion(orgA, v.id)).toBe(false);
  });
});

describe("merge and erasure", () => {
  test("merge moves versions and claims; the stricter consent wins", async () => {
    const survivor = await mkCandidate({ fullName: "Jane Doe", poolUse: "pool" });
    const absorbed = await mkCandidate({
      fullName: "Jane Doe",
      poolUse: "role_only",
      poolUseSource: "portal",
      consentGiven: false,
    });
    const v = await versions.recordCvVersion({
      orgId: orgA,
      candidateId: absorbed.id,
      source: "upload",
      parsedText: CV_A,
    });
    nextClaims = [{ type: "skill", value: "CRM", evidence: "listed", passage: "Skills: CRM" }];
    await versions.extractClaimsForVersion(orgA, v.id);
    await identity.mergeCandidatesCore({
      orgId: orgA,
      survivorId: survivor.id,
      mergedId: absorbed.id,
      actor: { email: "t@x" },
    });
    const [s] = await db.select().from(candidates).where(eq(candidates.id, survivor.id));
    expect(s!.poolUse).toBe("role_only");
    expect(s!.consentGiven).toBe(false);
    const moved = await db
      .select()
      .from(candidateCvVersions)
      .where(
        and(eq(candidateCvVersions.orgId, orgA), eq(candidateCvVersions.candidateId, survivor.id)),
      );
    expect(moved.map((r) => r.id)).toContain(v.id);
    const claims = await db
      .select()
      .from(candidateClaims)
      .where(eq(candidateClaims.candidateId, survivor.id));
    expect(claims.length).toBe(1);
  });

  test("erasing a person removes versions, claims and the records merged into them", async () => {
    const survivor = await mkCandidate({ fullName: "Erase Me" });
    const absorbed = await mkCandidate({ fullName: "Erase Me" });
    await versions.recordCvVersion({
      orgId: orgA,
      candidateId: absorbed.id,
      source: "upload",
      parsedText: CV_A,
    });
    await identity.mergeCandidatesCore({
      orgId: orgA,
      survivorId: survivor.id,
      mergedId: absorbed.id,
      actor: { email: "t@x" },
    });
    await eraseCandidatesCore(orgA, [survivor.id]);
    const left = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(eq(candidates.fullName, "Erase Me"));
    expect(left).toHaveLength(0);
    const vs = await db
      .select()
      .from(candidateCvVersions)
      .where(eq(candidateCvVersions.candidateId, absorbed.id));
    expect(vs).toHaveLength(0);
  });
});
