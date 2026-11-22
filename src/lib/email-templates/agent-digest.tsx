import * as React from "react";
import { Button, Section } from "@react-email/components";

import type { TemplateEntry } from "./registry";
import { BRAND, EmailLayout, layoutStyles, primaryButton } from "./email-layout";

/**
 * End-of-day summary for one person: what agents are waiting on them today
 * and, for the owner / HR heads / CBOs, the agent issues still open.
 */
interface Props {
  memberName?: string;
  orgName?: string;
  heading?: string;
  /** e.g. "Sunday, 22 November" in the org's time zone. */
  dayLabel?: string;
  /** JSON: [{ severity, agent, title, since }] */
  issuesJson?: string;
  /** JSON: [{ heading, message, url }] */
  remindersJson?: string;
  actionUrl?: string;
}

type Issue = { severity: string; agent: string; title: string; since: string };
type Reminder = { heading: string; message: string; url: string };

function parse<T>(json: string | undefined, ok: (v: T) => boolean): T[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? (v as T[]).filter((x) => x && ok(x)) : [];
  } catch {
    return [];
  }
}

const { text } = layoutStyles;
const sectionTitle = {
  fontSize: "12px",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase" as const,
  color: "#6b7280",
  margin: "26px 0 10px",
};
const tile = {
  width: "33%",
  padding: "12px 14px",
  border: "1px solid #e5e7eb",
  borderRadius: "10px",
  verticalAlign: "top",
};
const tileNum = { fontSize: "24px", fontWeight: 700, lineHeight: "1.1", margin: 0 };
const tileLabel = { fontSize: "12px", color: "#6b7280", margin: "4px 0 0" };
const item = {
  padding: "12px 14px",
  border: "1px solid #e5e7eb",
  borderLeft: `3px solid ${BRAND}`,
  borderRadius: "8px",
  marginBottom: "8px",
};
const itemHead = { fontSize: "14px", fontWeight: 600, color: "#111827", textDecoration: "none" };
const itemBody = { fontSize: "13px", color: "#4b5563", lineHeight: "1.55", margin: "4px 0 0" };
const cell = {
  padding: "10px 8px",
  borderBottom: "1px solid #f0f1f3",
  fontSize: "13px",
  color: "#374151",
  verticalAlign: "top",
  textAlign: "left" as const,
};
const th = {
  ...cell,
  fontSize: "11px",
  fontWeight: 700,
  color: "#6b7280",
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  borderBottom: "1px solid #e5e7eb",
};
const pill = (critical: boolean) => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "11px",
  fontWeight: 700,
  color: critical ? "#991b1b" : "#92400e",
  backgroundColor: critical ? "#fee2e2" : "#fef3c7",
});

function summaryLine(reminders: number, critical: number, serious: number): string {
  const parts: string[] = [];
  if (reminders)
    parts.push(
      `${reminders} ${reminders === 1 ? "thing is" : "things are"} waiting for your decision`,
    );
  const issues = critical + serious;
  if (issues)
    parts.push(
      `${issues} agent ${issues === 1 ? "issue is" : "issues are"} still open${critical ? ` (${critical} critical)` : ""}`,
    );
  if (!parts.length) return "Nothing needs you today.";
  return `${parts.join(", and ")}.`;
}

