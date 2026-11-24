/**
 * Requisitions-domain behaviour lockdown (Phase 5/6 L3 prep), against the
 * disposable database. Everything here tests the exported, invocable cores of
 * the "requisitions" domain — the *.functions.ts server fns themselves are
 * requireOrg-wrapped and not invocable from bun test, so what is locked down
 * is the core each wrapper delegates to:
 *  - src/server/guards.ts: assertRequisitionInOrg refuses another org's
 *    requisitionId BEFORE any insert that references it;
 *  - requisitions.server.ts: every lifecycle core predicates on the org
 *    (a foreign actor gets "Requisition not found." or a no-op, never a
 *    cross-org write), keeps the same role gates (owner passes, a recruiter
 *    cannot approve, send back, correct or re-weight), rebuilds the approval
 *    trail server-side, writes the audit rows and raises the agent events;
 *  - role-hiring-manager.server.ts: the manager read and set are org-scoped
 *    and the set is audited;
 *  - role-profile.server.ts: draftRoleProfile refuses vendor-neutrally with no
 *    saved key (real-AI paths are out of scope here — no provider keys in CI);
 *  - jd-dedupe.ts and work-mode.ts: the pure helpers (title-threshold
 *    duplicate detection over live requisitions only, and placeLabel).
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/requisitions-domain.test.ts
 */
// bun test does not load .env.local — pick up the secrets the server env
// schema demands (SESSION_SECRET et al) before any module graph loads, so the
// documented run line needs only DATABASE_URL.
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
import { and, eq, inArray } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  applications,
  auditLog,
  candidates,
  jobDescriptions,
  orgMembers,
  orgProfiles,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const lifecycle = await import("../src/lib/requisitions.server");
const guards = await import("../src/server/guards");
const rhm = await import("../src/lib/role-hiring-manager.server");
const rp = await import("../src/lib/role-profile.server");
const dedupe = await import("../src/lib/jd-dedupe");
const wm = await import("../src/lib/work-mode");

const stamp = Date.now();
const dom = `reqd${stamp}.test`;
let orgA: string;
let orgB: string;
let ownerId: string;
let recruiterId: string;
let dhId: string;
let ownerBId: string;
const cleanupUserIds: string[] = [];
// org A rows
let reqDraft: string;
let reqPendingDh: string; // becomes pending_hr via the advance happy path
let reqSendBack: string; // pending_dh, sent back to draft
let reqEdit: string; // pending_dh, corrected in approval
let reqWeightsPending: string; // pending_dh, weights refused
let reqApproved: string;
let reqClosed: string;
let reqJd: string; // carries the JD versions
let reqIjp: string;
let reqB: string; // org B's own draft

