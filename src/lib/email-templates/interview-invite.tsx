import * as React from "react";

import type { TemplateEntry } from "./registry";
import { BRAND, EmailLayout, layoutStyles, primaryButton } from "./email-layout";

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
  /** "yes" when the call is transcribed for the silent panel agent. */
  transcribed?: string;
  /** Private link to confirm the time or say it does not work. */
  confirmUrl?: string;
  /** The time the candidate was told before, when the round has moved. */
  previousText?: string;
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
  transcribed,
  confirmUrl,
  previousText,
}: Props) => (
  <EmailLayout
    preview={
      previousText
        ? `A new time for your ${roundLabel} for ${jobTitle}`
        : `${roundLabel} scheduled for ${jobTitle}`
    }
    orgName={orgName}
    heading={previousText ? `A new time for your ${roundLabel}` : `You are invited: ${roundLabel}`}
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    {previousText ? (
      <p style={text}>
        We are sorry to change your <strong>{roundLabel}</strong> for <strong>{jobTitle}</strong>.
        It was set for {previousText}; something came up on our side, and we would be grateful if
        the new time below works for you. If it does not, please let us know — we will find one that
        does.
      </p>
    ) : (
      <p style={text}>
        <strong>{orgName}</strong> would like to schedule your <strong>{roundLabel}</strong> for{" "}
        <strong>{jobTitle}</strong>.
      </p>
    )}
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
            ["With", withText],
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
    {agenda ? <p style={text}>{agenda}</p> : null}
    {transcribed === "yes" ? (
      <p style={text}>
        This call will be transcribed so the team has an accurate record, and an AI note-taker uses
        the transcript to help them review the interview consistently. The people on the panel make
        the decision. If you would rather the call were not transcribed, reply to this email before
        the interview and we will switch it off; it will not affect how you are assessed.
      </p>
    ) : null}
    {confirmUrl ? (
      <>
        <p style={text}>
          <a href={confirmUrl} style={button}>
            {previousText ? "This time works" : "Confirm this time"}
          </a>
        </p>
        <p style={text}>
          <a href={`${confirmUrl}?change=1`} style={link}>
            {previousText ? "I need a different time" : "This time doesn't work for me"}
          </a>
        </p>
      </>
    ) : (
      <p style={text}>
        A calendar invite (.ics) is attached — please accept it so the slot is held for you. If the
        time does not work, reply to this email and the team will reschedule.
      </p>
    )}
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    data["previousText"]
      ? `New interview time — ${data["jobTitle"] ?? ""} at ${data["orgName"] ?? ""}`.replace(
          /\s+/g,
          " ",
        )
      : `Interview invitation — ${data["jobTitle"] ?? ""} at ${data["orgName"] ?? ""}`.replace(
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
    transcribed: "yes",
  },
} satisfies TemplateEntry;
