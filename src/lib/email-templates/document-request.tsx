import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  /** Plain list of documents, one per line. */
  documents?: string;
  replyTo?: string;
  dueDate?: string;
  /** Why an earlier copy was not accepted. */
  note?: string;
}

const { text } = layoutStyles;

const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "your new role",
  documents,
  replyTo,
  dueDate,
  note,
}: Props) => (
  <EmailLayout
    preview={`Documents for your offer — ${jobTitle}`}
    orgName={orgName}
    heading="Documents we need before your offer"
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    <p style={text}>
      To prepare your offer for <strong>{jobTitle}</strong> with <strong>{orgName}</strong>, please
      send us the following documents:
    </p>
    {note ? (
      <p style={text}>
        <strong>About the copy you sent earlier:</strong> {note}
      </p>
    ) : null}
    {documents ? (
      <ul>
        {documents.split("\n").map((d) => (
          <li key={d} style={text}>
            {d}
          </li>
        ))}
      </ul>
    ) : null}
    <p style={text}>
      {replyTo ? (
        <>
          Reply to this email or send them to <strong>{replyTo}</strong>
        </>
      ) : (
        "Reply to this email with the documents attached"
      )}
      {dueDate ? ` by ${dueDate}` : ""}. Clear scans or photos are fine.
    </p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) => `Documents for your offer — ${data["jobTitle"] ?? "your new role"}`,
  displayName: "Pre-onboarding document request",
  previewData: {
    candidateName: "Sana",
    orgName: "Yavar TechWorks",
    jobTitle: "Platform SRE",
    documents: "Photo identity (PAN or passport)\nLatest three payslips\nRelieving letter",
    replyTo: "careers@yavar.example",
    dueDate: "Friday, 16 October",
  },
} satisfies TemplateEntry;
