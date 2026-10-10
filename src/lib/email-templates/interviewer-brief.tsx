import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  interviewerName?: string;
  orgName?: string;
  candidateName?: string;
  jobTitle?: string;
  /** e.g. "L1 interview" */
  roundLabel?: string;
  scheduledAtText?: string;
  durationMins?: string;
  modeLabel?: string;
  whereText?: string;
  /** One line: current role, experience, location. */
  profile?: string;
  /** Top skills, comma separated. */
  skills?: string;
  /** Match score and its one-line rationale. */
  matchText?: string;
  /** Screening recommendation and reason, when screened. */
  screeningText?: string;
  agenda?: string;
  /** Everyone on the panel, when more than one. */
  panelText?: string;
  /** This round's purpose from the role's interview plan. */
  roundFocus?: string;
  /** What to rate, comma separated. */
  competencies?: string;
  candidateUrl?: string;
  scorecardUrl?: string;
}

const { text, detail, link } = layoutStyles;

/** The interviewer's own invite and brief: when, where, who, and what to probe. */
const Email = ({
  interviewerName,
  orgName = "the hiring team",
  candidateName = "the candidate",
  jobTitle = "the role",
  roundLabel = "Interview",
  scheduledAtText,
  durationMins,
  modeLabel,
  whereText,
  profile,
  skills,
  matchText,
  screeningText,
  agenda,
  panelText,
  roundFocus,
  competencies,
  candidateUrl,
  scorecardUrl,
}: Props) => (
  <EmailLayout
    preview={`${roundLabel} with ${candidateName} — ${jobTitle}`}
    orgName={orgName}
    heading={`You are interviewing ${candidateName}`}
    greeting={interviewerName ? `Hi ${interviewerName},` : "Hello,"}
  >
    <p style={text}>
      You are on the panel for the <strong>{roundLabel}</strong> of <strong>{candidateName}</strong>{" "}
      for <strong>{jobTitle}</strong>.
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
    {panelText ? <p style={detail}>Panel: {panelText}</p> : null}
    {roundFocus ? <p style={text}>This round: {roundFocus}</p> : null}
    {competencies ? (
      <p style={text}>You will rate: {competencies} (1–5 each), then select, hold or reject.</p>
    ) : null}
    <p style={text}>
      <strong>About the candidate</strong>
    </p>
    {profile ? <p style={detail}>{profile}</p> : null}
    {skills ? <p style={detail}>Skills: {skills}</p> : null}
    {matchText ? <p style={detail}>Match: {matchText}</p> : null}
    {screeningText ? <p style={detail}>Screening: {screeningText}</p> : null}
    {agenda ? <p style={text}>Focus for this round: {agenda}</p> : null}
    {candidateUrl ? (
      <p style={text}>
        Full profile and CV:{" "}
        <a href={candidateUrl} style={link}>
          {candidateUrl}
        </a>
      </p>
    ) : null}
    {scorecardUrl ? (
      <p style={text}>
        After the interview, submit your scorecard here:{" "}
        <a href={scorecardUrl} style={link}>
          {scorecardUrl}
        </a>
      </p>
    ) : null}
    <p style={text}>A calendar invite (.ics) is attached so the slot is held in your calendar.</p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `${data["roundLabel"] ?? "Interview"}: ${data["candidateName"] ?? "candidate"} — ${data["jobTitle"] ?? ""}`.trim(),
  displayName: "Interviewer invite and brief",
  previewData: {
    interviewerName: "Priya",
    orgName: "Yavar TechWorks",
    candidateName: "Asha Raman",
    jobTitle: "UI/UX Engineer",
    roundLabel: "L1 interview",
    scheduledAtText: "Tuesday, 13 October 2026 at 11:00 IST",
    durationMins: "60",
    modeLabel: "Online",
    whereText: "https://meet.google.com/abc-defg-hij",
    profile: "Product Designer at Acme · 5 years · Bengaluru",
    skills: "Figma, Design systems, User research, React",
    matchText: "82/100 — strong Figma and design-system work; light on accessibility",
    screeningText: "Proceed — clear process, good examples",
    candidateUrl: "https://example.com/candidates/abc",
    scorecardUrl: "https://example.com/interviews/mine",
  },
} satisfies TemplateEntry;
