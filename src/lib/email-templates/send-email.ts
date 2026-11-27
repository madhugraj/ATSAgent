import * as React from "react";
import { render } from "@react-email/render";
import nodemailer from "nodemailer";
import { TEMPLATES, type TemplateData } from "./registry";
import { BRAND, EmailBrandCtx } from "./email-layout";

// Server-only: sends over SMTP_URL or Microsoft Graph. Never import from client components.

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

/** True when any mail transport is configured (SMTP_URL or the Graph mail credentials). */
export function emailTransportConfigured(): boolean {
  return Boolean(
    process.env["SMTP_URL"] ||
    (process.env["MICROSOFT_OAUTH_TENANT_ID"] &&
      process.env["MICROSOFT_OAUTH_CLIENT_ID"] &&
      process.env["MICROSOFT_OAUTH_CLIENT_SECRET"]),
  );
}

// Vendor-neutral operator hint for "nothing can send": callers relay error
// messages to clients (e.g. registration), so no transport/vendor branding.
function notConfiguredError(): Error {
  return new Error(
    "Email is not configured: set SMTP_URL, or the OAuth mail credentials " +
      "(MICROSOFT_OAUTH_TENANT_ID, MICROSOFT_OAUTH_CLIENT_ID, MICROSOFT_OAUTH_CLIENT_SECRET)",
  );
}

// Client-credentials token for Graph, cached until shortly before Entra's
// ~60-min expiry — one token per pod instead of one per email.
let graphToken: { value: string; expiresAt: number } | null = null;

async function graphAccessToken(
  tenant: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  if (graphToken && Date.now() < graphToken.expiresAt) return graphToken.value;
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error_description?: unknown } | null;
    const reason =
      detail?.error_description != null ? String(detail.error_description) : `HTTP ${res.status}`;
    throw new Error(`Email token request failed (${reason})`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  graphToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 300) * 1000 };
  return graphToken.value;
}

/**
 * Renders a registered template and sends it. Transport, in order: the
 * deployment's SMTP relay (SMTP_URL), else Microsoft Graph client-credentials
 * sendMail as the EMAIL_FROM mailbox (works where the tenant blocks SMTP
 * basic auth). Any transport failure throws; the email outbox
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

  const mail = {
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
  };

  const smtpUrl = process.env["SMTP_URL"];
  const useGraph = !smtpUrl && emailTransportConfigured();

  // Test runs share .env.local, whose SMTP relay — and, once the Graph mail
  // credentials are set, whose Graph mailbox — reaches real inboxes: render
  // and "send" in memory instead, so a test never e-mails a real person.
  // Graph has no in-memory transport, so test mode downgrades any configured
  // transport to the SMTP jsonTransport.
  if (process.env["NODE_ENV"] === "test") {
    if (!smtpUrl && !useGraph) throw notConfiguredError();
    await nodemailer.createTransport({ jsonTransport: true }).sendMail(mail);
    return { sent: true };
  }

  if (smtpUrl) {
    await nodemailer.createTransport(smtpUrl).sendMail(mail);
    return { sent: true };
  }

  // Microsoft Graph — client-credentials sendMail as the mailbox in EMAIL_FROM
  // (atsiq@yavar.ai in prod). The yavar.ai tenant's security defaults block
  // SMTP basic auth outright, so this is the working transport there; the app
  // registration's Mail.Send permission is admin-consented. The token endpoint
  // must be tenant-specific: /organizations rejects client_credentials with a
  // misleading Conditional Access error (AADSTS53003). Never reached under
  // NODE_ENV=test (downgraded to the in-memory transport above).
  const graphTenant = process.env["MICROSOFT_OAUTH_TENANT_ID"];
  const graphClientId = process.env["MICROSOFT_OAUTH_CLIENT_ID"];
  const graphSecret = process.env["MICROSOFT_OAUTH_CLIENT_SECRET"];
  if (useGraph && graphTenant && graphClientId && graphSecret) {
    const mailboxMatch = /<([^>]+)>/.exec(from);
    const mailbox = mailboxMatch?.[1] ?? from.trim();
    const displayName = mailboxMatch
      ? from.slice(0, mailboxMatch.index).trim().replace(/^"|"$/g, "")
      : undefined;
    const token = await graphAccessToken(graphTenant, graphClientId, graphSecret);
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "HTML", content: html },
            from: {
              emailAddress: { address: mailbox, ...(displayName ? { name: displayName } : {}) },
            },
            toRecipients: [{ emailAddress: { address: recipient } }],
            ...(options.replyTo
              ? { replyTo: [{ emailAddress: { address: options.replyTo } }] }
              : {}),
            ...(inline.length || options.attachments?.length
              ? {
                  attachments: [
                    ...inline.map((a) => ({
                      "@odata.type": "#microsoft.graph.fileAttachment",
                      name: a.cid,
                      contentType: a.contentType,
                      contentBytes: a.content.toString("base64"),
                      contentId: a.cid,
                      isInline: true,
                    })),
                    ...(options.attachments ?? []).map((a) => ({
                      "@odata.type": "#microsoft.graph.fileAttachment",
                      name: a.filename,
                      contentType: a.contentType,
                      contentBytes: a.contentBase64,
                    })),
                  ],
                }
              : {}),
          },
          saveToSentItems: true,
        }),
      },
    );
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: { message?: unknown };
      } | null;
      const reason =
        detail?.error?.message != null ? String(detail.error.message) : `HTTP ${response.status}`;
      throw new Error(`Email send failed (${reason})`);
    }
    return { sent: true };
  }

  throw notConfiguredError();
}
