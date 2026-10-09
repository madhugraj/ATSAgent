# ATSIQ — Entity-Relationship Diagram

> **Generated file — do not edit by hand.** Source of truth: `drizzle/schema.ts`.
> Regenerate after any schema change: `node scripts/gen-er-diagram.mjs`.
>
> Conventions: attribute keys — `PK` primary key, `FK` foreign key, `UK` unique.
> Unmarked single columns are nullable (noted explicitly). Relationship labels name
> the foreign-key column and call out non-default delete behaviour (e.g. `cascade`).
> A domain diagram shows that domain's tables in full; references into other domains
> point at a stub entity that is drawn complete in its own domain.

72 tables across 9 domains.

## Identity & access

`users`, `sessions`, `audit_log`, `user_roles`, `platform_admins`

```mermaid
erDiagram
  users {
    uuid id PK
    text email UK
    timestamptz email_confirmed_at "nullable"
    text password_hash "nullable"
    text full_name "nullable"
    text avatar_url "nullable"
    timestamptz created_at
    timestamptz last_login_at "nullable"
  }
  sessions {
    uuid id PK
    uuid user_id FK
    text token_hash UK
    timestamptz expires_at
    timestamptz created_at
    timestamptz last_used_at
    text user_agent "nullable"
    text ip "nullable"
  }
  audit_log {
    uuid id PK
    uuid org_id "nullable"
    uuid actor_user_id "nullable"
    text actor
    text action
    text entity_type "nullable"
    uuid entity_id "nullable"
    jsonb detail "nullable"
    text ip "nullable"
    timestamptz created_at
  }
  user_roles {
    uuid id PK
    uuid org_id FK
    uuid user_id FK
    appRoleEnum role
  }
  platform_admins {
    uuid id PK
    text email UK
    uuid user_id "nullable"
    text note "nullable"
    uuid created_by "nullable"
    timestamptz created_at
  }

  sessions }o--|| users : "user_id · cascade"
  user_roles }o--o| organizations : "org_id · cascade"
  user_roles }o--|| users : "user_id · cascade"
```

## Organisations & masters

`organizations`, `org_members`, `departments`, `master_items`, `org_linkedin_connections`, `product_catalogue_commercials`, `org_pool_shares`

```mermaid
erDiagram
  organizations {
    uuid id PK
    text name
    text slug UK
    text email_domain "nullable"
    text inbox_slug "nullable"
    text legal_name "nullable"
    text industry "nullable"
    text hq_country "nullable"
    text hq_city "nullable"
    text employee_band "nullable"
    text currency
    smallint fiscal_year_start_month
    text careers_email "nullable"
    text onboarding_step
    timestamptz onboarded_at "nullable"
    uuid created_by "nullable"
    timestamptz created_at
    text status
    timestamptz archived_at "nullable"
    text archived_reason "nullable"
    timestamptz approved_at "nullable"
    uuid approved_by "nullable"
    timestamptz rejected_at "nullable"
    text rejection_reason "nullable"
    text capture_token UK "nullable"
    text capture_token_hash UK "nullable"
  }
  org_members {
    uuid id PK
    uuid org_id FK
    uuid user_id FK
    text email
    text full_name "nullable"
    text title "nullable"
    text status
    boolean is_owner
    appRoleEnum invited_role "nullable"
    uuid invited_by "nullable"
    timestamptz created_at
    timestamptz joined_at "nullable"
  }
  departments {
    uuid id PK
    uuid org_id FK
    text name
    text head_name "nullable"
    integer budgeted_headcount
    numeric budgeted_cost
    text period
    timestamptz created_at
  }
  master_items {
    uuid id PK
    uuid org_id FK
    text kind
    text name
    text category "nullable"
    integer sort_order
    boolean active
    timestamptz created_at
  }
  org_linkedin_connections {
    uuid org_id PK,FK
    text member_sub
    text member_name "nullable"
    text member_email "nullable"
    text access_token
    text refresh_token "nullable"
    timestamptz expires_at "nullable"
    text scope "nullable"
    uuid connected_by "nullable"
    timestamptz connected_at
    timestamptz updated_at
  }
  product_catalogue_commercials {
    text module_id PK
    text tier "nullable"
    numeric list_price "nullable"
    text currency
    text unit "nullable"
    text notes "nullable"
    timestamptz updated_at
    uuid updated_by "nullable"
  }
  org_pool_shares {
    uuid id PK
    uuid owner_org FK
    uuid partner_org FK
    text status
    text scope "nullable"
    uuid requested_by "nullable"
    uuid responded_by "nullable"
    timestamptz created_at
    timestamptz responded_at "nullable"
    timestamptz revoked_at "nullable"
  }

  org_members }o--|| organizations : "org_id · cascade"
  org_members }o--o| users : "user_id · cascade"
  departments }o--o| organizations : "org_id · cascade"
  master_items }o--o| organizations : "org_id · cascade"
  org_linkedin_connections }o--|| organizations : "org_id · cascade"
  org_pool_shares }o--|| organizations : "owner_org · cascade"
  org_pool_shares }o--|| organizations : "partner_org · cascade"
```

