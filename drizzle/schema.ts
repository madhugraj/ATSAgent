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
  type AnyPgColumn,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
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
  "countered",
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

/**
 * An organisation's acceptance of a versioned legal document (Terms of
 * Service, Privacy Policy, Data Processing Agreement — src/lib/legal). One row
 * per document version accepted; a new version needs a new row, so the owner
 * is asked again. The signatory's name, title and email are copied so the
 * record survives the user being removed; the IP is kept only as an HMAC.
 */
export const orgAgreements = pgTable(
  "org_agreements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    version: text("version").notNull(),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    accepterName: text("accepter_name").notNull(),
    accepterTitle: text("accepter_title").notNull(),
    accepterEmail: text("accepter_email").notNull(),
    ipHash: text("ip_hash"),
  },
  (t) => [
    check("org_agreements_kind_check", sql`${t.kind} in ('terms','privacy','dpa')`),
    uniqueIndex("org_agreements_org_kind_version_key").on(t.orgId, t.kind, t.version),
    index("org_agreements_org_idx").on(t.orgId, t.acceptedAt),
  ],
);

/** Who interviews, on what, how often — registered once by the admin (docs/interview-panel-plan.md). */
export const memberInterviewerProfiles = pgTable(
  "member_interviewer_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => orgMembers.id, { onDelete: "cascade" }),
    active: boolean("active").notNull().default(true),
    /** Skills and competencies they assess, matched to a round's competencies. */
    areas: text("areas")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Interview rounds they take (1–3). */
    rounds: integer("rounds")
      .array()
      .notNull()
      .default(sql`'{1,2,3}'::integer[]`),
    weeklyCap: integer("weekly_cap").notNull().default(4),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("member_interviewer_profiles_member_key").on(t.memberId),
    index("member_interviewer_profiles_org_idx").on(t.orgId, t.active),
    check("member_interviewer_profiles_weekly_cap_check", sql`${t.weeklyCap} between 1 and 20`),
    check(
      "member_interviewer_profiles_rounds_check",
      sql`${t.rounds} <@ array[1,2,3] and cardinality(${t.rounds}) >= 1`,
    ),
    check("member_interviewer_profiles_areas_check", sql`cardinality(${t.areas}) <= 20`),
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
    /** onsite | hybrid | remote (migration 0041); null for older roles. */
    workMode: text("work_mode").$type<"onsite" | "hybrid" | "remote">(),
    openings: integer("openings").notNull().default(1),
    experienceMin: integer("experience_min").notNull().default(0),
    experienceMax: integer("experience_max").notNull().default(5),
    budgetCtc: numeric("budget_ctc", { precision: 14, scale: 2 }).notNull().default("0"),
    hiringManager: text("hiring_manager"),
    /** The role's hiring manager as a member (approves its interview panels). */
    hiringManagerMemberId: uuid("hiring_manager_member_id").references(() => orgMembers.id, {
      onDelete: "set null",
    }),
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
    /** Interview rounds, rubric and verdict policy for this role (null = the default from its must-haves). */
    interviewPlan:
      jsonb("interview_plan").$type<import("../src/lib/interview-plan").InterviewPlan>(),
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

/**
 * The approved interview panel for one role and round (docs/interview-panel-plan.md,
 * P2): proposed by the Interview coordinator, approved or changed by a person,
 * reused for every candidate of that role and round. `version` counts approvals.
 */
export const rolePanels = pgTable(
  "role_panels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => requisitions.id, { onDelete: "cascade" }),
    level: integer("level").notNull(),
    memberIds: uuid("member_ids").array().notNull(),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("role_panels_requisition_level_key").on(t.requisitionId, t.level),
    index("role_panels_org_idx").on(t.orgId),
    check("role_panels_level_check", sql`${t.level} between 1 and 3`),
    check("role_panels_members_check", sql`cardinality(${t.memberIds}) between 1 and 3`),
  ],
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
    /** The candidate asked not to be phoned by the AI assistant: no AI call dials them again. */
    aiCallOptOutAt: timestamp("ai_call_opt_out_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When this person was last checked against the open roles (new CV → open roles). */
    roleMatchCheckedAt: timestamp("role_match_checked_at", { withTimezone: true }),
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
    /**
     * What this CV may be used for (migration 0045): 'pool' (any role, with
     * consent) or 'role_only' — it came from a portal whose terms limit it to
     * the role it was for; never reused, erased (after a person approves)
     * once its roles are over. pool_use_source names that portal.
     */
    poolUse: text("pool_use").$type<"pool" | "role_only">().notNull().default("pool"),
    poolUseSource: text("pool_use_source"),
  },
  (t) => [
    index("candidates_skills_gin").using("gin", t.skills),
    index("candidates_role_only_idx")
      .on(t.orgId)
      .where(sql`${t.poolUse} = 'role_only'`),
    uniqueIndex("candidates_external_unique")
      .on(t.externalProvider, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index("candidates_role_match_pending_idx")
      .on(t.orgId, t.createdAt)
      .where(sql`${t.roleMatchCheckedAt} is null`),
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
    /** Further interviewers on the panel (the first is `interviewer`): [{ name, email }]. */
    panel: jsonb("panel")
      .$type<{ name: string | null; email: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Why a round did not happen (no-show / cancelled), in a person's words. */
    outcomeNote: text("outcome_note"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Interviewers who said they cannot make this booked round (migration 0051). */
    unavailable: jsonb("unavailable")
      .$type<{ email: string; note: string | null; at: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (t) => [index("interviews_interviewer_email_idx").on(sql`lower(${t.interviewerEmail})`)],
);

/**
 * For one candidate's round only, a panellist replaced by another member
 * (docs/interview-panel-plan.md, P3): proposed by the Interview coordinator,
 * approved by a person. The role's approved panel is unchanged.
 */
export const roundSubstitutes = pgTable(
  "round_substitutes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    level: integer("level").notNull(),
    replaceMemberId: uuid("replace_member_id")
      .notNull()
      .references(() => orgMembers.id, { onDelete: "cascade" }),
    withMemberId: uuid("with_member_id")
      .notNull()
      .references(() => orgMembers.id, { onDelete: "cascade" }),
    reason: text("reason"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("round_substitutes_round_member_key").on(
      t.applicationId,
      t.level,
      t.replaceMemberId,
    ),
    index("round_substitutes_org_idx").on(t.orgId),
    check("round_substitutes_level_check", sql`${t.level} between 1 and 3`),
    check("round_substitutes_distinct_check", sql`${t.replaceMemberId} <> ${t.withMemberId}`),
  ],
);

/**
 * Interview times offered to a candidate, who picks one from a private link
 * (/schedule/<token>). Booking happens only when they pick: the round, the
 * meeting link and both invites are created then (migration 0033).
 */
export const interviewSlotOffers = pgTable(
  "interview_slot_offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    level: integer("level").notNull(),
    interviewerName: text("interviewer_name"),
    interviewerEmail: text("interviewer_email").notNull(),
    durationMins: integer("duration_mins").notNull().default(60),
    mode: text("mode").notNull().default("online"),
    meetingProvider: text("meeting_provider"),
    agenda: text("agenda"),
    /** ISO start times offered. */
    slots: jsonb("slots").$type<string[]>().notNull(),
    token: text("token").notNull(),
    /** offered | booked | declined | expired | cancelled */
    status: text("status").notNull().default("offered"),
    chosenAt: timestamp("chosen_at", { withTimezone: true }),
    interviewId: uuid("interview_id").references(() => interviews.id, { onDelete: "set null" }),
    /** The candidate's own words when none of the times work (untrusted). */
    candidateNote: text("candidate_note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by"),
    agentRunId: uuid("agent_run_id"),
    /** Further interviewers on the panel: [{ name, email }]. */
    panel: jsonb("panel")
      .$type<{ name: string | null; email: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("interview_slot_offers_token_key").on(t.token),
    index("interview_slot_offers_open_idx").on(t.orgId, t.status, t.expiresAt),
    index("interview_slot_offers_application_idx").on(t.applicationId),
  ],
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
    /** Who submitted (lower-case email) — one scorecard per panel member per round. */
    evaluatorEmail: text("evaluator_email"),
  },
  (t) => [
    // One scorecard per interviewer per round (panels have several per round).
    uniqueIndex("evaluations_interview_evaluator_key")
      .on(t.interviewId, sql`coalesce(lower(${t.evaluatorEmail}), '')`)
      .where(sql`${t.interviewId} is not null`),
  ],
);

export const offers = pgTable(
  "offers",
  {
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
    /** The candidate's private accept / decline / ask-for-changes link (set on release). */
    responseToken: text("response_token"),
    /** What the candidate asked for: { expectedCtc, joiningDate, note, at }. */
    counter: jsonb("counter").$type<{
      expectedCtc: number | null;
      joiningDate: string | null;
      note: string | null;
      at: string;
    }>(),
    /** Version of this offer (1, then +1 per revision after a counter). */
    revision: integer("revision").notNull().default(1),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("offers_response_token_key")
      .on(t.responseToken)
      .where(sql`${t.responseToken} is not null`),
  ],
);

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
    /** The application it was sent for (reminders and decisions act on it). */
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    /** What the candidate was told; overdue counts from here. */
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** When the link stops working. */
    closesAt: timestamp("closes_at", { withTimezone: true }),
    remindersSent: integer("reminders_sent").notNull().default(0),
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    /** When it was flagged overdue (the people deciding were told). */
    overdueAt: timestamp("overdue_at", { withTimezone: true }),
    /** Why a person chose to go on without it (status 'waived'). */
    waivedReason: text("waived_reason"),
  },
  (t) => [
    index("candidate_assessments_open_idx")
      .on(t.orgId, t.status, t.dueAt)
      .where(sql`${t.status} = 'sent'`),
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
    /** The agent run that caused this request (model turn or AI call inside a tool). */
    agentRunId: uuid("agent_run_id"),
    /** The role / candidate this request was made for (cost per candidate). */
    requisitionId: uuid("requisition_id"),
    applicationId: uuid("application_id"),
    candidateId: uuid("candidate_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_usage_events_org_created_idx").on(t.orgId, t.createdAt),
    index("ai_usage_events_feature_created_idx").on(t.feature, t.createdAt),
    index("ai_usage_events_model_idx").on(t.model),
    index("ai_usage_events_created_idx").on(t.createdAt),
    index("ai_usage_events_application_idx")
      .on(t.applicationId)
      .where(sql`${t.applicationId} is not null`),
    index("ai_usage_events_requisition_idx")
      .on(t.requisitionId)
      .where(sql`${t.requisitionId} is not null`),
  ],
);

export type EmailOutboxKind =
  | "ack"
  | "stage_update"
  | "interview_invite"
  | "offer_released"
  | "assessment_invite"
  | "member_reminder"
  | "document_request"
  | "role_invite"
  | "interviewer_brief"
  | "interview_slots"
  | "compensation_form"
  | "offer_negotiation"
  | "screening_call_booked";
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
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
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

/** How much of a phone screening a grade rests on. */
export type ScreeningCoverage = {
  /** Screening questions the call meant to ask. */
  planned: number;
  /** Of those, how many were asked on the call (older runs: not recorded). */
  asked?: number;
  /** Of those, how many the candidate answered (the grade uses only these). */
  answered: number;
  /** The planned and the asked questions' ids — so the ones not reached can be named. */
  plannedIds?: string[];
  askedIds?: string[];
  /** answered / planned: high ≥ 75 %, medium ≥ 50 %, else low. */
  confidence: "high" | "medium" | "low";
};

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
    /** Phone screening: what the grade rests on (graded only on the questions covered). */
    coverage: jsonb("coverage").$type<ScreeningCoverage | null>(),
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
 * Syndication state for one requisition on one channel: a partner board
 * (LinkedIn / Indeed / Naukri, by API or posted by hand), a job feed
 * (Jooble / Adzuna / Jora), Google for Jobs, or a portal a person posts on
 * (provider = a channel id from src/lib/job-channels.ts). `external_id` is the
 * vendor's posting id — the key the inbound webhook uses to route an
 * applicant back to this requisition.
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
 * How an organisation advertises beyond the partner boards (migration 0044):
 * Google for Jobs listing and the token behind its public job feeds. The
 * token is a feed address, stored encrypted with a SHA-256 lookup hash.
 */
export const orgJobDistribution = pgTable(
  "org_job_distribution",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    googleJobsEnabled: boolean("google_jobs_enabled").notNull().default(false),
    feedToken: text("feed_token"),
    feedTokenHash: text("feed_token_hash"),
    feedRotatedAt: timestamp("feed_rotated_at", { withTimezone: true }),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("org_job_distribution_feed_token_hash_key")
      .on(t.feedTokenHash)
      .where(sql`${t.feedTokenHash} is not null`),
  ],
);

/** Google Indexing API notifications, sent within the platform's daily quota. */
export const jobIndexNotifications = pgTable(
  "job_index_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    url: text("url").notNull(),
    kind: text("kind").$type<"URL_UPDATED" | "URL_DELETED">().notNull(),
    /** pending | sent | failed | expired */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("job_index_notifications_status_idx").on(t.status, t.createdAt),
    index("job_index_notifications_org_idx").on(t.orgId, t.createdAt),
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
  | "followup"
  | "sourcing"
  | "distribution"
  | "screening_call"
  | "scheduling_call";
export type AgentAutonomy = "suggest" | "act_and_notify" | "autonomous";
export type AgentRunStatus =
  "queued" | "running" | "awaiting_human" | "done" | "failed" | "cancelled";
export type AgentTaskKind = "gate" | "approval" | "clarification";
export type AgentTaskStatus =
  "open" | "approved" | "rejected" | "answered" | "expired" | "cancelled";
export type AgentEventStatus = "pending" | "processing" | "done" | "failed";
export type AgentRunMode = "live" | "replay";

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
    /** Run limits per leg (AI turns / tokens between human decisions); null = the agent's default. */
    maxStepsPerLeg: integer("max_steps_per_leg"),
    maxTokensPerLeg: integer("max_tokens_per_leg"),
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

/** Immutable snapshot of each agent manifest version, keyed by content hash. */
export const agentDefinitions = pgTable(
  "agent_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentType: text("agent_type").$type<AgentType>().notNull(),
    version: text("version").notNull(),
    hash: text("hash").notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_definitions_type_hash_key").on(t.agentType, t.hash)],
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
    /** The manifest version this run executed under (agent_definitions). */
    definitionId: uuid("definition_id").references(() => agentDefinitions.id, {
      onDelete: "set null",
    }),
    definitionVersion: text("definition_version"),
    definitionHash: text("definition_hash"),
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
    /** Where the current leg began (a human decision starts a new one; migration 0042). */
    legStepStart: integer("leg_step_start").notNull().default(0),
    legTokenStart: integer("leg_token_start").notNull().default(0),
    traceId: uuid("trace_id").notNull().defaultRandom(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** live | replay — a replay is a dry run of `replayOf`: write, external and human steps are simulated. */
    mode: text("mode").$type<AgentRunMode>().notNull().default("live"),
    replayOf: uuid("replay_of").references((): AnyPgColumn => agentRuns.id, {
      onDelete: "set null",
    }),
    /** When this run's trace was exported to the org's OpenTelemetry endpoint. */
    otelExportedAt: timestamp("otel_exported_at", { withTimezone: true }),
    /** The hiring-desk thread this run works for; its results are posted there. */
    conversationId: uuid("conversation_id").references((): AnyPgColumn => hiringConversations.id, {
      onDelete: "set null",
    }),
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
    /** ok | error | blocked | awaiting | simulated (dry-run replay) */
    status: text("status").notNull(),
    /** Redacted summaries only — never full CV, document or mail text. */
    input: jsonb("input").$type<unknown>(),
    output: jsonb("output").$type<unknown>(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    spanId: uuid("span_id").notNull().defaultRandom(),
    /** act_and_notify: 'pending' until the principal marks the action seen, then 'seen'. */
    notifyState: text("notify_state").$type<"pending" | "seen">(),
    /** Third-party text in this tool result looked like an instruction to the model. */
    injectionSuspected: boolean("injection_suspected").notNull().default(false),
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

/* --------------------------------------------------- agent health (0027) */

export type AgentIssueSeverity = "warning" | "serious" | "critical";
export type AgentIssueStatus = "open" | "acknowledged" | "resolved";

/** A problem the health engine detected for one org × agent × rule, while it lasts. */
export const agentIssues = pgTable(
  "agent_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Agent type, or "*" for organisation-wide (orchestrator) issues. */
    agentType: text("agent_type").notNull(),
    element: text("element").notNull(),
    rule: text("rule").notNull(),
    severity: text("severity").$type<AgentIssueSeverity>().notNull(),
    status: text("status").$type<AgentIssueStatus>().notNull().default("open"),
    title: text("title").notNull(),
    detail: jsonb("detail")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurrences: integer("occurrences").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Alert e-mail / webhook sent for this issue (serious and critical only). */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("agent_issues_active_key")
      .on(t.orgId, t.agentType, t.rule)
      .where(sql`status <> 'resolved'`),
    index("agent_issues_org_status_idx").on(t.orgId, t.status),
  ],
);

/** Scheduler liveness: the last tick and health evaluation (single row, id "agents"). */
export const agentRuntimeHeartbeat = pgTable("agent_runtime_heartbeat", {
  id: text("id").primaryKey(),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
  lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
  lastCounts: jsonb("last_counts")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
});

/* ------------------------------------------- agent telemetry & alerts (0029) */

/**
 * Per-org trace export (OTLP/HTTP JSON to the org's own collector) and alert
 * channels for agent health issues. Header values and the webhook signing
 * secret are encrypted at rest (encryptSecret).
 */
export const agentTelemetrySettings = pgTable("agent_telemetry_settings", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  otlpEnabled: boolean("otlp_enabled").notNull().default(false),
  otlpEndpoint: text("otlp_endpoint"),
  otlpHeadersEnc: text("otlp_headers_enc"),
  alertEmailEnabled: boolean("alert_email_enabled").notNull().default(true),
  alertWebhookUrl: text("alert_webhook_url"),
  alertWebhookSecretEnc: text("alert_webhook_secret_enc"),
  lastExportAt: timestamp("last_export_at", { withTimezone: true }),
  /** Last export attempt (successful or not), for back-off after failures. */
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastExportError: text("last_export_error"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------ hiring desk (0030) */

export type HiringConversationStatus = "gathering" | "confirming" | "active" | "closed";
export type HiringMessageRole = "user" | "desk" | "agent";

/** One chat thread per hiring need (docs/agentic-plan.md §13.2). */
export const hiringConversations = pgTable(
  "hiring_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New hiring need"),
    status: text("status").$type<HiringConversationStatus>().notNull().default("gathering"),
    /** The hiring details gathered so far (role, location, experience, …). */
    slots: jsonb("slots")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    /** An approved JD of this earlier requisition is reused (the person's choice). */
    reuseJdFrom: uuid("reuse_jd_from").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Deleted (hidden) — restorable by an owner for 30 days, then purged (migration 0040). */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),
    deleteReason: text("delete_reason"),
  },
  (t) => [index("hiring_conversations_org_idx").on(t.orgId, t.updatedAt)],
);

/** Messages of a hiring-desk thread; `card` carries structured results. */
export const hiringMessages = pgTable(
  "hiring_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => hiringConversations.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role").$type<HiringMessageRole>().notNull(),
    agentType: text("agent_type"),
    body: text("body").notNull().default(""),
    card: jsonb("card").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hiring_messages_conv_idx").on(t.conversationId, t.createdAt)],
);

/* ------------------------------------------------- agent cost rates (0031) */

/**
 * The organisation's own AI token prices (it brings its own key, so the price
 * is its model's and plan's). Used only for cost estimates on Agent
 * observability; with no row, the app shows tokens and never guesses a price.
 */
export const agentCostRates = pgTable("agent_cost_rates", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  currency: text("currency").notNull().default("USD"),
  inputPerMillion: numeric("input_per_million", { precision: 12, scale: 4 }).notNull(),
  outputPerMillion: numeric("output_per_million", { precision: 12, scale: 4 }).notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------- training data (0036) */

/**
 * Training data for a future HR model (docs/agentic-plan.md §14). Off per
 * organisation until an owner agrees: a customer's candidate data is used to
 * train a model only with that customer's consent (DPDP Act 2023 / GDPR).
 */
export const trainingSettings = pgTable(
  "training_settings",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    consentedBy: uuid("consented_by").references(() => users.id, { onDelete: "set null" }),
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    retentionDays: integer("retention_days").notNull().default(730),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("training_settings_retention_days_check", sql`${t.retentionDays} between 30 and 3650`),
  ],
);

export type TrainingCallKind = "json" | "research" | "agent_step" | "voice";

/** One model call: what it was given and what it returned. */
export const trainingInferences = pgTable(
  "training_inferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    callKind: text("call_kind").$type<TrainingCallKind>().notNull(),
    feature: text("feature").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    request: jsonb("request").notNull(),
    response: jsonb("response"),
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    stopReason: text("stop_reason"),
    grounded: boolean("grounded"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    latencyMs: integer("latency_ms"),
    requestHash: text("request_hash").notNull(),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    candidateId: uuid("candidate_id").references(() => candidates.id, { onDelete: "cascade" }),
    usageEventIds: uuid("usage_event_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("training_inferences_org_created_idx").on(t.orgId, t.createdAt),
    index("training_inferences_run_idx")
      .on(t.agentRunId, t.createdAt)
      .where(sql`${t.agentRunId} is not null`),
    index("training_inferences_feature_idx").on(t.feature, t.createdAt),
    index("training_inferences_application_idx")
      .on(t.applicationId)
      .where(sql`${t.applicationId} is not null`),
    index("training_inferences_candidate_idx")
      .on(t.candidateId)
      .where(sql`${t.candidateId} is not null`),
    index("training_inferences_hash_idx").on(t.requestHash),
  ],
);

export type TrainingActorKind = "human" | "candidate" | "system" | "eval";

/** A human or real-world judgement on AI work (preference and reward data). */
export const trainingFeedback = pgTable(
  "training_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    label: text("label").notNull(),
    rating: integer("rating"),
    reason: text("reason"),
    original: jsonb("original"),
    corrected: jsonb("corrected"),
    inferenceId: uuid("inference_id").references(() => trainingInferences.id, {
      onDelete: "cascade",
    }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    agentTaskId: uuid("agent_task_id").references(() => agentTasks.id, { onDelete: "set null" }),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    candidateId: uuid("candidate_id").references(() => candidates.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorKind: text("actor_kind").$type<TrainingActorKind>().notNull().default("human"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("training_feedback_org_created_idx").on(t.orgId, t.createdAt),
    index("training_feedback_inference_idx")
      .on(t.inferenceId)
      .where(sql`${t.inferenceId} is not null`),
    index("training_feedback_run_idx")
      .on(t.agentRunId)
      .where(sql`${t.agentRunId} is not null`),
    index("training_feedback_application_idx")
      .on(t.applicationId)
      .where(sql`${t.applicationId} is not null`),
    index("training_feedback_source_idx").on(t.source, t.label),
  ],
);

/** An eval scenario's verdict: benchmark and regression data. */
export const trainingEvalResults = pgTable(
  "training_eval_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scenario: text("scenario").notNull(),
    agentType: text("agent_type").notNull(),
    agentVersion: text("agent_version"),
    definitionHash: text("definition_hash"),
    mode: text("mode").notNull(),
    provider: text("provider"),
    model: text("model"),
    passed: boolean("passed").notNull(),
    checks: jsonb("checks").notNull(),
    transcript: jsonb("transcript"),
    tokens: integer("tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("training_eval_results_scenario_idx").on(t.scenario, t.createdAt)],
);

/* ----------------------------------- assessment timeline, agent pop-ups (0037) */

/** Per organisation; defaults apply when there is no row. */
export const assessmentSettings = pgTable(
  "assessment_settings",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    dueWorkingDays: integer("due_working_days").notNull().default(3),
    firstReminderDays: integer("first_reminder_days").notNull().default(2),
    maxReminders: integer("max_reminders").notNull().default(2),
    overdueAfterDays: integer("overdue_after_days").notNull().default(2),
    closeAfterDays: integer("close_after_days").notNull().default(7),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("assessment_settings_due_working_days_check", sql`${t.dueWorkingDays} between 1 and 15`),
    check(
      "assessment_settings_first_reminder_days_check",
      sql`${t.firstReminderDays} between 1 and 14`,
    ),
    check("assessment_settings_max_reminders_check", sql`${t.maxReminders} between 0 and 3`),
    check(
      "assessment_settings_overdue_after_days_check",
      sql`${t.overdueAfterDays} between 0 and 14`,
    ),
    check("assessment_settings_close_after_days_check", sql`${t.closeAfterDays} between 2 and 30`),
  ],
);

/** Per person: an agent pop-up seen, snoozed or dismissed. */
export const notificationStates = pgTable(
  "notification_states",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    notificationId: text("notification_id").notNull(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.notificationId] })],
);

/* ------------------------------------------------ compensation details (0038) */

/** A private form link asking the candidate for compensation and availability. */
export const compensationRequests = pgTable(
  "compensation_requests",
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
    token: text("token").notNull(),
    status: text("status").notNull().default("sent"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    remindersSent: integer("reminders_sent").notNull().default(0),
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("compensation_requests_token_key").on(t.token),
    index("compensation_requests_open_idx")
      .on(t.orgId, t.status, t.dueAt)
      .where(sql`${t.status} = 'sent'`),
    index("compensation_requests_application_idx").on(t.applicationId),
  ],
);

export type CompensationSource = "candidate_form" | "screening_call" | "recruiter";

/** What an offer is built on; the latest row per application is in force. HR roles only. */
export const compensationDetails = pgTable(
  "compensation_details",
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
    currency: text("currency").notNull().default("INR"),
    currentFixed: numeric("current_fixed", { precision: 14, scale: 2 }),
    currentVariable: numeric("current_variable", { precision: 14, scale: 2 }),
    expectedCtc: numeric("expected_ctc", { precision: 14, scale: 2 }),
    noticePeriodDays: integer("notice_period_days"),
    earliestJoining: date("earliest_joining"),
    competingOffers: boolean("competing_offers"),
    competingNote: text("competing_note"),
    currentLocation: text("current_location"),
    openToRelocate: boolean("open_to_relocate"),
    note: text("note"),
    source: text("source").$type<CompensationSource>().notNull(),
    enteredBy: uuid("entered_by").references(() => users.id, { onDelete: "set null" }),
    requestId: uuid("request_id").references(() => compensationRequests.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("compensation_details_application_idx").on(t.applicationId, t.createdAt),
    check(
      "compensation_details_notice_period_days_check",
      sql`${t.noticePeriodDays} between 0 and 365`,
    ),
  ],
);

export type NegotiationStatus =
  | "open"
  | "message_sent"
  | "countered"
  | "call_requested"
  | "agreed"
  | "no_agreement"
  | "expired"
  | "cancelled";

/** What can make an offer work besides base pay. */
export type NegotiationLevers = {
  joiningBonus?: number | null;
  /** A pay review after this many months, written into the letter. */
  reviewMonths?: number | null;
  /** Free text: fixed / variable split, ESOPs, title or scope. */
  other?: string | null;
};

/** Agreeing the figure with a candidate before the offer (migration 0039). HR roles only. */
export const offerNegotiations = pgTable(
  "offer_negotiations",
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
    status: text("status").$type<NegotiationStatus>().notNull().default("open"),
    expectedCtc: numeric("expected_ctc", { precision: 14, scale: 2 }),
    ceiling: numeric("ceiling", { precision: 14, scale: 2 }).notNull(),
    ceilingApprovedBy: text("ceiling_approved_by").$type<"hr_head" | "president_cbo">().notNull(),
    proposedCtc: numeric("proposed_ctc", { precision: 14, scale: 2 }).notNull(),
    levers: jsonb("levers").$type<NegotiationLevers>().notNull().default({}),
    talkTrack: text("talk_track").notNull().default(""),
    message: text("message"),
    token: text("token").unique(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    /** The candidate's answer: { decision: accept | propose | call, amount?, note?, at }. */
    answer: jsonb("answer").$type<{
      decision: "accept" | "propose" | "call";
      amount?: number | null;
      note?: string | null;
      at: string;
    } | null>(),
    /** What was agreed (or not): { agreedCtc?, joiningBonus?, joiningDate?, note?, source, by? }. */
    outcome: jsonb("outcome").$type<{
      agreedCtc?: number | null;
      joiningBonus?: number | null;
      joiningDate?: string | null;
      note?: string | null;
      source: "candidate_link" | "call";
      by?: string | null;
    } | null>(),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("offer_negotiations_app_idx").on(t.applicationId, t.createdAt)],
);

/* ------------------------------------------------------- phone screening */
// docs/voice-screening-agent.md — migration 0046.

/** Per organisation: whether candidates are screened by phone, and how. */
export const phoneScreeningSettings = pgTable(
  "phone_screening_settings",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    /** The name the AI assistant introduces itself with. */
    assistantName: text("assistant_name").notNull().default("Saranya"),
    /** Calling window, minutes after midnight in the organisation's time zone. */
    windowStartMinute: integer("window_start_minute").notNull().default(600),
    windowEndMinute: integer("window_end_minute").notNull().default(1140),
    /** ISO weekdays it calls on (1 = Monday … 7 = Sunday). */
    callDays: integer("call_days")
      .array()
      .notNull()
      .default(sql`'{1,2,3,4,5,6}'`),
    maxAttempts: integer("max_attempts").notNull().default(3),
    maxMinutes: integer("max_minutes").notNull().default(10),
    /** Times a candidate may move the call to another time; then alternatives are offered. */
    maxReschedules: integer("max_reschedules").notNull().default(2),
    /** Scheduling calls (a follow-up to an unanswered interview-time e-mail) switched on. */
    schedulingEnabled: boolean("scheduling_enabled").notNull().default(false),
    /** Hours an e-mailed interview-time offer waits unanswered before a scheduling call. */
    schedulingWaitHours: integer("scheduling_wait_hours").notNull().default(24),
    /** The assistant's voice (one of the voice service's prebuilt voices). */
    voice: text("voice").notNull().default("Kore"),
    /** What the assistant tells candidates happens next (≤ 300 characters). */
    nextStepsText: text("next_steps_text"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "phone_screening_settings_assistant_name_check",
      sql`char_length(${t.assistantName}) between 2 and 40`,
    ),
    check(
      "phone_screening_settings_window_start_minute_check",
      sql`${t.windowStartMinute} between 0 and 1439`,
    ),
    check(
      "phone_screening_settings_window_end_minute_check",
      sql`${t.windowEndMinute} between 1 and 1440`,
    ),
    check(
      "phone_screening_settings_window_check",
      sql`${t.windowEndMinute} > ${t.windowStartMinute}`,
    ),
    check("phone_screening_settings_max_attempts_check", sql`${t.maxAttempts} between 1 and 5`),
    check("phone_screening_settings_max_minutes_check", sql`${t.maxMinutes} between 5 and 30`),
    check(
      "phone_screening_settings_scheduling_wait_check",
      sql`${t.schedulingWaitHours} between 2 and 96`,
    ),
    check(
      "phone_screening_settings_max_reschedules_check",
      sql`${t.maxReschedules} between 0 and 5`,
    ),
    check(
      "phone_screening_settings_next_steps_check",
      sql`${t.nextStepsText} is null or char_length(${t.nextStepsText}) <= 300`,
    ),
  ],
);

export const SCREENING_CALL_STATUSES = [
  "requested",
  "approved",
  "dialling",
  "in_progress",
  "completed",
  "callback",
  "no_answer",
  "failed",
  "consent_declined",
  "cancelled",
  "fell_back",
] as const;
export type ScreeningCallStatus = (typeof SCREENING_CALL_STATUSES)[number];

/** One line of a call transcript. */
export type ScreeningCallTurn = {
  who: "caller" | "ai";
  text: string;
  at: string;
  interrupted?: boolean;
};

/** Practical details the candidate gave on the call (pay is kept elsewhere, HR-only). */
export type ScreeningCallDetails = {
  currentTitle?: string;
  currentCompany?: string;
  totalExperienceYears?: number;
  currentLocation?: string;
  openToRelocate?: boolean;
  noticePeriodDays?: number;
  earliestJoining?: string;
  /** Anything else the candidate said the hiring team should know, in their words. */
  note?: string;
};

/** What the candidate said for one kit question, as the call agent recorded it. */
export type VoiceCallPurpose = "screening" | "scheduling";

export type ScreeningCallAnswer = {
  question_id: string;
  summary: string;
  at: string;
  /** The candidate chose not to answer (asked, never graded). */
  declined?: boolean;
};

/**
 * One phone screening of one application by the Screening call agent. The
 * number is never copied here (read from the candidate when dialling); the
 * transcript is kept only once the candidate consented.
 */
export const screeningCalls = pgTable(
  "screening_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    requisitionId: uuid("requisition_id").references(() => requisitions.id, {
      onDelete: "set null",
    }),
    kitId: uuid("kit_id").references(() => screeningKits.id, { onDelete: "set null" }),
    /** The Screening agent run that asked for the call. */
    requestedRunId: uuid("requested_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    /** The call's own run (Screening call agent). */
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    status: text("status").$type<ScreeningCallStatus>().notNull().default("requested"),
    attempt: integer("attempt").notNull().default(0),
    /** The candidate agreed this time on an earlier call (an expected call, not a cold one). */
    bookedByCandidate: boolean("booked_by_candidate").notNull().default(false),
    /** Times the candidate moved this call to another time. */
    reschedules: integer("reschedules").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }),
    callbackAt: timestamp("callback_at", { withTimezone: true }),
    phoneLast4: text("phone_last4"),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    /** What the candidate said when agreeing or declining, as the assistant heard it. */
    consentWords: text("consent_words"),
    language: text("language"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"),
    durationS: integer("duration_s"),
    transcript: jsonb("transcript")
      .$type<ScreeningCallTurn[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    answers: jsonb("answers")
      .$type<ScreeningCallAnswer[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Current role, experience, location, availability as said on the call — never pay. */
    details: jsonb("details")
      .$type<ScreeningCallDetails>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    screeningRunId: uuid("screening_run_id").references(() => screeningRuns.id, {
      onDelete: "set null",
    }),
    /** screening = the AI screening call; scheduling = a call to pick an interview time. */
    purpose: text("purpose").$type<VoiceCallPurpose>().notNull().default("screening"),
    /** Scheduling: the e-mailed interview-time offer this call follows up. */
    slotOfferId: uuid("slot_offer_id").references(() => interviewSlotOffers.id, {
      onDelete: "set null",
    }),
    /** Scheduling: up to three extra start times (ISO) checked free when the call was asked for. */
    alternates: jsonb("alternates")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "screening_calls_status_check",
      sql`${t.status} in ('requested', 'approved', 'dialling', 'in_progress', 'completed', 'callback', 'no_answer', 'failed', 'consent_declined', 'cancelled', 'fell_back')`,
    ),
    index("screening_calls_due_idx").on(t.orgId, t.status, t.dueAt),
    index("screening_calls_application_idx").on(t.applicationId, t.createdAt),
    index("screening_calls_candidate_idx").on(t.candidateId),
    index("screening_calls_slot_offer_idx").on(t.slotOfferId),
    check("screening_calls_purpose_check", sql`${t.purpose} in ('screening', 'scheduling')`),
    check(
      "screening_calls_alternates_check",
      sql`jsonb_typeof(${t.alternates}) = 'array' and jsonb_array_length(${t.alternates}) <= 3`,
    ),
    check(
      "screening_calls_scheduling_offer_check",
      sql`${t.purpose} <> 'scheduling' or ${t.slotOfferId} is not null`,
    ),
  ],
);

