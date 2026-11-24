/**
 * Offers-domain behaviour lockdown (Phase 5/6 L3 domain: src/lib/offer*,
 * negotiation, compensation, comp-knowledge, salary-benchmark, market.*,
 * pay-*, labour-policy), against the disposable database. The *.functions.ts
 * server fns are requireOrg-wrapped and not invocable from bun test — what is
 * locked down is the core each wrapper delegates to, so a move into an @ats/*
 * package cannot change behaviour silently:
 *  - ORG ISOLATION: a second organisation cannot read or touch the first
 *    organisation's applications, offers, pay details, negotiations, check
 *    overrides, convention drafts, rates, pay zones or policy sources;
 *  - ROLE CHECKS: every assertRole-gated core refuses a plain member (raising
 *    offers, approval hops, send-backs, the offer-check override, pay entry,
 *    negotiation outcomes, pay conventions and rates, policy sources);
 *  - the offer approval chain (HR → CBO → release) is built server-side: the
 *    transition table, the letter / terms / check / readiness gates, the
 *    candidate's token answer and the trails;
 *  - compensation and negotiation cores: happy and refusal paths;
 *  - salary benchmark / market research: the vendor-neutral refusal with no
 *    AI key (CI has none).
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/offers-domain.test.ts
 */
// bun test does not load .env.local — pick up the secrets the server env
// schema demands before any module graph loads, so the documented run line
// needs only DATABASE_URL and SESSION_SECRET (what CI sets).
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
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  applications,
  auditLog,
  candidates,
  compKnowledge,
  compensationDetails,
  compensationRequests,
  emailOutbox,
  offerNegotiations,
  offers,
  onboardingDocuments,
  organizations,
  orgMembers,
  exchangeRates,
  payConventionDrafts,
  payFigures,
  poolingRegions,
  policyReads,
  requisitions,
  userRoles,
  users,
  payZones,
  agentRuns,
  agentTasks,
} = await import("../drizzle/schema");
const offersFn = await import("../src/lib/offers.functions");
const offerResp = await import("../src/lib/offer-response.server");
const offerCheck = await import("../src/lib/offer-check.server");
const checkLib = await import("../src/lib/offer-check");
const comp = await import("../src/lib/compensation.server");
const neg = await import("../src/lib/negotiation.server");
const bench = await import("../src/lib/salary-benchmark.server");
const knowledge = await import("../src/lib/comp-knowledge.server");
const paySettings = await import("../src/lib/pay-settings.server");
const paySettingsLib = await import("../src/lib/pay-settings");
const payCtx = await import("../src/lib/pay-context.server");
const payConvert = await import("../src/lib/pay-convert");
const payTermsLib = await import("../src/lib/pay-terms");
const labour = await import("../src/lib/labour-policy.server");
const market = await import("../src/lib/market.server");

const stamp = Date.now();
const dom = `offd${stamp}.test`;
let orgA: string;
let orgB: string;
let ownerA: string;
let hrA: string; // recruiter + hr_head
let cboA: string; // president_cbo only
let hmA: string; // hiring_manager — the wrong role everywhere
let hrB: string; // org B's recruiter + hr_head
let reqA: string;
let reqDraftA: string;
let reqB: string;
let candA: string;
let candB: string;
let appA: string;
let appB: string;
let zoneA: string;
let zoneB: string;
let releasedOfferOfChain = "";
let backOfferOfSendBack = "";
let negotiation1 = "";
let negotiation2 = "";
const hrEmail = `hr-${stamp}@${dom}`;
const asHr = () => ({ orgId: orgA, userId: hrA, memberEmail: hrEmail });
const asCbo = () => ({ orgId: orgA, userId: cboA, memberEmail: `cbo@${dom}` });
const asHm = () => ({ orgId: orgA, userId: hmA, memberEmail: `hm@${dom}` });

const LETTER = {
  subject: "Offer of employment",
  greeting: "Dear Meera,",
  opening: "We are pleased to offer you the role of AI Lead.",
  sections: [{ heading: "Compensation", body: "The annual CTC is as discussed." }],
  closing: "Sincerely,",
  generatedAt: new Date().toISOString(),
};

async function run(agentType: "offer" | "screening" = "offer") {
  return (
    await db
      .insert(agentRuns)
      .values({
        orgId: orgA,
        agentType,
        principalUserId: hrA,
        goal: "g",
        status: "running",
        subjectType: "application",
        subjectId: appA,
      } as never)
      .returning({ id: agentRuns.id })
  )[0]!.id;
}
async function answered(runId: string, assigneeRole: "hr_head" | "president_cbo") {
  await db.insert(agentTasks).values({
    orgId: orgA,
    runId,
    kind: "clarification",
    status: "answered",
    title: "Ceiling",
    assigneeRole,
    response: { answer: "ok" },
    decidedBy: assigneeRole === "hr_head" ? hrA : cboA,
  } as never);
}

/** A draft offer raised through the core, with its letter (and joining date) set. */
async function draftOffer(o: { ctc?: string; joiningDate?: string | null; letter?: boolean } = {}) {
  const created = await offersFn.createOfferCore(
    asHr(),
    {
      applicationId: appA,
      offeredCtc: o.ctc ?? "9000000",
      joiningDate: o.joiningDate === undefined ? "2027-03-01" : o.joiningDate,
    },
    "draft",
  );
  if (o.letter ?? true)
    await db.update(offers).set({ letter: LETTER }).where(eq(offers.id, created.id));
  return created.id;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");

  const mkOrg = async (name: string) =>
    (
      await db
        .insert(organizations)
        .values({
          name,
          slug: `offd-${name.toLowerCase().replace(/\s+/g, "-")}-${stamp}`,
          status: "active",
        })
        .returning({ id: organizations.id })
    )[0]!.id;
  orgA = await mkOrg("Offers Domain A");
  orgB = await mkOrg("Offers Domain B");

  const mkUser = async (email: string) =>
    (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
  ownerA = await mkUser(`owner@${dom}`);
  hrA = await mkUser(hrEmail);
  cboA = await mkUser(`cbo@${dom}`);
  hmA = await mkUser(`hm@${dom}`);
  hrB = await mkUser(`hrb@${dom}`);
  const member = async (userId: string, email: string, isOwner = false) =>
    db
      .insert(orgMembers)
      .values({ orgId: orgA, userId, email, status: "active", isOwner } as never);
  await member(ownerA, `owner@${dom}`, true);
  await member(hrA, hrEmail);
  await member(cboA, `cbo@${dom}`);
  await member(hmA, `hm@${dom}`);
  await db.insert(orgMembers).values({
    orgId: orgB,
    userId: hrB,
    email: `hrb@${dom}`,
    status: "active",
  } as never);
  await db.insert(userRoles).values([
    { userId: hrA, orgId: orgA, role: "recruiter" as never },
    { userId: hrA, orgId: orgA, role: "hr_head" as never },
    { userId: cboA, orgId: orgA, role: "president_cbo" as never },
    { userId: hmA, orgId: orgA, role: "hiring_manager" as never },
    { userId: hrB, orgId: orgB, role: "recruiter" as never },
    { userId: hrB, orgId: orgB, role: "hr_head" as never },
  ] as never);

  const mkReq = async (o: string, code: string, status: string, creator: string) =>
    (
      await db
        .insert(requisitions)
        .values({
          orgId: o,
          code,
          title: "AI Lead",
          status,
          createdBy: creator,
          ctcBandMin: "7000000",
          ctcBandMax: "10500000",
          budgetCtc: "8500000",
        } as never)
        .returning({ id: requisitions.id })
    )[0]!.id;
  reqA = await mkReq(orgA, `REQ-OD-${stamp}`, "approved", hrA);
  reqB = await mkReq(orgB, `REQ-ODB-${stamp}`, "approved", hrB);
  reqDraftA = await mkReq(orgA, `REQ-ODD-${stamp}`, "draft", hrA);

  const mkCand = async (o: string, name: string) =>
    (
      await db
        .insert(candidates)
        .values({
          orgId: o,
          fullName: name,
          email: `${name.split(" ")[0]!.toLowerCase()}-${stamp}@cand.local`,
        })
        .returning({ id: candidates.id })
    )[0]!.id;
  candA = await mkCand(orgA, "Meera Iyer");
  candB = await mkCand(orgB, "Other Person");
  appA = (
    await db
      .insert(applications)
      .values({ orgId: orgA, requisitionId: reqA, candidateId: candA, stage: "offer_pending" })
      .returning({ id: applications.id })
  )[0]!.id;
  appB = (
    await db
      .insert(applications)
      .values({ orgId: orgB, requisitionId: reqB, candidateId: candB, stage: "offer_pending" })
      .returning({ id: applications.id })
  )[0]!.id;

  zoneA = (
    await db
      .insert(payZones)
      .values({
        orgId: orgA,
        name: `Zone A ${stamp}`,
        countries: ["IN"],
        cities: ["Bengaluru"],
        currency: "INR",
        payBasis: "annual",
      } as never)
      .returning({ id: payZones.id })
  )[0]!.id;
  zoneB = (
    await db
      .insert(payZones)
      .values({
        orgId: orgA,
        name: `Zone B ${stamp}`,
        countries: ["DE"],
        cities: [],
        currency: "EUR",
        payBasis: "annual",
      } as never)
      .returning({ id: payZones.id })
  )[0]!.id;

  // The candidate's settled terms (expected CTC + notice) — everything the
  // offer gates read. The expectation sits above the negotiating ceiling so a
  // pay discussion is legitimate.
  await db.insert(compensationDetails).values({
    orgId: orgA,
    applicationId: appA,
    candidateId: candA,
    expectedCtc: "9000000",
    noticePeriodDays: 60,
    source: "candidate_form",
  } as never);
});