## Requisitions & job content

`requisitions`, `job_descriptions`, `content_templates`

```mermaid
erDiagram
  requisitions {
    uuid id PK
    uuid org_id FK
    text code
    text title
    uuid department_id FK
    reqTypeEnum req_type
    reqStatusEnum status
    text location "nullable"
    integer openings
    integer experience_min
    integer experience_max
    numeric budget_ctc
    text hiring_manager "nullable"
    text must_have_skills
    text good_to_have_skills
    text responsibilities "nullable"
    text education_requirement "nullable"
    integer weight_skills
    integer weight_experience
    integer weight_career
    integer weight_impact
    integer weight_education
    integer weight_social
    jsonb approval_trail
    uuid created_by FK
    timestamptz opened_at
    timestamptz created_at
    text billing_type
    text engagement_type
    text client_name "nullable"
    text cost_center "nullable"
    boolean ijp_enabled
    timestamptz ijp_posted_at "nullable"
    text ijp_notes "nullable"
    numeric ctc_band_min "nullable"
    numeric ctc_band_max "nullable"
    text career_level "nullable"
    jsonb job_card_overrides
    integer max_notice_period_days "nullable"
    text work_authorization_required "nullable"
  }
  job_descriptions {
    uuid id PK
    uuid requisition_id FK
    uuid org_id FK
    integer version
    jdStatusEnum status
    text purpose "nullable"
    text responsibilities "nullable"
    text must_have
    text good_to_have
    text qualifications "nullable"
    text success_factors "nullable"
    text reporting_to "nullable"
    text full_text "nullable"
    text approver_comment "nullable"
    uuid template_id "nullable"
    text template_name "nullable"
    timestamptz created_at
  }
  content_templates {
    uuid id PK
    uuid org_id FK
    text kind
    text name
    boolean is_default
    jsonb config
    text instructions "nullable"
    text logo_path "nullable"
    text logo_content_type "nullable"
    text background_path "nullable"
    text background_content_type "nullable"
    text source_path "nullable"
    text source_name "nullable"
    text source_content_type "nullable"
    timestamptz created_at
    timestamptz updated_at
  }

  requisitions }o--o| organizations : "org_id · cascade"
  requisitions }o--o| departments : "department_id"
  requisitions }o--o| users : "created_by"
  job_descriptions }o--|| requisitions : "requisition_id · cascade"
  job_descriptions }o--o| organizations : "org_id · cascade"
  content_templates }o--|| organizations : "org_id · cascade"
```

## Candidates & pipeline

`candidates`, `applications`, `stage_events`, `match_scores`, `social_profiles`, `evaluations`, `candidate_verifications`, `candidate_assessments`, `candidate_ownership_events`, `candidate_referrals`, `talent_requests`, `talent_request_suggestions`, `candidate_notes`

