import type { ReactNode } from "react";

/**
 * The markdown agents write in chat — headings, tables, bullet and numbered
 * lists, rules, **bold**, *italics*, `code` and links — rendered as React
 * elements, never as HTML: agent text can carry third-party content (a CV, a
 * web page), so it always stays escaped. Links open only for http(s).
 */
export function AgentMarkdown({ text }: { text: string }) {
  return <div className="space-y-2">{blocks(text)}</div>;
}

/* ------------------------------------------------------------ inline */

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

function link(href: string, label: ReactNode, key: string) {
  // Trailing punctuation belongs to the sentence, not the link.
  const m = /^(.*?)([.,;:!?)]*)$/.exec(href)!;
  const url = m[1]!;
  if (!SAFE_URL.test(url)) return <span key={key}>{href}</span>;
  return (
    <span key={key}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-primary underline underline-offset-2"
      >
        {label === null ? url : label}
      </a>
      {m[2]}
    </span>
  );
}

/** Bold, italics, code, [text](url) and bare URLs. An unclosed backtick stays a backtick. */
function inline(text: string, keyBase = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(\*\*[^*]+\*\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>()`'"]+)|(\*[^*\s][^*\n]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${n++}`;
    const t = m[0];
    if (m[1]) out.push(<strong key={key}>{inline(t.slice(2, -2), key)}</strong>);
    else if (m[2]) {
      const inner = t.slice(1, -1);
      out.push(
        SAFE_URL.test(inner) ? (
          link(inner, null, key)
        ) : (
          <code key={key} className="rounded bg-background/60 px-1 text-[0.9em]">
            {inner}
          </code>
        ),
      );
    } else if (m[3]) {
      const label = t.slice(1, t.indexOf("]("));
      out.push(link(t.slice(t.indexOf("](") + 2, -1), inline(label, key), key));
    } else if (m[4]) out.push(link(t, null, key));
    else if (m[5]) out.push(<em key={key}>{inline(t.slice(1, -1), key)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ------------------------------------------------------------ blocks */

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
const bullet = /^\s*[-*•]\s+(.*)$/;
const numbered = /^\s*(\d+)[.)]\s+(.*)$/;

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${k++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    // Table: a row, a separator, then rows.
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push(
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[0.92em]">
            <thead>
              <tr className="border-b border-border">
                {head.map((h, j) => (
                  <th key={j} className="px-2 py-1 font-semibold">
                    {inline(h, `${key}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-border/50 align-top">
                  {head.map((_, j) => (
                    <td key={j} className="px-2 py-1">
                      {inline(r[j] ?? "", `${key}r${ri}c${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        <p key={key} className="font-semibold">
          {inline(heading[2]!, key)}
        </p>,
      );
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr key={key} className="border-border" />);
      i++;
      continue;
    }
    if (bullet.test(line)) {
      const items: string[] = [];
      while (i < lines.length && bullet.test(lines[i]!)) items.push(bullet.exec(lines[i++]!)![1]!);
      out.push(
        <ul key={key} className="list-disc space-y-0.5 pl-5">
          {items.map((t, j) => (
            <li key={j}>{inline(t, `${key}-${j}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (numbered.test(line)) {
      const start = Number(numbered.exec(line)![1]);
      const items: string[] = [];
      while (i < lines.length && numbered.test(lines[i]!))
        items.push(numbered.exec(lines[i++]!)![2]!);
      out.push(
        <ol key={key} start={start} className="list-decimal space-y-0.5 pl-5">
          {items.map((t, j) => (
            <li key={j}>{inline(t, `${key}-${j}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    // A paragraph: consecutive plain lines, line breaks kept.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !(isTableRow(lines[i]!) && i + 1 < lines.length && isTableSep(lines[i + 1]!)) &&
      !/^\s*#{1,6}\s/.test(lines[i]!) &&
      !bullet.test(lines[i]!) &&
      !numbered.test(lines[i]!)
    )
      para.push(lines[i++]!);
    out.push(
      <p key={key} className="whitespace-pre-wrap">
        {para.flatMap((l, j) => [...(j ? ["\n"] : []), ...inline(l, `${key}-${j}`)])}
      </p>,
    );
  }
  return out;
}
