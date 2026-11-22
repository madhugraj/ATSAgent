import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  siteName?: string;
  siteUrl?: string;
  orgName?: string;
  ownerName?: string;
  reason?: string;
}

const { text, detail } = layoutStyles;
const note = {
  fontSize: "14px",
  color: "#374151",
  lineHeight: "1.6",
  margin: "0 0 18px",
  padding: "12px 14px",
  backgroundColor: "#f9fafb",
  borderLeft: "3px solid #d1d5db",
  borderRadius: "6px",
};

const Email = ({
  siteName = "ATSIQ",
  siteUrl = "https://atsiq.yavar.ai",
  orgName = "your organisation",
  ownerName,
  reason,
}: Props) => (
  <EmailLayout
    platform
    preview={`We need a little more before approving ${orgName}`}
    orgName={siteName}
    siteName={siteName}
    siteUrl={siteUrl}
    heading={`We could not approve ${orgName} yet`}
    greeting={ownerName ? `Hi ${ownerName},` : "Hello,"}
  >
    <p style={text}>Thank you for registering. Our review found something to clarify:</p>
    {reason ? <p style={note}>{reason}</p> : null}
    <p style={text}>
      Reply to this email with the corrected details and we reopen the registration — nothing needs
      to be entered again.
    </p>
    <p style={detail}>If you registered by mistake, no action is needed; nothing was activated.</p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `Your ATSIQ registration for ${data["orgName"] ?? "your organisation"} needs attention`,
  displayName: "Organisation rejected",
  previewData: {
    siteName: "ATSIQ",
    siteUrl: "https://atsiq.yavar.ai",
    orgName: "Yavar TechWorks",
    ownerName: "Madhu",
    reason: "We could not verify the registered legal entity from the details provided.",
  },
} satisfies TemplateEntry;
