import * as React from "react";
import { Button, Section } from "@react-email/components";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles, primaryButton } from "./email-layout";

interface Props {
  siteName?: string;
  siteUrl?: string;
  orgName?: string;
  ownerName?: string;
}

const { text } = layoutStyles;
const step = { fontSize: "14px", color: "#374151", lineHeight: "1.6", margin: "0 0 8px" };

const Email = ({
  siteName = "ATSIQ",
  siteUrl = "https://atsiq.yavar.ai",
  orgName = "Your organisation",
  ownerName,
}: Props) => (
  <EmailLayout
    platform
    preview={`${orgName} is approved — your workspace is live`}
    orgName={siteName}
    siteName={siteName}
    siteUrl={siteUrl}
    heading={`${orgName} is approved`}
    greeting={ownerName ? `Hi ${ownerName},` : "Hello,"}
  >
    <p style={text}>Your workspace is live and you are its owner. Three steps get you hiring:</p>
    <p style={step}>
      <strong>1.</strong> Connect your workspace — e-mail, calendar and AI key.
    </p>
    <p style={step}>
      <strong>2.</strong> Invite your HR head, recruiters and hiring managers.
    </p>
    <p style={step}>
      <strong>3.</strong> Describe your organisation, so every agent works from your context.
    </p>
    <Section style={{ margin: "22px 0 8px" }}>
      <Button href={siteUrl} style={primaryButton}>
        Open your workspace
      </Button>
    </Section>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) => `${data["orgName"] ?? "Your organisation"} is approved on ATSIQ`,
  displayName: "Organisation approved",
  previewData: {
    siteName: "ATSIQ",
    siteUrl: "https://atsiq.yavar.ai",
    orgName: "Yavar TechWorks",
    ownerName: "Madhu",
  },
} satisfies TemplateEntry;
