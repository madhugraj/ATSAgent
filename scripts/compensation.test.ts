/**
 * Pay & availability before an offer, against the disposable database:
 *  - field-by-field merge (a later partial entry never erases a known figure),
 *    profile fallback, joining-date and lakh parsing, the approval-card line;
 *  - the form: idempotent send, stage / email / emails-off refusals, one
 *    submission only (concurrent claims), closed links, consent required, the
 *    profile kept in step, audit without amounts, the thread told without amounts;
 *  - TA / HR entry: role-checked, closes the open form once complete;
 *  - org isolation: another organisation's application is never readable;
 *  - the Offer agent: no draft without expected CTC and notice (send the form,
 *    or wait if it is open); above the band the HR head is asked first; above
 *    the band is drafted only with the CBO's answer;
 *  - the sweep: reminders when allowed, a pop-up when not, overdue nudge, closing;
 *  - compensation.submitted continues the offer only for a selected candidate.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/compensation.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  agentPolicies,
  agentRuns,
  agentTasks,
  applications,
  auditLog,
  candidateNotes,
  candidates,
  compensationDetails,
  compensationRequests,
  emailOutbox,
  emailSettings,
  hiringConversations,
  hiringMessages,
  offers,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
await import("../src/server/agents");
const comp = await import("../src/lib/compensation.server");
const { lakhsToRupees } = await import("../src/lib/money");
const { expectationLine } = await import("../src/server/agents/runtime.server");
const { offerReadiness } = await import("../src/server/agents/tools-phase4");
const { getTool } = await import("../src/server/agents/registry");
const { processAgentEvents } = await import("../src/server/agents/orchestrator.server");

const stamp = Date.now();
let orgId: string;
let otherOrg: string;
let hr: string;
let cbo: string;
let viewer: string;
let role: string;
let appId: string;
let candId: string;
let convId: string;
let otherApp: string;
const hrEmail = `pay-ta-${stamp}@test.local`;
const asHr = () => ({ orgId, userId: hr, memberEmail: hrEmail });
const by = () => ({ userId: hr, memberEmail: hrEmail });

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const mk = async (email: string) =>
    (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
  hr = await mk(hrEmail);
  cbo = await mk(`pay-cbo-${stamp}@test.local`);
  viewer = await mk(`pay-viewer-${stamp}@test.local`);
  const mkOrg = async (slug: string) =>
    (
      await db
        .insert(organizations)
        .values({ name: "Pay Org", slug, status: "active" })
        .returning({ id: organizations.id })
    )[0]!.id;
  orgId = await mkOrg(`pay-${stamp}`);
  otherOrg = await mkOrg(`pay-other-${stamp}`);
  for (const [u, roles] of [
    [hr, ["recruiter", "hr_head"]],
    [cbo, ["president_cbo"]],
    [viewer, ["hiring_manager"]],
  ] as const) {
    await db.insert(orgMembers).values({
      orgId,
      userId: u,
      email: `${u}@x`,
      fullName: "M",
      status: "active",
      isOwner: false,
    } as never);
    for (const r of roles)
      await db.insert(userRoles).values({ userId: u, orgId, role: r as never });
  }
  const mkReq = async (o: string, code: string) =>
    (
      await db
        .insert(requisitions)
        .values({
          orgId: o,
          code,
          title: "AI Lead",
          status: "approved",
          createdBy: hr,
          ctcBandMin: "7000000",
          ctcBandMax: "10500000",
          budgetCtc: "8500000",
        } as never)
        .returning({ id: requisitions.id })
    )[0]!.id;
  role = await mkReq(orgId, `REQ-P-${stamp}`);
  const otherRole = await mkReq(otherOrg, `REQ-PO-${stamp}`);
  candId = (
    await db
      .insert(candidates)
      .values({ orgId, fullName: "Meera Iyer", email: `pay-meera-${stamp}@cand.local` })
      .returning({ id: candidates.id })
  )[0]!.id;
  const otherCand = (
    await db
      .insert(candidates)
      .values({ orgId: otherOrg, fullName: "Other", email: `pay-o-${stamp}@cand.local` })
      .returning({ id: candidates.id })
  )[0]!.id;
  appId = (
    await db
      .insert(applications)
      .values({ orgId, requisitionId: role, candidateId: candId, stage: "shortlisted" })
      .returning({ id: applications.id })
  )[0]!.id;
  otherApp = (
    await db
      .insert(applications)
      .values({
        orgId: otherOrg,
        requisitionId: otherRole,
        candidateId: otherCand,
        stage: "shortlisted",
      })
      .returning({ id: applications.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(organizations).where(eq(organizations.id, otherOrg));
  for (const u of [hr, cbo, viewer]) await db.delete(users).where(eq(users.id, u));
});

beforeEach(async () => {
  for (const t of [
    compensationDetails,
    compensationRequests,
    emailOutbox,
    emailSettings,
    hiringConversations,
    agentRuns,
    agentEvents,
    agentPolicies,
    offers,
    candidateNotes,
  ])
    await db.delete(t).where(eq((t as typeof emailOutbox).orgId, orgId));
  await db.update(applications).set({ stage: "shortlisted" }).where(eq(applications.id, appId));
  await db
    .update(candidates)
    .set({ currentCtc: null, expectedCtc: null, noticePeriodDays: null })
    .where(eq(candidates.id, candId));
  convId = (
    await db
      .insert(hiringConversations)
      .values({ orgId, createdBy: hr, requisitionId: role, status: "active" })
      .returning({ id: hiringConversations.id })
  )[0]!.id;
});

const messages = async () =>
  (
    await db
      .select()
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, convId))
      .orderBy(hiringMessages.createdAt)
  ).map((m) => m.body);
const requestRow = async (id: string) =>
  (await db.select().from(compensationRequests).where(eq(compensationRequests.id, id)))[0]!;
const form = (extra: Record<string, unknown> = {}) =>
  ({
    currentFixed: 6_000_000,
    currentVariable: 1_000_000,
    expectedCtc: 9_000_000,
    noticePeriodDays: 60,
    consent: true,
    ...extra,
  }) as never;
async function policy(agent: "screening" | "offer", level: "suggest" | "autonomous") {
  await db
    .insert(agentPolicies)
    .values({ orgId, agentType: agent, enabled: true, autonomy: level } as never)
    .onConflictDoUpdate({
      target: [agentPolicies.orgId, agentPolicies.agentType],
      set: { autonomy: level, enabled: true },
    });
}
async function run(agentType: "offer" | "screening" = "offer") {
  return (
    await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType,
        principalUserId: hr,
        goal: "g",
        status: "running",
        subjectType: "application",
        subjectId: appId,
      } as never)
      .returning({ id: agentRuns.id })
  )[0]!.id;
}
async function answered(runId: string, assigneeRole: "hr_head" | "president_cbo") {
  await db.insert(agentTasks).values({
    orgId,
    runId,
    kind: "clarification",
    status: "answered",
    title: "Above the band",
    assigneeRole,
    response: { answer: "ok" },
    decidedBy: assigneeRole === "hr_head" ? hr : cbo,
  } as never);
}

/* ------------------------------------------------------------ pure */