afterAll(async () => {
  // audit rows carry no FK; the rest cascades from the organisations.
  for (const id of [orgA, orgB]) await db.delete(auditLog).where(eq(auditLog.orgId, id));
  await db.delete(organizations).where(eq(organizations.id, orgA));
  await db.delete(organizations).where(eq(organizations.id, orgB));
  for (const id of [ownerA, hrA, cboA, hmA, hrB]) await db.delete(users).where(eq(users.id, id));
});

/* ------------------------------------------------------------ raising offers */

describe("createOfferCore (offers.functions)", () => {
  test("happy: the recruiting team raises a draft offer in the role's pay terms", async () => {
    const created = await offersFn.createOfferCore(
      asHr(),
      { applicationId: appA, offeredCtc: "9000000", joiningDate: "2027-03-01" },
      "draft",
    );
    const [o] = await db.select().from(offers).where(eq(offers.id, created.id));
    expect(o).toMatchObject({
      orgId: orgA,
      applicationId: appA,
      status: "draft",
      currency: "INR",
      payBasis: "annual",
      kindOfWork: "permanent",
      revision: 1,
    });
    expect(Number(o!.offeredCtc)).toBe(9_000_000);
    expect(String(o!.joiningDate)).toMatch(/2027-03-0/);
    await db.delete(offers).where(eq(offers.id, created.id));
  });

  test("refusal: a hiring manager is not the recruiting team", async () => {
    await expect(
      offersFn.createOfferCore(asHm(), { applicationId: appA, offeredCtc: "9000000" }),
    ).rejects.toThrow(/Only the recruiting team/);
  });

  test("org isolation: another org's application is never raisable", async () => {
    await expect(
      offersFn.createOfferCore(asHr(), { applicationId: appB, offeredCtc: "9000000" }),
    ).rejects.toThrow("Application not found");
  });
});

/* ------------------------------------------------- the server-side approval chain */

describe("advanceOfferCore — the HR → CBO → release approval chain", () => {
  let chainOffer = "";

  test("refusal: an illegal hop is refused before anything else", async () => {
    chainOffer = await draftOffer();
    await expect(
      offersFn.advanceOfferCore(asHr(), { id: chainOffer, status: "approved" }),
    ).rejects.toThrow("An offer cannot move from draft to approved.");
  }, 20_000);

  test("gate: an offer without a joining date cannot go for approval", async () => {
    const noDate = await draftOffer({ joiningDate: null });
    await expect(
      offersFn.advanceOfferCore(asHr(), { id: noDate, status: "pending_hr" }),
    ).rejects.toThrow(/cannot go for approval yet/);
    await expect(
      offersFn.advanceOfferCore(asHr(), { id: noDate, status: "pending_hr" }),
    ).rejects.toThrow(/a joining date on the offer/);
    await db.delete(offers).where(eq(offers.id, noDate));
  }, 20_000);

  test("org isolation: another org's offer id opens nothing", async () => {
    const orgBOffer = (
      await db
        .insert(offers)
        .values({ orgId: orgB, applicationId: appB, offeredCtc: "9000000", status: "draft" })
        .returning({ id: offers.id })
    )[0]!.id;
    await expect(
      offersFn.advanceOfferCore(asHr(), { id: orgBOffer, status: "pending_hr" }),
    ).rejects.toThrow("Offer not found");
    await db.delete(offers).where(eq(offers.id, orgBOffer));
  });

  test("happy: draft → pending_hr runs the offer check (no rules yet: needs counsel)", async () => {
    await offersFn.advanceOfferCore(asHr(), { id: chainOffer, status: "pending_hr" });
    const [o] = await db
      .select({ status: offers.status, check: offers.policyCheck, trail: offers.approvalTrail })
      .from(offers)
      .where(eq(offers.id, chainOffer));
    expect(o!.status).toBe("pending_hr");
    expect(o!.check!.verdict).toBe("needs_counsel");
    expect((o!.trail as { to: string }[]).at(-1)).toMatchObject({
      from: "draft",
      to: "pending_hr",
    });
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "offer.policy_checked")));
    expect(audits.length).toBe(1);
  }, 20_000);

  test("role: only the HR head submits for CBO approval", async () => {
    await expect(
      offersFn.advanceOfferCore(asCbo(), { id: chainOffer, status: "pending_cbo" }),
    ).rejects.toThrow(/permission/);
    await offersFn.advanceOfferCore(asHr(), { id: chainOffer, status: "pending_cbo" });
    const [o] = await db
      .select({ status: offers.status })
      .from(offers)
      .where(eq(offers.id, chainOffer));
    expect(o!.status).toBe("pending_cbo");
  }, 20_000);

  test("role: only the CBO approves — and approval locks the reporting rate", async () => {
    await expect(
      offersFn.advanceOfferCore(asHr(), { id: chainOffer, status: "approved" }),
    ).rejects.toThrow(/permission/);
    await offersFn.advanceOfferCore(asCbo(), { id: chainOffer, status: "approved" });
    const [o] = await db
      .select({
        status: offers.status,
        reporting: offers.reportingAmount,
        locked: offers.rateLockedAt,
      })
      .from(offers)
      .where(eq(offers.id, chainOffer));
    expect(o!.status).toBe("approved");
    expect(Number(o!.reporting)).toBe(9_000_000);
    expect(o!.locked).not.toBeNull();
  }, 20_000);

  test("role + gate: only the HR head releases, and only with verified pre-onboarding documents", async () => {
    await expect(
      offersFn.advanceOfferCore(asCbo(), { id: chainOffer, status: "released" }),
    ).rejects.toThrow(/permission/);
    await expect(
      offersFn.advanceOfferCore(asHr(), { id: chainOffer, status: "released" }),
    ).rejects.toThrow(/Pre-onboarding is incomplete/);
    for (const docType of ["id_proof", "experience_letter", "payslip", "education_certificate"])
      await db.insert(onboardingDocuments).values({
        orgId: orgA,
        applicationId: appA,
        candidateId: candA,
        offerId: chainOffer,
        docType,
        fileName: `${docType}.pdf`,
        status: "verified",
      } as never);
    await offersFn.advanceOfferCore(asHr(), { id: chainOffer, status: "released" });
    const [o] = await db
      .select({ status: offers.status, token: offers.responseToken, trail: offers.approvalTrail })
      .from(offers)
      .where(eq(offers.id, chainOffer));
    expect(o!.status).toBe("released");
    expect(o!.token).toMatch(/^[a-f0-9]{64}$/);
    expect((o!.trail as { decision: string }[]).at(-1)!.decision).toBe("released");
    releasedOfferOfChain = chainOffer;
  }, 30_000);
});

describe("sendBackOfferCore", () => {
  let backOffer = "";

  beforeAll(async () => {
    backOffer = await draftOffer();
    await offersFn.advanceOfferCore(asHr(), { id: backOffer, status: "pending_hr" });
  }, 30_000);

  test("refusal: a reason of fewer than three characters is refused", async () => {
    await expect(
      offersFn.sendBackOfferCore(asHr(), { id: backOffer, reason: "no" }),
    ).rejects.toThrow("Say why the offer is sent back.");
  });

  test("role: at the HR step only the HR head sends back", async () => {
    await expect(
      offersFn.sendBackOfferCore(asCbo(), {
        id: backOffer,
        reason: "The terms were never agreed with the candidate.",
      }),
    ).rejects.toThrow(/permission/);
  });

  test("refusal: an offer not waiting for an approval cannot be sent back", async () => {
    await expect(
      offersFn.sendBackOfferCore(asHr(), {
        id: releasedOfferOfChain,
        reason: "The letter needs a rewrite.",
      }),
    ).rejects.toThrow(/not waiting for an approval/);
  });

  test("org isolation: another org's offer is not here", async () => {
    const foreign = (
      await db
        .insert(offers)
        .values({ orgId: orgB, applicationId: appB, offeredCtc: "1", status: "pending_hr" })
        .returning({ id: offers.id })
    )[0]!.id;
    await expect(
      offersFn.sendBackOfferCore(asHr(), { id: foreign, reason: "Not our offer at all." }),
    ).rejects.toThrow("Offer not found");
    await db.delete(offers).where(eq(offers.id, foreign));
  });

  test("happy: the HR head sends it back to draft with the reason on the trail, audited", async () => {
    await offersFn.sendBackOfferCore(asHr(), {
      id: backOffer,
      reason: "The joining date was never confirmed with the candidate.",
    });
    const [o] = await db
      .select({ status: offers.status, trail: offers.approvalTrail })
      .from(offers)
      .where(eq(offers.id, backOffer));
    expect(o!.status).toBe("draft");
    expect((o!.trail as { decision: string; comment: string }[]).at(-1)).toMatchObject({
      decision: "sent_back",
      comment: "The joining date was never confirmed with the candidate.",
    });
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "offer.sent_back")));
    expect(audits.length).toBe(1);
    backOfferOfSendBack = backOffer;
  }, 20_000);
});

describe("reviseOfferCore", () => {
  test("happy: a sent-back draft is revised to the next version, letter cleared, audited", async () => {
    const o = await offersFn.reviseOfferCore(asHr(), {
      offerId: backOfferOfSendBack,
      offeredCtc: 9_200_000,
      joiningDate: "2027-04-01",
      rationale: "The candidate asked for a later joining date.",
    });
    expect(o.revision).toBe(2);
    const [row] = await db
      .select({
        status: offers.status,
        ctc: offers.offeredCtc,
        letter: offers.letter,
        joining: offers.joiningDate,
      })
      .from(offers)
      .where(eq(offers.id, backOfferOfSendBack));
    expect(row!.status).toBe("draft");
    expect(Number(row!.ctc)).toBe(9_200_000);
    expect(row!.letter).toBeNull();
    expect(String(row!.joining)).toMatch(/2027-04-01/);
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "offer.revised")));
    expect(audits.length).toBe(1);
  }, 20_000);

  test("refusal: a released offer cannot be revised", async () => {
    await expect(
      offersFn.reviseOfferCore(asHr(), {
        offerId: releasedOfferOfChain,
        offeredCtc: 9_500_000,
        joiningDate: null,
        rationale: "Trying to change a released offer.",
      }),
    ).rejects.toThrow("An offer that is released cannot be revised.");
  });

  test("org isolation: another org's offer is not here", async () => {
    const foreign = (
      await db
        .insert(offers)
        .values({ orgId: orgB, applicationId: appB, offeredCtc: "1", status: "countered" })
        .returning({ id: offers.id })
    )[0]!.id;
    await expect(
      offersFn.reviseOfferCore(asHr(), {
        offerId: foreign,
        offeredCtc: 2,
        joiningDate: null,
        rationale: "Not our offer.",
      }),
    ).rejects.toThrow("Offer not found.");
    await db.delete(offers).where(eq(offers.id, foreign));
  });
});

