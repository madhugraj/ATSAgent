/**
 * The markdown agents write in chat renders as structure — tables, lists,
 * links — and always stays escaped (agent text can carry third-party content).
 * Run: bun test scripts/agent-markdown.test.ts
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentMarkdown } from "../src/components/AgentMarkdown";

const html = (text: string) => renderToStaticMarkup(createElement(AgentMarkdown, { text }));

describe("agent markdown", () => {
  test("a table renders as a table, not pipes", () => {
    const out = html(
      "### Screening Summary\n\n| Candidate | Status |\n| :--- | :--- |\n| Madhumathi Rajesh | Sent (Due: 2026-10-15) |",
    );
    expect(out).toContain("<table");
    expect(out).toContain("<th");
    expect(out).toContain("<td");
    expect(out).toContain("Madhumathi Rajesh");
    expect(out).not.toContain("| :---");
    expect(out).toContain('<p class="font-semibold">Screening Summary</p>');
  });

  test("lists, bold, italics and code", () => {
    const out = html("1. **Enable** boards\n2. Review *skills*\n\n- one\n- `two`");
    expect(out).toContain("<ol");
    expect(out).toContain("<ul");
    expect(out).toContain("<strong>Enable</strong>");
    expect(out).toContain("<em>skills</em>");
    expect(out).toContain("two</code>");
  });

  test("links: http(s) only, a code-wrapped URL is a link, trailing punctuation stays text", () => {
    const out = html(
      "Apply (`http://localhost:9000/apply/abc`). See [the JD](https://example.com/jd). Bad [x](javascript:alert(1))",
    );
    expect(out).toContain('href="http://localhost:9000/apply/abc"');
    expect(out).toContain('href="https://example.com/jd"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain('javascript:alert(1)"');
    expect(out).not.toMatch(/href="javascript/);
  });

  test("an unclosed backtick stays a backtick; HTML in agent text stays escaped", () => {
    const out = html(
      "link (`http://localhost:9000/apply/) here <script>alert(1)</script> <b>x</b>",
    );
    expect(out).toContain("(`");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<b>x</b>");
  });

  test("in-app links stay in the tab and are marked internal; protocol-relative paths are not links", () => {
    const out = html(
      "Run it on [Agent settings](/agents/settings) or [activity](/agents?tab=activity). Not [evil](//evil.example) or [x](/\\evil).",
    );
    expect(out).toContain('href="/agents/settings" data-internal=""');
    expect(out).toContain('href="/agents?tab=activity" data-internal=""');
    expect(out).not.toContain('_blank">Agent settings');
    expect(out).not.toContain('href="//evil.example"');
    expect(out).not.toMatch(/href="\/\\/);
    expect(out).toContain("evil");
  });
});
