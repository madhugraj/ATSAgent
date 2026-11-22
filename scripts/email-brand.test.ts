/**
 * E-mail branding (src/lib/email-templates/send-email.ts): an organisation's
 * colour replaces the placeholder everywhere, kept readable behind white
 * text; its logo travels as an inline cid: attachment; without branding the
 * header falls back to a monogram.
 */
import { describe, expect, test } from "bun:test";

const { renderTemplateEmail, readableBrandColor } =
  await import("../src/lib/email-templates/send-email");
const { BRAND } = await import("../src/lib/email-templates/email-layout");

const data = {
  memberName: "Ravi",
  orgName: "Acme Robotics",
  heading: "REQ-1 is waiting for your approval",
  message: "It has waited 3 days.",
  actionUrl: "https://example.test/r/1",
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);

describe("readable brand colour", () => {
  test("a dark colour is kept; a pale one is darkened to 4.5:1 against white", () => {
    expect(readableBrandColor("#0f766e")).toBe("#0f766e");
    const pale = readableBrandColor("#facc15");
    expect(pale).not.toBe("#facc15");
    const lum = (h: string) =>
      [1, 3, 5]
        .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    expect(1.05 / (lum(pale) + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(readableBrandColor("not-a-colour")).toBe(BRAND);
  });
});

describe("rendering", () => {
  test("org colour replaces the placeholder and the logo is an inline attachment", async () => {
    const r = await renderTemplateEmail("member_reminder", data, {
      orgName: "Acme Robotics",
      color: "#0f766e",
      logo: { bytes: png, contentType: "image/png" },
    });
    expect(r.html.toLowerCase()).not.toContain(BRAND);
    expect(r.html).toContain("#0f766e");
    expect(r.html).toContain('src="cid:org-logo"');
    expect(r.inline).toHaveLength(1);
    expect(r.inline[0]!.contentType).toBe("image/png");
  });

  test("no logo: a monogram of the organisation's initials, no attachment", async () => {
    const r = await renderTemplateEmail("member_reminder", data, {
      orgName: "Acme Robotics",
      color: "#0f766e",
      logo: null,
    });
    expect(r.inline).toHaveLength(0);
    expect(r.html).toContain(">AR<");
    expect(r.html).not.toContain("cid:");
  });

  test("platform mail (no org) keeps the ATSIQ look", async () => {
    const r = await renderTemplateEmail("member_reminder", data, null);
    expect(r.html.toLowerCase()).toContain(BRAND);
    expect(r.inline).toHaveLength(0);
  });

  test("the summary leads with counts, then reminders, then issues", async () => {
    const { template } = await import("../src/lib/email-templates/agent-digest");
    const r = await renderTemplateEmail("agent_digest", template.previewData, null);
    const t = r.text;
    expect(t).toContain("Waiting for you");
    expect(t).toContain("Critical issues");
    expect(t.lastIndexOf("Waiting for you")).toBeLessThan(t.indexOf("Agent issues still open"));
  });
});
