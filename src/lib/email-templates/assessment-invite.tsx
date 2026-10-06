import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  assessmentUrl?: string;
  dueDate?: string;
  reminder?: string;
}

const { text } = layoutStyles;

const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "the role",
  assessmentUrl,
  dueDate,
  reminder,
}: Props) => (
  <EmailLayout
    preview={`${reminder ? "Reminder: " : ""}a short assessment for ${jobTitle}`}
    orgName={orgName}
    heading={
      reminder ? "A reminder about your assessment" : "A short assessment for your application"
    }
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    <p style={text}>
      As the next step for <strong>{jobTitle}</strong> with <strong>{orgName}</strong>, please
      complete a short written assessment. It takes about 20 minutes.
    </p>
    {assessmentUrl ? (
      <p style={text}>
        Open it here: <a href={assessmentUrl}>{assessmentUrl}</a>
      </p>
    ) : null}
    {dueDate ? <p style={text}>Please complete it by {dueDate}.</p> : null}
    <p style={text}>The link is personal to you — please do not share it.</p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `${data["reminder"] ? "Reminder: " : ""}Assessment for ${data["jobTitle"] ?? "your application"}`,
  displayName: "Candidate assessment invitation",
  previewData: {
    candidateName: "Asha",
    orgName: "Yavar TechWorks",
    jobTitle: "Senior Backend Engineer",
    assessmentUrl: "https://example.com/assess/abc",
    dueDate: "Friday, 9 October",
  },
} satisfies TemplateEntry;