describe("pure", () => {
  const row = (at: number, f: Record<string, unknown>) =>
    ({
      createdAt: new Date(at),
      currentFixed: null,
      currentVariable: null,
      expectedCtc: null,
      noticePeriodDays: null,
      earliestJoining: null,
      competingOffers: null,
      competingNote: null,
      currentLocation: null,
      openToRelocate: null,
      note: null,
      source: "candidate_form",
      ...f,
    }) as never;
  const none = { currentCtc: null, expectedCtc: null, noticePeriodDays: null };

  test("a later partial entry keeps earlier figures; the latest value wins per field", () => {
    const v = comp.mergeCompensation(
      [
        row(1, { expectedCtc: "9000000", noticePeriodDays: 90, currentFixed: "6000000" }),
        row(2, { noticePeriodDays: 30, source: "screening_call" }),
      ],
      none,
    );
    expect(v).toMatchObject({
      expectedCtc: 9_000_000,
      noticePeriodDays: 30,
      currentTotal: 6_000_000,
      source: "candidate_form",
      complete: true,
    });
  });

  test("falls back to the profile; incomplete without notice", () => {
    expect(
      comp.mergeCompensation([], {
        currentCtc: "5000000",
        expectedCtc: "7000000",
        noticePeriodDays: null,
      }),
    ).toMatchObject({
      currentTotal: 5_000_000,
      expectedCtc: 7_000_000,
      source: "candidate_profile",
      complete: false,
    });
    expect(comp.mergeCompensation([], none)).toMatchObject({ source: null, complete: false });
    // Only on the profile (maybe an earlier process): complete, but not confirmed for this role.
    expect(
      comp.mergeCompensation([], {
        currentCtc: null,
        expectedCtc: "9000000",
        noticePeriodDays: 30,
      }),
    ).toMatchObject({ source: "candidate_profile", complete: true, unconfirmed: true });
  });

  test("joining date: not in the past, within a year", () => {
    const now = new Date("2026-10-13T10:00:00Z");
    expect(comp.joiningDateProblem("2026-11-02", now)).toBeNull();
    expect(comp.joiningDateProblem("2026-10-01", now)).toMatch(/past/);
    expect(comp.joiningDateProblem("2028-01-01", now)).toMatch(/within the next year/);
    expect(comp.joiningDateProblem("2026-02-31x", now)).toMatch(/not a real date/);
    expect(comp.joiningDateProblem(null, now)).toBeNull();
  });

  test("lakhs to rupees", () => {
    expect(lakhsToRupees("18.5")).toBe(1_850_000);
    expect(lakhsToRupees(" 1,05 ")).toBe(10_500_000);
    expect(lakhsToRupees("")).toBeNull();
    expect(lakhsToRupees("abc")).toBeNaN();
    expect(lakhsToRupees("-3")).toBeNaN();
  });

  test("the approval card states the expectation and the gap", () => {
    const pay = {
      expectedCtc: 10_000_000,
      currentTotal: 7_000_000,
      noticePeriodDays: 60,
      competingOffers: true,
      source: "candidate_form",
    };
    const below = expectationLine(8_500_000, pay);
    expect(below).toContain("expects ₹1,00,00,000 (from the candidate's form)");
    expect(below).toContain("₹15,00,000 (15%) below it");
    expect(below).toContain("21% change");
    expect(below).toContain("Notice period 60 days");
    expect(below).toContain("other offers in hand");
    expect(expectationLine(11_000_000, pay)).toContain("(10%) above it");
    expect(expectationLine(10_000_000, pay)).toContain("meets it exactly");
    expect(expectationLine(8_500_000, { ...pay, expectedCtc: null })).toMatch(
      /not on record — this offer was not checked/,
    );
  });
});

