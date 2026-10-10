/**
 * Duplicates, races and exceptions, against the disposable database:
 *  - the same document twice is not filed, read or announced again; a changed
 *    file, or a resend after HR rejected the first, is;
 *  - two approvers sending the same offer back: one wins, the other is told;
 *  - the release email goes once per revision, and a failure never throws;
 *  - the same event twice starts one agent run; a gate decided twice is refused;
 *  - a bad or used offer link is refused; a person without the role is refused;
 *  - hiring cost never counts another organisation's spend; nothing spent
 *    reads as zero, not as a made-up figure.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/agent-edge-cases.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";

process.env["LOCAL_STORAGE_DIR"] ??= mkdtempSync(path.join(tmpdir(), "atsiq-edge-"));

const { db } = await import("../src/server/db");
const {
  agentEvents,
  agentPolicies,
  agentRuns,
  agentTasks,
  aiUsageEvents,
  applications,
  candidates,
  emailOutbox,
  interviewSlotOffers,
  offers,
  onboardingDocuments,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
  users,
} = await import("../drizzle/schema");
await import("../src/server/agents");
const { processAgentEvents } = await import("../src/server/agents/orchestrator.server");
const { emitAgentEvent } = await import("../src/server/agents/events");
const offersLib = await import("../src/lib/offers.functions");
const { orgHiringCost, roleCost } = await import("../src/server/agents/hiring-cost.server");

const stamp = Date.now();
let orgId: string;
let otherOrg: string;
let hr: string;
let outsider: string;
let role: string;
let appId: string;
let candId: string;
const hrEmail = `hr-${stamp}@test.local`;
const outsiderEmail = `rec-${stamp}@test.local`;
const asHr = () => ({ orgId, userId: hr, memberEmail: hrEmail });

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const mkUser = async (email: string) =>
    (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
  hr = await mkUser(hrEmail);
  outsider = await mkUser(outsiderEmail);
  const mkOrg = async (slug: string) =>
    (
      await db
        .insert(organizations)
        .values({ name: slug, slug, status: "active" })
        .returning({ id: organizations.id })
    )[0]!.id;
  orgId = await mkOrg(`edge-${stamp}`);
  otherOrg = await mkOrg(`edge-other-${stamp}`);
  for (const [u, email, roles] of [
    [hr, hrEmail, ["hr_head", "president_cbo", "recruiter"]],
    [outsider, outsiderEmail, ["recruiter"]],
  ] as const) {
    await db.insert(orgMembers).values({
      orgId,
      userId: u,
      email,
      fullName: email,
      status: "active",
      isOwner: false,
    } as never);
    for (const r of roles)
      await db.insert(userRoles).values({ userId: u, orgId, role: r as never });
  }
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-E-${stamp}`,
      title: "Platform Lead",
      status: "approved",
      ctcBandMin: "5000000",
      ctcBandMax: "9000000",
      budgetCtc: "7000000",
      createdBy: hr,
    } as never)
    .returning({ id: requisitions.id });
  role = r!.id;
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Ravi Kumar", email: `ravi-${stamp}@cand.local` })
    .returning({ id: candidates.id });
  candId = c!.id;
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: role, candidateId: candId, stage: "l1" })
    .returning({ id: applications.id });
  appId = a!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(organizations).where(eq(organizations.id, otherOrg));
  await db.delete(users).where(eq(users.id, hr));
  await db.delete(users).where(eq(users.id, outsider));
});

beforeEach(async () => {
  for (const t of [
    agentRuns,
    agentEvents,
    offers,
    onboardingDocuments,
    emailOutbox,
    interviewSlotOffers,
    agentPolicies,
    aiUsageEvents,
  ])
    await db.delete(t).where(eq((t as typeof offers).orgId, orgId));
  await db.delete(aiUsageEvents).where(eq(aiUsageEvents.orgId, otherOrg));
});

async function offerAt(status: string, extra: Record<string, unknown> = {}) {
  const [o] = await db
    .insert(offers)
    .values({
      orgId,
      applicationId: appId,
      offeredCtc: "7000000",
      status,
      letter: { subject: "Offer", opening: "Dear Ravi", sections: [{ heading: "Pay", body: "x" }] },
      ...extra,
    } as never)
    .returning({ id: offers.id });
  return o!.id;
}
const count = async (table: typeof offers, where = eq((table as typeof offers).orgId, orgId)) =>
  (await db.select().from(table).where(where)).length;

/* --------------------------------------------------------------- duplicates */

