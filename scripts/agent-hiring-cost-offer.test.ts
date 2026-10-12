/**
 * Cost per candidate and the candidate's answer to an offer, against the
 * disposable database:
 *  - AI requests are attributed to the role / candidate they were made for
 *    (scope, agent-run subject, CV backfill); the role cost splits into shared
 *    work and each candidate's direct cost by stage; cost per hire at the
 *    organisation's rate;
 *  - a released offer carries a private link; accept / decline / ask for
 *    changes are recorded on the offer and the stage, once; a request for
 *    changes reaches the Offer agent, whose revision stays inside the band and
 *    goes back to draft as the next revision.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/agent-hiring-cost-offer.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentCostRates,
  agentEvents,
  agentPolicies,
  agentRuns,
  aiUsageEvents,
  applications,
  candidates,
  emailOutbox,
  hiringConversations,
  hiringMessages,
  offers,
  onboardingDocuments,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
const { recordAiUsage } = await import("../src/server/ai-usage");
const { withAiSubject } = await import("../src/server/agents/context");
const { roleCost, candidateCost } = await import("../src/server/agents/hiring-cost.server");
const { labelCvCost } = await import("../src/lib/intake.server");
const resp = await import("../src/lib/offer-response.server");
const offersLib = await import("../src/lib/offers.functions");
await import("../src/server/agents");
const { getTool } = await import("../src/server/agents/registry");

const stamp = Date.now();
let orgId: string;
let userId: string;
let role: string;
let appA: string;
let appB: string;
let candA: string;
const email = `hr-${stamp}@test.local`;

async function usage(feature: string, tokens: number) {
  await recordAiUsage({
    orgId,
    feature,
    provider: "test",
    model: "test",
    status: "ok",
    promptTokens: Math.round(tokens * 0.8),
    completionTokens: Math.round(tokens * 0.2),
    totalTokens: tokens,
  });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Cost Org", slug: `cost-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  await db
    .insert(orgMembers)
    .values({ orgId, userId, email, fullName: "Hema", status: "active", isOwner: true } as never);
  for (const r of ["hr_head", "president_cbo"])
    await db.insert(userRoles).values({ userId, orgId, role: r as never });
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-C-${stamp}`,
      title: "VP Product and AI",
      status: "approved",
      ctcBandMin: "7500000",
      ctcBandMax: "12500000",
      createdBy: userId,
    } as never)
    .returning({ id: requisitions.id });
  role = r!.id;
  const cand = async (name: string) =>
    (
      await db
        .insert(candidates)
        .values({ orgId, fullName: name, email: `${name.toLowerCase()}-${stamp}@cand.local` })
        .returning({ id: candidates.id })
    )[0]!.id;
  candA = await cand("Asha");
  const candB = await cand("Bala");
  appA = (
    await db
      .insert(applications)
      .values({ orgId, requisitionId: role, candidateId: candA, stage: "offer_released" })
      .returning({ id: applications.id })
  )[0]!.id;
  appB = (
    await db
      .insert(applications)
      .values({ orgId, requisitionId: role, candidateId: candB, stage: "ai_screened" })
      .returning({ id: applications.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await db.delete(aiUsageEvents).where(eq(aiUsageEvents.orgId, orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(offers).where(eq(offers.orgId, orgId));
  await db.delete(agentEvents).where(eq(agentEvents.orgId, orgId));
  await db.delete(emailOutbox).where(eq(emailOutbox.orgId, orgId));
  await db.delete(hiringConversations).where(eq(hiringConversations.orgId, orgId));
  await db.update(applications).set({ stage: "offer_released" }).where(eq(applications.id, appA));
});

/* ---------------------------------------------------------- cost per candidate */