/* ------------------------------------------------------------ the form */

describe("the form", () => {
  test("sending is idempotent, emails once, and tells the thread without amounts", async () => {
    const a = await comp.requestCompensation(orgId, appId, by());
    expect(a).toMatchObject({ emailed: true, alreadyOpen: false });
    const b = await comp.requestCompensation(orgId, appId, by());
    expect(b).toMatchObject({ requestId: a.requestId, emailed: false, alreadyOpen: true });
    const mails = await db.select().from(emailOutbox).where(eq(emailOutbox.orgId, orgId));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      kind: "compensation_form",
      templateName: "compensation_form",
    });
    expect(String((mails[0]!.templateData as { formUrl: string }).formUrl)).toMatch(
      /\/pay\/[a-f0-9]{64}$/,
    );
    expect((await messages()).at(-1)).toMatch(/sent the pay & availability form \(due/);
  });

  test("refused outside screening-to-offer, without an email address, or with candidate emails off", async () => {
    await db.update(applications).set({ stage: "applied" }).where(eq(applications.id, appId));
    await expect(comp.requestCompensation(orgId, appId, by())).rejects.toThrow(
      /between screening and offer/,
    );
    await db.update(applications).set({ stage: "shortlisted" }).where(eq(applications.id, appId));
    await db.insert(emailSettings).values({ orgId, enabled: true, stageEnabled: false } as never);
    await expect(comp.requestCompensation(orgId, appId, by())).rejects.toThrow(
      /emails are turned off/,
    );
    expect(
      await db.select().from(compensationRequests).where(eq(compensationRequests.orgId, orgId)),
    ).toHaveLength(0);
  });

  test("another organisation's application is never readable or askable", async () => {
    await expect(comp.detailsFor(orgId, otherApp)).rejects.toThrow(/not found/);
    await expect(comp.requestCompensation(orgId, otherApp, by())).rejects.toThrow(/not found/);
    await expect(
      comp.recordCompensation(asHr(), otherApp, { expectedCtc: 1 }, "recruiter"),
    ).rejects.toThrow(/not found/);
  });

  test("submit once: details stored, profile in step, audited without amounts, event raised", async () => {
    const r = await comp.requestCompensation(orgId, appId, by());
    const { token } = await requestRow(r.requestId);
    const view = await comp.publicCompensationView(token);
    expect(view).toMatchObject({
      status: "sent",
      candidateName: "Meera Iyer",
      jobTitle: "AI Lead",
    });
    expect(JSON.stringify(view)).not.toMatch(/expected|Ctc|current/i);
    // Two submissions at once: exactly one wins.
    const results = await Promise.allSettled([
      comp.submitCompensation(token, form()),
      comp.submitCompensation(token, form({ expectedCtc: 1 })),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((x) => x.status === "rejected") as PromiseRejectedResult).reason.message,
    ).toMatch(/already sent/);
    const rows = await db
      .select()
      .from(compensationDetails)
      .where(eq(compensationDetails.applicationId, appId));
    expect(rows).toHaveLength(1);
    const d = await comp.detailsFor(orgId, appId);
    expect(d).toMatchObject({
      currentTotal: 7_000_000,
      noticePeriodDays: 60,
      complete: true,
      source: "candidate_form",
    });
    const [c] = await db.select().from(candidates).where(eq(candidates.id, candId));
    expect(c).toMatchObject({ noticePeriodDays: 60 });
    expect(Number(c!.currentCtc)).toBe(7_000_000);
    expect([9_000_000, 1]).toContain(Number(c!.expectedCtc));
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "compensation.submitted")));
    expect(audit!.actor).toBe(`candidate:${candId}`);
    expect(JSON.stringify(audit!.detail)).not.toMatch(/9000000|7000000/);
    expect((await messages()).at(-1)).toMatch(/shared their pay and availability/);
    expect((await messages()).join("\n")).not.toMatch(/₹|lakh|9000000/);
    const ev = await db.select().from(agentEvents).where(eq(agentEvents.orgId, orgId));
    expect(ev.map((e) => e.type)).toContain("compensation.submitted");
    // The link now only thanks them.
    expect(await comp.publicCompensationView(token)).toMatchObject({ status: "completed" });
  });

  test("closed, cancelled or unknown links take nothing; consent and amounts are checked", async () => {
    const r = await comp.requestCompensation(orgId, appId, by());
    const { token } = await requestRow(r.requestId);
    await expect(comp.submitCompensation(token, form({ consent: false }))).rejects.toThrow();
    await expect(comp.submitCompensation(token, form({ expectedCtc: 0 }))).rejects.toThrow();
    await expect(comp.submitCompensation(token, form({ noticePeriodDays: 400 }))).rejects.toThrow();
    await expect(
      comp.submitCompensation(token, form({ earliestJoining: "2020-01-01" })),
    ).rejects.toThrow(/past/);
    await db
      .update(compensationRequests)
      .set({ closesAt: new Date(Date.now() - 1000) })
      .where(eq(compensationRequests.id, r.requestId));
    await expect(comp.publicCompensationView(token)).rejects.toThrow(/closed/);
    await expect(comp.submitCompensation(token, form())).rejects.toThrow(/closed/);
    await expect(comp.submitCompensation("f".repeat(64), form())).rejects.toThrow(/not valid/);
    expect(
      await db.select().from(compensationDetails).where(eq(compensationDetails.orgId, orgId)),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ TA / HR entry */

describe("TA / HR entry", () => {
  test("only TA, HR head, CBO or owners; partial entries add up; the open form closes when complete", async () => {
    await expect(
      comp.recordCompensation(
        { orgId, userId: viewer, memberEmail: "v@x" },
        appId,
        { expectedCtc: 9_000_000 },
        "recruiter",
      ),
    ).rejects.toThrow(/Only TA/);
    await expect(comp.recordCompensation(asHr(), appId, {}, "recruiter")).rejects.toThrow(
      /at least one/,
    );
    const r = await comp.requestCompensation(orgId, appId, by());
    const first = await comp.recordCompensation(
      asHr(),
      appId,
      { expectedCtc: 9_500_000 },
      "screening_call",
    );
    expect(first.complete).toBe(false);
    expect((await requestRow(r.requestId)).status).toBe("sent");
    const second = await comp.recordCompensation(
      asHr(),
      appId,
      { noticePeriodDays: 45 },
      "screening_call",
    );
    expect(second.complete).toBe(true);
    expect((await requestRow(r.requestId)).status).toBe("cancelled");
    expect(await comp.detailsFor(orgId, appId)).toMatchObject({
      expectedCtc: 9_500_000,
      noticePeriodDays: 45,
      source: "screening_call",
    });
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "compensation.recorded")));
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits.map((a) => a.detail))).not.toMatch(/9500000/);
  });
});

