import * as React from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Img,
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
  /** Mail from ATSIQ itself (sign-up, password, tenant approval), not from an organisation. */
  platform?: boolean;
  children?: React.ReactNode;
}

/**
 * The brand colour placeholder: buttons, links, the top rule and the monogram.
 * Templates write this literal; sendTemplateEmail swaps it for the
 * organisation's own colour (Organisation → E-mail branding) at render time.
 */
export const BRAND = "#4f46e5";

/** Set by sendTemplateEmail for the organisation the e-mail is sent for. */
export type EmailBrandContext = { logoSrc: string | null };
export const EmailBrandCtx = React.createContext<EmailBrandContext>({ logoSrc: null });

const ink = "#111827";
const body = "#374151";
const muted = "#6b7280";
const hairline = "#e5e7eb";

const main = {
  backgroundColor: "#f4f5f7",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  padding: "32px 0",
  margin: 0,
};
const frame = {
  maxWidth: "600px",
  backgroundColor: "#ffffff",
  border: `1px solid ${hairline}`,
  borderRadius: "12px",
  overflow: "hidden" as const,
};
const rule = { backgroundColor: BRAND, height: "4px", lineHeight: "4px", fontSize: "1px" };
const header = { padding: "22px 36px 18px", borderBottom: `1px solid ${hairline}` };
const monogram = {
  display: "inline-block",
  width: "36px",
  height: "36px",
  lineHeight: "36px",
  borderRadius: "8px",
  backgroundColor: BRAND,
  color: "#ffffff",
  fontSize: "15px",
  fontWeight: 700,
  textAlign: "center" as const,
  verticalAlign: "middle",
};
const orgLabel = {
  display: "inline-block",
  marginLeft: "12px",
  fontSize: "15px",
  fontWeight: 600,
  color: ink,
  verticalAlign: "middle",
};
const inner = { padding: "28px 36px 12px" };
const h1 = {
  fontSize: "22px",
  lineHeight: "1.3",
  fontWeight: 700,
  color: ink,
  margin: "0 0 18px",
};
const text = { fontSize: "15px", color: body, lineHeight: "1.65", margin: "0 0 14px" };
const detail = { fontSize: "14px", color: body, lineHeight: "1.6", margin: "0 0 6px" };
const link = { color: BRAND, textDecoration: "underline" };
const foot = {
  padding: "18px 36px 24px",
  borderTop: `1px solid ${hairline}`,
  backgroundColor: "#fafafb",
  fontSize: "12px",
  color: muted,
  lineHeight: "1.6",
  margin: 0,
};
/** The main action: one per email. */
export const primaryButton = {
  backgroundColor: BRAND,
  color: "#ffffff",
  fontSize: "14px",
  fontWeight: 600,
  textDecoration: "none",
  padding: "12px 22px",
  borderRadius: "8px",
  display: "inline-block",
};

function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return (
    (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2)) || "?"
  ).toUpperCase();
}

/**
 * Shared frame for every template: the organisation's colour rule, its logo
 * (or a monogram) and name, the content, and a quiet footer. All variable
 * copy is passed in as strings — dates are formatted at enqueue time.
 */
export function EmailLayout({
  preview,
  orgName,
  siteName = "ATSIQ",
  siteUrl = "https://atsiq.yavar.ai",
  heading,
  greeting,
  platform = false,
  children,
}: EmailLayoutProps) {
  const { logoSrc } = React.useContext(EmailBrandCtx);
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={frame}>
          <Section style={rule}>&nbsp;</Section>
          <Section style={header}>
            {platform ? (
              <Text
                style={{
                  margin: 0,
                  fontSize: "18px",
                  fontWeight: 800,
                  color: BRAND,
                  letterSpacing: "0.04em",
                }}
              >
                {siteName}
              </Text>
            ) : logoSrc ? (
              <Img
                src={logoSrc}
                alt={orgName}
                height="40"
                style={{ height: "40px", width: "auto", maxWidth: "220px", display: "block" }}
              />
            ) : (
              <Text style={{ margin: 0 }}>
                <span style={monogram}>{initials(orgName)}</span>
                <span style={orgLabel}>{orgName}</span>
              </Text>
            )}
          </Section>
          <Section style={inner}>
            <Heading style={h1}>{heading}</Heading>
            {greeting === "" ? null : <Text style={text}>{greeting ?? "Hello,"}</Text>}
            {children}
          </Section>
          {platform ? (
            <Text style={foot}>
              {siteName} by Yavar AI ·{" "}
              <Link href={siteUrl} style={{ color: muted, textDecoration: "underline" }}>
                {siteUrl.replace(/^https?:\/\//, "")}
              </Link>
            </Text>
          ) : (
            <Text style={foot}>
              Sent by {orgName} through{" "}
              <Link href={siteUrl} style={{ color: muted, textDecoration: "underline" }}>
                {siteName}
              </Link>
              . If you were not expecting this e-mail, you can ignore it.
            </Text>
          )}
        </Container>
      </Body>
    </Html>
  );
}

/** The one main action of an e-mail, as a button in the brand colour. */
export function EmailAction({ href, label }: { href: string; label: string }) {
  return (
    <Section style={{ margin: "22px 0" }}>
      <Button href={href} style={primaryButton}>
        {label}
      </Button>
    </Section>
  );
}

export const layoutStyles = { text, detail, link };
