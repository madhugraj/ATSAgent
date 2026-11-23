/**
 * Labour law & policy L3 (docs/labour-policy-agent-plan.md): the offer check
 * before approval, the HR head's override, a stale check, and the approved
 * rules a screening call follows where the job is. Database-backed; the
 * checker's model is faked.
 *
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/offer-check.test.ts
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";

/** What the fake checker answers: a fix when the letter says "probation of 12 months". */
const realGateway = await import("../src/lib/ai-gateway.server");
let lastPrompt = "";
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiJson: async (opts: { feature: string; prompt?: string }) => {
    if (opts.feature !== "offer_policy_check")
      throw new Error(`unexpected AI call ${opts.feature}`);
    lastPrompt = opts.prompt ?? "";
    const p = JSON.parse(lastPrompt) as { rules: { id: string; area: string }[] };
    const tooLong = /probation of 12 months/i.test(lastPrompt);
    return {
      ok: true,
      data: {
        items: p.rules.map((r) =>
          r.area === "probation" && tooLong
            ? {
                check: "Probation length",
                verdict: "fix_needed",
                detail: "The letter sets 12 months of probation; the rule allows at most 6.",
                ruleId: r.id,
                suggestion: "Your probation period will be six months.",
              }
            : { check: r.area, verdict: "pass", detail: "Met.", ruleId: r.id, suggestion: null },
        ),
        suspected_prompt_injection: false,
      },
      model: "m",
      provider: "google",
      usage: null,
    };
  },
}));

const { db } = await import("../src/server/db");
const {
  applications,
  auditLog,
  candidates,
  offers,
  organizations,
  orgMembers,
  payZones,
  policyFindings,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const check = await import("../src/lib/offer-check.server");
const lp = await import("../src/lib/labour-policy.server");

let orgId: string, hr: string, recruiter: string, zoneId: string;
const stamp = Date.now();
const who = (userId: string) => ({ orgId, userId, memberEmail: `${userId}@x.local` });
const letter = (probation: string) => ({
  version: 1,
  generatedAt: new Date().toISOString(),
  subject: "Offer of employment",
  opening: "We are pleased to offer you the role.",
  sections: [
    { heading: "Compensation", body: "EUR 52,000 per annum." },
    { heading: "Probation", body: probation },
  ],
  closing: "Sincerely,",
});

async function rule(area: string, text: string) {
  const [f] = await db
    .insert(policyFindings)
    .values({
      orgId,
      zoneId,
      url: "https://www.lavoro.gov.it/notizie",
      quote: `${text} — quoted from the source page.`,
      area: area as never,
      summary: text,
      rule: text,
      status: "approved",
      decidedAt: new Date(),
    })
    .returning({ id: policyFindings.id });
  return f!.id;
}

async function offer(probation: string) {
  const [req] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-OC-${Math.random().toString(36).slice(2, 7)}`,
      title: "Engineer",
      status: "approved",
      payZoneId: zoneId,
      payCurrency: "EUR",
    } as never)
    .returning({ id: requisitions.id });
  const [cand] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Sara Conti", email: `s-${Math.random()}@cand.local` } as never)
    .returning({ id: candidates.id });
  const [app] = await db
    .insert(applications)
    .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: "shortlisted" } as never)
    .returning({ id: applications.id });
  const [o] = await db
    .insert(offers)
    .values({
      orgId,
      applicationId: app!.id,
      offeredCtc: "52000",
      currency: "EUR",
      joiningDate: "2027-02-01",
      letter: letter(probation),
    } as never)
    .returning({ id: offers.id });
  return o!.id;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const mk = async (tag: string) =>
    (
      await db
        .insert(users)
        .values({ email: `oc-${tag}-${stamp}@test.local` })
        .returning({ id: users.id })
    )[0]!.id;
  [hr, recruiter] = [await mk("hr"), await mk("recruiter")];
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Offer Check Org", slug: `oc-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  for (const [u, role] of [
    [hr, "hr_head"],
    [recruiter, "recruiter"],
  ] as const) {
    await db.insert(orgMembers).values({
      orgId,
      userId: u,
      email: `${u}@x.local`,
      status: "active",
      isOwner: false,
    } as never);
    await db.insert(userRoles).values({ userId: u, orgId, role });
  }
  zoneId = (
    await db
      .insert(payZones)
      .values({ orgId, name: "Italy", countries: ["IT"], currency: "EUR" })
      .returning({ id: payZones.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const u of [hr, recruiter]) await db.delete(users).where(eq(users.id, u));
});

describe("the offer check", () => {
  test("no approved rules for the place: needs counsel, no AI call, does not block", async () => {
    const id = await offer("Your probation period will be six months.");
    lastPrompt = "";
    const c = await check.runOfferCheckCore(orgId, id);
    expect(c.verdict).toBe("needs_counsel");
    expect(c.items[0]!.detail).toContain("no approved labour rules for Italy");
    expect(lastPrompt).toBe("");
    expect(await check.offerCheckBlock(orgId, id)).toBeNull();
  });

  test("a fix needed blocks approval; the letter goes to the checker as untrusted data", async () => {
    await rule("probation", "Probation in Italy may not exceed six months.");
    await rule("pay_transparency", "The offered pay must sit within the posted range.");
    const id = await offer("Your probation of 12 months starts on joining.");
    const block = await check.offerCheckBlock(orgId, id, { autoRun: true });
    expect(block).toContain("needs fixes first: Probation length");
    expect(lastPrompt).toContain('<untrusted_data label=\\"offer_letter\\">');
    const [o] = await db.select().from(offers).where(eq(offers.id, id));
    expect(o!.policyCheck).toMatchObject({ verdict: "fix_needed", zone: "Italy" });
    expect(o!.policyCheck!.items).toHaveLength(2);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "offer.policy_checked")));
    expect(audits.length).toBeGreaterThan(0);
    // The card says why.
    expect(check.checkWords(o!.policyCheck, null)).toContain("fixes needed on Probation length");
  });

  test("only the HR head overrides, with a reason, for that exact check", async () => {
    const id = await offer("Your probation of 12 months starts on joining.");
    await check.runOfferCheckCore(orgId, id);
    await expect(
      check.overrideOfferCheckCore(who(recruiter), {
        offerId: id,
        reason: "Agreed with legal team.",
      }),
    ).rejects.toThrow(/Only the HR head/);
    await expect(
      check.overrideOfferCheckCore(who(hr), { offerId: id, reason: "ok" }),
    ).rejects.toThrow(/Say why/);
    await check.overrideOfferCheckCore(who(hr), {
      offerId: id,
      reason: "Counsel confirmed the collective agreement allows it.",
    });
    expect(await check.offerCheckBlock(orgId, id)).toBeNull();
    // A new rule makes the check — and its override — stale.
    await rule("leave", "Paid leave is at least 26 days a year.");
    expect(await check.offerCheckBlock(orgId, id)).toContain("changed since the offer check");
    const { evaluateAgentHealth } = await import("../src/server/agents/health.server");
    const { agentIssues } = await import("../drizzle/schema");
    await evaluateAgentHealth({ orgId });
    const issues = await db.select().from(agentIssues).where(eq(agentIssues.orgId, orgId));
    expect(issues.find((i) => i.rule === "offer.policy_check_overridden")).toMatchObject({
      agentType: "offer",
      title: expect.stringContaining("Counsel confirmed"),
    });
  });

  test("a fixed letter passes", async () => {
    const id = await offer("Your probation period will be six months.");
    expect(await check.offerCheckBlock(orgId, id, { autoRun: true })).toBeNull();
    const [o] = await db.select().from(offers).where(eq(offers.id, id));
    expect(o!.policyCheck!.verdict).toBe("pass");
  });
});