/* ------------------------------------------------------------ the Offer agent */

describe("the Offer agent", () => {
  test("no draft without expected CTC and notice: send the form, or wait while it is open", async () => {
    const runId = await run();
    expect(await offerReadiness({ orgId, runId }, appId)).toMatch(
      /expected CTC and notice period are not known[\s\S]*send_compensation_form/,
    );
    await comp.requestCompensation(orgId, appId, by());
    expect(await offerReadiness({ orgId, runId }, appId)).toMatch(
      /already sent and is open — do not draft and do not send it again/,
    );
    const send = getTool("send_compensation_form")!;
    expect(
      await send.precheck!(
        { orgId, runId, principalUserId: hr, agentType: "offer", actor: "a" },
        {
          applicationId: appId,
        },
      ),
    ).toMatch(/already sent and is still open/);
  });

  test("within the band: go ahead; above it: the HR head first", async () => {
    const runId = await run();
    await comp.recordCompensation(
      asHr(),
      appId,
      { expectedCtc: 9_000_000, noticePeriodDays: 60 },
      "recruiter",
    );
    expect(await offerReadiness({ orgId, runId }, appId)).toBeNull();
    await comp.recordCompensation(asHr(), appId, { expectedCtc: 12_000_000 }, "recruiter");
    const msg = await offerReadiness({ orgId, runId }, appId);
    expect(msg).toContain("expects ₹1,20,00,000");
    expect(msg).toContain("₹15,00,000 (14%) above the band maximum ₹1,05,00,000");
    expect(msg).toMatch(/ask_human with assignee_role hr_head/);
    // Another run's answer does not count.
    await answered(await run(), "hr_head");
    expect(await offerReadiness({ orgId, runId }, appId)).not.toBeNull();
    await answered(runId, "hr_head");
    expect(await offerReadiness({ orgId, runId }, appId)).toBeNull();
    const send = getTool("send_compensation_form")!;
    expect(
      await send.precheck!(
        { orgId, runId, principalUserId: hr, agentType: "offer", actor: "a" },
        {
          applicationId: appId,
        },
      ),
    ).toMatch(/already known/);
  });

  test("a draft above the band needs the CBO's answer in this run", async () => {
    await db.update(applications).set({ stage: "offer_pending" }).where(eq(applications.id, appId));
    await comp.recordCompensation(
      asHr(),
      appId,
      { expectedCtc: 12_000_000, noticePeriodDays: 60 },
      "recruiter",
    );
    const runId = await run();
    await answered(runId, "hr_head");
    const draft = getTool("draft_offer")!;
    const ctx = {
      orgId,
      runId,
      principalUserId: hr,
      agentType: "offer" as const,
      actor: `agent:offer:${runId}`,
    };
    await expect(draft.run(ctx, { applicationId: appId, offeredCtc: 11_500_000 })).rejects.toThrow(
      /outside the approved band[\s\S]*CBO/,
    );
    await answered(runId, "president_cbo");
    const r = (await draft.run(ctx, { applicationId: appId, offeredCtc: 11_500_000 })) as {
      status: string;
    };
    expect(r.status).toBe("draft");
    // Below the band stays refused whoever answered.
    await db.delete(offers).where(eq(offers.orgId, orgId));
    await expect(draft.run(ctx, { applicationId: appId, offeredCtc: 5_000_000 })).rejects.toThrow(
      /outside the approved band/,
    );
  });

  test("answers continue the offer only for a selected candidate with no offer at approvers", async () => {
    await policy("offer", "suggest");
    await db.update(applications).set({ stage: "l3" }).where(eq(applications.id, appId));
    const emit = async () => {
      await db.insert(agentEvents).values({
        orgId,
        type: "compensation.submitted",
        subjectType: "application",
        subjectId: appId,
        payload: { applicationId: appId },
      } as never);
      await processAgentEvents({ orgId });
      return (await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId))).filter(
        (x) => x.agentType === "offer",
      );
    };
    // Not selected yet: nothing starts.
    expect(await emit()).toHaveLength(0);
    // Selected, offer already with the HR head: nothing starts.
    await db.insert(agentEvents).values({
      orgId,
      type: "hiring.selected",
      subjectType: "application",
      subjectId: appId,
      status: "done",
      payload: {},
    } as never);
    const [o] = await db
      .insert(offers)
      .values({ orgId, applicationId: appId, offeredCtc: "8500000", status: "pending_hr" } as never)
      .returning({ id: offers.id });
    expect(await emit()).toHaveLength(0);
    // Sent back to draft: the Offer agent continues.
    await db.update(offers).set({ status: "draft" }).where(eq(offers.id, o!.id));
    const runs = await emit();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.goal).toMatch(/shared their expected CTC and notice period/);
  });
});

