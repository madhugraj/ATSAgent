import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  roundLabel?: string;
  durationMins?: string;
  modeLabel?: string;
  /** The offered times, one per line, in the organisation's time zone. */
  slotsText?: string;
  chooseUrl?: string;
  /** When the link stops working. */
  expiresText?: string;
}

const { text, detail, link } = layoutStyles;

/** The candidate chooses their interview time from a private link. */
const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "the role",
  roundLabel = "interview",
  durationMins,
  modeLabel,
  slotsText,
  chooseUrl,
  expiresText,
}: Props) => (
  <EmailLayout
    preview={`Choose a time for your ${roundLabel} — ${jobTitle}`}
    orgName={orgName}
    heading="Choose a time for your interview"
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    <p style={text}>
      <strong>{orgName}</strong> would like to invite you to the <strong>{roundLabel}</strong> for{" "}
      <strong>{jobTitle}</strong>
      {durationMins
        ? ` (${durationMins} minutes${modeLabel ? `, ${modeLabel.toLowerCase()}` : ""})`
        : ""}
      . Please pick the time that suits you:
    </p>
    {slotsText ? (
      <ul>
        {slotsText.split("\n").map((s) => (
          <li key={s} style={detail}>
            {s}
          </li>
        ))}
      </ul>
    ) : null}
    {chooseUrl ? (
      <p style={text}>
        Choose your time here:{" "}
        <a href={chooseUrl} style={link}>
          {chooseUrl}
        </a>
      </p>
    ) : null}
    <p style={text}>
      If none of these work, the same link lets you tell us, and we will offer other times.
      {expiresText ? ` The link works until ${expiresText}.` : ""} It is personal to you — please do
      not share it.
    </p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) => `Choose a time for your interview — ${data["jobTitle"] ?? ""}`.trim(),
  displayName: "Candidate interview time choice",
  previewData: {
    candidateName: "Asha",
    orgName: "Yavar TechWorks",
    jobTitle: "UI/UX Engineer",
    roundLabel: "L1 interview",
    durationMins: "60",
    modeLabel: "Online",
    slotsText:
      "Tuesday, 13 October 2026 at 11:00 IST\nWednesday, 14 October 2026 at 15:30 IST\nThursday, 15 October 2026 at 10:00 IST",
    chooseUrl: "https://example.com/schedule/abc",
    expiresText: "Monday, 12 October 2026 at 18:00 IST",
  },
} satisfies TemplateEntry;
