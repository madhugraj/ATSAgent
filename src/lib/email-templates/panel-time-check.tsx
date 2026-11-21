import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  interviewerName?: string;
  orgName?: string;
  candidateName?: string;
  jobTitle?: string;
  /** e.g. "L2 interview" */
  roundLabel?: string;
  durationMins?: string;
  /** One time per line, formatted in the organisation's time zone. */
  slotsText?: string;
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

/** Before the candidate is offered times: do these suit the panelist? */
const Email = ({
  interviewerName,
  orgName = "the hiring team",
  candidateName = "the candidate",
  jobTitle = "the role",
  roundLabel = "Interview",
  durationMins,
  slotsText,
  confirmUrl,
}: Props) => (
  <EmailLayout
    preview={`Do these times work for ${candidateName}'s ${roundLabel}?`}
    orgName={orgName}
    heading="Do these interview times work for you?"
    greeting={interviewerName ? `Hi ${interviewerName},` : "Hello,"}
  >
    <p style={text}>
      You are on the panel for {candidateName}&apos;s {roundLabel} for {jobTitle}
      {durationMins ? ` (${durationMins} minutes)` : ""}. The candidate is offered these times only
      after the panel agrees:
    </p>
    {(slotsText ?? "")
      .split("\n")
      .filter(Boolean)
      .map((s) => (
        <p key={s} style={detail}>
          {s}
        </p>
      ))}
    {confirmUrl ? (
      <p style={{ ...text, marginTop: "18px" }}>
        <a href={confirmUrl} style={button}>
          Answer
        </a>
      </p>
    ) : null}
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `Times to agree: ${data["roundLabel"] ?? "Interview"} with ${data["candidateName"] ?? "a candidate"}`,
  displayName: "Panel: agree interview times",
  previewData: {
    interviewerName: "Priya",
    orgName: "Yavar TechWorks",
    candidateName: "Asha Raman",
    jobTitle: "UI/UX Engineer",
    roundLabel: "L2 interview",
    durationMins: "60",
    slotsText: "Tuesday, 13 October 2026 at 11:00 IST\nWednesday, 14 October 2026 at 15:00 IST",
    confirmUrl: "https://example.com/confirm/abc",
  },
} satisfies TemplateEntry;