```mermaid
erDiagram
  candidates {
    uuid id PK
    uuid org_id FK
    text full_name
    text email
    text phone "nullable"
    text location "nullable"
    text source
    numeric experience_years
    numeric current_ctc "nullable"
    numeric expected_ctc "nullable"
    integer notice_period_days "nullable"
    text education "nullable"
    text skills
    text resume_text "nullable"
    text linkedin_url "nullable"
    text github_url "nullable"
    text website_url "nullable"
    text x_url "nullable"
    boolean consent_given
    timestamptz created_at
    timestamptz role_match_checked_at "nullable"
    text external_id "nullable"
    text external_provider "nullable"
    text resume_file_path "nullable"
    uuid owner_id "nullable"
    uuid added_by "nullable"
    boolean is_internal
    text employee_id "nullable"
    text current_department "nullable"
    boolean manager_endorsed
    timestamptz last_synced_at "nullable"
    text sync_status
    text current_employer "nullable"
    text work_authorization "nullable"
    boolean willing_to_relocate "nullable"
    text preferred_locations
    boolean suspected_prompt_injection
    text referral_source "nullable"
    jsonb employment_history
    jsonb career_metrics "nullable"
  }
  applications {
    uuid id PK
    uuid requisition_id FK
    uuid candidate_id FK
    uuid org_id FK
    appStageEnum stage
    text source
    timestamptz applied_at
    timestamptz last_activity_at
    text stage_reason "nullable"
    text stage_note "nullable"
  }
  stage_events {
    uuid id PK
    uuid application_id FK
    uuid org_id FK
    appStageEnum from_stage "nullable"
    appStageEnum to_stage
    text actor "nullable"
    text reason "nullable"
    text note "nullable"
    timestamptz created_at
  }
  match_scores {
    uuid id PK
    uuid application_id FK
    uuid org_id FK
    integer skills_score
    integer experience_score
    integer career_score
    integer impact_score
    integer innovation_score
    integer education_score
    integer social_score
    integer overall_score
    jsonb weights
    text matched_skills
    text missing_skills
    text rationale "nullable"
    text risk_flags
    recommendationEnum recommendation "nullable"
    text model "nullable"
    recommendationEnum recruiter_override "nullable"
    text override_reason "nullable"
    timestamptz computed_at
    jsonb career_metrics "nullable"
    text career_flags
    text logistics_flags
    text impact_highlights
    text innovation_signals
  }
  social_profiles {
    uuid id PK
    uuid candidate_id FK
    uuid org_id FK
    text provider
    text profile_url "nullable"
    text handle "nullable"
    integer score
    jsonb signals
    text rationale "nullable"
    jsonb raw "nullable"
    text status
    timestamptz fetched_at
    timestamptz last_synced_at "nullable"
  }
  evaluations {
    uuid id PK
    uuid application_id FK
    uuid org_id FK
    integer level
    text evaluator "nullable"
    text focus_area "nullable"
    integer rating "nullable"
    text comments "nullable"
    recommendationEnum recommendation
    timestamptz created_at
    uuid interview_id FK
    jsonb competencies
    text submitted_by "nullable"
    timestamptz submitted_at "nullable"
    text evaluator_email "nullable"
  }
  candidate_verifications {
    uuid id PK
    uuid candidate_id FK
    uuid org_id FK
    integer authenticity_score
    jsonb claims
    text red_flags
    jsonb evidence
    text summary "nullable"
    text model "nullable"
    text status
    timestamptz created_at
  }
  candidate_assessments {
    uuid id PK
    uuid candidate_id FK
    uuid requisition_id FK
    uuid org_id FK
    text token UK
    text status
    jsonb questions
    jsonb answers
    integer mindset_score "nullable"
    jsonb dimensions "nullable"
    text red_flags
    text strengths
    text summary "nullable"
    text model "nullable"
    timestamptz created_at
    timestamptz completed_at "nullable"
  }
  candidate_ownership_events {
    uuid id PK
    uuid org_id FK
    uuid candidate_id FK
    uuid from_owner "nullable"
    uuid to_owner "nullable"
    uuid actor "nullable"
    text reason "nullable"
    timestamptz created_at
  }
  candidate_referrals {
    uuid id PK
    uuid org_id FK
    uuid candidate_id FK
    uuid requisition_id FK
    uuid from_user
    uuid to_user
    text note "nullable"
    text status
    text response_note "nullable"
    timestamptz created_at
    timestamptz responded_at "nullable"
  }
  talent_requests {
    uuid id PK
    uuid org_id FK
    uuid requisition_id FK
    uuid requester_id
    text title
    text skills
    text note "nullable"
    text status
    timestamptz created_at
    timestamptz closed_at "nullable"
  }
  talent_request_suggestions {
    uuid id PK
    uuid org_id FK
    uuid request_id FK
    uuid candidate_id FK
    uuid suggested_by
    text note "nullable"
    text status
    timestamptz created_at
  }
  candidate_notes {
    uuid id PK
    uuid org_id FK
    uuid candidate_id FK
    uuid author_id
    text author_name "nullable"
    text body
    uuid mentions
    timestamptz created_at
  }

  candidates }o--o| organizations : "org_id · cascade"
  applications }o--|| requisitions : "requisition_id · cascade"
  applications }o--|| candidates : "candidate_id · cascade"
  applications }o--o| organizations : "org_id · cascade"
  stage_events }o--|| applications : "application_id · cascade"
  stage_events }o--o| organizations : "org_id · cascade"
  match_scores }o--|| applications : "application_id · cascade"
  match_scores }o--o| organizations : "org_id · cascade"
  social_profiles }o--|| candidates : "candidate_id · cascade"
  social_profiles }o--o| organizations : "org_id · cascade"
  evaluations }o--|| applications : "application_id · cascade"
  evaluations }o--o| organizations : "org_id · cascade"
  evaluations }o--o| interviews : "interview_id"
  candidate_verifications }o--|| candidates : "candidate_id · cascade"
  candidate_verifications }o--o| organizations : "org_id · cascade"
  candidate_assessments }o--|| candidates : "candidate_id · cascade"
  candidate_assessments }o--o| requisitions : "requisition_id"
  candidate_assessments }o--o| organizations : "org_id · cascade"
  candidate_ownership_events }o--o| organizations : "org_id"
  candidate_ownership_events }o--|| candidates : "candidate_id · cascade"
  candidate_referrals }o--o| organizations : "org_id"
  candidate_referrals }o--|| candidates : "candidate_id · cascade"
  candidate_referrals }o--o| requisitions : "requisition_id"
  talent_requests }o--|| organizations : "org_id"
  talent_requests }o--o| requisitions : "requisition_id"
  talent_request_suggestions }o--|| organizations : "org_id"
  talent_request_suggestions }o--|| talent_requests : "request_id · cascade"
  talent_request_suggestions }o--|| candidates : "candidate_id · cascade"
  candidate_notes }o--o| organizations : "org_id · cascade"
  candidate_notes }o--|| candidates : "candidate_id · cascade"
```

## Screening & interviews

`ai_interviews`, `interviews`, `screening_kits`, `screening_runs`, `screening_prep_jobs`

