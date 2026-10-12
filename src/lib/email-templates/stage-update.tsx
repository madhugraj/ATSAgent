import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  /** Stage-specific headline, e.g. "You have been shortlisted". */
  stageHeading?: string;
  /** Stage-specific body copy (plain sentences, no HTML). */
  stageBody?: string;
  /** "yes" when this is the last word (e.g. not taken further): no "we will write again". */
  final?: string;
}

const { text } = layoutStyles;

const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "the role",
  stageHeading = "Update on your application",
  stageBody,
  final,
}: Props) => (
  <EmailLayout
    preview={`${stageHeading} — ${jobTitle}`}
    orgName={orgName}
    heading={stageHeading}
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    <p style={text}>
      There is an update on your application for <strong>{jobTitle}</strong> with{" "}
      <strong>{orgName}</strong>.
    </p>
    {stageBody ? <p style={text}>{stageBody}</p> : null}
    {final ? null : <p style={text}>We will write again as things progress.</p>}
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `${data["stageHeading"] ?? "Application update"} — ${data["jobTitle"] ?? ""}`.trim(),
  displayName: "Candidate stage update",
  previewData: {
    candidateName: "Asha",
    orgName: "Yavar TechWorks",
    jobTitle: "Senior Backend Engineer",
    stageHeading: "You have been shortlisted",
    stageBody:
      "Your profile stood out for this role, and the recruiting team would like to take it forward to the next round.",
  },
} satisfies TemplateEntry;
