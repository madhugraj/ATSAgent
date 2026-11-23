import * as React from "react";
import { Button, Section } from "@react-email/components";

import { EmailLayout, layoutStyles, primaryButton } from "./email-layout";

interface RecoveryEmailProps {
  siteName: string;
  confirmationUrl: string;
}

const { text, detail } = layoutStyles;

export const RecoveryEmail = ({ siteName = "ATSIQ", confirmationUrl }: RecoveryEmailProps) => (
  <EmailLayout
    platform
    preview={`Reset your ${siteName} password`}
    orgName={siteName}
    siteName={siteName}
    heading="Reset your password"
    greeting="Hello,"
  >
    <p style={text}>Someone asked to reset the password for this {siteName} account.</p>
    <Section style={{ margin: "22px 0" }}>
      <Button href={confirmationUrl} style={primaryButton}>
        Choose a new password
      </Button>
    </Section>
    <p style={detail}>If it was not you, ignore this email — your password stays as it is.</p>
  </EmailLayout>
);

export default RecoveryEmail;