async function mkUser(email: string) {
  return (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
}
async function member(
  userId: string,
  email: string,
  orgId: string,
  isOwner = false,
  roles: (typeof userRoles.$inferInsert)["role"][] = [],
) {
  const memberId = (
    await db
      .insert(orgMembers)
      .values({ orgId, userId, email, status: "active", isOwner } as never)
      .returning({ id: orgMembers.id })
  )[0]!.id;
  if (roles.length)
    await db.insert(userRoles).values(roles.map((role) => ({ userId, orgId, role }) as never));
  return memberId;
}
async function mkReq(
  orgId: string,
  createdBy: string,
  status: string,
  extra: Partial<typeof requisitions.$inferInsert> = {},
) {
  return (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `RD${stamp}-${orgId.slice(0, 4)}-${status}-${Math.random().toString(36).slice(2, 6)}`,
        title: "Platform Engineer",
        location: "Chennai",
        status: status as never,
        createdBy,
        ...extra,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
}
const actor = (orgId: string, userId: string, memberEmail: string): lifecycle.LifecycleActor => ({
  orgId,
  userId,
  memberEmail,
});
const fields = (title = "Platform Engineer"): lifecycle.RequisitionFields => ({
  title,
  departmentId: null,
  location: "Chennai",
  openings: 2,
  experienceMin: 3,
  experienceMax: 8,
  budgetCtc: 4_000_000,
  ctcBandMin: 3_000_000,
  ctcBandMax: 5_000_000,
  maxNoticePeriodDays: 60,
  workAuthorizationRequired: null,
  hiringManager: null,
  mustHaveSkills: ["PostgreSQL", "TypeScript"],
  goodToHaveSkills: ["Kubernetes"],
  responsibilities: "Ship the platform.",
  educationRequirement: null,
  billingType: "non_billable",
  engagementType: "internal",
  clientName: null,
  costCenter: null,
  workMode: "hybrid",
});
const WEIGHTS = { skills: 40, experience: 15, career: 10, impact: 10, education: 10, social: 15 };
const jd = (fullText: string) => ({
  purpose: "Own the data platform.",
  responsibilities: "Design schemas.",
  must_have: ["PostgreSQL"],
  good_to_have: ["Kafka"],
  qualifications: "B.E. in Computer Science",
  success_factors: "Zero missed paging escalations.",
  reporting_to: "Head of Engineering",
  full_text: fullText,
});

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgA = (
    await db
      .insert(organizations)
      .values({ name: "Req Domain A", slug: `reqda-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  orgB = (
    await db
      .insert(organizations)
      .values({ name: "Req Domain B", slug: `reqdb-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  ownerId = await mkUser(`owner@${dom}`);
  recruiterId = await mkUser(`recruiter@${dom}`);
  dhId = await mkUser(`dh@${dom}`);
  ownerBId = await mkUser(`ownerb@${dom}`);
  await member(ownerId, `owner@${dom}`, orgA, true);
  await member(recruiterId, `recruiter@${dom}`, orgA, false, ["recruiter"]);
  await member(dhId, `dh@${dom}`, orgA, false, ["department_head"]);
  await member(ownerBId, `ownerb@${dom}`, orgB, true);
  reqDraft = await mkReq(orgA, ownerId, "draft");
  reqPendingDh = await mkReq(orgA, ownerId, "pending_dh");
  reqSendBack = await mkReq(orgA, ownerId, "pending_dh");
  reqEdit = await mkReq(orgA, ownerId, "pending_dh");
  reqWeightsPending = await mkReq(orgA, ownerId, "pending_hr");
  reqApproved = await mkReq(orgA, ownerId, "approved");
  reqClosed = await mkReq(orgA, ownerId, "closed");
  reqJd = await mkReq(orgA, ownerId, "draft");
  reqIjp = await mkReq(orgA, ownerId, "approved");
  reqB = await mkReq(orgB, ownerBId, "draft");
});

afterAll(async () => {
  // audit rows carry no FK; everything else cascades from organizations.
  for (const id of [orgA, orgB]) await db.delete(auditLog).where(eq(auditLog.orgId, id));
  for (const id of [orgA, orgB]) await db.delete(organizations).where(eq(organizations.id, id));
  for (const id of [ownerId, recruiterId, dhId, ownerBId, ...cleanupUserIds])
    await db.delete(users).where(eq(users.id, id));
});

describe("assertRequisitionInOrg (src/server/guards.ts)", () => {
  test("a requisition of the caller's own organisation passes", async () => {
    await guards.assertRequisitionInOrg(reqDraft, orgA);
  });

  test("another org's requisitionId throws BEFORE any insert references it", async () => {
    await expect(guards.assertRequisitionInOrg(reqDraft, orgB)).rejects.toThrow(
      "Requisition not found in your organisation.",
    );
    // The ingest pattern: guard, then insert. The guard throws, so the
    // guarded insert never runs and no row leaks across orgs.
    let leaked = false;
    const candId = (
      await db
        .insert(candidates)
        .values({ orgId: orgB, fullName: "B Candidate", email: `bc-${stamp}@${dom}` } as never)
        .returning({ id: candidates.id })
    )[0]!.id;
    try {
      await guards.assertRequisitionInOrg(reqDraft, orgB);
      await db.insert(applications).values({
        orgId: orgB,
        requisitionId: reqDraft,
        candidateId: candId,
        stage: "l1",
      } as never);
      leaked = true;
    } catch {
      // expected: the guard refused before the insert
    }
    expect(leaked).toBe(false);
    const rows = await db
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.requisitionId, reqDraft), eq(applications.orgId, orgB)));
    expect(rows.length).toBe(0);
  });
});

describe("createRequisitionCore", () => {
  test("raises the role with the next per-org code, the asked status and the created event", async () => {
    const out = await lifecycle.createRequisitionCore(
      actor(orgA, ownerId, `owner@${dom}`),
      fields(),
      "pending_dh",
    );
    expect(out.code).toMatch(new RegExp(`^REQ-${new Date().getFullYear()}-\\d{3}$`));
    const [row] = await db
      .select({
        status: requisitions.status,
        workMode: requisitions.workMode,
        budgetCtc: requisitions.budgetCtc,
        createdBy: requisitions.createdBy,
      })
      .from(requisitions)
      .where(and(eq(requisitions.id, out.id), eq(requisitions.orgId, orgA)));
    expect(row).toMatchObject({
      status: "pending_dh",
      workMode: "hybrid",
      budgetCtc: "4000000.00",
      createdBy: ownerId,
    });
    const [ev] = await db
      .select({ type: agentEvents.type, payload: agentEvents.payload })
      .from(agentEvents)
      .where(and(eq(agentEvents.orgId, orgA), eq(agentEvents.subjectId, out.id)));
    expect(ev).toMatchObject({ type: "requisition.created" });
  });

  test("an organisation that requires an approved profile refuses the raise", async () => {
    await db.insert(orgProfiles).values({ orgId: orgB, requireProfile: true } as never);
    await expect(
      lifecycle.createRequisitionCore(actor(orgB, ownerBId, `ownerb@${dom}`), fields(), "draft"),
    ).rejects.toThrow("approved organisation profile");
    await db.delete(orgProfiles).where(eq(orgProfiles.orgId, orgB));
  });
});

