import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

/** End-of-day summary: what is waiting for this person, and open agent issues (leaders). */
interface Props {
  memberName?: string;
  orgName?: string;
  heading?: string;
  /** JSON: [{ severity, agent, title, since }] */
  issuesJson?: string;
  /** JSON: [{ heading, message, url }] — the day's reminders for this person. */
  remindersJson?: string;
  actionUrl?: string;
}

type Row = { severity: string; agent: string; title: string; since: string };
type Reminder = { heading: string; message: string; url: string };

function remindersOf(json: string | undefined): Reminder[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter((r): r is Reminder => Boolean(r) && typeof (r as Reminder).heading === "string")
      : [];
  } catch {
    return [];
  }
}

function rowsOf(json: string | undefined): Row[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter((r): r is Row => Boolean(r) && typeof (r as Row).title === "string")
      : [];
  } catch {
    return [];
  }
}

const { text, link } = layoutStyles;
const cell: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid #e5e7eb",
  fontSize: "13px",
  verticalAlign: "top",
  textAlign: "left",
};
const head: React.CSSProperties = { ...cell, fontWeight: 600, color: "#374151" };

const Email = ({
  memberName,
  orgName = "your organisation",
  heading = "Today",
  issuesJson,
  remindersJson,
  actionUrl,
}: Props) => {
  const rows = rowsOf(issuesJson);
  const reminders = remindersOf(remindersJson);
  return (
    <EmailLayout
      preview={heading}
      orgName={orgName}
      heading={heading}
      greeting={memberName ? `Hi ${memberName},` : "Hello,"}
    >
      {reminders.length ? (
        <>
          <p style={{ ...text, fontWeight: 600 }}>Waiting for you</p>
          <table
            cellPadding={0}
            cellSpacing={0}
            style={{ width: "100%", borderCollapse: "collapse" }}
          >
            <tbody>
              {reminders.map((r, i) => (
                <tr key={i}>
                  <td style={cell}>
                    {r.url ? (
                      <a href={r.url} style={link}>
                        {r.heading}
                      </a>
                    ) : (
                      r.heading
                    )}
                    {r.message ? <div style={{ color: "#4b5563" }}>{r.message}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {rows.length ? (
        <>
          <p style={{ ...text, fontWeight: 600 }}>Agent issues still open</p>
          <table
            cellPadding={0}
            cellSpacing={0}
            style={{ width: "100%", borderCollapse: "collapse" }}
          >
            <thead>
              <tr>
                <th style={head}>Severity</th>
                <th style={head}>Agent</th>
                <th style={head}>Issue</th>
                <th style={head}>Since</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ ...cell, color: r.severity === "critical" ? "#b91c1c" : "#b45309" }}>
                    {r.severity}
                  </td>
                  <td style={cell}>{r.agent}</td>
                  <td style={cell}>{r.title}</td>
                  <td style={cell}>{r.since}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {actionUrl ? (
        <p style={text}>
          <a href={actionUrl} style={link}>
            Open Agent observability
          </a>
        </p>
      ) : null}
    </EmailLayout>
  );
};

export const template = {
  component: Email,
  subject: (data: Props) => data["heading"] ?? "Today",
  displayName: "End-of-day summary",
  previewData: {
    memberName: "Ravi",
    orgName: "Yavar TechWorks",
    heading: "Today: 1 waiting for you, 2 agent issues open",
    remindersJson: JSON.stringify([
      {
        heading: "REQ-2026-104 is waiting for your approval",
        message: "Backend Engineer ×2 has waited 3 days.",
        url: "https://example.com/requisitions/1",
      },
    ]),
    issuesJson: JSON.stringify([
      { severity: "critical", agent: "Orchestrator", title: "1 run stuck", since: "21 Nov, 14:02" },
      {
        severity: "serious",
        agent: "Offer",
        title: "REQ-2026-011 pays in USD, but its zone pays in INR",
        since: "19 Nov, 09:10",
      },
    ]),
    actionUrl: "https://example.com/agents/observability",
  },
} satisfies TemplateEntry;
