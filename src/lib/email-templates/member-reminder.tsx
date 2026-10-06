import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

/** Internal nudge to a member (approvals, scorecards) sent by the Follow-up agent. */
interface Props {
  memberName?: string;
  orgName?: string;
  heading?: string;
  message?: string;
  actionUrl?: string;
}

const { text } = layoutStyles;

const Email = ({
  memberName,
  orgName = "your organisation",
  heading = "Something is waiting for you",
  message,
  actionUrl,
}: Props) => (
  <EmailLayout
    preview={heading}
    orgName={orgName}
    heading={heading}
    greeting={memberName ? `Hi ${memberName},` : "Hello,"}
  >
    {message ? <p style={text}>{message}</p> : null}
    {actionUrl ? (
      <p style={text}>
        Open it here: <a href={actionUrl}>{actionUrl}</a>
      </p>
    ) : null}
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) => data["heading"] ?? "Something is waiting for you",
  displayName: "Member reminder",
  previewData: {
    memberName: "Ravi",
    orgName: "Yavar TechWorks",
    heading: "REQ-2026-104 is waiting for your approval",
    message: "Backend Engineer ×2 has been with you for 3 days.",
    actionUrl: "https://example.com/requisitions/1",
  },
} satisfies TemplateEntry;