describe("updateRequisitionDraftCore", () => {
  test("patches a draft in the caller's org", async () => {
    await lifecycle.updateRequisitionDraftCore(actor(orgA, ownerId, `owner@${dom}`), reqDraft, {
      title: "Senior Platform Engineer",
      workMode: "remote",
      openings: 3,
    });
    const [row] = await db
      .select({
        title: requisitions.title,
        workMode: requisitions.workMode,
        openings: requisitions.openings,
      })
      .from(requisitions)
      .where(and(eq(requisitions.id, reqDraft), eq(requisitions.orgId, orgA)));
    expect(row).toEqual({ title: "Senior Platform Engineer", workMode: "remote", openings: 3 });
  });

  test("a requisition past draft can no longer be edited", async () => {
    await expect(
      lifecycle.updateRequisitionDraftCore(actor(orgA, ownerId, `owner@${dom}`), reqApproved, {
        title: "X",
      }),
    ).rejects.toThrow("can no longer be edited");
  });

  test("another org's requisitionId is not found", async () => {
    await expect(
      lifecycle.updateRequisitionDraftCore(actor(orgB, ownerBId, `ownerb@${dom}`), reqDraft, {
        title: "Hijacked",
      }),
    ).rejects.toThrow("Requisition not found.");
    const [row] = await db
      .select({ title: requisitions.title })
      .from(requisitions)
      .where(eq(requisitions.id, reqDraft));
    expect(row!.title).toBe("Senior Platform Engineer");
  });
});

describe("advanceRequisitionCore", () => {
  test("another org's actor finds nothing", async () => {
    await expect(
      lifecycle.advanceRequisitionCore(actor(orgB, ownerBId, `ownerb@${dom}`), {
        id: reqPendingDh,
        status: "pending_hr",
      }),
    ).rejects.toThrow("Requisition not found.");
  });

  test("the wrong role cannot make the approval hop", async () => {
    await expect(
      lifecycle.advanceRequisitionCore(actor(orgA, recruiterId, `recruiter@${dom}`), {
        id: reqPendingDh,
        status: "pending_hr",
      }),
    ).rejects.toThrow("You do not have permission to perform this action.");
  });

  test("an illegal hop is refused", async () => {
    await expect(
      lifecycle.advanceRequisitionCore(actor(orgA, ownerId, `owner@${dom}`), {
        id: reqDraft,
        status: "approved",
      }),
    ).rejects.toThrow("cannot move from draft to approved");
  });

  test("the department head approves to pending_hr with a server-built trail and event", async () => {
    const out = await lifecycle.advanceRequisitionCore(actor(orgA, dhId, `dh@${dom}`), {
      id: reqPendingDh,
      status: "pending_hr",
      comment: "Looks right.",
    });
    expect(out).toEqual({ from: "pending_dh", to: "pending_hr" });
    const [row] = await db
      .select({ status: requisitions.status, approvalTrail: requisitions.approvalTrail })
      .from(requisitions)
      .where(and(eq(requisitions.id, reqPendingDh), eq(requisitions.orgId, orgA)));
    expect(row!.status).toBe("pending_hr");
    const trail = row!.approvalTrail as Record<string, unknown>[];
    expect(trail.at(-1)).toMatchObject({
      from: "pending_dh",
      to: "pending_hr",
      actor: `dh@${dom}`,
      comment: "Looks right.",
    });
    const [ev] = await db
      .select({ type: agentEvents.type })
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.orgId, orgA),
          eq(agentEvents.subjectId, reqPendingDh),
          eq(agentEvents.type, "requisition.status_changed"),
        ),
      );
    expect(ev).toBeDefined();
  });
});

describe("sendBackRequisitionCore", () => {
  test("a mangled reason is refused", async () => {
    await expect(
      lifecycle.sendBackRequisitionCore(actor(orgA, ownerId, `owner@${dom}`), {
        id: reqSendBack,
        reason: "  ",
      }),
    ).rejects.toThrow("Say what should change");
  });

  test("another org's actor finds nothing", async () => {
    await expect(
      lifecycle.sendBackRequisitionCore(actor(orgB, ownerBId, `ownerb@${dom}`), {
        id: reqSendBack,
        reason: "Not your role.",
      }),
    ).rejects.toThrow("Requisition not found.");
  });

  test("a bystander without an approver role cannot send it back", async () => {
    await expect(
      lifecycle.sendBackRequisitionCore(actor(orgA, recruiterId, `recruiter@${dom}`), {
        id: reqSendBack,
        reason: "Recruiter overreach.",
      }),
    ).rejects.toThrow("Only the current approver");
    const [row] = await db
      .select({ status: requisitions.status })
      .from(requisitions)
      .where(eq(requisitions.id, reqSendBack));
    expect(row!.status).toBe("pending_dh");
  });

  test("a closed requisition cannot be sent back", async () => {
    await expect(
      lifecycle.sendBackRequisitionCore(actor(orgA, ownerId, `owner@${dom}`), {
        id: reqClosed,
        reason: "Too late.",
      }),
    ).rejects.toThrow("cannot be sent back");
  });

  test("the raiser sends it back to draft with the trail, audit and event", async () => {
    const out = await lifecycle.sendBackRequisitionCore(actor(orgA, ownerId, `owner@${dom}`), {
      id: reqSendBack,
      reason: "Budget band is wrong, fix it.",
    });
    expect(out).toMatchObject({ from: "pending_dh", code: expect.any(String) });
    const [row] = await db
      .select({ status: requisitions.status, approvalTrail: requisitions.approvalTrail })
      .from(requisitions)
      .where(and(eq(requisitions.id, reqSendBack), eq(requisitions.orgId, orgA)));
    expect(row!.status).toBe("draft");
    expect((row!.approvalTrail as Record<string, unknown>[]).at(-1)).toMatchObject({
      from: "pending_dh",
      to: "draft",
      decision: "sent_back",
      comment: "Budget band is wrong, fix it.",
    });
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "requisition.sent_back")));
    expect(audits.length).toBe(1);
  });
});

