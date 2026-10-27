import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  /** e.g. "L1 interview" */
  roundLabel?: string;
  /** Formatted at enqueue time in the organisation's timezone. */
  scheduledAtText?: string;
  durationMins?: string;
  /** "Online", "Onsite" or "Phone" */
  modeLabel?: string;
  /** Meeting link or venue address. */
  whereText?: string;
  /** "the hiring team" / "a panel of 3 from the hiring team" — never a name. */
  withText?: string;
  agenda?: string;
}

const { text, detail, link } = layoutStyles;

const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "the role",
  roundLabel = "Interview",
  scheduledAtText,
  durationMins,
  modeLabel,
  whereText,
  withText,
  agenda,
}: Props) => (
  <EmailLayout
    preview={`${roundLabel} scheduled for ${jobTitle}`}
    orgName={orgName}
    heading={`You are invited: ${roundLabel}`}
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    <p style={text}>
      <strong>{orgName}</strong> would like to schedule your <strong>{roundLabel}</strong> for{" "}
      <strong>{jobTitle}</strong>.
    </p>
    {scheduledAtText ? <p style={detail}>When: {scheduledAtText}</p> : null}
    {durationMins ? <p style={detail}>Duration: {durationMins} minutes</p> : null}
    {modeLabel ? <p style={detail}>Mode: {modeLabel}</p> : null}
    {whereText ? (
      <p style={detail}>
        Where:{" "}
        {whereText.startsWith("http") ? (
          <a href={whereText} style={link}>
            {whereText}
          </a>
        ) : (
          whereText
        )}
      </p>
    ) : null}
    {withText ? <p style={detail}>With: {withText}</p> : null}
    {agenda ? <p style={text}>{agenda}</p> : null}
    <p style={text}>
      A calendar invite (.ics) is attached — please accept it so the slot is held for you. If the
      time does not work, reply to this email and the team will reschedule.
    </p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `Interview invitation — ${data["jobTitle"] ?? ""} at ${data["orgName"] ?? ""}`.replace(
      /\s+/g,
      " ",
    ),
  displayName: "Candidate interview invitation",
  previewData: {
    candidateName: "Asha",
    orgName: "Yavar TechWorks",
    jobTitle: "Senior Backend Engineer",
    roundLabel: "L1 interview",
    scheduledAtText: "Friday, 2 October 2026 at 11:00 (Asia/Kolkata)",
    durationMins: "60",
    modeLabel: "Online",
    whereText: "https://teams.microsoft.com/l/meetup-join/example",
    withText: "a panel of 2 from the hiring team",
    agenda: "Technical discussion on backend architecture and system design.",
  },
} satisfies TemplateEntry;
