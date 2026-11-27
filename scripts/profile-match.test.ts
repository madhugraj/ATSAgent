/**
 * Profile matching (plan row 8, C1): the evidence pass ranks demonstrated
 * evidence above listed above bare text; experience/location factors; the
 * requirement review only counts citations that resolve to the candidate's own
 * claims; the overall score is computed in code; reruns only re-review
 * candidates whose profile changed; unapproved or unprofiled requisitions are
 * not ranked; the pool excludes merged, non-consented and role-only people.
 *
 * Run: DATABASE_URL=<disposable local db> bun test scripts/profile-match.test.ts
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

let judgeCalls = 0;
const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiJson: async (opts: {
    prompt: string;
    feature: string;
    schema?: { parse: (v: unknown) => unknown };
  }) => {
    let raw: unknown;
    if (opts.feature === "profile_match") {
      judgeCalls++;
      // Cite C1 for R1 when the profile mentions e-commerce; also cite a fake id.
      const has = /e-commerce/i.test(opts.prompt.split("candidate_profile")[1] ?? "");
      raw = {
        requirements: [
          { id: "R1", verdict: has ? "met" : "missing", claimIds: has ? ["C1", "C99"] : [] },
          { id: "R2", verdict: "met", claimIds: ["C99"] },
        ],
        knockouts: [],
        rationale: has ? "Strong e-commerce evidence." : "No e-commerce evidence.",
      };
    } else raw = { expansions: [] };
    return { ok: true, data: opts.schema ? opts.schema.parse(raw) : raw };
  },
}));

const { db } = await import("../src/server/db");
const S = await import("../drizzle/schema");
const pm = await import("../src/server/candidates/profile-match.server");

const stamp = Date.now();
let orgA: string;
let reqId: string;

const REQ = {
  title: "Seller Growth Executive",
  roleFamily: "sales",
  seniority: "ic",
  sector: "e-commerce",
  employmentType: "permanent",
  location: { city: "London", country: "UK", remotePolicy: "hybrid" },
  rightToWork: null,
  languages: [],
  experienceYears: { min: null, max: 5 },
  mustHave: ["Direct e-commerce experience", "B2B sales acumen"],
  niceToHave: [],
  responsibilities: [],
  hiringClient: null,
  jobCode: null,
  pay: { status: "unknown" },
  suspectedPromptInjection: false,
} as const;

async function person(
  name: string,
  over: Partial<typeof S.candidates.$inferInsert>,
  claims: [string, "demonstrated" | "listed", string][],
) {
  const [c] = await db
    .insert(S.candidates)
    .values({
      orgId: orgA,
      fullName: name,
      email: `${name.replace(/\s/g, "")}-${stamp}@x.test`,
      ...over,
    })
    .returning();
  if (claims.length) {
    const [v] = await db
      .insert(S.candidateCvVersions)
      .values({
        orgId: orgA,
        candidateId: c!.id,
        source: "upload",
        parsedText: "x",
        extractionStatus: "done",
      })
      .returning();
    await db.insert(S.candidateClaims).values(
      claims.map(([value, strength, passage]) => ({
        orgId: orgA,
        candidateId: c!.id,
        versionId: v!.id,
        claimType: "skill" as const,
        rawValue: value,
        normalisedValue: value.toLowerCase(),
        evidenceStrength: strength,
        passage,
      })),
    );
  }
  return c!;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgA = (
    await db
      .insert(S.organizations)
      .values({ name: "PM A", slug: `pm-a-${stamp}`, status: "active" })
      .returning()
  )[0]!.id;
  reqId = (
    await db
      .insert(S.requisitions)
      .values({
        orgId: orgA,
        title: "Seller Growth Executive",
        code: `PM-${stamp}`,
        status: "approved",
      } as never)
      .returning()
  )[0]!.id;
  await db
    .insert(S.jdRequirementProfiles)
    .values({ orgId: orgA, requisitionId: reqId, profile: REQ as never });
});

afterAll(async () => {
  if (orgA) {
    await db.delete(S.auditLog).where(eq(S.auditLog.orgId, orgA));
    await db.delete(S.organizations).where(eq(S.organizations.id, orgA));
  }
});

describe("evidence pass", () => {
  test("fallback terms pull matchable phrases out of a requirement sentence", () => {
    const t = pm.fallbackTerms(
      "Proven B2B sales acumen, ideally gained within e-commerce or online marketplace",
    );
    expect(t).toContain("b2b sales acumen");
    expect(t.some((x) => x.includes("e-commerce"))).toBe(true);
  });

  test("demonstrated beats listed beats text-only", () => {
    const w = pm.normaliseWeights(null);
    const ex = [
      { requirement: "Direct e-commerce experience", kind: "must" as const, terms: ["e-commerce"] },
    ];
    const mk = (strength: "demonstrated" | "listed" | null, text = "") => ({
      id: strength ?? "t",
      experienceYears: 3,
      location: "London",
      text,
      stamp: "",
      claims: strength
        ? [
            {
              id: "c",
              versionId: "v",
              type: "skill",
              value: "E-commerce",
              key: "e-commerce",
              passage: "e-commerce",
              strength,
            },
          ]
        : [],
    });
    const r = (c: ReturnType<typeof mk>) => pm.coarseScore(c, REQ as never, ex, w, []).score;
    expect(r(mk("demonstrated"))).toBeGreaterThan(r(mk("listed")));
    expect(r(mk("listed"))).toBeGreaterThan(r(mk(null, "did some e-commerce")));
    expect(r(mk(null, "did some e-commerce"))).toBeGreaterThan(r(mk(null, "")));
  });

  test("the overall score comes from verdicts in code", () => {
    const w = pm.normaliseWeights({ must: 1, nice: 0, experience: 0, sector: 0, location: 0 });
    const coarse = { candidateId: "x", score: 0, factors: [], requirementHits: [], knockouts: [] };
    const met = pm.scoreFromVerdicts(
      [
        {
          requirement: "a",
          kind: "must",
          verdict: "met",
          strength: "demonstrated",
          evidence: [],
          note: null,
        },
      ],
      coarse,
      w,
    );
    const partial = pm.scoreFromVerdicts(
      [
        {
          requirement: "a",
          kind: "must",
          verdict: "partial",
          strength: "listed",
          evidence: [],
          note: null,
        },
      ],
      coarse,
      w,
    );
    expect(met.overall).toBe(100);
    expect(partial.overall).toBe(30);
  });
});

describe("a ranking run", () => {
  test("ranks the eligible pool, verifies citations, and re-reviews only changed profiles", async () => {
    const strong = await person("Strong One", { location: "London, UK", experienceYears: "4" }, [
      ["E-commerce", "demonstrated", "Grew e-commerce sellers on the marketplace"],
    ]);
    const weak = await person("Weak One", { location: "Paris", experienceYears: "4" }, [
      ["Retail", "listed", "Retail"],
    ]);
    const merged = await person("Merged One", { mergedIntoId: strong.id }, []);
    const roleOnly = await person("Role Only", { poolUse: "role_only" }, []);

    judgeCalls = 0;
    const out = await pm.runRequisitionMatch(orgA, reqId, { topK: 10 });
    expect(out.status).toBe("done");
    expect(out.pool).toBe(2); // merged and role-only people are not in the pool
    const rows = await db
      .select()
      .from(S.profileMatchScores)
      .where(eq(S.profileMatchScores.requisitionId, reqId));
    const ids = rows.map((r) => r.candidateId);
    expect(ids).not.toContain(merged.id);
    expect(ids).not.toContain(roleOnly.id);
    const s = rows.find((r) => r.candidateId === strong.id)!;
    const w = rows.find((r) => r.candidateId === weak.id)!;
    expect(s.stage).toBe("judged");
    expect(s.overallScore!).toBeGreaterThan(w.overallScore ?? 0);
    // R1 cites C1 (real) and C99 (invented): only the real claim is evidence.
    expect(s.requirements[0]!.evidence).toHaveLength(1);
    // R2 cites only an invented id: no evidence → missing.
    expect(s.requirements[1]!.verdict).toBe("missing");
    expect(s.rationale).toContain("e-commerce");

    const before = judgeCalls;
    await pm.runRequisitionMatch(orgA, reqId, { topK: 10 });
    expect(judgeCalls).toBe(before); // nothing changed, nothing re-reviewed
  });

  test("an unapproved requisition is not ranked", async () => {
    const [r] = await db
      .insert(S.requisitions)
      .values({ orgId: orgA, title: "Draft", code: `PMD-${stamp}`, status: "draft" } as never)
      .returning();
    expect((await pm.runRequisitionMatch(orgA, r!.id)).status).toBe("not_approved");
    await db
      .update(S.requisitions)
      .set({ status: "approved" } as never)
      .where(eq(S.requisitions.id, r!.id));
    expect((await pm.runRequisitionMatch(orgA, r!.id)).status).toBe("no_profile");
    const any = await db
      .select()
      .from(S.profileMatchScores)
      .where(and(eq(S.profileMatchScores.requisitionId, r!.id)));
    expect(any).toHaveLength(0);
  });
});