describe("updateRequisitionCompensationCore", () => {
  test("rewrites the band on the caller's org only", async () => {
    await lifecycle.updateRequisitionCompensationCore(actor(orgA, ownerId, `owner@${dom}`), {
      id: reqApproved,
      budgetCtc: 6_000_000,
      ctcBandMin: 5_000_000,
      ctcBandMax: 7_000_000,
      careerLevel: "L6",
    });
    const [row] = await db
      .select({
        budgetCtc: requisitions.budgetCtc,
        ctcBandMin: requisitions.ctcBandMin,
        careerLevel: requisitions.careerLevel,
      })
      .from(requisitions)
      .where(eq(requisitions.id, reqApproved));
    expect(row).toMatchObject({
      budgetCtc: "6000000.00",
      ctcBandMin: "5000000.00",
      careerLevel: "L6",
    });
  });

  test("another org's actor silently matches nothing — the row is untouched", async () => {
    await lifecycle.updateRequisitionCompensationCore(actor(orgB, ownerBId, `ownerb@${dom}`), {
      id: reqApproved,
      budgetCtc: 1,
      ctcBandMin: null,
      ctcBandMax: null,
    });
    const [row] = await db
      .select({ budgetCtc: requisitions.budgetCtc })
      .from(requisitions)
      .where(eq(requisitions.id, reqApproved));
    expect(row!.budgetCtc).toBe("6000000.00");
  });
});

describe("weightsProblem (pure)", () => {
  test("the six weights must be whole percentages totalling 100", () => {
    expect(lifecycle.weightsProblem(WEIGHTS)).toBeNull();
    expect(lifecycle.weightsProblem({ ...WEIGHTS, skills: 41 })).toMatch(/must total 100/);
    expect(lifecycle.weightsProblem({ ...WEIGHTS, skills: 40.5, social: 14.5 })).toMatch(
      "whole percentage",
    );
    expect(lifecycle.weightsProblem({ ...WEIGHTS, skills: 140, social: -40 })).toMatch(
      "between 0 and 100",
    );
  });

  test("custom dimensions are capped at 4 with clean keys, labels and hints", () => {
    const ok = [
      {
        key: "open_source",
        label: "Open source",
        hint: "Merged patches in big projects.",
        weight: 0,
      },
    ];
    expect(lifecycle.weightsProblem({ ...WEIGHTS, skills: 40 }, ok)).toBeNull();
    expect(
      lifecycle.weightsProblem(
        { ...WEIGHTS, skills: 40 },
        Array.from({ length: 5 }, () => ok[0]),
      ),
    ).toMatch("At most 4");
    expect(lifecycle.weightsProblem({ ...WEIGHTS, skills: 40 }, [ok[0]!, { ...ok[0]! }])).toMatch(
      "duplicated",
    );
    expect(
      lifecycle.weightsProblem({ ...WEIGHTS, skills: 40 }, [{ ...ok[0]!, key: "Bad Key" }]),
    ).toMatch("lowercase letters, digits and underscores");
    expect(
      lifecycle.weightsProblem({ ...WEIGHTS, skills: 40 }, [{ ...ok[0]!, label: "  " }]),
    ).toMatch("needs a label");
    expect(
      lifecycle.weightsProblem({ ...WEIGHTS, skills: 40 }, [{ ...ok[0]!, hint: "too short" }]),
    ).toMatch("scoring hint of 10");
  });
});