```mermaid
erDiagram
  ai_interviews {
    uuid id PK
    uuid application_id FK
    uuid org_id FK
    integer jd_match_score
    integer skillset_score
    jsonb transcript
    text summary "nullable"
    timestamptz created_at
  }
  interviews {
    uuid id PK
    uuid application_id FK
    uuid org_id FK
    integer level
    text interviewer "nullable"
    timestamptz scheduled_at "nullable"
    text teams_link "nullable"
    text status
    timestamptz created_at
    text interviewer_email "nullable"
    integer duration_mins
    text mode
    text agenda "nullable"
    jsonb panel
    text outcome_note "nullable"
    timestamptz completed_at "nullable"
  }
  screening_kits {
    uuid id PK
    uuid org_id FK
    uuid candidate_id FK
    uuid requisition_id FK
    uuid application_id FK
    jsonb questions
    text focus_summary "nullable"
    jsonb engine
    uuid created_by "nullable"
    timestamptz created_at
    timestamptz updated_at
  }
  screening_runs {
    uuid id PK
    uuid org_id FK
    uuid kit_id FK
    uuid candidate_id FK
    uuid requisition_id FK
    uuid application_id FK
    text input_kind
    jsonb answers
    text transcript "nullable"
    text audio_path "nullable"
    text audio_engine "nullable"
    integer screening_score
    integer match_score "nullable"
    integer combined_score "nullable"
    jsonb verdicts
    text red_flags
    text rationale "nullable"
    text recommendation "nullable"
    text recommendation_reason "nullable"
    jsonb engine
    uuid created_by "nullable"
    timestamptz created_at
  }
  screening_prep_jobs {
    uuid id PK
    uuid org_id FK
    uuid application_id FK,UK
    uuid candidate_id FK
    uuid requisition_id FK
    text status
    integer attempts
    text last_error "nullable"
    timestamptz created_at
    timestamptz updated_at
  }

  ai_interviews }o--|| applications : "application_id · cascade"
  ai_interviews }o--o| organizations : "org_id · cascade"
  interviews }o--|| applications : "application_id · cascade"
  interviews }o--o| organizations : "org_id · cascade"
  screening_kits }o--o| organizations : "org_id · cascade"
  screening_kits }o--|| candidates : "candidate_id · cascade"
  screening_kits }o--o| requisitions : "requisition_id"
  screening_kits }o--o| applications : "application_id"
  screening_runs }o--o| organizations : "org_id · cascade"
  screening_runs }o--|| screening_kits : "kit_id · cascade"
  screening_runs }o--|| candidates : "candidate_id · cascade"
  screening_runs }o--o| requisitions : "requisition_id"
  screening_runs }o--o| applications : "application_id"
  screening_prep_jobs }o--o| organizations : "org_id · cascade"
  screening_prep_jobs }o--|| applications : "application_id · cascade"
  screening_prep_jobs }o--|| candidates : "candidate_id · cascade"
  screening_prep_jobs }o--|| requisitions : "requisition_id · cascade"
```

## Offers & onboarding

`offers`, `hr_incentive_schemes`, `onboarding_documents`

```mermaid
erDiagram
  offers {
    uuid id PK
    uuid application_id FK
    uuid org_id FK
    numeric offered_ctc
    date joining_date "nullable"
    offerStatusEnum status
    jsonb approval_trail
    jsonb letter "nullable"
    uuid letter_template_id "nullable"
    timestamptz created_at
  }
  hr_incentive_schemes {
    uuid org_id PK,FK
    text currency
    integer target_closures_per_month
    numeric payout_per_closure
    jsonb quality_bands
    numeric monthly_cap "nullable"
    text notes "nullable"
    uuid updated_by "nullable"
    timestamptz updated_at
  }
  onboarding_documents {
    uuid id PK
    uuid org_id FK
    uuid application_id FK
    uuid candidate_id FK
    uuid offer_id FK
    text doc_type
    text file_name
    text file_path "nullable"
    integer file_bytes "nullable"
    text content_type "nullable"
    text source
    uuid inbox_message_id "nullable"
    text extracted_text "nullable"
    jsonb extracted "nullable"
    text extraction_status
    text extraction_note "nullable"
    text model "nullable"
    text status
    text review_note "nullable"
    uuid reviewed_by "nullable"
    timestamptz reviewed_at "nullable"
    uuid uploaded_by "nullable"
    timestamptz created_at
  }

  offers }o--|| applications : "application_id · cascade"
  offers }o--o| organizations : "org_id · cascade"
  hr_incentive_schemes }o--|| organizations : "org_id · cascade"
  onboarding_documents }o--|| organizations : "org_id · cascade"
  onboarding_documents }o--|| applications : "application_id · cascade"
  onboarding_documents }o--|| candidates : "candidate_id · cascade"
  onboarding_documents }o--o| offers : "offer_id"
```

## Sourcing & integrations

`source_integrations`, `integration_credentials`, `capture_events`, `inbox_messages`

