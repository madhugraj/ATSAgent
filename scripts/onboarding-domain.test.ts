/**
 * Behaviour lockdown for the "onboarding" domain (Phase 5/6 L3 hiring domain;
 * regex over repo-relative paths: ^src/lib/(onboarding|hrms)) so ANY behaviour
 * change when these files move into an @ats/* package fails a test. Locked
 * down, per the domain split:
 *  - src/lib/onboarding.server.ts — the pre-onboarding document collection,
 *    extraction and reconciliation split: catalogue + guessDocType +
 *    docTypeLabel and their browser-catalogue parity; the ExtractedDoc
 *    validation shape (labelled pay lines, capped arrays, 0-100 confidence);
 *    expandUpload flattening (zip/nested-zip/junk-skip/damaged fallback);
 *    documentObjectPath + readOnboardingFile org-prefix boundary; the
 *    extractDocument vendor-neutral refusal (no AI key → never throws, never
 *    names a vendor) and no-readable-text refusal; storeOnboardingDocument
 *    (pending row, stored bytes, twin suppression that ignores rejected rows,
 *    document_received event); readinessFor (verified-only gating, required
 *    types, org scoping); offerContextForEmail (offering-stage only, org
 *    scoped); compensationReading (payslip annualisation, one-off exclusion,
 *    revision governance + drift conflict, future-revision gap, parts
 *    flattening, employment gaps, confidence, offered-hike, org isolation);
 *  - src/lib/onboarding.functions.ts — reviewOnboardingDocCore: role gate
 *    (recruiter/hr_head only), org scoping (a foreign org's doc id is "no
 *    longer here"), rejected-needs-a-reason, verified/pending/rejected row
 *    effects with the audit trail and the document_rejected agent event;
 *  - src/lib/hrms.ts + src/lib/hrms.server.ts — provider catalogue meta;
 *    ensureHrmsConnections (idempotent, disabled, hrms-category, org-scoped);
 *    assertHrmsBaseUrl (https, no credentials, per-provider allow-list with
 *    dot-suffix and the INTEGRATION_ALLOWED_HOSTS extra, trailing slash);
 *    testHrmsProvider refusals (unknown, missing credentials, base URL
 *    required, deterministic DNS failure → failed, never throws);
 *    syncHrmsEmployees refusals (not found, CROSS-ORG connection id, disabled)
 *    and the failed-run recording (state row lastRunStatus/lastError +
 *    hrms.sync.failed audit); hrmsSyncOverview org scoping; forgetHrmsCache;
 *  - src/lib/onboarding.catalogue.ts — must not drift from the server
 *    catalogue.
 *
 * No mock.module. DB-backed on the disposable database (org B proves tenant
 * isolation for every org-scoped core). The HRMS vendors are reached through
 * safeFetch (undici, DNS-vetted), so their happy paths cannot be stubbed via
 * globalThis.fetch — the sync/probe failure paths are driven against a
 * reserved .test host (never resolves) instead, and the real-vendor pulls are
 * listed in the suite notes. AI-calling cores are tested on the vendor-neutral
 * refusal path only (no provider keys in CI).
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/onboarding-domain.test.ts
 */
// CI runs the suites with only DATABASE_URL and SESSION_SECRET. These only
// need to EXIST before the module graph loads: throwaway values, real
// environment values always win. SECRET_ENCRYPTION_KEY is cached by crypto.ts
// at first use (credential round-trips in the HRMS connection tests).
process.env.SECRET_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");
// The HRMS base-URL allow-list is snapshotted from the env at import; a
// reserved .test host here drives the deterministic "could not resolve"
// failure paths (vendor REST goes through safeFetch, not stubbable fetch).
process.env.INTEGRATION_ALLOWED_HOSTS ??= "onb-sync.test";

import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  applications,
  auditLog,
  candidates,
  hrmsEmployees,
  hrmsSyncState,
  offers,
  onboardingDocuments,
  organizations,
  orgMembers,
  requisitions,
  sourceIntegrations,
  userRoles,
  users,
} = await import("../drizzle/schema");
const onb = await import("../src/lib/onboarding.server");
const catalogue = await import("../src/lib/onboarding.catalogue");
const { reviewOnboardingDocCore } = await import("../src/lib/onboarding.functions");
const hrms = await import("../src/lib/hrms");
const hrmsServer = await import("../src/lib/hrms.server");
const integrations = await import("../src/lib/integrations.server");
const { deletePrefix, putObject } = await import("../src/server/storage");

const stamp = Date.now();
const dom = `onbd${stamp}.test`;
const syncHost = `sync-${stamp}.onb-sync.test`; // reserved TLD: never resolves

let orgA: string;
let orgB: string;
let ownerA: string;
let taA: string;
let hrA: string;
let hmA: string;
let panelA: string;
let ownerB: string;

let appDoc: string; // storeOnboardingDocument / review / readiness flow
let candDoc: string;
let appDoc2: string; // fully verified → readiness ready
let candDoc2: string;
let appPay: string; // three consecutive verified payslips + an offer
let candPay: string;
let offerPay: string;
let appRev: string; // payslips + a governing revision letter
let candRev: string;
let appFuture: string; // revision effective after the newest payslip
let candFuture: string;
let appOneOff: string; // gross with a one-off component
let candOneOff: string;
let appGap: string; // employment history with a gap
let candGap: string;
let appParts: string; // merged upload read as parts
let candParts: string;
let appEarly: string; // pre-offer stage → offerContextForEmail null
let candEarly: string;
let appB1: string; // org B
let candB1: string;

let aKeka: string;
let aGreythr: string;
let bKeka: string;
let bGreythr: string;

const monthAgo = (n: number): string => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
};

