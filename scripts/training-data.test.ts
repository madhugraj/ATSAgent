/**
 * Training-data capture (docs/agentic-plan.md §14), against the disposable
 * database:
 *  - nothing is kept until an owner agrees; consent is audited;
 *  - a model call is kept whole (system, prompt, tools, output), linked to its
 *    ledger rows, run, role and candidate; attachments are described, not copied;
 *  - capture never breaks the call it records;
 *  - judgements are kept and linked: task decisions and edits, HR document
 *    verdicts, final outcomes, annotations (refused without consent, and across
 *    organisations);
 *  - erasing a candidate erases their rows; retention and "delete" work;
 *  - exports are pseudonymised and refused without consent.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/training-data.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentRuns,
  agentTasks,
  aiUsageEvents,
  applications,
  auditLog,
  candidates,
  onboardingDocuments,
  orgMembers,
  organizations,
  requisitions,
  trainingFeedback,
  trainingInferences,
  trainingSettings,
  userRoles,
  users,
} = await import("../drizzle/schema");
const capture = await import("../src/server/training/capture.server");
const training = await import("../src/lib/training.functions");
const { recordAiUsage } = await import("../src/server/ai-usage");
const { agentRunScope, withAiSubject } = await import("../src/server/agents/context");

const stamp = Date.now();
let orgId: string;
let otherOrg: string;
let owner: string;
let role: string;
let appId: string;
let candId: string;
const ownerEmail = `owner-${stamp}@test.local`;
const asOwner = () => ({ orgId, userId: owner, memberEmail: ownerEmail });

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  owner = (await db.insert(users).values({ email: ownerEmail }).returning({ id: users.id }))[0]!.id;
  const mkOrg = async (slug: string) =>
    (
      await db
        .insert(organizations)
        .values({ name: slug, slug, status: "active" })
        .returning({ id: organizations.id })
    )[0]!.id;
  orgId = await mkOrg(`train-${stamp}`);
  otherOrg = await mkOrg(`train-other-${stamp}`);
  await db.insert(orgMembers).values({
    orgId,
    userId: owner,
    email: ownerEmail,
    fullName: "Kavya Menon",
    status: "active",
    isOwner: true,
  } as never);
  for (const r of ["hr_head", "recruiter"])
    await db.insert(userRoles).values({ userId: owner, orgId, role: r as never });
  role = (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-T-${stamp}`,
        title: "Data Lead",
        status: "approved",
        createdBy: owner,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(organizations).where(eq(organizations.id, otherOrg));
  await db.delete(users).where(eq(users.id, owner));
});

beforeEach(async () => {
  for (const t of [
    trainingFeedback,
    trainingInferences,
    trainingSettings,
    agentRuns,
    aiUsageEvents,
  ])
    await db.delete(t).where(eq((t as typeof trainingSettings).orgId, orgId));
  await db.delete(candidates).where(eq(candidates.orgId, orgId));
  candId = (
    await db
      .insert(candidates)
      .values({
        orgId,
        fullName: "Priya Raghavan",
        email: `priya-${stamp}@cand.local`,
        phone: "+91 98765 43210",
      })
      .returning({ id: candidates.id })
  )[0]!.id;
  appId = (
    await db
      .insert(applications)
      .values({ orgId, requisitionId: role, candidateId: candId, stage: "shortlisted" })
      .returning({ id: applications.id })
  )[0]!.id;
  capture.resetCaptureCache();
});

const consent = (enabled: boolean) =>
  training.setTrainingConsentCore(asOwner(), { enabled, retentionDays: 365 });

/** A fake model call that writes a ledger row, like a real provider call. */
const fakeCall = (output: unknown, opts: { fail?: boolean } = {}) =>
  capture.withInferenceCapture(
    async () => {
      await recordAiUsage({
        orgId,
        feature: "candidate_score",
        provider: "google",
        model: "gemini-test",
        status: opts.fail ? "error" : "ok",
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
      });
      return opts.fail
        ? { ok: false as const, message: "provider down" }
        : { ok: true as const, data: output };
    },
    (r, latencyMs) => ({
      orgId,
      callKind: "json",
      feature: "candidate_score",
      request: {
        system: "You score candidates.",
        prompt: "Priya Raghavan, 9 years data platforms",
        outputSchema: { type: "object" },
      },
      response: r.ok ? { data: r.data } : null,
      status: r.ok ? "ok" : "error",
      errorMessage: r.ok ? null : r.message,
      promptTokens: 1200,
      completionTokens: 300,
      latencyMs,
    }),
  );