/**
 * The voice worker's heartbeat (one row per worker process). The web app treats
 * a recent beat as "a phone line is available", so only the worker holds the
 * PBX credentials.
 */
export const voiceWorkerHeartbeat = pgTable("voice_worker_heartbeat", {
  workerId: text("worker_id").primaryKey(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  maxConcurrent: integer("max_concurrent").notNull().default(1),
  callsInProgress: integer("calls_in_progress").notNull().default(0),
});

/* --------------------------------------------- service SLOs (0053) */

/**
 * Per-minute request SLI counts, one row per app instance and route group
 * (src/server/http-metrics.ts → src/server/slo.server.ts). Low-cardinality by
 * design: no paths, ids, orgs or users. Kept 35 days.
 */
export const serviceRequestMinutes = pgTable(
  "service_request_minutes",
  {
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    instanceId: text("instance_id").notNull(),
    /** server_fn | page | api_public | api_auth */
    routeGroup: text("route_group").notNull(),
    requests: integer("requests").notNull().default(0),
    /** Answered with a 5xx status. */
    errors: integer("errors").notNull().default(0),
    /** Slower than LATENCY_THRESHOLD_MS (src/server/slo.ts). */
    slow: integer("slow").notNull().default(0),
    /** Non-cumulative counts per DURATION_BUCKETS bound, last entry +Inf. */
    latency: integer("latency")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
  },
  (t) => [
    primaryKey({ columns: [t.minute, t.instanceId, t.routeGroup] }),
    index("service_request_minutes_minute_idx").on(t.minute),
  ],
);

/** Burn-rate alerts on the platform SLOs (src/server/slo.ts); one open row per SLO. */
export const sloAlerts = pgTable(
  "slo_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slo: text("slo").notNull(),
    /** serious | critical */
    severity: text("severity").notNull(),
    /** open | resolved */
    status: text("status").notNull().default("open"),
    burnRate: doublePrecision("burn_rate").notNull(),
    windowMinutes: integer("window_minutes").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** When this severity was last pushed to the alert channels. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("slo_alerts_open_uq")
      .on(t.slo)
      .where(sql`status = 'open'`),
    index("slo_alerts_opened_idx").on(t.openedAt),
  ],
);