async function mkOrg(name: string) {
  return (
    await db
      .insert(organizations)
      .values({ name, slug: `${name}-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
}
async function mkUser(email: string) {
  return (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
}
async function member(userId: string, org: string, email: string, isOwner = false) {
  await db
    .insert(orgMembers)
    .values({ orgId: org, userId, email, status: "active", isOwner } as never);
}
async function role(userId: string, org: string, r: string) {
  await db.insert(userRoles).values({ userId, orgId: org, role: r } as never);
}
async function seedOffer(org: string, code: string, email: string, stage: string) {
  const reqId = (
    await db
      .insert(requisitions)
      .values({ orgId: org, code, title: "Head of AI", status: "approved" } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
  const candId = (
    await db
      .insert(candidates)
      .values({ orgId: org, fullName: "Asha Candidate", email } as never)
      .returning({ id: candidates.id })
  )[0]!.id;
  const appId = (
    await db
      .insert(applications)
      .values({ orgId: org, requisitionId: reqId, candidateId: candId, stage } as never)
      .returning({ id: applications.id })
  )[0]!.id;
  return { candId, appId };
}
/** An onboarding document row carrying the agent's reading of the file. */
async function doc(
  applicationId: string,
  candId: string,
  docType: string,
  extracted: Record<string, unknown>,
  status = "verified",
) {
  return (
    await db
      .insert(onboardingDocuments)
      .values({
        orgId: orgA,
        applicationId,
        candidateId: candId,
        docType,
        fileName: `${docType}-${stamp}.txt`,
        extracted: extracted as never,
        extractionStatus: "extracted",
        status,
      } as never)
      .returning({ id: onboardingDocuments.id })
  )[0]!.id;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");

  orgA = await mkOrg("Onboarding Domain A");
  orgB = await mkOrg("Onboarding Domain B");

  ownerA = await mkUser(`owner@${dom}`);
  taA = await mkUser(`ta@${dom}`);
  hrA = await mkUser(`hr@${dom}`);
  hmA = await mkUser(`hm@${dom}`);
  panelA = await mkUser(`panel@${dom}`);
  ownerB = await mkUser(`owner-b@${dom}`);
  await member(ownerA, orgA, `owner@${dom}`, true);
  await member(taA, orgA, `ta@${dom}`);
  await member(hrA, orgA, `hr@${dom}`);
  await member(hmA, orgA, `hm@${dom}`);
  await member(panelA, orgA, `panel@${dom}`);
  await member(ownerB, orgB, `owner-b@${dom}`, true);
  await role(taA, orgA, "recruiter");
  await role(hrA, orgA, "hr_head");
  await role(hmA, orgA, "hiring_manager");
  await role(panelA, orgA, "interviewer");

  ({ candId: candDoc, appId: appDoc } = await seedOffer(
    orgA,
    `REQ-OD-1-${stamp}`,
    `doc@${dom}`,
    "offer",
  ));
  ({ candId: candDoc2, appId: appDoc2 } = await seedOffer(
    orgA,
    `REQ-OD-2-${stamp}`,
    `doc2@${dom}`,
    "offer",
  ));
  ({ candId: candPay, appId: appPay } = await seedOffer(
    orgA,
    `REQ-OD-3-${stamp}`,
    `pay@${dom}`,
    "offer",
  ));
  ({ candId: candRev, appId: appRev } = await seedOffer(
    orgA,
    `REQ-OD-4-${stamp}`,
    `rev@${dom}`,
    "offer",
  ));
  ({ candId: candFuture, appId: appFuture } = await seedOffer(
    orgA,
    `REQ-OD-5-${stamp}`,
    `fut@${dom}`,
    "offer",
  ));
  ({ candId: candOneOff, appId: appOneOff } = await seedOffer(
    orgA,
    `REQ-OD-6-${stamp}`,
    `one@${dom}`,
    "offer",
  ));
  ({ candId: candGap, appId: appGap } = await seedOffer(
    orgA,
    `REQ-OD-7-${stamp}`,
    `gap@${dom}`,
    "offer",
  ));
  ({ candId: candParts, appId: appParts } = await seedOffer(
    orgA,
    `REQ-OD-8-${stamp}`,
    `parts@${dom}`,
    "offer",
  ));
  ({ candId: candEarly, appId: appEarly } = await seedOffer(
    orgA,
    `REQ-OD-9-${stamp}`,
    `early@${dom}`,
    "l1",
  ));
  ({ candId: candB1, appId: appB1 } = await seedOffer(
    orgB,
    `REQ-OD-B-${stamp}`,
    `b1@${dom}`,
    "offer",
  ));

  offerPay = (
    await db
      .insert(offers)
      .values({ orgId: orgA, applicationId: appPay, offeredCtc: "1800000" } as never)
      .returning({ id: offers.id })
  )[0]!.id;

  await hrmsServer.ensureHrmsConnections(orgA);
  await hrmsServer.ensureHrmsConnections(orgB);
  const rows = await db
    .select({
      id: sourceIntegrations.id,
      orgId: sourceIntegrations.orgId,
      provider: sourceIntegrations.provider,
    })
    .from(sourceIntegrations)
    .where(eq(sourceIntegrations.category, "hrms"));
  aKeka = rows.find((r) => r.orgId === orgA && r.provider === "keka")!.id;
  aGreythr = rows.find((r) => r.orgId === orgA && r.provider === "greythr")!.id;
  bKeka = rows.find((r) => r.orgId === orgB && r.provider === "keka")!.id;
  bGreythr = rows.find((r) => r.orgId === orgB && r.provider === "greythr")!.id;
});

afterAll(async () => {
  // audit rows carry no FK; local object storage has no DB cascade. The rest
  // cascades from organizations, then users.
  for (const id of [orgA, orgB]) {
    if (!id) continue;
    await db.delete(auditLog).where(eq(auditLog.orgId, id));
    await deletePrefix(`${id}/`).catch(() => {});
  }
  for (const id of [orgA, orgB]) await db.delete(organizations).where(eq(organizations.id, id));
  for (const id of [ownerA, taA, hrA, hmA, panelA, ownerB])
    if (id) await db.delete(users).where(eq(users.id, id));
});

/* ------------------------------------------- catalogue, shapes, name reading */

describe("document catalogue (onboarding.server)", () => {
  test("four required document types gate readiness, keys are stable", () => {
    expect(onb.REQUIRED_DOC_TYPES).toEqual([
      "id_proof",
      "experience_letter",
      "payslip",
      "education_certificate",
    ]);
    expect(onb.DOC_TYPE_KEYS).toEqual(onb.DOC_TYPES.map((d) => d.key));
    expect(onb.DOC_TYPES.every((d) => d.expects.length > 0)).toBe(true);
  });

  test("docTypeLabel resolves catalogue labels and falls back to the key", () => {
    expect(onb.docTypeLabel("payslip")).toBe("Recent payslips");
    expect(onb.docTypeLabel("id_proof")).toBe("Government photo ID");
    expect(onb.docTypeLabel("mystery_kind")).toBe("mystery_kind");
  });

  test("guessDocType reads the file name, anything else is 'other'", () => {
    expect(onb.guessDocType(`payslip-mar-${stamp}.pdf`)).toBe("payslip");
    expect(onb.guessDocType("relieving-letter.pdf")).toBe("experience_letter");
    expect(onb.guessDocType("aadhaar-front.png")).toBe("id_proof");
    expect(onb.guessDocType("btech-degree.pdf")).toBe("education_certificate");
    expect(onb.guessDocType("appraisal-2026.pdf")).toBe("salary_revision");
    expect(onb.guessDocType("cancelled-cheque.jpg")).toBe("bank_details");
    expect(onb.guessDocType("rent-agreement.pdf")).toBe("address_proof");
    expect(onb.guessDocType("bgv-consent.pdf")).toBe("background_form");
    expect(onb.guessDocType("photo.pdf")).toBe("other");
  });

  test("the browser catalogue copy does not drift from the server catalogue", () => {
    expect(catalogue.DOC_TYPES.map((d) => [d.key, d.label, d.hint])).toEqual(
      onb.DOC_TYPES.map((d) => [d.key, d.label, d.hint]),
    );
    expect(catalogue.DOC_TYPES.map((d) => d.key)).toEqual(onb.DOC_TYPE_KEYS);
  });

  test("ExtractedDoc keeps labelled pay lines and merged parts, caps junk", () => {
    const parsed = onb.ExtractedDoc.parse({
      document_kind: "Payslip",
      period_iso: `${monthAgo(0)}-01`,
      monthly_fixed_gross: 100000,
      pay_components: [{ label: "Basic", amount: 50000, kind: null, recurring: true }],
      parts: [{ part_label: "Payslip Mar", period_iso: monthAgo(1), pages: "1-2" }],
      contains_multiple_documents: true,
      confidence: 92,
    });
    expect(parsed.pay_components).toHaveLength(1);
    expect(parsed.parts![0]!.part_label).toBe("Payslip Mar");
    expect(onb.ExtractedDoc.safeParse({ confidence: 150 }).success).toBe(false);
    expect(
      onb.ExtractedDoc.safeParse({ pay_components: [{ label: "x".repeat(121), amount: 1 }] })
        .success,
    ).toBe(false);
    expect(
      onb.ExtractedDoc.safeParse({
        pay_components: Array.from({ length: 41 }, () => ({ label: "l", amount: 1 })),
      }).success,
    ).toBe(false);
  });
});

describe("expandUpload (archive flattening)", () => {
  const pdf = strToU8("%PDF-1.4 test");

  test("a non-archive passes through as one untouched member", async () => {
    const out = await onb.expandUpload("experience.pdf", pdf);
    expect(out).toHaveLength(1);
    expect(out[0]!.fileName).toBe("experience.pdf");
  });

  test("a zip flattens into its documents, skipping resource forks", async () => {
    const zip = zipSync({
      "payslip-mar.pdf": pdf,
      "folder/relieving.pdf": pdf,
      "__MACOSX/._junk": pdf,
      ".DS_Store": pdf,
    });
    const out = await onb.expandUpload(`proofs-${stamp}.zip`, zip);
    expect(out.map((m) => m.fileName).sort()).toEqual(["payslip-mar.pdf", "relieving.pdf"]);
  });

  test("a nested zip is flattened too", async () => {
    const out = await onb.expandUpload(
      `nested-${stamp}.zip`,
      zipSync({ "inner.zip": zipSync({ "aadhaar.pdf": pdf }) }),
    );
    expect(out.map((m) => m.fileName)).toEqual(["aadhaar.pdf"]);
  });

  test("a damaged archive stays one stored file so HR can ask for a copy", async () => {
    const out = await onb.expandUpload(`damaged-${stamp}.zip`, strToU8("not a zip at all"));
    expect(out).toHaveLength(1);
    expect(out[0]!.fileName).toBe(`damaged-${stamp}.zip`);
  });
});

describe("document storage paths and the org-prefix boundary", () => {
  test("documentObjectPath is org-prefixed and sanitises the file name", () => {
    const p = onb.documentObjectPath(orgA, candDoc, "../../evil name#1.pdf");
    expect(p.startsWith(`${orgA}/onboarding/${candDoc}/`)).toBe(true);
    // Path separators and cross-site chars are flattened — exactly four
    // segments, so no traversal component survives inside the key.
    expect(p.split("/")).toHaveLength(4);
    expect(p).not.toContain("#");
  });

  test("readOnboardingFile round-trips own bytes and refuses foreign prefixes", async () => {
    const bytes = strToU8("gross monthly 100000");
    const p = onb.documentObjectPath(orgA, candDoc, "payslip.txt");
    await putObject(p, bytes, "text/plain");
    const got = await onb.readOnboardingFile(orgA, p);
    expect(Buffer.from(got!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(got!.contentType).toBe("text/plain");
    expect(await onb.readOnboardingFile(orgA, `${orgB}/onboarding/${candB1}/x.pdf`)).toBeNull();
    expect(await onb.readOnboardingFile(orgA, null)).toBeNull();
  });
});

describe("extractDocument (vendor-neutral AI refusal paths)", () => {
  test("a readable text file fails closed without naming any vendor", async () => {
    const out = await onb.extractDocument({
      orgId: orgA,
      docType: "payslip",
      fileName: "payslip.txt",
      bytes: strToU8("Gross monthly pay: 100000 INR. Basic 50000. HRA 50000."),
    });
    expect(out.status).toBe("failed");
    expect(out.extracted).toBeNull();
    expect(out.model).toBeNull();
    expect(out.text).toContain("Gross monthly pay");
    expect(out.note).toContain("No AI model key saved");
    // Vendor names never leave the server on the refusal path.
    expect(out.note ?? "").not.toMatch(/openai|anthropic|google|gpt|claude|gemini/i);
  });

  test("a file with no readable text is refused as a scan, not sent anywhere", async () => {
    const out = await onb.extractDocument({
      orgId: orgA,
      docType: "experience_letter",
      fileName: "blank.txt",
      bytes: strToU8("   \n  "),
    });
    expect(out.status).toBe("failed");
    expect(out.text).toBeNull();
    expect(out.note).toContain("No readable text in the file");
  });
});

describe("storeOnboardingDocument + readinessFor", () => {
  test("filing stores the bytes privately and leaves the row pending for review", async () => {
    const bytes = strToU8("Payslip March. Gross 100000.");
    const out = await onb.storeOnboardingDocument({
      orgId: orgA,
      applicationId: appDoc,
      candidateId: candDoc,
      offerId: null,
      docType: "payslip",
      fileName: "payslip-mar.txt",
      bytes,
      source: "upload",
      uploadedBy: taA,
    });
    expect(out.duplicate).toBeUndefined();
    expect(out.extractionStatus).toBe("failed"); // no AI key in this org
    expect(out.note).toContain("No AI model key saved");
    const [row] = await db
      .select({
        status: onboardingDocuments.status,
        filePath: onboardingDocuments.filePath,
        fileBytes: onboardingDocuments.fileBytes,
        contentType: onboardingDocuments.contentType,
        uploadedBy: onboardingDocuments.uploadedBy,
        model: onboardingDocuments.model,
        extractedText: onboardingDocuments.extractedText,
      })
      .from(onboardingDocuments)
      .where(and(eq(onboardingDocuments.orgId, orgA), eq(onboardingDocuments.id, out.id)));
    expect(row!.status).toBe("pending");
    expect(row!.filePath!.startsWith(`${orgA}/onboarding/`)).toBe(true);
    expect(row!.fileBytes).toBe(bytes.byteLength);
    expect(row!.contentType).toBe("text/plain");
    expect(row!.uploadedBy).toBe(taA);
    expect(row!.model).toBeNull(); // no vendor name stored on a failed read
    expect(row!.extractedText).toContain("Payslip March");
    const stored = await onb.readOnboardingFile(orgA, row!.filePath);
    expect(stored).not.toBeNull();
    const events = await db
      .select({ payload: agentEvents.payload })
      .from(agentEvents)
      .where(
        and(eq(agentEvents.orgId, orgA), eq(agentEvents.type, "onboarding.document_received")),
      );
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toMatchObject({ documentId: out.id, extractionStatus: "failed" });
  });

  test("the same file twice is a duplicate — not filed or read again", async () => {
    const bytes = strToU8("Payslip April. Gross 100000.");
    const first = await onb.storeOnboardingDocument({
      orgId: orgA,
      applicationId: appDoc,
      candidateId: candDoc,
      offerId: null,
      docType: "payslip",
      fileName: "payslip-apr.txt",
      bytes,
      source: "upload",
    });
    const again = await onb.storeOnboardingDocument({
      orgId: orgA,
      applicationId: appDoc,
      candidateId: candDoc,
      offerId: null,
      docType: "payslip",
      fileName: "payslip-apr.txt",
      bytes,
      source: "careers_inbox",
    });
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
    expect(again.note).toContain("already filed");
    const mine = await db
      .select({ id: onboardingDocuments.id })
      .from(onboardingDocuments)
      .where(
        and(
          eq(onboardingDocuments.orgId, orgA),
          eq(onboardingDocuments.docType, "payslip"),
          eq(onboardingDocuments.applicationId, appDoc),
        ),
      );
    expect(mine.length).toBe(2); // March (above) + April — no third row
  });

  test("a rejected document is not a twin — a resend is filed fresh", async () => {
    const [pending] = await db
      .select({ id: onboardingDocuments.id })
      .from(onboardingDocuments)
      .where(
        and(
          eq(onboardingDocuments.orgId, orgA),
          eq(onboardingDocuments.applicationId, appDoc),
          eq(onboardingDocuments.status, "pending"),
        ),
      );
    await db
      .update(onboardingDocuments)
      .set({ status: "rejected" })
      .where(eq(onboardingDocuments.id, pending!.id));
    const resent = await onb.storeOnboardingDocument({
      orgId: orgA,
      applicationId: appDoc,
      candidateId: candDoc,
      offerId: null,
      docType: "payslip",
      fileName: "payslip-mar.txt",
      bytes: strToU8("Payslip March. Gross 100000."),
      source: "upload",
    });
    expect(resent.duplicate).toBeUndefined();
    expect(resent.id).not.toBe(pending!.id);
    const mine = await db
      .select({ status: onboardingDocuments.status })
      .from(onboardingDocuments)
      .where(
        and(
          eq(onboardingDocuments.orgId, orgA),
          eq(onboardingDocuments.docType, "payslip"),
          eq(onboardingDocuments.applicationId, appDoc),
        ),
      );
    expect(mine.length).toBe(3);
    expect(mine.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(mine.filter((r) => r.status === "pending")).toHaveLength(2);
  });

  test("readiness counts verified-only evidence against the required types", async () => {
    const r = await onb.readinessFor(orgA, appDoc);
    expect(r.applicationId).toBe(appDoc);
    expect(r.verified).toBe(0);
    expect(r.pending).toBe(2);
    expect(r.rejected).toBe(1);
    expect(r.missing).toEqual(onb.REQUIRED_DOC_TYPES);
    expect(r.ready).toBe(false);
  });

  test("every required type verified makes the application ready", async () => {
    for (const t of onb.REQUIRED_DOC_TYPES) await doc(appDoc2, candDoc2, t, {}, "verified");
    const r = await onb.readinessFor(orgA, appDoc2);
    expect(r).toMatchObject({ total: 4, verified: 4, missing: [], ready: true });
  });

  test("a pending optional document never blocks; only verified evidence counts", async () => {
    await doc(appDoc2, candDoc2, "address_proof", {}, "pending");
    const r = await onb.readinessFor(orgA, appDoc2);
    expect(r.total).toBe(5);
    expect(r.verified).toBe(4);
    expect(r.ready).toBe(true); // address proof is optional
    expect(r.pending).toBe(1);
  });

  test("another org's application reads as empty — no cross-org readiness", async () => {
    const r = await onb.readinessFor(orgB, appDoc2);
    expect(r.total).toBe(0);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(onb.REQUIRED_DOC_TYPES);
  });
});

describe("offerContextForEmail (where mailed proofs land)", () => {
  test("files against the candidate's latest offering-stage application and its offer", async () => {
    const ctx = await onb.offerContextForEmail(orgA, `PAY@${dom}`);
    expect(ctx).toEqual({ applicationId: appPay, candidateId: candPay, offerId: offerPay });
  });

  test("a candidate not yet at the offer stage has no filing context", async () => {
    expect(await onb.offerContextForEmail(orgA, `early@${dom}`)).toBeNull();
  });

  test("another org's candidate email resolves to nothing, and so does a stranger's", async () => {
    expect(await onb.offerContextForEmail(orgB, `pay@${dom}`)).toBeNull();
    expect(await onb.offerContextForEmail(orgA, `nobody@${dom}`)).toBeNull();
  });
});

describe("compensationReading (the chronological pay reconciliation)", () => {
  const EMP = "Acme Technologies";

  test("no documents yield no figure — the basis says what to collect", async () => {
    const r = await onb.compensationReading(orgA, appB1);
    expect(r.lastDrawnAnnual).toBeNull();
    expect(r.confident).toBe(false);
    expect(r.timeline).toEqual([]);
    expect(r.basis).toContain("No payslip or revision letter yields a figure yet");
    expect(r.currency).toBe("INR");
  });

  test("three consecutive verified payslips annualise against the live offer", async () => {
    for (const m of [monthAgo(2), monthAgo(1), monthAgo(0)])
      await doc(appPay, candPay, "payslip", {
        period_iso: m,
        monthly_fixed_gross: 100000,
        employer: EMP,
        currency: "inr",
      });
    const r = await onb.compensationReading(orgA, appPay);
    expect(r.lastDrawnAnnual).toBe(1200000);
    expect(r.currency).toBe("INR");
    expect(r.basis).toContain(`${monthAgo(0)} payslip`);
    expect(r.basis).toContain("annualised");
    expect(r.timeline).toHaveLength(3);
    expect(r.timeline[0]!.onIso).toBe(`${monthAgo(0)}-01`);
    expect(r.validatedEvidence).toBe(3);
    expect(r.totalEvidence).toBe(3);
    expect(r.conflicts).toEqual([]);
    expect(r.gaps).toEqual([]);
    expect(r.confident).toBe(true);
    expect(r.offeredAnnual).toBe(1800000);
    expect(r.hikePct).toBe(50);
  });

  test("a gross that still carries a one-off is never annualised whole", async () => {
    await doc(appOneOff, candOneOff, "payslip", {
      period_iso: monthAgo(0),
      gross_pay: 130000,
      monthly_one_off: 30000,
      employer: EMP,
      currency: "INR",
    });
    const r = await onb.compensationReading(orgA, appOneOff);
    expect(r.lastDrawnAnnual).toBe(1200000);
    expect(r.timeline[0]!.oneOff).toBe(30000);
    expect(r.timeline[0]!.reads).toContain("30000 paid once");
    expect(r.gaps.join(" ")).toContain("1 dated payslip(s) on file");
    expect(r.confident).toBe(false);
  });

  test("a revision effective before the newest payslip governs — and a 25% drift is a conflict, not an average", async () => {
    for (const m of [monthAgo(2), monthAgo(1), monthAgo(0)])
      await doc(appRev, candRev, "payslip", {
        period_iso: m,
        monthly_fixed_gross: 100000,
        employer: EMP,
        currency: "INR",
      });
    await doc(appRev, candRev, "salary_revision", {
      effective_from_iso: `${monthAgo(1)}-01`,
      annual_ctc: 1500000,
      employer: EMP,
      currency: "INR",
    });
    const r = await onb.compensationReading(orgA, appRev);
    expect(r.lastDrawnAnnual).toBe(1500000);
    expect(r.basis).toContain("Revision letter effective");
    expect(r.basis).toContain("cross-checked");
    expect(r.conflicts.join(" ")).toContain("differ by 25%");
    expect(r.confident).toBe(false);
  });

  test("a revision effective after the newest payslip is not yet proven as drawn pay", async () => {
    await doc(appFuture, candFuture, "payslip", {
      period_iso: monthAgo(0),
      monthly_fixed_gross: 100000,
      employer: EMP,
      currency: "INR",
    });
    await doc(appFuture, candFuture, "salary_revision", {
      effective_from_iso: `${monthAgo(-6)}-01`,
      annual_ctc: 2000000,
      currency: "INR",
    });
    const r = await onb.compensationReading(orgA, appFuture);
    expect(r.lastDrawnAnnual).toBe(1200000);
    expect(r.gaps.join(" ")).toContain("not yet proven as drawn pay");
  });

  test("service letters surface employment gaps between employers", async () => {
    await doc(appGap, candGap, "experience_letter", {
      employed_from_iso: "2020-01-01",
      employed_to_iso: "2024-06-30",
      employer: "Old Corp",
      designation: "Engineer",
    });
    await doc(appGap, candGap, "experience_letter", {
      employed_from_iso: "2025-01-15",
      employer: "New Tech",
    });
    const r = await onb.compensationReading(orgA, appGap);
    expect(r.lastDrawnAnnual).toBeNull();
    expect(r.gaps.join(" ")).toContain("7 months unaccounted for");
    expect(r.timeline).toHaveLength(2);
  });

  test("a merged upload is reconciled part by part, never averaged", async () => {
    await doc(appParts, candParts, "payslip", {
      currency: "INR",
      contains_multiple_documents: true,
      parts: [
        {
          part_label: "Payslip Aug",
          period_iso: monthAgo(3),
          monthly_fixed_gross: 90000,
          currency: "INR",
          pages: "1",
        },
        {
          part_label: "Payslip Nov",
          period_iso: monthAgo(0),
          monthly_fixed_gross: 90000,
          currency: "USD",
          pages: "2",
        },
      ],
    });
    const r = await onb.compensationReading(orgA, appParts);
    expect(r.timeline).toHaveLength(2);
    expect(r.timeline[0]!.fileName).toContain("Payslip Nov");
    expect(r.lastDrawnAnnual).toBe(1080000); // the newest part annualised alone
    expect(r.conflicts.join(" ")).toContain("more than one currency");
    expect(r.gaps.join(" ")).toContain("not consecutive");
  });

  test("another org's documents and offer contribute nothing", async () => {
    const r = await onb.compensationReading(orgB, appPay);
    expect(r.lastDrawnAnnual).toBeNull();
    expect(r.offeredAnnual).toBeNull();
    expect(r.hikePct).toBeNull();
    expect(r.timeline).toEqual([]);
    expect(r.totalEvidence).toBe(0);
  });
});

describe("reviewOnboardingDocCore (role gate, org scoping, trail)", () => {
  let pendingId: string;
  beforeAll(async () => {
    pendingId = await doc(appDoc, candDoc, "id_proof", { holder_name: "Asha" }, "pending");
  });

  test("an interviewer-only member and a hiring manager cannot validate", async () => {
    await expect(
      reviewOnboardingDocCore(
        { orgId: orgA, userId: panelA, memberEmail: `panel@${dom}` },
        { id: pendingId, decision: "verified" },
      ),
    ).rejects.toThrow("Only TA or HR can validate pre-onboarding documents.");
    await expect(
      reviewOnboardingDocCore(
        { orgId: orgA, userId: hmA, memberEmail: `hm@${dom}` },
        { id: pendingId, decision: "rejected", note: "blurry" },
      ),
    ).rejects.toThrow("Only TA or HR can validate pre-onboarding documents.");
  });

  test("another org's reviewer gets 'no longer here' — the doc id is org-scoped", async () => {
    await expect(
      reviewOnboardingDocCore(
        { orgId: orgB, userId: ownerB, memberEmail: `owner-b@${dom}` },
        { id: pendingId, decision: "verified" },
      ),
    ).rejects.toThrow("That document is no longer here.");
    const [row] = await db
      .select({ status: onboardingDocuments.status })
      .from(onboardingDocuments)
      .where(eq(onboardingDocuments.id, pendingId));
    expect(row!.status).toBe("pending"); // untouched
  });

  test("a rejection without a reason is refused — the candidate must be told", async () => {
    await expect(
      reviewOnboardingDocCore(
        { orgId: orgA, userId: taA, memberEmail: `ta@${dom}` },
        { id: pendingId, decision: "rejected", note: "   " },
      ),
    ).rejects.toThrow("Say why the document is rejected");
  });

  test("a recruiter's verification records the reviewer and the audit trail", async () => {
    await expect(
      reviewOnboardingDocCore(
        { orgId: orgA, userId: taA, memberEmail: `ta@${dom}` },
        { id: pendingId, decision: "verified" },
      ),
    ).resolves.toEqual({ ok: true });
    const [row] = await db
      .select({
        status: onboardingDocuments.status,
        reviewedBy: onboardingDocuments.reviewedBy,
        reviewedAt: onboardingDocuments.reviewedAt,
        reviewNote: onboardingDocuments.reviewNote,
      })
      .from(onboardingDocuments)
      .where(eq(onboardingDocuments.id, pendingId));
    expect(row!.status).toBe("verified");
    expect(row!.reviewedBy).toBe(taA);
    expect(row!.reviewedAt).not.toBeNull();
    const audits = await db
      .select({ action: auditLog.action, actorUserId: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "onboarding_document_verified")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorUserId).toBe(taA);
  });

  test("re-opening clears the reviewer; an HR head's rejection emits the resend event", async () => {
    await reviewOnboardingDocCore(
      { orgId: orgA, userId: hrA, memberEmail: `hr@${dom}` },
      { id: pendingId, decision: "pending" },
    );
    let [row] = await db
      .select({
        status: onboardingDocuments.status,
        reviewedBy: onboardingDocuments.reviewedBy,
        reviewedAt: onboardingDocuments.reviewedAt,
      })
      .from(onboardingDocuments)
      .where(eq(onboardingDocuments.id, pendingId));
    expect(row).toMatchObject({ status: "pending", reviewedBy: null, reviewedAt: null });

    await reviewOnboardingDocCore(
      { orgId: orgA, userId: hrA, memberEmail: `hr@${dom}` },
      { id: pendingId, decision: "rejected", note: "Name does not match the offer" },
    );
    [row] = await db
      .select({
        status: onboardingDocuments.status,
        reviewNote: onboardingDocuments.reviewNote,
        reviewedBy: onboardingDocuments.reviewedBy,
      })
      .from(onboardingDocuments)
      .where(eq(onboardingDocuments.id, pendingId));
    expect(row).toMatchObject({
      status: "rejected",
      reviewNote: "Name does not match the offer",
      reviewedBy: hrA,
    });
    const audits = await db
      .select({ action: auditLog.action, detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "onboarding_document_rejected")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({
      docType: "id_proof",
      note: "Name does not match the offer",
    });
    const events = await db
      .select({ payload: agentEvents.payload })
      .from(agentEvents)
      .where(
        and(eq(agentEvents.orgId, orgA), eq(agentEvents.type, "onboarding.document_rejected")),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      documentId: pendingId,
      docType: "id_proof",
      reason: "Name does not match the offer",
    });
  });
});

/* ------------------------------------------------------------- HRMS sync */

describe("HRMS provider catalogue (hrms.ts)", () => {
  test("the two providers carry their credential fields and allow-listed hosts", () => {
    expect(hrms.HRMS_PROVIDERS.map((p) => p.provider)).toEqual(["keka", "greythr"]);
    const keka = hrms.hrmsProviderMeta("keka")!;
    expect(keka.credentialFields).toEqual(["client_id", "client_secret", "api_key"]);
    expect(keka.allowedHosts).toEqual(["api.keka.com"]);
    expect(keka.needsBaseUrl).toBe(false);
    const greythr = hrms.hrmsProviderMeta("greythr")!;
    expect(greythr.credentialFields).toEqual(["api_key"]);
    expect(greythr.allowedHosts).toEqual(["greythr.com"]);
    expect(greythr.needsBaseUrl).toBe(true);
    expect(hrms.hrmsProviderMeta("workday")).toBeUndefined();
  });
});

describe("HRMS connections (ensureHrmsConnections)", () => {
  test("provisions both providers disabled, hrms-category, scoped to the org", async () => {
    for (const org of [orgA, orgB]) {
      const rows = await db
        .select({
          provider: sourceIntegrations.provider,
          enabled: sourceIntegrations.enabled,
          credentialFields: sourceIntegrations.credentialFields,
        })
        .from(sourceIntegrations)
        .where(and(eq(sourceIntegrations.orgId, org), eq(sourceIntegrations.category, "hrms")));
      expect(new Set(rows.map((r) => r.provider))).toEqual(new Set(["keka", "greythr"]));
      expect(rows.every((r) => r.enabled === false)).toBe(true);
      expect(rows.find((r) => r.provider === "greythr")!.credentialFields).toEqual(["api_key"]);
    }
  });

  test("re-provisioning is a no-op and never crosses orgs", async () => {
    await hrmsServer.ensureHrmsConnections(orgA);
    const a = await db
      .select({ id: sourceIntegrations.id })
      .from(sourceIntegrations)
      .where(and(eq(sourceIntegrations.orgId, orgA), eq(sourceIntegrations.category, "hrms")));
    expect(a).toHaveLength(2);
    const b = await db
      .select({ provider: sourceIntegrations.provider })
      .from(sourceIntegrations)
      .where(and(eq(sourceIntegrations.orgId, orgB), eq(sourceIntegrations.category, "hrms")));
    expect(b).toHaveLength(2);
  });
});

describe("assertHrmsBaseUrl (the SSRF boundary)", () => {
  test("refuses garbage, plain http and embedded credentials", () => {
    expect(() => hrmsServer.assertHrmsBaseUrl("keka", "not a url")).toThrow("not a valid URL");
    expect(() => hrmsServer.assertHrmsBaseUrl("keka", "http://api.keka.com")).toThrow(
      "must use https",
    );
    expect(() => hrmsServer.assertHrmsBaseUrl("keka", "https://user:pass@api.keka.com")).toThrow(
      "Credentials in URLs are not allowed",
    );
  });

  test("refuses hosts outside the provider's allow-list, naming the vendor", () => {
    expect(() => hrmsServer.assertHrmsBaseUrl("keka", `https://evil-${stamp}.example`)).toThrow(
      "not an approved Keka HRMS endpoint",
    );
    // greytHR's approved host may not stand in for Keka
    expect(() => hrmsServer.assertHrmsBaseUrl("keka", "https://greythr.com")).toThrow(
      "not an approved Keka HRMS endpoint",
    );
  });

  test("allows the vendor host, dot-suffix subdomains and the env extra; strips the trailing slash", () => {
    expect(hrmsServer.assertHrmsBaseUrl("keka", "https://api.keka.com/")).toBe(
      "https://api.keka.com",
    );
    expect(hrmsServer.assertHrmsBaseUrl("keka", "https://x.api.keka.com/v1")).toBe(
      "https://x.api.keka.com/v1",
    );
    expect(hrmsServer.assertHrmsBaseUrl("greythr", `https://${syncHost}/`)).toBe(
      `https://${syncHost}`,
    );
  });

  test("an unknown provider has no allow-list at all", () => {
    expect(() => hrmsServer.assertHrmsBaseUrl("workday", "https://api.keka.com")).toThrow(
      "Unknown HRMS provider",
    );
  });
});

