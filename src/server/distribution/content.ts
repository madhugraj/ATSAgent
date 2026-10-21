/**
 * What a role looks like when it leaves the organisation: the Google for Jobs
 * structured data on its apply page, the job feeds aggregators read, and the
 * text a person pastes into a portal. Pure — no database, no network — so
 * every format is unit-tested (scripts/job-distribution.test.ts).
 *
 * Only what a candidate may see goes out: never the budget, the pay band,
 * the scoring weights or anything from the approval trail.
 */

export type DistributableJob = {
  id: string;
  code: string;
  title: string;
  location: string | null;
  workMode: "onsite" | "hybrid" | "remote" | null;
  openings: number;
  experienceMin: number;
  experienceMax: number;
  mustHave: string[];
  goodToHave: string[];
  /** Plain text: the approved job description, or one built from the requisition. */
  description: string;
  company: string;
  /** ISO 3166-1 alpha-2, from the organisation's HQ country; null when unknown. */
  country: string | null;
  countryName: string | null;
  /** When the role went out on this channel (or was opened). */
  postedAt: Date;
  /** Hired for a client rather than by the organisation itself. */
  forClient: boolean;
};

/* ------------------------------------------------------------ description */

/** The text candidates read: the approved JD, else one built from the requisition. */
export function describeJob(input: {
  jdText: string | null;
  responsibilities: string | null;
  mustHave: string[];
  goodToHave: string[];
}): string {
  const jd = (input.jdText ?? "").trim();
  if (jd) return jd;
  const parts: string[] = [];
  if (input.responsibilities?.trim()) parts.push(input.responsibilities.trim());
  if (input.mustHave.length)
    parts.push(`Must have:\n${input.mustHave.map((s) => `- ${s}`).join("\n")}`);
  if (input.goodToHave.length)
    parts.push(`Good to have:\n${input.goodToHave.map((s) => `- ${s}`).join("\n")}`);
  return parts.join("\n\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(s: string): string {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/** Plain or light-markdown text as simple, escaped HTML (headings, lists, paragraphs). */
export function textToHtml(text: string): string {
  const out: string[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    let list: string[] = [];
    let para: string[] = [];
    const flush = () => {
      if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
      if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      list = [];
      para = [];
    };
    for (const raw of lines) {
      const line = raw.trim();
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        out.push(`<h3>${inline(heading[1]!)}</h3>`);
      } else if (bullet) {
        if (para.length) flush();
        list.push(bullet[1]!);
      } else {
        if (list.length) flush();
        para.push(line);
      }
    }
    flush();
  }
  return out.join("\n");
}

/** Markdown markers removed, for portals that take plain text. */
export function plainText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[*•]\s+/gm, "- ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * E-mail addresses, phone numbers and links taken out of a portal posting:
 * portals forbid or strip them, and applications should come through the
 * tracked apply link or the portal itself.
 */
export function stripContactDetails(text: string): string {
  return text
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/(?:\+?\d[\d\s().-]{8,}\d)/g, (m) => (m.replace(/\D/g, "").length >= 10 ? "" : m))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/* --------------------------------------------------------------- location */

const COUNTRY_CODES: Record<string, string> = {
  india: "IN",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  australia: "AU",
  singapore: "SG",
  "united arab emirates": "AE",
  uae: "AE",
  canada: "CA",
  germany: "DE",
  france: "FR",
  netherlands: "NL",
  "new zealand": "NZ",
  "south africa": "ZA",
  ireland: "IE",
  malaysia: "MY",
  philippines: "PH",
  "saudi arabia": "SA",
  qatar: "QA",
  japan: "JP",
  brazil: "BR",
  mexico: "MX",
  spain: "ES",
  italy: "IT",
  poland: "PL",
  austria: "AT",
  belgium: "BE",
  switzerland: "CH",
  sweden: "SE",
  indonesia: "ID",
  "hong kong": "HK",
  "sri lanka": "LK",
  bangladesh: "BD",
  nepal: "NP",
  kenya: "KE",
  nigeria: "NG",
  egypt: "EG",
};

/** ISO 3166-1 alpha-2 for a country as people write it; null when unknown. */
export function countryCode(country: string | null | undefined): string | null {
  const c = (country ?? "").trim();
  if (!c) return null;
  if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase() === "UK" ? "GB" : c.toUpperCase();
  return COUNTRY_CODES[c.toLowerCase().replace(/\s+/g, " ")] ?? null;
}

/** "Bengaluru / Chennai; Pune" → three places. Commas stay (Bengaluru, Karnataka). */
export function places(location: string | null): string[] {
  return (location ?? "")
    .split(/\s*(?:\/|;|\||\bor\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function locationLine(job: DistributableJob): string {
  if (job.workMode === "remote") return `Remote${job.countryName ? ` (${job.countryName})` : ""}`;
  return places(job.location).join(" / ") || job.countryName || "";
}

/* ---------------------------------------------------------- Google for Jobs */

/** Why a role cannot be listed on Google for Jobs yet, in plain words (empty = ready). */
export function listingGaps(job: DistributableJob): string[] {
  const gaps: string[] = [];
  if (job.description.trim().length < 100)
    gaps.push("The job description is too short — approve a job description for this role.");
  if (job.workMode === "remote") {
    if (!job.country)
      gaps.push(
        "A remote role needs the country candidates must live in — set your HQ country in Organisation settings.",
      );
  } else if (!places(job.location).length) {
    gaps.push("Add the role's location.");
  }
  return gaps;
}

/**
 * schema.org JobPosting for the apply page, following Google's required and
 * recommended properties. Null when a required property is missing.
 */
export function jobPostingJsonLd(job: DistributableJob): Record<string, unknown> | null {
  if (listingGaps(job).length) return null;
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: job.title,
    description: textToHtml(job.description),
    datePosted: job.postedAt.toISOString().slice(0, 10),
    identifier: { "@type": "PropertyValue", name: job.company, value: job.code },
    hiringOrganization: { "@type": "Organization", name: job.company },
    directApply: true,
    totalJobOpenings: job.openings,
  };
  if (job.experienceMin > 0)
    ld["experienceRequirements"] = {
      "@type": "OccupationalExperienceRequirements",
      monthsOfExperience: job.experienceMin * 12,
    };
  const skills = [...job.mustHave, ...job.goodToHave];
  if (skills.length) ld["skills"] = skills.join(", ");
  if (job.workMode === "remote") {
    ld["jobLocationType"] = "TELECOMMUTE";
    ld["applicantLocationRequirements"] = { "@type": "Country", name: job.countryName };
  } else {
    ld["jobLocation"] = places(job.location).map((p) => ({
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: p,
        ...(job.country ? { addressCountry: job.country } : {}),
      },
    }));
  }
  return ld;
}

/** JSON for an inline <script type="application/ld+json">: no "<" can close the tag. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/* ---------------------------------------------------------------- feeds */

/** Characters XML 1.0 does not allow are dropped. */
function xmlSafe(s: string): string {
  // eslint-disable-next-line no-control-regex -- the allowed XML 1.0 characters are listed on purpose
  return s.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "");
}

export function cdata(s: string): string {
  return `<![CDATA[${xmlSafe(s).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function xmlText(s: string): string {
  return xmlSafe(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ddmmyyyy(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

export type FeedJob = DistributableJob & { applyUrl: string };

/** Jooble's XML feed specification (jooble.org/files/xml_feed_specifications.pdf). */
export function joobleFeed(jobs: FeedJob[]): string {
  const items = jobs.map(
    (j) =>
      `<job id="${xmlText(j.id)}">` +
      `<link>${cdata(j.applyUrl)}</link>` +
      `<name>${cdata(j.title)}</name>` +
      `<region>${cdata(locationLine(j))}</region>` +
      `<description>${cdata(textToHtml(j.description))}</description>` +
      `<pubdate>${cdata(ddmmyyyy(j.postedAt))}</pubdate>` +
      `<updated>${cdata(ddmmyyyy(j.postedAt))}</updated>` +
      `<company>${cdata(j.company)}</company>` +
      `</job>`,
  );
  return `<?xml version="1.0" encoding="utf-8"?>\n<jobs>\n${items.join("\n")}\n</jobs>\n`;
}

/** Adzuna's XML job feed (adzuna.co.uk/jobs/xml-specification.html). */
export function adzunaFeed(jobs: FeedJob[]): string {
  const items = jobs.map(
    (j) =>
      `<job>` +
      `<title>${cdata(j.title)}</title>` +
      `<id>${cdata(j.id)}</id>` +
      `<description>${cdata(textToHtml(j.description))}</description>` +
      `<url>${cdata(j.applyUrl)}</url>` +
      `<location>${cdata(locationLine(j))}</location>` +
      (j.country ? `<country>${cdata(j.country)}</country>` : "") +
      `<company>${cdata(j.company)}</company>` +
      `<date>${cdata(j.postedAt.toISOString().slice(0, 10))}</date>` +
      `</job>`,
  );
  return `<?xml version="1.0" encoding="utf-8"?>\n<jobs>\n${items.join("\n")}\n</jobs>\n`;
}

/** Jora's XML feed (support.jora.com, "Get your jobs published on Jora with an XML feed"). */
export function joraFeed(jobs: FeedJob[], publisher: { name: string; url: string }): string {
  const items = jobs.map((j) => {
    const [city] = places(j.location);
    return (
      `<job>` +
      `<title>${cdata(j.title)}</title>` +
      `<id>${cdata(j.id)}</id>` +
      `<description>${cdata(textToHtml(j.description))}</description>` +
      `<url>${cdata(j.applyUrl)}</url>` +
      `<location>${cdata(locationLine(j))}</location>` +
      (city && j.workMode !== "remote" ? `<city>${cdata(city)}</city>` : "") +
      (j.country ? `<country>${cdata(j.country)}</country>` : "") +
      `<listed_date>${cdata(j.postedAt.toISOString())}</listed_date>` +
      `<organisation>${cdata(j.company)}</organisation>` +
      `</job>`
    );
  });
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n<source>\n` +
    `<publisher>${cdata(publisher.name)}</publisher>\n` +
    `<publisherurl>${cdata(publisher.url)}</publisherurl>\n` +
    `<lastBuildDate>${cdata(new Date().toISOString())}</lastBuildDate>\n` +
    `${items.join("\n")}\n</source>\n`
  );
}

/* --------------------------------------------------------- posting pack */

/** The copy a person pastes into a portal: contact details out, plain text. */
export function packText(job: DistributableJob, applyUrl: string | null): string {
  const lines = [
    job.title,
    [
      locationLine(job),
      `${job.experienceMin}–${job.experienceMax} years`,
      `${job.openings} opening${job.openings === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join(" · "),
    "",
    stripContactDetails(plainText(job.description)),
  ];
  if (job.mustHave.length && !/must have/i.test(job.description))
    lines.push("", `Must have: ${job.mustHave.join(", ")}`);
  if (applyUrl) lines.push("", `Apply: ${applyUrl}`);
  return lines.join("\n").trim();
}