/* ------------------------------------------------- the candidate's token answer */

describe("offer-response.server — the private /offer/<token> flow", () => {
  const tokenB = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  let orgBOffer = "";

  beforeAll(async () => {
    orgBOffer = (
      await db
        .insert(offers)
        .values({
          orgId: orgB,
          applicationId: appB,
          offeredCtc: "12000000",
          status: "released",
          responseToken: tokenB,
          letter: LETTER,
        } as never)
        .returning({ id: offers.id })
    )[0]!.id;
  });

  test("the token shows only its own offer's facts; a wrong token shows nothing", async () => {
    const view = await offerResp.publicOfferView(tokenB);
    expect(view).toMatchObject({
      orgName: "Offers Domain B",
      jobTitle: "AI Lead",
      candidateFirstName: "Other",
      offeredCtc: 12_000_000,
      currency: "INR",
      payBasis: "annual",
      status: "released",
    });
    expect(view!.letter!.subject).toBe("Offer of employment");
    expect(await offerResp.publicOfferView(`wrong-${stamp}`)).toBeNull();
  });

  test("org scoping: org A's released token never reveals org B's offer", async () => {
    const [released] = await db
      .select({ token: offers.responseToken })
      .from(offers)
      .where(and(eq(offers.id, releasedOfferOfChain), eq(offers.orgId, orgA)));
    const a = await offerResp.publicOfferView(released!.token!);
    expect(a!.orgName).toBe("Offers Domain A");
    expect(JSON.stringify(a)).not.toContain("Offers Domain B");
    expect(JSON.stringify(a)).not.toContain("12000000");
  });

  test("the candidate declines org B's offer with a reason; the trail and audit record it", async () => {
    const out = await offerResp.respondToOffer(tokenB, {
      action: "decline",
      reason: "  Joining   too   soon.  ",
    });
    expect(out).toEqual({ ok: true, status: "declined" });
    const [o] = await db
      .select({
        status: offers.status,
        trail: offers.approvalTrail,
        respondedAt: offers.respondedAt,
      })
      .from(offers)
      .where(eq(offers.id, orgBOffer));
    expect(o!.status).toBe("declined");
    expect(o!.respondedAt).not.toBeNull();
    expect((o!.trail as { actor: string; comment: string }[]).at(-1)).toMatchObject({
      actor: "candidate",
      comment: "Joining too soon.",
    });
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgB), eq(auditLog.action, "offer.declined")));
    expect(audits.length).toBe(1);
  }, 20_000);

  test("an offer is answered once: the second answer is refused", async () => {
    const again = await offerResp.respondToOffer(tokenB, { action: "accept" });
    expect(again).toMatchObject({ ok: false });
    const invalid = await offerResp.respondToOffer(`wrong-${stamp}`, { action: "accept" });
    expect(invalid).toMatchObject({ ok: false, reason: "This link is not valid." });
  });

  test("happy: org A's released offer is accepted, the trail and audit record the candidate", async () => {
    const [released] = await db
      .select({ token: offers.responseToken })
      .from(offers)
      .where(eq(offers.id, releasedOfferOfChain));
    const out = await offerResp.respondToOffer(released!.token!, { action: "accept" });
    expect(out).toEqual({ ok: true, status: "accepted" });
    const [o] = await db
      .select({ status: offers.status })
      .from(offers)
      .where(eq(offers.id, releasedOfferOfChain));
    expect(o!.status).toBe("accepted");
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "offer.accepted")));
    expect(audits.length).toBe(1);
  }, 20_000);

  afterAll(async () => {
    if (orgBOffer) await db.delete(offers).where(eq(offers.id, orgBOffer));
  });
});

/* ------------------------------------------------------------ the offer check */

describe("offer-check.server", () => {
  let checkOffer = "";

  beforeAll(async () => {
    checkOffer = await draftOffer();
  }, 20_000);

  test("checkKeyOf is keyed to the exact rules, letter and terms", async () => {
    const rules = [{ id: "r1", decidedAt: new Date("2026-01-01T00:00:00Z") }];
    const o = {
      letter: { generatedAt: "2026-01-01T00:00:00Z" },
      offeredCtc: "9000000",
      currency: "INR",
      payBasis: "annual",
      joiningDate: "2027-03-01",
      contractEnd: null,
    };
    expect(offerCheck.checkKeyOf(rules, o)).toBe(offerCheck.checkKeyOf(rules, o));
    expect(offerCheck.checkKeyOf(rules, o)).not.toBe(
      offerCheck.checkKeyOf([{ id: "r1", decidedAt: new Date("2026-02-01T00:00:00Z") }], o),
    );
    expect(offerCheck.checkKeyOf(rules, o)).not.toBe(
      offerCheck.checkKeyOf(rules, { ...o, letter: { generatedAt: "2026-06-01T00:00:00Z" } }),
    );
    expect(offerCheck.checkKeyOf(rules, o)).not.toBe(
      offerCheck.checkKeyOf(rules, { ...o, offeredCtc: "9100000" }),
    );
  });

  test("happy: with no approved rules the check records needs-counsel — and never calls AI", async () => {
    const check = await offerCheck.runOfferCheckCore(orgA, checkOffer, { actor: hrEmail });
    expect(check.verdict).toBe("needs_counsel");
    expect(check.rules).toEqual([]);
    expect(check.items[0]!.verdict).toBe("needs_counsel");
    const [o] = await db
      .select({ check: offers.policyCheck })
      .from(offers)
      .where(eq(offers.id, checkOffer));
    expect(o!.check!.key).toBe(check.key);
  });

  test("failure: no letter to read — the check refuses", async () => {
    const bare = await draftOffer({ letter: false });
    await expect(offerCheck.runOfferCheckCore(orgA, bare)).rejects.toThrow(
      "Generate the offer letter first",
    );
    await db.delete(offers).where(eq(offers.id, bare));
  }, 20_000);

  test("org isolation: another org cannot check this offer", async () => {
    await expect(offerCheck.runOfferCheckCore(orgB, checkOffer)).rejects.toThrow(
      "Offer not found.",
    );
    await expect(offerCheck.currentCheckKey(orgB, checkOffer)).rejects.toThrow("Offer not found.");
  });

  test("offerCheckBlock: a fix-needed check blocks; the HR head's override clears it", async () => {
    const key = await offerCheck.currentCheckKey(orgA, checkOffer);
    await db
      .update(offers)
      .set({
        policyCheck: {
          at: new Date().toISOString(),
          verdict: "fix_needed",
          items: [
            {
              check: "Pay floor",
              verdict: "fix_needed",
              detail: "Below the zone floor",
              ruleId: null,
              suggestion: null,
            },
          ],
          key,
          zone: null,
          rules: [],
        } as never,
      })
      .where(eq(offers.id, checkOffer));
    const block = await offerCheck.offerCheckBlock(orgA, checkOffer);
    expect(block).toMatch(/needs fixes first: Pay floor/);

    // role + reason gates on the override
    await expect(
      offerCheck.overrideOfferCheckCore(asHm(), {
        offerId: checkOffer,
        reason: "The floor does not apply to this seniority.",
      }),
    ).rejects.toThrow(/Only the HR head/);
    await expect(
      offerCheck.overrideOfferCheckCore(asHr(), { offerId: checkOffer, reason: "short" }),
    ).rejects.toThrow("Say why the offer may go ahead as it is.");
    await offerCheck.overrideOfferCheckCore(asHr(), {
      offerId: checkOffer,
      reason: "Counsel reviewed the floor and this seniority is exempt.",
    });
    const [o] = await db
      .select({ override: offers.policyOverride })
      .from(offers)
      .where(eq(offers.id, checkOffer));
    expect(o!.override).toMatchObject({ by: hrEmail, checkKey: key });
    expect(await offerCheck.offerCheckBlock(orgA, checkOffer)).toBeNull();
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "offer.policy_overridden")));
    expect(audits.length).toBe(1);
  }, 20_000);

  test("override refusals: a passing check has nothing to override; a missing one is stale", async () => {
    const key = await offerCheck.currentCheckKey(orgA, checkOffer);
    await db
      .update(offers)
      .set({
        policyCheck: {
          at: new Date().toISOString(),
          verdict: "pass",
          items: [
            { check: "Pay floor", verdict: "pass", detail: "ok", ruleId: null, suggestion: null },
          ],
          key,
          zone: null,
          rules: [],
        } as never,
      })
      .where(eq(offers.id, checkOffer));
    await expect(
      offerCheck.overrideOfferCheckCore(asHr(), {
        offerId: checkOffer,
        reason: "Trying to override a passing check.",
      }),
    ).rejects.toThrow("There is nothing to override.");
    await db.update(offers).set({ policyCheck: null }).where(eq(offers.id, checkOffer));
    await expect(
      offerCheck.overrideOfferCheckCore(asHr(), {
        offerId: checkOffer,
        reason: "The check was never run at all.",
      }),
    ).rejects.toThrow("Run the offer check again first");
  });

  test("checkWords names the verdict and any override", () => {
    expect(checkLib.overallVerdict([{ verdict: "pass" }, { verdict: "pass" }])).toBe("pass");
    expect(checkLib.overallVerdict([{ verdict: "pass" }, { verdict: "fix_needed" }])).toBe(
      "fix_needed",
    );
    // the worst verdict wins: a fix outranks counsel, counsel outranks a pass
    expect(checkLib.overallVerdict([{ verdict: "fix_needed" }, { verdict: "needs_counsel" }])).toBe(
      "fix_needed",
    );
    expect(checkLib.overallVerdict([{ verdict: "pass" }, { verdict: "needs_counsel" }])).toBe(
      "needs_counsel",
    );
    const words = offerCheck.checkWords(
      {
        at: "2026-01-01",
        verdict: "fix_needed",
        items: [
          {
            check: "Pay floor",
            verdict: "fix_needed",
            detail: "d",
            ruleId: null,
            suggestion: null,
          },
        ],
        key: "k",
        zone: null,
        rules: [],
      },
      { by: "hr@test", reason: "exempt" },
    );
    expect(words).toContain("fixes needed on Pay floor");
    expect(words).toContain('overridden by hr@test: "exempt"');
    expect(offerCheck.checkWords(null, null)).toContain("not run");
  });

  afterAll(async () => {
    if (checkOffer) await db.delete(offers).where(eq(offers.id, checkOffer));
  });
});