describe("testHrmsProvider (probe refusals and failure mapping)", () => {
  test("an unknown provider fails without probing", async () => {
    const out = await hrmsServer.testHrmsProvider("workday" as never, {}, {});
    expect(out.status).toBe("failed");
    expect(out.message).toContain("Unknown HRMS provider");
  });

  test("missing credentials are pending, naming every field", async () => {
    const out = await hrmsServer.testHrmsProvider("keka", {}, {});
    expect(out.status).toBe("pending");
    expect(out.message).toContain("client_id");
    expect(out.message).toContain("api_key");
  });

  test("credentials without the tenant base URL are pending for greytHR", async () => {
    const out = await hrmsServer.testHrmsProvider("greythr", { api_key: `k-${stamp}` }, {});
    expect(out.status).toBe("pending");
    expect(out.message).toContain("base URL");
  });

  test("a connection the network cannot reach becomes a failed outcome, never a throw", async () => {
    const out = await hrmsServer.testHrmsProvider(
      "greythr",
      { api_key: `k-${stamp}` },
      { base_url: `https://${syncHost}` },
    );
    expect(out.status).toBe("failed");
    expect(out.message).toContain("greytHR test failed");
  });
});

describe("syncHrmsEmployees (refusals and failure recording)", () => {
  test("a connection id from another org is 'not found' — the id is org-scoped", async () => {
    await expect(
      hrmsServer.syncHrmsEmployees({ orgId: orgA, integrationId: bKeka }),
    ).rejects.toThrow("HRMS connection not found.");
    await expect(
      hrmsServer.syncHrmsEmployees({ orgId: orgA, integrationId: crypto.randomUUID() }),
    ).rejects.toThrow("HRMS connection not found.");
  });

  test("a disabled connection refuses with the vendor label", async () => {
    await expect(
      hrmsServer.syncHrmsEmployees({ orgId: orgA, integrationId: aKeka }),
    ).rejects.toThrow("disabled on the Integrations page");
  });

  test("an unreachable vendor records a failed run: state row, lastError and the audit", async () => {
    await db
      .update(sourceIntegrations)
      .set({ enabled: true, config: { base_url: `https://${syncHost}` } as never })
      .where(eq(sourceIntegrations.id, aGreythr));
    await integrations.writeSecrets(aGreythr, { api_key: `greythr-${stamp}` });

    const out = await hrmsServer.syncHrmsEmployees({
      orgId: orgA,
      integrationId: aGreythr,
      actor: `owner@${dom}`,
    });
    expect(out.status).toBe("failed");
    expect(out.upserted).toBe(0);
    expect(out.error).toContain("ENOTFOUND");

    const [state] = await db
      .select({
        lastRunStatus: hrmsSyncState.lastRunStatus,
        lastError: hrmsSyncState.lastError,
        stats: hrmsSyncState.stats,
      })
      .from(hrmsSyncState)
      .where(and(eq(hrmsSyncState.integrationId, aGreythr), eq(hrmsSyncState.entity, "employees")));
    expect(state!.lastRunStatus).toBe("failed");
    expect(state!.lastError).toContain("ENOTFOUND");
    expect(state!.stats).toMatchObject({ fetched: 0, upserted: 0 });

    const audits = await db
      .select({ action: auditLog.action, actor: auditLog.actor })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "hrms.sync.failed")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe(`owner@${dom}`);

    const employees = await db
      .select({ id: hrmsEmployees.id })
      .from(hrmsEmployees)
      .where(eq(hrmsEmployees.orgId, orgA));
    expect(employees).toHaveLength(0); // nothing half-written
  });
});

