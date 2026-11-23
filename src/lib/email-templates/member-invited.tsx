import * as React from "react";
import { Button, Section } from "@react-email/components";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles, primaryButton } from "./email-layout";

/** A colleague was added to the organisation; sent for (and branded as) the organisation. */
interface Props {
  siteName?: string;
  siteUrl?: string;
  orgName?: string;
  inviteeName?: string;
  inviterName?: string;
  roleLabel?: string;
  title?: string;
  email?: string;
}

const { text, detail } = layoutStyles;

const Email = ({
  siteName = "ATSIQ",
  siteUrl = "https://atsiq.yavar.ai",
  orgName = "your organisation",
  inviteeName,
  inviterName,
  roleLabel = "Recruiter",
  title,
  email,
}: Props) => (
  <EmailLayout
    preview={`You have been added to ${orgName} as ${roleLabel}`}
    orgName={orgName}
    siteName={siteName}
    siteUrl={siteUrl}
    heading={`Welcome to the ${orgName} hiring workspace`}
    greeting={inviteeName ? `Hi ${inviteeName},` : "Hello,"}
  >
    <p style={text}>
      {inviterName ?? "Your administrator"} added you as <strong>{roleLabel}</strong>
      {title ? ` (${title})` : ""}. Requisitions, candidates, interviews and the hiring agents that
      need your decisions are all in one place.
    </p>
    <Section style={{ margin: "22px 0" }}>
      <Button href={siteUrl} style={primaryButton}>
        Sign in
      </Button>
    </Section>
    <p style={detail}>
      Sign in with {email ? <strong>{email}</strong> : "this email address"}; your role is applied
      the first time you do.
    </p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `You have been added to ${data["orgName"] ?? "your organisation"} on ATSIQ`,
  displayName: "Team member invited",
  previewData: {
    siteName: "ATSIQ",
    siteUrl: "https://atsiq.yavar.ai",
    orgName: "Yavar TechWorks",
    inviteeName: "Saranya",
    inviterName: "Madhu",
    roleLabel: "Recruiter",
    title: "Talent Partner",
    email: "saranya.r@yavar.ai",
  },
} satisfies TemplateEntry;