/* ----------------------------------------------------- pay & availability */

describe("compensation.server cores", () => {
  beforeAll(async () => {
    // the accept test moved the candidate to offer_accepted; pay is asked before that
    await db.update(applications).set({ stage: "offer_pending" }).where(eq(applications.id, appA));
  });

  test("happy: the form is sent once; a second send returns the open request, no second email", async () => {
    const a = await comp.requestCompensation(orgA, appA, { userId: hrA, memberEmail: hrEmail });
    expect(a).toMatchObject({ emailed: true, alreadyOpen: false });
    const b = await comp.requestCompensation(orgA, appA, { userId: hrA, memberEmail: hrEmail });
    expect(b).toMatchObject({ requestId: a.requestId, emailed: false, alreadyOpen: true });
    const mails = await db
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.orgId, orgA), eq(emailOutbox.kind, "compensation_form")));
    expect(mails.length).toBe(1);
  }, 20_000);

  test("failure: pay is not asked once the process is past offer", async () => {
    await db.update(applications).set({ stage: "hired" }).where(eq(applications.id, appA));
    await expect(
      comp.requestCompensation(orgA, appA, { userId: hrA, memberEmail: hrEmail }),
    ).rejects.toThrow(/between screening and offer/);
    await db.update(applications).set({ stage: "offer_pending" }).where(eq(applications.id, appA));
  });

  test("org isolation: another org's application is not readable or askable", async () => {
    await expect(comp.detailsFor(orgA, appB)).rejects.toThrow(/not found/);
    await expect(
      comp.requestCompensation(orgA, appB, { userId: hrA, memberEmail: hrEmail }),
    ).rejects.toThrow(/not found/);
    expect(await comp.latestRequest(orgA, appB)).toBeNull();
  });

  test("role: a hiring manager cannot record pay; TA/HR can, which closes an open form", async () => {
    await expect(
      comp.recordCompensation(asHm(), appA, { expectedCtc: 9_000_000 }, "recruiter"),
    ).rejects.toThrow(/Only TA, the HR head or the CBO/);
    const r = await comp.requestCompensation(orgA, appA, { userId: hrA, memberEmail: hrEmail });
    const done = await comp.recordCompensation(
      asHr(),
      appA,
      { expectedCtc: 8_800_000, noticePeriodDays: 45 },
      "screening_call",
    );
    expect(done).toEqual({ ok: true, complete: true });
    const [req] = await db
      .select({ status: compensationRequests.status })
      .from(compensationRequests)
      .where(eq(compensationRequests.id, r.requestId));
    expect(req!.status).toBe("cancelled");
    const audits = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "compensation.recorded")));
    const detail = JSON.stringify(audits.at(-1)!.detail);
    expect(detail).not.toContain("8800000");
    expect(detail).toContain("expectedCtc");
  }, 20_000);

  test("the token form: one submission only, and the view never carries amounts", async () => {
    const r = await comp.requestCompensation(orgA, appA, { userId: hrA, memberEmail: hrEmail });
    const [row] = await db
      .select({ token: compensationRequests.token })
      .from(compensationRequests)
      .where(eq(compensationRequests.id, r.requestId));
    const view = await comp.publicCompensationView(row!.token);
    expect(view).toMatchObject({ status: "sent", candidateName: "Meera Iyer" });
    expect(JSON.stringify(view)).not.toMatch(/expectedCtc|currentFixed/i);
    const form = { expectedCtc: 9_000_000, noticePeriodDays: 60, consent: true };
    await expect(comp.submitCompensation(row!.token, form as never)).resolves.toEqual({ ok: true });
    await expect(comp.submitCompensation(row!.token, form as never)).rejects.toThrow(
      "You have already sent your details. Thank you.",
    );
    expect((await comp.publicCompensationView(row!.token)).status).toBe("completed");
    await expect(comp.publicCompensationView(`wrong-${stamp}`)).rejects.toThrow(
      "This link is not valid.",
    );
  }, 20_000);

  test("recordCallDetails stores what was said on the call; nothing stated records nothing", async () => {
    const out = await comp.recordCallDetails(orgA, appA, {
      currentFixed: 6_000_000,
      note: "plus ten lakhs in shares",
    });
    expect(out.recorded).toEqual(["currentFixed", "note"]);
    expect(await comp.recordCallDetails(orgA, appA, {})).toEqual({ recorded: [] });
    const audits = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "compensation.recorded")));
    expect(JSON.stringify(audits.at(-1)!.detail)).toContain("screening_call");
  }, 20_000);

  test("offerTermsMissing names exactly what an offer still lacks", async () => {
    expect(await comp.offerTermsMissing(orgA, appA, "2027-03-01")).toEqual([]);
    expect(await comp.offerTermsMissing(orgA, appA, null)).toEqual(["a joining date on the offer"]);
    expect(comp.listWords(["a", "b", "c"])).toBe("a, b and c");
    expect(comp.listWords(["only"])).toBe("only");
  });

  test("mergeCompensation keeps earlier figures and falls back to the profile", () => {
    const row = (at: number, f: Record<string, unknown>) =>
      ({ createdAt: new Date(at), source: "candidate_form", ...f }) as never;
    const v = comp.mergeCompensation(
      [row(1, { expectedCtc: "9000000", noticePeriodDays: 90 }), row(2, { noticePeriodDays: 30 })],
      { currentCtc: null, expectedCtc: null, noticePeriodDays: null },
    );
    expect(v).toMatchObject({ expectedCtc: 9_000_000, noticePeriodDays: 30, complete: true });
    expect(
      comp.mergeCompensation([], {
        currentCtc: "5000000",
        expectedCtc: "7000000",
        noticePeriodDays: null,
      }),
    ).toMatchObject({ source: "candidate_profile", complete: false, unconfirmed: true });
    expect(comp.joiningDateProblem("2020-01-01", new Date("2026-10-13T10:00:00Z"))).toMatch(/past/);
    expect(comp.joiningDateProblem("not a date", new Date())).toMatch(/not a real date/);
  });

  afterAll(async () => {
    await db.delete(compensationRequests).where(eq(compensationRequests.orgId, orgA));
    await db.delete(compensationDetails).where(eq(compensationDetails.orgId, orgA));
    await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgA));
    // restore the settled terms the later negotiation tests rely on
    await db.insert(compensationDetails).values({
      orgId: orgA,
      applicationId: appA,
      candidateId: candA,
      expectedCtc: "9000000",
      noticePeriodDays: 60,
      source: "candidate_form",
    } as never);
  });
});

/* ------------------------------------------------------------- negotiation */

