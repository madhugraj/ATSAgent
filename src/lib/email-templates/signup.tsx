import * as React from "react";
import { Button, Section } from "@react-email/components";

import { EmailLayout, layoutStyles, primaryButton } from "./email-layout";

interface SignupEmailProps {
  siteName: string;
  siteUrl: string;
  recipient: string;
  confirmationUrl: string;
}

const { text, detail, link } = layoutStyles;

/** Confirms the work address of someone registering a new organisation. */
export const SignupEmail = ({
  siteName = "ATSIQ",
  siteUrl = "https://atsiq.yavar.ai",
  recipient,
  confirmationUrl,
}: SignupEmailProps) => (
  <EmailLayout
    platform
    preview={`Confirm your work email to register on ${siteName}`}
    orgName={siteName}
    siteName={siteName}
    siteUrl={siteUrl}
    heading="Confirm your work email"
    greeting="Hello,"
  >
    <p style={text}>
      Confirm {recipient ? <strong>{recipient}</strong> : "this address"} to continue registering
      your organisation on {siteName}.
    </p>
    <Section style={{ margin: "22px 0" }}>
      <Button href={confirmationUrl} style={primaryButton}>
        Confirm email
      </Button>
    </Section>
    <p style={detail}>
      After this you complete your organisation profile, and our team reviews the registration — you
      hear back by email.
    </p>
    <p style={{ ...detail, marginTop: "14px" }}>
      The link works once and expires soon. If the button does not open, use{" "}
      <a href={confirmationUrl} style={link}>
        this link
      </a>
      . If you did not start a registration, ignore this email — nothing is created without it.
    </p>
  </EmailLayout>
);

export default SignupEmail;
