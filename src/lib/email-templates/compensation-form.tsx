import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  formUrl?: string;
  dueDate?: string;
  reminder?: string;
}

const { text } = layoutStyles;

const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "the role",
  formUrl,
  dueDate,
  reminder,
}: Props) => (
  <EmailLayout
    preview={`${reminder ? "Reminder: " : ""}your current and expected pay for ${jobTitle}`}
    orgName={orgName}
    heading={reminder ? "A reminder: your pay and availability" : "Your pay and availability"}
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    <p style={text}>
      To make sure any offer for <strong>{jobTitle}</strong> with <strong>{orgName}</strong> fits
      you, please share your current and expected pay, your notice period and when you could join.
      It takes about two minutes.
    </p>
    {formUrl ? (
      <p style={text}>
        Open the form here: <a href={formUrl}>{formUrl}</a>
      </p>
    ) : null}
    {dueDate ? <p style={text}>Please send it by {dueDate}.</p> : null}
    <p style={text}>
      Only the HR team sees your answers. The link is personal to you — please do not share it.
    </p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `${data["reminder"] ? "Reminder: " : ""}Your pay and availability — ${data["jobTitle"] ?? "your application"}`,
  displayName: "Candidate compensation & availability form",
  previewData: {
    candidateName: "Asha",
    orgName: "Yavar TechWorks",
    jobTitle: "Senior Backend Engineer",
    formUrl: "https://example.com/pay/abc",
    dueDate: "Friday, 9 October (end of day)",
  },
} satisfies TemplateEntry;
