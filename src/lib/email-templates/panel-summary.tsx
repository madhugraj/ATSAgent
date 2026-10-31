import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  memberName?: string;
  orgName?: string;
  candidateName?: string;
  jobTitle?: string;
  /** e.g. "L1 interview" */
  roundLabel?: string;
  whenText?: string;
  overview?: string;
  /** JSON: [{ topic, asked, answered }] — factual, no judgement. */
  topicsJson?: string;
  scorecardUrl?: string;
}

type Topic = { topic: string; asked: string; answered: string };

function topicsOf(json: string | undefined): Topic[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter(
          (t): t is Topic =>
            Boolean(t) &&
            typeof (t as Topic).topic === "string" &&
            typeof (t as Topic).asked === "string",
        )
      : [];
  } catch {
    return [];
  }
}

const { text, detail, link } = layoutStyles;

/**
 * The silent panel agent's factual summary of a call, for the people on its
 * panel (docs/silent-panel-agent-plan.md): what was asked and how the candidate
 * answered — never a score or a verdict.
 */
const Email = ({
  memberName,
  orgName = "the hiring team",
  candidateName = "the candidate",
  jobTitle = "the role",
  roundLabel = "Interview",
  whenText,
  overview,
  topicsJson,
  scorecardUrl,
}: Props) => (
  <EmailLayout
    preview={`Summary of the ${roundLabel} with ${candidateName}`}
    orgName={orgName}
    heading={`What was covered: ${roundLabel} with ${candidateName}`}
    greeting={memberName ? `Hi ${memberName},` : "Hello,"}
  >
    <p style={text}>
      Here is a factual summary of the <strong>{roundLabel}</strong> with{" "}
      <strong>{candidateName}</strong> for <strong>{jobTitle}</strong>
      {whenText ? ` (${whenText})` : ""}, taken from the call&apos;s transcript.
    </p>
    {overview ? <p style={text}>{overview}</p> : null}
    {topicsOf(topicsJson).map((t, i) => (
      <div key={i}>
        <p style={text}>
          <strong>{t.topic}</strong>
        </p>
        <p style={detail}>Asked: {t.asked}</p>
        {t.answered ? <p style={detail}>Answered: {t.answered}</p> : null}
      </div>
    ))}
    <p style={text}>
      It is the same for everyone on the panel and carries no score or recommendation. The silent
      panel agent&apos;s own view stays hidden until all of you have scored, so please score from
      your own judgement.
    </p>
    {scorecardUrl ? (
      <p style={text}>
        Submit your scorecard here:{" "}
        <a href={scorecardUrl} style={link}>
          {scorecardUrl}
        </a>
      </p>
    ) : null}
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `Summary: ${data["roundLabel"] ?? "Interview"} with ${data["candidateName"] ?? "the candidate"} — ${data["jobTitle"] ?? ""}`.trim(),
  displayName: "Panel summary of an interview call",
  previewData: {
    memberName: "Priya",
    orgName: "Yavar TechWorks",
    candidateName: "Asha Raman",
    jobTitle: "ML Engineer",
    roundLabel: "L1 interview",
    whenText: "Tuesday, 3 November 2026 at 11:00 (Asia/Kolkata)",
    overview:
      "A 45-minute technical conversation on model serving, data pipelines and one recent project.",
    topicsJson: JSON.stringify([
      {
        topic: "Model serving",
        asked: "How the candidate would serve a ranking model under 50 ms.",
        answered:
          "Described batching requests, caching embeddings and a fallback model; had run this on Kubernetes.",
      },
    ]),
    scorecardUrl: "https://example.com/interviews/mine",
  },
} satisfies TemplateEntry;
