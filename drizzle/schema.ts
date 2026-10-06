/**
 * ATSIQ schema — single source of truth for plain-Postgres deployments.
 *
 * Ported from the retired Supabase-era migrations (0000-0027) with:
 *  - all RLS policies / grants / auth.uid()-dependent helpers removed
 *    (authorization is enforced in server code — see src/server/auth.ts)
 *  - auth.users replaced by the `users` table
 *  - new: users, sessions, audit_log
 *  - org_id backfill triggers removed: server code always sets org_id explicitly
 *
 * Baseline SQL is generated: `bunx drizzle-kit generate` (out: drizzle/pg-migrations).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ enums */

export const reqTypeEnum = pgEnum("req_type", ["new", "replacement"]);

export const reqStatusEnum = pgEnum("req_status", [
  "draft",
  "pending_dh",
  "pending_hr",
  "pending_cbo",
  "approved",
  "rejected",
  "on_hold",
  "closed",
]);

export const jdStatusEnum = pgEnum("jd_status", [
  "draft",
  "pending_dh",
  "approved",
  "changes_requested",
]);

export const appStageEnum = pgEnum("app_stage", [
  "sourced",
  "applied",
  "ai_screened",
  "shortlisted",
  "l1",
  "l2",
  "l3",
  "offer",
  "hired",
  "rejected",
  "offer_pending",
  "offer_released",
  "offer_accepted",
  "offer_declined",
  "joined",
  "no_show",
  "joining_deferred",
  "withdrawn",
  "on_hold",
  "reserve",
]);

export const recommendationEnum = pgEnum("recommendation", ["select", "reject", "hold"]);

export const offerStatusEnum = pgEnum("offer_status", [
  "draft",
  "pending_hr",
  "pending_cbo",
  "approved",
  "released",
  "accepted",
  "declined",
  "revoked",
]);

export const appRoleEnum = pgEnum("app_role", [
  "recruiter",
  "hiring_manager",
  "department_head",
  "hr_head",
  "president_cbo",
]);

/* ------------------------------------------------------- identity (new) */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    emailConfirmedAt: timestamp("email_confirmed_at", { withTimezone: true }),
    /** Versioned hash: `scrypt$N$r$p$salt$hash`, or imported `bcrypt$...`. */
    passwordHash: text("password_hash"),
    fullName: text("full_name"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** sha256 hex of the cookie token — the raw token is never stored. */
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id"),
    actorUserId: uuid("actor_user_id"),
    /** Email of the acting user, or "ai" / "system". */
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    detail: jsonb("detail"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_org_created_idx").on(t.orgId, t.createdAt)],
);

/* ------------------------------------------------------------- tenancy */

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    emailDomain: text("email_domain"),
    inboxSlug: text("inbox_slug"),
    legalName: text("legal_name"),
    industry: text("industry"),
    hqCountry: text("hq_country"),
    hqCity: text("hq_city"),
    employeeBand: text("employee_band"),
    currency: text("currency").notNull().default("INR"),
    fiscalYearStartMonth: smallint("fiscal_year_start_month").notNull().default(4),
    careersEmail: text("careers_email"),
    onboardingStep: text("onboarding_step").notNull().default("profile"),
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("active"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedReason: text("archived_reason"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    /** Shared bearer token for the browser-companion capture endpoint. */
    captureToken: text("capture_token"),
    /** SHA-256 of the capture token — lookup key so the token itself can be encrypted. */
    captureTokenHash: text("capture_token_hash"),
  },
  (t) => [
    uniqueIndex("organizations_slug_key").on(t.slug),
    uniqueIndex("organizations_capture_token_key").on(t.captureToken),
    uniqueIndex("organizations_capture_token_hash_key").on(t.captureTokenHash),
    uniqueIndex("organizations_inbox_slug_key")
      .on(sql`lower(${t.inboxSlug})`)
      .where(sql`${t.inboxSlug} is not null`),
    uniqueIndex("organizations_careers_email_key")
      .on(sql`lower(${t.careersEmail})`)
      .where(sql`${t.careersEmail} is not null`),
    index("organizations_status_idx").on(t.status),
    index("organizations_email_domain_idx")
      .on(t.emailDomain)
      .where(sql`${t.emailDomain} is not null`),
  ],
);

export const orgMembers = pgTable(
  "org_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    fullName: text("full_name"),
    title: text("title"),
    status: text("status").notNull().default("invited"),
    isOwner: boolean("is_owner").notNull().default(false),
    invitedRole: appRoleEnum("invited_role"),
    invitedBy: uuid("invited_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("org_members_org_email_key").on(t.orgId, t.email),
    uniqueIndex("org_members_org_user_key")
      .on(t.orgId, t.userId)
      .where(sql`${t.userId} is not null`),
    index("org_members_user_idx").on(t.userId),
    index("org_members_email_idx").on(sql`lower(${t.email})`),
  ],
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: appRoleEnum("role").notNull(),
  },
  (t) => [uniqueIndex("user_roles_org_user_role_key").on(t.orgId, t.userId, t.role)],
);

export const platformAdmins = pgTable(
  "platform_admins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    userId: uuid("user_id"),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("platform_admins_email_key").on(t.email),
    index("platform_admins_email_idx").on(sql`lower(${t.email})`),
  ],
);

/* -------------------------------------------------- requisitions & JDs */

export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    headName: text("head_name"),
    budgetedHeadcount: integer("budgeted_headcount").notNull().default(0),
    budgetedCost: numeric("budgeted_cost", { precision: 14, scale: 2 }).notNull().default("0"),
    period: text("period").notNull().default("FY26"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("departments_org_name_key").on(t.orgId, t.name)],
);

