import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  /** The organisation's confirmed website; the keep-in-touch line is left out without it. */
  websiteUrl?: string;
}

const { text } = layoutStyles;

const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "the role",
  websiteUrl,
}: Props) => (
  <EmailLayout
    preview={`Thank you for applying for ${jobTitle}`}
    orgName={orgName}
    heading="Thank you for applying!"
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    <p style={text}>
      Thank you for taking the time to apply for the <strong>{jobTitle}</strong> position.
    </p>
    <p style={text}>
      Wondering what comes next? We're currently reviewing your profile and carefully matching it
      against the qualifications for this opportunity. Every application, including yours, receives
      the same level of attention from us.
    </p>
    <p style={text}>
      Although we can't offer immediate feedback on individual applications, we'll be in touch if
      your qualifications align with our current needs and we decide to move forward with your
      application.
    </p>
    {websiteUrl ? (
      <p style={text}>
        Want to keep in touch? Follow what we're up to at <a href={websiteUrl}>{websiteUrl}</a>.
      </p>
    ) : null}
    <p style={text}>Together, let's unlock the power of people.</p>
    <p style={text}>
      Best regards,
      <br />
      {orgName} Talent Acquisition Team
    </p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) => `Thank you for applying — ${data["jobTitle"] ?? "your application"}`,
  displayName: "Candidate application acknowledgment",
  previewData: {
    candidateName: "Asha",
    orgName: "Yavar TechWorks",
    jobTitle: "Senior Backend Engineer",
    websiteUrl: "https://yavar.ai",
  },
} satisfies TemplateEntry;