describe("negotiation.server cores", () => {
  test("negotiationProblem refuses every impossible preparation", () => {
    const base = {
      ceiling: 8_500_000,
      proposedCtc: 8_000_000,
      bandMax: 10_500_000,
      hrAnswered: true,
      cboAnswered: false,
    };
    expect(neg.negotiationProblem({ ...base, expectedCtc: null })).toMatch(
      /expected CTC is not known/,
    );
    expect(
      neg.negotiationProblem({ ...base, expectedCtc: 9_000_000, proposedCtc: 8_600_000 }),
    ).toMatch(/above the ceiling/);
    expect(neg.negotiationProblem({ ...base, expectedCtc: 8_000_000 })).toMatch(
      /within the ceiling/,
    );
    expect(
      neg.negotiationProblem({
        ...base,
        expectedCtc: 12_000_000,
        ceiling: 11_000_000,
        proposedCtc: 10_000_000,
      }),
    ).toMatch(/assignee_role president_cbo/);
    expect(neg.negotiationProblem({ ...base, expectedCtc: 9_000_000, hrAnswered: false })).toMatch(
      /assignee_role hr_head/,
    );
    expect(neg.negotiationProblem({ ...base, expectedCtc: 9_000_000 })).toBeNull();
  });

  test("prepareNegotiation: no HR answer, or a proposal above the ceiling, refuses", async () => {
    const noAnswer = await run();
    const input = {
      applicationId: appA,
      ceiling: 8_500_000,
      proposedCtc: 8_000_000,
      levers: {},
      talkTrack: "x".repeat(40),
      message: "y".repeat(80),
    };
    await expect(
      neg.prepareNegotiation(
        { orgId: orgA, runId: noAnswer, actor: "offer-agent", principalUserId: hrA },
        input,
      ),
    ).rejects.toThrow(/assignee_role hr_head/);
    const withHr = await run();
    await answered(withHr, "hr_head");
    await expect(
      neg.prepareNegotiation(
        { orgId: orgA, runId: withHr, actor: "offer-agent", principalUserId: hrA },
        { ...input, proposedCtc: 8_600_000 },
      ),
    ).rejects.toThrow(/above the ceiling/);
  }, 20_000);

  test("org isolation: another org's application is never negotiable", async () => {
    const runId = await run();
    await expect(
      neg.prepareNegotiation(
        { orgId: orgA, runId, actor: "x", principalUserId: hrA },
        {
          applicationId: appB,
          ceiling: 8_500_000,
          proposedCtc: 8_000_000,
          levers: {},
          talkTrack: "x".repeat(40),
          message: "y".repeat(80),
        },
      ),
    ).rejects.toThrow(/not found/);
    expect(await neg.latestNegotiation(orgA, appB)).toBeNull();
  }, 20_000);

  test("happy: the Offer agent prepares the discussion; preparing again is idempotent", async () => {
    const runId = await run();
    await answered(runId, "hr_head");
    const input = {
      applicationId: appA,
      ceiling: 8_500_000,
      proposedCtc: 8_000_000,
      levers: { joiningBonus: 200_000 } as never,
      talkTrack: "x".repeat(40),
      message: "y".repeat(80),
    };
    const first = await neg.prepareNegotiation(
      { orgId: orgA, runId, actor: "offer-agent", principalUserId: hrA },
      input,
    );
    expect(first).toMatchObject({ status: "open", existing: false });
    const again = await neg.prepareNegotiation(
      { orgId: orgA, runId, actor: "offer-agent", principalUserId: hrA },
      input,
    );
    expect(again).toMatchObject({ negotiationId: first.negotiationId, existing: true });
    const [row] = await db
      .select()
      .from(offerNegotiations)
      .where(eq(offerNegotiations.id, first.negotiationId));
    expect(row).toMatchObject({ orgId: orgA, status: "open", ceilingApprovedBy: "hr_head" });
    expect(Number(row!.expectedCtc)).toBe(9_000_000);
    negotiation1 = first.negotiationId;
  }, 20_000);

  test("sendNegotiationMessage: too short refuses; the approved message goes out once", async () => {
    await expect(
      neg.sendNegotiationMessage(orgA, negotiation1, "too short", { userId: hrA, actor: hrEmail }),
    ).rejects.toThrow("The message is too short to send.");
    const message =
      "We can offer eight million with a joining bonus of two lakhs, and a salary review after six months. Let us know if this works for you.";
    const out = await neg.sendNegotiationMessage(orgA, negotiation1, message, {
      userId: hrA,
      actor: hrEmail,
    });
    expect(out.sent).toBe(true);
    const [row] = await db
      .select()
      .from(offerNegotiations)
      .where(eq(offerNegotiations.id, negotiation1));
    expect(row!.status).toBe("message_sent");
    expect(row!.token).toMatch(/^[a-f0-9]{64}$/);
    const [mail] = await db
      .select({ templateData: emailOutbox.templateData })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.orgId, orgA), eq(emailOutbox.kind, "offer_negotiation")));
    expect(String((mail!.templateData as { responseUrl: string }).responseUrl)).toMatch(
      /\/negotiate\/[a-f0-9]{64}$/,
    );
    await expect(
      neg.sendNegotiationMessage(orgA, negotiation1, `${message} A second send is refused.`, {
        userId: hrA,
        actor: hrEmail,
      }),
    ).rejects.toThrow(/nothing to send/);
  }, 20_000);

  test("publicNegotiationView: the token shows the proposal; a wrong token refuses", async () => {
    const [row] = await db
      .select({ token: offerNegotiations.token })
      .from(offerNegotiations)
      .where(eq(offerNegotiations.id, negotiation1));
    const view = await neg.publicNegotiationView(row!.token!);
    expect(view).toMatchObject({
      status: "open",
      candidateName: "Meera Iyer",
      proposedCtc: 8_000_000,
    });
    expect(view!.message).toContain("joining bonus");
    await expect(neg.publicNegotiationView(`wrong-${stamp}`)).rejects.toThrow(
      "This link is not valid.",
    );
  });

  test("answerNegotiation: the candidate accepts once; a second answer refuses", async () => {
    const [row] = await db
      .select({ token: offerNegotiations.token })
      .from(offerNegotiations)
      .where(eq(offerNegotiations.id, negotiation1));
    await expect(neg.answerNegotiation(row!.token!, { decision: "accept" })).resolves.toEqual({
      ok: true,
    });
    const [after] = await db
      .select()
      .from(offerNegotiations)
      .where(eq(offerNegotiations.id, negotiation1));
    expect(after!.status).toBe("agreed");
    expect(after!.outcome).toMatchObject({ agreedCtc: 8_000_000, source: "candidate_link" });
    await expect(neg.answerNegotiation(row!.token!, { decision: "accept" })).rejects.toThrow(
      "You have already answered. Thank you.",
    );
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "negotiation.answered")));
    expect(audits.length).toBe(1);
  }, 20_000);

  test("recordNegotiationOutcome: role, ceiling and state gates", async () => {
    // a second, still-open discussion to record a call against
    const runId = await run();
    await answered(runId, "hr_head");
    const second = await neg.prepareNegotiation(
      { orgId: orgA, runId, actor: "offer-agent", principalUserId: hrA },
      {
        applicationId: appA,
        ceiling: 8_500_000,
        proposedCtc: 8_100_000,
        levers: {},
        talkTrack: "x".repeat(40),
        message: "y".repeat(80),
      },
    );
    negotiation2 = second.negotiationId;
    await expect(
      neg.recordNegotiationOutcome(asHm(), negotiation2, { agreed: true, agreedCtc: 8_000_000 }),
    ).rejects.toThrow(/Only TA, the HR head or the CBO/);
    await expect(
      neg.recordNegotiationOutcome(asHr(), negotiation2, { agreed: true, agreedCtc: 9_000_000 }),
    ).rejects.toThrow(/above the approved ceiling/);
    await expect(
      neg.recordNegotiationOutcome(asHr(), negotiation1, { agreed: true, agreedCtc: 8_000_000 }),
    ).rejects.toThrow(/already agreed/);
  }, 20_000);

  test("org isolation: another org cannot record an outcome on this discussion", async () => {
    await expect(
      neg.recordNegotiationOutcome(
        { orgId: orgB, userId: hrB, memberEmail: `hrb@${dom}` },
        negotiation2,
        { agreed: true, agreedCtc: 8_000_000 },
      ),
    ).rejects.toThrow("That pay discussion is not here.");
  });

  test("happy: a call's agreed figure is recorded and becomes what the Offer agent may draft", async () => {
    const out = await neg.recordNegotiationOutcome(asHr(), negotiation2, {
      agreed: true,
      agreedCtc: 8_200_000,
      joiningDate: "2027-05-01",
    });
    expect(out).toMatchObject({ ok: true, status: "agreed" });
    const terms = await neg.agreedTerms(orgA, appA);
    expect(terms).toMatchObject({
      agreedCtc: 8_200_000,
      ceiling: 8_500_000,
      cboApproved: false,
      joiningDate: "2027-05-01",
    });
    expect(await neg.agreedTerms(orgB, appA)).toBeNull();
  }, 20_000);

  test("runNegotiationSweep expires an unanswered link past its closing date", async () => {
    const runId = await run();
    await answered(runId, "hr_head");
    const third = await neg.prepareNegotiation(
      { orgId: orgA, runId, actor: "offer-agent", principalUserId: hrA },
      {
        applicationId: appA,
        ceiling: 8_500_000,
        proposedCtc: 8_000_000,
        levers: {},
        talkTrack: "x".repeat(40),
        message: "y".repeat(80),
      },
    );
    await neg.sendNegotiationMessage(
      orgA,
      third.negotiationId,
      "We can offer eight million with a joining bonus of two lakhs, and a salary review after six months. Let us know if this works for you.",
      { userId: hrA, actor: hrEmail },
    );
    await db
      .update(offerNegotiations)
      .set({ closesAt: new Date(Date.now() - 1000) })
      .where(eq(offerNegotiations.id, third.negotiationId));
    const expired = await neg.runNegotiationSweep(orgA);
    expect(expired).toBe(1);
    const [row] = await db
      .select({ status: offerNegotiations.status })
      .from(offerNegotiations)
      .where(eq(offerNegotiations.id, third.negotiationId));
    expect(row!.status).toBe("expired");
  }, 20_000);

  test("negotiationOverdue waits one day past the due date, only while a message is out", () => {
    const now = new Date("2026-10-13T10:00:00Z");
    expect(
      neg.negotiationOverdue(
        { status: "message_sent", dueAt: new Date("2026-10-12T09:00:00Z") },
        now,
      ),
    ).toBe(true);
    expect(
      neg.negotiationOverdue(
        { status: "message_sent", dueAt: new Date("2026-10-13T09:00:00Z") },
        now,
      ),
    ).toBe(false);
    expect(
      neg.negotiationOverdue({ status: "open", dueAt: new Date("2026-10-01T09:00:00Z") }, now),
    ).toBe(false);
  });

  afterAll(async () => {
    await db.delete(offerNegotiations).where(eq(offerNegotiations.orgId, orgA));
    await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgA));
  });
});

/* --------------------------------------------- salary benchmark / market (AI) */

describe("salary-benchmark + market — the vendor-neutral no-key refusals", () => {
  test("benchmarkInputKey is deterministic and reacts to every input", () => {
    const a = { title: "AI Lead", location: "Bengaluru", experienceMin: 6, experienceMax: 9 };
    expect(bench.benchmarkInputKey(a)).toBe(bench.benchmarkInputKey({ ...a }));
    expect(bench.benchmarkInputKey(a)).not.toBe(bench.benchmarkInputKey({ ...a, title: "CEO" }));
    expect(bench.benchmarkInputKey(a)).not.toBe(
      bench.benchmarkInputKey({ ...a, experienceMax: 10 }),
    );
    // the cache key ignores letter case and padding
    expect(bench.benchmarkInputKey(a)).toBe(
      bench.benchmarkInputKey({
        title: "  ai lead ",
        location: " bengaluru ",
        experienceMin: 6,
        experienceMax: 9,
      }),
    );
  });

  test("researchSalaryBenchmark refuses, vendor-neutral, with no organisation key", async () => {
    await expect(
      bench.researchSalaryBenchmark(
        {
          title: "AI Lead",
          location: "Bengaluru",
          experienceMin: 6,
          experienceMax: 9,
          currency: "INR",
        },
        undefined,
        orgA,
      ),
    ).rejects.toThrow("No AI model key saved. Add one on the Integrations page.");
  });

  test("benchmarkMarket refuses, vendor-neutral, with no organisation key", async () => {
    await expect(
      market.benchmarkMarket({
        orgId: orgA,
        role: "AI Lead",
        location: "Bengaluru",
        currency: "INR",
        experienceMin: 6,
        experienceMax: 9,
        skills: ["LLMs"],
      }),
    ).rejects.toThrow("No AI model key saved. Add one on the Integrations page.");
  }, 60_000);
});