describe("cost per candidate", () => {
  test("requests are attributed by scope, run subject and CV backfill; the role splits shared and direct", async () => {
    // Shared: the requisition and JD work for the role.
    await withAiSubject({ requisitionId: role }, async () => {
      await usage("agent_requisition", 10_000);
      await usage("jd_generate", 2_000);
    });
    // Asha: her CV read (labelled afterwards), scoring and screening by scope…
    const events: string[] = [];
    await withAiSubject({ requisitionId: role, events }, () => usage("resume_parse", 1_000));
    await labelCvCost(events, candA, role);
    await withAiSubject(
      { applicationId: appA, candidateId: candA, requisitionId: role },
      async () => {
        await usage("candidate_score", 3_000);
        await usage("assessment_generate", 500);
      },
    );
    // …and an agent run about her (the Offer agent) — every request in it counts.
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "offer",
        principalUserId: userId,
        goal: "g",
        subjectType: "application",
        subjectId: appA,
      })
      .returning({ id: agentRuns.id });
    await db.insert(aiUsageEvents).values({
      orgId,
      feature: "agent_offer",
      provider: "test",
      model: "test",
      status: "ok",
      promptTokens: 4_000,
      completionTokens: 1_000,
      totalTokens: 5_000,
      agentRunId: run!.id,
    });
    // Bala: scored only.
    await withAiSubject({ applicationId: appB, requisitionId: role }, () =>
      usage("candidate_score", 2_500),
    );

    const c = await roleCost(orgId, role);
    expect(c.total.tokens).toBe(24_000);
    expect(c.shared.tokens).toBe(12_000);
    expect(c.shared.byFeature.map((f) => f.feature)).toEqual(["agent_requisition", "jd_generate"]);
    const asha = c.candidates.find((x) => x.applicationId === appA)!;
    expect(asha.tokens).toBe(9_500);
    expect(asha.byStage.map((s) => [s.stage, s.tokens])).toEqual([
      ["Reading & checking the CV", 1_000],
      ["Matching", 3_000],
      ["Screening", 500],
      ["Offer", 5_000],
    ]);
    expect(c.candidates.find((x) => x.applicationId === appB)!.tokens).toBe(2_500);
    // No rate saved: tokens only; no hire yet: no cost per hire.
    expect(c.total.cost).toBeNull();
    expect(c.costPerHire).toBeNull();
  });

  test("cost per hire at the organisation's rate once someone is hired", async () => {
    await withAiSubject({ requisitionId: role }, () => usage("agent_requisition", 1_000_000));
    await db
      .insert(agentCostRates)
      .values({ orgId, currency: "USD", inputPerMillion: "2", outputPerMillion: "8" } as never)
      .onConflictDoNothing();
    await db.update(applications).set({ stage: "offer_accepted" }).where(eq(applications.id, appA));
    const c = await roleCost(orgId, role);
    expect(c.hires).toBe(1);
    // 800k input × $2/M + 200k output × $8/M = $3.20
    expect(c.total.cost).toBeCloseTo(3.2);
    expect(c.costPerHire!.tokens).toBe(1_000_000);
    const one = await candidateCost(orgId, appA);
    expect(one.role.candidates).toBe(2);
    await db.delete(agentCostRates).where(eq(agentCostRates.orgId, orgId));
  });
});

/* -------------------------------------------------------------- offer answers */

async function releasedOffer(ctc = 10_000_000) {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const [o] = await db
    .insert(offers)
    .values({
      orgId,
      applicationId: appA,
      offeredCtc: String(ctc),
      status: "released",
      responseToken: token,
      letter: { subject: "Offer", opening: "Dear Asha", sections: [{ heading: "Pay", body: "x" }] },
    } as never)
    .returning({ id: offers.id });
  return { offerId: o!.id, token };
}

