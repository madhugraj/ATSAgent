import * as React from "react";
import { render } from "@react-email/render";
import nodemailer from "nodemailer";
import { TEMPLATES, type TemplateData } from "./registry";

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

  const templateData = options.templateData ?? {};
  const element = React.createElement(template.component, templateData);
  const html = await render(element);
  const text = await render(element, { plainText: true });
  const subject =
    typeof template.subject === "function" ? template.subject(templateData) : template.subject;
  const from = process.env["EMAIL_FROM"] || `${SITE_NAME} <noreply@${FROM_DOMAIN}>`;

  const smtpUrl = process.env["SMTP_URL"];
  if (!smtpUrl) {
    throw new Error("Email is not configured: set SMTP_URL");
  }

  const transporter = nodemailer.createTransport(smtpUrl);
  await transporter.sendMail({
    from,
    to: recipient,
    subject,
    html,
    text,
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    ...(options.attachments?.length
      ? {
          attachments: options.attachments.map((a) => ({
            filename: a.filename,
            content: Buffer.from(a.contentBase64, "base64"),
            contentType: a.contentType,
          })),
        }
      : {}),
    headers: { "X-ATSIQ-Idempotency-Key": options.idempotencyKey || crypto.randomUUID() },
  });
  return { sent: true };
}