/* ------------------------------------------------------- comp knowledge */

describe("comp-knowledge.server — the organisation's own figures", () => {
  test("roleKey slugs a title", () => {
    expect(knowledge.roleKey("  AI Lead (Platform) ")).toBe("ai-lead-platform");
  });

  test("happy: saved figures are read back for the role, newest first", async () => {
    await db.insert(compKnowledge).values([
      {
        orgId: orgA,
        roleKey: knowledge.roleKey("AI Lead"),
        title: "AI Lead",
        levelKey: "senior",
        median: "9000000",
        low: "8000000",
        high: "10000000",
        source: "user_override",
        createdBy: hrA,
      },
      {
        orgId: orgA,
        roleKey: knowledge.roleKey("AI Lead"),
        title: "AI Lead",
        levelKey: "lead",
        median: "11000000",
        source: "user_override",
        createdBy: hrA,
      },
    ] as never);
    const mine = await knowledge.readRoleKnowledge(orgA, "AI Lead");
    expect(mine.length).toBe(2);
    expect(Number(mine[0]!.median)).toBe(11_000_000);
    expect(await knowledge.readRoleKnowledge(orgA, "Head of AI")).toEqual([]);
    expect((await knowledge.readOrgKnowledge(orgA)).length).toBe(2);
  });

  test("org isolation: another org reads none of them", async () => {
    expect(await knowledge.readRoleKnowledge(orgB, "AI Lead")).toEqual([]);
    expect(await knowledge.readOrgKnowledge(orgB, 60)).toEqual([]);
  });
});

/* --------------------------------------------------------- pay conventions */

describe("pay-settings.server — conventions, rates and requisition terms", () => {
  let draftId = "";

  test("currentConventions reads the organisation's conventions in force", async () => {
    const c = await paySettings.currentConventions(orgA);
    expect(c.reportingCurrency).toBe("INR");
    expect(c.zones.map((z) => z.name)).toContain(`Zone A ${stamp}`);
    await expect(paySettings.currentConventions(crypto.randomUUID())).rejects.toThrow(
      "Organisation not found.",
    );
  });

  test("proposeConventionsCore stores a pending draft; nothing to change refuses", async () => {
    const current = await paySettings.currentConventions(orgA);
    const proposed = await paySettings.proposeConventionsCore(orgA, {
      ...current,
      farAbovePct: 25,
    });
    expect(proposed.changes.join(" ")).toMatch(/25%/);
    draftId = proposed.draftId;
    await expect(paySettings.proposeConventionsCore(orgA, { ...current })).rejects.toThrow(
      "Nothing would change",
    );
  }, 20_000);

  test("pendingConventions is org-scoped: another org's draft is invisible", async () => {
    expect(await paySettings.pendingConventions(orgB, draftId)).toBeNull();
    expect(await paySettings.pendingConventions(orgA, draftId)).not.toBeNull();
  });

  test("decideConventionsCore: role gate, note gate, then a send-back lands", async () => {
    await expect(
      paySettings.decideConventionsCore(asHm(), { draftId, decision: "approve" }),
    ).rejects.toThrow(/Only the HR head, the CBO or an owner/);
    await expect(
      paySettings.decideConventionsCore(asHr(), { draftId, decision: "send_back" }),
    ).rejects.toThrow("Say what to change, or why it is declined.");
    const out = await paySettings.decideConventionsCore(asHr(), {
      draftId,
      decision: "send_back",
      note: "Keep the 20% tolerance for now.",
    });
    expect(out.status).toBe("sent_back");
    await expect(
      paySettings.decideConventionsCore(asHr(), { draftId, decision: "approve" }),
    ).rejects.toThrow(/not waiting for a decision/);
  }, 20_000);

  test("applyConventionsCore: role gate; a decider applies regions and zones in place", async () => {
    const current = await paySettings.currentConventions(orgA);
    await expect(paySettings.applyConventionsCore(asHm(), current)).rejects.toThrow(
      /Only the HR head, the CBO or an owner/,
    );
    const next = {
      ...current,
      regions: [...current.regions, { name: `Pool ${stamp}`, rule: "same_region" as const }],
    };
    const out = await paySettings.applyConventionsCore(asHr(), next);
    expect(out.changes.join(" ")).toContain(`Pool ${stamp}`);
    const [region] = await db
      .select()
      .from(poolingRegions)
      .where(and(eq(poolingRegions.orgId, orgA), eq(poolingRegions.name, `Pool ${stamp}`)));
    expect(region).toBeDefined();
  }, 20_000);

  test("addExchangeRateCore: role and validation gates; the happy rate is stored per org", async () => {
    await expect(
      paySettings.addExchangeRateCore(asHm(), {
        from: "USD",
        to: "INR",
        rate: 83.1,
        source: "test",
      }),
    ).rejects.toThrow(/Only the HR head, the CBO or an owner/);
    await expect(
      paySettings.addExchangeRateCore(asHr(), {
        from: "USDX",
        to: "INR",
        rate: 83,
        source: "test",
      }),
    ).rejects.toThrow("Give two different three-letter currency codes.");
    await expect(
      paySettings.addExchangeRateCore(asHr(), { from: "USD", to: "USD", rate: 1, source: "test" }),
    ).rejects.toThrow("Give two different three-letter currency codes.");
    await expect(
      paySettings.addExchangeRateCore(asHr(), { from: "USD", to: "INR", rate: 0, source: "test" }),
    ).rejects.toThrow("The rate must be above zero.");
    await expect(
      paySettings.addExchangeRateCore(asHr(), {
        from: "USD",
        to: "INR",
        rate: 83,
        source: "test",
        at: new Date(Date.now() + 7 * 86_400_000),
      }),
    ).rejects.toThrow("A rate cannot be dated in the future.");
    const added = await paySettings.addExchangeRateCore(asHr(), {
      from: "USD",
      to: "INR",
      rate: 83.1,
      source: "test-suite",
    });
    expect(added.id).toBeTruthy();
    const rates = await paySettings.ratesOf(orgA);
    expect(rates.at(-1)).toMatchObject({
      from: "USD",
      to: "INR",
      rate: 83.1,
      source: "test-suite",
    });
    expect(await paySettings.ratesOf(orgB)).toEqual([]);
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "exchange_rate.added")));
    expect(audits.length).toBe(1);
  }, 20_000);

  test("updateRequisitionPayTermsCore: drafts only, and the zone must exist", async () => {
    await expect(
      paySettings.updateRequisitionPayTermsCore(asHr(), { id: reqA, terms: { basis: "monthly" } }),
    ).rejects.toThrow(/Pay terms change only on a draft/);
    await expect(
      paySettings.updateRequisitionPayTermsCore(asHr(), {
        id: reqDraftA,
        zone: `No Such Zone ${stamp}`,
        terms: {},
      }),
    ).rejects.toThrow(/No pay zone called/);
    const out = await paySettings.updateRequisitionPayTermsCore(asHr(), {
      id: reqDraftA,
      zone: `Zone A ${stamp}`,
      terms: { kind: "permanent", basis: "annual", currency: "INR" },
    });
    expect(out.terms).toMatchObject({ kind: "permanent", basis: "annual", currency: "INR" });
    expect(out.zone).toBe(`Zone A ${stamp}`);
    const [r] = await db
      .select({ zoneId: requisitions.payZoneId })
      .from(requisitions)
      .where(eq(requisitions.id, reqDraftA));
    expect(r!.zoneId).toBe(zoneA);
  });

  test("conventionChanges names every difference for the approver", () => {
    const current = {
      reportingCurrency: "INR",
      payBasisDefault: "annual",
      hoursPerWeekDefault: 40,
      kindsOfWork: ["permanent"],
      farAbovePct: 20,
      regions: [],
      zones: [
        {
          name: "Z",
          countries: ["IN"],
          cities: [],
          currency: "INR",
          basis: "annual",
          paymentsPerYear: 12,
          includes: ["base"],
          hoursPerWeek: 40,
          workingDaysPerYear: 250,
          kinds: ["permanent"],
          contractTypes: [],
          entity: null,
          geoFactor: null,
          region: null,
        },
      ],
    } as never;
    const changes = paySettingsLib.conventionChanges(current, {
      ...current,
      farAbovePct: 30,
    } as never);
    expect(changes.join(" ")).toMatch(/30%/);
    expect(changes.join(" ")).toMatch(/Over a band's ceiling/);
  });

  afterAll(async () => {
    await db.delete(payConventionDrafts).where(eq(payConventionDrafts.orgId, orgA));
    await db.delete(exchangeRates).where(eq(exchangeRates.orgId, orgA));
    await db.delete(poolingRegions).where(eq(poolingRegions.orgId, orgA));
  });
});

/* ---------------------------------------------------------- pay context */

