import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  jobTitle?: string;
  assistantName?: string;
  when?: string;
  minutes?: string;
  contactEmail?: string;
}

const { text } = layoutStyles;

const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "the role",
  assistantName = "our recruiting assistant",
  when,
  minutes = "10",
  contactEmail,
}: Props) => (
  <EmailLayout
    preview={`Your screening call about ${jobTitle}${when ? ` — ${when}` : ""}`}
    orgName={orgName}
    heading="Your screening call is booked"
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    <p style={text}>
      Thank you for your time on the phone. As agreed, <strong>{assistantName}</strong>, an AI
      recruiting assistant with <strong>{orgName}</strong>&apos;s talent acquisition team, will call
      you {when ? <strong>on {when}</strong> : "at the time we agreed"} about your application for{" "}
      <strong>{jobTitle}</strong>.
    </p>
    <p style={text}>
      It is a short first conversation — about {minutes} minutes: a little about the role, a few
      practical details, and a few questions about your experience. The hiring team reviews it
      afterwards; nothing is decided on the call.
    </p>
    <p style={text}>
      Need a different time, or would you rather have a written assessment or a call from a person
      on the team? Just reply to this e-mail.
      {contactEmail ? (
        <>
          {" "}
          You can also check this is genuine by writing to{" "}
          <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
        </>
      ) : null}
    </p>
    <p style={text}>
      The assistant makes notes of the conversation for the hiring team only, and they are used only
      for your application.
    </p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `Your screening call about ${data["jobTitle"] ?? "your application"}${data["when"] ? ` — ${data["when"]}` : ""}`,
  displayName: "Candidate screening call booked",
  previewData: {
    candidateName: "Meera",
    orgName: "Yavar TechWorks",
    jobTitle: "Platform SRE",
    assistantName: "Saranya",
    when: "Monday 26 October, 11:30",
    minutes: "10",
    contactEmail: "careers@yavar.example",
  },
} satisfies TemplateEntry;