/**
 * The organisation profile (docs/org-context-agent-plan.md): numbered
 * versions written by a person (later the Organisation context agent) and
 * approved by the HR head or the owner. Approved versions never change.
 * Items never hold pay figures or staff names (refused in code).
 */
export type OrgProfileItemRow = {
  id: string;
  text: string;
  /** candidate: may be said to or written for candidates; internal: agents' internal work only. */
  visibility: "candidate" | "internal";
  /** Where it came from: a person typed it (O0), the website or a document (later). */
  source: {
    kind: "person" | "website" | "document" | "conversation";
    ref?: string;
    quote?: string;
  };
};
export type OrgProfileVersionStatus =
  "draft" | "pending" | "changes_requested" | "approved" | "declined" | "superseded";

export const orgProfileVersions = pgTable(
  "org_profile_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").$type<OrgProfileVersionStatus>().notNull().default("draft"),
    /** { [sectionKey]: OrgProfileItemRow[] } */
    sections: jsonb("sections")
      .$type<Record<string, OrgProfileItemRow[]>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    injectionFlagged: boolean("injection_flagged").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    submittedBy: uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
  },
  (t) => [
    check(
      "org_profile_versions_status_check",
      sql`${t.status} in ('draft', 'pending', 'changes_requested', 'approved', 'declined', 'superseded')`,
    ),
    uniqueIndex("org_profile_versions_org_version_key").on(t.orgId, t.version),
    uniqueIndex("org_profile_versions_one_open_key")
      .on(t.orgId)
      .where(sql`${t.status} in ('draft', 'pending', 'changes_requested')`),
  ],
);

/** One row per organisation: the approved version agents read, and the hard gate. */
export const orgProfiles = pgTable("org_profiles", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  currentVersionId: uuid("current_version_id").references(() => orgProfileVersions.id, {
    onDelete: "set null",
  }),
  /** No requisition is raised until a version is approved. */
  requireProfile: boolean("require_profile").notNull().default(false),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