describe("the cached employee master (org scoping and forgetting)", () => {
  beforeAll(async () => {
    await db.insert(hrmsEmployees).values([
      {
        orgId: orgA,
        integrationId: aKeka,
        externalId: "e1",
        fullName: "Ravi Employee",
        department: "Engineering",
      } as never,
      {
        orgId: orgA,
        integrationId: aKeka,
        externalId: "e2",
        fullName: "Sana Employee",
        department: "Finance",
      } as never,
    ]);
    await db.insert(hrmsSyncState).values({
      orgId: orgA,
      integrationId: aKeka,
      entity: "employees",
      lastRunStatus: "ok",
    } as never);
  });

  test("hrmsSyncOverview is org-scoped: own rows with own cache counts only", async () => {
    const a = await hrmsServer.hrmsSyncOverview(orgA);
    expect(a.map((r) => r.integrationId).sort()).toEqual([aGreythr, aKeka].sort());
    expect(a.find((r) => r.integrationId === aKeka)!.cached).toBe(2);
    expect(a.find((r) => r.integrationId === aKeka)!.state?.lastRunStatus).toBe("ok");
    expect(a.find((r) => r.integrationId === aGreythr)!.cached).toBe(0);
    const b = await hrmsServer.hrmsSyncOverview(orgB);
    expect(b.map((r) => r.integrationId).sort()).toEqual([bGreythr, bKeka].sort());
    expect(b.every((r) => r.cached === 0)).toBe(true); // org A's cache never leaks in
  });

  test("forgetHrmsCache drops one connection's cache and state, leaving the rest", async () => {
    await hrmsServer.forgetHrmsCache(aKeka);
    const left = await db
      .select({ id: hrmsEmployees.id })
      .from(hrmsEmployees)
      .where(eq(hrmsEmployees.orgId, orgA));
    expect(left).toHaveLength(0);
    const states = await db
      .select({ id: hrmsSyncState.id })
      .from(hrmsSyncState)
      .where(eq(hrmsSyncState.integrationId, aKeka));
    expect(states).toHaveLength(0);
    const [row] = await db
      .select({ enabled: sourceIntegrations.enabled })
      .from(sourceIntegrations)
      .where(eq(sourceIntegrations.id, aKeka));
    expect(row!.enabled).toBe(false); // the connection itself survives a cache forget
  });
});
