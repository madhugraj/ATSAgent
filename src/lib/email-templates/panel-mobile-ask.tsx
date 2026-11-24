import * as React from "react";

import type { TemplateEntry } from "./registry";
import { BRAND, EmailLayout, layoutStyles, primaryButton } from "./email-layout";

interface Props {
  firstName?: string;
  orgName?: string;
  actionUrl?: string;
  /** "yes" on the second ask. */
  again?: string;
}

const { text } = layoutStyles;
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

/** A panel member is asked for their mobile, so interview times are settled with a short call. */
const Email = ({ firstName, orgName = "the hiring team", actionUrl }: Props) => (
  <EmailLayout
    preview="Add your mobile for interview time checks"
    orgName={orgName}
    heading="Add your mobile number"
    greeting={firstName ? `Hi ${firstName},` : "Hello,"}
  >
    <p style={text}>
      You are on {orgName}&apos;s interview panel. When an interview time is waiting on your answer,
      our AI assistant can give you a short call so the candidate is not kept waiting.
    </p>
    {actionUrl ? (
      <p style={{ ...text, marginTop: "18px" }}>
        <a href={actionUrl} style={button}>
          Add my mobile
        </a>
      </p>
    ) : null}
    <p style={text}>You can also choose not to receive these calls on the same page.</p>
  </EmailLayout>
);

export const template = {
  component: Email,
  subject: (d: Props) =>
    d["again"] === "yes"
      ? "Reminder: add your mobile for interview time checks"
      : "Add your mobile for interview time checks",
  displayName: "Panel: add your mobile",
  previewData: {
    firstName: "Sivakami",
    orgName: "Yavar TechWorks",
    actionUrl: "https://example.com/panel-mobile/abc",
  },
} satisfies TemplateEntry;