const Email = ({
  memberName,
  orgName = "your organisation",
  heading = "Your end-of-day summary",
  dayLabel,
  issuesJson,
  remindersJson,
  actionUrl,
}: Props) => {
  const issues = parse<Issue>(issuesJson, (r) => typeof r.title === "string");
  const reminders = parse<Reminder>(remindersJson, (r) => typeof r.heading === "string");
  const critical = issues.filter((i) => i.severity === "critical").length;
  const serious = issues.length - critical;
  const tiles = [
    { n: reminders.length, label: "Waiting for you", color: "#111827" },
    { n: critical, label: "Critical issues", color: critical ? "#b91c1c" : "#111827" },
    { n: serious, label: "Serious issues", color: serious ? "#b45309" : "#111827" },
  ];
  return (
    <EmailLayout
      preview={summaryLine(reminders.length, critical, serious)}
      orgName={orgName}
      heading={heading}
      greeting={memberName ? `Hi ${memberName},` : "Hello,"}
    >
      <p style={text}>
        {dayLabel ? `${dayLabel}: ` : ""}
        {summaryLine(reminders.length, critical, serious)}
      </p>

      <table width="100%" cellPadding={0} cellSpacing={6} style={{ margin: "4px -6px 0" }}>
        <tbody>
          <tr>
            {tiles.map((t) => (
              <td key={t.label} style={tile}>
                <p style={{ ...tileNum, color: t.color }}>{t.n}</p>
                <p style={tileLabel}>{t.label}</p>
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      {reminders.length ? (
        <>
          <p style={sectionTitle}>Waiting for you</p>
          {reminders.map((r, i) => (
            <div key={i} style={item}>
              {r.url ? (
                <a href={r.url} style={itemHead}>
                  {r.heading} →
                </a>
              ) : (
                <span style={itemHead}>{r.heading}</span>
              )}
              {r.message ? <p style={itemBody}>{r.message}</p> : null}
            </div>
          ))}
        </>
      ) : null}

      {issues.length ? (
        <>
          <p style={sectionTitle}>Agent issues still open</p>
          <table
            width="100%"
            cellPadding={0}
            cellSpacing={0}
            style={{ borderCollapse: "collapse" }}
          >
            <thead>
              <tr>
                <th style={{ ...th, width: "82px" }}>Severity</th>
                <th style={th}>Issue</th>
                <th style={{ ...th, width: "96px" }}>Open since</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((r, i) => (
                <tr key={i}>
                  <td style={cell}>
                    <span style={pill(r.severity === "critical")}>
                      {r.severity === "critical" ? "Critical" : "Serious"}
                    </span>
                  </td>
                  <td style={cell}>
                    <span style={{ color: "#111827" }}>{r.title}</span>
                    <br />
                    <span style={{ fontSize: "12px", color: "#6b7280" }}>{r.agent}</span>
                  </td>
                  <td style={{ ...cell, color: "#6b7280", fontSize: "12px" }}>{r.since}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {actionUrl ? (
        <Section style={{ margin: "26px 0 8px" }}>
          <Button href={actionUrl} style={primaryButton}>
            {issues.length ? "Review agent issues" : "Open ATSIQ"}
          </Button>
        </Section>
      ) : null}
    </EmailLayout>
  );
};

export const template = {
  component: Email,
  subject: (data: Props) => data["heading"] ?? "Your end-of-day summary",
  displayName: "End-of-day summary",
  previewData: {
    memberName: "Ravi",
    orgName: "Yavar TechWorks",
    heading: "Today at Yavar TechWorks: 2 waiting for you, 2 agent issues",
    dayLabel: "Sunday, 22 November",
    remindersJson: JSON.stringify([
      {
        heading: "Sales Head (REQ-2026-008): JD approval pending for 2 days",
        message: "The job description is ready; approve it or send it back with a note.",
        url: "https://example.com/requisitions/1",
      },
      {
        heading: "AI Intern and AI Engineer are waiting to be posted",
        message: "Post them on Naukri and LinkedIn with the ATSIQ browser extension.",
        url: "https://example.com/requisitions/2",
      },
    ]),
    issuesJson: JSON.stringify([
      {
        severity: "critical",
        agent: "Orchestrator",
        title: "1 run stuck for over 30 minutes",
        since: "22 Nov, 14:02",
      },
      {
        severity: "serious",
        agent: "Offer agent",
        title: "REQ-2026-011 pays in USD, but its zone India pays in INR",
        since: "19 Nov, 09:10",
      },
    ]),
    actionUrl: "https://example.com/agents/observability",
  },
} satisfies TemplateEntry;
