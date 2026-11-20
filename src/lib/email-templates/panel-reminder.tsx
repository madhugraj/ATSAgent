import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  interviewerName?: string;
  orgName?: string;
  candidateName?: string;
  roundLabel?: string;
  /** One time per line, in the organisation's time zone. */
  timesText?: string;
  /** e.g. "2 hours" */
  leftText?: string;
  confirmUrl?: string;
}

const { text, detail } = layoutStyles;
const button = {
  backgroundColor: "#0f172a",
  color: "#ffffff",
  fontSize: "14px",
  fontWeight: "bold" as const,
  textDecoration: "none",
  padding: "10px 18px",
  borderRadius: "6px",
  display: "inline-block",
};

/** A panelist has not answered an interview time: the candidate is waiting on them. */
const Email = ({
  interviewerName,
  orgName = "the hiring team",
  candidateName = "the candidate",
  roundLabel = "interview",
  timesText,
  leftText,
  confirmUrl,
}: Props) => (
  <EmailLayout
    preview={`Reminder: answer ${candidateName}'s ${roundLabel} time`}
    orgName={orgName}
    heading="The candidate is waiting on your answer"
    greeting={interviewerName ? `Hi ${interviewerName},` : "Hello,"}
  >
    <p style={text}>
      {candidateName}&apos;s {roundLabel} cannot be confirmed until you answer
      {leftText ? ` — within ${leftText}, or the team goes ahead without your answer` : ""}:
    </p>
    {(timesText ?? "")
      .split("\n")
      .filter(Boolean)
      .map((t) => (
        <p key={t} style={detail}>
          {t}
        </p>
      ))}
    {confirmUrl ? (
      <p style={{ ...text, marginTop: "18px" }}>
        <a href={confirmUrl} style={button}>
          Answer now
        </a>
      </p>
    ) : null}
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (d: Props) =>
    `Reminder: ${d["roundLabel"] ?? "interview"} time for ${d["candidateName"] ?? "a candidate"}`,
  displayName: "Panel: answer reminder",
  previewData: {
    interviewerName: "Sivakami",
    orgName: "Yavar TechWorks",
    candidateName: "Vishal L V",
    roundLabel: "L2 interview",
    timesText: "Tuesday, 24 November 2026 at 13:00 IST",
    leftText: "2 hours",
    confirmUrl: "https://example.com/confirm/abc",
  },
} satisfies TemplateEntry;
