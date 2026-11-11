/**
 * Pay terms, Phase 2 — the organisation's pay conventions and a requisition's
 * pay terms (docs/pay-terms-plan.md). Database-backed.
 *
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/pay-settings.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  applications,
  auditLog,
  candidates,
  organizations,
  offers,
  payFigures,
  orgMembers,
  payConventionDrafts,
  payZones,
  poolingRegions,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const pay = await import("../src/lib/pay-settings.server");

let orgId: string;
let owner: string, hr: string, recruiter: string;
const stamp = Date.now();
const who = (userId: string) => ({ orgId, userId, memberEmail: `${userId}@x.local` });

const ITALY_AND_INDIA = {
  reportingCurrency: "USD",
  farAbovePct: 15,
  kindsOfWork: ["permanent", "fixed_term", "contract_hourly"],
  regions: [
    { name: "South Europe", rule: "same_region" },
    { name: "India", rule: "same_zone" },
  ],
  zones: [
    {
      name: "Milan",
      countries: ["IT"],
      cities: ["Milan", "Milano"],
      currency: "EUR",
      paymentsPerYear: 14,
      includes: ["base", "thirteenth_month", "fourteenth_month"],
      kinds: ["permanent", "fixed_term"],
      region: "South Europe",
    },
    {
      name: "India",
      countries: ["IN"],
      currency: "INR",
      hoursPerWeek: 45,
      includes: ["base", "variable", "employer_pf", "gratuity"],
      kinds: ["permanent", "contract_hourly"],
      region: "India",
    },
  ],
};

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const mk = async (tag: string) =>
    (
      await db
        .insert(users)
        .values({ email: `ps-${tag}-${stamp}@test.local` })
        .returning({ id: users.id })
    )[0]!.id;
  [owner, hr, recruiter] = [await mk("owner"), await mk("hr"), await mk("recruiter")];
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Pay Settings Org", slug: `ps-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  for (const [u, isOwner, role] of [
    [owner, true, null],
    [hr, false, "hr_head"],
    [recruiter, false, "recruiter"],
  ] as const) {
    await db.insert(orgMembers).values({
      orgId,
      userId: u,
      email: `${u}@x.local`,
      status: "active",
      isOwner,
    } as never);
    if (role) await db.insert(userRoles).values({ userId: u, orgId, role });
  }
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const u of [owner, hr, recruiter]) await db.delete(users).where(eq(users.id, u));
});

const audits = (action: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)));

describe("pay conventions", () => {
  test("a proposal changes nothing until the HR head approves; then it is applied and audited", async () => {
    const { draftId, changes } = await pay.proposeConventionsCore(orgId, ITALY_AND_INDIA, {
      agentRunId: null,
      proposedBy: hr,
    });
    expect(changes).toContain("Reporting currency: INR → USD");
    expect(changes.some((c) => c.startsWith("New zone — Milan (IT — Milan, Milano): EUR"))).toBe(
      true,
    );
    // Nothing applied yet.
    expect((await pay.currentConventions(orgId)).zones).toHaveLength(0);
    expect((await audits("pay_conventions.proposed")).length).toBe(1);

    // A recruiter cannot decide; sending back needs a reason.
    await expect(
      pay.decideConventionsCore(who(recruiter), { draftId, decision: "approve" }),
    ).rejects.toThrow(/Only the HR head/);
    await expect(
      pay.decideConventionsCore(who(hr), { draftId, decision: "send_back" }),
    ).rejects.toThrow(/Say what to change/);

    const out = await pay.decideConventionsCore(who(hr), { draftId, decision: "approve" });
    expect(out.status).toBe("approved");
    const now = await pay.currentConventions(orgId);
    expect(now.reportingCurrency).toBe("USD");
    expect(now.farAbovePct).toBe(15);
    expect(now.zones.map((z) => [z.name, z.currency, z.paymentsPerYear, z.region])).toEqual([
      ["India", "INR", 12, "India"],
      ["Milan", "EUR", 14, "South Europe"],
    ]);
    expect((await audits("pay_conventions.applied"))[0]!.detail).toMatchObject({ draftId });
    // A decided proposal cannot be decided again.
    await expect(
      pay.decideConventionsCore(who(hr), { draftId, decision: "approve" }),
    ).rejects.toThrow(/not waiting/);
  });

  test("the same conventions again change nothing; invalid ones are refused", async () => {
    await expect(pay.proposeConventionsCore(orgId, ITALY_AND_INDIA)).rejects.toThrow(
      /Nothing would change/,
    );
    await expect(
      pay.proposeConventionsCore(orgId, {
        ...ITALY_AND_INDIA,
        zones: [
          ...ITALY_AND_INDIA.zones,
          { name: "Rest of Italy", countries: ["IT"], currency: "EUR" },
          { name: "Italy", countries: ["IT"], currency: "EUR" },
        ],
      }),
    ).rejects.toThrow(/IT is covered by both/);
    await expect(
      pay.proposeConventionsCore(orgId, { ...ITALY_AND_INDIA, reportingCurrency: "dollars" }),
    ).rejects.toThrow();
  });

  test("a newer proposal supersedes a pending one; a renamed-away zone is removed", async () => {
    const first = await pay.proposeConventionsCore(orgId, { ...ITALY_AND_INDIA, farAbovePct: 25 });
    const second = await pay.proposeConventionsCore(orgId, {
      ...ITALY_AND_INDIA,
      zones: ITALY_AND_INDIA.zones.filter((z) => z.name !== "India"),
      regions: ITALY_AND_INDIA.regions.filter((r) => r.name !== "India"),
    });
    const [old] = await db
      .select({ status: payConventionDrafts.status })
      .from(payConventionDrafts)
      .where(eq(payConventionDrafts.id, first.draftId));
    expect(old!.status).toBe("superseded");
    expect(second.changes).toContain("Zone removed — India");
    await pay.decideConventionsCore(who(owner), { draftId: second.draftId, decision: "approve" });
    const zones = await db.select().from(payZones).where(eq(payZones.orgId, orgId));
    expect(zones.map((z) => z.name)).toEqual(["Milan"]);
    const regions = await db.select().from(poolingRegions).where(eq(poolingRegions.orgId, orgId));
    expect(regions.map((r) => r.name)).toEqual(["South Europe"]);
    // Put India back for the requisition tests.
    await pay.applyConventionsCore(who(hr), ITALY_AND_INDIA);
  });

  test("exchange rates: deciders only, dated, audited", async () => {
    await expect(
      pay.addExchangeRateCore(who(recruiter), {
        from: "EUR",
        to: "USD",
        rate: 1.08,
        source: "finance",
      }),
    ).rejects.toThrow(/Only the HR head/);
    await expect(
      pay.addExchangeRateCore(who(hr), { from: "EUR", to: "EUR", rate: 1, source: "finance" }),
    ).rejects.toThrow(/two different/);
    await pay.addExchangeRateCore(who(hr), {
      from: "eur",
      to: "usd",
      rate: 1.08,
      source: "Finance table",
    });
    const rates = await pay.ratesOf(orgId);
    expect(rates[0]).toMatchObject({ from: "EUR", to: "USD", rate: 1.08, source: "Finance table" });
    expect((await audits("exchange_rate.added")).length).toBe(1);
  });
});

describe("a requisition's pay terms", () => {
  async function draft(status = "draft") {
    const [r] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-PS-${Math.random().toString(36).slice(2, 7)}`,
        title: "Data Engineer",
        status,
        location: "Milan",
      } as never)
      .returning();
    return r!;
  }

  test("the zone sets the currency; a contract needs its length; audited", async () => {
    const r = await draft();
    const out = await pay.updateRequisitionPayTermsCore(who(recruiter), {
      id: r.id,
      zone: "milan",
      terms: { kind: "permanent", neededBy: "2027-02-01" },
    });
    expect(out).toMatchObject({ zone: "Milan", terms: { currency: "EUR", basis: "annual" } });
    const [after] = await db.select().from(requisitions).where(eq(requisitions.id, r.id));
    expect(after).toMatchObject({
      payCurrency: "EUR",
      kindOfWork: "permanent",
      neededBy: "2027-02-01",
    });
    expect((await audits("requisition.pay_terms_set")).length).toBeGreaterThan(0);
    await expect(
      pay.updateRequisitionPayTermsCore(who(recruiter), {
        id: r.id,
        terms: { kind: "fixed_term" },
      }),
    ).rejects.toThrow(/length in months/);
    const contract = await pay.updateRequisitionPayTermsCore(who(recruiter), {
      id: r.id,
      terms: { kind: "fixed_term", contractMonths: 12, extendable: true },
    });
    expect(contract.terms).toMatchObject({ kind: "fixed_term", contractMonths: 12 });
  });

  test("refused: an unknown zone, a kind the zone does not hire, a past date, a role in approval", async () => {
    const r = await draft();
    await expect(
      pay.updateRequisitionPayTermsCore(who(recruiter), { id: r.id, zone: "Paris", terms: {} }),
    ).rejects.toThrow(/No pay zone called “Paris”. Zones: (India, Milan|Milan, India)/);
    await expect(
      pay.updateRequisitionPayTermsCore(who(recruiter), {
        id: r.id,
        zone: "Milan",
        terms: { kind: "contract_hourly", contractMonths: 6 },
      }),
    ).rejects.toThrow(/Milan does not hire contract hourly/);
    await expect(
      pay.updateRequisitionPayTermsCore(who(recruiter), {
        id: r.id,
        terms: { neededBy: "2020-01-01" },
      }),
    ).rejects.toThrow(/in the past/);
    const inApproval = await draft("pending_hr");
    await expect(
      pay.updateRequisitionPayTermsCore(who(recruiter), {
        id: inApproval.id,
        zone: "Milan",
        terms: {},
      }),
    ).rejects.toThrow(/only on a draft/);
  });
});

describe("the call's figures reach matching (Phase 3)", () => {
  test("€52k said on a Milan call is kept as said, derived to USD, and read back with the pool", async () => {
    const [req] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-PS-${Math.random().toString(36).slice(2, 7)}`,
        title: "Data Engineer",
        status: "draft",
        location: "Milan",
      } as never)
      .returning();
    await pay.updateRequisitionPayTermsCore(who(hr), {
      id: req!.id,
      zone: "Milan",
      terms: { neededBy: "2027-02-01" },
    });
    const [cand] = await db
      .insert(candidates)
      .values({
        orgId,
        fullName: "Giulia Rossi",
        email: `giulia-${Math.random().toString(36).slice(2, 7)}@cand.local`,
        location: "Bengaluru, India",
      } as never)
      .returning({ id: candidates.id });
    const [app] = await db
      .insert(applications)
      .values({
        orgId,
        requisitionId: req!.id,
        candidateId: cand!.id,
        stage: "shortlisted",
      } as never)
      .returning({ id: applications.id });

    const { recordCallDetails } = await import("../src/lib/compensation.server");
    await recordCallDetails(orgId, app!.id, {
      expectedCtc: 52_000,
      earliestJoining: "2027-03-01",
      currentLocation: "Milano",
      currency: "EUR",
      payBasis: "annual",
      note: "€52k RAL",
    });
    const [fig] = await db
      .select()
      .from(payFigures)
      .where(and(eq(payFigures.orgId, orgId), eq(payFigures.ownerId, app!.id)));
    expect(fig).toMatchObject({
      figure: "expected",
      currency: "EUR",
      payBasis: "annual",
      payCurrency: "EUR",
      reportingCurrency: "USD",
      source: "screening_call",
      candidateId: cand!.id,
    });
    expect(Number(fig!.amount)).toBe(52_000);
    expect(Number(fig!.reportingAmount)).toBeCloseTo(56_160, 0); // the EUR→USD rate entered above

    const { roleLogistics, candidateLogistics } = await import("../src/lib/pay-context.server");
    const [r] = await db.select().from(requisitions).where(eq(requisitions.id, req!.id));
    const role = await roleLogistics(orgId, r!);
    expect(role.constraints.pool).toEqual({
      rule: "same_region",
      zone: "Milan",
      region: "South Europe",
    });
    const stated = await candidateLogistics(orgId, app!.id, "Bengaluru, India", role.ctx);
    // The call's place (Milano) is newer than the CV's (Bengaluru).
    expect(stated.place).toEqual({ zone: "Milan", region: "South Europe" });
    expect(stated.earliestJoining).toBe("2027-03-01");
    expect(stated.expectedPay).toMatchObject({ amount: 52_000, currency: "EUR" });

    const { logisticsCheck, JOIN_AFTER_NEEDED_BLOCKER } = await import("../src/lib/logistics");
    const check = logisticsCheck(stated, {
      ctcBandMin: 45_000,
      ctcBandMax: 60_000,
      ...role.constraints,
    });
    expect(check.blockers).toHaveLength(1);
    expect(check.blockers[0]).toStartWith(JOIN_AFTER_NEEDED_BLOCKER);
  });
});

describe("offers in the role's terms (Phase 4)", () => {
  async function contractApplication() {
    const [req] = await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-PS-${Math.random().toString(36).slice(2, 7)}`,
        title: "Data Engineer",
        status: "draft",
        location: "Milan",
      } as never)
      .returning();
    await pay.updateRequisitionPayTermsCore(who(hr), {
      id: req!.id,
      zone: "Milan",
      terms: { kind: "fixed_term", contractMonths: 12 },
    });
    const [cand] = await db
      .insert(candidates)
      .values({
        orgId,
        fullName: "Luca Bianchi",
        email: `luca-${Math.random().toString(36).slice(2, 7)}@cand.local`,
      } as never)
      .returning({ id: candidates.id });
    const [app] = await db
      .insert(applications)
      .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: "shortlisted" } as never)
      .returning({ id: applications.id });
    return app!.id;
  }

  test("an offer takes its currency, basis, kind and contract end from the role", async () => {
    const appId = await contractApplication();
    const { createOfferCore } = await import("../src/lib/offers.functions");
    const { id } = await createOfferCore(
      who(hr),
      { applicationId: appId, offeredCtc: "52000", joiningDate: "2027-01-01" },
      "draft",
    );
    const [o] = await db.select().from(offers).where(eq(offers.id, id));
    expect(o).toMatchObject({
      currency: "EUR",
      payBasis: "annual",
      kindOfWork: "fixed_term",
      contractEnd: "2027-12-31",
      rateLockedAt: null,
    });

    // Approval fixes the rate: €52k at the EUR→USD rate entered earlier.
    const { lockOfferRate } = await import("../src/lib/pay-context.server");
    await lockOfferRate(orgId, id);
    const [locked] = await db.select().from(offers).where(eq(offers.id, id));
    expect(locked!.reportingCurrency).toBe("USD");
    expect(Number(locked!.reportingAmount)).toBeCloseTo(56_160, 0);
    expect(locked!.rate).toMatchObject({ rate: 1.08, source: "Finance table" });
    // Fixed once: a later rate does not move it.
    await pay.addExchangeRateCore(who(hr), {
      from: "EUR",
      to: "USD",
      rate: 1.2,
      source: "Finance table",
    });
    await lockOfferRate(orgId, id);
    const [again] = await db.select().from(offers).where(eq(offers.id, id));
    expect(Number(again!.reportingAmount)).toBeCloseTo(56_160, 0);
  });

  test("no rate at approval: left out of reports, never guessed — and the health rule says so", async () => {
    const appId = await contractApplication();
    const [o] = await db
      .insert(offers)
      .values({
        orgId,
        applicationId: appId,
        offeredCtc: "9000000",
        currency: "JPY",
        status: "approved",
      } as never)
      .returning({ id: offers.id });
    const { lockOfferRate } = await import("../src/lib/pay-context.server");
    await lockOfferRate(orgId, o!.id);
    const [locked] = await db.select().from(offers).where(eq(offers.id, o!.id));
    expect(locked!.reportingAmount).toBeNull();
    expect(locked!.rateLockedAt).not.toBeNull();
    const { evaluateAgentHealth } = await import("../src/server/agents/health.server");
    const { agentIssues } = await import("../drizzle/schema");
    await evaluateAgentHealth({ orgId });
    const issues = await db.select().from(agentIssues).where(eq(agentIssues.orgId, orgId));
    expect(issues.find((i) => i.rule === "context.offer_not_in_reports")).toMatchObject({
      agentType: "offer",
      title: expect.stringContaining("JPY"),
    });
  });
});