describe("the same document twice", () => {
  const file = (text: string) => new TextEncoder().encode(text);
  const store = async (bytes: Uint8Array, docType = "payslip", name = "payslip-sep.txt") => {
    const { storeOnboardingDocument } = await import("../src/lib/onboarding.server");
    return storeOnboardingDocument({
      orgId,
      applicationId: appId,
      candidateId: candId,
      offerId: null,
      docType,
      fileName: name,
      bytes,
      source: "upload",
      uploadedBy: hr,
    });
  };

  test("is not filed, read or announced again; a changed file is", async () => {
    const first = await store(file("Payslip September 2026 — gross 6,00,000"));
    expect(first.duplicate).toBeUndefined();
    const reads = await count(aiUsageEvents as never);
    const again = await store(file("Payslip September 2026 — gross 6,00,000"));
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    expect(again.note).toMatch(/already filed/);
    expect(await count(onboardingDocuments as never)).toBe(1);
    expect(await count(aiUsageEvents as never)).toBe(reads); // no second AI read
    expect(
      (await db.select().from(agentEvents).where(eq(agentEvents.orgId, orgId))).filter(
        (e) => e.type === "onboarding.document_received",
      ),
    ).toHaveLength(1);
    // Same name and size, different content: a different document.
    const changed = await store(file("Payslip September 2026 — gross 6,00,001"));
    expect(changed.duplicate).toBeUndefined();
    expect(await count(onboardingDocuments as never)).toBe(2);
    // Same file under another document type is filed too.
    const other = await store(file("Payslip September 2026 — gross 6,00,000"), "experience_letter");
    expect(other.duplicate).toBeUndefined();
  });

  test("a resend of a copy HR rejected is filed again", async () => {
    const first = await store(file("Blurred ID"), "id_proof", "id.txt");
    await db
      .update(onboardingDocuments)
      .set({ status: "rejected" })
      .where(eq(onboardingDocuments.id, first.id));
    const resend = await store(file("Blurred ID"), "id_proof", "id.txt");
    expect(resend.duplicate).toBeUndefined();
    expect(resend.id).not.toBe(first.id);
  });
});

describe("two people acting on the same thing", () => {
  test("two approvers sending the same offer back: one wins, the other is told", async () => {
    const id = await offerAt("pending_hr");
    const results = await Promise.allSettled([
      offersLib.sendBackOfferCore(asHr(), { id, reason: "Joining date" }),
      offersLib.sendBackOfferCore(asHr(), { id, reason: "CTC too high" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(failed.reason)).toMatch(/already moved on|not waiting for an approval/);
    const [o] = await db.select().from(offers).where(eq(offers.id, id));
    expect(
      (o!.approvalTrail as { decision: string }[]).filter((t) => t.decision === "sent_back"),
    ).toHaveLength(1);
  });

  test("the same event twice starts one agent run", async () => {
    await db
      .insert(agentPolicies)
      .values({ orgId, agentType: "offer", enabled: true, autonomy: "act_and_notify" } as never);
    for (let i = 0; i < 2; i++)
      await emitAgentEvent({
        orgId,
        type: "hiring.selected",
        subjectType: "application",
        subjectId: appId,
        actorUserId: hr,
        payload: { rationale: "select" },
      });
    await processAgentEvents({ orgId });
    const runs = (await db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId))).filter(
      (r) => r.agentType === "offer",
    );
    expect(runs).toHaveLength(1);
  });

  test("a gate decided twice: the second is refused", async () => {
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "offer",
        principalUserId: hr,
        goal: "g",
        status: "awaiting_human",
      } as never)
      .returning({ id: agentRuns.id });
    const [task] = await db
      .insert(agentTasks)
      .values({ orgId, runId: run!.id, kind: "approval", status: "open", title: "Do it" } as never)
      .returning({ id: agentTasks.id });
    const { resolveTask } = await import("../src/server/agents/runtime.server");
    await resolveTask({
      orgId,
      userId: hr,
      taskId: task!.id,
      decision: { status: "approved" } as never,
    });
    await expect(
      resolveTask({
        orgId,
        userId: hr,
        taskId: task!.id,
        decision: { status: "rejected" } as never,
      }),
    ).rejects.toThrow(/already been decided/);
    const [t] = await db.select().from(agentTasks).where(eq(agentTasks.id, task!.id));
    expect(t!.status).toBe("approved");
  });
});