/* ------------------------------------------------------------ settled terms */

describe("an offer moves only on settled terms", () => {
  const offersLib = () => import("../src/lib/offers.functions");
  async function offerAt(status: string, joiningDate: string | null) {
    const [o] = await db
      .insert(offers)
      .values({
        orgId,
        applicationId: appId,
        offeredCtc: "8500000",
        status,
        joiningDate,
        letter: { subject: "Offer" },
      } as never)
      .returning({ id: offers.id });
    return o!.id;
  }

  test("submit, HR head, CBO and release refuse without expected CTC, notice and joining date", async () => {
    await db.update(applications).set({ stage: "offer_pending" }).where(eq(applications.id, appId));
    const { advanceOfferCore } = await offersLib();
    const asCbo = { orgId, userId: cbo, memberEmail: "cbo@x" };
    const draft = await offerAt("draft", null);
    await expect(advanceOfferCore(asHr(), { id: draft, status: "pending_hr" })).rejects.toThrow(
      /cannot go for approval yet: the candidate's expected CTC, their notice period and a joining date on the offer are missing/,
    );
    const atHr = await offerAt("pending_hr", "2026-12-07");
    await expect(advanceOfferCore(asHr(), { id: atHr, status: "pending_cbo" })).rejects.toThrow(
      /cannot be approved yet: the candidate's expected CTC and their notice period are missing/,
    );
    // Known pay, still no joining date: the CBO cannot approve either.
    await comp.recordCompensation(
      asHr(),
      appId,
      { expectedCtc: 9_000_000, noticePeriodDays: 60 },
      "recruiter",
    );
    const atCbo = await offerAt("pending_cbo", null);
    await expect(advanceOfferCore(asCbo, { id: atCbo, status: "approved" })).rejects.toThrow(
      /cannot be approved yet: a joining date on the offer is missing/,
    );
    // Settled: it moves.
    await advanceOfferCore(asHr(), { id: atHr, status: "pending_cbo" });
    expect((await db.select().from(offers).where(eq(offers.id, atHr)))[0]!.status).toBe(
      "pending_cbo",
    );
    // Nothing moved for the refused ones.
    expect((await db.select().from(offers).where(eq(offers.id, draft)))[0]!.status).toBe("draft");
    expect((await db.select().from(offers).where(eq(offers.id, atCbo)))[0]!.status).toBe(
      "pending_cbo",
    );
  });

  test("an approved, unreleased offer can be sent back by the HR head only", async () => {
    const { sendBackOfferCore } = await offersLib();
    const approved = await offerAt("approved", null);
    await expect(
      sendBackOfferCore(
        { orgId, userId: cbo, memberEmail: "cbo@x" },
        { id: approved, reason: "Terms never agreed" },
      ),
    ).rejects.toThrow();
    await sendBackOfferCore(asHr(), {
      id: approved,
      reason: "Collect expected CTC, notice period and joining date first",
    });
    const [o] = await db.select().from(offers).where(eq(offers.id, approved));
    expect(o!.status).toBe("draft");
    expect((o!.approvalTrail as { decision: string; from: string }[]).at(-1)).toMatchObject({
      decision: "sent_back",
      from: "approved",
    });
    expect((await messages()).at(-1)).toMatch(/after its approval \(it was not released\)/);
    const released = await offerAt("released", "2026-12-07");
    await expect(
      sendBackOfferCore(asHr(), { id: released, reason: "Changed my mind" }),
    ).rejects.toThrow(/not waiting for an approval/);
  });

  test("pre-onboarding asks for no documents until the terms are settled", async () => {
    await offerAt("approved", null);
    const status = getTool("onboarding_status")!;
    const ctx = { orgId, runId: "r", principalUserId: hr, agentType: "onboarding", actor: "a" };
    const out = (await status.run(ctx as never, { applicationId: appId } as never)) as {
      termsMissing: string[];
    };
    expect(out.termsMissing).toEqual([
      "the candidate's expected CTC",
      "their notice period",
      "a joining date on the offer",
    ]);
    const ask = getTool("request_documents")!;
    expect(
      await ask.precheck!(
        ctx as never,
        { applicationId: appId, documentTypes: ["payslip"] } as never,
      ),
    ).toMatch(/terms are not settled[\s\S]*Do not request documents/);
  });
});

