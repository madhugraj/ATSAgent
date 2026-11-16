import * as React from "react";

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

import type { TemplateEntry } from "./registry";

interface Props {
  siteName?: string;
  siteUrl?: string;
  orgName?: string;
  inviteeName?: string;
  inviterName?: string;
  roleLabel?: string;
  title?: string;
  email?: string;
}

const Email = ({
  siteName = "ATSIQ",
  siteUrl = "https://atsiq.yavar.ai",
  orgName = "your organisation",
  inviteeName,
  inviterName,
  roleLabel = "Recruiter",
  title,
  email,
}: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      You have been added to {orgName} on {siteName} as {roleLabel}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Text style={brand}>{siteName}</Text>
        <Heading style={h1}>You have access to {orgName}</Heading>
        <Text style={text}>{inviteeName ? `Hi ${inviteeName},` : "Hello,"}</Text>
        <Text style={text}>
          {inviterName ? `${inviterName} has` : "Your organisation administrator has"} added you to
          the <strong>{orgName}</strong> talent-acquisition workspace on {siteName} as{" "}
          <strong>{roleLabel}</strong>
          {title ? ` (${title})` : ""}.
        </Text>
        <Button
          style={button}
          href={email ? `${siteUrl}/?invite=${encodeURIComponent(email)}` : siteUrl}
        >
          Get started with {siteName}
        </Button>
        <Text style={small}>
          Use your work address{email ? ` (${email})` : ""} — the same address this invitation was
          sent to. First time? Create your account with it; your role and organisation are applied
          automatically when you join.
        </Text>
        <Hr style={hr} />
        <Section>
          <Text style={stepsTitle}>What you can do once you are in</Text>
          <Text style={step}>
            <strong>Requisitions.</strong> Raise roles, draft job descriptions and route them for
            approval.
          </Text>
          <Text style={step}>
            <strong>Talent pool.</strong> Upload CVs in bulk; parsing extracts skills, experience,
            education and social profiles.
          </Text>
          <Text style={step}>
            <strong>Matching.</strong> Score candidates against a requisition and shortlist the
            strongest.
          </Text>
          <Text style={step}>
            <strong>Interviews &amp; offers.</strong> Schedule sessions, submit scorecards and move
            candidates through to joining.
          </Text>
        </Section>
        <Text style={small}>
          New to the platform? Open <strong>User manual</strong> in the sidebar, or ask the
          in-product assistant.
        </Text>
        <Text style={footer}>
          You received this message because you were added to {orgName} on{" "}
          <Link href={siteUrl} style={link}>
            {siteName}
          </Link>
          . If this looks unexpected, contact your organisation administrator.
        </Text>
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: Email,
  subject: (data: Props) =>
    `You have been added to ${data["orgName"] ?? "your organisation"} on ATSIQ`,
  displayName: "Team member invited",
  previewData: {
    siteName: "ATSIQ",
    siteUrl: "https://atsiq.yavar.ai",
    orgName: "Yavar TechWorks",
    inviteeName: "Saranya",
    inviterName: "Madhu",
    roleLabel: "Recruiter",
    title: "Talent Partner",
    email: "saranya.r@yavar.ai",
  },
} satisfies TemplateEntry;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, Helvetica, sans-serif" };
const container = { padding: "24px 28px", maxWidth: "560px" };
const brand = {
  fontSize: "13px",
  letterSpacing: "0.12em",
  textTransform: "uppercase" as const,
  color: "#0f172a",
  fontWeight: "bold" as const,
  margin: "0 0 22px",
};
const h1 = { fontSize: "22px", fontWeight: "bold" as const, color: "#0f172a", margin: "0 0 18px" };
const text = { fontSize: "14px", color: "#45505f", lineHeight: "1.6", margin: "0 0 18px" };
const small = { fontSize: "13px", color: "#45505f", lineHeight: "1.6", margin: "22px 0 0" };
const link = { color: "#1d4ed8", textDecoration: "underline" };
const button = {
  backgroundColor: "#0f172a",
  color: "#ffffff",
  fontSize: "14px",
  borderRadius: "8px",
  padding: "12px 22px",
  textDecoration: "none",
  display: "inline-block",
};
const hr = { borderColor: "#e5e7eb", margin: "28px 0 20px" };
const stepsTitle = {
  fontSize: "13px",
  fontWeight: "bold" as const,
  color: "#0f172a",
  margin: "0 0 12px",
};
const step = { fontSize: "13px", color: "#45505f", lineHeight: "1.6", margin: "0 0 10px" };
const footer = { fontSize: "12px", color: "#9ca3af", margin: "26px 0 0", lineHeight: "1.6" };
