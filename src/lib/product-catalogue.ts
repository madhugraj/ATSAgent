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
      "Tenant isolation enforced in server middleware, with an explicit organisation filter on every query",
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
      "Roles: organisation owner, President/CBO, HR head, department head, hiring manager and recruiter; any member can interview",
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
    audience: "Hiring manager, department head, HR head, CBO",
    summary:
      "Raise a role once, route it for approval and publish it internally and externally without retyping the job description.",
    outcome: "Approved roles reach the market faster with a clean audit trail.",
    capabilities: [
      "Requisition intake with budget, openings, experience band, skills, responsibilities and qualifications",
      "Department head → HR head → CBO approval chain with immutable decision trails and aging visibility",
      "Near-duplicate job description detection before a role is raised",
      "Internal job postings (IJP) and public apply links",
      "Content templates that steer every AI-drafted job description, LinkedIn post and branded job-card image",
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
      "Configurable weights per role, with AI weight advice drawn from the requisition, the approved organisation profile, role-ontology demand, pool supply and location",
      "Up to two custom scoring dimensions where the role calls for them (location fit, compliance, equipment expertise)",
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
      "Role expert brief from the hiring manager: must-ask questions and each round's rubric",
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
    name: "Talent Brain & organisation ontology",
    category: "Leadership",
    audience: "CHRO, HR head, owner, product owner",
    summary:
      "A living organisational knowledge graph that connects skills, people, open-role demand and proven hiring outcomes.",
    outcome:
      "Leadership can see capability risk early and decide what talent to hire, build, borrow or redeploy.",
    capabilities: [
      "Organisation ontology of roles and skills, with role emergence (new roles growing out of existing ones) and a full-screen 3D explorer",
      "Skill ontology inside the Talent Brain, grouped into canonical capability families and aliases",
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
      "Hiring cost and Return on Individual: what hiring cost and the capability it returned against goals",
      "CSV export throughout; PDF and Excel reports by period on the agent pages",
    ],
    defaultTier: "Included",
  },
  {
    id: "copilot",
    name: "Aditi — embedded HR copilot",
    category: "Intelligence",
    audience: "Whole HR team",
    summary:
      "Aditi, a chat assistant grounded in the organisation's own data and the product manual, answering within each person's role.",
    outcome: "New HR users configure and operate the product without training sessions.",
    capabilities: [
      "Answers by role: requisition status and approval trails, approvals waiting on you, pipeline, budgets and governance only where the role allows",
      "Talent-pool coverage per open role and a demand outlook (own requisition trend plus market signal, with confidence)",
      "Role ontology lookups and emerging roles",
      "Short formatted answers with links to the right page; a cause is named only when the data shows it",
      "Guided first-login journey and answers grounded in the built-in user manual",
      "Hands work to the hiring agent Arjun only when the person clicks",
      "Organisation-scoped conversation persisted per user, available on every screen",
    ],
    defaultTier: "Growth",
  },
  {
    id: "hiring-agents",
    name: "Hiring agents & Hiring desk",
    category: "Agents",
    audience: "Recruiter, hiring manager, HR head, CBO",
    summary:
      "Opt-in hiring agents that draft, match, screen, schedule and chase across the lifecycle, led by Arjun on the Hiring desk, while every approval, rejection, offer and hire stays with a person.",
    outcome: "Recruiters supervise the pipeline instead of pushing every step by hand.",
    capabilities: [
      "Hiring desk: describe a need in chat; Arjun gathers the details, reuses or creates the role, ranks candidates and lines up screening",
      "Specialist agents: requisition, JD, publishing, intake and matching, sourcing, distribution, organisation context, role expert interview, screening, follow-up, interview coordination, L1–L3 silent panel, evaluation, offer and pre-onboarding",
      "Per-agent autonomy: Suggest, Act and notify or Autonomous, with measured recommendations",
      "Agents never approve, reject, release, hire or accept — they propose and a person decides in Waiting for you or the thread",
      "Model safety check (attacks run against your own AI model) required before any agent works at Autonomous",
      "Injection-flagged text pauses a run for a person; run limits and a monthly token budget cap spend",
    ],
    defaultTier: "Enterprise",
  },
  {
    id: "voice-agents",
    name: "AI phone calls & Voice Guard",
    category: "Agents",
    audience: "Recruiter, HR head",
    summary:
      "AI phone calls through the organisation's own phone line for screening, interview scheduling and pay discussions, each reviewed afterwards by the Voice Guard.",
    outcome:
      "Shortlisted candidates are screened within the day, consistently, with every call checked.",
    capabilities: [
      "Screening calls: says it is an AI, asks consent, takes joining date and pay expectations (HR-only), asks the kit's questions and grades only what was answered",
      "Calling hours and days, retries, callbacks and a written-assessment fallback; candidates can opt out of AI calls",
      "Scheduling calls that book only offered or free interviewer times",
      "Pay calls that offer only the approved figure, never the ceiling; a yes comes back for a person to confirm",
      "Voice Guard: mandatory after-call review against the call's rules and facts, with transcript quotes, listed under Call reviews",
    ],
    defaultTier: "Add-on",
  },
  {
    id: "agent-oversight",
    name: "Agent observability & governance",
    category: "Agents",
    audience: "HR head, CBO, owner, product owner",
    summary:
      "Read-only oversight of every hiring agent: what it is, how it behaves, whether its guardrails hold, and what needs a person now.",
    outcome: "Leadership can show who did what, under which rules, and fix what drifts.",
    capabilities: [
      "Agent observability: 14-day trends, health issues opened and resolved by the health engine, alert e-mail and webhooks",
      "Agent register: owner, version, permission scope, must-never list, risk tier, tools and evals for every agent; each run records its version",
      "Agent intelligence and Agent governance: verdicts, fix lists, hand-off chains end to end, autonomy against risk tier and budget",
      "All / Voice / Text view on every agent page",
      "PDF and Excel reports by period and agent",
      "Optional OpenTelemetry trace export; cross-tenant agent and AI usage consoles for the product owner",
    ],
    defaultTier: "Enterprise",
  },
  {
    id: "distribution",
    name: "Job boards & distribution",
    category: "Sourcing",
    audience: "Recruiter, HR head",
    summary:
      "Approved roles reach job boards and portals by the route each allows, and every application comes back into one scored pipeline.",
    outcome: "Roles are advertised widely without retyping, and every channel's yield is measured.",
    capabilities: [
      "LinkedIn, Indeed and Naukri connections where the partner contract allows: publish and ingest applications",
      "Google for Jobs structured data on every approved role's apply page",
      "Per-organisation job feeds and copy-ready posting packs for portals with no integration",
      "Apply links tagged per channel and a per-channel report of who applied and how far they got",
      "Candidate e-mails: acknowledgement, stage updates, interview invitations and offers, each switchable",
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
      "Every AI request logged per organisation and feature with the tokens the provider reported",
      "Organisation spend limits: monthly AI tokens and daily automatic scorings per role",
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
      "Tenant authorisation in server middleware, repeated as an organisation filter in every query",
      "Organisation-supplied credentials and AI keys encrypted at rest",
      "Private vaults for CV files and screening audio, with signed short-lived links",
      "Audit trails for stage changes, ownership, verification, privilege changes and platform operations",
      "Rate-limited public endpoints and versioned Terms, Privacy Policy and DPA accepted by a named signatory",
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
    "One multi-tenant platform covering requisition to joining: evidence-based JD↔CV matching, human-in-the-loop hiring agents and AI phone screening, verified candidate signals, market-aligned budgets, governance and leadership analytics.",
};

export function totalCapabilities() {
  return CATALOGUE_MODULES.reduce((n, m) => n + m.capabilities.length, 0);
}
