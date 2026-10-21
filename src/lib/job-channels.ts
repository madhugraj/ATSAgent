/**
 * Where a role can be advertised, and how each place works — verified against
 * each portal's own employer, partner and developer pages on 2026-10-21
 * (docs/job-distribution-research.md has the sources). Client-safe: the
 * requisition page, the Job distribution page, the apply page and the
 * reports all read this one list, so a channel's name, route and tracked
 * source can never drift between them.
 *
 * Routes:
 *  - structured_data: listed from our own apply page (Google for Jobs).
 *  - feed: the organisation's job feed, read by the aggregator.
 *  - partner_api: a partner integration (Integrations page); can also be
 *    posted by hand with a posting pack until the partnership is in place.
 *  - assisted: no integration exists — a person posts the prepared pack.
 *  - own: our own pages, inbox and invitations.
 */

export type ChannelRoute = "structured_data" | "feed" | "partner_api" | "assisted" | "own";

export type FeedFormat = "jooble" | "adzuna" | "jora";

export type JobChannel = {
  /** Also the `source` recorded on an application and the `?src=` of a tracked link. */
  id: string;
  name: string;
  route: ChannelRoute;
  region: string;
  /** How applicants come back to us, in plain words. */
  applications: string;
  /** Cost or approval, in plain words. */
  cost: string;
  /** Where an employer posts or registers (official page). */
  portalUrl: string | null;
  /** Whether the portal accepts an outside apply link in a posting. */
  externalLink: "yes" | "unknown" | "no";
  /** Steps for a person posting by hand (assisted and partner channels). */
  steps?: string[];
  /** What we could not verify, or a caution worth knowing. */
  caution?: string;
  feedFormat?: FeedFormat;
};