export const masterItems = pgTable(
  "master_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    sortOrder: integer("sort_order").notNull().default(100),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "master_items_kind_check",
      sql`${t.kind} in ('skill','location','education','employment_type','industry','role_title','billing_type','engagement_type','client','rejection_reason')`,
    ),
    uniqueIndex("master_items_kind_name_unique").on(t.orgId, t.kind, sql`lower(${t.name})`),
    index("master_items_kind_idx").on(t.kind, t.active),
  ],
);

export const requisitions = pgTable(
  "requisitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    title: text("title").notNull(),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    reqType: reqTypeEnum("req_type").notNull().default("new"),
    status: reqStatusEnum("status").notNull().default("draft"),
    location: text("location"),
    openings: integer("openings").notNull().default(1),
    experienceMin: integer("experience_min").notNull().default(0),
    experienceMax: integer("experience_max").notNull().default(5),
    budgetCtc: numeric("budget_ctc", { precision: 14, scale: 2 }).notNull().default("0"),
    hiringManager: text("hiring_manager"),
    mustHaveSkills: text("must_have_skills")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    goodToHaveSkills: text("good_to_have_skills")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    responsibilities: text("responsibilities"),
    educationRequirement: text("education_requirement"),
    weightSkills: integer("weight_skills").notNull().default(40),
    weightExperience: integer("weight_experience").notNull().default(15),
    weightCareer: integer("weight_career").notNull().default(10),
    weightImpact: integer("weight_impact").notNull().default(10),
    weightEducation: integer("weight_education").notNull().default(10),
    weightSocial: integer("weight_social").notNull().default(15),
    approvalTrail: jsonb("approval_trail")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Member who raised it; agents act for this person (docs/agentic-plan.md §6.1). */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    billingType: text("billing_type").notNull().default("non_billable"),
    engagementType: text("engagement_type").notNull().default("internal"),
    clientName: text("client_name"),
    costCenter: text("cost_center"),
    ijpEnabled: boolean("ijp_enabled").notNull().default(false),
    ijpPostedAt: timestamp("ijp_posted_at", { withTimezone: true }),
    ijpNotes: text("ijp_notes"),
    ctcBandMin: numeric("ctc_band_min", { precision: 14, scale: 2 }),
    ctcBandMax: numeric("ctc_band_max", { precision: 14, scale: 2 }),
    /** Ladder key the budget CTC was benchmarked against (see career-ladder.ts). */
    careerLevel: text("career_level"),
    /** TA-corrected job-card zones + slot values for this requisition. */
    jobCardOverrides: jsonb("job_card_overrides")
      .notNull()
      .default(sql`'{}'::jsonb`),
    maxNoticePeriodDays: integer("max_notice_period_days"),
    workAuthorizationRequired: text("work_authorization_required"),
  },
  (t) => [uniqueIndex("requisitions_org_code_key").on(t.orgId, t.code)],
);