```mermaid
erDiagram
  source_integrations {
    uuid id PK
    uuid org_id FK
    text provider
    text label
    boolean enabled
    text category
    jsonb config
    text credential_fields
    boolean has_credentials
    text last_test_status
    text last_test_message "nullable"
    timestamptz last_tested_at "nullable"
    text webhook_token "nullable"
    text webhook_token_hash "nullable"
    timestamptz webhook_configured_at "nullable"
    timestamptz updated_at
    timestamptz created_at
  }
  integration_credentials {
    uuid integration_id PK,FK
    uuid org_id FK
    jsonb secrets
    timestamptz updated_at
  }
  capture_events {
    uuid id PK
    uuid org_id FK
    text kind
    text source_url "nullable"
    text title "nullable"
    text status
    text detail "nullable"
    uuid candidate_id FK
    uuid requisition_id FK
    timestamptz created_at
  }
  inbox_messages {
    uuid id PK
    uuid org_id FK
    text to_address "nullable"
    text from_email "nullable"
    text from_name "nullable"
    text subject "nullable"
    text body "nullable"
    text attachment_name "nullable"
    integer attachment_bytes "nullable"
    text status
    text detail "nullable"
    uuid candidate_id "nullable"
    uuid requisition_id "nullable"
    text provider_message_id "nullable"
    timestamptz received_at
    timestamptz created_at
  }

  source_integrations }o--o| organizations : "org_id · cascade"
  integration_credentials }o--|| source_integrations : "integration_id · cascade"
  integration_credentials }o--o| organizations : "org_id · cascade"
  capture_events }o--|| organizations : "org_id · cascade"
  capture_events }o--o| candidates : "candidate_id"
  capture_events }o--o| requisitions : "requisition_id"
  inbox_messages }o--|| organizations : "org_id · cascade"
```

## Intelligence

`salary_benchmarks`, `copilot_messages`, `skill_nodes`, `skill_edges`, `skill_evidence`, `ontology_snapshots`, `comp_knowledge`

```mermaid
erDiagram
  salary_benchmarks {
    uuid id PK
    uuid org_id FK
    uuid requisition_id FK
    text input_key
    text title
    text location "nullable"
    integer experience_min
    integer experience_max
    text currency
    boolean grounded
    text confidence
    jsonb payload
    text provider
    text model
    timestamptz created_at
  }
  copilot_messages {
    uuid id PK
    uuid org_id FK
    uuid user_id
    text role
    text content
    timestamptz created_at
  }
  skill_nodes {
    uuid id PK
    uuid org_id FK
    text slug
    text name
    text category
    text aliases
    text parent_slug "nullable"
    integer supply
    integer demand
    integer validated
    integer evidence_count
    text status
    timestamptz first_seen_at
    timestamptz last_seen_at
    timestamptz updated_at
  }
  skill_edges {
    uuid id PK
    uuid org_id FK
    text from_slug
    text to_slug
    text kind
    numeric weight
    integer evidence_count
    timestamptz updated_at
  }
  skill_evidence {
    uuid id PK
    uuid org_id FK
    text slug
    uuid candidate_id FK
    uuid requisition_id FK
    text source
    numeric strength
    timestamptz observed_at
    timestamptz created_at
  }
  ontology_snapshots {
    uuid id PK
    uuid org_id FK
    integer node_count
    integer edge_count
    text added
    text grown
    text dormant
    text retired
    jsonb stats
    text model "nullable"
    timestamptz created_at
  }
  comp_knowledge {
    uuid id PK
    uuid org_id FK
    uuid requisition_id FK
    text role_key
    text title
    text location "nullable"
    text level_key
    text currency
    numeric low "nullable"
    numeric median
    numeric high "nullable"
    integer experience_min "nullable"
    integer experience_max "nullable"
    text source
    text note "nullable"
    uuid created_by "nullable"
    timestamptz created_at
  }

  salary_benchmarks }o--|| organizations : "org_id · cascade"
  salary_benchmarks }o--o| requisitions : "requisition_id"
  copilot_messages }o--o| organizations : "org_id · cascade"
  skill_nodes }o--|| organizations : "org_id · cascade"
  skill_edges }o--|| organizations : "org_id · cascade"
  skill_evidence }o--|| organizations : "org_id · cascade"
  skill_evidence }o--o| candidates : "candidate_id · cascade"
  skill_evidence }o--o| requisitions : "requisition_id · cascade"
  ontology_snapshots }o--|| organizations : "org_id · cascade"
  comp_knowledge }o--|| organizations : "org_id · cascade"
  comp_knowledge }o--o| requisitions : "requisition_id"
```

## Communications & AI settings

`ai_settings`, `ai_provider_credentials`, `ai_usage_events`, `email_outbox`, `email_settings`

