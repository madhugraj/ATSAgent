import * as React from "react";

import type { TemplateEntry } from "./registry";
import { BRAND, EmailLayout, layoutStyles, primaryButton } from "./email-layout";

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
  /** How the time was set: picked by the candidate, on a call, or booked by a person. */
  bookedText?: string;
  /** Earlier rounds' outcomes, one line each (internal panelists only). */
  earlierRounds?: string;
  /** Everyone on the panel, when more than one. */
  panelText?: string;
  /** This round's purpose from the role's interview plan. */
  roundFocus?: string;
  /** What to rate, comma separated. */
  competencies?: string;
  candidateUrl?: string;
  scorecardUrl?: string;
  /** Add-your-mobile link, while none is on file (0093). */
  mobileUrl?: string;
  /** Accept the time or say it does not work (absent once accepted). */
  confirmUrl?: string;
  /** The latest the round can move to under the hiring SLA. */
  latestText?: string;
  /** "yes" when they already accepted this time (e.g. they moved it here). */
  confirmed?: string;
}

const { text, detail } = layoutStyles;
const section = {
  fontSize: "12px",
  letterSpacing: "0.08em",
  textTransform: "uppercase" as const,
  color: "#0f172a",
  fontWeight: "bold" as const,
  margin: "22px 0 8px",
};
const label = {
  fontSize: "14px",
  color: "#6b7280",
  padding: "3px 14px 3px 0",
  whiteSpace: "nowrap" as const,
  verticalAlign: "top",
};
const value = { fontSize: "14px", color: "#0f172a", padding: "3px 0", verticalAlign: "top" };
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
  margin: "0 8px 8px 0",
};
const secondary = { color: BRAND, fontSize: "14px", textDecoration: "underline" };
const quiet = {
  ...button,
  backgroundColor: "#ffffff",
  color: "#0f172a",
  border: "1px solid #cbd5e1",
};

const Row = ({ k, v }: { k: string; v?: React.ReactNode }) =>
  v ? (
    <tr>
      <td style={label}>{k}</td>
      <td style={value}>{v}</td>
    </tr>
  ) : null;

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
  bookedText,
  profile,
  skills,
  matchText,
  screeningText,
  earlierRounds,
  panelText,
  roundFocus,
  competencies,
  candidateUrl,
  scorecardUrl,
  mobileUrl,
  confirmUrl,
  latestText,
  confirmed,
}: Props) => {
  const joinUrl = whereText?.startsWith("http") ? whereText : undefined;
  const rounds = earlierRounds ? earlierRounds.split("\n").filter(Boolean) : [];
  return (
    <EmailLayout
      preview={`${roundLabel} with ${candidateName}${scheduledAtText ? `, ${scheduledAtText}` : ""}`}
      orgName={orgName}
      heading={`${roundLabel}: ${candidateName}`}
      greeting={interviewerName ? `Hi ${interviewerName},` : "Hello,"}
    >
      <p style={text}>
        You are on the panel for {candidateName}&apos;s {roundLabel} for {jobTitle}.
      </p>
      <table cellPadding={0} cellSpacing={0} role="presentation" style={{ margin: "0 0 16px" }}>
        <tbody>
          <Row k="When" v={scheduledAtText} />
          <Row
            k="Length"
            v={
              durationMins
                ? `${durationMins} minutes, ${modeLabel ?? ""}`.replace(/, $/, "")
                : modeLabel
            }
          />
          <Row k="Where" v={joinUrl ? undefined : whereText} />
          <Row k="Panel" v={panelText} />
          <Row k="Time set" v={bookedText} />
          <Row
            k="Latest by"
            v={
              latestText ? (
                <span style={{ color: "#b45309", fontWeight: "bold" }}>{latestText}</span>
              ) : undefined
            }
          />
        </tbody>
      </table>
      {confirmUrl ? (
        <>
          {confirmed === "yes" ? (
            <p style={{ ...text, fontWeight: "bold", color: "#0f172a" }}>
              You&apos;re confirmed for this time.
            </p>
          ) : (
            <a href={confirmUrl} style={button}>
              Accept this time
            </a>
          )}
          <p style={{ ...text, margin: "10px 0 16px" }}>
            <a href={`${confirmUrl}?change=1`} style={secondary}>
              I can&apos;t make it or need another time
            </a>
          </p>
        </>
      ) : null}
      {joinUrl ? (
        <p style={{ ...text, margin: "0 0 16px" }}>
          <a href={joinUrl} style={confirmUrl ? quiet : button}>
            Join meeting
          </a>
        </p>
      ) : null}

      {roundFocus || competencies ? <p style={section}>This round</p> : null}
      {roundFocus ? <p style={detail}>{roundFocus}</p> : null}
      {competencies ? (
        <p style={detail}>Rate {competencies} from 1 to 5, then select, hold or reject.</p>
      ) : null}

      {rounds.length ? <p style={section}>Earlier rounds</p> : null}
      {rounds.map((r) => (
        <p key={r} style={detail}>
          {r}
        </p>
      ))}

      <p style={section}>Candidate</p>
      {profile ? <p style={detail}>{profile}</p> : null}
      {skills ? <p style={detail}>Skills: {skills}</p> : null}
      {matchText ? <p style={detail}>Match: {matchText}</p> : null}
      {screeningText ? <p style={detail}>Screening: {screeningText}</p> : null}

      <p style={{ ...text, margin: "18px 0 0" }}>
        {candidateUrl ? (
          <a href={candidateUrl} style={quiet}>
            Profile and CV
          </a>
        ) : null}
        {scorecardUrl ? (
          <a href={scorecardUrl} style={quiet}>
            Scorecard
          </a>
        ) : null}
        {mobileUrl ? (
          <a href={mobileUrl} style={quiet}>
            Add your mobile
          </a>
        ) : null}
      </p>
    </EmailLayout>
  );
};

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
    bookedText: "Picked by the candidate",
    earlierRounds: "L1 (Priya): select — Figma 4, Design systems 4. Strong portfolio walkthrough.",
    roundFocus: "Role and ownership — design systems and how they work with engineers",
    competencies: "Design systems, Collaboration, Ownership",
    candidateUrl: "https://example.com/candidates/abc",
    scorecardUrl: "https://example.com/interviews/mine",
    confirmUrl: "https://example.com/confirm/abc",
    latestText: "Wednesday, 14 October 2026 at 18:00 IST",
  },
} satisfies TemplateEntry;
