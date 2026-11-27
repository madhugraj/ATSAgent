/**
 * Candidate identity (plan row 1): normalisation and key computation, the
 * strong-key / shared-key / fuzzy decision rules, the reversible merge with
 * its undo (including the refusal rule and same-requisition application
 * restoration), keep-separate shared keys, and cross-tenant isolation.
 *
 * Run: bun --env-file=.env.local test scripts/candidate-identity.test.ts
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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  applications,
  auditLog,
  candidateIdentityKeys,
  candidateIdentitySettings,
  candidateMergeSuggestions,
  candidateMerges,
  candidates,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const norm = await import("../src/lib/candidates/identity-normalise");
const identity = await import("../src/server/candidates/identity.server");
const stepUp = await import("../src/server/step-up");

const stamp = Date.now();
const dom = `ci-${stamp}.test`;

let orgA: string;
let orgB: string;
let userId: string;
let reqId: string;

function hashOf(v: string) {
  return createHash("sha256").update(v).digest("hex");
}

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

async function mkCandidate(orgId: string, over: Partial<typeof candidates.$inferInsert> = {}) {
  return (
    await db
      .insert(candidates)
      .values({
        orgId,
        fullName: over.fullName ?? "Test Person",
        email: over.email ?? `person-${Math.random().toString(36).slice(2)}@${dom}`,
        ...over,
      })
      .returning()
  )[0]!;
}

async function mkApplication(
  candidateId: string,
  requisitionId: string,
  over: Partial<typeof applications.$inferInsert> = {},
) {
  return (
    await db
      .insert(applications)
      .values({ candidateId, requisitionId, orgId: orgA, ...over })
      .returning()
  )[0]!;
}

const actor = { email: `tester@${dom}` };

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgA = await mkOrg(`CI Identity A`);
  orgB = await mkOrg(`CI Identity B`);
  userId = (
    await db
      .insert(users)
      .values({ email: `owner@${dom}` })
      .returning({ id: users.id })
  )[0]!.id;
  reqId = (
    await db
      .insert(requisitions)
      .values({
        orgId: orgA,
        code: `REQ-CI-${stamp}`,
        title: "Platform Engineer",
        status: "approved",
        createdBy: userId,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
});

afterAll(async () => {
  // audit_log has no FK — clear by org id, then let the cascades do the rest.
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    await db.delete(auditLog).where(eq(auditLog.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
  if (userId) await db.delete(users).where(eq(users.id, userId));
});

describe("normalisation", () => {
  test("email folds gmail dots and +tags", () => {
    expect(norm.normEmail("First.Last+cv@Gmail.com")).toBe("firstlast@gmail.com");
    expect(norm.normEmail("person+tag@example.com")).toBe("person@example.com");
    expect(norm.normEmail("Person@Example.COM")).toBe("person@example.com");
  });

  test("placeholder domains never become email keys", () => {
    const ph = `jane-doe.abc123${norm.PLACEHOLDER_DOMAIN}`;
    expect(norm.isPlaceholderEmail(ph)).toBe(true);
    expect(norm.normEmail(ph)).toBe("");
    expect(norm.normEmail("x@import.local")).toBe("");
  });

  test("phone parses E.164 with an explicit + or the tenant region; weak fallback otherwise", () => {
    expect(norm.normPhone("+91 98765 43210").strong).toBe("+919876543210");
    expect(norm.normPhone("9876543210", "in").strong).toBe("+919876543210");
    expect(norm.normPhone("9876543210").strong).toBe("");
    expect(norm.normPhone("9876543210").weak).toBe("9876543210");
  });

  test("profile URLs canonicalise away protocol, www and /in/", () => {
    expect(norm.normProfileUrl("https://www.linkedin.com/in/jane-doe/")).toBe(
      "linkedin.com/jane-doe",
    );
  });

  test("fuzzy score: timeline overlap outweighs a bare name match", () => {
    const samePerson = norm.fuzzyIdentityScore({
      fullNameA: "Jane A. Doe",
      fullNameB: "Doe Jane",
      timelineA: [
        { company: "Acme", start: 2019 },
        { company: "Globex", start: 2022 },
      ],
      timelineB: [
        { company: "Globex", start: "2022" },
        { company: "Acme", start: "2019" },
      ],
      educationA: "IIT Delhi",
      educationB: null,
      locationA: "Bengaluru",
      locationB: "Bengaluru",
    });
    const different = norm.fuzzyIdentityScore({
      fullNameA: "Jane Doe",
      fullNameB: "Jane Doe",
      timelineA: [{ company: "Acme", start: 2019 }],
      timelineB: [{ company: "Initech", start: 2021 }],
      educationA: "IIT Delhi",
      educationB: "NIIT",
      locationA: "Bengaluru",
      locationB: "Pune",
    });
    expect(samePerson.score).toBeGreaterThan(0.7);
    expect(different.score).toBeLessThan(norm.FUZZY_WEIGHTS.name + 0.05);
  });
});

describe("computeIdentityKeys", () => {
  test("real email keys as email, placeholder keys as placeholder", () => {
    const keys = identity.computeIdentityKeys({
      fullName: "Jane Doe",
      email: `jane.doe+cv@gmail.com`,
    });
    expect(keys).toContainEqual({ keyType: "email", keyValue: "janedoe@gmail.com" });
    const ph = identity.computeIdentityKeys({
      fullName: "Jane Doe",
      email: `jane-doe.deadbeef${norm.PLACEHOLDER_DOMAIN}`,
    });
    expect(ph.map((k) => k.keyType)).toEqual(["placeholder"]);
  });

  test("weak phone keys as shared_phone, strong as phone", () => {
    expect(identity.computeIdentityKeys({ fullName: "A", phone: "9876543210" })).toEqual([
      { keyType: "shared_phone", keyValue: "9876543210" },
    ]);
    expect(identity.computeIdentityKeys({ fullName: "A", phone: "+919876543210" })).toEqual([
      { keyType: "phone", keyValue: "+919876543210" },
    ]);
  });

  test("file hash and external id become keys", () => {
    const keys = identity.computeIdentityKeys({
      fullName: "A",
      fileHash: "abc123",
      externalProvider: "indeed",
      externalId: "e-1",
    });
    expect(keys).toContainEqual({ keyType: "file_hash", keyValue: "abc123" });
    expect(keys).toContainEqual({ keyType: "external", keyValue: "indeed:e-1" });
  });
});

describe("resolveIdentity against the database", () => {
  test("strong key (linkedin) merges despite a different email", async () => {
    const existing = await mkCandidate(orgA, {
      fullName: "Jane Doe",
      email: `jane-a@${dom}`,
      linkedinUrl: "https://www.linkedin.com/in/jane-doe-ci",
    });
    await db.insert(candidateIdentityKeys).values({
      orgId: orgA,
      candidateId: existing.id,
      keyType: "linkedin",
      keyValue: "linkedin.com/jane-doe-ci",
    });
    const outcome = await identity.resolveIdentity({
      orgId: orgA,
      fullName: "Jane Doe",
      email: `jane-b@${dom}`,
      linkedinUrl: "linkedin.com/in/jane-doe-ci",
    });
    expect(outcome.outcome).toBe("merged");
    expect(outcome.candidateId).toBe(existing.id);
  });

  test("file hash: same bytes + same name attaches; different name reviews", async () => {
    const hash = hashOf(`cv-${stamp}`);
    const named = await mkCandidate(orgA, { fullName: "Ravi Kumar" });
    await db.insert(candidateIdentityKeys).values({
      orgId: orgA,
      candidateId: named.id,
      keyType: "file_hash",
      keyValue: hash,
    });
    const attach = await identity.resolveIdentity({
      orgId: orgA,
      fullName: "Ravi Kumar",
      fileHash: hash,
    });
    expect(attach.outcome).toBe("attach");
    const review = await identity.resolveIdentity({
      orgId: orgA,
      fullName: "Different Person",
      fileHash: hash,
    });
    expect(review.outcome).toBe("review");
    expect(review.reasons[0]?.signal).toBe("file_hash");
  });

  test("autoMergeStrongKeys off sends a strong-key hit to review", async () => {
    await db
      .insert(candidateIdentitySettings)
      .values({ orgId: orgB, autoMergeStrongKeys: false })
      .onConflictDoNothing();
    const existing = await mkCandidate(orgB, { fullName: "Sam Lee", email: `sam-lee@${dom}` });
    await db.insert(candidateIdentityKeys).values({
      orgId: orgB,
      candidateId: existing.id,
      keyType: "email",
      keyValue: `sam-lee@${dom}`,
    });
    const outcome = await identity.resolveIdentity({
      orgId: orgB,
      fullName: "Sam Lee",
      email: `sam-lee@${dom}`,
    });
    expect(outcome.outcome).toBe("review");
    expect(outcome.reasons[0]?.signal).toBe("strong_key:email");
  });

  test("fuzzy: overlapping timeline reviews, disjoint timeline stays new", async () => {
    const hist = [
      { company: "Acme Systems", start: 2019 },
      { company: "Globex", start: 2022 },
    ];
    await mkCandidate(orgA, {
      fullName: "Priya Sharma",
      email: `priya-${stamp}@${dom}`,
      employmentHistory: hist,
      education: "IIT Delhi",
      location: "Bengaluru",
    });
    const similar = await identity.resolveIdentity({
      orgId: orgA,
      fullName: "Priya Sharma",
      email: `priya-second-${stamp}@${dom}`,
      employmentHistory: [
        { company: "Globex", start: "2022" },
        { company: "Acme Systems", start: "2019" },
      ],
      education: "IIT Delhi",
      location: "Bengaluru",
    });
    expect(similar.outcome).toBe("review");
    const different = await identity.resolveIdentity({
      orgId: orgA,
      fullName: "Priya Sharma",
      email: `priya-third-${stamp}@${dom}`,
      employmentHistory: [{ company: "Initech", start: "2021" }],
      education: "NIIT",
      location: "Pune",
    });
    expect(different.outcome).toBe("new");
  });

  test("identity never crosses tenants", async () => {
    const outcome = await identity.resolveIdentity({
      orgId: orgB,
      fullName: "Jane Doe",
      email: `jane-b@${dom}`,
      linkedinUrl: "linkedin.com/in/jane-doe-ci",
    });
    expect(outcome.outcome).toBe("new");
  });
});

describe("merge and undo", () => {
  test("merge tombstones the absorbed row, moves children and keys, and undo restores deleted applications with original ids and dates", async () => {
    const survivor = await mkCandidate(orgA, {
      fullName: "Ada Original",
      email: `ada-a-${stamp}@${dom}`,
    });
    const absorbed = await mkCandidate(orgA, {
      fullName: "Ada Duplicate",
      email: `ada-b-${stamp}@${dom}`,
    });
    await mkApplication(survivor.id, reqId);
    // Duplicate application for the same requisition (the merge deletes it);
    // plus one for a second requisition (the merge re-points it).
    const dupeApp = await mkApplication(absorbed.id, reqId, {
      appliedAt: new Date("2025-01-02T00:00:00Z"),
    });
    const req2 = (
      await db
        .insert(requisitions)
        .values({
          orgId: orgA,
          code: `REQ-CI2-${stamp}`,
          title: "Data Engineer",
          status: "approved",
          createdBy: userId,
        } as never)
        .returning({ id: requisitions.id })
    )[0]!.id;
    const movedApp = await mkApplication(absorbed.id, req2, {});
    await db.insert(candidateIdentityKeys).values({
      orgId: orgA,
      candidateId: absorbed.id,
      keyType: "email",
      keyValue: `ada-b-${stamp}@${dom}`,
    });

    const result = await identity.mergeCandidatesCore({
      orgId: orgA,
      survivorId: survivor.id,
      mergedId: absorbed.id,
      actor,
    });
    expect(result.movedChildren).toBe(1);
    expect(result.deletedChildren).toBe(1);

    const tombstone = (
      await db.select().from(candidates).where(eq(candidates.id, absorbed.id))
    )[0]!;
    expect(tombstone.mergedIntoId).toBe(survivor.id);
    const [survivorApps] = [
      await db.select().from(applications).where(eq(applications.candidateId, survivor.id)),
    ];
    expect(survivorApps!.some((a) => a.id === movedApp.id)).toBe(true);
    expect(survivorApps!.some((a) => a.id === dupeApp.id)).toBe(false);
    const [keys] = [
      await db
        .select()
        .from(candidateIdentityKeys)
        .where(
          and(
            eq(candidateIdentityKeys.orgId, orgA),
            eq(candidateIdentityKeys.candidateId, survivor.id),
          ),
        ),
    ];
    expect(keys!.some((k) => k.keyValue === `ada-b-${stamp}@${dom}`)).toBe(true);

    // Merge is audited.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "candidate.merge")));
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // Undo restores the deleted application with its original id and date.
    await identity.undoMerge({
      orgId: orgA,
      mergeId: result.mergeId,
      actor,
    });
    const restored = (
      await db
        .select()
        .from(applications)
        .where(inArray(applications.id, [dupeApp.id, movedApp.id]))
    ).sort((a, b) => a.id.localeCompare(b.id));
    expect(restored.length).toBe(2);
    const restoredDupe = restored.find((a) => a.id === dupeApp.id)!;
    expect(restoredDupe.appliedAt.toISOString()).toBe("2025-01-02T00:00:00.000Z");
    expect(restoredDupe.candidateId).toBe(absorbed.id);
    const undoneTombstone = (
      await db.select().from(candidates).where(eq(candidates.id, absorbed.id))
    )[0]!;
    expect(undoneTombstone.mergedIntoId).toBeNull();
    const undoAudits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "candidate.merge.undo")));
    expect(undoAudits.length).toBeGreaterThanOrEqual(1);
  });

  test("undo is refused when a re-pointed application moved after the merge", async () => {
    const survivor = await mkCandidate(orgA, {
      fullName: "Refa One",
      email: `refa-a-${stamp}@${dom}`,
    });
    const absorbed = await mkCandidate(orgA, {
      fullName: "Refa Two",
      email: `refa-b-${stamp}@${dom}`,
    });
    const req2 = (
      await db
        .insert(requisitions)
        .values({
          orgId: orgA,
          code: `REQ-CI3-${stamp}`,
          title: "Backend Engineer",
          status: "approved",
          createdBy: userId,
        } as never)
        .returning({ id: requisitions.id })
    )[0]!.id;
    const app = await mkApplication(absorbed.id, req2);
    const result = await identity.mergeCandidatesCore({
      orgId: orgA,
      survivorId: survivor.id,
      mergedId: absorbed.id,
      actor,
    });
    // The pipeline moves the re-pointed application after the merge.
    await db
      .update(applications)
      .set({ stage: "l1", lastActivityAt: new Date() })
      .where(eq(applications.id, app.id));
    expect(
      async () => await identity.undoMerge({ orgId: orgA, mergeId: result.mergeId, actor }),
    ).toThrow(/changed after the merge/);
    // The application stays where the pipeline put it.
    const [current] = await db.select().from(applications).where(eq(applications.id, app.id));
    expect(current.candidateId).toBe(survivor.id);
    expect(current.stage).toBe("l1");
  });

  test("keep separate demotes the collision key to shared_ and a later arrival reviews instead of merging", async () => {
    const existing = await mkCandidate(orgA, { fullName: "Fam A", email: `family@${dom}` });
    await db.insert(candidateIdentityKeys).values({
      orgId: orgA,
      candidateId: existing.id,
      keyType: "email",
      keyValue: `family@${dom}`,
    });
    const suggestion = await identity.enqueueMergeSuggestion({
      orgId: orgA,
      existingId: existing.id,
      newcomerId: (await mkCandidate(orgA, { fullName: "Fam B", email: `fam-b-${stamp}@${dom}` }))
        .id,
      score: 1,
      reasons: [{ signal: "strong_key:email", detail: `family@${dom}` }],
    });
    expect(suggestion).not.toBeNull();
    // Enqueueing the same pair again does not duplicate.
    const pendingFirst = await db
      .select()
      .from(candidateMergeSuggestions)
      .where(
        and(
          eq(candidateMergeSuggestions.orgId, orgA),
          eq(candidateMergeSuggestions.status, "pending"),
        ),
      );
    expect(pendingFirst.length).toBe(1);
    const again = await identity.enqueueMergeSuggestion({
      orgId: orgA,
      existingId: existing.id,
      newcomerId: pendingFirst[0]!.candidateBId,
      score: 1,
      reasons: [{ signal: "strong_key:email", detail: `family@${dom}` }],
    });
    expect(again).toBeNull();
    const pending = await db
      .select()
      .from(candidateMergeSuggestions)
      .where(
        and(
          eq(candidateMergeSuggestions.orgId, orgA),
          eq(candidateMergeSuggestions.status, "pending"),
        ),
      );
    expect(pending.length).toBe(1);

    const newcomerId = pending[0]!.candidateBId;
    const decision = await identity.decideSuggestion({
      orgId: orgA,
      suggestionId: pending[0]!.id,
      decision: "keep_separate",
      actor,
    });
    expect(decision.status).toBe("kept_separate");
    const shared = await db
      .select()
      .from(candidateIdentityKeys)
      .where(
        and(
          eq(candidateIdentityKeys.orgId, orgA),
          eq(candidateIdentityKeys.candidateId, newcomerId),
          eq(candidateIdentityKeys.keyType, "shared_email"),
        ),
      );
    expect(shared.length).toBe(1);

    // A third arrival holding the shared address goes to review, never merges.
    const outcome = await identity.resolveIdentity({
      orgId: orgA,
      fullName: "Fam C",
      email: `family@${dom}`,
    });
    expect(outcome.outcome).toBe("review");
    expect(outcome.reasons[0]?.signal).toBe("shared_key:shared_email");
  });
});

describe("decision guards (verdict 114 blockers)", () => {
  const memberUsers: string[] = [];

  async function mkMember(email: string, opts: { role?: string; isOwner?: boolean } = {}) {
    const id = (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
    await db.insert(orgMembers).values({
      orgId: orgA,
      userId: id,
      email,
      status: "active",
      isOwner: opts.isOwner ?? false,
    } as never);
    if (opts.role)
      await db.insert(userRoles).values({ userId: id, orgId: orgA, role: opts.role } as never);
    memberUsers.push(id);
    return id;
  }

  afterAll(async () => {
    for (const id of memberUsers) {
      await db.delete(orgMembers).where(eq(orgMembers.userId, id));
      await db.delete(userRoles).where(eq(userRoles.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  });

  test("a client-supplied survivor outside the pair is refused (merge hijack)", async () => {
    const a = await mkCandidate(orgA, { fullName: "Pair A", email: `pair-a-${stamp}@${dom}` });
    const b = await mkCandidate(orgA, { fullName: "Pair B", email: `pair-b-${stamp}@${dom}` });
    const outsider = await mkCandidate(orgA, {
      fullName: "Outsider",
      email: `outsider-${stamp}@${dom}`,
    });
    const suggestion = await identity.enqueueMergeSuggestion({
      orgId: orgA,
      existingId: a.id,
      newcomerId: b.id,
      score: 1,
      reasons: [{ signal: "strong_key:email", detail: `shared-${stamp}@${dom}` }],
    });
    expect(suggestion).not.toBeNull();
    expect(
      async () =>
        await identity.decideSuggestion({
          orgId: orgA,
          suggestionId: suggestion!.id,
          decision: "merge",
          survivorId: outsider.id,
          actor,
        }),
    ).toThrow(/survivor must be one of the two/);
    // Nothing merged: all three rows still exist and no tombstone was set.
    const after = await db.select().from(candidates).where(eq(candidates.orgId, orgA));
    for (const row of [a, b, outsider]) {
      const current = after.find((r) => r.id === row.id)!;
      expect(current.mergedIntoId).toBeNull();
    }
    const [stillPending] = await db
      .select()
      .from(candidateMergeSuggestions)
      .where(eq(candidateMergeSuggestions.id, suggestion!.id));
    expect(stillPending.status).toBe("pending");
    // Decide properly to leave a clean state.
    await identity.decideSuggestion({
      orgId: orgA,
      suggestionId: suggestion!.id,
      decision: "keep_separate",
      actor,
    });
  });

  test("only recruiter-side roles decide or undo; step-up needs a fresh re-authentication", async () => {
    const owner = await mkMember(`merge-owner@${dom}`, { isOwner: true });
    const recruiter = await mkMember(`merge-recruiter@${dom}`, { role: "recruiter" });
    const manager = await mkMember(`merge-manager@${dom}`, { role: "hiring_manager" });
    await expect(identity.assertMergeDecisionRole(owner, orgA)).resolves.toBeUndefined();
    await expect(identity.assertMergeDecisionRole(recruiter, orgA)).resolves.toBeUndefined();
    await expect(identity.assertMergeDecisionRole(manager, orgA)).rejects.toThrow(
      /Only recruiters and HR leadership/,
    );
    // Server-side step-up: a session with no recent re-authentication is refused.
    await expect(stepUp.assertStepUp(manager, new Request("http://localhost/"))).rejects.toThrow(
      /Confirm your password/,
    );
  });

  test("a suggestion decided twice loses the race: the loser is refused", async () => {
    const a = await mkCandidate(orgA, { fullName: "Race A", email: `race-a-${stamp}@${dom}` });
    const b = await mkCandidate(orgA, { fullName: "Race B", email: `race-b-${stamp}@${dom}` });
    const suggestion = await identity.enqueueMergeSuggestion({
      orgId: orgA,
      existingId: a.id,
      newcomerId: b.id,
      score: 1,
      reasons: [{ signal: "strong_key:email", detail: `race-${stamp}@${dom}` }],
    });
    expect(suggestion).not.toBeNull();
    await identity.decideSuggestion({
      orgId: orgA,
      suggestionId: suggestion!.id,
      decision: "keep_separate",
      actor,
    });
    expect(
      async () =>
        await identity.decideSuggestion({
          orgId: orgA,
          suggestionId: suggestion!.id,
          decision: "keep_separate",
          actor,
        }),
    ).toThrow(/already been decided/);
  });
});

describe("intake wiring (A1b)", () => {
  const { mergeCandidatesCore } = identity;
  let intake: typeof import("../src/lib/intake.server");

  test("ingest merges through an identity key (linkedin) despite a different email, and records the newcomer's other keys on the survivor", async () => {
    intake ??= await import("../src/lib/intake.server");
    const linkedin = `linkedin.com/a1b-intake-${stamp}`;
    const first = await intake.ingestCandidate({
      resumeText: "A1b intake — platform engineer.",
      fileName: "a1b-one.pdf",
      orgId: orgA,
      source: "talent_pool",
      parsed: {
        full_name: "Intake Person",
        email: `intake-one-${stamp}@${dom}`,
        skills: ["Go"],
        linkedin_url: linkedin,
      } as never,
    });
    const second = await intake.ingestCandidate({
      resumeText: "A1b intake — platform engineer, new mail.",
      fileName: "a1b-two.pdf",
      orgId: orgA,
      source: "inbox",
      parsed: {
        full_name: "Intake Person",
        email: `intake-two-${stamp}@${dom}`,
        skills: ["Go", "K8s"],
        linkedin_url: linkedin,
      } as never,
    });
    expect(second.merged).toBe(true);
    expect(second.candidateId).toBe(first.candidateId);
    const keys = await db
      .select()
      .from(candidateIdentityKeys)
      .where(
        and(
          eq(candidateIdentityKeys.orgId, orgA),
          eq(candidateIdentityKeys.candidateId, first.candidateId),
        ),
      );
    const values = keys.map((k) => `${k.keyType}=${k.keyValue}`);
    expect(values).toContain(`email=intake-one-${stamp}@${dom}`);
    expect(values).toContain(`email=intake-two-${stamp}@${dom}`);
    expect(values).toContain(`linkedin=${linkedin}`);
  });

  test("fuzzy evidence on a trusted surface creates the newcomer AND queues a review suggestion", async () => {
    intake ??= await import("../src/lib/intake.server");
    const hist = [
      { company: "Wireworks", start: 2020 },
      { company: "Northgate", start: 2023 },
    ];
    await intake.ingestCandidate({
      resumeText: "Fuzzy wiring — engineer.",
      fileName: "fz-one.pdf",
      orgId: orgA,
      source: "talent_pool",
      parsed: {
        full_name: "Ondrea Marlowe",
        email: `ondrea-one-${stamp}@${dom}`,
        skills: ["Go"],
        employment_history: hist,
        education: "IIT Madras",
        location: "Chennai",
      } as never,
    });
    const second = await intake.ingestCandidate({
      resumeText: "Fuzzy wiring — engineer, rewritten CV.",
      fileName: "fz-two.pdf",
      orgId: orgA,
      source: "talent_pool",
      parsed: {
        full_name: "Ondrea Marlowe",
        email: `ondrea-two-${stamp}@${dom}`,
        skills: ["Go"],
        employment_history: [
          { company: "Northgate", start: "2023" },
          { company: "Wireworks", start: "2020" },
        ],
        education: "IIT Madras",
        location: "Chennai",
      } as never,
    });
    expect(second.candidateId).not.toBeFalsy();
    const suggestions = await db
      .select()
      .from(candidateMergeSuggestions)
      .where(
        and(
          eq(candidateMergeSuggestions.orgId, orgA),
          eq(candidateMergeSuggestions.status, "pending"),
        ),
      );
    const pair = suggestions.find(
      (s) => s.candidateAId === second.candidateId || s.candidateBId === second.candidateId,
    );
    expect(pair).toBeTruthy();
    // Decide it away so later runs of the fuzzy suite stay deterministic.
    await identity.decideSuggestion({
      orgId: orgA,
      suggestionId: pair!.id,
      decision: "keep_separate",
      actor,
    });
  });

  test("unassigned-pool arrivals keep the legacy lookup and get no identity keys", async () => {
    intake ??= await import("../src/lib/intake.server");
    const first = await intake.ingestCandidate({
      resumeText: "Pool path — no org.",
      fileName: "pool-one.pdf",
      orgId: null,
      source: "talent_pool",
      parsed: {
        full_name: "Pool Person",
        email: `pool-${stamp}@${dom}`,
        skills: ["Go"],
      } as never,
    });
    const second = await intake.ingestCandidate({
      resumeText: "Pool path — no org, again.",
      fileName: "pool-two.pdf",
      orgId: null,
      source: "talent_pool",
      parsed: {
        full_name: "Pool Person",
        email: `pool-${stamp}@${dom}`,
        skills: ["Go"],
      } as never,
    });
    expect(second.merged).toBe(true);
    expect(second.candidateId).toBe(first.candidateId);
    const keys = await db
      .select()
      .from(candidateIdentityKeys)
      .where(eq(candidateIdentityKeys.candidateId, first.candidateId));
    expect(keys.length).toBe(0);
  });

  test("a tombstoned candidate is invisible to the pool-match sweep", async () => {
    intake ??= await import("../src/lib/intake.server");
    const { matchNewCvsToRoles } = await import("../src/server/agents/pool-match.server");
    const survivor = await mkCandidate(orgA, {
      fullName: "Sweep Keeper",
      email: `sweep-keeper-${stamp}@${dom}`,
    });
    const absorbed = await mkCandidate(orgA, {
      fullName: "Sweep Ghost",
      email: `sweep-ghost-${stamp}@${dom}`,
    });
    await db
      .update(candidates)
      .set({ roleMatchCheckedAt: null })
      .where(eq(candidates.id, survivor.id));
    await mergeCandidatesCore({
      orgId: orgA,
      survivorId: survivor.id,
      mergedId: absorbed.id,
      actor,
    });
    const req = (
      await db
        .insert(requisitions)
        .values({
          orgId: orgA,
          code: `REQ-SWEEP-${stamp}`,
          title: "Sweep Engineer",
          status: "approved",
          mustHaveSkills: ["Go"],
          createdBy: userId,
        } as never)
        .returning({ id: requisitions.id })
    )[0]!.id;
    const result = await matchNewCvsToRoles(orgA);
    void req;
    const ghost = (await db.select().from(candidates).where(eq(candidates.id, absorbed.id)))[0]!;
    // The tombstone was never selected: its cursor stays null and no
    // application appeared for it.
    expect(ghost.mergedIntoId).toBe(survivor.id);
    expect(ghost.roleMatchCheckedAt).toBeNull();
    const ghostApps = await db
      .select()
      .from(applications)
      .where(eq(applications.candidateId, absorbed.id));
    expect(ghostApps.length).toBe(0);
    void survivor;
    void result;
  });
});