```mermaid
erDiagram
  ai_settings {
    uuid id PK
    boolean singleton
    uuid org_id FK,UK
    text provider
    text model
    text last_test_status
    text last_test_message "nullable"
    timestamptz last_tested_at "nullable"
    timestamptz updated_at
  }
  ai_provider_credentials {
    uuid org_id FK
    text provider
    text api_key
    timestamptz updated_at
  }
  ai_usage_events {
    uuid id PK
    uuid org_id FK
    uuid user_id FK
    text feature
    text provider
    text model
    text status
    integer prompt_tokens
    integer completion_tokens
    integer total_tokens
    integer attempt
    integer duration_ms "nullable"
    boolean grounded "nullable"
    text error_message "nullable"
    uuid agent_run_id "nullable"
    timestamptz created_at
  }
  email_outbox {
    uuid id PK
    uuid org_id FK
    uuid application_id FK
    text kind
    text template_name
    text to_email
    text reply_to "nullable"
    jsonb template_data
    jsonb attachments
    text idempotency_key UK
    text status
    integer attempts
    text last_error "nullable"
    timestamptz available_at
    timestamptz sent_at "nullable"
    timestamptz created_at
  }
  email_settings {
    uuid id PK
    boolean singleton
    uuid org_id FK,UK
    boolean enabled
    boolean ack_enabled
    boolean stage_enabled
    boolean interview_enabled
    boolean offer_enabled
    text reply_to "nullable"
    text timezone
    timestamptz updated_at
  }

  ai_settings }o--o| organizations : "org_id · cascade"
  ai_provider_credentials }o--|| organizations : "org_id · cascade"
  ai_usage_events }o--o| organizations : "org_id · cascade"
  ai_usage_events }o--o| users : "user_id"
  email_outbox }o--|| organizations : "org_id · cascade"
  email_outbox }o--o| applications : "application_id · cascade"
  email_settings }o--o| organizations : "org_id · cascade"
```

## All foreign-key relationships