const kept = async () =>
  db.select().from(trainingInferences).where(eq(trainingInferences.orgId, orgId));

describe("consent", () => {
  test("nothing is kept until an owner agrees; consent and withdrawal are audited", async () => {
    await withAiSubject({ applicationId: appId }, () => fakeCall({ score: 81 }));
    expect(await kept()).toHaveLength(0);
    await consent(true);
    await withAiSubject({ applicationId: appId }, () => fakeCall({ score: 81 }));
    expect(await kept()).toHaveLength(1);
    await consent(false);
    await withAiSubject({ applicationId: appId }, () => fakeCall({ score: 82 }));
    expect(await kept()).toHaveLength(1);
    const audits = (await db.select().from(auditLog).where(eq(auditLog.orgId, orgId))).map(
      (a) => a.action,
    );
    expect(audits).toContain("training.consent_given");
    expect(audits).toContain("training.consent_withdrawn");
  });

  test("another organisation's consent does not open capture for this one", async () => {
    await db.insert(trainingSettings).values({ orgId: otherOrg, enabled: true });
    capture.resetCaptureCache();
    await fakeCall({ score: 1 });
    expect(await kept()).toHaveLength(0);
    await db.delete(trainingSettings).where(eq(trainingSettings.orgId, otherOrg));
  });
});

describe("a model call", () => {
  test("is kept whole and linked to its ledger rows, run, role and candidate", async () => {
    await consent(true);
    const [run] = await db
      .insert(agentRuns)
      .values({ orgId, agentType: "intake", principalUserId: owner, goal: "score" } as never)
      .returning({ id: agentRuns.id });
    const r = await agentRunScope.run({ runId: run!.id, orgId, agentType: "intake" }, () =>
      withAiSubject({ requisitionId: role, applicationId: appId }, () => fakeCall({ score: 77 })),
    );
    expect(r).toEqual({ ok: true, data: { score: 77 } });
    const [inf] = await kept();
    expect(inf).toMatchObject({
      callKind: "json",
      feature: "candidate_score",
      provider: "google",
      model: "gemini-test",
      status: "ok",
      response: { data: { score: 77 } },
      agentRunId: run!.id,
      requisitionId: role,
      applicationId: appId,
      candidateId: candId, // resolved from the application, for erasure
      promptTokens: 1200,
      completionTokens: 300,
    });
    expect(inf!.request).toMatchObject({
      system: "You score candidates.",
      outputSchema: { type: "object" },
    });
    expect(inf!.requestHash).toMatch(/^[0-9a-f]{64}$/);
    const usage = await db.select().from(aiUsageEvents).where(eq(aiUsageEvents.orgId, orgId));
    expect(inf!.usageEventIds).toEqual(usage.map((u) => u.id));
  });

  test("a failed call is kept with its error; attachments are described, never copied", async () => {
    await consent(true);
    await fakeCall(null, { fail: true });
    const [inf] = await kept();
    expect(inf).toMatchObject({ status: "error", errorMessage: "provider down", response: null });
    const d = capture.describeAttachment({
      base64: Buffer.from("%PDF-1.4 payslip").toString("base64"),
      contentType: "application/pdf",
      fileName: "payslip.pdf",
    });
    expect(d).toMatchObject({ contentType: "application/pdf", fileName: "payslip.pdf", bytes: 16 });
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(d)).not.toContain("JVBER"); // no base64
  });

  test("capture never breaks the call it records", async () => {
    await consent(true);
    // An organisation id that does not exist: the insert fails, the call does not.
    const r = await capture.withInferenceCapture(
      async () => "the answer",
      () => ({
        orgId,
        callKind: "json",
        feature: "x",
        request: { bad: 1n as never },
        response: null,
        status: "ok",
      }),
    );
    expect(r).toBe("the answer");
  });
});