export const JOB_CHANNELS: JobChannel[] = [
  {
    id: "google_jobs",
    name: "Google for Jobs",
    route: "structured_data",
    region: "Global",
    applications: "Candidates apply on your apply page.",
    cost: "Free; no approval.",
    portalUrl: "https://developers.google.com/search/docs/appearance/structured-data/job-posting",
    externalLink: "yes",
  },
  {
    id: "jooble",
    name: "Jooble",
    route: "feed",
    region: "About 66 countries",
    applications: "Candidates apply on your apply page.",
    cost: "Feed by support ticket; paid promotion optional (from about $200).",
    portalUrl:
      "https://help.jooble.org/en/support/solutions/articles/60000700159-can-i-publish-my-vacancies-via-ats-",
    externalLink: "yes",
    feedFormat: "jooble",
    steps: [
      "Open a ticket on Jooble's help portal (link above) asking to publish your vacancies from an XML feed.",
      "Paste your Jooble feed link from Job distribution → Job feeds.",
      "Jooble checks the vacancies, then reads the feed at least once a day.",
    ],
    caution:
      "Jooble only accepts jobs first published under 45 days before it first reads the feed, and no duplicates.",
  },
  {
    id: "adzuna",
    name: "Adzuna",
    route: "feed",
    region: "19 countries, including India",
    applications: "Candidates apply on your apply page.",
    cost: "Feed free; sponsored ads optional. Easy Apply into the ATS needs Adzuna's partnerships team.",
    portalUrl: "https://www.adzuna.com/hire/ats-integration/",
    externalLink: "yes",
    feedFormat: "adzuna",
    steps: [
      "Contact Adzuna through its ATS-integration page (link above) and give them your Adzuna feed link.",
      "Adzuna downloads the feed at least once a day.",
    ],
    caution: "Adzuna's feed specification was read from its 2020 copy; the live page is protected.",
  },
  {
    id: "jora",
    name: "Jora",
    route: "feed",
    region: "Australia only",
    applications: "Candidates apply on your apply page.",
    cost: "Free.",
    portalUrl:
      "https://support.jora.com/hc/en-us/articles/13919677306383-Get-your-jobs-published-on-Jora-with-an-XML-feed",
    externalLink: "yes",
    feedFormat: "jora",
    steps: [
      "Use Jora's contact form (link above) to register your Jora feed link.",
      "Jora reads it every 2 to 24 hours and removes a job when it leaves the feed.",
    ],
    caution:
      "Jora stopped direct posting on 17 Aug 2026 and closed outside Australia; only list Australian roles.",
  },
  {
    id: "linkedin",
    name: "LinkedIn Jobs",
    route: "partner_api",
    region: "Global",
    applications:
      "Posted by hand: candidates use your apply link. Delivered into the ATS only through LinkedIn's partner programme.",
    cost: "Basic jobs free by approved feed; promoted jobs pay per click. Partner approval needed.",
    portalUrl: "https://www.linkedin.com/talent/post-a-job",
    externalLink: "yes",
    steps: [
      "Post the job on LinkedIn using the text below.",
      "Set the apply method to an external website and paste the apply link.",
      "Come back and mark it posted, with the LinkedIn job link.",
    ],
    caution: "LinkedIn's job posting API is closed to new partners.",
  },
  {
    id: "indeed",
    name: "Indeed",
    route: "partner_api",
    region: "Global",
    applications:
      "Posted by hand: candidates use your apply link. Delivered into the ATS only through Indeed's partner programme.",
    cost: "Up to three free jobs a month posted directly; sponsored jobs paid. Partner agreement for the API.",
    portalUrl: "https://employers.indeed.com/",
    externalLink: "unknown",
    steps: [
      "Post the job on Indeed using the text below.",
      "If Indeed offers an external apply option, paste the apply link; otherwise download the CVs Indeed collects and upload them to this role with source Indeed.",
      "Mark it posted, with the Indeed job link.",
    ],
    caution: "Free XML feeds no longer list for free when the jobs could come through an ATS.",
  },
  {
    id: "naukri",
    name: "Naukri",
    route: "partner_api",
    region: "India",
    applications:
      "Posted by hand: in your Naukri dashboard. Delivered into the ATS once Naukri approves the partner API.",
    cost: "Paid Naukri plan; the partner API needs Naukri's approval.",
    portalUrl: "https://www.naukri.com/recruit/job-posting",
    externalLink: "unknown",
    steps: [
      "Post the job from your Naukri recruiter account using the text below.",
      "Applications arrive in your Naukri dashboard — download the CVs and upload them to this role with source Naukri, or forward them to your careers inbox.",
      "Mark it posted, with the Naukri job link.",
    ],
    caution:
      "Naukri's terms limit application data to the one role and ask for deletion when it closes.",
  },
  {
    id: "wellfound",
    name: "Wellfound",
    route: "assisted",
    region: "Global (start-ups)",
    applications: "Inside Wellfound; use your apply link where Wellfound allows it.",
    cost: "Free posting; paid plans optional.",
    portalUrl: "https://wellfound.com/recruit/overview",
    externalLink: "unknown",
    steps: [
      "Post the job on Wellfound using the text below (it asks about visa sponsorship).",
      "Download applicants' CVs from Wellfound and upload them to this role with source Wellfound.",
      "Mark it posted, with the Wellfound job link.",
    ],
    caution: "Wellfound syncs only with the ATSs it lists; there is no public API.",
  },
  {
    id: "timesjobs",
    name: "TimesJobs",
    route: "assisted",
    region: "India",
    applications: "Probably e-mail and your TimesJobs dashboard (not verified).",
    cost: "Paid plans (not verified).",
    portalUrl: "https://www.timesjobs.com/",
    externalLink: "unknown",
    steps: [
      "Post the job from your TimesJobs employer account using the text below.",
      "Set the application e-mail to your careers inbox if TimesJobs allows it, or upload the CVs to this role with source TimesJobs.",
      "Mark it posted, with the TimesJobs job link.",
    ],
    caution: "TimesJobs' site could not be read; ask their sales team about a feed or API.",
  },
  {
    id: "placementindia",
    name: "PlacementIndia",
    route: "assisted",
    region: "India",
    applications: "Your PlacementIndia dashboard, e-mail and SMS.",
    cost: "Free single post; paid packages.",
    portalUrl: "https://www.placementindia.com/job-recruiters/",
    externalLink: "unknown",
    steps: [
      "Post the job from your PlacementIndia account using the text below — it must not contain an e-mail, phone or address.",
      "Upload the CVs you receive to this role with source PlacementIndia.",
      "Mark it posted, with the PlacementIndia job link.",
    ],
  },
  {
    id: "jobhai",
    name: "Job Hai",
    route: "assisted",
    region: "India",
    applications: "Candidates phone you; applications in the Job Hai app.",
    cost: "Free up to 3 live jobs; paid credits.",
    portalUrl: "https://employer.jobhai.com/hire",
    externalLink: "no",
    steps: [
      "Post the job in the Job Hai recruiter app using the text below.",
      "Add the people you take forward to this role with source Job Hai.",
      "Mark it posted.",
    ],
    caution: "Job Hai's pages could not be read directly; details come from search results.",
  },
  {
    id: "workindia",
    name: "WorkIndia",
    route: "assisted",
    region: "India",
    applications: "Phone calls and WhatsApp; your WorkIndia dashboard.",
    cost: "Paid plans from ₹2,350.",
    portalUrl: "https://www.workindia.in/employers/",
    externalLink: "no",
    steps: [
      "Post the job on WorkIndia using the text below.",
      "Add the people you take forward to this role with source WorkIndia.",
      "Mark it posted.",
    ],
    caution: "WorkIndia does not serve placement agencies.",
  },
  {
    id: "apna",
    name: "Apna",
    route: "assisted",
    region: "India",
    applications: "Your Apna dashboard; spreadsheet export.",
    cost: "From ₹699 a post; integrations only on an enterprise plan.",
    portalUrl: "https://employer.apna.co/",
    externalLink: "no",
    steps: [
      "Post the job on Apna using the text below.",
      "Export the applicants and upload their CVs to this role with source Apna.",
      "Mark it posted, with the Apna job link.",
    ],
  },
  {
    id: "internshala",
    name: "Internshala",
    route: "assisted",
    region: "India (internships, fresher jobs)",
    applications: "Internshala's own tracker; Excel export on paid plans.",
    cost: "Free: 1 listing a month; paid plans.",
    portalUrl: "https://internshala.com/",
    externalLink: "no",
    steps: [
      "Post the listing on Internshala using the text below — each listing is reviewed.",
      "Internshala does not send applications to an outside ATS: export them and upload the CVs to this role with source Internshala.",
      "Mark it posted, with the Internshala listing link.",
    ],
  },
];