describe("pay-context.server", () => {
  test("termsOf parses a requisition's pay terms; contractEndOf ends the day before", async () => {
    const [r] = await db.select().from(requisitions).where(eq(requisitions.id, reqDraftA));
    expect(payCtx.termsOf(r!)).toMatchObject({
      kind: "permanent",
      basis: "annual",
      currency: "INR",
    });
    expect(payCtx.contractEndOf("2027-01-01", 12)).toBe("2027-12-31");
    expect(payCtx.contractEndOf("2027-01-01", null)).toBeNull();
  });

  test("placeOf resolves a free-text place to a zone, never guessing", async () => {
    const zones = (await paySettings.zonesOf(orgA)).map((z) => ({ ...z, region: null }));
    expect(payCtx.placeOf("Based in Bengaluru, open to relocate", zones)).toMatchObject({
      zone: `Zone A ${stamp}`,
    });
    expect(payCtx.placeOf("Relocating to Germany", zones)).toMatchObject({
      zone: `Zone B ${stamp}`,
    });
    expect(payCtx.placeOf("Somewhere else entirely", zones)).toBeNull();
    expect(payCtx.placeOf("", zones)).toBeNull();
  });

  test("offerTermsFor reads the role's terms; another org's application is not here", async () => {
    const terms = await payCtx.offerTermsFor(orgA, appA, "2027-03-01");
    expect(terms).toMatchObject({ currency: "INR", payBasis: "annual", kindOfWork: "permanent" });
    expect(terms.contractEnd).toBeNull();
    await expect(payCtx.offerTermsFor(orgA, appB, null)).rejects.toThrow("Application not found");
  });

  test("lockOfferRate: another org's offer is a no-op; our own INR offer locks at itself", async () => {
    const fresh = await draftOffer({ letter: false });
    await payCtx.lockOfferRate(orgB, fresh);
    const [untouched] = await db
      .select({ locked: offers.rateLockedAt })
      .from(offers)
      .where(eq(offers.id, fresh));
    expect(untouched!.locked).toBeNull();
    await payCtx.lockOfferRate(orgA, fresh);
    const [locked] = await db
      .select({
        reporting: offers.reportingAmount,
        locked: offers.rateLockedAt,
        currency: offers.reportingCurrency,
      })
      .from(offers)
      .where(eq(offers.id, fresh));
    expect(locked!.locked).not.toBeNull();
    expect(Number(locked!.reporting)).toBe(9_000_000);
    expect(locked!.currency).toBe("INR");
    await db.delete(offers).where(eq(offers.id, fresh));
  }, 20_000);

  test("recordPayFigures stores figures as said and derives them — or records why not", async () => {
    await payCtx.recordPayFigures(
      orgA,
      { id: appA, candidateId: candA, requisitionId: reqA },
      [
        {
          figure: "expected",
          money: payTermsLib.Money.parse({
            amount: 9_000_000,
            currency: "INR",
            basis: "annual",
            gross: true,
          }),
        },
      ],
      "screening_call",
    );
    const rows = await db
      .select()
      .from(payFigures)
      .where(and(eq(payFigures.orgId, orgA), eq(payFigures.figure, "expected")));
    expect(Number(rows.at(-1)!.payAmount)).toBe(9_000_000);
    expect(Number(rows.at(-1)!.reportingAmount)).toBe(9_000_000);
    // No rate on record for USD → INR: refused, never guessed.
    await payCtx.recordPayFigures(
      orgA,
      { id: appA, candidateId: candA, requisitionId: reqA },
      [
        {
          figure: "current_fixed",
          money: payTermsLib.Money.parse({
            amount: 100_000,
            currency: "USD",
            basis: "annual",
            gross: true,
          }),
        },
      ],
      "screening_call",
    );
    const refused = await db
      .select()
      .from(payFigures)
      .where(and(eq(payFigures.orgId, orgA), eq(payFigures.figure, "current_fixed")));
    expect(refused.at(-1)!.refusal).toBe("no_rate");
    expect(refused.at(-1)!.payAmount).toBeNull();
    // A foreign requisition is silently ignored (the caller checked org first).
    await payCtx.recordPayFigures(
      orgA,
      { id: appB, candidateId: candB, requisitionId: reqB },
      [
        {
          figure: "expected",
          money: payTermsLib.Money.parse({
            amount: 1,
            currency: "INR",
            basis: "annual",
            gross: true,
          }),
        },
      ],
      "screening_call",
    );
    const foreign = await db
      .select({ id: payFigures.id })
      .from(payFigures)
      .where(and(eq(payFigures.orgId, orgA), eq(payFigures.ownerId, appB)));
    expect(foreign.length).toBe(0);
  }, 20_000);

  afterAll(async () => {
    await db.delete(payFigures).where(eq(payFigures.orgId, orgA));
  });
});

/* ------------------------------------------------- the converter and pay terms */

describe("pay-convert + pay-terms — the only converter, pure", () => {
  const now = new Date("2026-11-24T00:00:00Z");
  const fresh = (rate: number) => ({
    from: "USD",
    to: "INR",
    rate,
    source: "test",
    at: new Date(now.getTime() - 86_400_000).toISOString(),
  });
  const c = { hoursPerWeek: 40, workingDaysPerYear: 250, paymentsPerYear: 12 };
  const annual = (amount: number, currency = "INR", extra = {}) =>
    payTermsLib.Money.parse({ amount, currency, basis: "annual", gross: true, ...extra } as never);

  test("conventionsOf: the role's own hours win over the zone default", () => {
    expect(
      payConvert.conventionsOf(
        { hoursPerWeek: 20, daysPerWeek: 5 },
        { hoursPerWeek: 40, workingDaysPerYear: 250, paymentsPerYear: 12 },
      ),
    ).toMatchObject({ hoursPerWeek: 20 });
    expect(payConvert.conventionsOf(null, null)).toEqual({
      hoursPerWeek: null,
      workingDaysPerYear: null,
      paymentsPerYear: null,
    });
  });

  test("no guesses: net figures, unknown hours/payments and missing rates are refused", () => {
    expect(
      payConvert.convert(
        annual(1, "INR", { gross: false }),
        { currency: "INR", basis: "annual" },
        c,
        [],
        now,
      ),
    ).toMatchObject({ ok: false, refusal: "net_figure" });
    expect(
      payConvert.convert(
        payTermsLib.Money.parse({ amount: 1, currency: "INR", basis: "hourly", gross: true }),
        { currency: "INR", basis: "annual" },
        { hoursPerWeek: null, workingDaysPerYear: null, paymentsPerYear: null },
        [],
        now,
      ),
    ).toMatchObject({ ok: false, refusal: "hours_unknown" });
    expect(
      payConvert.convert(
        payTermsLib.Money.parse({ amount: 1, currency: "INR", basis: "monthly", gross: true }),
        { currency: "INR", basis: "annual" },
        { hoursPerWeek: 40, workingDaysPerYear: 250, paymentsPerYear: null },
        [],
        now,
      ),
    ).toMatchObject({ ok: false, refusal: "payments_unknown" });
    expect(
      payConvert.convert(annual(100_000, "USD"), { currency: "INR", basis: "annual" }, c, [], now),
    ).toMatchObject({ ok: false, refusal: "no_rate" });
    const stale = { from: "USD", to: "INR", rate: 80, source: "s", at: "2026-01-01T00:00:00Z" };
    expect(
      payConvert.convert(
        annual(100_000, "USD"),
        { currency: "INR", basis: "annual" },
        c,
        [stale],
        now,
      ),
    ).toMatchObject({ ok: false, refusal: "stale_rate" });
  });

  test("convert derives, never edits the original, and carries the rate", () => {
    const m = annual(9_000_000);
    const out = payConvert.convert(m, { currency: "INR", basis: "annual" }, c, [], now);
    expect(out).toMatchObject({ ok: true });
    expect(out.ok && out.money.amount).toBe(9_000_000);
    expect(out.ok && out.rate).toBeNull();
    expect(m.amount).toBe(9_000_000);
    const usd = payConvert.convert(
      annual(100_000, "USD"),
      { currency: "INR", basis: "annual" },
      c,
      [fresh(83)],
      now,
    );
    expect(usd.ok && usd.money.amount).toBe(8_300_000);
    expect(usd.ok && usd.notes.join(" ")).toContain("83 INR per USD");
    // inverse rates work
    const inverse = { from: "INR", to: "USD", rate: 1 / 83, source: "s", at: fresh(83).at };
    const viaInverse = payConvert.convert(
      annual(100_000, "USD"),
      { currency: "INR", basis: "annual" },
      c,
      [inverse],
      now,
    );
    expect(viaInverse.ok && viaInverse.money.amount).toBe(8_300_000);
  });

  test("rateFor picks the freshest rate (either direction) within its validity", () => {
    expect(payConvert.rateFor([], "USD", "USD", now)).toMatchObject({ rate: 1 });
    expect(
      payConvert.rateFor(
        [fresh(83), { ...fresh(82), at: new Date(now.getTime() - 2 * 86_400_000).toISOString() }],
        "USD",
        "INR",
        now,
      ),
    ).toMatchObject({ rate: 83 });
    const volatile = {
      from: "USD",
      to: "ARS",
      rate: 1000,
      source: "s",
      at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    };
    expect(payConvert.rateFor([volatile], "USD", "ARS", now)).toBe("stale_rate");
  });

  test("checkAgainstBand compares in the role's pay currency; mismatched kinds refuse", () => {
    const terms = payTermsLib.PayTerms.parse({
      kind: "permanent",
      basis: "annual",
      currency: "INR",
    });
    const zone = {
      id: "z",
      name: "Z",
      countries: ["IN"],
      cities: [],
      currency: "INR",
      basis: "annual" as const,
      paymentsPerYear: 12,
      includes: ["base"],
      hoursPerWeek: 40,
      workingDaysPerYear: 250,
      kinds: ["permanent"],
      contractTypes: [],
      entity: null,
      geoFactor: null,
    };
    const base = {
      terms,
      zone,
      band: { min: 7_000_000, max: 10_500_000 },
      rates: [],
      reportingCurrency: "INR",
      now,
    };
    expect(payConvert.checkAgainstBand({ ...base, figure: annual(9_000_000) })).toMatchObject({
      comparable: true,
      position: "inside",
    });
    expect(payConvert.checkAgainstBand({ ...base, figure: annual(14_000_000) })).toMatchObject({
      position: "far_above",
    });
    expect(payConvert.checkAgainstBand({ ...base, figure: annual(6_000_000) })).toMatchObject({
      position: "below",
    });
    expect(
      payConvert.checkAgainstBand({
        ...base,
        figure: annual(9_000_000),
        figureKind: "contract_hourly",
      }),
    ).toMatchObject({ comparable: false, refusal: "different_kind_of_work" });
    const usdCheck = payConvert.checkAgainstBand({
      ...base,
      figure: annual(100_000, "USD"),
      rates: [fresh(83)],
    });
    expect(usdCheck.comparable).toBe(true);
    expect(usdCheck.flags.join(" ")).toContain("the role pays in INR");
  });

  test("hikePct only compares like with like", () => {
    expect(payConvert.hikePct(annual(7_000_000), annual(9_000_000), c, [], now)).toBeCloseTo(28.6);
    expect(payConvert.hikePct(annual(100_000, "USD"), annual(9_000_000, "INR"), c, [], now)).toBe(
      "no_rate",
    );
    expect(
      payConvert.hikePct(annual(100_000, "USD"), annual(9_000_000, "INR"), c, [fresh(83)], now),
    ).toBeCloseTo(8.4);
  });

  test("spokenMoney and parseAmounts speak and read pay", () => {
    expect(payConvert.spokenMoney({ amount: 18_500_000, currency: "INR", basis: "annual" })).toBe(
      "1 crore 85 lakh rupees a year",
    );
    expect(payConvert.spokenMoney({ amount: 90_000, currency: "GBP", basis: "annual" })).toBe(
      "90 thousand pounds a year",
    );
    expect(payConvert.spokenMoney({ amount: 65.5, currency: "USD", basis: "hourly" })).toBe(
      "65.50 dollars an hour",
    );
    expect(payConvert.parseAmounts("expecting 95 lakhs to 1 crore, INR CTC")).toEqual({
      amounts: [9_500_000, 10_000_000],
      currency: "INR",
      basis: "annual",
    });
    expect(payConvert.parseAmounts("about €52k per year")).toMatchObject({
      amounts: [52_000],
      currency: "EUR",
      basis: "annual",
    });
    expect(payConvert.parseAmounts("65 an hour")).toMatchObject({
      amounts: [65],
      basis: "hourly",
      currency: null,
    });
  });

  test("zoneFor: a city match wins, then a country-wide zone, else null", () => {
    const zones = [
      { name: "Karnataka", countries: ["IN"], cities: ["Bengaluru"] },
      { name: "Germany", countries: ["DE"], cities: [] },
    ] as never[];
    expect(payTermsLib.zoneFor(zones, { country: "IN", city: "Bengaluru" })).toMatchObject({
      name: "Karnataka",
    });
    expect(payTermsLib.zoneFor(zones, { country: "DE" })).toMatchObject({ name: "Germany" });
    expect(payTermsLib.zoneFor(zones, { country: "IN", city: "Chennai" })).toBeNull();
    expect(payTermsLib.zoneFor(zones, { country: null })).toBeNull();
  });

  test("callPayWords asks pay in the role's own words", () => {
    expect(
      payTermsLib.callPayWords({
        kind: "permanent",
        basis: "annual",
        currency: "INR",
        contractMonths: null,
      }),
    ).toMatchObject({ term: "CTC per year", currencyName: "rupees", contract: false });
    expect(
      payTermsLib.callPayWords({
        kind: "fixed_term",
        basis: "monthly",
        currency: "EUR",
        contractMonths: 12,
      }),
    ).toMatchObject({ term: "gross monthly salary", contract: true, contractMonths: 12 });
    expect(
      payTermsLib.callPayWords({
        kind: "contract_hourly",
        basis: "hourly",
        currency: "USD",
        contractMonths: null,
      }),
    ).toMatchObject({ term: "hourly rate", contract: true });
  });

  test("defaultPayTerms backfills to INR annual permanent", () => {
    expect(payTermsLib.defaultPayTerms("USD")).toMatchObject({ currency: "USD", basis: "annual" });
    expect(payTermsLib.defaultPayTerms(null)).toMatchObject({ currency: "INR", basis: "annual" });
  });
});