describe("the release email", () => {
  // A complete letter, checked against the real schema so the fixture cannot drift.
  const letter = () =>
    offersLib.OfferLetterPayload.parse({
      version: 1,
      generatedAt: new Date().toISOString(),
      templateId: null,
      templateName: "Standard",
      hasLogo: false,
      boilerplate: null,
      subject: "Offer of employment",
      greeting: "Dear Ravi,",
      opening: "We are pleased to offer you the role of Platform Lead.",
      sections: [{ heading: "Compensation", body: "Annual CTC of INR 70,00,000." }],
      closing: "We look forward to working with you.",
      letterhead: { orgName: "Edge Org", legalName: null, hqCity: "Chennai", careersEmail: null },
      candidate: { fullName: "Ravi Kumar", email: null, phone: null, location: null },
      role: { title: "Platform Lead", location: "Chennai" },
      ctc: "7000000",
      joiningDate: null,
    });

  test("goes once per revision; a new revision gets its own", async () => {
    const id = await offerAt("released", { responseToken: `tok${stamp}`, letter: letter() });
    expect(await offersLib.emailReleasedOffer(orgId, id, `tok${stamp}`)).toBe(true);
    await offersLib.emailReleasedOffer(orgId, id, `tok${stamp}`);
    const mails = async () =>
      db
        .select()
        .from(emailOutbox)
        .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.kind, "offer_released")));
    expect(await mails()).toHaveLength(1);
    await db.update(offers).set({ revision: 2 }).where(eq(offers.id, id));
    await offersLib.emailReleasedOffer(orgId, id, `tok${stamp}b`);
    const all = await mails();
    expect(all).toHaveLength(2);
    expect(
      all.find((m) => (m.templateData as { revised?: string }).revised === "yes"),
    ).toBeTruthy();
  });

  test("never throws: no letter, or an offer that is not there, is reported as not sent", async () => {
    const id = await offerAt("released", { letter: null });
    expect(await offersLib.emailReleasedOffer(orgId, id, "t")).toBe(false);
    expect(
      await offersLib.emailReleasedOffer(orgId, "00000000-0000-0000-0000-000000000000", "t"),
    ).toBe(false);
    // A letter the PDF builder cannot read is logged, not thrown.
    const bad = await offerAt("released", { letter: { broken: true } });
    expect(await offersLib.emailReleasedOffer(orgId, bad, "t")).toBe(false);
  });
});

/* --------------------------------------------------------------- refusals */