describe("judgements", () => {
  test("a person editing an agent's proposal is a correction linked to the call that made it", async () => {
    await consent(true);
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "intake",
        principalUserId: owner,
        goal: "g",
        status: "awaiting_human",
      } as never)
      .returning({ id: agentRuns.id });
    await agentRunScope.run({ runId: run!.id, orgId, agentType: "intake" }, () =>
      fakeCall({ weights: { skills: 40 } }),
    );
    const [inf] = await kept();
    const [task] = await db
      .insert(agentTasks)
      .values({
        orgId,
        runId: run!.id,
        kind: "approval",
        status: "open",
        title: "Save scoring weights",
        proposedAction: { toolCallId: "t1", name: "save_weights", args: { skills: 40 } },
      } as never)
      .returning({ id: agentTasks.id });
    const { resolveTask } = await import("../src/server/agents/runtime.server");
    await resolveTask({
      orgId,
      userId: owner,
      taskId: task!.id,
      decision: {
        status: "approved",
        args: { skills: 55 },
        comment: "Skills matter more here",
      } as never,
    });
    const [fb] = await db.select().from(trainingFeedback).where(eq(trainingFeedback.orgId, orgId));
    expect(fb).toMatchObject({
      source: "task_decision",
      label: "edited",
      reason: "Skills matter more here",
      corrected: { args: { skills: 55 } },
      inferenceId: inf!.id,
      agentRunId: run!.id,
      agentTaskId: task!.id,
    });
    expect((fb!.original as { proposed: unknown }).proposed).toEqual({ skills: 40 });
  });

  test("HR's verdict on an AI document read, and the final outcome", async () => {
    await consent(true);
    await withAiSubject({ applicationId: appId }, () =>
      capture.withInferenceCapture(
        async () => ({ ok: true }),
        () => ({
          orgId,
          callKind: "json",
          feature: "doc_extract",
          request: { prompt: "payslip" },
          response: { gross: 600000 },
          status: "ok",
        }),
      ),
    );
    const [inf] = await kept();
    const [doc] = await db
      .insert(onboardingDocuments)
      .values({
        orgId,
        applicationId: appId,
        candidateId: candId,
        docType: "payslip",
        fileName: "p.txt",
        extracted: { gross: 600000 },
      } as never)
      .returning({ id: onboardingDocuments.id });
    const { reviewOnboardingDocCore } = await import("../src/lib/onboarding.functions");
    await reviewOnboardingDocCore(asOwner(), {
      id: doc!.id,
      decision: "rejected",
      note: "Gross is 6,50,000 on the slip",
    });
    const { moveStageCore } = await import("../src/lib/pipeline.server");
    await moveStageCore(asOwner() as never, {
      applicationId: appId,
      toStage: "rejected",
      reason: "Not a fit",
    });
    const fb = await db.select().from(trainingFeedback).where(eq(trainingFeedback.orgId, orgId));
    expect(fb.find((f) => f.source === "document_review")).toMatchObject({
      label: "rejected",
      reason: "Gross is 6,50,000 on the slip",
      inferenceId: inf!.id,
      original: { docType: "payslip", extracted: { gross: 600000 } },
    });
    expect(fb.find((f) => f.source === "outcome")).toMatchObject({
      label: "rejected",
      applicationId: appId,
      candidateId: candId,
      actorKind: "system",
    });
  });

  test("annotations: refused without consent and across organisations", async () => {
    await consent(true);
    await fakeCall({ score: 50 });
    const [inf] = await kept();
    await training.annotateInferenceCore(
      { orgId, userId: owner },
      { inferenceId: inf!.id, label: "corrected", rating: 2, corrected: { score: 70 } },
    );
    const [a] = await db
      .select()
      .from(trainingFeedback)
      .where(eq(trainingFeedback.source, "annotation"));
    expect(a).toMatchObject({
      label: "corrected",
      rating: 2,
      corrected: { score: 70 },
      inferenceId: inf!.id,
    });
    await expect(
      training.annotateInferenceCore(
        { orgId: otherOrg, userId: owner },
        { inferenceId: inf!.id, label: "good" },
      ),
    ).rejects.toThrow();
    await consent(false);
    await expect(
      training.annotateInferenceCore(
        { orgId, userId: owner },
        { inferenceId: inf!.id, label: "good" },
      ),
    ).rejects.toThrow(/capture is off/);
  });
});

