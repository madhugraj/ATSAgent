/**
 * The single source of truth for the ATSIQ user manual.
 *
 * It is rendered on /help for humans and injected into the HR copilot prompt, so an
 * organisation can self-configure and operate the platform without external hand-holding.
 * Edit here only — both surfaces stay in sync automatically.
 */

export type ManualSection = {
  id: string;
  title: string;
  summary: string;
  steps: string[];
};

/** Shared first-run journey for the help page and the HR copilot. */
export const FIRST_RUN_JOURNEY = [
  {
    title: "Connect your workspace",
    to: "/integrations",
    detail:
      "An owner or HR head connects the organisation's own AI key, candidate sources, careers inbox and meeting provider. Save and test each connection before relying on it.",
    access: "governance",
  },
  {
    title: "Set up your hiring foundations",
    to: "/masters",
    detail:
      "Add departments, locations and skills, then invite colleagues and assign their approval roles in Users & roles.",
    access: "governance",
  },
  {
    title: "Open an approved role",
    to: "/requisitions",
    detail:
      "Create the requisition and JD, check the live market range, set JD↔CV scoring weights, and complete the department, HR and executive approvals required for your organisation.",
    access: "org",
  },
  {
    title: "Bring candidates in",
    to: "/candidates",
    detail:
      "Import CVs, collect applications from the careers inbox or capture LinkedIn Recruiter profiles. Publish approved roles internally through Internal postings when relevant.",
    access: "recruiter",
  },
  {
    title: "Review evidence and shortlist",
    to: "/matching",
    detail:
      "Match the JD to people in the talent pool. Review skills, experience, career history and verified social evidence; record a reason for any recruiter override.",
    access: "recruiter",
  },
  {
    title: "Screen and interview",
    to: "/screening",
    detail:
      "Work the screening queue: the best matches per role, with JD-and-CV-specific questions prepared in the background. Review answers, score the call and move the candidate on without leaving the page.",
    access: "recruiter",
  },
  {
    title: "Approve, validate and release",
    to: "/offers",
    detail:
      "Prepare the offer and letter, obtain approvals, collect pre-onboarding ID, employment, pay and education documents, and validate each extraction beside its original. Release stays locked until mandatory documents are validated.",
    access: "recruiter",
  },
  {
    title: "Measure the outcome",
    to: "/reports",
    detail:
      "Record acceptance and joining, then review funnel reports; leadership can examine Talent Brain and Return on Individual for capability strengths and programme readiness.",
    access: "approver",
  },
] as const;

