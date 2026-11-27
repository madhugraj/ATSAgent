/**
 * Inbound CV mail e2e (Phase 4 Gate 4, source repo): a candidate emails the
 * organisation's careers address with a CV attached, the comms transport
 * (receiveMail, @ats/comms/server) resolves the tenant and hands the mail to
 * the app's registered handler, and a candidate lands in the talent pool with
 * the mail recorded on inbox_messages — the full mail → candidate path The duplicate-delivery case locks the drizzle-0.45 error-wrap fix.
 *
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/inbound-cv-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const { candidates, inboxMessages, organizations, users } = await import("../drizzle/schema");
// The transport and the handler live on opposite sides of the source repo monolith (the refactored repo runs the same receiveMail
// through @ats/comms + the app handler; see its gate twin).
const inbox = await import("../src/lib/local-inbox.server");

const stamp = Date.now();
let orgId: string;
let userId: string;

beforeAll(async () => {
  const url = process.env["DATABASE_URL"] ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  userId = (
    await db
      .insert(users)
      .values({ email: `gate4-owner-${stamp}@test.example` })
      .returning({ id: users.id })
  )[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({
        name: "Gate 4 Org",
        slug: `gate4-${stamp}`,
        careersEmail: `careers-${stamp}@example.com`,
        inboxSlug: `gate4-${stamp}`,
        status: "active",
        ownerUserId: userId,
      })
      .returning({ id: organizations.id })
  )[0]!.id;
});

afterAll(async () => {
  // The handler's candidate belongs to the org; deleting the org cascades
  // candidates and messages. The user goes first (no FK from org).
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
});

describe("inbound CV mail e2e (Gate 4)", () => {
  test("careers mail with a CV attachment creates a talent-pool candidate", async () => {
    const cvText = [
      "ASHA RAO",
      "Senior Backend Engineer",
      "",
      "EXPERIENCE",
      "2021-present: Staff engineer, payments platform. Led the ledger rewrite.",
      "2017-2021: Backend engineer, billing APIs in Go and Postgres.",
      "",
      "SKILLS: Go, Postgres, Kafka, distributed systems",
      "NOTICE: 60 days. Expected CTC: 4400000.",
    ].join("\n");
    const res = await inbox.receiveMail({
      to: `careers-${stamp}@example.com`,
      from: "Asha Rao <asha.rao@example.com>",
      subject: "Application: Senior Backend Engineer",
      text: "Please find my CV attached.",
      messageId: `gate4-${stamp}@mail.example`,
      attachments: [
        {
          filename: "asha-rao-cv.txt",
          contentType: "text/plain",
          content: Buffer.from(cvText, "utf8").toString("base64"),
        },
      ],
    });

    expect(res.status).toBe("imported");
    expect(res.messageId).not.toBeNull();

    // The mail is on record with its outcome.
    const [msg] = await db
      .select()
      .from(inboxMessages)
      .where(
        and(
          eq(inboxMessages.orgId, orgId),
          eq(inboxMessages.providerMessageId, `gate4-${stamp}@mail.example`),
        ),
      );
    expect(msg).toBeDefined();
    expect(msg!.status).toBe("imported");
    expect(msg!.fromEmail).toBe("asha.rao@example.com");
    expect(msg!.attachmentName).toBe("asha-rao-cv.txt");

    // The candidate is in this org's talent pool with the CV text as resume.
    const [cand] = await db
      .select()
      .from(candidates)
      .where(and(eq(candidates.orgId, orgId), eq(candidates.email, "asha.rao@example.com")));
    expect(cand).toBeDefined();
    expect((cand!.fullName ?? "").toLowerCase()).toContain("asha");
    expect((cand!.resumeText ?? "").length).toBeGreaterThan(50);
    expect(cand!.source).toBe(inbox.inboxSource("asha.rao@example.com"));
  });

  test("a mail with no CV attachment is stored and skipped, no candidate", async () => {
    const before = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(eq(candidates.orgId, orgId));
    const res = await inbox.receiveMail({
      to: `careers-${stamp}@example.com`,
      from: "Recruiter <hr@example.com>",
      subject: "Partner question",
      text: "Do you accept agency submissions?",
      messageId: `gate4-nocv-${stamp}@mail.example`,
    });
    expect(res.status).toBe("skipped");
    const after = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(eq(candidates.orgId, orgId));
    expect(after.length).toBe(before.length);
    const [msg] = await db
      .select()
      .from(inboxMessages)
      .where(eq(inboxMessages.providerMessageId, `gate4-nocv-${stamp}@mail.example`));
    expect(msg).toBeDefined();
    expect(msg!.status).toBe("skipped");
  });

  test("a duplicate delivery is skipped, not double-imported", async () => {
    const dupId = `gate4-dup-${stamp}@mail.example`;
    const first = await inbox.receiveMail({
      to: `careers-${stamp}@example.com`,
      from: "Ravi Kumar <ravi.kumar@example.com>",
      subject: "Application: Backend Engineer",
      text: "Please find my CV attached.",
      messageId: dupId,
      attachments: [
        {
          filename: "ravi-kumar-cv.txt",
          contentType: "text/plain",
          content: Buffer.from(
            "RAVI KUMAR\nBackend engineer.\nSKILLS: Go, Postgres",
            "utf8",
          ).toString("base64"),
        },
      ],
    });
    expect(first.status).toBe("imported");
    const res = await inbox.receiveMail({
      to: `careers-${stamp}@example.com`,
      from: "Ravi Kumar <ravi.kumar@example.com>",
      subject: "Application: Backend Engineer",
      text: "Please find my CV attached.",
      messageId: dupId,
    });
    expect(res.status).toBe("skipped");
    expect(res.detail).toBe("Already received.");
  });
});