export const jobDescriptions = pgTable("job_descriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  requisitionId: uuid("requisition_id")
    .notNull()
    .references(() => requisitions.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  status: jdStatusEnum("status").notNull().default("draft"),
  purpose: text("purpose"),
  responsibilities: text("responsibilities"),
  mustHave: text("must_have")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  goodToHave: text("good_to_have")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  qualifications: text("qualifications"),
  successFactors: text("success_factors"),
  reportingTo: text("reporting_to"),
  fullText: text("full_text"),
  approverComment: text("approver_comment"),
  /** Content template that produced this version (no FK — survives template deletion). */
  templateId: uuid("template_id"),
  templateName: text("template_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Cached AI salary research — one row per benchmark run. `input_key` hashes
 * the role inputs so identical lookups reuse a recent run instead of paying
 * for another web-search model call.
 */
export const salaryBenchmarks = pgTable(
  "salary_benchmarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    /** sha1(lower(title)|lower(location)|experience_min|experience_max). */
    inputKey: text("input_key").notNull(),
    title: text("title").notNull(),
    location: text("location"),
    experienceMin: integer("experience_min").notNull().default(0),
    experienceMax: integer("experience_max").notNull().default(5),
    currency: text("currency").notNull().default("INR"),
    /** False when the model had no live web access — numbers are an estimate. */
    grounded: boolean("grounded").notNull().default(false),
    confidence: text("confidence").notNull().default("medium"),
    /** BenchmarkPayload from career-ladder.ts: per-level ranges + sources. */
    payload: jsonb("payload").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("salary_benchmarks_org_input_idx").on(t.orgId, t.inputKey, t.createdAt)],
);

/* ------------------------------------------------------------ candidates */

export const candidates = pgTable(
  "candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    location: text("location"),
    source: text("source").notNull().default("direct"),
    experienceYears: numeric("experience_years", { precision: 4, scale: 1 }).notNull().default("0"),
    currentCtc: numeric("current_ctc", { precision: 14, scale: 2 }),
    expectedCtc: numeric("expected_ctc", { precision: 14, scale: 2 }),
    noticePeriodDays: integer("notice_period_days"),
    education: text("education"),
    skills: text("skills")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    resumeText: text("resume_text"),
    linkedinUrl: text("linkedin_url"),
    githubUrl: text("github_url"),
    websiteUrl: text("website_url"),
    xUrl: text("x_url"),
    consentGiven: boolean("consent_given").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    externalId: text("external_id"),
    externalProvider: text("external_provider"),
    /** Path inside the private CV vault bucket: <org_id>/<candidate_id>/<file>. */
    resumeFilePath: text("resume_file_path"),
    ownerId: uuid("owner_id"),
    addedBy: uuid("added_by"),
    isInternal: boolean("is_internal").notNull().default(false),
    employeeId: text("employee_id"),
    currentDepartment: text("current_department"),
    managerEndorsed: boolean("manager_endorsed").notNull().default(false),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncStatus: text("sync_status").notNull().default("never"),
    currentEmployer: text("current_employer"),
    workAuthorization: text("work_authorization"),
    willingToRelocate: boolean("willing_to_relocate"),
    preferredLocations: text("preferred_locations")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The CV parser flagged injection-style instructions in the resume text. */
    suspectedPromptInjection: boolean("suspected_prompt_injection").notNull().default(false),
    referralSource: text("referral_source"),
    employmentHistory: jsonb("employment_history")
      .notNull()
      .default(sql`'[]'::jsonb`),
    careerMetrics: jsonb("career_metrics"),
  },
  (t) => [
    index("candidates_skills_gin").using("gin", t.skills),
    uniqueIndex("candidates_external_unique")
      .on(t.externalProvider, t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
);

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => requisitions.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    stage: appStageEnum("stage").notNull().default("applied"),
    source: text("source").notNull().default("direct"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    stageReason: text("stage_reason"),
    stageNote: text("stage_note"),
  },
  (t) => [uniqueIndex("applications_requisition_candidate_key").on(t.requisitionId, t.candidateId)],
);

export const stageEvents = pgTable(
  "stage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    fromStage: appStageEnum("from_stage"),
    toStage: appStageEnum("to_stage").notNull(),
    actor: text("actor"),
    reason: text("reason"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stage_events_application_idx").on(t.applicationId, t.createdAt)],
);

export const matchScores = pgTable(
  "match_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    skillsScore: integer("skills_score").notNull().default(0),
    experienceScore: integer("experience_score").notNull().default(0),
    careerScore: integer("career_score").notNull().default(0),
    impactScore: integer("impact_score").notNull().default(0),
    innovationScore: integer("innovation_score").notNull().default(0),
    educationScore: integer("education_score").notNull().default(0),
    socialScore: integer("social_score").notNull().default(0),
    overallScore: integer("overall_score").notNull().default(0),
    weights: jsonb("weights")
      .notNull()
      .default(sql`'{"skills":50,"experience":25,"education":10,"social":15}'::jsonb`),
    matchedSkills: text("matched_skills")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    missingSkills: text("missing_skills")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    rationale: text("rationale"),
    riskFlags: text("risk_flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    recommendation: recommendationEnum("recommendation"),
    model: text("model"),
    recruiterOverride: recommendationEnum("recruiter_override"),
    overrideReason: text("override_reason"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    careerMetrics: jsonb("career_metrics"),
    careerFlags: text("career_flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    logisticsFlags: text("logistics_flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    impactHighlights: text("impact_highlights")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    innovationSignals: text("innovation_signals")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [index("match_scores_application_idx").on(t.applicationId)],
);

export const socialProfiles = pgTable(
  "social_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    profileUrl: text("profile_url"),
    handle: text("handle"),
    score: integer("score").notNull().default(0),
    signals: jsonb("signals")
      .notNull()
      .default(sql`'{}'::jsonb`),
    rationale: text("rationale"),
    raw: jsonb("raw"),
    status: text("status").notNull().default("ok"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("social_profiles_candidate_provider_key").on(t.candidateId, t.provider)],
);

export const aiInterviews = pgTable("ai_interviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id")
    .notNull()
    .references(() => applications.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  jdMatchScore: integer("jd_match_score").notNull().default(0),
  skillsetScore: integer("skillset_score").notNull().default(0),
  transcript: jsonb("transcript")
    .notNull()
    .default(sql`'[]'::jsonb`),
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const interviews = pgTable(
  "interviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    level: integer("level").notNull().default(1),
    interviewer: text("interviewer"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    teamsLink: text("teams_link"),
    status: text("status").notNull().default("scheduled"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    interviewerEmail: text("interviewer_email"),
    durationMins: integer("duration_mins").notNull().default(60),
    mode: text("mode").notNull().default("online"),
    agenda: text("agenda"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("interviews_interviewer_email_idx").on(sql`lower(${t.interviewerEmail})`)],
);

export const evaluations = pgTable(
  "evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    level: integer("level").notNull(),
    evaluator: text("evaluator"),
    focusArea: text("focus_area"),
    rating: integer("rating"),
    comments: text("comments"),
    recommendation: recommendationEnum("recommendation").notNull().default("hold"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    interviewId: uuid("interview_id").references(() => interviews.id, { onDelete: "set null" }),
    competencies: jsonb("competencies")
      .notNull()
      .default(sql`'[]'::jsonb`),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("evaluations_interview_id_key")
      .on(t.interviewId)
      .where(sql`${t.interviewId} is not null`),
  ],
);

export const offers = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id")
    .notNull()
    .references(() => applications.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  offeredCtc: numeric("offered_ctc", { precision: 14, scale: 2 }).notNull().default("0"),
  joiningDate: date("joining_date"),
  status: offerStatusEnum("status").notNull().default("draft"),
  approvalTrail: jsonb("approval_trail")
    .notNull()
    .default(sql`'[]'::jsonb`),
  /** Generated offer letter payload — see generateOfferLetter. Not FK'd: templates hard-delete. */
  letter: jsonb("letter"),
  letterTemplateId: uuid("letter_template_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const candidateVerifications = pgTable(
  "candidate_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    authenticityScore: integer("authenticity_score").notNull().default(0),
    claims: jsonb("claims")
      .notNull()
      .default(sql`'[]'::jsonb`),
    redFlags: text("red_flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    evidence: jsonb("evidence")
      .notNull()
      .default(sql`'{}'::jsonb`),
    summary: text("summary"),
    model: text("model"),
    status: text("status").notNull().default("ok"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("candidate_verifications_candidate_idx").on(t.candidateId, t.createdAt)],
);

export const candidateAssessments = pgTable(
  "candidate_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    status: text("status").notNull().default("sent"),
    questions: jsonb("questions")
      .notNull()
      .default(sql`'[]'::jsonb`),
    answers: jsonb("answers")
      .notNull()
      .default(sql`'[]'::jsonb`),
    mindsetScore: integer("mindset_score"),
    dimensions: jsonb("dimensions"),
    redFlags: text("red_flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    strengths: text("strengths")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    summary: text("summary"),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("candidate_assessments_token_key").on(t.token),
    index("candidate_assessments_candidate_idx").on(t.candidateId, t.createdAt),
  ],
);

/* ---------------------------------------------------- integrations & AI */

export const sourceIntegrations = pgTable(
  "source_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    category: text("category").notNull().default("sourcing"),
    config: jsonb("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    credentialFields: text("credential_fields")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    hasCredentials: boolean("has_credentials").notNull().default(false),
    lastTestStatus: text("last_test_status").notNull().default("untested"),
    lastTestMessage: text("last_test_message"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    // Per-connection webhook delivery token (board application ingestion):
    // encrypted display copy + sha256 hash lookup, capture-token precedent.
    webhookToken: text("webhook_token"),
    webhookTokenHash: text("webhook_token_hash"),
    webhookConfiguredAt: timestamp("webhook_configured_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("source_integrations_org_provider_key").on(t.orgId, t.provider)],
);

export const integrationCredentials = pgTable("integration_credentials", {
  integrationId: uuid("integration_id")
    .primaryKey()
    .references(() => sourceIntegrations.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  secrets: jsonb("secrets")
    .notNull()
    .default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiSettings = pgTable(
  "ai_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singleton: boolean("singleton").notNull().default(true),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("openai"),
    model: text("model").notNull().default("gpt-5.5"),
    lastTestStatus: text("last_test_status").notNull().default("untested"),
    lastTestMessage: text("last_test_message"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_settings_org_key").on(t.orgId)],
);

export const aiProviderCredentials = pgTable(
  "ai_provider_credentials",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    apiKey: text("api_key").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_provider_credentials_org_provider_key").on(t.orgId, t.provider)],
);

export type AiUsageStatus = "ok" | "error";

/** One row per provider request — the R&D ledger behind the platform console. */
export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    feature: text("feature").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: text("status").$type<AiUsageStatus>().notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    durationMs: integer("duration_ms"),
    grounded: boolean("grounded"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_usage_events_org_created_idx").on(t.orgId, t.createdAt),
    index("ai_usage_events_feature_created_idx").on(t.feature, t.createdAt),
    index("ai_usage_events_model_idx").on(t.model),
    index("ai_usage_events_created_idx").on(t.createdAt),
  ],
);

export type EmailOutboxKind =
  | "ack"
  | "stage_update"
  | "interview_invite"
  | "offer_released"
  | "assessment_invite"
  | "member_reminder";
export type EmailOutboxStatus = "queued" | "sent" | "failed" | "suppressed";
export type EmailOutboxAttachment = {
  filename: string;
  contentBase64: string;
  contentType: string;
};

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").$type<EmailOutboxKind>().notNull(),
    templateName: text("template_name").notNull(),
    toEmail: text("to_email").notNull(),
    replyTo: text("reply_to"),
    templateData: jsonb("template_data")
      .$type<Record<string, string | undefined>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    attachments: jsonb("attachments")
      .$type<EmailOutboxAttachment[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").$type<EmailOutboxStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_outbox_idempotency_key").on(t.idempotencyKey),
    index("email_outbox_queue_idx").on(t.status, t.availableAt),
    index("email_outbox_application_kind_status_idx").on(t.applicationId, t.kind, t.status),
    index("email_outbox_org_kind_created_idx").on(t.orgId, t.kind, t.createdAt),
  ],
);

export const emailSettings = pgTable(
  "email_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singleton: boolean("singleton").notNull().default(true),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    ackEnabled: boolean("ack_enabled").notNull().default(true),
    stageEnabled: boolean("stage_enabled").notNull().default(true),
    interviewEnabled: boolean("interview_enabled").notNull().default(true),
    offerEnabled: boolean("offer_enabled").notNull().default(true),
    replyTo: text("reply_to"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("email_settings_org_key").on(t.orgId)],
);

export const copilotMessages = pgTable("copilot_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const captureEvents = pgTable(
  "capture_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    sourceUrl: text("source_url"),
    title: text("title"),
    status: text("status").notNull().default("stored"),
    detail: text("detail"),
    candidateId: uuid("candidate_id").references(() => candidates.id, { onDelete: "set null" }),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("capture_events_org_created_idx").on(t.orgId, t.createdAt)],
);

export const inboxMessages = pgTable(
  "inbox_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    toAddress: text("to_address"),
    fromEmail: text("from_email"),
    fromName: text("from_name"),
    subject: text("subject"),
    body: text("body"),
    attachmentName: text("attachment_name"),
    attachmentBytes: integer("attachment_bytes"),
    status: text("status").notNull().default("received"),
    detail: text("detail"),
    candidateId: uuid("candidate_id"),
    requisitionId: uuid("requisition_id"),
    providerMessageId: text("provider_message_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inbox_messages_provider_key")
      .on(t.orgId, t.providerMessageId)
      .where(sql`${t.providerMessageId} is not null`),
    index("inbox_messages_org_idx").on(t.orgId, t.receivedAt),
  ],
);

export const orgLinkedinConnections = pgTable("org_linkedin_connections", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  memberSub: text("member_sub").notNull(),
  memberName: text("member_name"),
  memberEmail: text("member_email"),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  scope: text("scope"),
  connectedBy: uuid("connected_by"),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ----------------------------------------------------- talent ontology (0032) */

export const skillNodes = pgTable(
  "skill_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull().default("general"),
    aliases: text("aliases").array().notNull().default([]),
    parentSlug: text("parent_slug"),
    supply: integer("supply").notNull().default(0),
    demand: integer("demand").notNull().default(0),
    validated: integer("validated").notNull().default(0),
    evidenceCount: integer("evidence_count").notNull().default(0),
    status: text("status").notNull().default("active"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("skill_nodes_org_slug_key").on(t.orgId, t.slug)],
);

export const skillEdges = pgTable(
  "skill_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fromSlug: text("from_slug").notNull(),
    toSlug: text("to_slug").notNull(),
    kind: text("kind").notNull().default("cooccurs"),
    weight: numeric("weight").notNull().default("0"),
    evidenceCount: integer("evidence_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("skill_edges_org_key").on(t.orgId, t.fromSlug, t.toSlug, t.kind)],
);

export const skillEvidence = pgTable(
  "skill_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    candidateId: uuid("candidate_id").references(() => candidates.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "cascade",
    }),
    source: text("source").notNull(),
    strength: numeric("strength").notNull().default("1"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("skill_evidence_org_slug_idx").on(t.orgId, t.slug)],
);

export const ontologySnapshots = pgTable("ontology_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  nodeCount: integer("node_count").notNull().default(0),
  edgeCount: integer("edge_count").notNull().default(0),
  added: text("added").array().notNull().default([]),
  grown: text("grown").array().notNull().default([]),
  dormant: text("dormant").array().notNull().default([]),
  retired: text("retired").array().notNull().default([]),
  stats: jsonb("stats").notNull().default({}),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* --------------------------------------------- product catalogue commercials (0031) */

export const productCatalogueCommercials = pgTable("product_catalogue_commercials", {
  moduleId: text("module_id").primaryKey(),
  tier: text("tier"),
  listPrice: numeric("list_price"),
  currency: text("currency").notNull().default("USD"),
  unit: text("unit"),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});

/* --------------------------------- ownership & collaboration (0030), catalogue shares */

export const candidateOwnershipEvents = pgTable("candidate_ownership_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id),
  candidateId: uuid("candidate_id")
    .notNull()
    .references(() => candidates.id, { onDelete: "cascade" }),
  fromOwner: uuid("from_owner"),
  toOwner: uuid("to_owner"),
  actor: uuid("actor"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const candidateReferrals = pgTable("candidate_referrals", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id),
  candidateId: uuid("candidate_id")
    .notNull()
    .references(() => candidates.id, { onDelete: "cascade" }),
  requisitionId: uuid("requisition_id").references(() => requisitions.id, { onDelete: "set null" }),
  fromUser: uuid("from_user").notNull(),
  toUser: uuid("to_user").notNull(),
  note: text("note"),
  status: text("status").notNull().default("pending"),
  responseNote: text("response_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
});

export const talentRequests = pgTable("talent_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id),
  requisitionId: uuid("requisition_id").references(() => requisitions.id, { onDelete: "set null" }),
  requesterId: uuid("requester_id").notNull(),
  title: text("title").notNull(),
  skills: text("skills").array().notNull().default([]),
  note: text("note"),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const talentRequestSuggestions = pgTable(
  "talent_request_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    requestId: uuid("request_id")
      .notNull()
      .references(() => talentRequests.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    suggestedBy: uuid("suggested_by").notNull(),
    note: text("note"),
    status: text("status").notNull().default("suggested"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("talent_request_suggestions_req_cand_key").on(t.requestId, t.candidateId)],
);

export const candidateNotes = pgTable("candidate_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id),
  candidateId: uuid("candidate_id")
    .notNull()
    .references(() => candidates.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull(),
  authorName: text("author_name"),
  body: text("body").notNull(),
  mentions: uuid("mentions").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgPoolShares = pgTable(
  "org_pool_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerOrg: uuid("owner_org")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    partnerOrg: uuid("partner_org")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    scope: text("scope"),
    requestedBy: uuid("requested_by"),
    respondedBy: uuid("responded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("org_pool_shares_owner_partner_key").on(t.ownerOrg, t.partnerOrg)],
);

/* --------------------------------------------------- content templates */

/**
 * Org-defined templates controlling how AI-generated LinkedIn posts and JDs
 * are written, plus branded job-card image themes. `config` holds the
 * per-kind structured fields (tone, headings, hashtags, accent color, …);
 * `instructions` is the org's free-text overlay supporting {{placeholders}}.
 */
export const contentTemplates = pgTable(
  "content_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    config: jsonb("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    instructions: text("instructions"),
    /** job_card only — stored object key under `${orgId}/branding/`. */
    logoPath: text("logo_path"),
    logoContentType: text("logo_content_type"),
    /** job_card — full-bleed background artwork; job text renders on top. */
    backgroundPath: text("background_path"),
    backgroundContentType: text("background_content_type"),
    /** Original company file the template was imported from, when it was. */
    sourcePath: text("source_path"),
    sourceName: text("source_name"),
    sourceContentType: text("source_content_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "content_templates_kind_check",
      sql`${t.kind} in ('linkedin_post','jd','job_card','offer_letter')`,
    ),
    uniqueIndex("content_templates_org_kind_name_key").on(t.orgId, t.kind, t.name),
    uniqueIndex("content_templates_org_kind_default_key")
      .on(t.orgId, t.kind)
      .where(sql`${t.isDefault}`),
  ],
);

/**
 * Phone-screening kits: AI-built question sets for one candidate/role pairing.
 * Questions and engine metadata are AI-generated JSON; `orgId` scopes every
 * read/write (enforced again in screening.functions.ts — no RLS exists).
 */
export const screeningKits = pgTable(
  "screening_kits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    questions: jsonb("questions")
      .notNull()
      .default(sql`'[]'::jsonb`),
    focusSummary: text("focus_summary"),
    engine: jsonb("engine")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("screening_kits_candidate_idx").on(t.candidateId, t.createdAt),
    index("screening_kits_org_idx").on(t.orgId),
  ],
);

/** One graded screening attempt against a kit (typed answers, notes or audio). */
export const screeningRuns = pgTable(
  "screening_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    kitId: uuid("kit_id")
      .notNull()
      .references(() => screeningKits.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    inputKind: text("input_kind").notNull().default("typed"),
    answers: jsonb("answers")
      .notNull()
      .default(sql`'[]'::jsonb`),
    transcript: text("transcript"),
    /** Vault object key under `${orgId}/${candidateId}/`. */
    audioPath: text("audio_path"),
    audioEngine: text("audio_engine"),
    screeningScore: integer("screening_score").notNull().default(0),
    matchScore: integer("match_score"),
    combinedScore: integer("combined_score"),
    verdicts: jsonb("verdicts")
      .notNull()
      .default(sql`'[]'::jsonb`),
    redFlags: text("red_flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    rationale: text("rationale"),
    recommendation: text("recommendation"),
    recommendationReason: text("recommendation_reason"),
    engine: jsonb("engine")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("screening_runs_kit_idx").on(t.kitId, t.createdAt),
    index("screening_runs_candidate_idx").on(t.candidateId, t.createdAt),
    index("screening_runs_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

export type ScreeningPrepStatus = "pending" | "running" | "ready" | "failed";

/**
 * Background queue that prepares screening kits when a candidate is
 * shortlisted, so the questions are ready before the recruiter arrives.
 * One job per application (unique index); re-enqueue is an upsert that resets
 * a failed attempt. Kits themselves stay in screening_kits — deliberately no
 * unique index there, because manual "Rebuild questions" keeps multiple kits
 * per pairing; dedupe happens in code.
 */
export const screeningPrepJobs = pgTable(
  "screening_prep_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => requisitions.id, { onDelete: "cascade" }),
    status: text("status").$type<ScreeningPrepStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("screening_prep_jobs_application_key").on(t.applicationId),
    index("screening_prep_jobs_queue_idx").on(t.status, t.updatedAt),
    index("screening_prep_jobs_org_idx").on(t.orgId, t.status),
  ],
);

export const hrIncentiveSchemes = pgTable("hr_incentive_schemes", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  currency: text("currency").notNull().default("INR"),
  targetClosuresPerMonth: integer("target_closures_per_month").notNull().default(3),
  payoutPerClosure: numeric("payout_per_closure").notNull().default("10000"),
  qualityBands: jsonb("quality_bands")
    .notNull()
    .default(
      sql`'[{"min_score":85,"multiplier":1.2},{"min_score":70,"multiplier":1},{"min_score":0,"multiplier":0.8}]'::jsonb`,
    ),
  monthlyCap: numeric("monthly_cap"),
  notes: text("notes"),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * In-house compensation knowledge. Every figure a recruiter accepts or edits
 * on the market benchmark panel lands here, so future research is anchored on
 * what this organisation actually pays rather than on the open web alone.
 */
export const compKnowledge = pgTable(
  "comp_knowledge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    /** slug(title) — the grouping key for "what do we pay for this role". */
    roleKey: text("role_key").notNull(),
    title: text("title").notNull(),
    location: text("location"),
    /** Career ladder key, or "requisition" for a whole-req budget decision. */
    levelKey: text("level_key").notNull(),
    currency: text("currency").notNull().default("INR"),
    low: numeric("low"),
    median: numeric("median").notNull(),
    high: numeric("high"),
    experienceMin: integer("experience_min"),
    experienceMax: integer("experience_max"),
    /** "user_override" when typed by hand, "market_applied" when accepted as-is. */
    source: text("source").notNull().default("user_override"),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("comp_knowledge_org_role_idx").on(t.orgId, t.roleKey, t.createdAt),
    index("comp_knowledge_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

/**
 * Pre-onboarding document collection and validation.
 *
 * Before an approved offer may be released, the candidate's documents — photo
 * ID, experience letters, payslips proving the last drawn CTC, education
 * certificates — are collected (uploaded by TA or received on the careers
 * inbox), read by the extraction agent into `extracted`, and then validated by
 * HR/TA against the original file. The stored file, the extracted reading and
 * the reviewer's decision live on the same row so the audit is transparent.
 */
export const onboardingDocuments = pgTable(
  "onboarding_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id").references(() => offers.id, { onDelete: "set null" }),
    /** Catalogue key — see DOC_TYPES in src/lib/onboarding.server.ts. */
    docType: text("doc_type").notNull(),
    fileName: text("file_name").notNull(),
    /** Private object-storage key, always under `<org_id>/…`. */
    filePath: text("file_path"),
    fileBytes: integer("file_bytes"),
    contentType: text("content_type"),
    /** "upload" (TA/HR) or "careers_inbox" (received by mail). */
    source: text("source").notNull().default("upload"),
    inboxMessageId: uuid("inbox_message_id"),
    /** Text the agent read out of the file, kept for reviewer transparency. */
    extractedText: text("extracted_text"),
    extracted: jsonb("extracted"),
    /** pending | extracted | failed */
    extractionStatus: text("extraction_status").notNull().default("pending"),
    extractionNote: text("extraction_note"),
    model: text("model"),
    /** pending | verified | rejected */
    status: text("status").notNull().default("pending"),
    reviewNote: text("review_note"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    uploadedBy: uuid("uploaded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("onboarding_documents_org_app_idx").on(t.orgId, t.applicationId, t.createdAt),
    index("onboarding_documents_org_status_idx").on(t.orgId, t.status),
  ],
);

/* -------------------------------------------------------------- HRMS sync */

/**
 * Normalised employee-master rows synced *from* the organisation's HRMS
 * (Keka, greytHR, …) over the connections in source_integrations
 * (category "hrms"). The HRMS stays the system of record — this table is a
 * read-only cache, so rows are upserted and tombstoned (employment_status),
 * never deleted by the sync.
 */
export const hrmsEmployees = pgTable(
  "hrms_employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => sourceIntegrations.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    fullName: text("full_name").notNull(),
    email: text("email"),
    employeeCode: text("employee_code"),
    department: text("department"),
    jobTitle: text("job_title"),
    location: text("location"),
    managerExternalId: text("manager_external_id"),
    /** Vendor value passed through; "terminated"/"resigned" tombstones a leaver. */
    employmentStatus: text("employment_status").notNull().default("active"),
    joinedOn: text("joined_on"),
    /** Last vendor payload, kept for field-mapping debugging — never rendered. */
    raw: jsonb("raw")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("hrms_employees_integration_external_key").on(t.integrationId, t.externalId),
    index("hrms_employees_org_department_idx").on(t.orgId, t.department),
  ],
);

/** One row per connection + entity: watermark, health and run statistics. */
export const hrmsSyncState = pgTable(
  "hrms_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => sourceIntegrations.id, { onDelete: "cascade" }),
    /** "employees" | "departments" */
    entity: text("entity").notNull().default("employees"),
    /** Opaque vendor cursor (page / last-modified watermark) between runs. */
    cursor: jsonb("cursor")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastFullSyncAt: timestamp("last_full_sync_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** idle | ok | failed */
    lastRunStatus: text("last_run_status").notNull().default("idle"),
    lastError: text("last_error"),
    stats: jsonb("stats")
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("hrms_sync_state_integration_entity_key").on(t.integrationId, t.entity)],
);

/**
 * Per-connection field mapping profile: HRMS field path → ATSIQ employee
 * field, plus a passthrough bag for vendor-specific fields the defaults do
 * not cover. `{}` means "adapter defaults" — mappings are overrides.
 */
export const hrmsFieldMappings = pgTable(
  "hrms_field_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => sourceIntegrations.id, { onDelete: "cascade" }),
    mappings: jsonb("mappings")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("hrms_field_mappings_integration_key").on(t.integrationId)],
);

/* ------------------------------------------------- job board connections */

/**
 * Syndication state for one requisition on one partner board (LinkedIn /
 * Indeed / Naukri). `external_id` is the vendor's posting id — the key the
 * inbound webhook uses to route an applicant back to this requisition.
 */
export const requisitionBoardPostings = pgTable(
  "requisition_board_postings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => requisitions.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** pending | published | failed | closed | withdrawn */
    status: text("status").notNull().default("pending"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    /** Last posted body — non-secret by construction. */
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    publishedBy: uuid("published_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("board_postings_req_provider_key").on(t.requisitionId, t.provider),
    index("board_postings_org_status_idx").on(t.orgId, t.status),
    index("board_postings_provider_external_idx")
      .on(t.provider, t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
);

/**
 * Raw inbound board webhook events. The `dedupe_key` ("<provider>:<org>:
 * <event id>") is the idempotency boundary — a redelivery can never file an
 * applicant twice. Rows are forensics too: terminal rows are purged after
 * 30 days by board-sync.
 */
export const boardWebhookEvents = pgTable(
  "board_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dedupeKey: text("dedupe_key").notNull(),
    /** NULL when the org could not be resolved from the delivery token. */
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    externalEventId: text("external_event_id").notNull(),
    /** Allowlisted headers only (content-type, user-agent, signature). */
    headers: jsonb("headers")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** pending | processed | duplicate | failed */
    status: text("status").notNull().default("pending"),
    requisitionId: uuid("requisition_id"),
    candidateId: uuid("candidate_id"),
    applicationId: uuid("application_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("board_webhook_events_dedupe_key").on(t.dedupeKey),
    index("board_webhook_events_status_idx").on(t.status, t.receivedAt),
    index("board_webhook_events_org_idx").on(t.orgId, t.receivedAt),
  ],
);

/** Poll watermark and run health per board connection (cron bookkeeping). */
export const boardSyncState = pgTable(
  "board_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => sourceIntegrations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** idle | ok | failed */
    lastRunStatus: text("last_run_status").notNull().default("idle"),
    lastError: text("last_error"),
    stats: jsonb("stats")
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("board_sync_state_integration_key").on(t.integrationId)],
);

/* ------------------------------------------------------------ agents (0024) */
/* docs/agentic-plan.md §7. Statuses are app-level text, like email_outbox. */

export type AgentType =
  | "copilot"
  | "requisition"
  | "jd"
  | "publishing"
  | "intake"
  | "screening"
  | "interview"
  | "evaluation"
  | "offer"
  | "onboarding"
  | "followup";
export type AgentAutonomy = "suggest" | "act_and_notify" | "autonomous";
export type AgentRunStatus =
  "queued" | "running" | "awaiting_human" | "done" | "failed" | "cancelled";
export type AgentTaskKind = "gate" | "approval" | "clarification";
export type AgentTaskStatus =
  "open" | "approved" | "rejected" | "answered" | "expired" | "cancelled";
export type AgentEventStatus = "pending" | "processing" | "done" | "failed";

/**
 * Per org × agent type: the autonomy dial, template whitelist and budget.
 * Agents are opt-in — no row (or enabled = false) means the agent is off. The
 * row with agent_type '*' is the org-wide switch: enabled = false pauses all.
 */
export const agentPolicies = pgTable(
  "agent_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentType: text("agent_type").$type<AgentType | "*">().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    autonomy: text("autonomy").$type<AgentAutonomy>().notNull().default("suggest"),
    /** Content-template ids an agent may send without per-message approval. */
    whitelistedTemplates: jsonb("whitelisted_templates")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    monthlyTokenBudget: integer("monthly_token_budget"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_policies_org_agent_key").on(t.orgId, t.agentType)],
);

/** Domain-event outbox written by lifecycle choke points; drained by the orchestrator. */
export const agentEvents = pgTable(
  "agent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").$type<AgentEventStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_events_queue_idx").on(t.status, t.createdAt),
    index("agent_events_org_idx").on(t.orgId, t.createdAt),
  ],
);

/**
 * One agent run. `transcript` is the provider-neutral conversation
 * (AgentMessage[]) and doubles as the checkpoint; `pending` holds tool calls
 * parked behind a human decision. Every run acts on behalf of a human
 * principal — it can never do more than that person could.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentType: text("agent_type").$type<AgentType>().notNull(),
    status: text("status").$type<AgentRunStatus>().notNull().default("queued"),
    principalUserId: uuid("principal_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    triggerEventId: uuid("trigger_event_id").references(() => agentEvents.id, {
      onDelete: "set null",
    }),
    goal: text("goal").notNull(),
    transcript: jsonb("transcript")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    pending: jsonb("pending").$type<unknown>(),
    result: text("result"),
    stepCount: integer("step_count").notNull().default(0),
    tokensUsed: integer("tokens_used").notNull().default(0),
    maxSteps: integer("max_steps").notNull().default(20),
    maxTokens: integer("max_tokens").notNull().default(200000),
    traceId: uuid("trace_id").notNull().defaultRandom(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_runs_queue_idx").on(t.status, t.updatedAt),
    index("agent_runs_org_status_idx").on(t.orgId, t.status),
    index("agent_runs_subject_idx").on(t.orgId, t.subjectType, t.subjectId),
  ],
);

/** Append-only step log of a run: model turns, tool calls, decisions. Also the trace spans. */
export const agentSteps = pgTable(
  "agent_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** model | tool | decision | error */
    kind: text("kind").notNull(),
    toolName: text("tool_name"),
    toolCallId: text("tool_call_id"),
    /** ok | error | blocked | awaiting */
    status: text("status").notNull(),
    /** Redacted summaries only — never full CV, document or mail text. */
    input: jsonb("input").$type<unknown>(),
    output: jsonb("output").$type<unknown>(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    spanId: uuid("span_id").notNull().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_steps_run_seq_key").on(t.runId, t.seq)],
);

/** Human-in-the-loop items: gates, action approvals and clarifying questions. */
export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AgentTaskKind>().notNull(),
    status: text("status").$type<AgentTaskStatus>().notNull().default("open"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** The tool call waiting on this decision: { toolCallId, name, args }. */
    proposedAction: jsonb("proposed_action").$type<unknown>(),
    assigneeRole: text("assignee_role").$type<(typeof appRoleEnum.enumValues)[number]>(),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    /** The human's answer: edited args, free-text reply, rejection reason. */
    response: jsonb("response").$type<unknown>(),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_tasks_org_status_idx").on(t.orgId, t.status),
    index("agent_tasks_run_idx").on(t.runId),
  ],
);

/** Daily rollup per org × agent for dashboards and alerts (docs/agentic-plan.md §9). */
export const agentMetricsDaily = pgTable(
  "agent_metrics_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentType: text("agent_type").$type<AgentType>().notNull(),
    day: date("day").notNull(),
    runsStarted: integer("runs_started").notNull().default(0),
    runsDone: integer("runs_done").notNull().default(0),
    runsFailed: integer("runs_failed").notNull().default(0),
    steps: integer("steps").notNull().default(0),
    toolErrors: integer("tool_errors").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    tasksOpened: integer("tasks_opened").notNull().default(0),
    tasksApproved: integer("tasks_approved").notNull().default(0),
    tasksRejected: integer("tasks_rejected").notNull().default(0),
    tasksEdited: integer("tasks_edited").notNull().default(0),
    hitlWaitMsTotal: integer("hitl_wait_ms_total").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_metrics_daily_key").on(t.orgId, t.agentType, t.day)],
);
