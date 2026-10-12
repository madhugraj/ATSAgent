import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  /** The candidate's private link to accept, decline or ask for changes. */
  respondUrl?: string;
  /** Set when this is a revised offer after the candidate asked for changes. */
  revised?: string;
}

const { text, link } = layoutStyles;

const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "the role",
  respondUrl,
  revised,
}: Props) => (
  <EmailLayout
    preview={`Your offer from ${orgName} for ${jobTitle}`}
    orgName={orgName}
    heading="Your offer letter is here"
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    <p style={text}>
      {revised
        ? "Thank you for your feedback. Here is your revised offer for the "
        : "Congratulations! We are delighted to extend an offer to you for the "}
      <strong>{jobTitle}</strong> position at <strong>{orgName}</strong>.
    </p>
    <p style={text}>
      Your offer letter is attached to this email as a PDF. Please review it carefully.
    </p>
    {respondUrl ? (
      <p style={text}>
        When you are ready, accept it, decline it, or ask for changes here:{" "}
        <a href={respondUrl} style={link}>
          {respondUrl}
        </a>
        . The link is personal to you.
      </p>
    ) : (
      <p style={text}>The recruiting team will reach out to walk you through the details.</p>
    )}
    <p style={text}>We look forward to welcoming you to the team.</p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `Your offer from ${data["orgName"] ?? "us"} — ${data["jobTitle"] ?? ""}`.replace(/\s+/g, " "),
  displayName: "Candidate offer released",
  previewData: {
    candidateName: "Asha",
    orgName: "Yavar TechWorks",
    jobTitle: "Senior Backend Engineer",
  },
} satisfies TemplateEntry;
