import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  location?: string;
  applyUrl?: string;
  /** Why we thought of them (their earlier application), one short line. */
  context?: string;
}

const { text } = layoutStyles;

/** A past candidate who did well is invited to apply for a new role (approved per send). */
const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "a new role",
  location,
  applyUrl,
  context,
}: Props) => (
  <EmailLayout
    preview={`A new role you may like — ${jobTitle}`}
    orgName={orgName}
    heading="A new role we thought of you for"
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    <p style={text}>
      {context ? `${context} ` : ""}We have a new opening for <strong>{jobTitle}</strong>
      {location ? ` (${location})` : ""} at <strong>{orgName}</strong> that looks like a good fit
      for your experience.
    </p>
    {applyUrl ? (
      <p style={text}>
        If you are interested, you can apply here: <a href={applyUrl}>{applyUrl}</a>
      </p>
    ) : null}
    <p style={text}>
      No pressure — if the timing is not right, simply ignore this email. Reply if you would rather
      not hear from us about future roles.
    </p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) => `A new role you may like — ${data["jobTitle"] ?? "we're hiring"}`,
  displayName: "Invitation to apply (past candidates)",
  previewData: {
    candidateName: "Asha",
    orgName: "Yavar TechWorks",
    jobTitle: "UI/UX Engineer",
    location: "Remote",
    applyUrl: "https://example.com/apply/abc",
    context: "You interviewed with us for Product Designer earlier this year.",
  },
} satisfies TemplateEntry;
