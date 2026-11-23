/**
 * The ATSIQ product catalogue: every shipped module, what it does, who it serves and the
 * capabilities inside it. This is the single source of truth for the super-admin catalogue
 * page and for the PDF / Excel exports, so it must describe what the product actually does.
 */

export type CatalogueCapability = {
  /** Short name of the capability. */
  name: string;
  /** What it does and why it matters, in one or two sentences. */
  detail: string;
};

export type CatalogueModule = {
  id: string;
  name: string;
  category: string;
  audience: string;
  /** One-line summary for lists and tables. */
  summary: string;
  /** Fuller description: how the module works end to end. */
  overview: string;
  outcome: string;
  capabilities: CatalogueCapability[];
  defaultTier: string;
};

const c = (name: string, detail: string): CatalogueCapability => ({ name, detail });

export const CATALOGUE_MODULES: CatalogueModule[] = [
  {
    id: "tenancy",
    name: "Multi-tenant enterprise onboarding",
    category: "Platform",
    audience: "Product owner, organisation owner",
    summary:
      "Each organisation registers with its own verified work-email domain, is approved by the product owner and then runs fully isolated from every other tenant.",
    overview:
      "An organisation signs up through a guided registration that captures its legal identity, industry, headquarters, currency and careers inbox, and a named signatory accepts the current Terms of Service, Privacy Policy and Data Processing Agreement. The product owner reviews and approves the request before anyone can work in it. From then on every server request is checked against the caller's organisation, and every query is scoped to that organisation, so one deployment serves many clients with no data crossover.",
    outcome: "One deployment serves many client organisations with no data crossover.",
    capabilities: [
      c(
        "Guided organisation registration",
        "Mandatory legal name, industry, HQ, currency and careers-inbox details are captured up front, so the workspace is ready to hire on day one.",
      ),
      c(
        "Work-email domain validation",
        "Free and disposable email domains are refused and each organisation owns one registrable domain, which stops impostor sign-ups.",
      ),
      c(
        "Product-owner approval and lifecycle",
        "The product owner approves or rejects (with a reason), archives, restores or permanently deletes an organisation, and every action is audited.",
      ),
      c(
        "Server-enforced tenant isolation",
        "Every tenant-scoped request passes organisation and role checks on the server, and every query carries the organisation's id, so one tenant can never read another's records.",
      ),
      c(
        "Versioned legal agreements",
        "Terms, Privacy Policy and DPA are accepted by a named signatory at registration and re-accepted by the owner whenever a version changes; acceptances are recorded and visible on the platform console.",
      ),
      c(
        "Departments and locations",
        "Departments and office locations are captured at onboarding and reused across requisitions, reports and approvals.",
      ),
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
    overview:
      "Owners and HR heads invite colleagues by email, grant them one or more roles and manage their lifecycle from a single Users & roles table. Each role opens a defined set of screens and actions, and the server enforces it — hiding a button is never the only control. Colleagues who only sit on interview panels get a separate Interviewer role with a one-page app and no access to anything else.",
    outcome: "Every person sees exactly the data and actions their role allows.",
    capabilities: [
      c(
        "Role model",
        "Owner, CHRO, HR head, recruiter, hiring manager and interviewer roles, each with server-enforced permissions; a person can hold several.",
      ),
      c(
        "Panel-only Interviewer role",
        "Colleagues who only interview see their own rounds, the brief and CV for each, and their scorecard — the server refuses them everything else.",
      ),
      c(
        "Email invitations",
        "Branded invitation emails with joining status, so the admin can see who has accepted and chase who has not.",
      ),
      c(
        "Grant, revoke, pause and delete",
        "Roles are granted and revoked individually; users can be paused, restored or permanently removed.",
      ),
      c(
        "Owner protection and audit",
        "The last owner cannot be removed, and every privilege change is written to the audit log with who made it.",
      ),
      c(
        "Built for large teams",
        "Search, filters, pagination up to 250 rows and CSV export keep administration fast for organisations with thousands of users.",
      ),
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
    overview:
      "A hiring manager or recruiter raises a requisition with the budget, openings, experience band, skills, responsibilities and qualifications, checks the live market range and sets the scoring weights for matching. The requisition and its job description then move through the department, HR and executive approval chain; transitions are decided on the server and every decision is kept in an immutable trail. Once approved, the role can be posted internally and published to the careers page, apply links and job boards from the same record.",
    outcome: "Approved roles reach the market faster with a clean audit trail.",
    capabilities: [
      c(
        "Content templates",
        "Templates that steer every AI-drafted job description, LinkedIn post and branded job-card image.",
      ),
      c(
        "Structured requisition intake",
        "Budget, openings, experience band, location, must-have and good-to-have skills, responsibilities and qualifications in one form.",
      ),
      c(
        "Approval chain with immutable trail",
        "Department head, HR head and CHRO approvals with aging visibility; status changes are built on the server and the trail cannot be edited.",
      ),
      c(
        "AI drafting",
        "Skills, qualifications and responsibilities are drafted from the role title and the organisation's approved profile, ready for the requester to edit.",
      ),
      c(
        "Near-duplicate detection",
        "Similar open job descriptions are flagged before a new role is raised, avoiding parallel searches for the same position.",
      ),
      c(
        "Role expert interview",
        "An agent asks the hiring manager (in their inbox, at most two rounds) what the role really needs, and writes an expert brief — must-haves, deal-breakers, what good looks like, must-ask screening questions and each round's rubric — for the manager to approve.",
      ),
      c(
        "Internal job posting and apply links",
        "Approved roles can be opened to internal candidates (IJP) and shared through public apply links tagged by channel.",
      ),
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
    overview:
      "Every CV is scored out of 100 against the requisition's own weights across skills, experience, career history, impact and ownership, innovation and learning, education and public signals, plus up to four dimensions the organisation defines itself. Each dimension carries quoted evidence from the CV, and the result lists matched and missing skills, a rationale and risk flags. Hard gates — a missing must-have, a career pointing at a different role family, a salary ask well above the band, or suspicious text in the CV — hold the candidate for a person instead of advancing them automatically. Recruiters can override any recommendation with a reason, and both versions are kept.",
    outcome: "Recruiters shortlist on evidence instead of keyword luck.",
    capabilities: [
      c(
        "Weighted, explainable scoring",
        "Skills, experience, career history, impact, innovation, education and public signals, each scored with the CV evidence behind it.",
      ),
      c(
        "Weights per role, with AI suggestions",
        "Weights are set on each requisition (totalling 100) and the AI can suggest a split for the role.",
      ),
      c(
        "Organisation-specific dimensions",
        "Up to four of the organisation's own parameters per role — for example values, domain or craft — each with a label, scoring hint and weight, scored in the same pass with cited evidence.",
      ),
      c(
        "Career-direction check",
        "The scorer compares where the candidate's career is heading with the role's family; a mismatch (for example an AI career against a backend role) holds the candidate for a person while still crediting their skills.",
      ),
      c(
        "Band-aware experience and pay",
        "Experience above or below the band lowers the score either way, and an expected salary more than 20% above the approved band holds the candidate; a missing salary never does.",
      ),
      c(
        "Bulk scoring and pool suggestions",
        "Score one candidate, a selection or a whole pipeline at once; newly raised roles get a pre-ranked list of existing talent-pool candidates.",
      ),
      c(
        "Recruiter overrides",
        "Any recommendation can be overridden with a reason; the original score and the override are both retained for audit.",
      ),
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
    overview:
      "For each candidate and role the assistant writes a screening kit: 8–10 questions grounded in the JD, the CV and the hiring manager's expert brief, each with the reason to ask and what a strong answer sounds like. The recruiter runs the call, captures answers as text, notes or a private recording, and the assistant grades each answer with evidence and red flags. Pay expectations and notice period are collected separately through a private candidate form, so they are known before any offer.",
    outcome: "Every screening call is consistent, defensible and scored.",
    capabilities: [
      c(
        "Role- and candidate-specific question kits",
        "8–10 questions with the reason to ask and the expected strong answer, including the must-ask questions from the role's expert brief.",
      ),
      c(
        "Editable, stored kits",
        "Kits can be edited, printed or copied and are stored per candidate and role for later review.",
      ),
      c(
        "Flexible answer capture",
        "Typed answers, whole-call notes or a private audio recording that is transcribed and stored in a private vault.",
      ),
      c(
        "Per-question grading",
        "Each answer gets a verdict with evidence, red flags are called out and an overall recommendation is given.",
      ),
      c(
        "Combined fit score",
        "The CV match and the screening outcome are blended into a single fit score for shortlisting.",
      ),
      c(
        "Pay and availability form",
        "A private form collects current and expected pay and notice period from the candidate; it is visible to HR only.",
      ),
    ],
    defaultTier: "Growth",
  },
  {
    id: "voice-calls",
    name: "AI phone calls",
    category: "Intelligence",
    audience: "Recruiter, HR head",
    summary:
      "Optional AI voice agents that phone candidates for screening, scheduling and pay conversations through the organisation's own line.",
    overview:
      "When an organisation switches it on, AI voice agents call candidates through the organisation's own telephone line and its own AI voice key. Every call opens by saying it is an AI and asking for consent, keeps to calling hours, retries and honours callbacks, and falls back to a written route when the candidate prefers. Results come back to the hiring desk for a person to decide on — the call agents never make a hiring decision themselves.",
    outcome: "Candidates are reached quickly and consistently, while people keep every decision.",
    capabilities: [
      c(
        "Practical details on the screening call",
        "The screening call takes the joining date and current and expected pay (recorded for HR only, or noted as declined) before the kit's questions.",
      ),
      c(
        "Voice Guard",
        "Every answered AI phone call is reviewed after it ends against the call's rules and facts; findings quote the transcript and are listed under Call reviews.",
      ),
      c(
        "Screening calls",
        "The agent asks the screening kit's questions (never pay), grades only the questions actually answered and shows the result with a 'Why this score' explanation.",
      ),
      c(
        "Scheduling calls",
        "The agent offers interview slots by phone and books the one the candidate picks, with the meeting link from the connected provider.",
      ),
      c(
        "Pay calls",
        "The agent phones the candidate with the approved figure — and at most one pre-approved improved figure, never the ceiling; a yes comes back for HR to confirm in one click.",
      ),
      c(
        "Consent and calling rules",
        "AI disclosure and consent at the start of every call, calling-hour limits, retries and callbacks, and a written fallback.",
      ),
      c(
        "Organisation-owned telephony",
        "Calls go out on the organisation's own line and its own AI voice key, so numbers and spend stay with the client.",
      ),
    ],
    defaultTier: "Add-on",
  },
  {
    id: "sourcing",
    name: "Sourcing & CV intake",
    category: "Sourcing",
    audience: "Recruiter",
    summary:
      "CVs reach the pool automatically from the careers inbox, bulk uploads, apply links and the ATSIQ Capture companion.",
    overview:
      "CVs arrive from every channel into one deduplicated pool: the careers inbox is watched and each CV is filed, parsed and scored automatically; recruiters bulk-upload PDF and DOCX files; candidates apply through public links; and the ATSIQ Capture browser companion collects profiles from LinkedIn Recruiter in the recruiter's own signed-in browser. Hidden text is stripped from CVs before any AI reads them, and the original file is kept in a private vault.",
    outcome: "No CV is left sitting in a mailbox unparsed.",
    capabilities: [
      c(
        "Careers-inbox watching",
        "Incoming applications are filed against the right role, parsed into a structured profile and scored without anyone opening the mailbox.",
      ),
      c(
        "Bulk upload with structured parsing",
        "PDF and DOCX CVs are parsed into employment history, skills, education and contact details.",
      ),
      c(
        "ATSIQ Capture companion",
        "A browser companion for LinkedIn Recruiter that captures profiles and CVs from the recruiter's own session.",
      ),
      c(
        "Source tracking",
        "Every candidate records where they came from (inbox, companion, job board, referral, consultant, campus, IJP and more) and when.",
      ),
      c(
        "Private CV vault",
        "Original files are stored privately and opened only through short-lived signed links.",
      ),
    ],
    defaultTier: "Growth",
  },
  {
    id: "distribution",
    name: "Job boards & distribution",
    category: "Sourcing",
    audience: "Recruiter, HR head",
    summary:
      "Publish approved roles to enterprise job boards and 14 portals, and ingest their applicants into the same scored pipeline.",
    overview:
      "Approved requisitions publish to LinkedIn, Indeed and Naukri through enterprise connections, gated by what each partner contract allows, and board applications flow back by signed webhooks and scheduled polling into the same deduplicated, scored pipeline. Beyond the boards, every approved role gets Google for Jobs structured data, per-organisation feeds for aggregators, and copy-ready posting packs for portals with no integration. Apply links are tagged per channel, so the organisation can see which channels bring candidates who progress.",
    outcome: "One approval puts the role everywhere, and every applicant lands in one pipeline.",
    capabilities: [
      c(
        "Enterprise job-board connections",
        "LinkedIn, Indeed and Naukri publishing and applicant ingestion, limited to what each partner contract opens.",
      ),
      c(
        "Google for Jobs",
        "Structured data on every approved role's apply page, with indexing notifications within the daily quota.",
      ),
      c(
        "Aggregator feeds",
        "Per-organisation job feeds for aggregators such as Jooble, Adzuna and Jora.",
      ),
      c(
        "Posting packs for other portals",
        "Copy-ready packs for portals without an integration; on some portals the Capture companion fills the form in the person's own browser — it never submits — and records the posting.",
      ),
      c(
        "Per-channel reporting",
        "Channel-tagged apply links and a report of who applied from each channel and how far they got.",
      ),
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
    overview:
      "The talent pool is a list-plus-dossier workspace that stays fast past a hundred thousand records. Identities are normalised so the same person arriving from several channels is grouped and can be merged safely, and every CV is classed by freshness so recruiters know what to re-verify. The dossier brings together employment history, skills, education, compensation, contact completeness and every pipeline the candidate is in.",
    outcome: "A pool that stays trustworthy as it grows past a hundred thousand records.",
    capabilities: [
      c(
        "List and dossier layout",
        "Search, Excel-style column filters and saved views on the left; the full candidate dossier on the right.",
      ),
      c(
        "Duplicate control",
        "Identity normalisation groups likely duplicates, and merging keeps the history of both records.",
      ),
      c(
        "Freshness bands",
        "CVs are classed fresh (up to 90 days), aging (up to a year) or stale, so outdated profiles are refreshed before outreach.",
      ),
      c(
        "Complete dossier",
        "Employment history, skills, education, compensation, contact completeness and pipeline status in one place.",
      ),
      c("Bulk actions and export", "Act on many candidates at once and export to CSV."),
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
    overview:
      "When a candidate shares public profiles, ATSIQ fetches them through a safe fetcher and compares what they show with what the CV claims. The result is an authenticity score with the evidence behind it, plus signals about career history, impact, innovation and mindset that feed the match score. Every run is recorded, and logistics and risk flags surface on the dossier before an interview is booked.",
    outcome: "Claims on a CV are corroborated before an interview is booked.",
    capabilities: [
      c(
        "Public-profile analysis",
        "LinkedIn and GitHub public signals are fetched and compared with the CV.",
      ),
      c(
        "Authenticity score",
        "A score showing how well public evidence supports the CV, with the evidence listed.",
      ),
      c(
        "Career and impact signals",
        "Career history, impact, innovation and mindset signals that feed into matching.",
      ),
      c("Audited runs", "Every verification run is recorded with what was checked and when."),
      c(
        "Risk flags on the dossier",
        "Logistics and risk flags appear where the recruiter makes the shortlist decision.",
      ),
    ],
    defaultTier: "Growth",
  },
  {
    id: "interviews",
    name: "Interviews & scorecards",
    category: "Hiring workflow",
    audience: "Recruiter, interviewer, hiring manager",
    summary:
      "Scheduling with calendar and meeting links, competency scorecards with a weighted rubric, and audited stage decisions.",
    overview:
      "Each role has an interview plan of rounds, and each round lists the competencies it rates, with a weight per competency and a 1/3/5 rating guide so interviewers score against the same standard. Panels are drawn from a panel directory of members and outside people (clients, advisors); every panellist receives a brief with the candidate's profile, CV and the round's rubric. Interviewers submit their own scorecards — members in the app, people without a login through a private expiring link — and the overall is the weighted average, computed on the server. Scorecards lock on submission, and stage decisions are recorded with reasons.",
    outcome: "Interview outcomes are recorded once, on one standard, and cannot be quietly edited.",
    capabilities: [
      c(
        "Meeting creation",
        "Zoom, Google Meet and Microsoft Teams meetings plus .ics invites; online rounds use the connected provider automatically.",
      ),
      c(
        "Rubric per round",
        "Competency weights (×1 to ×5) and a 1/3/5 rating guide per competency; the overall is the weighted average, worked out on the server.",
      ),
      c(
        "Panel directory",
        "Everyone who can sit on a panel — members and external people — in one list managed by the HR head or owner.",
      ),
      c(
        "Brief and CV for every panellist",
        "Each panellist gets the candidate's profile, skills, round focus, rubric and CV before the interview.",
      ),
      c(
        "Scoring without a login",
        "Panellists without an account score through a private, expiring link; a link verdict never opens an offer on its own.",
      ),
      c(
        "Interviewer workspace",
        "My interviews lists each interviewer's rounds, with can't-make-it and didn't-happen actions.",
      ),
      c(
        "Locked scorecards",
        "Scorecards lock on submission, so outcomes cannot be changed after the fact.",
      ),
      c(
        "Silent panel agents (optional)",
        "For online rounds, L1–L3 agents read the call transcript, email the panel a factual summary with no score, and flag disagreements between the panel and the evidence for the HR head.",
      ),
      c(
        "Reasoned decisions",
        "Reschedule and cancel need a reason; select, hold and reject decisions carry reasons specific to the destination.",
      ),
    ],
    defaultTier: "Included",
  },
  {
    id: "offers",
    name: "Offers & candidate lifecycle",
    category: "Hiring workflow",
    audience: "Recruiter, HR head",
    summary:
      "A state machine covering every candidate outcome from applied through joined, with approved offers and pre-onboarding in between.",
    overview:
      "Every candidate moves through a defined lifecycle from applied to joined, with each transition recorded as a stage event. Offers are drafted against the approved band, the candidate's stated expectation and internal parity, and go through HR head and executive approval on the server. When the candidate expects more than the ceiling, the team gets a call brief and a person-approved message. Before an offer is released, pre-onboarding documents are collected, extracted and validated by HR.",
    outcome: "Nobody is lost between 'offered' and 'joined'.",
    capabilities: [
      c(
        "Offer approval workflow",
        "Offers are approved by the HR head and then the executive approver, with an immutable decision trail.",
      ),
      c(
        "Pay discussions before the letter",
        "A call brief and a person-approved message when the candidate's expectation is above the approved ceiling.",
      ),
      c(
        "Pre-onboarding gate",
        "Documents are collected, extracted by an agent and validated by HR before the offer can be released.",
      ),
      c(
        "Complete outcome states",
        "Rejected, accepted, joined and not joined, each with reasons, plus a full stage history per candidate.",
      ),
      c(
        "Stalled-candidate detection",
        "Candidates who have not moved are surfaced with their owner and next action.",
      ),
      c(
        "Candidate notifications",
        "Acknowledgement, stage update, interview invitation and offer emails, each switchable per organisation.",
      ),
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
    overview:
      "From inside the requisition form, a hiring manager asks for the market range for the role, level and location. ATSIQ researches live public sources and returns a low, median and high figure with a recommended CTC band, a confidence rating, the quoted evidence and links. Where data is interpolated or estimated it says so, and the organisation's own corrections are saved and reused.",
    outcome: "Budgets are set against the market, not last year's band.",
    capabilities: [
      c(
        "Market range with recommended band",
        "Low, median and high compensation with a recommended CTC band for the role.",
      ),
      c(
        "Confidence and source status",
        "A confidence rating overall and a status for each source consulted.",
      ),
      c("Cited evidence", "Quoted evidence and source links so every figure can be checked."),
      c(
        "Stated caveats",
        "Interpolated or estimated figures are labelled as such rather than presented as fact.",
      ),
      c(
        "Saved organisation corrections",
        "Corrections made by the organisation are kept and applied to later research.",
      ),
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
    overview:
      "The whole team works from one pool, but every candidate has an owner, so effort is not duplicated and credit is clear. Recruiters can transfer or take ownership, refer a candidate to a colleague's role, and ask colleagues for talent — all audited. Notes with @mentions keep the conversation on the candidate record.",
    outcome: "Recruiters cooperate on candidates without stepping on each other.",
    capabilities: [
      c(
        "Candidate ownership",
        "My candidates and All candidates views, with a clear owner for each record.",
      ),
      c(
        "Audited transfers",
        "Ownership can be transferred or taken over, and every change is audited.",
      ),
      c(
        "Referrals between recruiters",
        "Refer a candidate to a colleague's role; the colleague accepts or declines.",
      ),
      c(
        "Talent requests",
        "Recruiters ask colleagues for candidates for a role and receive suggestions.",
      ),
      c(
        "Notes with @mentions",
        "Discussion stays on the candidate record and notifies the right people.",
      ),
      c(
        "Consortium pool sharing (opt-in)",
        "Organisations can choose to share pool candidates with partner organisations.",
      ),
    ],
    defaultTier: "Growth",
  },
  {
    id: "hiring-desk",
    name: "Hiring desk & hiring agents",
    category: "Automation",
    audience: "Hiring manager, recruiter, HR head",
    summary:
      "Describe a hiring need in a chat; opt-in agents gather the details, raise the role, source and rank candidates and line up interviews, with every decision shown in the thread.",
    overview:
      "The hiring desk is a chat where a person types a need — for example 'I need a full-stack developer in Chennai'. Specialist agents (Requisition, JD, Publishing, Intake & matching, Screening, Follow-up, Interview coordinator, Evaluation, Offer, Pre-onboarding & release, Sourcing and Distribution) take it from there, each working as the person who started the run. Agents can only propose, request or submit: approvals, rejections, releases and hires are always made by a person in the Decisions inbox. Each agent has a manifest with an accountable owner, permission scope, must-never list, risk tier and evaluations, and autonomy is set per organisation.",
    outcome: "Routine hiring work runs itself, and people spend their time on the decisions.",
    capabilities: [
      c(
        "Chat-first hiring desk",
        "One thread per hiring need, showing every step the agents take and every decision waiting for a person.",
      ),
      c(
        "Specialist agents across the lifecycle",
        "From requisition and JD through sourcing, screening, scheduling, evaluation, offer and pre-onboarding.",
      ),
      c(
        "Human decisions only",
        "Agents propose and request; approving, rejecting, releasing and hiring stay with people in the Decisions inbox.",
      ),
      c(
        "Governed agent register",
        "Each agent has a versioned manifest — owner, responsibility, permissions, must-never list, gates, risk tier and evaluations.",
      ),
      c(
        "Autonomy settings with recommendations",
        "Per-organisation autonomy levels, with measured recommendations and dry-run replays before raising them.",
      ),
      c(
        "Observability and health",
        "Run tracing, a health engine with plain-language alerts, alert emails and webhooks, and optional trace export.",
      ),
    ],
    defaultTier: "Enterprise",
  },
  {
    id: "org-profile",
    name: "Organisation profile & context",
    category: "Intelligence",
    audience: "Organisation owner, HR head",
    summary:
      "A versioned, approved description of what the organisation does and how it hires, used by every agent that writes or judges.",
    overview:
      "The Organisation context agent builds the profile from the admin's answers, the organisation's own website and uploaded documents, quoting the source for every item. Each line is marked for candidates or internal use, pay figures and staff names are refused, and nothing is approved by an agent — the HR head or owner approves, with a two-person rule. Once approved, job descriptions write 'About us' only from candidate-visible lines, requisitions draft from the hiring norms, and matching weighs domain experience against it.",
    outcome:
      "Every job description and score reflects the real organisation, from one approved source.",
    capabilities: [
      c(
        "Agent-built profile with sources",
        "Built from the admin's answers, the organisation's own website and uploaded documents (including scans), each item quoting its source.",
      ),
      c(
        "Candidate vs internal lines",
        "Each line is marked for candidates or internal use; only candidate lines appear in job descriptions.",
      ),
      c(
        "Approval and versioning",
        "Versioned and approved by the HR head or owner under a two-person rule; pay figures and staff names are refused.",
      ),
      c(
        "Used across the product",
        "Drives 'About us', requisition drafting, domain matching and screening questions on domain and regulators.",
      ),
      c(
        "Monthly website re-read",
        "The organisation's own site is re-read monthly (own domain only, respecting robots.txt) to keep the profile current.",
      ),
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
    overview:
      "Talent Brain learns from CV skills, requisition requirements and hiring outcomes to build a skill ontology grouped into capability families. For each skill it shows supply, weighted demand, hiring validation, scarcity and how recent the evidence is, and it tracks skills as they emerge, fade or go dormant. Leadership gets an executive narrative and evidence-based prescriptions on what to hire, build, borrow or redeploy, and Return on Individual maps hired capability to the organisation's programmes.",
    outcome:
      "Leadership can see capability risk early and decide what talent to hire, build, borrow or redeploy.",
    capabilities: [
      c(
        "Organisation ontology and role emergence",
        "Roles and skills of the organisation, with new roles detected as they grow out of existing ones, explored in a full-screen 3D view.",
      ),
      c(
        "Graphical skill ontology",
        "Skills grouped into canonical capability families with aliases resolved.",
      ),
      c(
        "Supply, demand and scarcity",
        "Per-skill supply, weighted demand from open roles, hiring validation, scarcity and evidence recency.",
      ),
      c(
        "Adjacency and bridge skills",
        "Shows which skills commonly occur together and which bridge skills support reskilling into scarce areas.",
      ),
      c(
        "Skill lifecycle",
        "Emerging, fading, dormant and retired skills, with historical snapshots.",
      ),
      c(
        "Narrative and prescriptions",
        "An executive narrative plus evidence-based decisions to hire, build, borrow or redeploy.",
      ),
      c(
        "Return on Individual",
        "Maps hired capability to programme blueprints, showing contributors, single-person dependencies and missing capabilities.",
      ),
      c(
        "Works without AI",
        "Deterministic analysis keeps running when the organisation's AI provider is unavailable.",
      ),
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
    overview:
      "Leadership sees each recruiter's activity, quality, conversion and speed, measured from real pipeline events rather than self-reporting, and combined into a composite score against targets. Incentive bands and caps are configured once and the workings are shown for every payout. The board is visible to leadership only.",
    outcome: "Incentives are computed from real pipeline activity, not opinion.",
    capabilities: [
      c(
        "Recruiter metrics",
        "Activity, quality, conversion and speed per recruiter, from pipeline events.",
      ),
      c(
        "Targets and composite score",
        "Target attainment and a single composite performance score.",
      ),
      c("Transparent incentives", "Incentive bands and caps with the calculation shown."),
      c("Leadership-only", "Recruiters cannot see the board."),
      c("Payroll export", "CSV export for payroll review."),
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
    overview:
      "Dashboards change with the viewer's role. Leadership sees where the funnel leaks, which sources work, approval aging, SLA breaches, budget risk and offer acceptance, framed as decisions to make. Recruiters see their own work queues. Every view exports to CSV, and the product owner sees an aggregate across organisations.",
    outcome: "Leaders get decisions to make, not charts to interpret.",
    capabilities: [
      c(
        "Funnel and source analytics",
        "Funnel, drop-off, source effectiveness, score distribution and scarce-skill analysis.",
      ),
      c(
        "Governance views",
        "Approval aging, SLA breaches, roles without candidates and stale-pool hygiene.",
      ),
      c("Quality and risk", "Screening coverage, offer acceptance, match quality and budget risk."),
      c("Drill-down views", "Department, requisition and interviewer-load views."),
      c("Cross-organisation view", "An aggregate band across organisations for the product owner."),
      c("CSV export", "Every report can be exported."),
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
    overview:
      "The copilot is available on every screen. It answers from the organisation's live requisitions, candidates and pipeline, and from the built-in user manual, and it walks new users through a guided first-login journey that mirrors the help page. Conversations are stored per organisation.",
    outcome: "New HR users configure and operate the product without training sessions.",
    capabilities: [
      c(
        "Answers by role",
        "Requisition status and approval trails, approvals waiting on you, pipeline, budgets and governance, only where the person's role allows.",
      ),
      c(
        "Pool coverage and demand outlook",
        "Talent-pool coverage per open role and a demand outlook from the organisation's own requisition trend plus a market signal, with confidence.",
      ),
      c(
        "Role ontology lookups",
        "Looks a role up in the organisation's role map and names emerging roles.",
      ),
      c(
        "Guided first-login journey",
        "A step-by-step setup walkthrough that matches the in-app manual exactly.",
      ),
      c(
        "Grounded in live data",
        "Looks up requisitions, candidates and pipeline data to answer questions.",
      ),
      c("Grounded in the manual", "Answers how-to questions from the built-in user manual."),
      c("Persistent conversations", "Organisation-scoped conversations stored in the database."),
      c("Everywhere", "Available on every screen of the product."),
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
    overview:
      "On its Integrations page an organisation chooses its AI provider and model and enters its own key, which is validated and stored encrypted. A Test model action checks the exact configuration on screen. Every AI request is then logged against the organisation with the tokens the provider reports, so spend is visible and owned by the client.",
    outcome: "Clients own and control their AI spend.",
    capabilities: [
      c(
        "Per-organisation configuration",
        "Provider, model and key chosen per organisation; keys are encrypted at rest.",
      ),
      c(
        "Validate and test",
        "Key validation and a Test model action against the exact configuration on screen.",
      ),
      c("Current model choices", "A maintained list of current models across supported providers."),
      c(
        "Usage ledger",
        "Every AI request is logged per organisation, feature and agent run with the tokens the provider reports.",
      ),
      c(
        "Spend limits",
        "Monthly AI token limits and daily scoring limits per role keep costs predictable.",
      ),
    ],
    defaultTier: "Included",
  },
  {
    id: "guardrails",
    name: "AI guardrails",
    category: "Platform",
    audience: "Organisation owner, product owner",
    summary:
      "Defences that keep AI features safe against manipulated CVs, profiles and emails, and keep people in charge of decisions.",
    overview:
      "All outside text — CVs, job descriptions, profiles, emails — enters AI prompts fenced as data, and hidden text is removed from CVs first. Model output is checked against a schema and stripped of echoed instructions. A candidate whose CV contains injection attempts is never advanced automatically, and an agent run that has read suspicious text asks a person before acting. Before any agent is allowed to work autonomously, the organisation's own model must pass a safety check of attacks run against it.",
    outcome: "AI speeds hiring up without letting a crafted CV steer the outcome.",
    capabilities: [
      c(
        "Outside text fenced as data",
        "CVs, profiles and emails enter prompts as data with injection rules, never as instructions.",
      ),
      c(
        "Hidden-text removal",
        "Invisible or hidden text is stripped from CVs before any AI reads them.",
      ),
      c(
        "Injection holds",
        "Flagged candidates never auto-advance, and runs that read suspicious text ask a person first.",
      ),
      c(
        "Schema-checked output",
        "Every model response is validated against a schema before it is used.",
      ),
      c(
        "Model safety check",
        "Attacks are run against the organisation's own model before any agent may work autonomously.",
      ),
    ],
    defaultTier: "Included",
  },
  {
    id: "governance",
    name: "Security, audit & governance",
    category: "Platform",
    audience: "Product owner, organisation owner",
    summary:
      "Tenant isolation, private file storage, encrypted credentials and audit trails across the workflow, plus a product-owner console.",
    overview:
      "Isolation is enforced on the server for every request, files live in private vaults behind short-lived links, and credentials are encrypted at rest. Privileged actions — role grants, tenant operations, credential changes — are written to an audit log, and public endpoints are rate-limited. The product owner has a console covering every organisation, its lifecycle, its AI usage and its agent activity.",
    outcome: "The product stands up to enterprise security review.",
    capabilities: [
      c(
        "Server-enforced isolation",
        "Organisation and role checks on every request, with every query scoped to the organisation.",
      ),
      c(
        "Private vaults",
        "CV files, documents and call audio in private storage with signed, short-lived links.",
      ),
      c(
        "Encrypted credentials",
        "Integration keys and secrets are encrypted at rest and never shown back in full.",
      ),
      c(
        "Audit trails",
        "Stage changes, ownership, verification and every privileged action are logged with who and when.",
      ),
      c(
        "Rate-limited public surface",
        "Public endpoints and server calls are rate-limited against abuse.",
      ),
      c(
        "Product-owner console",
        "Every organisation with its lifecycle, AI usage (requests, tokens, latency) and agent activity (runs, failures, spend).",
      ),
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