describe("erasure and retention", () => {
  test("erasing a candidate erases their calls and judgements", async () => {
    await consent(true);
    await withAiSubject({ applicationId: appId }, () => fakeCall({ score: 9 }));
    const { captureFeedback } = await import("../src/server/training/capture.server");
    await captureFeedback({
      orgId,
      source: "outcome",
      label: "rejected",
      applicationId: appId,
      actorKind: "system",
    });
    expect(await kept()).toHaveLength(1);
    await db.delete(candidates).where(eq(candidates.id, candId));
    expect(await kept()).toHaveLength(0);
    expect(
      await db.select().from(trainingFeedback).where(eq(trainingFeedback.orgId, orgId)),
    ).toHaveLength(0);
  });

  test("retention removes old rows; an owner can delete everything, audited", async () => {
    await consent(true);
    await fakeCall({ a: 1 });
    await fakeCall({ a: 2 });
    const [old] = await kept();
    await db
      .update(trainingInferences)
      .set({ createdAt: new Date(Date.now() - 400 * 864e5) })
      .where(eq(trainingInferences.id, old!.id));
    expect(await training.applyTrainingRetention(orgId)).toBe(1);
    expect(await kept()).toHaveLength(1);
    expect(await training.deleteTrainingDataCore(asOwner())).toMatchObject({ inferences: 1 });
    expect(await kept()).toHaveLength(0);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "training.data_deleted")));
    expect(audits).toHaveLength(1);
  });
});

describe("export", () => {
  test("pseudonymises known people stably and masks other contact details", async () => {
    const { buildPseudonymiser } = await import("../src/server/training/pseudonymise");
    const scrub = buildPseudonymiser(orgId, [
      {
        name: "Priya Raghavan",
        email: "priya@cand.local",
        phone: "+91 98765 43210",
        kind: "candidate",
      },
    ]);
    const out = JSON.stringify(
      scrub({
        prompt:
          "Priya Raghavan (priya@cand.local, +91 98765 43210) — Priya led the team. Ref: ops@other.com, 044-2345 6789 01",
      }),
    );
    expect(out).not.toMatch(/Priya|Raghavan|priya@cand\.local|98765|ops@other\.com/i);
    expect(out).toMatch(/candidate-[0-9a-f]{8}/);
    expect(out).toContain("[email]");
    const again = JSON.stringify(scrub({ who: "Priya Raghavan" }));
    expect(again).toContain(out.match(/candidate-[0-9a-f]{8}/)![0]); // stable token
  });

  test("refused without consent; with consent writes the datasets, pseudonymised and audited", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "atsiq-export-"));
    const run = (o: string) =>
      Bun.spawnSync(["bun", "scripts/training-export.ts", "--org", orgId, "--out", o], {
        env: process.env,
        cwd: path.resolve(import.meta.dir, ".."),
      });
    expect(run(out).exitCode).toBe(2);
    await consent(true);
    await withAiSubject({ applicationId: appId }, () =>
      fakeCall({ summary: "Priya Raghavan is strong" }),
    );
    const r = run(out);
    expect(r.exitCode).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      schema: "atsiq-training/1",
      pseudonymised: true,
      counts: { sft: 1 },
    });
    const sft = readFileSync(path.join(out, "sft.jsonl"), "utf8");
    expect(sft).not.toMatch(/Priya|Raghavan/);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "training.exported")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});