| From (child) | Column | To (parent) | ON DELETE |
|---|---|---|---|
| `agent_cost_rates` | `org_id` | `organizations` | cascade |
| `agent_cost_rates` | `updated_by` | `users` | no action |
| `agent_events` | `actor_user_id` | `users` | no action |
| `agent_events` | `org_id` | `organizations` | cascade |
| `agent_issues` | `acknowledged_by` | `users` | no action |
| `agent_issues` | `org_id` | `organizations` | cascade |
| `agent_metrics_daily` | `org_id` | `organizations` | cascade |
| `agent_policies` | `org_id` | `organizations` | cascade |
| `agent_policies` | `updated_by` | `users` | no action |
| `agent_runs` | `definition_id` | `agent_definitions` | no action |
| `agent_runs` | `org_id` | `organizations` | cascade |
| `agent_runs` | `principal_user_id` | `users` | cascade |
| `agent_runs` | `trigger_event_id` | `agent_events` | no action |
| `agent_steps` | `org_id` | `organizations` | cascade |
| `agent_steps` | `run_id` | `agent_runs` | cascade |
| `agent_tasks` | `assignee_user_id` | `users` | no action |
| `agent_tasks` | `decided_by` | `users` | no action |
| `agent_tasks` | `org_id` | `organizations` | cascade |
| `agent_tasks` | `run_id` | `agent_runs` | cascade |
| `agent_telemetry_settings` | `org_id` | `organizations` | cascade |
| `agent_telemetry_settings` | `updated_by` | `users` | no action |
| `ai_interviews` | `application_id` | `applications` | cascade |
| `ai_interviews` | `org_id` | `organizations` | cascade |
| `ai_provider_credentials` | `org_id` | `organizations` | cascade |
| `ai_settings` | `org_id` | `organizations` | cascade |
| `ai_usage_events` | `org_id` | `organizations` | cascade |
| `ai_usage_events` | `user_id` | `users` | no action |
| `applications` | `candidate_id` | `candidates` | cascade |
| `applications` | `org_id` | `organizations` | cascade |
| `applications` | `requisition_id` | `requisitions` | cascade |
| `board_sync_state` | `integration_id` | `source_integrations` | cascade |
| `board_sync_state` | `org_id` | `organizations` | cascade |
| `board_webhook_events` | `org_id` | `organizations` | no action |
| `candidate_assessments` | `candidate_id` | `candidates` | cascade |
| `candidate_assessments` | `org_id` | `organizations` | cascade |
| `candidate_assessments` | `requisition_id` | `requisitions` | no action |
| `candidate_notes` | `candidate_id` | `candidates` | cascade |
| `candidate_notes` | `org_id` | `organizations` | cascade |
| `candidate_ownership_events` | `candidate_id` | `candidates` | cascade |
| `candidate_ownership_events` | `org_id` | `organizations` | no action |
| `candidate_referrals` | `candidate_id` | `candidates` | cascade |
| `candidate_referrals` | `org_id` | `organizations` | no action |
| `candidate_referrals` | `requisition_id` | `requisitions` | no action |
| `candidate_verifications` | `candidate_id` | `candidates` | cascade |
| `candidate_verifications` | `org_id` | `organizations` | cascade |
| `candidates` | `org_id` | `organizations` | cascade |
| `capture_events` | `candidate_id` | `candidates` | no action |
| `capture_events` | `org_id` | `organizations` | cascade |
| `capture_events` | `requisition_id` | `requisitions` | no action |
| `comp_knowledge` | `org_id` | `organizations` | cascade |
| `comp_knowledge` | `requisition_id` | `requisitions` | no action |
| `content_templates` | `org_id` | `organizations` | cascade |
| `copilot_messages` | `org_id` | `organizations` | cascade |
| `departments` | `org_id` | `organizations` | cascade |
| `email_outbox` | `application_id` | `applications` | cascade |
| `email_outbox` | `org_id` | `organizations` | cascade |
| `email_settings` | `org_id` | `organizations` | cascade |
| `evaluations` | `application_id` | `applications` | cascade |
| `evaluations` | `interview_id` | `interviews` | no action |
| `evaluations` | `org_id` | `organizations` | cascade |
| `hiring_conversations` | `created_by` | `users` | cascade |
| `hiring_conversations` | `org_id` | `organizations` | cascade |
| `hiring_conversations` | `requisition_id` | `requisitions` | no action |
| `hiring_conversations` | `reuse_jd_from` | `requisitions` | no action |
| `hiring_messages` | `conversation_id` | `hiring_conversations` | cascade |
| `hiring_messages` | `org_id` | `organizations` | cascade |
| `hr_incentive_schemes` | `org_id` | `organizations` | cascade |
| `hrms_employees` | `integration_id` | `source_integrations` | cascade |
| `hrms_employees` | `org_id` | `organizations` | cascade |
| `hrms_field_mappings` | `integration_id` | `source_integrations` | cascade |
| `hrms_field_mappings` | `org_id` | `organizations` | cascade |
| `hrms_sync_state` | `integration_id` | `source_integrations` | cascade |
| `hrms_sync_state` | `org_id` | `organizations` | cascade |
| `inbox_messages` | `org_id` | `organizations` | cascade |
| `integration_credentials` | `integration_id` | `source_integrations` | cascade |
| `integration_credentials` | `org_id` | `organizations` | cascade |
| `interview_slot_offers` | `application_id` | `applications` | cascade |
| `interview_slot_offers` | `interview_id` | `interviews` | no action |
| `interview_slot_offers` | `org_id` | `organizations` | cascade |
| `interviews` | `application_id` | `applications` | cascade |
| `interviews` | `org_id` | `organizations` | cascade |
| `job_descriptions` | `org_id` | `organizations` | cascade |
| `job_descriptions` | `requisition_id` | `requisitions` | cascade |
| `master_items` | `org_id` | `organizations` | cascade |
| `match_scores` | `application_id` | `applications` | cascade |
| `match_scores` | `org_id` | `organizations` | cascade |
| `offers` | `application_id` | `applications` | cascade |
| `offers` | `org_id` | `organizations` | cascade |
| `onboarding_documents` | `application_id` | `applications` | cascade |
| `onboarding_documents` | `candidate_id` | `candidates` | cascade |
| `onboarding_documents` | `offer_id` | `offers` | no action |
| `onboarding_documents` | `org_id` | `organizations` | cascade |
| `ontology_snapshots` | `org_id` | `organizations` | cascade |
| `org_linkedin_connections` | `org_id` | `organizations` | cascade |
| `org_members` | `org_id` | `organizations` | cascade |
| `org_members` | `user_id` | `users` | cascade |
| `org_pool_shares` | `owner_org` | `organizations` | cascade |
| `org_pool_shares` | `partner_org` | `organizations` | cascade |
| `requisition_board_postings` | `org_id` | `organizations` | cascade |
| `requisition_board_postings` | `requisition_id` | `requisitions` | cascade |
| `requisitions` | `created_by` | `users` | no action |
| `requisitions` | `department_id` | `departments` | no action |
| `requisitions` | `org_id` | `organizations` | cascade |
| `salary_benchmarks` | `org_id` | `organizations` | cascade |
| `salary_benchmarks` | `requisition_id` | `requisitions` | no action |
| `screening_kits` | `application_id` | `applications` | no action |
| `screening_kits` | `candidate_id` | `candidates` | cascade |
| `screening_kits` | `org_id` | `organizations` | cascade |
| `screening_kits` | `requisition_id` | `requisitions` | no action |
| `screening_prep_jobs` | `application_id` | `applications` | cascade |
| `screening_prep_jobs` | `candidate_id` | `candidates` | cascade |
| `screening_prep_jobs` | `org_id` | `organizations` | cascade |
| `screening_prep_jobs` | `requisition_id` | `requisitions` | cascade |
| `screening_runs` | `application_id` | `applications` | no action |
| `screening_runs` | `candidate_id` | `candidates` | cascade |
| `screening_runs` | `kit_id` | `screening_kits` | cascade |
| `screening_runs` | `org_id` | `organizations` | cascade |
| `screening_runs` | `requisition_id` | `requisitions` | no action |
| `sessions` | `user_id` | `users` | cascade |
| `skill_edges` | `org_id` | `organizations` | cascade |
| `skill_evidence` | `candidate_id` | `candidates` | cascade |
| `skill_evidence` | `org_id` | `organizations` | cascade |
| `skill_evidence` | `requisition_id` | `requisitions` | cascade |
| `skill_nodes` | `org_id` | `organizations` | cascade |
| `social_profiles` | `candidate_id` | `candidates` | cascade |
| `social_profiles` | `org_id` | `organizations` | cascade |
| `source_integrations` | `org_id` | `organizations` | cascade |
| `stage_events` | `application_id` | `applications` | cascade |
| `stage_events` | `org_id` | `organizations` | cascade |
| `talent_request_suggestions` | `candidate_id` | `candidates` | cascade |
| `talent_request_suggestions` | `org_id` | `organizations` | no action |
| `talent_request_suggestions` | `request_id` | `talent_requests` | cascade |
| `talent_requests` | `org_id` | `organizations` | no action |
| `talent_requests` | `requisition_id` | `requisitions` | no action |
| `user_roles` | `org_id` | `organizations` | cascade |
| `user_roles` | `user_id` | `users` | cascade |

