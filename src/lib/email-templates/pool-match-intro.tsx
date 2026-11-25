import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailAction, EmailLayout, layoutStyles } from "./email-layout";

interface Props {
  candidateName?: string;
  orgName?: string;
  /** One or more role titles, already joined ("Data Engineer and ML Engineer"). */
  jobTitle?: string;
  /** The role's public page (the first role when several matched). */
  roleUrl?: string;
  optOutUrl?: string;
}

const { text, link } = layoutStyles;

/**
 * Someone in the talent pool was matched to an open role and added to its
 * pipeline (pool-match). They are told formally, once, and can opt out.
 */
const Email = ({
  candidateName,
  orgName = "the hiring team",
  jobTitle = "an open role",
  roleUrl,
  optOutUrl,
}: Props) => (
  <EmailLayout
    preview={`Your profile is being considered for ${jobTitle}`}
    orgName={orgName}
    heading="Your profile is being considered"
    greeting={candidateName ? `Hi ${candidateName},` : "Hello,"}
  >
    <p style={text}>
      Your profile is in the talent pool at <strong>{orgName}</strong>, and it matches our open{" "}
      <strong>{jobTitle}</strong> role. The recruiting team is reviewing it now and will write to
      you as things progress.
    </p>
    {roleUrl ? <EmailAction href={roleUrl} label="View the role" /> : null}
    <p style={text}>
      If you are interested, there is nothing you need to do. If you are not looking right now,
      simply reply and we will withdraw your profile from this role.
    </p>
    {optOutUrl ? (
      <p style={text}>
        <a href={optOutUrl} style={link}>
          Stop emails about new roles
        </a>
      </p>
    ) : null}
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `Your profile is being considered — ${data["jobTitle"] ?? "an open role"}`,
  displayName: "Talent pool match notice",
  previewData: {
    candidateName: "Asha",
    orgName: "Yavar TechWorks",
    jobTitle: "Data Engineer",
    roleUrl: "https://example.com/apply/abc",
    optOutUrl: "https://example.com/api/public/contact-preferences?t=abc",
  },
} satisfies TemplateEntry;
