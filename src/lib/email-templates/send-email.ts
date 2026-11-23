import * as React from "react";
import { render } from "@react-email/render";
import nodemailer from "nodemailer";
import { TEMPLATES, type TemplateData } from "./registry";
import { BRAND, EmailBrandCtx } from "./email-layout";

// Server-only: sends over SMTP_URL. Never import from client components.

const SITE_NAME = "ATSIQ";
// Domain shown in the default From: header; override with EMAIL_FROM.
const FROM_DOMAIN = "atsiq.yavar.ai";

export type SendTemplateEmailResult = { sent: true };

export interface EmailAttachment {
  filename: string;
  contentBase64: string;
  contentType: string;
}

export interface SendTemplateEmailOptions {
  templateData?: TemplateData;
  /** Dedupes retries of the same logical send; defaults to a random UUID (no dedupe). */
  idempotencyKey?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  /** The organisation the e-mail is sent for: themes it with its logo and colour. */
  orgId?: string | null;
}

/** Relative luminance (WCAG) of "#rrggbb". */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * The brand colour, darkened just enough that white button text on it meets
 * WCAG AA (4.5:1) — a pale brand colour would otherwise make buttons unreadable.
 */
export function readableBrandColor(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return BRAND;
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let i = 0; i < 30; i++) {
    const h = `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
    if (1.05 / (luminance(h) + 0.05) >= 4.5) return h;
    [r, g, b] = [r, g, b].map((v) => Math.floor(v! * 0.92));
  }
  return "#111827";
}

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  inline: { cid: string; content: Buffer; contentType: string }[];
};

/**
 * Render a template, themed for the organisation when `orgId` is given: its
 * logo (inline cid: attachment — no public URL) and its colour in place of
 * the BRAND placeholder. Without an org, ATSIQ's own look.
 */
export async function renderTemplateEmail(
  templateName: string,
  templateData: TemplateData = {},
  /** An org id (branding loaded from the database) or a brand given directly (previews). */
  org?: string | import("@/server/email-brand.server").EmailBrand | null,
): Promise<RenderedEmail> {
  const template = TEMPLATES[templateName];
  if (!template) {
    throw new Error(
      `Template '${templateName}' not found. Available: ${Object.keys(TEMPLATES).join(", ")}`,
    );
  }
  let color = BRAND;
  const inline: RenderedEmail["inline"] = [];
  let logoSrc: string | null = null;
  if (org) {
    const { loadEmailBrand, BRAND_LOGO_CID } = await import("@/server/email-brand.server");
    const brand = typeof org === "string" ? await loadEmailBrand(org) : org;
    if (brand) {
      color = readableBrandColor(brand.color);
      if (brand.logo) {
        logoSrc = `cid:${BRAND_LOGO_CID}`;
        inline.push({
          cid: BRAND_LOGO_CID,
          content: Buffer.from(brand.logo.bytes),
          contentType: brand.logo.contentType,
        });
      }
    }
  }
  const element = React.createElement(
    EmailBrandCtx.Provider,
    { value: { logoSrc } },
    React.createElement(template.component, templateData),
  );
  const swap = (h: string) =>
    color.toLowerCase() === BRAND ? h : h.replace(new RegExp(BRAND, "gi"), color);
  const html = swap(await render(element));
  const text = await render(element, { plainText: true });
  const subject =
    typeof template.subject === "function" ? template.subject(templateData) : template.subject;
  return { subject, html, text, inline };
}

/**
 * Renders a registered template and sends it over the deployment's SMTP
 * relay (SMTP_URL). Any transport failure throws; the email outbox
 * (src/lib/email-outbox.server.ts) owns retries.
 */
export async function sendTemplateEmail(
  templateName: string,
  to: string,
  options: SendTemplateEmailOptions = {},
): Promise<SendTemplateEmailResult> {
  const template = TEMPLATES[templateName];
  if (!template) {
    throw new Error(
      `Template '${templateName}' not found. Available: ${Object.keys(TEMPLATES).join(", ")}`,
    );
  }

  // Template-level `to` takes precedence — notification templates always
  // send to their fixed address.
  const recipient = template.to || to;
  if (!recipient) {
    throw new Error("Recipient is required (the template defines no fixed recipient)");
  }

  const { subject, html, text, inline } = await renderTemplateEmail(
    templateName,
    options.templateData ?? {},
    options.orgId,
  );
  const from = process.env["EMAIL_FROM"] || `${SITE_NAME} <noreply@${FROM_DOMAIN}>`;

  const smtpUrl = process.env["SMTP_URL"];
  if (!smtpUrl) {
    throw new Error("Email is not configured: set SMTP_URL");
  }

  // Test runs share .env.local, whose SMTP relay reaches real inboxes: render
  // and "send" in memory instead, so a test never e-mails a real person.
  const transporter =
    process.env["NODE_ENV"] === "test"
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport(smtpUrl);
  await transporter.sendMail({
    from,
    to: recipient,
    subject,
    html,
    text,
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    ...(options.attachments?.length || inline.length
      ? {
          attachments: [
            ...inline.map((a) => ({
              filename: "logo",
              cid: a.cid,
              content: a.content,
              contentType: a.contentType,
              contentDisposition: "inline" as const,
            })),
            ...(options.attachments ?? []).map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.contentBase64, "base64"),
              contentType: a.contentType,
            })),
          ],
        }
      : {}),
    headers: { "X-ATSIQ-Idempotency-Key": options.idempotencyKey || crypto.randomUUID() },
  });
  return { sent: true };
}
