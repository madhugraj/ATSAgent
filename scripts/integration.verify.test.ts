/**
 * Integration tests for the de-Supabase migration (P2 server-side).
 * Run: DATABASE_URL=... SESSION_SECRET=... bun test scripts/integration.verify.test.ts
 * Requires a disposable database with drizzle/pg-migrations/0000_baseline.sql applied.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { db, sql } from "../src/server/db";
import {
  applications,
  candidates,
  captureEvents,
  orgMembers,
  organizations,
  requisitions,
  screeningKits,
  screeningPrepJobs,
  userRoles,
  users,
} from "../drizzle/schema";
import { activeOrgOf, assertRole } from "../src/lib/auth.middleware";
import { capture, orgForCaptureToken } from "../src/lib/capture.server";
import { submitApplicationImpl } from "../src/lib/apply.functions";
import { storeResumeFile } from "../src/lib/intake.server";

let orgA: string;
let orgB: string;
let ownerA: string;
let reqA: string;
let reqB: string;
let archivedOrg: string;

async function seedUser(email: string) {
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  return u!.id;
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required and must point to the disposable local test database",
    );
  }
  const databaseHost = new URL(databaseUrl).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(databaseHost)) {
    throw new Error(
      `Refusing destructive integration tests against non-local database host: ${databaseHost}`,
    );
  }

  // This suite truncates every organisation, user and candidate. Never run it
  // against a working database (e.g. the one in .env.local): the database name
  // must mark it as disposable.
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!/(^|_)(test|ci|verify|tmp|scratch)(_|$)/i.test(databaseName)) {
    throw new Error(
      `Refusing to wipe database "${databaseName}": use a disposable database whose name contains test, ci, verify, tmp or scratch (e.g. atsagent_test).`,
    );
  }

  // Clean slate (cascades handle children)
  await db.execute(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await import("drizzle-orm"))
      .sql`truncate table ${organizations}, ${users}, ${candidates}, ${captureEvents} restart identity cascade`,
  );

  // Org A + owner (no user_roles rows: owner bypasses role checks)
  ownerA = await seedUser("owner-a@test.local");
  const [a] = await db
    .insert(organizations)
    .values({ name: "Org A", slug: `org-a-${Date.now()}`, status: "active" })
    .returning({ id: organizations.id });
  orgA = a!.id;
  await db.insert(orgMembers).values({
    orgId: orgA,
    userId: ownerA,
    email: "owner-a@test.local",
    status: "active",
    isOwner: true,
    joinedAt: new Date(),
  });

  // Org B + owner, for the cross-org C2 test
  const ownerB = await seedUser("owner-b@test.local");
  const [b] = await db
    .insert(organizations)
    .values({ name: "Org B", slug: `org-b-${Date.now()}`, status: "active" })
    .returning({ id: organizations.id });
  orgB = b!.id;
  await db.insert(orgMembers).values({
    orgId: orgB,
    userId: ownerB,
    email: "owner-b@test.local",
    status: "active",
    isOwner: true,
    joinedAt: new Date(),
  });

  // Archived org, for capture-token rejection
  const [arch] = await db
    .insert(organizations)
    .values({
      name: "Archived",
      slug: `arch-${Date.now()}`,
      status: "archived",
      captureToken: "archived-token-0123456789",
    })
    .returning({ id: organizations.id });
  archivedOrg = arch!.id;

  // Approved requisitions per org
  const [r1] = await db
    .insert(requisitions)
    .values({ orgId: orgA, code: "REQ-A-1", title: "Backend Engineer", status: "approved" })
    .returning({ id: requisitions.id });
  reqA = r1!.id;
  const [r2] = await db
    .insert(requisitions)
    .values({ orgId: orgB, code: "REQ-B-1", title: "Sales Manager", status: "approved" })
    .returning({ id: requisitions.id });
  reqB = r2!.id;
});

afterAll(async () => {
  await sql.end();
});

describe("authz seam (src/lib/auth.middleware.ts)", () => {
  test("activeOrgOf resolves first active membership", async () => {
    const ctx = await activeOrgOf(ownerA);
    expect(ctx).not.toBeNull();
    expect(ctx!.orgId).toBe(orgA);
    expect(ctx!.isOwner).toBe(true);
  });

  test("activeOrgOf returns null for user with no membership", async () => {
    const loner = await seedUser("loner@test.local");
    const ctx = await activeOrgOf(loner);
    expect(ctx).toBeNull();
  });

  test("activeOrgOf ignores disabled memberships", async () => {
    const u = await seedUser("disabled@test.local");
    const [o] = await db
      .insert(organizations)
      .values({ name: "Disabled Org", slug: `dis-${Date.now()}`, status: "active" })
      .returning({ id: organizations.id });
    await db
      .insert(orgMembers)
      .values({ orgId: o!.id, userId: u, email: "disabled@test.local", status: "disabled" });
    expect(await activeOrgOf(u)).toBeNull();
  });

  test("assertRole: owner passes without a role row", async () => {
    await expect(assertRole(ownerA, orgA, "hr_head")).resolves.toBeUndefined();
  });

  test("assertRole: granted role passes, wrong role throws", async () => {
    const u = await seedUser("recruiter@test.local");
    await db.insert(orgMembers).values({
      orgId: orgA,
      userId: u,
      email: "recruiter@test.local",
      status: "active",
      joinedAt: new Date(),
    });
    await db.insert(userRoles).values({ userId: u, orgId: orgA, role: "recruiter" });
    await expect(assertRole(u, orgA, "recruiter")).resolves.toBeUndefined();
    await expect(assertRole(u, orgA, "hr_head")).rejects.toThrow(/permission/);
  });
});

describe("C2 fix: public apply cannot overwrite existing candidates", () => {
  const base = {
    fileName: "cv.pdf",
    resumeText:
      "Experienced engineer with ten years of building distributed systems and platforms.",
    source: "linkedin_post",
  };

  test("first submission creates the candidate", async () => {
    const res = await submitApplicationImpl({
      ...base,
      requisitionId: reqA,
      email: "priya@test.local",
      fullName: "Priya Original",
      phone: "+91 90000 00001",
    });
    expect(res.ok).toBe(true);
    expect(res.merged).toBe(false);

    const [row] = await db
      .select({ fullName: candidates.fullName, phone: candidates.phone })
      .from(candidates)
      .where(and(eq(candidates.email, "priya@test.local"), eq(candidates.orgId, orgA)))
      .limit(1);
    expect(row?.fullName).toBe("Priya Original");
    expect(row?.phone).toBe("+91 90000 00001");
  });

  test("second submission with same email must NOT overwrite the record", async () => {
    const res = await submitApplicationImpl({
      ...base,
      requisitionId: reqA,
      email: "priya@test.local",
      fullName: "Mallory Injection",
      phone: "+91 99999 99999",
    });
    expect(res.ok).toBe(true);
    expect(res.merged).toBe(true);
    expect(res.alreadyApplied).toBe(true);

    // Record keeps its original values — the poisoning attempt did nothing.
    const [row] = await db
      .select({ fullName: candidates.fullName, phone: candidates.phone })
      .from(candidates)
      .where(and(eq(candidates.email, "priya@test.local"), eq(candidates.orgId, orgA)))
      .limit(1);
    expect(row?.fullName).toBe("Priya Original");
    expect(row?.phone).toBe("+91 90000 00001");
  });

  test("same email in ANOTHER org creates a separate candidate (no cross-org leak)", async () => {
    const res = await submitApplicationImpl({
      ...base,
      requisitionId: reqB,
      email: "priya@test.local",
      fullName: "Priya Org B",
    });
    expect(res.ok).toBe(true);
    expect(res.merged).toBe(false);

    const rows = await db
      .select({ orgId: candidates.orgId })
      .from(candidates)
      .where(eq(candidates.email, "priya@test.local"));
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.orgId))).toEqual(new Set([orgA, orgB]));
  });

  test("unapproved requisition rejects applications", async () => {
    const [draft] = await db
      .insert(requisitions)
      .values({ orgId: orgA, code: "REQ-A-2", title: "Draft Role", status: "draft" })
      .returning({ id: requisitions.id });
    await expect(
      submitApplicationImpl({
        ...base,
        requisitionId: draft!.id,
        email: "x@test.local",
        fullName: "X",
      }),
    ).rejects.toThrow(/no longer accepting/);
  });
});

describe("capture token resolution", () => {
  test("valid token resolves the active org", async () => {
    const [updated] = await db
      .update(organizations)
      .set({ captureToken: "valid-token-aaaaaaaaaaaaaaaaaaaa" })
      .where(eq(organizations.id, orgA))
      .returning({ id: organizations.id });
    void updated;
    const org = await orgForCaptureToken("valid-token-aaaaaaaaaaaaaaaaaaaa");
    expect(org?.id).toBe(orgA);
  });

  test("short/garbage tokens return null", async () => {
    expect(await orgForCaptureToken("short")).toBeNull();
    expect(await orgForCaptureToken("nonexistent-token-aaaaaaaaaaaaaa")).toBeNull();
  });

  test("archived org's token is rejected", async () => {
    expect(await orgForCaptureToken("archived-token-0123456789")).toBeNull();
  });
});

describe("capture() full flow without LLM keys (graceful degradation)", () => {
  test("files a candidate from profile text and logs a capture_event", async () => {
    const token = "flow-token-aaaaaaaaaaaaaaaaaaaa";
    await db.update(organizations).set({ captureToken: token }).where(eq(organizations.id, orgA));

    const result = await capture({
      token,
      kind: "cv",
      text: "Rahul Verma is a backend engineer with eight years of experience in Python, PostgreSQL and Kubernetes. Previously at a fintech company building payment ledgers.",
      candidateName: "Rahul Verma",
      sourceUrl: "https://www.linkedin.com/in/rahul-verma",
      publicProfileUrl: "https://www.linkedin.com/in/rahul-verma",
      title: "Rahul Verma — LinkedIn",
    });

    expect(result.status).toBe("stored");
    expect(result.candidateId).toBeTruthy();
    expect(result.detail).toContain("verification needs retry"); // LLM absent → graceful

    const [row] = await db
      .select({ fullName: candidates.fullName, orgId: candidates.orgId, source: candidates.source })
      .from(candidates)
      .where(eq(candidates.id, result.candidateId!))
      .limit(1);
    expect(row?.fullName).toBe("Rahul Verma");
    expect(row?.orgId).toBe(orgA);

    const events = await db
      .select({ kind: captureEvents.kind, status: captureEvents.status })
      .from(captureEvents)
      .where(eq(captureEvents.orgId, orgA));
    expect(events.some((e) => e.kind === "cv" && e.status === "stored")).toBe(true);
  });

  test("insufficient text is skipped", async () => {
    const token = "flow-token-aaaaaaaaaaaaaaaaaaaa";
    const result = await capture({
      token,
      kind: "cv",
      text: "too short",
      candidateName: "Someone",
    });
    expect(result.status).toBe("skipped");
  });

  test("invalid token never touches the database", async () => {
    const result = await capture({
      token: "bogus-token-aaaaaaaaaaaaaaaaaaaa",
      kind: "cv",
      text: "x".repeat(200),
    });
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/capture key/i);
  });
});

describe("H4: CV vault degrades gracefully without storage configured", () => {
  test("storeResumeFile falls back to local storage (no S3 env) and never throws", async () => {
    const [cand] = await db
      .insert(candidates)
      .values({ fullName: "Vault Test", email: "vault@test.local", orgId: orgA })
      .returning({ id: candidates.id });
    const res = await storeResumeFile({
      orgId: orgA,
      candidateId: cand!.id,
      filename: "../../evil.pdf",
      bytes: new Uint8Array(10),
    });
    // Without S3 env the vault writes to the local .local-storage fallback;
    // either way it must not throw, and the traversal filename must be sanitised.
    expect(res.error).toBeNull();
    expect(res.path).toBeTruthy();
    // No path segment may be ".." (traversal); dots inside a segment are fine.
    expect(res.path!.split("/")).not.toContain("..");
  });
});

describe("screening prep queue (shortlist → background kit)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily inside the suite
  const { recordStageTransition } = require("../src/lib/stage-events.server") as {
    recordStageTransition: typeof import("../src/lib/stage-events.server").recordStageTransition;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily inside the suite
  const { runScreeningPrep } = require("../src/lib/screening-prep.server") as {
    runScreeningPrep: typeof import("../src/lib/screening-prep.server").runScreeningPrep;
  };

  const jobFor = async (applicationId: string) => {
    const [row] = await db
      .select()
      .from(screeningPrepJobs)
      .where(eq(screeningPrepJobs.applicationId, applicationId))
      .limit(1);
    return row ?? null;
  };

  let appShortlisted: string;
  let appApplied: string;

  beforeAll(async () => {
    const mkApp = async (email: string, name: string, stage: "applied" | "shortlisted") => {
      const [c] = await db
        .insert(candidates)
        .values({ fullName: name, email, orgId: orgA })
        .returning({ id: candidates.id });
      const [a] = await db
        .insert(applications)
        .values({ requisitionId: reqA, candidateId: c!.id, orgId: orgA, stage })
        .returning({ id: applications.id });
      return a!.id;
    };
    appShortlisted = await mkApp("prep-shortlisted@test.local", "Prep Shortlisted", "shortlisted");
    appApplied = await mkApp("prep-applied@test.local", "Prep Applied", "applied");
  });

  test("shortlist transition enqueues exactly one prep job", async () => {
    await recordStageTransition({
      orgId: orgA,
      applicationId: appShortlisted,
      fromStage: "applied",
      toStage: "shortlisted",
      actor: "test",
    });
    const job = await jobFor(appShortlisted);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("pending");
    expect(job!.attempts).toBe(0);
    expect(job!.candidateId).toBeTruthy();
    expect(job!.requisitionId).toBe(reqA);
  });

  test("re-shortlisting resets a failed job instead of duplicating it", async () => {
    await db
      .update(screeningPrepJobs)
      .set({ status: "failed", attempts: 3, lastError: "older failure" })
      .where(eq(screeningPrepJobs.applicationId, appShortlisted));
    await recordStageTransition({
      orgId: orgA,
      applicationId: appShortlisted,
      fromStage: "on_hold",
      toStage: "shortlisted",
      actor: "test",
    });
    const rows = await db
      .select()
      .from(screeningPrepJobs)
      .where(eq(screeningPrepJobs.applicationId, appShortlisted));
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.attempts).toBe(0);
    expect(rows[0]!.lastError).toBeNull();
  });

  test("non-shortlisted transitions enqueue nothing", async () => {
    await recordStageTransition({
      orgId: orgA,
      applicationId: appApplied,
      fromStage: "applied",
      toStage: "l1",
      actor: "test",
    });
    expect(await jobFor(appApplied)).toBeNull();
  });

  test("backfill covers shortlisted-without-kit, skips applied and kit-existing rows", async () => {
    // A shortlisted candidate who already has a kit must be skipped.
    const [kitted] = await db
      .insert(candidates)
      .values({ fullName: "Prep Kitted", email: "prep-kitted@test.local", orgId: orgA })
      .returning({ id: candidates.id });
    const [kitApp] = await db
      .insert(applications)
      .values({ requisitionId: reqA, candidateId: kitted!.id, orgId: orgA, stage: "shortlisted" })
      .returning({ id: applications.id });
    await db.insert(screeningKits).values({
      orgId: orgA,
      candidateId: kitted!.id,
      requisitionId: reqA,
      applicationId: kitApp!.id,
    });

    await runScreeningPrep({ max: 100 });

    // applied → no job; shortlisted-without-kit (appShortlisted now has one
    // from the hook) → the kitted row must still have no job.
    expect(await jobFor(appApplied)).toBeNull();
    expect(await jobFor(kitApp!.id)).toBeNull();
  });

  test("no-AI-key org: jobs fail with vendor-neutral copy only", async () => {
    // Drain the job: expire backoff between attempts so all retries land now.
    for (let i = 0; i < 3; i++) {
      await runScreeningPrep({ max: 100 });
      await db.execute(
        (await import("drizzle-orm"))
          .sql`update screening_prep_jobs set updated_at = now() - interval '5 minutes' where status = 'pending'`,
      );
    }
    const job = await jobFor(appShortlisted);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("failed");
    expect(job!.attempts).toBe(3);
    expect(job!.lastError).toBeTruthy();
    // Vendor-neutral by construction: no provider or model names may leak.
    expect(job!.lastError!).not.toMatch(/openai|anthropic|gemini|gpt|claude/i);
    expect(job!.lastError).toMatch(/Integrations|automatically|job description/i);

    // And a kit must NOT have been written for the failed job.
    const kits = await db
      .select({ id: screeningKits.id })
      .from(screeningKits)
      .where(and(eq(screeningKits.candidateId, job!.candidateId), eq(screeningKits.orgId, orgA)));
    expect(kits.length).toBe(0);
  });
});