export const MANUAL_SECTIONS: ManualSection[] = [
  {
    id: "first-run-journey",
    title: "Start here: from integration to offer release",
    summary:
      "A first-time hiring journey. Your role determines which pages you can open; ask an organisation owner or HR head to complete setup and approvals you cannot perform.",
    steps: FIRST_RUN_JOURNEY.map((step) => `${step.title} (${step.to}): ${step.detail}`),
  },
  {
    id: "registration",
    title: "1. Registering your organisation",
    summary:
      "Every user belongs to an organisation. Accounts cannot exist on their own, so the organisation is registered first and a platform super admin approves it.",
    steps: [
      "Sign up with your work email address. Free or disposable mailboxes (gmail, outlook, yahoo, temporary domains) are rejected — the domain proves the organisation is genuine.",
      "Confirm your email from the verification message sent to that inbox.",
      "Complete the registration wizard: organisation name, registered legal name, industry, headquarters country and city, reporting currency, careers inbox, plus at least one department and one location. All of these are mandatory.",
      "Your organisation is then queued for review and you see the 'Awaiting platform approval' screen. It refreshes itself — you do not need to sign out and back in.",
      "A platform super admin approves or rejects the registration. You receive an acknowledgement email either way, and approval opens the workspace on your next screen refresh.",
    ],
  },
  {
    id: "users",
    title: "2. Users, roles and access (Users & roles)",
    summary:
      "The registering user becomes the organisation owner. Only the owner invites internal users, and invitations are restricted to your own email domain.",
    steps: [
      "Invite a colleague from Users & roles (/team) with their work email and the role they should hold. They receive a branded invitation email immediately.",
      "Change someone's roles later from the Roles (click to edit) cell in their row: tick to grant, untick to revoke. Both the organisation owner and any President/CBO admin can do this; other roles can view but not change.",
      "Roles available: recruiter, hiring manager, department head, HR head, president/CBO. Roles decide who can approve requisitions, job descriptions and offers.",
      "Grant or revoke roles at any time from the row action menu.",
      "Pause access to suspend someone while keeping all their history; delete removes the membership and roles permanently.",
      "The owner cannot be deleted until ownership is transferred. A platform super admin can remove any user, including an owner.",
      "Use search, role and status filters, pagination and CSV export to manage large employee bases.",
    ],
  },
  {
    id: "configuration",
    title: "3. First-time configuration",
    summary: "Three pages get a fresh tenant production-ready.",
    steps: [
      "Screen space: collapse the left People Excellence menu with the arrow button beside its title. The choice is remembered on that browser, and the icons stay clickable while collapsed.",
      "Master data (/masters): departments, skills, locations, education levels and industries. Everything else picks from these lists, so fill them first.",
      "Integrations (/integrations) is split into five tabs: Candidate sources, Interview meetings, HRMS sync, Candidate emails and AI model. Each row is closed until you click it, so the page stays short; open a row to paste credentials, press Save and then Test.",
      "Credentials are stored on the server and are never sent back to the browser. 'What each source can do' at the bottom of the sources tab explains what every channel needs: the LinkedIn company sign-in, the ATSIQ Capture browser extension (pair it with the org's capture token), public apply links, the careers inbox, Naukri/Indeed keys, and GitHub for public-signal verification.",
      "Job boards: each board card (LinkedIn, Indeed, Naukri) carries a connect panel and an Enterprise connection checklist. LinkedIn is a one-time company sign-in; Naukri and Indeed take the client keys from the partner onboarding pack, and one press of Connect saves them and verifies them against the board's token endpoint — the card title turns green when it connects. The checklist covers the connection test, the application webhook URL (press Set up, then give that exact URL to the board), what the board's contract actually opens, and live postings/applications; a board whose partner pack has not landed shows a pending line, never a fake tick, and each panel has a ready-to-send request note for the board's account manager. Connecting, disconnecting, publishing to boards and rotating the webhook URL are HR-head actions and are audited.",
      "HRMS sync: on the HRMS tab, connect Keka or greytHR with the keys from your HR admin portal, press Test and then Sync now. Your employee master — departments, titles, leavers — is pulled into ATSIQ and refreshed automatically, so hiring managers, interviewers and internal candidates come straight from your HR system. Your HRMS stays the source of truth; ATSIQ keeps a read-only copy, and disconnecting a platform deletes its synced employee data.",
      "Candidate emails: on the emails tab, choose which automatic emails candidates receive — application acknowledgment, stage update, interview invitation and offer notification — and set a reply-to address and timezone. Delivery runs through the platform's own mail relay, so there is nothing to configure per organisation; toggles apply from the next event onward and nothing is retro-sent.",
      "Organisation (/organisation): keep the organisation profile, currency and careers inbox current. The owner can also archive the organisation here — archiving locks everyone out but deletes nothing.",
      "AI provider: choose the provider and model used for matching, scoring, verification and the copilot on the Integrations page. Every organisation must supply its own key; ATSIQ never substitutes a shared platform key. Test the connection before running batches.",
    ],
  },
  {
    id: "requisitions",
    title: "4. Requisitions and job descriptions",
    summary:
      "A requisition is the hiring demand; the JD is its published description. Both move through approval.",
    steps: [
      "Create a requisition (/requisitions) with department, openings, experience band, budget, location, must-have and good-to-have skills.",
      "Use role-profile assistance to fill missing skills, qualifications and responsibilities from the role title; existing HR entries are preserved and remain editable.",
      "Use Get market range for a current low, median and high compensation benchmark. Review the named public sources, evidence extracts, freshness and confidence before adopting the suggested CTC band.",
      "Set the scoring weights on the requisition: skills, experience, career history, impact, education and social. They must total 100. Ask the AI for a suggestion if unsure.",
      "Draft or paste the JD; the parser splits purpose, responsibilities, must-have and good-to-have skills and qualifications into versioned fields.",
      "Send for approval: department head, then HR head, then president/CBO where required. Every decision is recorded in the approval trail.",
      "Approved requisitions become open, can be posted internally (IJP) and start accepting applications.",
      "Publish to job boards: on an approved requisition, the Job boards panel files structured listings on LinkedIn, Indeed and Naukri where the connection's contract allows it — until then the LinkedIn feed-post designer below it is the always-available route. Applicants the boards deliver arrive in this pipeline automatically (deduplicated, parsed, acknowledged), and closing the requisition takes its board postings down.",
    ],
  },
  {
    id: "talent-pool",
    title: "5. Talent pool and CV intake",
    summary:
      "A shared organisation pool with clear recruiter ownership, source history, duplicate control and freshness tracking.",
    steps: [
      "Add candidates individually or upload CVs in bulk (PDF/DOCX) on Talent pool (/candidates) — parsing fills name, contact, skills, experience and employment history automatically.",
      "Use Mine, Unassigned or All to focus the list. Every candidate can have an owning recruiter; assignment and hand-over history remains visible.",
      "Review the master-detail view and filter it by skill, experience, location, source, added date, freshness, duplicates, owner and stage. Source identifies manual upload, LinkedIn capture, careers inbox, Naukri, Indeed, referral, consultant, campus or IJP.",
      "Freshness: fresh (updated within 90 days), aging (91-365 days), stale (over a year). Refresh or re-sync stale profiles before relying on them.",
      "Select rows to move stage, merge duplicates, re-run verification, or permanently delete candidates along with their applications, interviews, scores and stored CV files.",
      "Duplicates are grouped by normalised email, phone and name. Merge keeps the richest record and reassigns every application, interview, offer and score.",
      "Social links (LinkedIn, GitHub, X, portfolio, blog) are fetched and verified where the provider allows it; the verification agent scores authenticity and flags contradictions against CV claims.",
      "Original CVs are held privately. Open or download them through ATSIQ, rather than through the storage host. A profile-only LinkedIn capture remains usable and is marked as file pending until the original CV is recovered.",
    ],
  },
  {
    id: "candidate-sources",
    title: "6. Candidate sources and LinkedIn Recruiter capture",
    summary: "Source candidates without losing their origin, evidence or original CV.",
    steps: [
      "Configure candidate sources on Integrations (/integrations). The careers inbox can import attached CVs; LinkedIn Recruiter capture uses the downloadable ATSIQ browser companion.",
      "Install ATSIQ Capture from the download on Integrations, open its popup, paste the organisation capture token and pair it. Treat the token like a password and rotate it from Integrations if it may have been exposed.",
      "In LinkedIn Recruiter, open the job's applicant list and start the companion. It performs a deep read of every visited profile even when no CV is present: expanding collapsed sections, scrolling lazy content, opening profile tabs and following relevant credential or detail links before it sends deduplicated evidence to ATSIQ.",
      "The companion reports the precise failed stage when navigation, identity confirmation, attachment discovery, download, private storage or analysis does not complete. Stop interrupts the current wait rather than leaving the run stuck.",
      "A successful original-file capture is parsed and stored privately. When only validated profile evidence is available, ATSIQ keeps the candidate, runs available social analysis and matching, and waits for a later CV capture to enrich the same person.",
      "Use Careers inbox (/inbox) to trigger mailbox intake and background matching for CVs received through job advertisements.",
    ],
  },
  {
    id: "matching",
    title: "7. JD to CV matching and scoring",
    summary:
      "Scoring is evidence-based and always out of 100, using the requisition's own weights.",
    steps: [
      "Open Matching engine (/matching) and pick a requisition.",
      "'Suggested from pool' pre-ranks existing talent-pool candidates against that JD; add the ones worth pursuing to the pipeline.",
      "Select candidates (or the whole pipeline) and run scoring in bulk.",
      "Each score breaks down into skills, experience, career history, impact/ownership, innovation/learning, education and social, with matched and missing skills, rationale and risk flags.",
      "A recruiter can override the AI recommendation with a reason; the original score and the override are both retained.",
    ],
  },
  {
    id: "screening",
    title: "8. Preliminary screening-call support",
    summary:
      "A per-role triage queue with JD-and-CV-specific questions prepared in the background, so the call is ready before the recruiter arrives.",
    steps: [
      "Open Screening calls (/screening). Pick a role; the queue shows To call, Questions ready, Screened and All, each with a live count.",
      "When someone is shortlisted, their question kit is prepared automatically in the background — no waiting, no button. Rows pulse until the questions are ready, then move to Questions ready on their own.",
      "Move through the stack with j / k (or arrow keys); press a to advance, s to shortlist, r to reject. Everything about one candidate — score evidence, questions, answers, grading, stage — lives in the pane on the right.",
      "Each question includes why HR should ask it, the most relevant answer expected, and weak-answer guidance grounded in the JD and candidate evidence. Review, edit, remove, copy or print before the call.",
      "After the call, enter answers question by question, paste whole-call notes, or upload the private audio recording for transcription. Submit for per-question verdicts, a screening score, recommendation, red flags and rationale — the combined fit uses 60% existing JD/CV match and 40% screening result.",
      "If questions are not prepared, the organisation's AI key is missing or the role has no job description — check Integrations, then press Prepare questions on the candidate as a fallback.",
      "The Screening section on the candidate profile offers the same kit and grading; previous runs and private recording links remain available to authorised organisation users.",
    ],
  },
  {
    id: "interviews",
    title: "9. Interviews",
    summary: "Multi-level interviews with calendar invites, scorecards and automatic progression.",
    steps: [
      "Schedule from Interviews (/interviews): level, interviewer and email, mode, duration and agenda. The candidate's stored email is used for the invite.",
      "A meeting link is created with your configured provider and an .ics invite is issued to interviewer and candidate.",
      "Reschedule from the same row; a reason is mandatory and the change is audited.",
      "Interviewers open My interviews (/interviews/mine) and submit a competency scorecard with rating, comments and a recommendation. Submissions lock.",
      "Select advances the candidate to the next level, hold pauses the pipeline, reject closes it with a required reason.",
      "Optional AI screening interviews score JD match, skillset, role fit and culture fit before human rounds.",
    ],
  },
  {
    id: "offers",
    title: "10. Offers, pre-onboarding checks and joining",
    summary:
      "Candidates reaching the offer stage flow through approval, document validation, release and joining.",
    steps: [
      "When a candidate clears the final interview level, move them to the offer stage; they then appear on Offers (/offers).",
      "Raise the offer with CTC and joining date; it routes through HR and CBO approval.",
      "Open Letter to generate the offer letter from a template — an offer cannot go for approval without it.",
      "Open Documents on the offer to run pre-onboarding: government photo ID, experience or relieving letters, recent payslips and the highest education certificate are mandatory; salary revision letter, bank proof, address proof and background form are optional.",
      "Upload documents yourself, or ask the candidate to mail them to your careers address — mail from a candidate who already has an offer in flight is filed against that offer automatically and sorted by document type.",
      "Every filed document is read by the extraction agent using your organisation's own AI key. Name, ID number, employer, dates, payslip figures and last drawn CTC are pulled out and shown beside the original page, so you validate the reading against the document rather than trusting the agent.",
      "Send the documents in whatever form the previous employer issued them: PDF, Word, or a photo or scan as JPG or PNG. A single file may hold several documents — three monthly payslips merged into one PDF, a payslip followed by the revision letter, an ID on page one and a certificate on page two — and each document inside it is read, dated and reconciled separately, with the page range shown. A scanned or photographed payslip with no machine text is read from the page images. A ZIP of everything at once is unpacked and filed as individual documents, each sorted by type.",
      "No two employers structure pay the same way, so the breakup is captured exactly as printed rather than forced into a template: every line of the earnings, deductions and employer-contribution tables is kept with the employer's own label — basic, HRA, flexible benefit plan, special allowance, city compensatory allowance, retention pay, employer PF, gratuity, professional tax and the rest — with one-off lines marked as one-off. You see that breakup next to the page it came from.",
      "Last drawn salary is presented as a dated conclusion, not a field copied off one page. Recurring monthly pay is kept apart from one-off pay (arrears, bonus, incentive, leave encashment) before it is annualised, a salary revision letter is read by its effective date rather than its letter date, and it only overrides the payslips when it took effect on or before the newest slip. Payslips older than three months, non-consecutive months, a recurring gross that moves between months, a revision effective in the future, employer mismatches between payslips and service letters, employment gaps over three months and a revision-versus-payslip divergence above twelve per cent are all reported instead of averaged away.",
      "The Evidence timeline shows every pay document in date order with what it contributes, so you can see exactly which page the figure came from and how it compares with the offered CTC.",
      "Press Validate to accept a document, or Reject with a mandatory note when it does not match. Read again re-runs the extraction; Remove deletes the file and its reading. Every decision is written to the audit log with the actor.",
      "Release stays locked until all four mandatory document types are validated; the Release button explains what is still outstanding.",
      "Release the approved offer, then record accepted, declined, revoked, joined, no-show or deferred outcomes.",
      "Every stage change captures actor, reason and note, so the audit trail is complete.",
    ],
  },
  {
    id: "collaboration",
    title: "11. Recruiter ownership, referrals and talent sharing",
    summary:
      "The organisation shares one talent pool while ownership and every hand-over remain explicit.",
    steps: [
      "Assign or take ownership from Talent pool, including bulk assignment. Mine shows your candidates, Unassigned shows work needing an owner, and All preserves organisation-wide visibility.",
      "On a candidate profile, use Ownership & team to hand the candidate to a colleague, refer them to a colleague's requisition, add notes and mention teammates. Ownership events form a permanent trail.",
      "Open Team & sharing (/collaboration) to accept or decline referrals and see referrals you sent. Accepting a referral makes you the owner and adds the candidate to the named role when applicable.",
      "Post a request for talent with role, skills and context. Colleagues can suggest candidates already in the shared pool, and the requester can close the request when filled.",
      "Organisation owners can offer or respond to an opt-in pool-sharing agreement with another organisation. Sharing is explicit and can be revoked; it is never enabled automatically.",
    ],
  },
  {
    id: "talent-brain",
    title: "12. Talent Brain for workforce intelligence",
    summary:
      "A leadership-only, evidence-linked skill map showing organisational capability supply, hiring demand, scarcity and change over time.",
    steps: [
      "Open Talent Brain (/brain). Organisation owners, CHROs and HR heads see their organisation; the platform super admin can also switch to an all-organisations view.",
      "Read bubble size as the combined weight of people with the skill and demand from open roles. Violet means healthier coverage, amber means tightening supply, red means scarce against demand and grey means dormant evidence.",
      "Capability-family zones group related skills. Select a bubble to isolate skills that occur alongside it, then use the detail panel to compare people in the pool, weighted demand, evidence validated by hires and recency.",
      "Use Decisions & prescriptions to identify skills to hire, build, borrow or redeploy, plus bridge skills that support reskilling into scarce capabilities.",
      "The ontology learns from CV skills, requisition requirements and hiring outcomes. Evidence keeps full weight for 180 days, half weight through one year and quarter weight thereafter; unsupported skills become dormant after one year and retire after two years.",
      "Press Relearn ontology after substantial candidate, requisition or hiring changes. Deterministic analysis always runs; the organisation's configured AI provider can improve aliases, capability families and the executive narrative.",
    ],
  },
  {
    id: "roi",
    title: "13. Return on Individual and capability-to-goal planning",
    summary:
      "A CHRO decision layer that relates the cost of each accepted hire to evidenced capability and shows what the organisation can credibly execute now.",
    steps: [
      "Open Return on Individual (/roi). CHROs, HR heads and owners see their organisation; the platform super admin can select a particular organisation for a governed comparison.",
      "Read the individual index as an organisation-relative decision aid built from JD↔CV match evidence, capability scarcity, delivered impact, innovation and learning, career trajectory and breadth. It is not a financial return guarantee.",
      "The cost anchor uses the released offer where one exists and the requisition budget otherwise. Records without defensible evidence remain visible with their evidence limitations rather than receiving invented values.",
      "Use What this organisation can go and do now to review programme blueprints calculated from accepted-hire skills and current organisation evidence. Cards are generated from live records, not sample cards; team readiness and wider-pool readiness are shown separately.",
      "Open a blueprint to see contributors, enabling capabilities and missing capabilities. Use the gaps to decide whether to hire, build, borrow or redeploy.",
      "The Strengths and exposures view highlights concentrated strengths, single-person dependencies, dormant capabilities and coverage weaknesses by department.",
      "Records marked test_roi_cohort are explicitly labelled test evidence and must not be represented as production hires in executive reporting.",
    ],
  },
  {
    id: "ijp",
    title: "14. Internal job postings (IJP)",
    summary:
      "Approved roles can be opened to employees so internal mobility uses the same governed demand and evidence model as external hiring.",
    steps: [
      "Open Internal jobs (/ijp) to review roles published for internal applicants.",
      "Publish only an approved, open requisition and confirm the internal description, eligibility and closing details before sharing it.",
      "Employees apply through the internal posting journey; their source remains IJP so internal mobility can be measured separately from external sourcing.",
      "Review and progress internal applicants through the same evidence, screening, interview and decision controls used for other candidates.",
    ],
  },
  {
    id: "market-intelligence",
    title: "15. Live market compensation intelligence",
    summary:
      "Market ranges combine current evidence from quality salary and hiring sources with the organisation's own approved knowledge.",
    steps: [
      "From a requisition, select Get market range. ATSIQ searches approved public sources live and shows the source name, quoted evidence, retrieval date and confidence behind the low, median and high range.",
      "Review the role, location, currency, seniority and evidence before using a recommendation. A live result can still be incomplete when publishers block access or the market is thin.",
      "Choose Use to apply the researched range, or Correct to enter the organisation's known value with context.",
      "Used and corrected values are saved in PostgreSQL as organisation knowledge and can inform future recommendations; one organisation's knowledge is never shared with another.",
    ],
  },
  {
    id: "reports",
    title: "16. Dashboards, reports and HR performance",
    summary:
      "Operational work for recruiters and governance, quality and performance views for HR leadership.",
    steps: [
      "Dashboard (/) changes with the signed-in role. Recruiters see operational priorities; CHROs, HR heads and owners see decisions and prescriptions such as approval aging, weak pipeline coverage, screening gaps, SLA breaches, offer health, budget risk and funnel drop-off.",
      "Reports (/reports) adds filters by department, requisition, location, skill, source and date, plus funnel conversion, score distribution, drop-off, interviewer load and CSV export.",
      "Leadership-only HR performance compares recruiter activity, quality, conversion, speed and target attainment. Configure incentive bands and caps, inspect the calculation and export the result; recruiters cannot see the team-governance view.",
      "Platform super admins receive a cross-organisation aggregate view, while organisation records remain separated by access controls.",
    ],
  },
  {
    id: "copilot",
    title: "17. HR copilot",
    summary: "An embedded assistant grounded in your own live data and in this manual.",
    steps: [
      "Open the copilot from any page and ask about your pipeline, a requisition, pool coverage for a skill, or how to perform any task in the platform.",
      "It answers only from your organisation's data and this manual — it never invents candidates or numbers.",
      "The copilot uses the organisation's selected AI provider and encrypted organisation-owned key. If no key is configured, it stops and asks an authorised owner or HR head to configure one.",
      "The conversation is stored per user and can be cleared at any time.",
    ],
  },
  {
    id: "hiring-desk",
    title: "18. Hiring desk",
    summary:
      "Describe who you need in plain words; the hiring agents gather the details, find similar roles, rank candidates and line up screening, and stop at every decision that is yours.",
    steps: [
      "Use the switch at the top: Agent mode shows the agent pages (Hiring desk, Waiting for you, Agent activity, and agent administration for HR leadership); Manual mode shows the pages for doing each step yourself (requisitions, talent pool, matching, screening, interviews, offers, sourcing, reports). Both work on the same records, the choice is remembered, and opening a page of the other mode (for example from the bell) switches automatically.",
      'Open Hiring desk and type the need, for example "I need a Full stack developer in Chennai". The desk asks one short question at a time until it knows the role, location, experience, number of openings and must-have skills. Not sure? Say "as per market" or press **Research it from the market**: the desk researches current skills, experience and pay for the role and shows a proposal (marked live web research or estimate) — say "ok" or press **Use these**, or tell it what to change. Under each reply, **How I read that** shows what it understood, what is still missing and what it does next. When an agent is waiting on you, you can also reply in the chat: "give more weight to experience" sends the request back to that agent with your change, and it revises and asks again; an answer to an agent\'s question is passed on the same way. Type "show the JD" to read the current job description right in the chat. When the JD is approved the desk lists what happens next — scoring, publishing and sourcing — and HR leadership can switch on any agent that is off right there. New applicants are announced in the thread as they arrive, and "Ask the Sourcing agent" (under Bring candidates in) searches your talent pool and past candidates and invites the best to apply, with your approval. With the Sourcing agent on, every new CV that lands in the talent pool without a role (an emailed CV that named no role, an upload, a capture) is checked against your open roles, and a strong match is added to that role and announced in its thread. A job description waiting for approval can be sent back for changes the same way (for example "use the Yavar template" — if no template has that name, the desk lists the ones you have). Approving, and declining a requisition or offer, happen on their card, never from the chat. If an agent stops because it used its monthly token budget, the journey shows how much it used; HR head, CBO or the owner can press **Raise to … and continue**.',
      "It then shows similar roles. Continue with an open role, create a new role, or create a new role that reuses an earlier role's approved job description (no new JD approval is needed; the reuse is recorded in the audit log).",
      "A new role is created as a draft in your name. The Requisition agent adds the pay band and scoring weights and sends it through the usual department head → HR → CBO approval chain.",
      'Once the job description is approved, the Intake & matching agent searches the talent pool and posts a ranked list in the thread. Tick candidates and choose Screen selected, or type "talk to the first 5".',
      "Autonomy levels (Agent settings): Suggest asks before every change and message. Act and notify makes internal changes on its own and tells you; candidate emails send on their own only for the templates you tick. Autonomous also makes changes silently and sends every candidate email template on its own; job-board posts go out on their own only on the boards you pre-approve. Job-board posts otherwise go to the HR head for approval and are published as them. Decisions — approving requisitions, JDs and offers, rejections, hiring decisions, document checks and offer release — always stay with people.",
      "Every request an agent makes for a person — an approval, a decision or a question — appears in the thread with Approve, Decline or Answer, and also in Agent decisions. Deciding in either place is the same decision.",
      "The agents must be switched on in Agent settings and an AI model key saved under Integrations; if an agent is off, the desk says so in the thread instead of waiting silently. Automated screening calls arrive with the voice agent integration.",
    ],
  },
  {
    id: "roles",
    title: "19. Permission guide",
    summary:
      "Access follows the smallest role needed for each decision, with the organisation owner and platform super admin kept distinct.",
    steps: [
      "Recruiters source, own, match, screen, schedule and progress candidates within their organisation.",
      "Hiring managers and department heads review their demand, interview assignments and approval steps; department heads control the business-side requisition decision.",
      "HR heads govern templates, AI configuration, offer release, Talent Brain, Return on Individual and HR performance controls.",
      "President/CBO users complete executive approvals and can administer organisation roles where policy permits; capture-token rotation is restricted to this governed administrative role.",
      "The organisation owner controls membership, organisation settings and archival. The platform super admin separately approves organisations and performs cross-organisation platform operations.",
      "If a page or action is absent, confirm the user's active membership and role in Users & roles rather than sharing credentials or widening access informally.",
    ],
  },
  {
    id: "platform",
    title: "20. Platform super admin (product owner only)",
    summary: "Cross-tenant administration lives on Platform console (/platform).",
    steps: [
      "Review the pending registration queue and approve or reject organisations; the registering owner is emailed the decision.",
      "See every organisation's live statistics: members, requisitions, candidates, interviews, offers and hires.",
      "Edit an organisation profile, archive and restore it, or permanently delete it — deletion is irreversible, requires the exact organisation name and also removes login accounts left without any other membership.",
      "Manage the super-admin allowlist by email.",
      "Open Product catalogue (/catalogue) to govern platform-level product and commercial definitions. Organisation members cannot access this page.",
    ],
  },
  {
    id: "account-recovery",
    title: "21. Sign-in and account recovery",
    summary: "ATSIQ uses first-party database-backed sessions and secure browser cookies.",
    steps: [
      "Sign in with the confirmed work email and password used during registration or invitation. A successful session remains active in the browser and is renewed while it is used.",
      "Passwords follow one policy everywhere (registration, reset and change): 8–128 characters with at least one uppercase letter, one lowercase letter and one digit, and a new password must differ from the current one. Use the eye toggle on any password field to check what you typed.",
      "Choose Forgot password on the sign-in form, submit the work email and use the time-limited link delivered to that inbox.",
      "If the link is invalid or expired, request a new one. For privacy, the request screen does not reveal whether an address exists.",
      "If sign-in fails during a temporary database interruption, wait briefly and retry; do not create a duplicate account.",
      "Sign out on a shared device. Administrators can pause a membership immediately from Users & roles without deleting its audit history.",
    ],
  },
];

/** Markdown rendering of the manual, used for the copilot knowledge base. */
export const MANUAL_TEXT = MANUAL_SECTIONS.map(
  (s) => `${s.title}\n${s.summary}\n${s.steps.map((t) => `- ${t}`).join("\n")}`,
).join("\n\n");