describe("saveRequisitionWeightsCore", () => {
  const wrongTotal = { ...WEIGHTS, skills: 39 };

  test("weights that do not total 100 are refused before any read", async () => {
    await expect(
      lifecycle.saveRequisitionWeightsCore(
        actor(orgA, ownerId, `owner@${dom}`),
        reqDraft,
        wrongTotal,
      ),
    ).rejects.toThrow("must total 100");
  });

  test("another org's actor finds nothing", async () => {
    await expect(
      lifecycle.saveRequisitionWeightsCore(
        actor(orgB, ownerBId, `ownerb@${dom}`),
        reqDraft,
        WEIGHTS,
      ),
    ).rejects.toThrow("Requisition not found.");
  });

  test("in approval the weights are locked; a closed role never changes them", async () => {
    await expect(
      lifecycle.saveRequisitionWeightsCore(
        actor(orgA, ownerId, `owner@${dom}`),
        reqWeightsPending,
        WEIGHTS,
      ),
    ).rejects.toThrow("in approval");
    await expect(
      lifecycle.saveRequisitionWeightsCore(
        actor(orgA, ownerId, `owner@${dom}`),
        reqClosed,
        WEIGHTS,
      ),
    ).rejects.toThrow("closed");
  });

  test("an approved role is re-weighted by HR leadership only; a bystander on a draft is refused", async () => {
    await expect(
      lifecycle.saveRequisitionWeightsCore(
        actor(orgA, recruiterId, `recruiter@${dom}`),
        reqApproved,
        WEIGHTS,
      ),
    ).rejects.toThrow("Only the HR head or the CBO");
    await expect(
      lifecycle.saveRequisitionWeightsCore(
        actor(orgA, recruiterId, `recruiter@${dom}`),
        reqDraft,
        WEIGHTS,
      ),
    ).rejects.toThrow("Only the person who raised this requisition");
  });

  test("the raiser saves weights on their draft, audited with before and after", async () => {
    const custom = [
      {
        key: "open_source",
        label: "Open source",
        hint: "Merged patches in big projects.",
        weight: 0,
      },
    ];
    const out = await lifecycle.saveRequisitionWeightsCore(
      actor(orgA, ownerId, `owner@${dom}`),
      reqDraft,
      { ...WEIGHTS, skills: 40 },
      custom,
    );
    expect(out).toMatchObject({ status: "draft", changed: true });
    const [row] = await db
      .select({ skills: requisitions.weightSkills, customWeights: requisitions.customWeights })
      .from(requisitions)
      .where(eq(requisitions.id, reqDraft));
    expect(row!.customWeights).toEqual(custom);
    const audits = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "requisition.weights_changed")));
    expect(audits.length).toBe(1);
    expect((audits[0]!.detail as Record<string, unknown>).before).toMatchObject({ skills: 40 });
  });

  test("saving the identical weights is a no-op with changed:false and no audit", async () => {
    const auditCount = async () =>
      (
        await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "requisition.weights_changed")))
      ).length;
    // clear the custom dimension first (jsonb re-orders keys, so a custom set
    // never stringifies equal to its stored form — the no-op case is the
    // plain six weights)
    await lifecycle.saveRequisitionWeightsCore(actor(orgA, ownerId, `owner@${dom}`), reqDraft, {
      ...WEIGHTS,
      skills: 40,
    });
    const before = await auditCount();
    const out = await lifecycle.saveRequisitionWeightsCore(
      actor(orgA, ownerId, `owner@${dom}`),
      reqDraft,
      { ...WEIGHTS, skills: 40 },
    );
    expect(out).toEqual({ status: "draft", changed: false });
    expect(await auditCount()).toBe(before);
  });
});

describe("setRequisitionIjpCore", () => {
  test("publishes to the internal board with a posted-at stamp, unpublishing clears it", async () => {
    await lifecycle.setRequisitionIjpCore(actor(orgA, ownerId, `owner@${dom}`), reqIjp, true);
    let [row] = await db
      .select({ enabled: requisitions.ijpEnabled, postedAt: requisitions.ijpPostedAt })
      .from(requisitions)
      .where(eq(requisitions.id, reqIjp));
    expect(row!.enabled).toBe(true);
    expect(row!.postedAt).not.toBeNull();
    await lifecycle.setRequisitionIjpCore(actor(orgA, ownerId, `owner@${dom}`), reqIjp, false);
    [row] = await db
      .select({ enabled: requisitions.ijpEnabled, postedAt: requisitions.ijpPostedAt })
      .from(requisitions)
      .where(eq(requisitions.id, reqIjp));
    expect(row).toMatchObject({ enabled: false, postedAt: null });
  });

  test("another org's actor flips nothing", async () => {
    await lifecycle.setRequisitionIjpCore(actor(orgB, ownerBId, `ownerb@${dom}`), reqIjp, true);
    const [row] = await db
      .select({ enabled: requisitions.ijpEnabled })
      .from(requisitions)
      .where(eq(requisitions.id, reqIjp));
    expect(row!.enabled).toBe(false);
  });
});

describe("saveJobDescriptionCore", () => {
  test("files the next version for DH review and raises jd.submitted", async () => {
    const v1 = await lifecycle.saveJobDescriptionCore(actor(orgA, ownerId, `owner@${dom}`), {
      requisitionId: reqJd,
      jd: jd("Own the data platform end to end."),
    });
    expect(v1.version).toBe(1);
    const v2 = await lifecycle.saveJobDescriptionCore(actor(orgA, ownerId, `owner@${dom}`), {
      requisitionId: reqJd,
      jd: jd("Own the data platform, v2."),
      templateName: "Default JD",
    });
    expect(v2.version).toBe(2);
    const rows = await db
      .select({ status: jobDescriptions.status, version: jobDescriptions.version })
      .from(jobDescriptions)
      .where(and(eq(jobDescriptions.requisitionId, reqJd), eq(jobDescriptions.orgId, orgA)))
      .orderBy(jobDescriptions.version);
    expect(rows).toEqual([
      { status: "pending_dh", version: 1 },
      { status: "pending_dh", version: 2 },
    ]);
    const evs = await db
      .select({ type: agentEvents.type })
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.orgId, orgA),
          eq(agentEvents.subjectType, "jd"),
          eq(agentEvents.subjectId, v1.id),
        ),
      );
    expect(evs).toEqual([{ type: "jd.submitted" }]);
  });

  test("another org's requisitionId is refused", async () => {
    await expect(
      lifecycle.saveJobDescriptionCore(actor(orgB, ownerBId, `ownerb@${dom}`), {
        requisitionId: reqJd,
        jd: jd("Cross-org attempt."),
      }),
    ).rejects.toThrow("Requisition not found");
    const rows = await db
      .select({ id: jobDescriptions.id })
      .from(jobDescriptions)
      .where(and(eq(jobDescriptions.requisitionId, reqJd), eq(jobDescriptions.orgId, orgB)));
    expect(rows.length).toBe(0);
  });

  test("an absolute claim about the job is refused before the version exists", async () => {
    await expect(
      lifecycle.saveJobDescriptionCore(actor(orgA, ownerId, `owner@${dom}`), {
        requisitionId: reqJd,
        jd: jd("We guarantee a job for every applicant."),
      }),
    ).rejects.toThrow("absolute guarantee");
    const rows = await db
      .select({ id: jobDescriptions.id })
      .from(jobDescriptions)
      .where(and(eq(jobDescriptions.requisitionId, reqJd), eq(jobDescriptions.orgId, orgA)));
    expect(rows.length).toBe(2);
  });
});