/* ------------------------------------------------------- labour policy sources */

describe("labour-policy.server — sources are an org-scoped, role-gated allow-list", () => {
  test("seedsFor lists each official source once per country", () => {
    const seeds = labour.seedsFor([
      { id: zoneA, countries: ["IN"] },
      { id: zoneB, countries: ["DE", "IN"] },
    ]);
    expect(seeds.length).toBe(4); // 3 IN + 1 DE, IN deduped across zones
    expect(new Set(seeds.map((s) => s.country))).toEqual(new Set(["IN", "DE"]));
  });

  test("pure helpers", () => {
    // hostnames, as the reader passes them
    expect(labour.sameSite("WWW.Example.com", "example.com")).toBe(true);
    expect(labour.sameSite("a.com", "b.com")).toBe(false);
    expect(labour.newLines("old line\nshared\n", "shared\nnew line one\nnew line two")).toEqual([
      "new line one",
      "new line two",
    ]);
    expect(labour.readableChars("hello 123")).toBe(5);
    expect(labour.readableChars("1234 <>()/")).toBe(0);
    expect(labour.siteApiOf("https://example.com/x")).toBeNull();
    expect(
      labour.siteApiOf(
        "https://www.labour.gov.in/offerings/circulars/details/labour-codes-gzNzQzMtQWa",
      ),
    ).toMatchObject({ kind: "labour_gov_in", type: "circulars" });
  });

  test("role: a hiring manager cannot change the source list", async () => {
    await expect(
      labour.seedSourcesCore({ orgId: orgA, userId: hmA, memberEmail: `hm@${dom}` }),
    ).rejects.toThrow(/Only the HR head, the CBO or an owner/);
    await expect(
      labour.addSourceCore(asHm(), { url: "https://example.com/feed", label: "Example" }),
    ).rejects.toThrow(/Only the HR head, the CBO or an owner/);
    const mine = await labour.listSources(orgA);
    if (mine.length)
      await expect(
        labour.setSourceActiveCore(asHm(), { id: mine[0]!.id, active: false }),
      ).rejects.toThrow(/Only the HR head, the CBO or an owner/);
  });

  test("happy: seeding lands the official sources for the org's zones, idempotently", async () => {
    const first = await labour.seedSourcesCore({ orgId: orgA, userId: hrA, memberEmail: hrEmail });
    expect(first.added).toBe(4); // the IN zone's three seeds + the DE zone's one
    const again = await labour.seedSourcesCore({ orgId: orgA, userId: hrA, memberEmail: hrEmail });
    expect(again.added).toBe(0);
    const sources = await labour.listSources(orgA);
    expect(sources.filter((s) => s.seeded).length).toBe(4);
    expect(sources.every((s) => s.active)).toBe(true);
  }, 20_000);

  test("addSourceCore: label and level gates; a duplicate is refused", async () => {
    await expect(
      labour.addSourceCore(asHr(), { url: "https://example.com/feed", label: "x" }),
    ).rejects.toThrow("Name the source.");
    await expect(
      labour.addSourceCore(asHr(), {
        url: "https://example.com/feed",
        label: "Example",
        level: "galaxy",
      }),
    ).rejects.toThrow("Unknown source level.");
    const added = await labour.addSourceCore(asHr(), {
      url: `https://labour.example-${stamp}.gov/feed`,
      label: "Example labour notices",
      country: "in",
    });
    expect(added.id).toBeTruthy();
    await expect(
      labour.addSourceCore(asHr(), {
        url: `https://labour.example-${stamp}.gov/feed`,
        label: "Example labour notices again",
      }),
    ).rejects.toThrow("That source is already on the list.");
    const mine = await labour.listSources(orgA);
    expect(mine.find((s) => s.id === added.id)).toMatchObject({ country: "IN", active: true });
  });

  test("org isolation: another org cannot see, pause or read this org's sources", async () => {
    const mine = await labour.listSources(orgA);
    expect((await labour.listSources(orgB)).length).toBe(0);
    await expect(
      labour.setSourceActiveCore(
        { orgId: orgB, userId: hrB, memberEmail: `hrb@${dom}` },
        { id: mine[0]!.id, active: false },
      ),
    ).rejects.toThrow("Source not found.");
    await expect(labour.readSourceCore(orgB, mine[0]!.id)).rejects.toThrow("Source not found.");
  });

  test("readSourceCore: a paused source refuses; a first read stores the page, no diff yet", async () => {
    const mine = await labour.listSources(orgA);
    const source = mine.find((s) => !s.seeded)!;
    await labour.setSourceActiveCore(asHr(), { id: source.id, active: false });
    await expect(labour.readSourceCore(orgA, source.id)).rejects.toThrow("This source is paused.");
    await labour.setSourceActiveCore(asHr(), { id: source.id, active: true });
    const longPage = Array.from(
      { length: 30 },
      (_, i) => `Notice line number ${i} with words`,
    ).join("\n");
    const first = await labour.readSourceCore(orgA, source.id, {
      fetchText: async () => longPage,
      now: new Date(),
    });
    expect(first).toMatchObject({ status: "first", newText: "" });
    const reads = await db
      .select({ status: policyReads.status })
      .from(policyReads)
      .where(and(eq(policyReads.orgId, orgA), eq(policyReads.sourceId, source.id)));
    expect(reads.length).toBe(1);
    // an unchanged page costs nothing new
    const second = await labour.readSourceCore(orgA, source.id, {
      fetchText: async () => longPage,
      now: new Date(Date.now() + 86_400_000),
    });
    expect(second).toMatchObject({ status: "unchanged", newText: "" });
  }, 20_000);

  afterAll(async () => {
    await db.delete(policyReads).where(eq(policyReads.orgId, orgA));
  });
});