/** Sources that are ours rather than a portal's. */
const OWN_SOURCES: Record<string, string> = {
  careers_site: "Careers site",
  linkedin_post: "LinkedIn post",
  role_invite: "Invitation to apply",
  careers_inbox: "Careers inbox",
  direct: "Manual upload",
  bulk_upload: "Manual upload",
  hiring_desk: "Hiring desk upload",
  browser_capture: "LinkedIn companion",
  referral: "Referral",
  consultant: "Consultant",
  campus: "Campus",
  ijp: "Internal job posting",
  talent_pool: "Talent pool",
  agent_talent_pool: "Added by an agent from the talent pool",
  pool_match: "Talent pool match",
};

export function channelById(id: string | null | undefined): JobChannel | null {
  return JOB_CHANNELS.find((c) => c.id === id) ?? null;
}

/** People-readable name of an application source. */
export function sourceLabel(source: string | null | undefined): string {
  const key = (source ?? "").trim();
  if (!key) return "Unknown";
  return (
    channelById(key)?.name ??
    OWN_SOURCES[key] ??
    key.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase())
  );
}

/** Sources a person may pick when uploading CVs by hand. */
export const UPLOAD_SOURCES: string[] = [
  "direct",
  "referral",
  "consultant",
  "campus",
  "ijp",
  ...JOB_CHANNELS.filter((c) => c.id !== "google_jobs").map((c) => c.id),
];

/** Sources a tracked apply link may carry. */
const LINK_SOURCES = new Set<string>([
  ...JOB_CHANNELS.map((c) => c.id),
  "linkedin_post",
  "role_invite",
  "careers_site",
]);

/**
 * The source an apply-page visit is recorded under. Only known sources are
 * kept — anything else is the careers site — so a link cannot invent channels.
 * Google appends utm_source=google_jobs_apply to apply clicks it sends.
 */
export function resolveSource(
  src: string | null | undefined,
  utmSource?: string | null | undefined,
): string {
  const s = (src ?? "").trim().toLowerCase();
  if (LINK_SOURCES.has(s)) return s;
  const u = (utmSource ?? "").trim().toLowerCase();
  if (u === "google_jobs_apply") return "google_jobs";
  if (LINK_SOURCES.has(u)) return u;
  return "careers_site";
}

/** The apply link for a role, tagged with where it was shared. */
export function trackedApplyUrl(siteUrl: string, requisitionId: string, source?: string): string {
  const base = `${siteUrl.replace(/\/$/, "")}/apply/${requisitionId}`;
  return source && source !== "careers_site" ? `${base}?src=${encodeURIComponent(source)}` : base;
}

export const ROUTE_LABEL: Record<ChannelRoute, string> = {
  structured_data: "Listed from your apply page",
  feed: "Job feed",
  partner_api: "Partner integration",
  assisted: "Posted by a person",
  own: "Your own channels",
};