describe("rules a screening call follows where the job is", () => {
  test("a salary-history ban is detected and current pay may be 'not allowed' — only then", async () => {
    expect(
      lp.PAY_HISTORY_BAN.test("Employers may not ask about an applicant's salary history."),
    ).toBe(true);
    expect(lp.PAY_HISTORY_BAN.test("Do not ask candidates their current pay.")).toBe(true);
    expect(lp.PAY_HISTORY_BAN.test("Probation may not exceed six months.")).toBe(false);
    expect((await lp.callRulesFor(orgId, zoneId)).payHistoryBanned).toBe(false);
    await rule("questions", "Never ask a candidate about their salary history or current pay.");
    const r = await lp.callRulesFor(orgId, zoneId);
    expect(r.payHistoryBanned).toBe(true);
    expect(r.lines).toContain("Never ask a candidate about their salary history or current pay.");

    const tools = await import("../src/server/voice/call-tools");
    const notAllowed = { not_given: [{ item: "current_pay", why: "not_allowed" }] };
    const free = { ...tools.freshCallState(), consent: true };
    expect(
      tools.applyCallTool(free as never, "record_details", notAllowed, new Set(), 0),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("No rule here forbids"),
    });
    const banned = { ...tools.freshCallState(), consent: true, payHistoryBanned: true };
    expect(
      tools.applyCallTool(banned as never, "record_details", notAllowed, new Set(), 0),
    ).toMatchObject({
      ok: true,
    });
    expect(tools.requiredDetailStatus(banned.details as never).current_pay).toBe("not_allowed");
    expect(tools.mandatoryMissing(banned.details as never)).not.toContain("current_pay");

    const { callSystemPrompt } = await import("../src/server/voice/call-prompt");
    const p = callSystemPrompt({
      assistantName: "Saranya",
      orgName: "Acme",
      roleTitle: "Engineer",
      roleCode: "REQ-1",
      place: "Milan",
      forClient: false,
      roleSummary: null,
      responsibilities: [],
      appliedVia: null,
      appliedOn: null,
      booked: false,
      reschedulesLeft: 2,
      contactEmail: null,
      candidateFirstName: "Sara",
      cv: { currentCompany: null, experienceYears: null, location: null },
      strengths: [],
      known: { notice: false, currentPay: false, expectedPay: false },
      emailDomain: null,
      questions: [],
      maxMinutes: 3,
      nextSteps: "the hiring team will be in touch",
      callingHours: "Monday to Friday, 09:00 to 18:00",
      placeRules: r.lines,
      payHistoryBanned: true,
    } as never);
    expect(p).toContain("Rules where this job is (approved by the HR head");
    expect(p).toContain("Never ask their current or past pay");
    expect(p).not.toContain('"What is your current CTC per year?"');
  });
});
