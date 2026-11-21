import * as React from "react";
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

interface EmailLayoutProps {
  preview: string;
  orgName: string;
  siteName?: string;
  siteUrl?: string;
  heading: string;
  greeting?: string;
  children?: React.ReactNode;
}

/** The brand colour: the band, buttons and links. */
export const BRAND = "#4f46e5";

const main = {
  backgroundColor: "#f3f4f8",
  fontFamily: "Arial, Helvetica, sans-serif",
  padding: "24px 0",
};
const frame = {
  maxWidth: "600px",
  backgroundColor: "#ffffff",
  border: "1px solid #d9dbe6",
  borderRadius: "10px",
  overflow: "hidden" as const,
};
const band = { backgroundColor: BRAND, padding: "22px 32px" };
const wordmark = {
  display: "inline-block",
  backgroundColor: "#ffffff",
  color: BRAND,
  borderRadius: "8px",
  padding: "6px 12px",
  fontSize: "16px",
  fontWeight: "bold" as const,
  letterSpacing: "0.02em",
  margin: 0,
};
const inner = { padding: "26px 36px 8px" };
const h1 = { fontSize: "21px", fontWeight: "bold" as const, color: "#0f172a", margin: "0 0 16px" };
const text = { fontSize: "14px", color: "#45505f", lineHeight: "1.65", margin: "0 0 14px" };
const detail = { fontSize: "14px", color: "#45505f", lineHeight: "1.6", margin: "0 0 6px" };
const link = { color: BRAND, textDecoration: "underline" };
const foot = {
  borderTop: `3px solid ${BRAND}`,
  padding: "14px 36px 20px",
  textAlign: "center" as const,
  fontSize: "12px",
  color: "#9ca3af",
  lineHeight: "1.6",
  margin: 0,
};
/** The main action: one per email. */
export const primaryButton = {
  backgroundColor: BRAND,
  color: "#ffffff",
  fontSize: "14px",
  fontWeight: "bold" as const,
  textDecoration: "none",
  padding: "11px 22px",
  borderRadius: "6px",
  display: "inline-block",
};

/**
 * Shared frame for every template: a bordered card with the organisation's
 * band and wordmark, the content, and a footer rule. All variable copy is
 * passed in as strings — dates are formatted at enqueue time.
 */
export function EmailLayout({
  preview,
  orgName,
  siteName = "ATSIQ",
  siteUrl = "https://atsiq.yavar.ai",
  heading,
  greeting,
  children,
}: EmailLayoutProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={frame}>
          <Section style={band}>
            <Text style={wordmark}>{orgName}</Text>
          </Section>
          <Section style={inner}>
            <Heading style={h1}>{heading}</Heading>
            <Text style={text}>{greeting ?? "Hello,"}</Text>
            {children}
          </Section>
          <Text style={foot}>
            Sent on behalf of {orgName} by{" "}
            <Link href={siteUrl} style={link}>
              {siteName}
            </Link>
            , their recruiting platform. If you were not expecting it, you can safely ignore this
            email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export const layoutStyles = { text, detail, link };