describe("approveJobDescriptionCore / requestJdChangesCore", () => {
  test("a recruiter is not a JD reviewer", async () => {
    const [v1] = await db
      .select({ id: jobDescriptions.id })
      .from(jobDescriptions)
      .where(and(eq(jobDescriptions.requisitionId, reqJd), eq(jobDescriptions.orgId, orgA)))
      .orderBy(jobDescriptions.version)
      .limit(1);
    await expect(
      lifecycle.approveJobDescriptionCore(actor(orgA, recruiterId, `recruiter@${dom}`), {
        id: v1!.id,
      }),
    ).rejects.toThrow("Only a department head, HR head or the CBO");
    await expect(
      lifecycle.requestJdChangesCore(actor(orgA, recruiterId, `recruiter@${dom}`), {
        id: v1!.id,
        comment: "Nope",
      }),
    ).rejects.toThrow("Only a department head, HR head or the CBO");
  });

  test("another org's reviewer finds nothing", async () => {
    const [v1] = await db
      .select({ id: jobDescriptions.id })
      .from(jobDescriptions)
      .where(and(eq(jobDescriptions.requisitionId, reqJd), eq(jobDescriptions.orgId, orgA)))
      .orderBy(jobDescriptions.version)
      .limit(1);
    await expect(
      lifecycle.approveJobDescriptionCore(actor(orgB, ownerBId, `ownerb@${dom}`), { id: v1!.id }),
    ).rejects.toThrow("Job description not found.");
  });

  test("the department head approves, keeping the drafted text unless edited", async () => {
    const rows = await db
      .select({ id: jobDescriptions.id, fullText: jobDescriptions.fullText })
      .from(jobDescriptions)
      .where(and(eq(jobDescriptions.requisitionId, reqJd), eq(jobDescriptions.orgId, orgA)))
      .orderBy(jobDescriptions.version);
    await lifecycle.approveJobDescriptionCore(actor(orgA, dhId, `dh@${dom}`), { id: rows[0]!.id });
    await lifecycle.approveJobDescriptionCore(actor(orgA, dhId, `dh@${dom}`), {
      id: rows[1]!.id,
      fullText: "Edited by the approver.",
    });
    const after = await db
      .select({
        id: jobDescriptions.id,
        status: jobDescriptions.status,
        fullText: jobDescriptions.fullText,
      })
      .from(jobDescriptions)
      .where(eq(jobDescriptions.id, rows[0]!.id));
    const edited = await db
      .select({ status: jobDescriptions.status, fullText: jobDescriptions.fullText })
      .from(jobDescriptions)
      .where(eq(jobDescriptions.id, rows[1]!.id));
    expect(after[0]).toMatchObject({
      status: "approved",
      fullText: "Own the data platform end to end.",
    });
    expect(edited[0]).toMatchObject({ status: "approved", fullText: "Edited by the approver." });
    const evs = await db
      .select({ type: agentEvents.type })
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.orgId, orgA),
          eq(agentEvents.subjectId, rows[0]!.id),
          eq(agentEvents.type, "jd.approved"),
        ),
      );
    expect(evs).toEqual([{ type: "jd.approved" }]);
    await expect(
      lifecycle.approveJobDescriptionCore(actor(orgA, dhId, `dh@${dom}`), { id: rows[0]!.id }),
    ).rejects.toThrow("already approved");
  });

  test("changes requested land with the reviewer's comment", async () => {
    const [v3] = await db
      .insert(jobDescriptions)
      .values({
        requisitionId: reqJd,
        orgId: orgA,
        version: 3,
        status: "pending_dh",
        fullText: "Third draft.",
      } as never)
      .returning({ id: jobDescriptions.id });
    await lifecycle.requestJdChangesCore(actor(orgA, dhId, `dh@${dom}`), {
      id: v3!.id,
      comment: "Tighten the purpose.",
    });
    const [row] = await db
      .select({ status: jobDescriptions.status, approverComment: jobDescriptions.approverComment })
      .from(jobDescriptions)
      .where(eq(jobDescriptions.id, v3!.id));
    expect(row).toMatchObject({
      status: "changes_requested",
      approverComment: "Tighten the purpose.",
    });
  });
});