## Table inventory

| Table | Domain | Columns | Unique constraints |
|---|---|---|---|
| `agent_cost_rates` | — | 6 | — |
| `agent_definitions` | — | 6 | (agentType+hash) |
| `agent_events` | — | 12 | — |
| `agent_issues` | — | 16 | — |
| `agent_metrics_daily` | — | 17 | — |
| `agent_policies` | — | 10 | (orgId+agentType) |
| `agent_runs` | — | 31 | — |
| `agent_runtime_heartbeat` | — | 4 | — |
| `agent_steps` | — | 17 | (runId+seq) |
| `agent_tasks` | — | 16 | — |
| `agent_telemetry_settings` | — | 12 | — |
| `ai_interviews` | Screening & interviews | 8 | — |
| `ai_provider_credentials` | Communications & AI settings | 4 | (orgId+provider) |
| `ai_settings` | Communications & AI settings | 9 | (org_id) |
| `ai_usage_events` | Communications & AI settings | 16 | — |
| `applications` | Candidates & pipeline | 10 | (requisitionId+candidateId) |
| `audit_log` | Identity & access | 10 | — |
| `board_sync_state` | — | 11 | (integration_id) |
| `board_webhook_events` | — | 15 | (dedupe_key) |
| `candidate_assessments` | Candidates & pipeline | 16 | (token) |
| `candidate_notes` | Candidates & pipeline | 8 | — |
| `candidate_ownership_events` | Candidates & pipeline | 8 | — |
| `candidate_referrals` | Candidates & pipeline | 11 | — |
| `candidate_verifications` | Candidates & pipeline | 11 | — |
| `candidates` | Candidates & pipeline | 40 | — |
| `capture_events` | Sourcing & integrations | 10 | — |
| `comp_knowledge` | Intelligence | 17 | — |
| `content_templates` | Requisitions & job content | 16 | — |
| `copilot_messages` | Intelligence | 6 | — |
| `departments` | Organisations & masters | 8 | (orgId+name) |
| `email_outbox` | Communications & AI settings | 16 | (idempotency_key) |
| `email_settings` | Communications & AI settings | 11 | (org_id) |
| `evaluations` | Candidates & pipeline | 15 | — |
| `hiring_conversations` | — | 10 | — |
| `hiring_messages` | — | 8 | — |
| `hr_incentive_schemes` | Offers & onboarding | 9 | — |
| `hrms_employees` | — | 15 | (integrationId+externalId) |
| `hrms_field_mappings` | — | 6 | (integration_id) |
| `hrms_sync_state` | — | 12 | (integrationId+entity) |
| `inbox_messages` | Sourcing & integrations | 16 | — |
| `integration_credentials` | Sourcing & integrations | 4 | — |
| `interview_slot_offers` | — | 22 | (token) |
| `interviews` | Screening & interviews | 16 | — |
| `job_descriptions` | Requisitions & job content | 17 | — |
| `master_items` | Organisations & masters | 8 | — |
| `match_scores` | Candidates & pipeline | 26 | — |
| `offers` | Offers & onboarding | 10 | — |
| `onboarding_documents` | Offers & onboarding | 23 | — |
| `ontology_snapshots` | Intelligence | 11 | — |
| `org_linkedin_connections` | Organisations & masters | 11 | — |
| `org_members` | Organisations & masters | 12 | (orgId+email) |
| `org_pool_shares` | Organisations & masters | 10 | (ownerOrg+partnerOrg) |
| `organizations` | Organisations & masters | 26 | (slug), (capture_token), (capture_token_hash) |
| `platform_admins` | Identity & access | 6 | (email) |
| `product_catalogue_commercials` | Organisations & masters | 8 | — |
| `requisition_board_postings` | — | 16 | (requisitionId+provider) |
| `requisitions` | Requisitions & job content | 40 | (orgId+code) |
| `salary_benchmarks` | Intelligence | 15 | — |
| `screening_kits` | Screening & interviews | 11 | — |
| `screening_prep_jobs` | Screening & interviews | 10 | (application_id) |
| `screening_runs` | Screening & interviews | 22 | — |
| `sessions` | Identity & access | 8 | (token_hash) |
| `skill_edges` | Intelligence | 8 | — |
| `skill_evidence` | Intelligence | 9 | — |
| `skill_nodes` | Intelligence | 15 | (orgId+slug) |
| `social_profiles` | Candidates & pipeline | 13 | (candidateId+provider) |
| `source_integrations` | Sourcing & integrations | 17 | (orgId+provider) |
| `stage_events` | Candidates & pipeline | 9 | — |
| `talent_request_suggestions` | Candidates & pipeline | 8 | (requestId+candidateId) |
| `talent_requests` | Candidates & pipeline | 10 | — |
| `user_roles` | Identity & access | 4 | — |
| `users` | Identity & access | 8 | (email) |
