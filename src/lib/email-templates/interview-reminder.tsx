import * as React from "react";

import type { TemplateEntry } from "./registry";
import { BRAND, EmailLayout, layoutStyles, primaryButton } from "./email-layout";

interface Props {
  /** "candidate" or "panel" */
  audience?: string;
  /** "day" (~24 h before) or "soon" (~1 h before) */
  step?: string;
  recipientName?: string;
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  roundLabel?: string;
  scheduledAtText?: string;
  durationMins?: string;
  modeLabel?: string;
  whereText?: string;
  /** Candidate only: "the hiring team" / "a panel of N" — never a name. */
  withText?: string;
  /** Panel only: the interviewer's interviews page. */
  actionUrl?: string;
}

const { text, link } = layoutStyles;
const box = {
  margin: "4px 0 18px",
  border: "1px solid #e5e7eb",
  borderRadius: "10px",
  padding: "6px 14px",
  backgroundColor: "#fafafb",
};
const boxKey = {
  width: "70px",
  padding: "7px 0",
  fontSize: "13px",
  color: "#6b7280",
  verticalAlign: "top",
};
const boxVal = { padding: "7px 0", fontSize: "14px", color: "#111827", fontWeight: 600 };
const button = {
  ...primaryButton,
  backgroundColor: BRAND,
  color: "#ffffff",
  fontSize: "14px",
  fontWeight: "bold" as const,
  textDecoration: "none",
  padding: "10px 18px",
  borderRadius: "6px",
  display: "inline-block",
};

const when = (step?: string) => (step === "soon" ? "starts in about an hour" : "is tomorrow");

/** A booked round is coming up: the candidate and each panelist are reminded. */
const Email = ({
  audience = "candidate",
  step = "day",
  recipientName,
  candidateName = "the candidate",
  orgName = "the hiring team",
  jobTitle = "the role",
  roundLabel = "interview",
  scheduledAtText,
  durationMins,
  modeLabel,
  whereText,
  withText,
  actionUrl,
}: Props) => {
  const panel = audience === "panel";
  return (
    <EmailLayout
      preview={
        panel
          ? `${candidateName}'s ${roundLabel} ${when(step)}`
          : `Your ${roundLabel} for ${jobTitle} ${when(step)}`
      }
      orgName={orgName}
      heading={
        panel
          ? `${candidateName}'s ${roundLabel} ${when(step)}`
          : `Your ${roundLabel} ${when(step)}`
      }
      greeting={recipientName ? `Hi ${recipientName},` : "Hello,"}
    >
      <p style={text}>
        {panel ? (
          <>
            You are on the panel for <strong>{candidateName}</strong>&apos;s{" "}
            <strong>{roundLabel}</strong> for <strong>{jobTitle}</strong>.
          </>
        ) : (
          <>
            A reminder of your <strong>{roundLabel}</strong> for <strong>{jobTitle}</strong> with{" "}
            <strong>{orgName}</strong>.
          </>
        )}
      </p>
      <table width="100%" cellPadding={0} cellSpacing={0} style={box}>
        <tbody>
          {(
            [
              ["When", scheduledAtText],
              [
                "Length",
                durationMins
                  ? `${durationMins} minutes${modeLabel ? `, ${modeLabel.toLowerCase()}` : ""}`
                  : modeLabel,
              ],
              ["Where", whereText],
              ["With", panel ? undefined : withText],
            ] as const
          )
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <tr key={k}>
                <td style={boxKey}>{k}</td>
                <td style={boxVal}>
                  {k === "Where" && v!.startsWith("http") ? (
                    <a href={v} style={link}>
                      Join the meeting
                    </a>
                  ) : (
                    v
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {panel ? (
        actionUrl ? (
          <p style={text}>
            <a href={actionUrl} style={button}>
              Open the interview brief
            </a>
          </p>
        ) : null
      ) : (
        <p style={text}>
          If something has come up and this time no longer works, reply to this email and the team
          will find another.
        </p>
      )}
    </EmailLayout>
  );
};

export const template = {
  component: Email,
  subject: (d: Props) =>
    d["audience"] === "panel"
      ? `Reminder: ${d["candidateName"] ?? "a candidate"}'s ${d["roundLabel"] ?? "interview"} ${when(d["step"])}`
      : `Reminder: your ${d["roundLabel"] ?? "interview"} ${when(d["step"])} — ${d["jobTitle"] ?? ""}`.trim(),
  displayName: "Interview reminder (candidate and panel)",
  previewData: {
    audience: "candidate",
    step: "day",
    recipientName: "Asha",
    candidateName: "Asha",
    orgName: "Yavar TechWorks",
    jobTitle: "Senior Backend Engineer",
    roundLabel: "L2 interview",
    scheduledAtText: "Tuesday, 24 November 2026 at 13:00 (Asia/Kolkata)",
    durationMins: "60",
    modeLabel: "Online",
    whereText: "https://teams.microsoft.com/l/meetup-join/example",
    withText: "the hiring team",
  },
} satisfies TemplateEntry;
