import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  /** The message a person approved, plain text; paragraphs split on blank lines. */
  message?: string;
  responseUrl?: string;
  dueDate?: string;
  reminder?: string;
}

const { text } = layoutStyles;

const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "the role",
  message = "",
  responseUrl,
  dueDate,
  reminder,
}: Props) => (
  <EmailLayout
    preview={`${reminder ? "Reminder: " : ""}about your offer for ${jobTitle}`}
    orgName={orgName}
    heading={reminder ? "A reminder about your offer" : `About your offer for ${jobTitle}`}
    greeting={candidateName ? `Dear ${candidateName},` : "Hello,"}
  >
    {message
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p, i) => (
        <p key={i} style={text}>
          {p}
        </p>
      ))}
    {responseUrl ? (
      <p style={text}>
        Let us know what you think here — accept, suggest another figure, or ask for a call:{" "}
        <a href={responseUrl}>{responseUrl}</a>
      </p>
    ) : null}
    {dueDate ? <p style={text}>It would help to hear from you by {dueDate}.</p> : null}
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `${data["reminder"] ? "Reminder: " : ""}About your offer — ${data["jobTitle"] ?? "your application"}`,
  displayName: "Offer discussion (before the letter)",
  previewData: {
    candidateName: "Asha",
    orgName: "Yavar TechWorks",
    jobTitle: "Senior Backend Engineer",
    message:
      "Thank you for sharing your expectations — we were glad to read them.\n\nWe would like to offer ₹1,10,00,000 a year, with a ₹5,00,000 joining bonus and a pay review after six months.",
    responseUrl: "https://example.com/negotiate/abc",
    dueDate: "Friday, 16 October",
  },
} satisfies TemplateEntry;