describe("refused", () => {
  test("a bad, unknown or already-answered offer link", async () => {
    const resp = await import("../src/lib/offer-response.server");
    expect(await resp.publicOfferView("nope")).toBeNull();
    expect(await resp.respondToOffer("nope", { action: "accept" })).toEqual({
      ok: false,
      reason: "This link is not valid.",
    });
    await offerAt("released", { responseToken: `used${stamp}` });
    expect(
      (await resp.respondToOffer(`used${stamp}`, { action: "decline", reason: "Other offer" })).ok,
    ).toBe(true);
    const again = await resp.respondToOffer(`used${stamp}`, { action: "accept" });
    expect(again).toMatchObject({ ok: false });
    const [o] = await db
      .select()
      .from(offers)
      .where(eq(offers.responseToken, `used${stamp}`));
    expect(o!.status).toBe("declined");
  });

  test("a person without the role cannot send an offer back or see organisation cost", async () => {
    const id = await offerAt("pending_cbo");
    await expect(
      offersLib.sendBackOfferCore(
        { orgId, userId: outsider, memberEmail: outsiderEmail },
        {
          id,
          reason: "Not mine to decide",
        },
      ),
    ).rejects.toThrow();
    expect((await db.select().from(offers).where(eq(offers.id, id)))[0]!.status).toBe(
      "pending_cbo",
    );
    const { assertRole } = await import("../src/lib/auth.middleware");
    await expect(
      assertRole(
        outsider,
        orgId,
        ["hr_head", "president_cbo"],
        "Hiring cost across the organisation is for the HR head, the CBO or an owner.",
      ),
    ).rejects.toThrow(/HR head, the CBO or an owner/);
  });

  test("revising an offer that is out with the candidate, or above the band", async () => {
    const tool = (await import("../src/server/agents/registry")).getTool("revise_offer")!;
    const ctx = { orgId, principalUserId: hr, runId: "x", agentType: "offer", actor: "t" };
    const out = await offerAt("released");
    await expect(
      tool.run(
        ctx as never,
        { offerId: out, offeredCtc: 7_000_000, rationale: "Change while out" } as never,
      ),
    ).rejects.toThrow(/cannot be revised|Only an offer/);
    const draft = await offerAt("draft");
    await expect(
      tool.run(
        ctx as never,
        { offerId: draft, offeredCtc: 9_500_000, rationale: "Above the band max" } as never,
      ),
    ).rejects.toThrow(/outside the approved band/);
  });
});

/* --------------------------------------------------------------- cost */

describe("hiring cost", () => {
  const usage = async (org: string, tokens: number, model = "gemini-3.8-flash") => {
    const { recordAiUsage } = await import("../src/server/ai-usage");
    const { withAiSubject } = await import("../src/server/agents/context");
    await withAiSubject({ requisitionId: role, applicationId: org === orgId ? appId : null }, () =>
      recordAiUsage({
        orgId: org,
        feature: "candidate_score",
        provider: "google",
        model,
        status: "ok",
        promptTokens: Math.round(tokens * 0.9),
        completionTokens: Math.round(tokens * 0.1),
        totalTokens: tokens,
      }),
    );
  };

  test("nothing spent reads as zero, never a made-up figure", async () => {
    const o = await orgHiringCost(orgId, { months: 3 });
    expect(o.total).toMatchObject({ tokens: 0, requests: 0, cost: null });
    expect(o.costPerHire).toBeNull();
    expect(o.currency).toBeNull();
  });

  test("another organisation's spend is never counted, even tagged with this role", async () => {
    await usage(orgId, 100_000);
    await usage(otherOrg, 5_000_000); // same requisition id in the tag — different org
    const o = await orgHiringCost(orgId, { months: 1 });
    expect(o.total.tokens).toBe(100_000);
    expect((await roleCost(orgId, role)).total.tokens).toBe(100_000);
    // 90K in at $0.75/M + 10K out at $3.75/M
    expect(o.total.cost).toBeCloseTo(0.0675 + 0.0375, 6);
  });

  test("a model with no price on file stays in tokens; priced and unpriced are kept apart", async () => {
    await usage(orgId, 100_000);
    await usage(orgId, 50_000, "some-unlisted-model");
    const o = await orgHiringCost(orgId, { months: 1 });
    expect(o.total.tokens).toBe(150_000);
    expect(o.total.unpricedTokens).toBe(50_000);
    expect(o.total.cost).toBeCloseTo(0.105, 6);
  });
});