describe("the candidate answers the offer", () => {
  test("release creates the private link and puts it in the email", async () => {
    const [o] = await db
      .insert(offers)
      .values({
        orgId,
        applicationId: appA,
        offeredCtc: "10000000",
        status: "approved",
        letter: {
          subject: "Offer",
          greeting: "Dear Asha",
          opening: "We are pleased to offer you the role.",
          sections: [{ heading: "Compensation", body: "Annual CTC as agreed." }],
          closing: "Welcome aboard.",
          version: 1,
          generatedAt: new Date().toISOString(),
          templateId: null,
          templateName: null,
          hasLogo: false,
          accentColor: "#4f46e5",
          boilerplate: null,
          headerLines: [],
          footerLines: [],
          refText: null,
          signatory: null,
          letterhead: { orgName: "Cost Org", legalName: null, hqCity: null, careersEmail: null },
          candidate: { fullName: "Asha", email: null, phone: null, location: null },
          role: { title: "VP Product and AI", location: null },
          ctc: "10000000",
          joiningDate: null,
        },
      } as never)
      .returning({ id: offers.id });
    const { REQUIRED_DOC_TYPES } = await import("../src/lib/onboarding.server");
    for (const t of REQUIRED_DOC_TYPES)
      await db.insert(onboardingDocuments).values({
        orgId,
        applicationId: appA,
        candidateId: candA,
        docType: t,
        fileName: `${t}.pdf`,
        status: "verified",
      } as never);
    await offersLib.advanceOfferCore(
      { orgId, userId, memberEmail: email },
      { id: o!.id, status: "released", applicationStage: "offer_released" },
    );
    const [row] = await db.select().from(offers).where(eq(offers.id, o!.id));
    expect(row!.responseToken).toMatch(/^[a-f0-9]{64}$/);
    const [mail] = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.kind, "offer_released")));
    expect((mail!.templateData as Record<string, string>)["respondUrl"]).toMatch(
      new RegExp(`/offer/${row!.responseToken}$`),
    );
    await db.delete(onboardingDocuments).where(eq(onboardingDocuments.orgId, orgId));
  });

  test("accept: recorded once on the offer and the stage; the thread is told", async () => {
    const [conv] = await db
      .insert(hiringConversations)
      .values({ orgId, createdBy: userId, requisitionId: role, status: "active" })
      .returning();
    const { offerId, token } = await releasedOffer();
    const view = (await resp.publicOfferView(token))!;
    expect(view).toMatchObject({
      jobTitle: "VP Product and AI",
      offeredCtc: 10_000_000,
      status: "released",
    });
    expect(JSON.stringify(view)).not.toMatch(/@/);
    expect(await resp.respondToOffer(token, { action: "accept" })).toEqual({
      ok: true,
      status: "accepted",
    });
    const [o] = await db.select().from(offers).where(eq(offers.id, offerId));
    expect(o!.status).toBe("accepted");
    const [a] = await db.select().from(applications).where(eq(applications.id, appA));
    expect(a!.stage).toBe("offer_accepted");
    expect(
      await resp.respondToOffer(token, { action: "decline", reason: "changed my mind" }),
    ).toMatchObject({
      ok: false,
    });
    const [msg] = await db
      .select()
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, conv!.id));
    expect(msg!.body).toMatch(/accepted the offer/);
  });

  test("decline: recorded with the reason", async () => {
    const { offerId, token } = await releasedOffer();
    await resp.respondToOffer(token, { action: "decline", reason: "Accepted another offer" });
    const [o] = await db.select().from(offers).where(eq(offers.id, offerId));
    expect(o!.status).toBe("declined");
    const [a] = await db.select().from(applications).where(eq(applications.id, appA));
    expect(a).toMatchObject({ stage: "offer_declined", stageReason: "Accepted another offer" });
  });

  test("ask for changes: countered → the Offer agent revises inside the band → next revision in draft", async () => {
    await db
      .insert(agentPolicies)
      .values({ orgId, agentType: "offer", enabled: true })
      .onConflictDoNothing();
    const { offerId, token } = await releasedOffer();
    await resp.respondToOffer(token, {
      action: "ask_changes",
      expectedCtc: 13_000_000,
      joiningDate: "2026-12-01",
      note: "Matching my current ESOP value",
    });
    const [o] = await db.select().from(offers).where(eq(offers.id, offerId));
    expect(o).toMatchObject({ status: "countered" });
    expect(o!.counter).toMatchObject({ expectedCtc: 13_000_000, joiningDate: "2026-12-01" });
    const { processAgentEvents } = await import("../src/server/agents/orchestrator.server");
    await processAgentEvents({ orgId });
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "offer")));
    expect(run).toMatchObject({ subjectType: "application", subjectId: appA });
    expect(run!.goal).toMatch(/asked for changes/);

    const tool = getTool("revise_offer")!;
    const ctx = { orgId, principalUserId: userId, runId: run!.id, agentType: "offer", actor: "t" };
    // Above the band (12.5M) is refused…
    await expect(
      tool.run(
        ctx as never,
        { offerId, offeredCtc: 13_000_000, rationale: "Meet the ask in full" } as never,
      ),
    ).rejects.toThrow(/outside the approved band/);
    // …the band maximum is the revision.
    const r = (await tool.run(
      ctx as never,
      {
        offerId,
        offeredCtc: 12_500_000,
        joiningDate: "2026-12-01",
        rationale: "Ask is above the band; offering the band maximum.",
      } as never,
    )) as { revision: number };
    expect(r.revision).toBe(2);
    const [rev] = await db.select().from(offers).where(eq(offers.id, offerId));
    expect(rev).toMatchObject({
      status: "draft",
      revision: 2,
      offeredCtc: "12500000.00",
      letter: null,
    });
    const last = (rev!.approvalTrail as { decision: string; previousCtc: number }[]).at(-1)!;
    expect(last).toMatchObject({ decision: "revised", previousCtc: 10_000_000 });
  });
});

