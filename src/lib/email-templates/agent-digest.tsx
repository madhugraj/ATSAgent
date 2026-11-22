import * as React from "react";

import type { TemplateEntry } from "./registry";
import { EmailLayout, layoutStyles } from "./email-layout";

/** End-of-day table of the organisation's open serious / critical agent issues. */
interface Props {
  memberName?: string;
  orgName?: string;
  heading?: string;
  /** JSON: [{ severity, agent, title, since }] */
  issuesJson?: string;
  actionUrl?: string;
}

type Row = { severity: string; agent: string; title: string; since: string };

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
  heading = "Agent issues today",
  issuesJson,
  actionUrl,
}: Props) => {
  const rows = rowsOf(issuesJson);
  return (
    <EmailLayout
      preview={heading}
      orgName={orgName}
      heading={heading}
      greeting={memberName ? `Hi ${memberName},` : "Hello,"}
    >
      <table cellPadding={0} cellSpacing={0} style={{ width: "100%", borderCollapse: "collapse" }}>
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
  subject: (data: Props) => data["heading"] ?? "Agent issues today",
  displayName: "Agent daily digest",
  previewData: {
    memberName: "Ravi",
    orgName: "Yavar TechWorks",
    heading: "2 agent issues open today",
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