/* ------------------------------------------------------------ the sweep and nudges */

describe("sweep and nudges", () => {
  const DAY = 864e5;
  async function sentAt(at: Date) {
    const r = await comp.requestCompensation(orgId, appId, by(), at);
    return r.requestId;
  }

  test("a reminder waits for a person unless an agent may send the form on its own", async () => {
    // Mon 12 Oct 2026 10:00 IST; first reminder is due Wed 14 Oct.
    const sent = new Date("2026-10-12T04:30:00Z");
    const id = await sentAt(sent);
    const wed = new Date(sent.getTime() + 2 * DAY + 3600_000);
    await policy("screening", "suggest");
    expect(await comp.runCompensationSweep(orgId, wed)).toMatchObject({
      reminded: 0,
      reminderDue: 1,
    });
    const { payNudges } = await import("../src/lib/notifications.functions");
    const n = await payNudges(orgId, wed);
    expect(n.map((x) => x.id)).toEqual([`pay:remind:${id}:1`]);
    expect(JSON.stringify(n)).not.toMatch(/₹|lakh/);
    await policy("screening", "autonomous");
    expect(await comp.runCompensationSweep(orgId, wed)).toMatchObject({ reminded: 1 });
    expect((await requestRow(id)).remindersSent).toBe(1);
    expect(
      await comp.runCompensationSweep(orgId, new Date(wed.getTime() + 3600_000)),
    ).toMatchObject({
      reminded: 0,
    });
  });

  test("overdue raises a pop-up; the link closes and the thread is told", async () => {
    const sent = new Date("2026-10-12T04:30:00Z");
    const id = await sentAt(sent);
    const r = await requestRow(id);
    const overdue = new Date(r.dueAt!.getTime() + 2 * DAY + 60_000);
    expect(comp.payOverdue(r, 2, overdue)).toBe(true);
    expect(comp.payOverdue(r, 2, new Date(r.dueAt!.getTime()))).toBe(false);
    // Live: due three days ago, link still open → the overdue pop-up, with a reminder action.
    await db
      .update(compensationRequests)
      .set({ dueAt: new Date(Date.now() - 3 * DAY), closesAt: new Date(Date.now() + DAY) })
      .where(eq(compensationRequests.id, id));
    const { payNudges } = await import("../src/lib/notifications.functions");
    const n = await payNudges(orgId);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      id: `pay:overdue:${id}`,
      popup: true,
      actions: [{ id: "pay_remind" }],
      subject: { payRequestId: id, applicationId: appId },
    });
    await db
      .update(compensationRequests)
      .set({ dueAt: r.dueAt, closesAt: r.closesAt })
      .where(eq(compensationRequests.id, id));
    const closed = await comp.runCompensationSweep(orgId, new Date(r.closesAt!.getTime() + 1000));
    expect(closed.closed).toBe(1);
    expect((await requestRow(id)).status).toBe("expired");
    expect((await messages()).at(-1)).toMatch(/did not fill in the pay & availability form/);
  });
});