/* ------------------------------------------- pre-onboarding document requests */

describe("pre-onboarding document requests", () => {
  test("never asks again for documents received or requested and not yet due", async () => {
    await db.delete(onboardingDocuments).where(eq(onboardingDocuments.orgId, orgId));
    const tool = getTool("request_documents")!;
    const [run] = await db
      .insert(agentRuns)
      .values({ orgId, agentType: "onboarding", principalUserId: userId, goal: "docs" } as never)
      .returning({ id: agentRuns.id });
    const ctx = {
      orgId,
      principalUserId: userId,
      runId: run!.id,
      agentType: "onboarding",
      actor: "t",
    };
    const ask = { applicationId: appA, documentTypes: ["id_proof", "payslip"], dueInDays: 5 };
    expect(await tool.precheck!(ctx as never, ask as never)).toBeNull();
    await tool.run(ctx as never, ask as never);

    // Asked a moment ago and not yet due: refused before anyone is asked.
    expect(await tool.precheck!(ctx as never, ask as never)).toMatch(
      /Already requested and not yet due.*id_proof, payslip/,
    );
    // A received document is never asked for again.
    await db.insert(onboardingDocuments).values({
      orgId,
      applicationId: appA,
      candidateId: candA,
      docType: "id_proof",
      fileName: "id.txt",
    } as never);
    expect(
      await tool.precheck!(ctx as never, { ...ask, documentTypes: ["id_proof"] } as never),
    ).toMatch(/Already received.*id_proof/);
    // Once the due date has passed, a reminder for what is still missing is allowed.
    const [mail] = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.kind, "document_request")));
    await db
      .update(emailOutbox)
      .set({
        templateData: {
          ...(mail!.templateData as object),
          dueDate: new Date(Date.now() - 3 * 864e5).toDateString(),
        },
      })
      .where(eq(emailOutbox.id, mail!.id));
    expect(
      await tool.precheck!(ctx as never, { ...ask, documentTypes: ["payslip"] } as never),
    ).toBeNull();
    // An approved request whose documents arrived meanwhile is not sent.
    await expect(
      tool.run(ctx as never, { ...ask, documentTypes: ["id_proof"] } as never),
    ).rejects.toThrow(/Already received/);
  });
});

test("onboarding_status names the offer a release request needs", async () => {
  const status = getTool("onboarding_status")!;
  const ctx = { orgId, principalUserId: userId, runId: "x", agentType: "onboarding", actor: "t" };
  const none = (await status.run(ctx as never, { applicationId: appA } as never)) as {
    offer: unknown;
  };
  expect(none.offer).toBeNull();
  const { offerId } = await releasedOffer(10_000_000);
  const r = (await status.run(ctx as never, { applicationId: appA } as never)) as {
    offer: { offerId: string; status: string; revision: number };
  };
  expect(r.offer).toEqual({ offerId, status: "released", revision: 1 });
});

test("the offer letter PDF uses jsPDF's named export (the default is not a constructor under Node)", async () => {
  // Production runs on Node, where "jspdf" resolves to its CommonJS build and
  // the default import is the module object — releases then sent no email.
  const src = await Bun.file(new URL("../src/lib/offer-letter-pdf.ts", import.meta.url)).text();
  expect(src).toMatch(/import \{ jsPDF \} from "jspdf"/);
  const { jsPDF } = await import("jspdf");
  expect(new jsPDF({ unit: "pt", format: "a4" }).output("arraybuffer").byteLength).toBeGreaterThan(
    0,
  );
});
