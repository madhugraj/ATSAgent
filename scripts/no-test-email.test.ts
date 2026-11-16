/**
 * Tests never send real e-mail, and reserved test addresses are never mailed
 * (16 November: test runs used up the day's sending quota with bounces).
 * Run: bun test scripts/no-test-email.test.ts
 */
import { describe, expect, test } from "bun:test";

const mail = await import("../src/lib/email-templates/send-email");

describe("e-mail never leaves a test run", () => {
  test("under bun test, a send is kept in memory, even with a relay configured", async () => {
    const before = process.env["SMTP_URL"];
    // A relay that does not exist: if anything tried to connect, the send would throw.
    process.env["SMTP_URL"] = "smtps://user:pass@127.0.0.1:1";
    try {
      const r = await mail.sendTemplateEmail("member_reminder", "someone@gmail.com", {
        templateData: { heading: "Hi", body: "Test" },
      });
      expect(r).toEqual({ sent: true });
      expect(mail.testOutbox.at(-1)).toMatchObject({ to: "someone@gmail.com" });
    } finally {
      if (before === undefined) delete process.env["SMTP_URL"];
      else process.env["SMTP_URL"] = before;
    }
  });

  test("reserved test domains are undeliverable; real ones are not", () => {
    for (const e of [
      "a@test.local",
      "b@cand.local",
      "c@ponb123.test",
      "d@client-1.example",
      "e@example.com",
      "f@no-email.atsiq.local",
      "nobody",
    ])
      expect(mail.undeliverableAddress(e)).toBe(true);
    for (const e of ["vishal@gmail.com", "shalini.m@yavar.ai", "x@example.co.in"])
      expect(mail.undeliverableAddress(e)).toBe(false);
  });
});