describe("actorFor (agent identity resolution)", () => {
  test("resolves the member the agent acts for, flagged via agent", async () => {
    const a = await lifecycle.actorFor(orgA, ownerId);
    expect(a).toMatchObject({
      orgId: orgA,
      userId: ownerId,
      memberEmail: `owner@${dom}`,
      via: "agent",
    });
  });

  test("a principal who is not in the org is refused", async () => {
    await expect(lifecycle.actorFor(orgA, ownerBId)).rejects.toThrow(
      "The person this agent works for has left the organisation.",
    );
  });
});

describe("editRequisitionInApprovalCore", () => {
  test("another org's actor finds nothing", async () => {
    await expect(
      lifecycle.editRequisitionInApprovalCore(actor(orgB, ownerBId, `ownerb@${dom}`), reqEdit, {
        title: "Hijacked",
      }),
    ).rejects.toThrow("Requisition not found.");
  });

  test("only the approver at the current step can correct an in-approval role", async () => {
    await expect(
      lifecycle.editRequisitionInApprovalCore(
        actor(orgA, recruiterId, `recruiter@${dom}`),
        reqEdit,
        {
          title: "Recruiter edit",
        },
      ),
    ).rejects.toThrow("Only the approver at this step");
  });

  test("a closed role cannot be corrected here", async () => {
    await expect(
      lifecycle.editRequisitionInApprovalCore(actor(orgA, ownerId, `owner@${dom}`), reqClosed, {
        title: "X",
      }),
    ).rejects.toThrow("in approval or sent back");
  });

  test("an experience band flipped upside down is refused", async () => {
    await expect(
      lifecycle.editRequisitionInApprovalCore(actor(orgA, dhId, `dh@${dom}`), reqEdit, {
        experienceMin: 9,
        experienceMax: 2,
      }),
    ).rejects.toThrow("Minimum experience is above the maximum");
  });

  test("the approver's corrections keep the step, trail an edited entry and audit", async () => {
    const out = await lifecycle.editRequisitionInApprovalCore(
      actor(orgA, dhId, `dh@${dom}`),
      reqEdit,
      {
        title: "Staff Platform Engineer",
        mustHaveSkills: ["PostgreSQL", "Go"],
      },
    );
    expect(out).toEqual({ changed: ["role", "must-have skills"] });
    const [row] = await db
      .select({
        status: requisitions.status,
        title: requisitions.title,
        approvalTrail: requisitions.approvalTrail,
      })
      .from(requisitions)
      .where(eq(requisitions.id, reqEdit));
    expect(row!.status).toBe("pending_dh");
    expect((row!.approvalTrail as Record<string, unknown>[]).at(-1)).toMatchObject({
      from: "pending_dh",
      to: "pending_dh",
      decision: "edited",
      comment: "Corrected role, must-have skills.",
    });
    const audits = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "requisition.edited_in_approval")));
    expect(audits.length).toBe(1);
  });

  test("an identical patch changes nothing", async () => {
    const out = await lifecycle.editRequisitionInApprovalCore(
      actor(orgA, dhId, `dh@${dom}`),
      reqEdit,
      {
        title: "Staff Platform Engineer",
      },
    );
    expect(out).toEqual({ changed: [] });
  });
});

describe("roleHiringManagerOf / setRoleHiringManagerCore (role-hiring-manager.server)", () => {
  let memberPlain: string;
  let memberHm: string;
  let reqMgr: string;

  beforeAll(async () => {
    const plainUserId = await mkUser(`plain-${stamp}@${dom}`);
    const hmUserId = await mkUser(`hm-${stamp}@${dom}`);
    cleanupUserIds.push(plainUserId, hmUserId);
    memberPlain = await member(plainUserId, `plain-${stamp}@${dom}`, orgA);
    memberHm = await member(hmUserId, `hm-${stamp}@${dom}`, orgA, false, ["hiring_manager"]);
    reqMgr = await mkReq(orgA, ownerId, "draft");
  });

  test("the read is org-scoped: another org's requisitionId throws", async () => {
    await expect(rhm.roleHiringManagerOf(orgB, reqMgr)).rejects.toThrow("Requisition not found.");
  });

  test("options list only this org's active members, hiring managers first", async () => {
    const out = await rhm.roleHiringManagerOf(orgA, reqMgr);
    expect(out).toMatchObject({ memberId: null, name: null });
    const emails = out.options.map((o) => o.email);
    expect(emails).toContain(`plain-${stamp}@${dom}`);
    expect(emails).not.toContain(`ownerb@${dom}`);
    expect(out.options[0]!.manager).toBe(true);
    // hiring_manager and department_head both count as managers, ordered first
    expect(out.options.filter((o) => o.manager).map((o) => o.email)).toEqual([
      `dh@${dom}`,
      `hm-${stamp}@${dom}`,
    ]);
  });

  test("a member of another organisation cannot be picked", async () => {
    await expect(
      rhm.setRoleHiringManagerCore(orgA, ownerId, reqMgr, crypto.randomUUID()),
    ).rejects.toThrow("Pick an active member of your organisation.");
  });

  test("setting lands the member on the role and writes the audit", async () => {
    const out = await rhm.setRoleHiringManagerCore(orgA, ownerId, reqMgr, memberHm);
    expect(out.memberId).toBe(memberHm);
    const [row] = await db
      .select({ hiringManagerMemberId: requisitions.hiringManagerMemberId })
      .from(requisitions)
      .where(and(eq(requisitions.id, reqMgr), eq(requisitions.orgId, orgA)));
    expect(row!.hiringManagerMemberId).toBe(memberHm);
    const audits = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "requisition.hiring_manager_set")));
    expect(audits.length).toBe(1);
    expect((audits[0]!.detail as Record<string, unknown>).member).toBe(`hm-${stamp}@${dom}`);
  });
});

