/**
 * Comms domain behaviour lockdown (pre-@ats/* package extraction):
 *  - the e-mail outbox keeps its per-org gates (master switch, per-kind
 *    toggles, the hourly ack cap scoped to one org), dedupes on the
 *    idempotency key, supersedes queued stage updates (sent rows and blank
 *    recipients untouched), releases/drops held mail only for its own org
 *    with SQL wildcards escaped, and drains only due queued rows (success
 *    marks sent, failure backs off exponentially and fails at five attempts);
 *  - org e-mail settings fall back to the defaults and persist per org; the
 *    reply-to override beats the careers address; the timezone formatter
 *    fails over to UTC on a bad zone;
 *  - the local careers inbox never turns a board relay into a candidate,
 *    resolves the tenant from the careers address before the inbox slug,
 *    treats duplicate deliveries and CV-less mail as skipped, and scopes
 *    retry/pending-mail to one org's rows;
 *  - branding loads per org (default colour on a non-hex value, foreign logo
 *    paths never fetched, cached within TTL until cleared);
 *  - sending refuses an unknown template and an unset SMTP_URL with
 *    vendor-neutral errors, and renders a pass-through brand;
 *  - buildIcs stays RFC-5545 with escaped text and CRLF lines.
 * Run: DATABASE_URL=postgres://…/atsagent_test bun test scripts/comms-domain.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

const savedEnv = {
  SMTP_URL: process.env.SMTP_URL,
  NODE_ENV: process.env.NODE_ENV,
};

const { db } = await import("../src/server/db");
const {
  applications,
  candidates,
  emailOutbox,
  emailSettings,
  inboxMessages,
  organizations,
  requisitions,
} = await import("../drizzle/schema");
const outbox = await import("../src/lib/email-outbox.server");
const inbox = await import("../src/lib/local-inbox.server");
const brand = await import("../src/server/email-brand.server");
const send = await import("../src/lib/email-templates/send-email");
const { buildIcs } = await import("../src/lib/ics");

const stamp = Date.now();
const INBOX_DOMAIN = inbox.INBOX_DOMAIN;
const REPLY_OVERRIDE = `reply.${stamp}@example.com`;

let orgA: string; // fully provisioned org: settings row + careers address
let orgB: string; // second org for every scoping assertion
let orgInactive: string; // suspended org: receiveMail must refuse it
let orgSlugClash: string; // inbox slug equal to orgA's careers local part
let appA: string; // orgA application for stage-update supersession

function orgValues(slug: string, extra: Record<string, unknown> = {}) {
  return { name: `Comms Org ${slug}`, slug, inboxSlug: slug, status: "active", ...extra };
}

async function insertOrg(slug: string, extra: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(organizations)
    .values(orgValues(slug, extra) as never)
    .returning({ id: organizations.id });
  return row!.id;
}

async function outboxCount(orgId: string, key?: string, kind?: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.orgId, orgId),
        ...(key ? [eq(emailOutbox.idempotencyKey, key)] : []),
        ...(kind ? [eq(emailOutbox.kind, kind as never)] : []),
      ),
    );
  return row?.count ?? 0;
}

async function outboxRow(orgId: string, key: string) {
  const [row] = await db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.idempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

async function insertMail(orgId: string, values: Record<string, unknown>) {
  const [row] = await db
    .insert(inboxMessages)
    .values({ orgId, receivedAt: new Date(), ...values } as never)
    .returning({
      id: inboxMessages.id,
      status: inboxMessages.status,
      detail: inboxMessages.detail,
    });
  return row!;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  // Sends must stay in-memory: nodemailer jsonTransport under NODE_ENV=test.
  if (process.env.NODE_ENV !== "test") process.env.NODE_ENV = "test";
  if (!process.env.SMTP_URL) process.env.SMTP_URL = "smtp://127.0.0.1:2525";

  orgA = await insertOrg(`commo${stamp}`, {
    careersEmail: `cbox${stamp}@example.com`,
    emailDomain: "example.com",
  });
  orgB = await insertOrg(`commx${stamp}`);
  orgInactive = await insertOrg(`susps${stamp}`, { status: "suspended" });
  orgSlugClash = await insertOrg(`cbox${stamp}`, {
    careersEmail: `own${stamp}@example.com`,
    emailDomain: "example.com",
  });

  // orgA's settings: everything on, reply-to override, org timezone.
  await db.insert(emailSettings).values({
    orgId: orgA,
    enabled: true,
    ackEnabled: true,
    stageEnabled: true,
    interviewEnabled: true,
    offerEnabled: true,
    replyTo: REPLY_OVERRIDE,
    timezone: "Asia/Kolkata",
  } as never);

  const reqId = (
    await db
      .insert(requisitions)
      .values({
        orgId: orgA,
        code: `REQ-C-${stamp}`,
        title: "Comms Engineer",
        status: "approved",
        createdBy: null,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
  const [c] = await db
    .insert(candidates)
    .values({
      orgId: orgA,
      fullName: "Comms Candidate",
      email: `cand${stamp}@example.com`,
    } as never)
    .returning({ id: candidates.id });
  appA = (
    await db
      .insert(applications)
      .values({ orgId: orgA, requisitionId: reqId, candidateId: c!.id } as never)
      .returning({ id: applications.id })
  )[0]!.id;
});

afterAll(async () => {
  // Organisations cascade: settings, outbox, inbox mail, requisitions,
  // candidates and applications all go with them.
  await db
    .delete(organizations)
    .where(inArray(organizations.id, [orgA, orgB, orgInactive, orgSlugClash].filter(Boolean)));
  if (savedEnv.SMTP_URL === undefined) delete process.env.SMTP_URL;
  else process.env.SMTP_URL = savedEnv.SMTP_URL;
  if (savedEnv.NODE_ENV !== undefined) process.env.NODE_ENV = savedEnv.NODE_ENV;
});

describe("email-outbox: settings, reply address, timezone", () => {
  test("an org without a settings row gets exactly the defaults", async () => {
    const { DEFAULT_EMAIL_SETTINGS } = await import("../src/lib/email-settings.shared");
    expect(await outbox.getOrgEmailSettings(crypto.randomUUID())).toEqual(DEFAULT_EMAIL_SETTINGS);
  });

  test("a persisted row wins over the defaults, scoped to its org", async () => {
    const s = await outbox.getOrgEmailSettings(orgA);
    expect(s).toMatchObject({ enabled: true, stageEnabled: true, replyTo: REPLY_OVERRIDE });
    // orgB has no row of its own yet — it must not see orgA's override.
    expect((await outbox.getOrgEmailSettings(orgB)).replyTo).toBeNull();
  });

  test("careersReplyAddress: the reply-to override beats the careers address", async () => {
    expect(await outbox.careersReplyAddress(orgA)).toBe(REPLY_OVERRIDE);
  });

  test("formatInOrgTZ renders in the org zone; a bad zone falls back to UTC", () => {
    const d = new Date("2026-01-15T10:30:00Z");
    expect(outbox.formatInOrgTZ(d, "Asia/Kolkata")).toContain("16:00");
    const fallback = outbox.formatInOrgTZ(d, "Mars/Olympus");
    expect(fallback).toContain("(UTC)");
    expect(fallback).toContain("10:30:00");
  });
});

describe("email-outbox: enqueueEmail toggles, dedupe, ack cap", () => {
  test("master switch off writes nothing, for any kind", async () => {
    await db.insert(emailSettings).values({ orgId: orgB, enabled: false } as never);
    await outbox.enqueueEmail({
      orgId: orgB,
      kind: "ack",
      templateName: "application_ack",
      toEmail: `a@${stamp}.example`,
      idempotencyKey: `comm${stamp}-off-ack`,
    });
    await outbox.enqueueEmail({
      orgId: orgB,
      kind: "member_reminder",
      templateName: "member_reminder",
      toEmail: `m@${stamp}.example`,
      idempotencyKey: `comm${stamp}-off-rem`,
    });
    expect(await outboxCount(orgB)).toBe(0);
  });

  test("a kind toggle off silences that kind only; null-toggle kinds still enqueue", async () => {
    await db
      .update(emailSettings)
      .set({ enabled: true, ackEnabled: false, stageEnabled: false })
      .where(eq(emailSettings.orgId, orgB));
    await outbox.enqueueEmail({
      orgId: orgB,
      kind: "ack",
      templateName: "application_ack",
      toEmail: `a@${stamp}.example`,
      idempotencyKey: `comm${stamp}-tok-ack`,
    });
    await outbox.enqueueEmail({
      orgId: orgB,
      kind: "stage_update",
      templateName: "stage_update",
      toEmail: `s@${stamp}.example`,
      applicationId: appA,
      idempotencyKey: `comm${stamp}-tok-stage`,
    });
    expect(await outboxCount(orgB, undefined, "ack")).toBe(0);
    expect(await outboxCount(orgB, undefined, "stage_update")).toBe(0);

    await outbox.enqueueEmail({
      orgId: orgB,
      kind: "member_reminder",
      templateName: "member_reminder",
      toEmail: `  Priya@Example.COM  `,
      availableAt: new Date(Date.now() + 3_600_000), // keep it out of any drain
      idempotencyKey: `comm${stamp}-tok-rem`,
    });
    const row = await outboxRow(orgB, `comm${stamp}-tok-rem`);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("queued");
    expect(row!.toEmail).toBe("priya@example.com");
    // Reply-to falls back to the org's own careers-inbox address.
    expect(row!.replyTo).toBe(inbox.inboxAddress(orgB.inboxSlug ?? `commx${stamp}`));
  });

  test("the same idempotency key enqueues exactly one row", async () => {
    const key = `comm${stamp}-idem`;
    for (let i = 0; i < 2; i++)
      await outbox.enqueueEmail({
        orgId: orgA,
        kind: "member_reminder",
        templateName: "member_reminder",
        toEmail: `idem${i}@example.com`,
        availableAt: new Date(Date.now() + 3_600_000),
        idempotencyKey: key,
      });
    expect(await outboxCount(orgA, key)).toBe(1);
  });

  test("another org's acks never count toward the hourly cap", async () => {
    // 50 acks already queued for orgB within the hour: orgA's first ack must
    // still be queued (locks the eq(orgId) predicate on the cap count).
    await db.insert(emailOutbox).values(
      Array.from({ length: 50 }, (_, i) => ({
        orgId: orgB,
        kind: "ack",
        templateName: "application_ack",
        toEmail: `capb${i}@example.com`,
        idempotencyKey: `comm${stamp}-capb-${i}`,
        availableAt: new Date(Date.now() + 7_200_000),
      })) as never,
    );
    await outbox.enqueueEmail({
      orgId: orgA,
      kind: "ack",
      templateName: "application_ack",
      toEmail: "cap-first@example.com",
      availableAt: new Date(Date.now() + 3_600_000),
      idempotencyKey: `comm${stamp}-cap-first`,
    });
    expect((await outboxRow(orgA, `comm${stamp}-cap-first`))!.status).toBe("queued");
  });

  test("the org's own 51st ack within the hour lands as suppressed", async () => {
    await db.insert(emailOutbox).values(
      Array.from({ length: 50 }, (_, i) => ({
        orgId: orgA,
        kind: "ack",
        templateName: "application_ack",
        toEmail: `capa${i}@example.com`,
        idempotencyKey: `comm${stamp}-capa-${i}`,
        availableAt: new Date(Date.now() + 7_200_000),
      })) as never,
    );
    await outbox.enqueueEmail({
      orgId: orgA,
      kind: "ack",
      templateName: "application_ack",
      toEmail: "cap-51st@example.com",
      idempotencyKey: `comm${stamp}-cap-51`,
    });
    expect((await outboxRow(orgA, `comm${stamp}-cap-51`))!.status).toBe("suppressed");
  });
});

describe("email-outbox: stage-update supersession", () => {
  test("a newer stage update suppresses the queued one, never the sent one", async () => {
    await db.insert(emailOutbox).values([
      {
        orgId: orgA,
        applicationId: appA,
        kind: "stage_update",
        templateName: "stage_update",
        toEmail: "old@example.com",
        idempotencyKey: `comm${stamp}-sup-old`,
        status: "queued",
        availableAt: new Date(Date.now() + 3_600_000),
      },
      {
        orgId: orgA,
        applicationId: appA,
        kind: "stage_update",
        templateName: "stage_update",
        toEmail: "sent@example.com",
        idempotencyKey: `comm${stamp}-sup-sent`,
        status: "sent",
        sentAt: new Date(),
        availableAt: new Date(Date.now() + 3_600_000),
      },
    ] as never);
    await outbox.enqueueStageUpdates(
      [
        {
          applicationId: appA,
          toEmail: "  New@Example.COM ",
          templateData: { candidateName: "Comms Candidate" },
          idempotencyKey: `comm${stamp}-sup-new`,
        },
        {
          applicationId: appA,
          toEmail: "   ",
          templateData: {},
          idempotencyKey: `comm${stamp}-sup-blank`,
        },
      ],
      {
        orgId: orgA,
        settings: {
          enabled: true,
          ackEnabled: true,
          stageEnabled: true,
          interviewEnabled: true,
          offerEnabled: true,
          replyTo: null,
          timezone: "Asia/Kolkata",
        },
      },
    );
    const old = await outboxRow(orgA, `comm${stamp}-sup-old`);
    expect(old!.status).toBe("suppressed");
    expect(old!.lastError).toBe("superseded by a newer stage update");
    expect((await outboxRow(orgA, `comm${stamp}-sup-sent`))!.status).toBe("sent");
    const fresh = await outboxRow(orgA, `comm${stamp}-sup-new`);
    expect(fresh).not.toBeNull();
    expect(fresh!.toEmail).toBe("new@example.com");
    expect(fresh!.kind).toBe("stage_update");
    expect(await outboxCount(orgA, `comm${stamp}-sup-blank`)).toBe(0);
  });

  test("stage toggles off, or the master switch off, write nothing", async () => {
    const base = {
      enabled: true,
      ackEnabled: true,
      stageEnabled: true,
      interviewEnabled: true,
      offerEnabled: true,
      replyTo: null,
      timezone: "Asia/Kolkata",
    };
    await outbox.enqueueStageUpdates(
      [
        {
          applicationId: appA,
          toEmail: "x@example.com",
          templateData: {},
          idempotencyKey: `comm${stamp}-sup-tg`,
        },
      ],
      { orgId: orgA, settings: { ...base, stageEnabled: false } },
    );
    await outbox.enqueueStageUpdates(
      [
        {
          applicationId: appA,
          toEmail: "x@example.com",
          templateData: {},
          idempotencyKey: `comm${stamp}-sup-ms`,
        },
      ],
      { orgId: orgA, settings: { ...base, enabled: false } },
    );
    expect(await outboxCount(orgA, `comm${stamp}-sup-tg`)).toBe(0);
    expect(await outboxCount(orgA, `comm${stamp}-sup-ms`)).toBe(0);
  });

  test("KNOWN HOLE, pinned: supersession has no eq(orgId) and suppresses another org's queued row for the same applicationId", async () => {
    // supersedeQueuedStageUpdates filters by applicationId+kind+status only.
    // application ids are globally unique so this is safe today, but the
    // project invariant demands eq(emailOutbox.orgId, ...) on every tenant
    // query — when that predicate is added, FLIP this assertion to expect
    // 'queued' (the foreign row untouched).
    const foreignKey = `comm${stamp}-sup-foreign`;
    await db.insert(emailOutbox).values({
      orgId: orgB, // another org's outbox row referencing orgA's application
      applicationId: appA,
      kind: "stage_update",
      templateName: "stage_update",
      toEmail: "foreign@example.com",
      idempotencyKey: foreignKey,
      status: "queued",
      availableAt: new Date(Date.now() + 3_600_000),
    } as never);
    await outbox.enqueueStageUpdates(
      [
        {
          applicationId: appA,
          toEmail: "newer@example.com",
          templateData: {},
          idempotencyKey: `comm${stamp}-sup-newer`,
        },
      ],
      {
        orgId: orgA,
        settings: {
          enabled: true,
          ackEnabled: true,
          stageEnabled: true,
          interviewEnabled: true,
          offerEnabled: true,
          replyTo: null,
          timezone: "Asia/Kolkata",
        },
      },
    );
    expect((await outboxRow(orgB, foreignKey))!.status).toBe("suppressed");
  });
});

describe("email-outbox: held mail release/drop", () => {
  test("release and drop touch only this org's held rows, with wildcards escaped", async () => {
    const mk = (orgId: string, suffix: string, held: boolean) => ({
      orgId,
      kind: "interview_invite" as const,
      templateName: "interview_invite",
      toEmail: `held-${suffix}@example.com`,
      idempotencyKey: `comm${stamp}${suffix}`,
      status: held ? ("held" as const) : ("queued" as const),
      availableAt: new Date(Date.now() + 7_200_000),
    });
    // orgA: one row matching the literal '%', one that only matches if '%'
    // is a wildcard; orgB: same prefix, must never be touched.
    await db
      .insert(emailOutbox)
      .values([
        mk(orgA, "%hld-a", true),
        mk(orgA, "Zhld-b", true),
        mk(orgB, "%hld-c", true),
      ] as never);

    // The prefix's % is escaped: only the literal-% row releases.
    const released = await outbox.releaseHeldEmails(orgA, `comm${stamp}%hld`);
    expect(released).toBe(1);
    // Releasing also starts a send in the background: the row may already be sent.
    expect(["queued", "sending", "sent"]).toContain(
      (await outboxRow(orgA, `comm${stamp}%hld-a`))!.status,
    );
    expect((await outboxRow(orgA, `comm${stamp}Zhld-b`))!.status).toBe("held");
    expect((await outboxRow(orgB, `comm${stamp}%hld-c`))!.status).toBe("held");

    await outbox.dropHeldEmails(orgA, `comm${stamp}Zhld`);
    expect((await outboxRow(orgA, `comm${stamp}Zhld-b`))!.status).toBe("suppressed");
    expect((await outboxRow(orgB, `comm${stamp}%hld-c`))!.status).toBe("held");
  });
});

describe("email-outbox: processEmailOutbox drain", () => {
  test("a due queued row is sent: status sent, sentAt set, lastError cleared", async () => {
    const key = `comm${stamp}-drain-ok`;
    await db.insert(emailOutbox).values({
      orgId: orgA,
      kind: "member_reminder",
      templateName: "application_ack",
      toEmail: `drain-ok-${stamp}@example.com`,
      idempotencyKey: key,
      replyTo: REPLY_OVERRIDE,
      status: "queued",
      availableAt: new Date(Date.now() - 1_000),
    } as never);
    const counts = await outbox.processEmailOutbox({ max: 25 });
    expect(counts.sent).toBeGreaterThanOrEqual(1); // global drain: own row counted somewhere
    const row = await outboxRow(orgA, key);
    expect(row!.status).toBe("sent");
    expect(row!.sentAt).not.toBeNull();
    expect(row!.lastError).toBeNull();
  });

  test("max is clamped into 1..100 — max 0 still drains one due row", async () => {
    const key = `comm${stamp}-drain-clamp`;
    await db.insert(emailOutbox).values({
      orgId: orgA,
      kind: "member_reminder",
      templateName: "application_ack",
      toEmail: `drain-clamp-${stamp}@example.com`,
      idempotencyKey: key,
      status: "queued",
      availableAt: new Date(Date.now() - 1_000),
    } as never);
    await outbox.processEmailOutbox({ max: 0 });
    expect((await outboxRow(orgA, key))!.status).toBe("sent");
  });

  test("a throwing send requeues with backoff and never marks sent", async () => {
    const key = `comm${stamp}-drain-err`;
    await db.insert(emailOutbox).values({
      orgId: orgA,
      kind: "member_reminder",
      templateName: `not-a-template-${stamp}`,
      toEmail: `drain-err-${stamp}@example.com`,
      idempotencyKey: key,
      status: "queued",
      availableAt: new Date(Date.now() - 1_000),
    } as never);
    await outbox.processEmailOutbox({ max: 25 });
    const row = await outboxRow(orgA, key);
    expect(row!.status).not.toBe("sent");
    expect(row!.attempts).toBeGreaterThanOrEqual(1);
    expect(row!.lastError).toContain("not found");
    if (row!.status === "queued")
      expect(row!.availableAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  test("the fifth failed attempt marks the row failed with the truncated error", async () => {
    const key = `comm${stamp}-drain-fail`;
    await db.insert(emailOutbox).values({
      orgId: orgA,
      kind: "member_reminder",
      templateName: `not-a-template-${stamp}`,
      toEmail: `drain-fail-${stamp}@example.com`,
      idempotencyKey: key,
      attempts: 4,
      status: "queued",
      availableAt: new Date(Date.now() - 1_000),
    } as never);
    await outbox.processEmailOutbox({ max: 25 });
    const row = await outboxRow(orgA, key);
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(5);
    expect(row!.lastError).toContain("not found");
    expect((row!.lastError ?? "").length).toBeLessThanOrEqual(500);
  });

  test("only due queued rows are claimed: held, suppressed and future rows stay put", async () => {
    const keys = {
      held: `comm${stamp}-claim-held`,
      sup: `comm${stamp}-claim-sup`,
      future: `comm${stamp}-claim-future`,
    };
    await db.insert(emailOutbox).values([
      {
        orgId: orgA,
        kind: "member_reminder",
        templateName: "application_ack",
        toEmail: "claim-held@example.com",
        idempotencyKey: keys.held,
        status: "held",
        availableAt: new Date(Date.now() - 1_000),
      },
      {
        orgId: orgA,
        kind: "member_reminder",
        templateName: "application_ack",
        toEmail: "claim-sup@example.com",
        idempotencyKey: keys.sup,
        status: "suppressed",
        availableAt: new Date(Date.now() - 1_000),
      },
      {
        orgId: orgA,
        kind: "member_reminder",
        templateName: "application_ack",
        toEmail: "claim-future@example.com",
        idempotencyKey: keys.future,
        status: "queued",
        availableAt: new Date(Date.now() + 3_600_000),
      },
    ] as never);
    await outbox.processEmailOutbox({ max: 25 });
    expect((await outboxRow(orgA, keys.held))!.status).toBe("held");
    expect((await outboxRow(orgA, keys.sup))!.status).toBe("suppressed");
    expect((await outboxRow(orgA, keys.future))!.status).toBe("queued");
  });
});

describe("local-inbox: pure address helpers", () => {
  test("inboxAddress normalises the slug and refuses empties", () => {
    expect(inbox.inboxAddress(`  Acme-${stamp} `)).toBe(`acme-${stamp}@${INBOX_DOMAIN}`);
    expect(inbox.inboxAddress(null)).toBeNull();
    expect(inbox.inboxAddress("   ")).toBeNull();
  });

  test("localPart strips +tags and display-name brackets", () => {
    expect(inbox.localPart(`Sub +tag <Acme+promo@Example.COM>`)).toBe("acme");
    expect(inbox.localPart(`plain+news@Example.com`)).toBe("plain");
  });

  test("recipientAddresses extracts every bare address from the header", () => {
    expect(inbox.recipientAddresses(`A <a@x.com>, b@y.com , <c@z.com>`)).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
    expect(inbox.recipientAddresses("no address here")).toEqual([]);
  });

  test("displayName splits the header form and lower-cases the address", () => {
    expect(inbox.displayName("Priya R <Priya@Ex.COM>")).toEqual({
      email: "priya@ex.com",
      name: "Priya R",
    });
    expect(inbox.displayName("plain@x.com")).toEqual({ email: "plain@x.com", name: null });
  });

  test("emailInText finds the first address in free text", () => {
    expect(inbox.emailInText("reach me at First.Last+news@Example.co.in today")).toBe(
      "first.last+news@example.co.in",
    );
    expect(inbox.emailInText("no address")).toBeNull();
  });
});

describe("local-inbox: applicantSender relay guard", () => {
  test("board relays and senderless addresses never become an applicant", () => {
    for (const email of [
      "no-reply@board.example",
      "donotreply@portal.example",
      "notifications@linkedin.example",
      "alerts@jobs.example",
      "jobs@board.example",
      "careers@company.example",
      "hr@company.example",
      "talent@company.example",
      "recruit@company.example",
      "garbage-without-at",
    ])
      expect(inbox.applicantSender({ email, name: "Imposter" })).toBeNull();
    expect(
      inbox.applicantSender({ email: "  Priya.Sharma@Example.COM ", name: "Priya Sharma" }),
    ).toEqual({ email: "priya.sharma@example.com", name: "Priya Sharma" });
  });
});

describe("local-inbox: receiveMail transport outcomes", () => {
  test("mail to an address no org owns is an error, nothing recorded", async () => {
    const res = await inbox.receiveMail({
      to: `nosuch${stamp}@${INBOX_DOMAIN}`,
      from: `appl${stamp}@example.com`,
    });
    expect(res.status).toBe("error");
    expect(res.detail).toContain(`No organisation owns the address nosuch${stamp}`);
    expect(res.messageId).toBeNull();
  });

  test("a suspended organisation's inbox refuses mail", async () => {
    const res = await inbox.receiveMail({
      to: `susps${stamp}@${INBOX_DOMAIN}`,
      from: `appl${stamp}@example.com`,
    });
    expect(res.status).toBe("error");
    expect(res.detail).toBe("That organisation is not active.");
  });

  test("a duplicate provider delivery is skipped (dedupe survives the drizzle wrap)", async () => {
    // FLIPPED from the KNOWN BUG pin: receiveMail's 23505 check now walks the
    // drizzle 0.45 wrap (the PG code sits on .cause, as runtime.server.ts
    // isActiveRunConflict already does), so the intended outcome holds.
    await insertMail(orgA, {
      toAddress: `commo${stamp}@${INBOX_DOMAIN}`,
      providerMessageId: `pm-${stamp}`,
      status: "received",
    });
    const res = await inbox.receiveMail({
      to: `commo${stamp}@${INBOX_DOMAIN}`,
      from: `appl${stamp}@example.com`,
      messageId: `pm-${stamp}`,
    });
    expect(res.status).toBe("skipped");
    expect(res.detail).toBe("Already received.");
    // at least the unique index still refused the second row
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(inboxMessages)
      .where(
        and(eq(inboxMessages.orgId, orgA), eq(inboxMessages.providerMessageId, `pm-${stamp}`)),
      );
    expect(count!.count).toBe(1);
  });

  test("the careers address resolves before the inbox slug, and CV-less mail is skipped", async () => {
    // localPart of orgA's careers address equals orgSlugClash's inbox slug:
    // the careersEmail branch must win.
    const res = await inbox.receiveMail({
      to: `cbox${stamp}@example.com`,
      from: `Applicant <appl${stamp}@example.com>`,
    });
    expect(res.status).toBe("skipped"); // no CV, no pre-onboarding docs
    expect(res.detail).toContain("No CV attached");
    expect(res.messageId).not.toBeNull();
    const [row] = await db
      .select({ orgId: inboxMessages.orgId, status: inboxMessages.status })
      .from(inboxMessages)
      .where(eq(inboxMessages.id, res.messageId!));
    expect(row!.orgId).toBe(orgA);
    expect(row!.status).toBe("skipped");
  });
});

describe("local-inbox: retryMessage + processPendingMail scoping", () => {
  test("retrying another org's message finds nothing and writes nothing", async () => {
    const foreign = await insertMail(orgB, {
      subject: "Foreign CV",
      body: "x".repeat(200), // long enough to retry IF the org filter is dropped
      status: "error",
    });
    const res = await inbox.retryMessage(orgA, foreign.id);
    expect(res.status).toBe("error");
    expect(res.detail).toBe("That mail is no longer here.");
    const [after] = await db
      .select({ status: inboxMessages.status, detail: inboxMessages.detail })
      .from(inboxMessages)
      .where(eq(inboxMessages.id, foreign.id));
    expect(after!.status).toBe("error");
    expect(after!.detail).toBeNull();
  });

  test("a stored body too short to be a CV refuses the retry", async () => {
    const short = await insertMail(orgA, { body: "too short", status: "error" });
    const res = await inbox.retryMessage(orgA, short.id);
    expect(res.status).toBe("error");
    expect(res.detail).toContain("no readable CV text");
  });

  test("processPendingMail scans only this org's pending rows, respecting the limit", async () => {
    await insertMail(orgA, { body: "pending body one", status: "received" });
    await insertMail(orgA, { body: "pending body two", status: "received" });
    await insertMail(orgB, { body: "foreign pending body", status: "received" });

    const [pending] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(inboxMessages)
      .where(
        and(
          eq(inboxMessages.orgId, orgA),
          inArray(inboxMessages.status, ["received", "stored", "error"]),
        ),
      );
    const expected = pending!.count;

    const scan = await inbox.processPendingMail(orgA, 25);
    expect(scan.scanned).toBe(expected);
    // every scanned row has a too-short body, so all land as errors
    expect(scan.errors + scan.skipped).toBe(expected);
    expect(scan.imported + scan.updated).toBe(0);

    const limited = await inbox.processPendingMail(orgA, 2);
    expect(limited.scanned).toBe(2);
  });
});

describe("email-brand: loadEmailBrand", () => {
  test("an unknown org has no brand", async () => {
    expect(await brand.loadEmailBrand(crypto.randomUUID())).toBeNull();
  });

  test("a non-hex colour falls back to the default; a foreign logo path is never fetched", async () => {
    await db
      .update(organizations)
      .set({ brandColor: "not-a-colour", brandLogoPath: `99999999/branding/evil.png` })
      .where(eq(organizations.id, orgA));
    brand.clearEmailBrandCache(orgA);
    const b = await brand.loadEmailBrand(orgA);
    expect(b).not.toBeNull();
    expect(b!.color).toBe(brand.DEFAULT_BRAND_COLOR);
    expect(b!.logo).toBeNull();
  });

  test("the brand is cached within the TTL until clearEmailBrandCache forces a re-read", async () => {
    await db
      .update(organizations)
      .set({ brandColor: "#123456", brandLogoPath: null })
      .where(eq(organizations.id, orgA));
    brand.clearEmailBrandCache(orgA);
    expect((await brand.loadEmailBrand(orgA))!.color).toBe("#123456");

    await db.update(organizations).set({ brandColor: "#654321" }).where(eq(organizations.id, orgA));
    expect((await brand.loadEmailBrand(orgA))!.color).toBe("#123456"); // cached

    brand.clearEmailBrandCache(orgA);
    expect((await brand.loadEmailBrand(orgA))!.color).toBe("#654321");
  });
});

describe("send-email: sendTemplateEmail + renderTemplateEmail", () => {
  test("an unknown template throws listing the available ones", async () => {
    await expect(send.sendTemplateEmail(`nope-${stamp}`, "x@example.com")).rejects.toThrow(
      /Available: .*application_ack/,
    );
    await expect(send.renderTemplateEmail(`nope-${stamp}`)).rejects.toThrow("Available:");
  });

  test("an unset transport fails vendor-neutral before any transport is created", async () => {
    // With the Graph fallback, SMTP_URL alone no longer decides "configured":
    // scrub the Graph credentials too, or .env.local machines would send (or
    // real-POST) instead of throwing.
    const graphKeys = [
      "MICROSOFT_OAUTH_TENANT_ID",
      "MICROSOFT_OAUTH_CLIENT_ID",
      "MICROSOFT_OAUTH_CLIENT_SECRET",
    ];
    const hadGraph = graphKeys.map((k) => [k, process.env[k]] as const);
    for (const k of graphKeys) delete process.env[k];
    const had = process.env.SMTP_URL;
    delete process.env.SMTP_URL;
    try {
      await expect(
        send.sendTemplateEmail("application_ack", `x-${stamp}@example.com`),
      ).rejects.toThrow("Email is not configured: set SMTP_URL");
    } finally {
      if (had === undefined) delete process.env.SMTP_URL;
      else process.env.SMTP_URL = had;
      for (const [k, v] of hadGraph) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("a configured send renders and 'sends' in memory under NODE_ENV=test", async () => {
    expect(await send.sendTemplateEmail("application_ack", `x-${stamp}@example.com`)).toEqual({
      sent: true,
    });
  });

  test("renderTemplateEmail accepts a brand object directly and themes the layout", async () => {
    const color = send.readableBrandColor("#112233");
    const rendered = await send.renderTemplateEmail(
      "email-confirmation",
      { siteName: "ATSIQ" },
      {
        orgName: "Comms Org",
        color: "#112233",
        logo: null,
      },
    );
    expect(rendered.html).toContain(color);
    expect(rendered.subject).toContain("ATSIQ");
  });
});

describe("ics: buildIcs", () => {
  test("RFC-5545 output: CRLF, headers, UTC stamps, escaping, attendees", () => {
    const ics = buildIcs({
      uid: `comm-${stamp}@example.com`,
      title: "Interview, with; R&D\nRound 1",
      description: "Discuss, the; role",
      location: null,
      startsAt: "2026-03-01T10:00:00Z",
      durationMins: 30,
      attendees: ["a@example.com", "b@example.com"],
    });
    expect(ics).toStartWith("BEGIN:VCALENDAR");
    expect(ics).toEndWith("END:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:-//Yavar ATS//Interviews//EN");
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain(`UID:comm-${stamp}@example.com`);
    expect(ics).toContain("DTSTART:20260301T100000Z");
    expect(ics).toContain("DTEND:20260301T103000Z");
    expect(ics).toContain("SUMMARY:Interview\\, with\\; R&D\\nRound 1");
    expect(ics).toContain("DESCRIPTION:Discuss\\, the\\; role");
    expect(ics).not.toContain("LOCATION:");
    expect(ics.match(/ATTENDEE;RSVP=TRUE:mailto:/g)).toHaveLength(2);
    expect(ics).toContain("ATTENDEE;RSVP=TRUE:mailto:a@example.com");
    expect(ics).toContain("\r\n");
  });
});

describe("reminder kinds after #87/#90: interview_reminder, interviewer_reminder, panel_mobile_ask", () => {
  test("interview_reminder is candidate mail: gated by the org's interview toggle", async () => {
    await db
      .update(emailSettings)
      .set({ enabled: true, interviewEnabled: false })
      .where(eq(emailSettings.orgId, orgB));
    await outbox.enqueueEmail({
      orgId: orgB,
      kind: "interview_reminder",
      templateName: "interview_reminder",
      toEmail: `cand-${stamp}@example.com`,
      applicationId: appA,
      idempotencyKey: `comm${stamp}-ir-off`,
    });
    expect(await outboxCount(orgB, undefined, "interview_reminder")).toBe(0);

    await db
      .update(emailSettings)
      .set({ interviewEnabled: true })
      .where(eq(emailSettings.orgId, orgB));
    await outbox.enqueueEmail({
      orgId: orgB,
      kind: "interview_reminder",
      templateName: "interview_reminder",
      toEmail: `cand-${stamp}@example.com`,
      applicationId: appA,
      idempotencyKey: `comm${stamp}-ir-on`,
    });
    const row = await outboxRow(orgB, `comm${stamp}-ir-on`);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("queued");
  });

  test("interviewer_reminder and panel_mobile_ask are internal: no kind toggle gates them", async () => {
    await db
      .update(emailSettings)
      .set({
        enabled: true,
        ackEnabled: false,
        stageEnabled: false,
        interviewEnabled: false,
        offerEnabled: false,
      })
      .where(eq(emailSettings.orgId, orgB));
    await outbox.enqueueEmail({
      orgId: orgB,
      kind: "interviewer_reminder",
      templateName: "interviewer_reminder",
      toEmail: `panel-${stamp}@example.com`,
      idempotencyKey: `comm${stamp}-ivr`,
    });
    await outbox.enqueueEmail({
      orgId: orgB,
      kind: "panel_mobile_ask",
      templateName: "panel_mobile_ask",
      toEmail: `panel-${stamp}@example.com`,
      idempotencyKey: `comm${stamp}-pma`,
    });
    expect(await outboxCount(orgB, undefined, "interviewer_reminder")).toBe(1);
    expect(await outboxCount(orgB, undefined, "panel_mobile_ask")).toBe(1);

    // …but the master switch still silences internal mail.
    await db.update(emailSettings).set({ enabled: false }).where(eq(emailSettings.orgId, orgB));
    await outbox.enqueueEmail({
      orgId: orgB,
      kind: "panel_mobile_ask",
      templateName: "panel_mobile_ask",
      toEmail: `panel-${stamp}@example.com`,
      idempotencyKey: `comm${stamp}-pma-off`,
    });
    expect(await outboxCount(orgB, `comm${stamp}-pma-off`)).toBe(0);
    await db.update(emailSettings).set({ enabled: true }).where(eq(emailSettings.orgId, orgB));
  });

  test("the registry registers both new templates and renders them with real subjects", async () => {
    const { TEMPLATES } = await import("../src/lib/email-templates/registry");
    expect(Object.keys(TEMPLATES)).toContain("interview_reminder");
    expect(Object.keys(TEMPLATES)).toContain("panel_mobile_ask");

    const brandObj = { orgName: "Comms Org", color: "#112233", logo: null };
    const reminder = await send.renderTemplateEmail(
      "interview_reminder",
      {
        audience: "candidate",
        step: "day",
        recipientName: "Asha",
        candidateName: "Asha",
        orgName: "Comms Org",
        jobTitle: "Senior Backend Engineer",
        roundLabel: "L2 interview",
        scheduledAtText: "tomorrow at 10:00",
        durationMins: "60",
        modeLabel: "Online",
        withText: "the hiring team",
      },
      brandObj,
    );
    expect(reminder.subject).toBe(
      "Reminder: your L2 interview is tomorrow — Senior Backend Engineer",
    );
    expect(reminder.html).toContain("Asha");
    expect(reminder.html).toContain("tomorrow at 10:00");

    const panel = await send.renderTemplateEmail(
      "panel_mobile_ask",
      { firstName: "Sivakami", orgName: "Comms Org", actionUrl: "https://example.com/pm" },
      brandObj,
    );
    expect(panel.subject).toBe("Add your mobile for interview time checks");
    expect(panel.html).toContain("Add my mobile");
    const again = await send.renderTemplateEmail("panel_mobile_ask", { again: "yes" }, brandObj);
    expect(again.subject).toBe("Reminder: add your mobile for interview time checks");

    // interviewer_reminder has no template on purpose: it is raw member mail
    // enqueued by interview-reminders.server, so the registry must NOT know it.
    expect(Object.keys(TEMPLATES)).not.toContain("interviewer_reminder");
  });
});
