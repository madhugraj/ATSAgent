/**
 * The ATSIQ product catalogue: every shipped module, what it does, who it serves and the
 * capabilities inside it. This is the single source of truth for the super-admin catalogue
 * page and for the PDF / Excel exports, so it must describe what the product actually does.
 */

export type CatalogueModule = {
  id: string;
  name: string;
  category: string;
  audience: string;
  summary: string;
  outcome: string;
  capabilities: string[];
  defaultTier: string;
};

export const CATALOGUE_MODULES: CatalogueModule[] = [
  {
    id: "tenancy",
    name: "Multi-tenant enterprise onboarding",
    category: "Platform",
    audience: "Product owner, organisation owner",
    summary:
      "Each organisation registers with its own verified work-email domain, is approved by the product owner and then runs fully isolated from every other tenant.",
    outcome: "One deployment serves many client organisations with no data crossover.",
    capabilities: [
      "Guided organisation registration with mandatory legal, industry, HQ, currency and careers-inbox details",
      "Work-email validation: free and disposable domains blocked, one registrable domain per organisation",
      "Product-owner approval, rejection with reason, archive, restore and permanent deletion",
      "Row-level security on every record, plus organisation-scoped indexes",
      "Departments and locations captured at onboarding",
    ],
    defaultTier: "Included",
  },
  {
    id: "rbac",
    name: "Users, roles & access control",
    category: "Platform",
    audience: "Organisation owner, HR head",
    summary:
      "Organisation-scoped user administration with role grants, invitations and lifecycle control, on a dense table that scales to very large teams.",
    outcome: "Every person sees exactly the data and actions their role allows.",
    capabilities: [
      "Roles: owner, CHRO, HR head, recruiter, interviewer, hiring manager",
      "Email invitations with branded templates and joining status",
      "Grant and revoke roles, pause, restore and permanently delete users",
      "Owner protection and audit of privilege changes",
      "Search, filters, pagination to 250 rows and CSV export",
    ],
    defaultTier: "Included",
  },
  {
    id: "requisitions",
    name: "Requisitions & approvals",
    category: "Hiring workflow",
    audience: "Hiring manager, HR head, CHRO",
    summary:
      "Raise a role once, route it for approval and publish it internally and externally without retyping the job description.",
    outcome: "Approved roles reach the market faster with a clean audit trail.",
    capabilities: [
      "Requisition intake with budget, openings, experience band, skills, responsibilities and qualifications",
      "CHRO and department-head approval chain with aging visibility",
      "Near-duplicate job description detection before a role is raised",
      "Internal job posting (IJP) and public apply links",
      "AI drafting of skills, qualifications and responsibilities from the role title",
    ],
    defaultTier: "Included",
  },
  {
    id: "matching",
    name: "JD ↔ CV matching engine",
    category: "Intelligence",
    audience: "Recruiter, HR head",
    summary:
      "Explainable weighted scoring of every CV against a job description, with configurable weights and evidence for each score.",
    outcome: "Recruiters shortlist on evidence instead of keyword luck.",
    capabilities: [
      "Weighted model across skills, experience, career history, impact, education and public signals",
      "Configurable weights per organisation, with AI weight suggestions",
      "Single and bulk scoring runs across a whole talent pool",
      "Rationale, matched and missing skills for every score",
      "Historic pool suggestions for newly raised roles",
    ],
    defaultTier: "Included",
  },
  {
    id: "screening",
    name: "Screening-call support",
    category: "Intelligence",
    audience: "Recruiter",
    summary:
      "An assistant that writes the preliminary questions for a specific JD and CV, then grades the candidate's answers.",
    outcome: "Every screening call is consistent, defensible and scored.",
    capabilities: [
      "8–10 role-specific questions with the reason to ask and the expected strong answer",
      "Editable, printable and copyable question kits stored per candidate and role",
      "Typed answers, whole-call notes or private audio recordings",
      "Per-question verdicts with evidence, red flags and a recommendation",
      "Combined fit score blending CV match with screening outcome",
    ],
    defaultTier: "Growth",
  },
  {
    id: "sourcing",
    name: "Sourcing & CV intake",
    category: "Sourcing",
    audience: "Recruiter",
    summary:
      "CVs reach the pool automatically from the careers inbox, bulk uploads, apply links and the LinkedIn Recruiter companion.",
    outcome: "No CV is left sitting in a mailbox unparsed.",
    capabilities: [
      "Careers-inbox watching with automatic filing, parsing and scoring",
      "Bulk PDF and DOCX upload with structured parsing",
      "Browser companion for LinkedIn Recruiter: profile capture and CV download",
      "Source and timestamp recorded per candidate (manual, companion, inbox, LinkedIn, Naukri, Indeed, referral, consultant, campus, IJP)",
      "Original CV files kept in a private vault with short-lived download links",
    ],
    defaultTier: "Growth",
  },
  {
    id: "pool",
    name: "Talent pool & hygiene",
    category: "Sourcing",
    audience: "Recruiter, HR head",
    summary:
      "A master-detail workspace over the whole pool with Excel-style filters, duplicate control and CV freshness classification.",
    outcome: "A pool that stays trustworthy as it grows past a hundred thousand records.",
    capabilities: [
      "List plus dossier layout with search, column filters and saved views",
      "Identity normalisation, duplicate grouping and safe merging",
      "Freshness bands: fresh to 90 days, aging to a year, stale beyond",
      "Full dossier: employment history, skills, education, compensation, contact completeness, pipeline",
      "Bulk actions and CSV export",
    ],
    defaultTier: "Included",
  },
  {
    id: "verification",
    name: "Public-signal verification",
    category: "Intelligence",
    audience: "Recruiter, HR head",
    summary:
      "Live checking of the public profiles a candidate shares, scored and audited rather than taken on trust.",
    outcome: "Claims on a CV are corroborated before an interview is booked.",
    capabilities: [
      "LinkedIn and GitHub public-signal fetching and analysis",
      "Authenticity score with the evidence behind it",
      "Career history, impact, innovation and mindset signals",
      "Audit record of every verification run",
      "Logistics and risk flags surfaced on the dossier",
    ],
    defaultTier: "Growth",
  },
  {
    id: "interviews",
    name: "Interviews & scorecards",
    category: "Hiring workflow",
    audience: "Recruiter, interviewer, hiring manager",
    summary:
      "Scheduling with calendar and meeting links, competency scorecards and audited stage decisions.",
    outcome: "Interview outcomes are recorded once and cannot be quietly edited.",
    capabilities: [
      "Zoom, Google Meet and Microsoft Teams meeting creation, plus .ics invites",
      "Interviewer workspace with their own panel list",
      "Competency scorecards that lock on submission",
      "Reschedule and cancel with a mandatory reason",
      "Select, hold or reject decisions with destination-specific reasons",
    ],
    defaultTier: "Included",
  },
  {
    id: "offers",
    name: "Offers & candidate lifecycle",
    category: "Hiring workflow",
    audience: "Recruiter, HR head",
    summary:
      "A state machine covering every candidate outcome from applied through joined, with offer handling in between.",
    outcome: "Nobody is lost between 'offered' and 'joined'.",
    capabilities: [
      "Offer stage with acceptance tracking",
      "States for rejected, accepted, joined and not joined, each with reasons",
      "Stage event history per candidate",
      "Stalled-candidate detection",
      "Ownership and next-action visibility",
    ],
    defaultTier: "Included",
  },
  {
    id: "benchmarking",
    name: "Market compensation benchmarking",
    category: "Intelligence",
    audience: "Hiring manager, HR head, CHRO",
    summary:
      "On-demand salary ranges for a role and level, drawn from live public sources with the evidence attached.",
    outcome: "Budgets are set against the market, not last year's band.",
    capabilities: [
      "Low, median and high compensation with a recommended CTC band",
      "Confidence rating and source status per source",
      "Quoted evidence and source links for transparency",
      "Caveats stated where data is interpolated or estimated",
      "Runs inside the requisition form at the point of decision",
    ],
    defaultTier: "Growth",
  },
  {
    id: "collaboration",
    name: "Ownership, referrals & team sharing",
    category: "Collaboration",
    audience: "Recruiter, HR head",
    summary:
      "A shared organisation pool where each candidate still has an owner, so recruiters can hand work over deliberately.",
    outcome: "Recruiters cooperate on candidates without stepping on each other.",
    capabilities: [
      "Candidate ownership with My candidates and All candidates views",
      "Ownership transfer and take-ownership, fully audited",
      "Refer a candidate to a colleague's role, with accept or decline",
      "Requests for talent and candidate suggestions between recruiters",
      "Candidate notes with @mentions",
      "Opt-in cross-organisation consortium pool sharing",
    ],
    defaultTier: "Growth",
  },
  {
    id: "talent-brain",
    name: "Talent Brain & skill ontology",
    category: "Leadership",
    audience: "CHRO, HR head, owner, product owner",
    summary:
      "A living organisational knowledge graph that connects skills, people, open-role demand and proven hiring outcomes.",
    outcome:
      "Leadership can see capability risk early and decide what talent to hire, build, borrow or redeploy.",
    capabilities: [
      "Graphical skill ontology grouped into canonical capability families and aliases",
      "Supply, weighted demand, hiring validation, scarcity and evidence recency per skill",
      "Skill-adjacency and bridge analysis for reskilling and internal mobility",
      "Emerging, fading, dormant and retired skill lifecycle with historical snapshots",
      "Executive narrative plus evidence-based decisions and prescriptions",
      "Organisation view for leadership and aggregate all-organisation view for the product owner",
      "Uses each client's configured AI provider while retaining deterministic analysis when AI is unavailable",
    ],
    defaultTier: "Enterprise",
  },
  {
    id: "performance",
    name: "Recruiter performance & incentives",
    category: "Leadership",
    audience: "CHRO, HR head, owner",
    summary:
      "Leadership-only reporting on how each recruiter performs, and what that earns them under the incentive scheme.",
    outcome: "Incentives are computed from real pipeline activity, not opinion.",
    capabilities: [
      "Activity, quality, conversion and speed metrics per recruiter",
      "Target attainment and a composite performance score",
      "Incentive bands and caps with the workings shown",
      "Leadership-gated: recruiters cannot see the board",
      "CSV export for payroll review",
    ],
    defaultTier: "Enterprise",
  },
  {
    id: "analytics",
    name: "Reports & executive dashboards",
    category: "Leadership",
    audience: "CHRO, HR head, owner, product owner",
    summary:
      "Role-aware dashboards: prescriptions and governance for leadership, work queues for recruiters.",
    outcome: "Leaders get decisions to make, not charts to interpret.",
    capabilities: [
      "Funnel, drop-off, source effectiveness, score distribution and scarce-skill analytics",
      "Approval aging, SLA breaches, roles without candidates and stale-pool hygiene",
      "Screening coverage, offer acceptance, match quality and budget risk",
      "Department, requisition and interviewer-load views",
      "Cross-organisation aggregate band for the product owner",
      "CSV export throughout",
    ],
    defaultTier: "Included",
  },
  {
    id: "copilot",
    name: "Aditi — embedded HR copilot",
    category: "Intelligence",
    audience: "Whole HR team",
    summary:
      "A chat assistant grounded in the organisation's own data and the product manual, so teams can self-serve.",
    outcome: "New HR users configure and operate the product without training sessions.",
    capabilities: [
      "Organisation-scoped conversation persisted in the database",
      "Tool calling over live requisitions, candidates and pipeline data",
      "Answers grounded in the built-in user manual",
      "Available on every screen",
    ],
    defaultTier: "Growth",
  },
  {
    id: "ai-keys",
    name: "Bring-your-own AI keys",
    category: "Platform",
    audience: "Organisation owner",
    summary:
      "Each organisation can run all intelligence features on its own API key, with its choice of provider and model.",
    outcome: "Clients own and control their AI spend.",
    capabilities: [
      "Per-organisation provider, model and key configuration",
      "Key validation and a Test model action against the exact configuration on screen",
      "Current model choices across supported providers",
      "Usage of every AI call tracked per organisation",
    ],
    defaultTier: "Included",
  },
  {
    id: "governance",
    name: "Security, audit & governance",
    category: "Platform",
    audience: "Product owner, organisation owner",
    summary:
      "Tenant isolation, private file storage and audit trails across the workflow, plus a product-owner console.",
    outcome: "The product stands up to enterprise security review.",
    capabilities: [
      "Row-level security on all tenant tables, with tenant-scoped policies",
      "Private vaults for CV files and screening audio, with signed short-lived links",
      "Audit trails for stage changes, ownership, verification and privilege changes",
      "Notifications with actionable items",
      "Product-owner console: every organisation, its usage and its lifecycle",
    ],
    defaultTier: "Included",
  },
];

export const CATALOGUE_TIERS = ["Included", "Growth", "Enterprise", "Add-on"] as const;

export const CATALOGUE_SUMMARY = {
  name: "ATSIQ by Yavar AI",
  tagline: "Enterprise recruiting operating system",
  positioning:
    "One multi-tenant platform covering requisition to joining: evidence-based JD↔CV matching, screening support, verified candidate signals, market-aligned budgets, recruiter governance and leadership analytics.",
};

export function totalCapabilities() {
  return CATALOGUE_MODULES.reduce((n, m) => n + m.capabilities.length, 0);
}