describe("draftRoleProfile (role-profile.server)", () => {
  test("with no saved key it refuses vendor-neutrally — no provider call", async () => {
    await expect(
      rp.draftRoleProfile({
        orgId: orgA,
        role: "Staff Platform Engineer",
        experienceMin: 6,
        experienceMax: 12,
      }),
    ).rejects.toThrow("No AI model key saved");
  });
});

describe("findDuplicateRequisitions (jd-dedupe, pure)", () => {
  const existing = [
    {
      id: "r1",
      code: "REQ-1",
      title: "Platform Engineer",
      status: "approved",
      department_id: "d1",
      location: "Chennai",
      must_have_skills: ["PostgreSQL", "TypeScript"],
    },
    {
      id: "r2",
      code: "REQ-2",
      title: "Data Platform Engineer",
      status: "pending_dh",
      department_id: null,
      location: "Chennai",
      must_have_skills: ["PostgreSQL"],
    },
    {
      id: "r3",
      code: "REQ-3",
      title: "Platform Engineer",
      status: "closed",
      department_id: "d1",
      location: "Chennai",
      must_have_skills: ["PostgreSQL"],
    },
    {
      id: "r4",
      code: "REQ-4",
      title: "Payroll Specialist",
      status: "approved",
      department_id: "d2",
      location: "Mumbai",
      must_have_skills: ["Payroll"],
    },
  ];

  test("an empty title matches nothing", () => {
    expect(dedupe.findDuplicateRequisitions({ title: "  " }, existing)).toEqual([]);
  });

  test("same role: title, department, location and skills stack into the score, strongest first", () => {
    const out = dedupe.findDuplicateRequisitions(
      {
        title: "Platform Engineer",
        department_id: "d1",
        location: "Chennai",
        must_have_skills: ["PostgreSQL", "TypeScript"],
      },
      existing,
    );
    expect(out.map((m) => m.req.id)).toEqual(["r1", "r2"]);
    // the score is capped at 1 — an identical title with every boost maxes it
    expect(out[0]!.score).toBe(1);
    expect(out[0]!.reasons).toEqual([
      "Identical role title",
      "Same department",
      "Overlapping location",
      "Must-have skills overlap (100%)",
    ]);
    // r2 shares only the title similarity, location and skills — no department
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
    // r3 is closed — history, not a duplicate; r4's title is too far off.
    expect(out.map((m) => m.req.id)).not.toContain("r3");
    expect(out.map((m) => m.req.id)).not.toContain("r4");
  });

  test("excludeId skips the requisition being edited; results cap at five", () => {
    const out = dedupe.findDuplicateRequisitions(
      { title: "Platform Engineer", must_have_skills: ["PostgreSQL"] },
      existing,
      { excludeId: "r1" },
    );
    expect(out.map((m) => m.req.id)).toEqual(["r2"]);
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      code: `M-${i}`,
      title: "Platform Engineer",
      status: "draft",
      department_id: null,
      location: null,
      must_have_skills: [],
    }));
    expect(dedupe.findDuplicateRequisitions({ title: "Platform Engineer" }, many).length).toBe(5);
  });
});

describe("work-mode (pure)", () => {
  test("the three modes carry display labels", () => {
    expect([...wm.WORK_MODES]).toEqual(["onsite", "hybrid", "remote"]);
    expect(wm.WORK_MODE_LABEL.remote).toBe("Remote");
  });

  test("placeLabel composes location and mode, deduplicating and passing blanks through", () => {
    expect(wm.placeLabel("Chennai", "hybrid")).toBe("Chennai (Hybrid)");
    expect(wm.placeLabel("Chennai", null)).toBe("Chennai");
    expect(wm.placeLabel(null, "remote")).toBe("Remote");
    expect(wm.placeLabel(null, null)).toBe("");
    expect(wm.placeLabel("Remote, India", "remote")).toBe("Remote, India");
    expect(wm.placeLabel("Chennai", "not-a-mode")).toBe("Chennai");
  });
});

// Re-run safety: rows are all org-scoped and removed with the orgs; the code
// allocation starts from the highest REQ-<year>-N in the org, so a second run
// in the same database still allocates cleanly.
describe("re-run safety", () => {
  test("a second pass over the same database allocates the next code cleanly", async () => {
    const out = await lifecycle.createRequisitionCore(
      actor(orgA, ownerId, `owner@${dom}`),
      fields(),
      "draft",
    );
    expect(out.code).toMatch(new RegExp(`^REQ-${new Date().getFullYear()}-\\d{3}$`));
  });
});

// keep drizzle helpers referenced for the cleanup path even if tests above are
// filtered out
void inArray;
void applications;
