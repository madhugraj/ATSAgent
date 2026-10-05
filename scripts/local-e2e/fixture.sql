--
-- PostgreSQL database dump
--

\restrict cxaf5JfuT0ORRKn0mv2MvpJTg9G4ZrDVHzdaBRhpSkdAAVsbDo7GNC87qTjAnEe

-- Dumped from database version 14.19 (Homebrew)
-- Dumped by pg_dump version 14.19 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA auth;


ALTER SCHEMA auth OWNER TO postgres;

--
-- Name: storage; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA storage;


ALTER SCHEMA storage OWNER TO postgres;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: app_role; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.app_role AS ENUM (
    'recruiter',
    'hiring_manager',
    'department_head',
    'hr_head',
    'president_cbo'
);


ALTER TYPE public.app_role OWNER TO postgres;

--
-- Name: app_stage; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.app_stage AS ENUM (
    'sourced',
    'applied',
    'ai_screened',
    'shortlisted',
    'l1',
    'l2',
    'l3',
    'offer',
    'hired',
    'rejected',
    'offer_pending',
    'offer_released',
    'offer_accepted',
    'offer_declined',
    'joined',
    'no_show',
    'joining_deferred',
    'withdrawn',
    'on_hold',
    'reserve'
);


ALTER TYPE public.app_stage OWNER TO postgres;

--
-- Name: jd_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.jd_status AS ENUM (
    'draft',
    'pending_dh',
    'approved',
    'changes_requested'
);


ALTER TYPE public.jd_status OWNER TO postgres;

--
-- Name: offer_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.offer_status AS ENUM (
    'draft',
    'pending_hr',
    'pending_cbo',
    'approved',
    'released',
    'accepted',
    'declined',
    'revoked'
);


ALTER TYPE public.offer_status OWNER TO postgres;

--
-- Name: recommendation; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.recommendation AS ENUM (
    'select',
    'reject',
    'hold'
);


ALTER TYPE public.recommendation OWNER TO postgres;

--
-- Name: req_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.req_status AS ENUM (
    'draft',
    'pending_dh',
    'pending_hr',
    'pending_cbo',
    'approved',
    'rejected',
    'on_hold',
    'closed'
);


ALTER TYPE public.req_status OWNER TO postgres;

--
-- Name: req_type; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.req_type AS ENUM (
    'new',
    'replacement'
);


ALTER TYPE public.req_type OWNER TO postgres;

--
-- Name: jwt(); Type: FUNCTION; Schema: auth; Owner: postgres
--

CREATE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;


ALTER FUNCTION auth.jwt() OWNER TO postgres;

--
-- Name: role(); Type: FUNCTION; Schema: auth; Owner: postgres
--

CREATE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $$ select current_setting('request.jwt.claim.role', true) $$;


ALTER FUNCTION auth.role() OWNER TO postgres;

--
-- Name: uid(); Type: FUNCTION; Schema: auth; Owner: postgres
--

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;


ALTER FUNCTION auth.uid() OWNER TO postgres;

--
-- Name: current_org_id(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.current_org_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select org_id from public.org_members
  where user_id = auth.uid() and status = 'active'
  order by created_at limit 1
$$;


ALTER FUNCTION public.current_org_id() OWNER TO postgres;

--
-- Name: fill_org_from_parent(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.fill_org_from_parent() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v uuid;
  parent text := TG_ARGV[0];
  col text := TG_ARGV[1];
  parent_id uuid := (to_jsonb(new) ->> col)::uuid;
begin
  if new.org_id is null then
    if parent_id is not null then
      execute format('select org_id from public.%I where id = $1', parent) into v using parent_id;
    end if;
    new.org_id := coalesce(v, public.current_org_id());
  end if;
  return new;
end $_$;


ALTER FUNCTION public.fill_org_from_parent() OWNER TO postgres;

--
-- Name: has_org_role(uuid, uuid, public.app_role); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.has_org_role(_user_id uuid, _org uuid, _role public.app_role) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role and (org_id = _org or org_id is null)
  )
$$;


ALTER FUNCTION public.has_org_role(_user_id uuid, _org uuid, _role public.app_role) OWNER TO postgres;

--
-- Name: has_role(uuid, public.app_role); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;


ALTER FUNCTION public.has_role(_user_id uuid, _role public.app_role) OWNER TO postgres;

--
-- Name: is_org_member(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_org_member(_org uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.org_members
    where org_id = _org and user_id = auth.uid() and status = 'active'
  )
$$;


ALTER FUNCTION public.is_org_member(_org uuid) OWNER TO postgres;

--
-- Name: is_org_owner(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_org_owner(_org uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.org_members
    where org_id = _org and user_id = auth.uid() and status = 'active' and is_owner
  )
$$;


ALTER FUNCTION public.is_org_owner(_org uuid) OWNER TO postgres;

--
-- Name: shares_pool_with_me(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.shares_pool_with_me(_owner_org uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_pool_shares s
    WHERE s.owner_org = _owner_org
      AND s.status = 'active'
      AND EXISTS (
        SELECT 1 FROM public.org_members m
        WHERE m.org_id = s.partner_org AND m.user_id = auth.uid() AND m.status = 'active'
      )
  )
$$;


ALTER FUNCTION public.shares_pool_with_me(_owner_org uuid) OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: users; Type: TABLE; Schema: auth; Owner: postgres
--

CREATE TABLE auth.users (
    id uuid NOT NULL,
    email text,
    email_confirmed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE auth.users OWNER TO postgres;

--
-- Name: ai_interviews; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ai_interviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    jd_match_score integer DEFAULT 0 NOT NULL,
    skillset_score integer DEFAULT 0 NOT NULL,
    culture_role_score integer DEFAULT 0 NOT NULL,
    culture_org_score integer DEFAULT 0 NOT NULL,
    transcript jsonb DEFAULT '[]'::jsonb NOT NULL,
    summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid
);


ALTER TABLE public.ai_interviews OWNER TO postgres;

--
-- Name: ai_provider_credentials; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ai_provider_credentials (
    provider text NOT NULL,
    api_key text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid DEFAULT public.current_org_id()
);


ALTER TABLE public.ai_provider_credentials OWNER TO postgres;

--
-- Name: ai_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ai_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    singleton boolean DEFAULT true NOT NULL,
    provider text DEFAULT 'openai'::text NOT NULL,
    model text DEFAULT 'google/gemini-3.7-flash'::text NOT NULL,
    last_test_status text DEFAULT 'untested'::text NOT NULL,
    last_test_message text,
    last_tested_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid DEFAULT public.current_org_id()
);


ALTER TABLE public.ai_settings OWNER TO postgres;

--
-- Name: applications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    requisition_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    stage public.app_stage DEFAULT 'applied'::public.app_stage NOT NULL,
    source text DEFAULT 'direct'::text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    stage_reason text,
    stage_note text,
    org_id uuid
);


ALTER TABLE public.applications OWNER TO postgres;

--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    actor_user_id uuid,
    actor text NOT NULL,
    action text NOT NULL,
    entity_type text,
    entity_id uuid,
    detail jsonb,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.audit_log OWNER TO postgres;

--
-- Name: candidate_assessments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.candidate_assessments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_id uuid NOT NULL,
    requisition_id uuid,
    token text NOT NULL,
    status text DEFAULT 'sent'::text NOT NULL,
    questions jsonb DEFAULT '[]'::jsonb NOT NULL,
    answers jsonb DEFAULT '[]'::jsonb NOT NULL,
    mindset_score integer,
    dimensions jsonb,
    red_flags text[] DEFAULT '{}'::text[] NOT NULL,
    strengths text[] DEFAULT '{}'::text[] NOT NULL,
    summary text,
    model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    org_id uuid
);


ALTER TABLE public.candidate_assessments OWNER TO postgres;

--
-- Name: candidate_notes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.candidate_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    candidate_id uuid NOT NULL,
    author_id uuid NOT NULL,
    author_name text,
    body text NOT NULL,
    mentions uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.candidate_notes OWNER TO postgres;

--
-- Name: candidate_ownership_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.candidate_ownership_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    candidate_id uuid NOT NULL,
    from_owner uuid,
    to_owner uuid,
    actor uuid,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.candidate_ownership_events OWNER TO postgres;

--
-- Name: candidate_referrals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.candidate_referrals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    candidate_id uuid NOT NULL,
    requisition_id uuid,
    from_user uuid NOT NULL,
    to_user uuid NOT NULL,
    note text,
    status text DEFAULT 'pending'::text NOT NULL,
    response_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone
);


ALTER TABLE public.candidate_referrals OWNER TO postgres;

--
-- Name: candidate_verifications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.candidate_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_id uuid NOT NULL,
    authenticity_score integer DEFAULT 0 NOT NULL,
    claims jsonb DEFAULT '[]'::jsonb NOT NULL,
    red_flags text[] DEFAULT '{}'::text[] NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    summary text,
    model text,
    status text DEFAULT 'ok'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid
);


ALTER TABLE public.candidate_verifications OWNER TO postgres;

--
-- Name: candidates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    phone text,
    location text,
    source text DEFAULT 'direct'::text NOT NULL,
    experience_years numeric(4,1) DEFAULT 0 NOT NULL,
    current_ctc numeric(14,2),
    expected_ctc numeric(14,2),
    notice_period_days integer,
    education text,
    skills text[] DEFAULT '{}'::text[] NOT NULL,
    resume_text text,
    linkedin_url text,
    github_url text,
    website_url text,
    x_url text,
    consent_given boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    external_id text,
    external_provider text,
    is_internal boolean DEFAULT false NOT NULL,
    employee_id text,
    current_department text,
    manager_endorsed boolean DEFAULT false NOT NULL,
    last_synced_at timestamp with time zone,
    sync_status text DEFAULT 'never'::text NOT NULL,
    current_employer text,
    work_authorization text,
    willing_to_relocate boolean,
    preferred_locations text[] DEFAULT '{}'::text[] NOT NULL,
    referral_source text,
    employment_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    career_metrics jsonb,
    org_id uuid DEFAULT public.current_org_id(),
    resume_file_path text,
    owner_id uuid,
    added_by uuid
);


ALTER TABLE public.candidates OWNER TO postgres;

--
-- Name: capture_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.capture_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    kind text NOT NULL,
    source_url text,
    title text,
    status text DEFAULT 'stored'::text NOT NULL,
    detail text,
    candidate_id uuid,
    requisition_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.capture_events OWNER TO postgres;

--
-- Name: copilot_messages; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.copilot_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    user_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT copilot_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);


ALTER TABLE public.copilot_messages OWNER TO postgres;

--
-- Name: departments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.departments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    head_name text,
    budgeted_headcount integer DEFAULT 0 NOT NULL,
    budgeted_cost numeric(14,2) DEFAULT 0 NOT NULL,
    period text DEFAULT 'FY26'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid DEFAULT public.current_org_id()
);


ALTER TABLE public.departments OWNER TO postgres;

--
-- Name: evaluations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.evaluations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    level integer NOT NULL,
    evaluator text,
    focus_area text,
    rating integer,
    comments text,
    recommendation public.recommendation DEFAULT 'hold'::public.recommendation NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    interview_id uuid,
    competencies jsonb DEFAULT '[]'::jsonb NOT NULL,
    submitted_by text,
    submitted_at timestamp with time zone,
    org_id uuid
);


ALTER TABLE public.evaluations OWNER TO postgres;

--
-- Name: hr_incentive_schemes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hr_incentive_schemes (
    org_id uuid NOT NULL,
    currency text DEFAULT 'INR'::text NOT NULL,
    target_closures_per_month integer DEFAULT 3 NOT NULL,
    payout_per_closure numeric DEFAULT 10000 NOT NULL,
    quality_bands jsonb DEFAULT '[{"min_score": 85, "multiplier": 1.2}, {"min_score": 70, "multiplier": 1}, {"min_score": 0, "multiplier": 0.8}]'::jsonb NOT NULL,
    monthly_cap numeric,
    notes text,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.hr_incentive_schemes OWNER TO postgres;

--
-- Name: inbox_messages; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.inbox_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    to_address text,
    from_email text,
    from_name text,
    subject text,
    body text,
    attachment_name text,
    attachment_bytes integer,
    status text DEFAULT 'received'::text NOT NULL,
    detail text,
    candidate_id uuid,
    requisition_id uuid,
    provider_message_id text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.inbox_messages OWNER TO postgres;

--
-- Name: integration_credentials; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.integration_credentials (
    integration_id uuid NOT NULL,
    secrets jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid
);


ALTER TABLE public.integration_credentials OWNER TO postgres;

--
-- Name: interviews; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.interviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    level integer DEFAULT 1 NOT NULL,
    interviewer text,
    scheduled_at timestamp with time zone,
    teams_link text,
    status text DEFAULT 'scheduled'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    interviewer_email text,
    duration_mins integer DEFAULT 60 NOT NULL,
    mode text DEFAULT 'online'::text NOT NULL,
    agenda text,
    completed_at timestamp with time zone,
    org_id uuid
);


ALTER TABLE public.interviews OWNER TO postgres;

--
-- Name: job_descriptions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.job_descriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    requisition_id uuid NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status public.jd_status DEFAULT 'draft'::public.jd_status NOT NULL,
    purpose text,
    responsibilities text,
    must_have text[] DEFAULT '{}'::text[] NOT NULL,
    good_to_have text[] DEFAULT '{}'::text[] NOT NULL,
    qualifications text,
    success_factors text,
    reporting_to text,
    full_text text,
    approver_comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid
);


ALTER TABLE public.job_descriptions OWNER TO postgres;

--
-- Name: linkedin_oauth_states; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.linkedin_oauth_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    redirect_uri text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:10:00'::interval) NOT NULL,
    consumed_at timestamp with time zone
);


ALTER TABLE public.linkedin_oauth_states OWNER TO postgres;

--
-- Name: master_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.master_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    category text,
    sort_order integer DEFAULT 100 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid DEFAULT public.current_org_id(),
    CONSTRAINT master_items_kind_check CHECK ((kind = ANY (ARRAY['skill'::text, 'location'::text, 'education'::text, 'employment_type'::text, 'industry'::text, 'role_title'::text, 'billing_type'::text, 'engagement_type'::text, 'client'::text, 'rejection_reason'::text])))
);


ALTER TABLE public.master_items OWNER TO postgres;

--
-- Name: match_scores; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.match_scores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    skills_score integer DEFAULT 0 NOT NULL,
    experience_score integer DEFAULT 0 NOT NULL,
    education_score integer DEFAULT 0 NOT NULL,
    social_score integer DEFAULT 0 NOT NULL,
    overall_score integer DEFAULT 0 NOT NULL,
    weights jsonb DEFAULT '{"skills": 50, "social": 15, "education": 10, "experience": 25}'::jsonb NOT NULL,
    matched_skills text[] DEFAULT '{}'::text[] NOT NULL,
    missing_skills text[] DEFAULT '{}'::text[] NOT NULL,
    rationale text,
    risk_flags text[] DEFAULT '{}'::text[] NOT NULL,
    recommendation public.recommendation,
    model text,
    recruiter_override public.recommendation,
    override_reason text,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    career_score integer DEFAULT 0 NOT NULL,
    impact_score integer DEFAULT 0 NOT NULL,
    innovation_score integer DEFAULT 0 NOT NULL,
    career_metrics jsonb,
    career_flags text[] DEFAULT '{}'::text[] NOT NULL,
    logistics_flags text[] DEFAULT '{}'::text[] NOT NULL,
    impact_highlights text[] DEFAULT '{}'::text[] NOT NULL,
    innovation_signals text[] DEFAULT '{}'::text[] NOT NULL,
    org_id uuid
);


ALTER TABLE public.match_scores OWNER TO postgres;

--
-- Name: offers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.offers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    offered_ctc numeric(14,2) DEFAULT 0 NOT NULL,
    joining_date date,
    status public.offer_status DEFAULT 'draft'::public.offer_status NOT NULL,
    approval_trail jsonb DEFAULT '[]'::jsonb NOT NULL,
    letter jsonb,
    letter_template_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid
);


ALTER TABLE public.offers OWNER TO postgres;

--
-- Name: ontology_snapshots; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ontology_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    node_count integer DEFAULT 0 NOT NULL,
    edge_count integer DEFAULT 0 NOT NULL,
    added text[] DEFAULT '{}'::text[] NOT NULL,
    grown text[] DEFAULT '{}'::text[] NOT NULL,
    dormant text[] DEFAULT '{}'::text[] NOT NULL,
    retired text[] DEFAULT '{}'::text[] NOT NULL,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.ontology_snapshots OWNER TO postgres;

--
-- Name: org_linkedin_connections; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.org_linkedin_connections (
    org_id uuid NOT NULL,
    member_sub text NOT NULL,
    member_name text,
    member_email text,
    access_token text NOT NULL,
    refresh_token text,
    expires_at timestamp with time zone,
    scope text,
    connected_by uuid,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.org_linkedin_connections OWNER TO postgres;

--
-- Name: org_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.org_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid,
    email text NOT NULL,
    full_name text,
    title text,
    status text DEFAULT 'invited'::text NOT NULL,
    is_owner boolean DEFAULT false NOT NULL,
    invited_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    joined_at timestamp with time zone,
    invited_role public.app_role
);


ALTER TABLE public.org_members OWNER TO postgres;

--
-- Name: org_pool_shares; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.org_pool_shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_org uuid NOT NULL,
    partner_org uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    scope text,
    requested_by uuid,
    responded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    revoked_at timestamp with time zone
);


ALTER TABLE public.org_pool_shares OWNER TO postgres;

--
-- Name: organizations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    legal_name text,
    industry text,
    hq_country text,
    hq_city text,
    employee_band text,
    currency text DEFAULT 'INR'::text NOT NULL,
    fiscal_year_start_month smallint DEFAULT 4 NOT NULL,
    careers_email text,
    onboarding_step text DEFAULT 'profile'::text NOT NULL,
    onboarded_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    archived_at timestamp with time zone,
    archived_reason text,
    approved_at timestamp with time zone,
    approved_by uuid,
    rejected_at timestamp with time zone,
    rejection_reason text,
    email_domain text,
    inbox_slug text,
    capture_token text
);


ALTER TABLE public.organizations OWNER TO postgres;

--
-- Name: platform_admins; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.platform_admins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    user_id uuid,
    note text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.platform_admins OWNER TO postgres;

--
-- Name: product_catalogue_commercials; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.product_catalogue_commercials (
    module_id text NOT NULL,
    tier text,
    list_price numeric,
    currency text DEFAULT 'USD'::text NOT NULL,
    unit text,
    notes text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


ALTER TABLE public.product_catalogue_commercials OWNER TO postgres;

--
-- Name: requisitions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.requisitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    department_id uuid,
    req_type public.req_type DEFAULT 'new'::public.req_type NOT NULL,
    status public.req_status DEFAULT 'draft'::public.req_status NOT NULL,
    location text,
    openings integer DEFAULT 1 NOT NULL,
    experience_min integer DEFAULT 0 NOT NULL,
    experience_max integer DEFAULT 5 NOT NULL,
    budget_ctc numeric(14,2) DEFAULT 0 NOT NULL,
    hiring_manager text,
    must_have_skills text[] DEFAULT '{}'::text[] NOT NULL,
    good_to_have_skills text[] DEFAULT '{}'::text[] NOT NULL,
    responsibilities text,
    education_requirement text,
    weight_skills integer DEFAULT 40 NOT NULL,
    weight_experience integer DEFAULT 15 NOT NULL,
    weight_education integer DEFAULT 10 NOT NULL,
    weight_social integer DEFAULT 15 NOT NULL,
    approval_trail jsonb DEFAULT '[]'::jsonb NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    billing_type text DEFAULT 'non_billable'::text NOT NULL,
    engagement_type text DEFAULT 'internal'::text NOT NULL,
    client_name text,
    cost_center text,
    ijp_enabled boolean DEFAULT false NOT NULL,
    ijp_posted_at timestamp with time zone,
    ijp_notes text,
    weight_career integer DEFAULT 10 NOT NULL,
    weight_impact integer DEFAULT 10 NOT NULL,
    ctc_band_min numeric(14,2),
    ctc_band_max numeric(14,2),
    max_notice_period_days integer,
    work_authorization_required text,
    org_id uuid DEFAULT public.current_org_id(),
    career_level text
);


ALTER TABLE public.requisitions OWNER TO postgres;

--
-- Name: salary_benchmarks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.salary_benchmarks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    requisition_id uuid,
    input_key text NOT NULL,
    title text NOT NULL,
    location text,
    experience_min integer DEFAULT 0 NOT NULL,
    experience_max integer DEFAULT 5 NOT NULL,
    currency text DEFAULT 'INR'::text NOT NULL,
    grounded boolean DEFAULT false NOT NULL,
    confidence text DEFAULT 'medium'::text NOT NULL,
    payload jsonb NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.salary_benchmarks OWNER TO postgres;

--
-- Name: screening_kits; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.screening_kits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    candidate_id uuid NOT NULL,
    requisition_id uuid,
    application_id uuid,
    questions jsonb DEFAULT '[]'::jsonb NOT NULL,
    focus_summary text,
    engine jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.screening_kits OWNER TO postgres;

--
-- Name: screening_runs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.screening_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    kit_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    requisition_id uuid,
    application_id uuid,
    input_kind text DEFAULT 'typed'::text NOT NULL,
    answers jsonb DEFAULT '[]'::jsonb NOT NULL,
    transcript text,
    audio_path text,
    audio_engine text,
    screening_score integer DEFAULT 0 NOT NULL,
    match_score integer,
    combined_score integer,
    verdicts jsonb DEFAULT '[]'::jsonb NOT NULL,
    red_flags text[] DEFAULT '{}'::text[] NOT NULL,
    rationale text,
    recommendation text,
    recommendation_reason text,
    engine jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.screening_runs OWNER TO postgres;

--
-- Name: sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    user_agent text,
    ip text
);


ALTER TABLE public.sessions OWNER TO postgres;

--
-- Name: skill_edges; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.skill_edges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text DEFAULT 'cooccurs'::text NOT NULL,
    weight numeric DEFAULT 0 NOT NULL,
    evidence_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.skill_edges OWNER TO postgres;

--
-- Name: skill_evidence; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.skill_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    slug text NOT NULL,
    candidate_id uuid,
    requisition_id uuid,
    source text NOT NULL,
    strength numeric DEFAULT 1 NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.skill_evidence OWNER TO postgres;

--
-- Name: skill_nodes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.skill_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    parent_slug text,
    supply integer DEFAULT 0 NOT NULL,
    demand integer DEFAULT 0 NOT NULL,
    validated integer DEFAULT 0 NOT NULL,
    evidence_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.skill_nodes OWNER TO postgres;

--
-- Name: social_profiles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.social_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_id uuid NOT NULL,
    provider text NOT NULL,
    profile_url text,
    handle text,
    score integer DEFAULT 0 NOT NULL,
    signals jsonb DEFAULT '{}'::jsonb NOT NULL,
    rationale text,
    raw jsonb,
    status text DEFAULT 'ok'::text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    last_synced_at timestamp with time zone,
    org_id uuid
);


ALTER TABLE public.social_profiles OWNER TO postgres;

--
-- Name: source_integrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.source_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    label text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    credential_fields text[] DEFAULT '{}'::text[] NOT NULL,
    has_credentials boolean DEFAULT false NOT NULL,
    last_test_status text DEFAULT 'untested'::text NOT NULL,
    last_test_message text,
    last_tested_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    category text DEFAULT 'sourcing'::text NOT NULL,
    org_id uuid DEFAULT public.current_org_id()
);


ALTER TABLE public.source_integrations OWNER TO postgres;

--
-- Name: stage_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.stage_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    from_stage public.app_stage,
    to_stage public.app_stage NOT NULL,
    actor text,
    reason text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid
);


ALTER TABLE public.stage_events OWNER TO postgres;

--
-- Name: talent_request_suggestions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.talent_request_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    request_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    suggested_by uuid NOT NULL,
    note text,
    status text DEFAULT 'suggested'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.talent_request_suggestions OWNER TO postgres;

--
-- Name: talent_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.talent_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    requisition_id uuid,
    requester_id uuid NOT NULL,
    title text NOT NULL,
    skills text[] DEFAULT '{}'::text[] NOT NULL,
    note text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone
);


ALTER TABLE public.talent_requests OWNER TO postgres;

--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role public.app_role NOT NULL,
    org_id uuid DEFAULT public.current_org_id()
);


ALTER TABLE public.user_roles OWNER TO postgres;

--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    email_confirmed_at timestamp with time zone,
    password_hash text,
    full_name text,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: buckets; Type: TABLE; Schema: storage; Owner: postgres
--

CREATE TABLE storage.buckets (
    id text NOT NULL,
    name text
);


ALTER TABLE storage.buckets OWNER TO postgres;

--
-- Name: objects; Type: TABLE; Schema: storage; Owner: postgres
--

CREATE TABLE storage.objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket_id text,
    name text,
    owner uuid,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE storage.objects OWNER TO postgres;

--
-- Data for Name: users; Type: TABLE DATA; Schema: auth; Owner: postgres
--

COPY auth.users (id, email, email_confirmed_at, created_at) FROM stdin;
5e2e0000-0000-4000-8000-00000000e2e1	e2e-owner@atsiq-e2e.local	2026-09-13 09:05:33.792566+05:30	2026-09-13 09:05:33.792566+05:30
6a6a0000-0000-4000-8000-00000000d001	madhu@demo.com	2026-09-13 18:19:49.161588+05:30	2026-09-13 18:19:49.161588+05:30
6a6a0000-0000-4000-8000-00000000d002	hr@yavar.ai	2026-09-13 18:19:49.161588+05:30	2026-09-13 18:19:49.161588+05:30
\.


--
-- Data for Name: ai_interviews; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.ai_interviews (id, application_id, jd_match_score, skillset_score, culture_role_score, culture_org_score, transcript, summary, created_at, org_id) FROM stdin;
b80d2bf2-6f5b-4410-b04c-d44767fd39b2	ccccccc1-0000-0000-0000-000000000001	86	88	82	79	[]	Clear articulation of ledger design trade-offs. Strong ownership signals. Slightly light on Kubernetes operational depth.	2026-09-13 09:03:48.363819+05:30	6a6a0000-0000-4000-8000-00000000d011
8fe4647a-6bb6-4f1c-8201-3cf5ce31e53c	ccccccc1-0000-0000-0000-000000000003	93	95	90	88	[]	Exceptional design reasoning and mentoring examples. Values map closely to engineering-led culture.	2026-09-13 09:03:48.363819+05:30	6a6a0000-0000-4000-8000-00000000d011
\.


--
-- Data for Name: ai_provider_credentials; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.ai_provider_credentials (provider, api_key, updated_at, org_id) FROM stdin;
\.


--
-- Data for Name: ai_settings; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.ai_settings (id, singleton, provider, model, last_test_status, last_test_message, last_tested_at, updated_at, org_id) FROM stdin;
9d44f41f-aea9-4b01-8dda-76966e2e0450	t	google	gemini-2.5-flash	untested	\N	\N	2026-09-15 07:32:50.972803+05:30	6a6a0000-0000-4000-8000-00000000d011
ce8139e7-5f52-4e03-a1b7-59a6911ff5b5	t	google	gemini-2.5-flash	untested	\N	\N	2026-09-15 07:32:50.972803+05:30	6a6a0000-0000-4000-8000-00000000d012
\.


--
-- Data for Name: applications; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.applications (id, requisition_id, candidate_id, stage, source, applied_at, last_activity_at, stage_reason, stage_note, org_id) FROM stdin;
ccccccc1-0000-0000-0000-000000000001	aaaaaaa1-0000-0000-0000-000000000001	bbbbbbb1-0000-0000-0000-000000000001	shortlisted	naukri	2026-09-13 09:03:48.362606+05:30	2026-09-13 09:03:48.524139+05:30	\N	\N	6a6a0000-0000-4000-8000-00000000d011
ccccccc1-0000-0000-0000-000000000002	aaaaaaa1-0000-0000-0000-000000000001	bbbbbbb1-0000-0000-0000-000000000002	applied	linkedin	2026-09-13 09:03:48.362606+05:30	2026-09-13 09:03:48.524139+05:30	\N	\N	6a6a0000-0000-4000-8000-00000000d011
ccccccc1-0000-0000-0000-000000000003	aaaaaaa1-0000-0000-0000-000000000001	bbbbbbb1-0000-0000-0000-000000000003	l1	referral	2026-09-13 09:03:48.362606+05:30	2026-09-13 09:03:48.524139+05:30	\N	\N	6a6a0000-0000-4000-8000-00000000d011
6ffa4de7-5f8b-41e8-affb-ddca8665d3d3	c9dff802-8679-4ff1-b3cd-0fb4b7823cc9	6a6a0000-0000-4000-8000-00000000c001	shortlisted	careers_page	2026-09-13 18:23:31.402051+05:30	2026-09-13 18:23:31.402051+05:30	\N	\N	6a6a0000-0000-4000-8000-00000000d012
e4841cd8-0f1f-4581-8fbc-809bd02cc2ee	c9dff802-8679-4ff1-b3cd-0fb4b7823cc9	6a6a0000-0000-4000-8000-00000000c002	applied	linkedin	2026-09-13 18:23:31.402051+05:30	2026-09-13 18:23:31.402051+05:30	\N	\N	6a6a0000-0000-4000-8000-00000000d012
\.


--
-- Data for Name: audit_log; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.audit_log (id, org_id, actor_user_id, actor, action, entity_type, entity_id, detail, ip, created_at) FROM stdin;
\.


--
-- Data for Name: candidate_assessments; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.candidate_assessments (id, candidate_id, requisition_id, token, status, questions, answers, mindset_score, dimensions, red_flags, strengths, summary, model, created_at, completed_at, org_id) FROM stdin;
\.


--
-- Data for Name: candidate_notes; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.candidate_notes (id, org_id, candidate_id, author_id, author_name, body, mentions, created_at) FROM stdin;
\.


--
-- Data for Name: candidate_ownership_events; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.candidate_ownership_events (id, org_id, candidate_id, from_owner, to_owner, actor, reason, created_at) FROM stdin;
\.


--
-- Data for Name: candidate_referrals; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.candidate_referrals (id, org_id, candidate_id, requisition_id, from_user, to_user, note, status, response_note, created_at, responded_at) FROM stdin;
\.


--
-- Data for Name: candidate_verifications; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.candidate_verifications (id, candidate_id, authenticity_score, claims, red_flags, evidence, summary, model, status, created_at, org_id) FROM stdin;
\.


--
-- Data for Name: candidates; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.candidates (id, full_name, email, phone, location, source, experience_years, current_ctc, expected_ctc, notice_period_days, education, skills, resume_text, linkedin_url, github_url, website_url, x_url, consent_given, created_at, external_id, external_provider, is_internal, employee_id, current_department, manager_endorsed, last_synced_at, sync_status, current_employer, work_authorization, willing_to_relocate, preferred_locations, referral_source, employment_history, career_metrics, org_id, resume_file_path, owner_id, added_by) FROM stdin;
bbbbbbb1-0000-0000-0000-000000000001	Priya Sharma	priya.sharma@example.com	+91 98200 11223	Bengaluru	naukri	7.0	2900000.00	3600000.00	60	B.Tech Computer Science, NIT Trichy	{Python,PostgreSQL,AWS,Kubernetes,"System Design",Kafka}	Senior backend engineer with 7 years across fintech and SaaS. Built payment ledger services in Python on AWS, migrated monolith to Kubernetes, owns PostgreSQL performance tuning and Kafka event pipelines. Led a team of 4.	https://www.linkedin.com/in/priyasharma	https://github.com/torvalds	https://priyasharma.dev	\N	t	2026-09-13 09:03:48.362326+05:30	\N	\N	f	\N	\N	f	\N	never	\N	\N	\N	{}	\N	[]	\N	6a6a0000-0000-4000-8000-00000000d011	\N	\N	\N
bbbbbbb1-0000-0000-0000-000000000002	Arjun Verma	arjun.verma@example.com	+91 99870 44531	Pune	linkedin	4.0	1600000.00	2400000.00	30	B.E. Information Technology, Pune University	{Python,Django,MySQL,Docker}	Backend developer with 4 years building Django applications, MySQL schemas and Dockerised deployments for e-commerce clients. Limited cloud and distributed systems exposure.	https://www.linkedin.com/in/arjunverma	https://github.com/gaearon	\N	\N	t	2026-09-13 09:03:48.362326+05:30	\N	\N	f	\N	\N	f	\N	never	\N	\N	\N	{}	\N	[]	\N	6a6a0000-0000-4000-8000-00000000d011	\N	\N	\N
bbbbbbb1-0000-0000-0000-000000000003	Neha Iyer	neha.iyer@example.com	+91 90040 78219	Bengaluru	referral	9.0	3400000.00	4200000.00	90	M.Tech Computer Science, IIT Bombay	{Go,Python,PostgreSQL,AWS,Kubernetes,Terraform,"System Design"}	Staff-level engineer, 9 years. Designed multi-region platform on AWS with Kubernetes and Terraform, authored internal system design guidelines, speaks at conferences, maintains two open-source Go libraries.	https://www.linkedin.com/in/nehaiyer	https://github.com/sindresorhus	https://nehaiyer.io	\N	t	2026-09-13 09:03:48.362326+05:30	\N	\N	f	\N	\N	f	\N	never	\N	\N	\N	{}	\N	[]	\N	6a6a0000-0000-4000-8000-00000000d011	\N	\N	\N
6a6a0000-0000-4000-8000-00000000c001	Kavya Nair	kavya.nair@example.com	+91 98860 22110	Bengaluru	careers_page	5.0	2200000.00	3200000.00	30	M.Tech AI, IISc Bengaluru	{Python,PyTorch,LLMOps,"Vector Databases",FastAPI}	ML engineer, 5 years building RAG pipelines and LLM evaluation harnesses. Owns retrieval quality and inference cost optimisation.	\N	\N	\N	\N	t	2026-09-13 18:22:50.787751+05:30	\N	\N	f	\N	\N	f	\N	never	\N	\N	\N	{}	\N	[]	\N	6a6a0000-0000-4000-8000-00000000d012	\N	\N	\N
6a6a0000-0000-4000-8000-00000000c002	Rohan Gupta	rohan.gupta@example.com	+91 99301 55420	Pune	linkedin	4.0	1800000.00	2600000.00	60	B.E. Computer Science, COEP	{TypeScript,React,Node.js,PostgreSQL,AWS}	Full-stack engineer, 4 years on B2B SaaS product. Built multi-tenant dashboards, billing and usage metering systems.	\N	\N	\N	\N	t	2026-09-13 18:22:50.787751+05:30	\N	\N	f	\N	\N	f	\N	never	\N	\N	\N	{}	\N	[]	\N	6a6a0000-0000-4000-8000-00000000d012	\N	\N	\N
6a6a0000-0000-4000-8000-00000000c003	Fatima Sheikh	fatima.sheikh@example.com	+91 90080 77341	Hyderabad	referral	6.0	2800000.00	3800000.00	90	B.Tech CSE, Osmania University	{Go,Kubernetes,Kafka,Terraform,Observability}	Platform engineer, 6 years. Runs multi-region Kubernetes fleets, built internal developer platform and CI speedups.	\N	\N	\N	\N	t	2026-09-13 18:22:50.787751+05:30	\N	\N	f	\N	\N	f	\N	never	\N	\N	\N	{}	\N	[]	\N	6a6a0000-0000-4000-8000-00000000d012	\N	\N	\N
\.


--
-- Data for Name: capture_events; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.capture_events (id, org_id, kind, source_url, title, status, detail, candidate_id, requisition_id, created_at) FROM stdin;
\.


--
-- Data for Name: copilot_messages; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.copilot_messages (id, org_id, user_id, role, content, created_at) FROM stdin;
\.


--
-- Data for Name: departments; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.departments (id, name, head_name, budgeted_headcount, budgeted_cost, period, created_at, org_id) FROM stdin;
11111111-1111-1111-1111-111111111111	Technology	Ananya Rao	24	96000000.00	FY26	2026-09-13 09:03:48.359495+05:30	6a6a0000-0000-4000-8000-00000000d011
22222222-2222-2222-2222-222222222222	Sales	Vikram Mehta	18	54000000.00	FY26	2026-09-13 09:03:48.359495+05:30	6a6a0000-0000-4000-8000-00000000d011
33333333-3333-3333-3333-333333333333	Finance	Rohit Nair	8	32000000.00	FY26	2026-09-13 09:03:48.359495+05:30	6a6a0000-0000-4000-8000-00000000d011
58ea99d6-0a11-482d-a28d-7d1ccbca6874	AI Engineering	\N	6	12000000.00	FY26	2026-09-13 18:19:49.175104+05:30	6a6a0000-0000-4000-8000-00000000d012
425bdebb-90cc-44fc-91fe-b9914e0bf61d	Growth	\N	3	4500000.00	FY26	2026-09-13 18:19:49.175104+05:30	6a6a0000-0000-4000-8000-00000000d012
\.


--
-- Data for Name: evaluations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.evaluations (id, application_id, level, evaluator, focus_area, rating, comments, recommendation, created_at, interview_id, competencies, submitted_by, submitted_at, org_id) FROM stdin;
c21ca74c-4cd6-4064-a812-0bc9a53ff10b	ccccccc1-0000-0000-0000-000000000003	1	Ananya Rao	Technical / functional competency	4	Excellent system design depth, clean coding round.	select	2026-09-13 09:03:48.364033+05:30	\N	[]	\N	\N	6a6a0000-0000-4000-8000-00000000d011
\.


--
-- Data for Name: hr_incentive_schemes; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.hr_incentive_schemes (org_id, currency, target_closures_per_month, payout_per_closure, quality_bands, monthly_cap, notes, updated_by, updated_at) FROM stdin;
\.


--
-- Data for Name: inbox_messages; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.inbox_messages (id, org_id, to_address, from_email, from_name, subject, body, attachment_name, attachment_bytes, status, detail, candidate_id, requisition_id, provider_message_id, received_at, created_at) FROM stdin;
\.


--
-- Data for Name: integration_credentials; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.integration_credentials (integration_id, secrets, updated_at, org_id) FROM stdin;
\.


--
-- Data for Name: interviews; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.interviews (id, application_id, level, interviewer, scheduled_at, teams_link, status, created_at, interviewer_email, duration_mins, mode, agenda, completed_at, org_id) FROM stdin;
6b656586-4e71-4a6a-a841-2a2a2659d54f	ccccccc1-0000-0000-0000-000000000003	2	Ananya Rao	2026-09-04 10:30:00+05:30	https://teams.microsoft.com/l/meetup-join/demo-l2	scheduled	2026-09-13 09:03:48.36423+05:30	\N	60	online	\N	\N	6a6a0000-0000-4000-8000-00000000d011
\.


--
-- Data for Name: job_descriptions; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.job_descriptions (id, requisition_id, version, status, purpose, responsibilities, must_have, good_to_have, qualifications, success_factors, reporting_to, full_text, approver_comment, created_at, org_id) FROM stdin;
00bcca47-0ca4-44b6-8e0f-7ad325ac4c8f	aaaaaaa1-0000-0000-0000-000000000001	1	approved	Own the design and reliability of core backend platform services powering customer-facing products.	- Design and build scalable, secure APIs and services\n- Own service reliability, observability and on-call\n- Mentor mid-level engineers and raise code quality\n- Partner with product on technical scoping	{Python,PostgreSQL,AWS,"System Design",Kubernetes}	{Go,Kafka,Terraform}	B.E./B.Tech in Computer Science with 5-9 years of backend experience	Ships production services within first 90 days; reduces p95 latency; strong design review presence	Engineering Manager, Technology	Senior Backend Engineer — own the design and reliability of core backend platform services.	\N	2026-09-13 09:03:48.362075+05:30	6a6a0000-0000-4000-8000-00000000d011
\.


--
-- Data for Name: linkedin_oauth_states; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.linkedin_oauth_states (id, org_id, user_id, redirect_uri, created_at, expires_at, consumed_at) FROM stdin;
\.


--
-- Data for Name: master_items; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.master_items (id, kind, name, category, sort_order, active, created_at, org_id) FROM stdin;
0df1c563-e85f-4360-8374-1a2161d4aa16	rejection_reason	Skills below requirement	\N	10	t	2026-09-13 09:03:48.546615+05:30	\N
30b79df7-6adc-4769-bd2d-4be5ab762e46	rejection_reason	Experience mismatch	\N	20	t	2026-09-13 09:03:48.546615+05:30	\N
bb3acc77-2301-466c-8949-2a71588ca341	rejection_reason	Compensation expectations	\N	30	t	2026-09-13 09:03:48.546615+05:30	\N
9827ec3b-0e67-4e21-8095-c4f08a202ed8	rejection_reason	Notice period too long	\N	40	t	2026-09-13 09:03:48.546615+05:30	\N
01b65a81-dd32-499c-8419-2848121d54c9	rejection_reason	Communication / culture fit	\N	50	t	2026-09-13 09:03:48.546615+05:30	\N
24e0a402-de9a-42c3-9f62-e4e50ddf1dc3	rejection_reason	Failed technical evaluation	\N	60	t	2026-09-13 09:03:48.546615+05:30	\N
784ba094-998a-4e01-9808-a8644da08ba8	rejection_reason	Authenticity concerns	\N	70	t	2026-09-13 09:03:48.546615+05:30	\N
915740d4-2cc5-4a1b-8e2e-d7b75835e097	rejection_reason	Candidate withdrew	\N	80	t	2026-09-13 09:03:48.546615+05:30	\N
1444215a-6b18-4a8f-86e3-6c0bddfaa4e4	rejection_reason	Position closed / on hold	\N	90	t	2026-09-13 09:03:48.546615+05:30	\N
db0bade1-0b2a-40d0-ad56-53ba643b6133	rejection_reason	Better candidate selected	\N	100	t	2026-09-13 09:03:48.546615+05:30	\N
a24eef78-55bc-486c-98e8-8893f29f1de3	role_title	Benchmark Probe Missing	\N	100	t	2026-09-13 18:41:48.83412+05:30	5e2e0000-0000-4000-8000-00000000e2e2
ad22b642-2e50-409e-bd2e-59eb991b0ac9	role_title	Benchmark Probe Engineer	\N	100	t	2026-09-13 18:41:53.569104+05:30	5e2e0000-0000-4000-8000-00000000e2e2
ebb21c82-1843-4f75-b6da-c9cbbd2e4240	role_title	Senior Data Scientist	\N	100	t	2026-09-13 19:02:35.761182+05:30	6a6a0000-0000-4000-8000-00000000d011
a81523b2-95f6-43a1-8872-a3e866e013bd	location	Chennai	\N	100	t	2026-09-13 19:02:52.941355+05:30	6a6a0000-0000-4000-8000-00000000d011
\.


--
-- Data for Name: match_scores; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.match_scores (id, application_id, skills_score, experience_score, education_score, social_score, overall_score, weights, matched_skills, missing_skills, rationale, risk_flags, recommendation, model, recruiter_override, override_reason, computed_at, career_score, impact_score, innovation_score, career_metrics, career_flags, logistics_flags, impact_highlights, innovation_signals, org_id) FROM stdin;
a131882a-4444-4d3f-bc82-df4d9323b343	ccccccc1-0000-0000-0000-000000000001	88	90	85	72	86	{"skills": 50, "social": 15, "education": 10, "experience": 25}	{Python,PostgreSQL,AWS,Kubernetes,"System Design"}	{}	Covers every must-have skill with depth in payments and platform work. Experience band sits inside the 5-9 year requirement. Social signal is solid but activity is inconsistent.	{"Expected CTC near budget ceiling"}	select	seed	\N	\N	2026-09-13 09:03:48.362908+05:30	0	0	0	\N	{}	{}	{}	{}	6a6a0000-0000-4000-8000-00000000d011
43574355-2051-4b3d-9051-18f567af5ef0	ccccccc1-0000-0000-0000-000000000002	52	45	78	48	53	{"skills": 50, "social": 15, "education": 10, "experience": 25}	{Python}	{PostgreSQL,AWS,Kubernetes,"System Design"}	Strong Django delivery record but missing cloud, orchestration and distributed design must-haves. Experience is below the requisition band.	{"Below experience band","4 of 5 must-have skills missing"}	reject	seed	\N	\N	2026-09-13 09:03:48.362908+05:30	0	0	0	\N	{}	{}	{}	{}	6a6a0000-0000-4000-8000-00000000d011
fdb121ef-ad0d-45ca-9dcc-5797602b2b43	ccccccc1-0000-0000-0000-000000000003	95	88	95	91	93	{"skills": 50, "social": 15, "education": 10, "experience": 25}	{Python,PostgreSQL,AWS,Kubernetes,"System Design"}	{}	Exceeds every must-have plus both good-to-haves. Public engineering footprint is exceptional: maintained OSS libraries, conference talks and consistent contribution history.	{"Notice period 90 days"}	select	seed	\N	\N	2026-09-13 09:03:48.362908+05:30	0	0	0	\N	{}	{}	{}	{}	6a6a0000-0000-4000-8000-00000000d011
32c6840d-151e-4f63-b843-11148ec26829	6ffa4de7-5f8b-41e8-affb-ddca8665d3d3	90	80	92	60	82	{"skills": 50, "social": 15, "education": 10, "experience": 25}	{Python,FastAPI,LLMOps}	{Go}	Strong RAG and LLM-eval background maps to the platform scope. Go exposure limited but not required.	{"Expected CTC above midpoint"}	select	seed	\N	\N	2026-09-13 18:24:03.277899+05:30	0	0	0	\N	{}	{}	{}	{}	6a6a0000-0000-4000-8000-00000000d012
dcf601fd-3bb9-4f08-afbb-7b5b2276ec46	e4841cd8-0f1f-4581-8fbc-809bd02cc2ee	55	60	70	45	58	{"skills": 50, "social": 15, "education": 10, "experience": 25}	{TypeScript,React,PostgreSQL}	{Go,Kubernetes,Kafka}	Solid product engineering record but the opening is platform/infra heavy; missing core runtime skills.	{}	hold	seed	\N	\N	2026-09-13 18:24:03.277899+05:30	0	0	0	\N	{}	{}	{}	{}	6a6a0000-0000-4000-8000-00000000d012
\.


--
-- Data for Name: offers; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.offers (id, application_id, offered_ctc, joining_date, status, approval_trail, created_at, org_id) FROM stdin;
\.


--
-- Data for Name: ontology_snapshots; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.ontology_snapshots (id, org_id, node_count, edge_count, added, grown, dormant, retired, stats, model, created_at) FROM stdin;
\.


--
-- Data for Name: org_linkedin_connections; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.org_linkedin_connections (org_id, member_sub, member_name, member_email, access_token, refresh_token, expires_at, scope, connected_by, connected_at, updated_at) FROM stdin;
\.


--
-- Data for Name: org_members; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.org_members (id, org_id, user_id, email, full_name, title, status, is_owner, invited_by, created_at, joined_at, invited_role) FROM stdin;
0d51a145-bf72-4a17-b1b7-a27d104f39ba	5e2e0000-0000-4000-8000-00000000e2e2	5e2e0000-0000-4000-8000-00000000e2e1	e2e-owner@atsiq-e2e.local	\N	\N	active	t	\N	2026-09-13 09:05:33.811585+05:30	2026-09-13 09:05:33.811585+05:30	\N
9f14261b-b2be-45ff-ac05-fabd2ea9fce9	6a6a0000-0000-4000-8000-00000000d011	6a6a0000-0000-4000-8000-00000000d001	madhu@demo.com	\N	\N	active	t	\N	2026-09-13 18:19:49.163924+05:30	2026-09-13 18:19:49.163924+05:30	\N
18cb11d3-da08-449d-8c02-241cb1f6583d	6a6a0000-0000-4000-8000-00000000d012	6a6a0000-0000-4000-8000-00000000d002	hr@yavar.ai	\N	\N	active	t	\N	2026-09-13 18:19:49.163924+05:30	2026-09-13 18:19:49.163924+05:30	\N
\.


--
-- Data for Name: org_pool_shares; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.org_pool_shares (id, owner_org, partner_org, status, scope, requested_by, responded_by, created_at, responded_at, revoked_at) FROM stdin;
\.


--
-- Data for Name: organizations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.organizations (id, name, slug, legal_name, industry, hq_country, hq_city, employee_band, currency, fiscal_year_start_month, careers_email, onboarding_step, onboarded_at, created_by, created_at, status, archived_at, archived_reason, approved_at, approved_by, rejected_at, rejection_reason, email_domain, inbox_slug, capture_token) FROM stdin;
5e2e0000-0000-4000-8000-00000000e2e2	E2E Test Org	e2e-org	\N	\N	\N	\N	\N	INR	4	\N	done	2026-09-13 09:05:33.810011+05:30	\N	2026-09-13 09:05:33.810011+05:30	active	\N	\N	\N	\N	\N	\N	\N	\N	\N
6a6a0000-0000-4000-8000-00000000d011	Demo Corp	demo-corp	\N	\N	\N	\N	\N	INR	4	\N	done	2026-09-13 18:19:49.163252+05:30	\N	2026-09-13 18:19:49.163252+05:30	active	\N	\N	\N	\N	\N	\N	\N	\N	40701a49ead47b43bd93fa74f4f6b70ecef0e781ebfb7f8f
6a6a0000-0000-4000-8000-00000000d012	Yavar Technologies	yavar-tech	\N	\N	\N	\N	\N	INR	4	\N	done	2026-09-13 18:19:49.163252+05:30	\N	2026-09-13 18:19:49.163252+05:30	active	\N	\N	\N	\N	\N	\N	\N	\N	ca7a95317062b8448405a5fa3231fda3c8ba3ac175187b68
\.


--
-- Data for Name: platform_admins; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.platform_admins (id, email, user_id, note, created_by, created_at) FROM stdin;
c16d7ffa-3183-4b1c-90f3-22ef0a38726f	madhu@demo.com	6a6a0000-0000-4000-8000-00000000d001	product owner (demo)	6a6a0000-0000-4000-8000-00000000d001	2026-09-13 18:19:49.165416+05:30
\.


--
-- Data for Name: product_catalogue_commercials; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.product_catalogue_commercials (module_id, tier, list_price, currency, unit, notes, updated_at, updated_by) FROM stdin;
\.


--
-- Data for Name: requisitions; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.requisitions (id, code, title, department_id, req_type, status, location, openings, experience_min, experience_max, budget_ctc, hiring_manager, must_have_skills, good_to_have_skills, responsibilities, education_requirement, weight_skills, weight_experience, weight_education, weight_social, approval_trail, opened_at, created_at, billing_type, engagement_type, client_name, cost_center, ijp_enabled, ijp_posted_at, ijp_notes, weight_career, weight_impact, ctc_band_min, ctc_band_max, max_notice_period_days, work_authorization_required, org_id, career_level) FROM stdin;
aaaaaaa1-0000-0000-0000-000000000001	REQ-2026-001	Senior Backend Engineer	11111111-1111-1111-1111-111111111111	new	approved	Bengaluru	2	5	9	3800000.00	Ananya Rao	{Python,PostgreSQL,AWS,"System Design",Kubernetes}	{Go,Kafka,Terraform}	Own backend services end to end, design scalable APIs, mentor engineers, drive reliability and cost efficiency.	B.E./B.Tech in Computer Science or equivalent	50	25	10	15	[]	2026-09-13 09:03:48.359818+05:30	2026-09-13 09:03:48.359818+05:30	non_billable	internal	\N	\N	f	\N	\N	10	10	\N	\N	\N	\N	6a6a0000-0000-4000-8000-00000000d011	\N
aaaaaaa1-0000-0000-0000-000000000002	REQ-2026-002	Enterprise Sales Manager	22222222-2222-2222-2222-222222222222	replacement	pending_hr	Mumbai	1	6	10	2900000.00	Vikram Mehta	{"Enterprise Sales",SaaS,Negotiation,CRM}	{"BFSI Domain","Solution Selling"}	Own the BFSI enterprise pipeline, lead RFP responses, close multi-year contracts.	MBA preferred	50	25	10	15	[]	2026-09-13 09:03:48.359818+05:30	2026-09-13 09:03:48.359818+05:30	non_billable	internal	\N	\N	f	\N	\N	10	10	\N	\N	\N	\N	6a6a0000-0000-4000-8000-00000000d011	\N
aaaaaaa1-0000-0000-0000-000000000003	REQ-2026-003	Data Platform Lead	11111111-1111-1111-1111-111111111111	new	pending_dh	Hyderabad	1	8	12	4500000.00	Ananya Rao	{Spark,Airflow,dbt,Snowflake,"Data Modeling"}	{Databricks,Streaming}	Build and lead the data platform team, own lakehouse architecture and governance.	B.Tech / M.Tech	50	25	10	15	[]	2026-09-13 09:03:48.359818+05:30	2026-09-13 09:03:48.359818+05:30	non_billable	internal	\N	\N	f	\N	\N	10	10	\N	\N	\N	\N	6a6a0000-0000-4000-8000-00000000d011	\N
c9dff802-8679-4ff1-b3cd-0fb4b7823cc9	YVR-AI-001	AI Platform Engineer	58ea99d6-0a11-482d-a28d-7d1ccbca6874	new	approved	Bengaluru / Remote	2	3	7	4000000.00	HR (Yavar)	{Python,FastAPI,Kubernetes}	{}	\N	B.E./B.Tech or higher in CS/AI	40	15	10	15	[]	2026-09-13 18:22:50.78556+05:30	2026-09-13 18:22:50.78556+05:30	non_billable	internal	\N	\N	f	\N	\N	10	10	\N	\N	\N	\N	6a6a0000-0000-4000-8000-00000000d012	\N
71f243e7-5e1f-4684-ab0a-0560f2c367c7	REQ-2026-001	Benchmark Probe Engineer	\N	new	pending_dh		1	3	6	3000000.00	\N	{}	{}	\N	\N	40	15	10	15	[]	2026-09-13 18:41:55.534217+05:30	2026-09-13 18:41:55.534217+05:30	Non-billable	Internal / Corporate	\N	\N	f	\N	\N	10	10	2200000.00	4000000.00	\N	\N	5e2e0000-0000-4000-8000-00000000e2e2	senior
4b24430f-0102-434f-be90-a416903583a1	REQ-2026-002	Benchmark Probe Engineer	\N	new	pending_dh		1	3	6	3000000.00	\N	{}	{}	\N	\N	40	15	10	15	[]	2026-09-13 18:52:59.657423+05:30	2026-09-13 18:52:59.657423+05:30	Non-billable	Internal / Corporate	\N	\N	f	\N	\N	10	10	2200000.00	4000000.00	\N	\N	5e2e0000-0000-4000-8000-00000000e2e2	senior
\.


--
-- Data for Name: salary_benchmarks; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.salary_benchmarks (id, org_id, requisition_id, input_key, title, location, experience_min, experience_max, currency, grounded, confidence, payload, provider, model, created_at) FROM stdin;
3ef76f7d-d561-4e91-b664-33be1cd87384	5e2e0000-0000-4000-8000-00000000e2e2	\N	706c50fcc55a697a00ed996c8aeb30adca785a8f	Benchmark Probe Engineer	Bengaluru	3	6	INR	t	high	{"notes": "Seeded e2e fixture — not real market data.", "levels": [{"key": "intern", "low": 180000, "high": 320000, "label": "Intern", "median": 240000, "expBand": {"max": 2, "min": 0, "label": "0–2 yrs"}, "sources": [], "confidence": "medium"}, {"key": "junior", "low": 450000, "high": 900000, "label": "Junior", "median": 650000, "expBand": {"max": 2, "min": 0, "label": "0–2 yrs"}, "sources": [{"url": "https://example.com/salary", "title": "Example Salary Data"}], "confidence": "high"}, {"key": "mid", "low": 1200000, "high": 2100000, "label": "Mid", "median": 1600000, "expBand": {"max": 5, "min": 3, "label": "3–5 yrs"}, "sources": [{"url": "https://example.com/salary", "title": "Example Salary Data"}], "confidence": "high"}, {"key": "senior", "low": 2200000, "high": 4000000, "label": "Senior", "median": 3000000, "expBand": {"max": 9, "min": 6, "label": "6–9 yrs"}, "sources": [{"url": "https://example.com/salary", "title": "Example Salary Data"}], "confidence": "high"}, {"key": "lead", "low": 3200000, "high": 5600000, "label": "Lead", "median": 4200000, "expBand": {"max": 15, "min": 10, "label": "10–15 yrs"}, "sources": [], "confidence": "medium"}, {"key": "manager", "low": 3500000, "high": 6200000, "label": "Manager", "median": 4600000, "expBand": {"max": 15, "min": 10, "label": "10–15 yrs"}, "sources": [], "confidence": "medium"}, {"key": "director", "low": 5000000, "high": 9500000, "label": "Director", "median": 7000000, "expBand": {"max": 40, "min": 15, "label": "15+ yrs"}, "sources": [], "confidence": "low"}, {"key": "vp_head", "low": 6500000, "high": 13000000, "label": "VP / Head", "median": 9000000, "expBand": {"max": 40, "min": 15, "label": "15+ yrs"}, "sources": [], "confidence": "low"}], "currency": "INR", "grounded": true}	anthropic	claude-sonnet-4-5	2026-09-13 18:37:39.967391+05:30
\.


--
-- Data for Name: screening_kits; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.screening_kits (id, org_id, candidate_id, requisition_id, application_id, questions, focus_summary, engine, created_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: screening_runs; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.screening_runs (id, org_id, kit_id, candidate_id, requisition_id, application_id, input_kind, answers, transcript, audio_path, audio_engine, screening_score, match_score, combined_score, verdicts, red_flags, rationale, recommendation, recommendation_reason, engine, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.sessions (id, user_id, token_hash, expires_at, created_at, last_used_at, user_agent, ip) FROM stdin;
\.


--
-- Data for Name: skill_edges; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.skill_edges (id, org_id, from_slug, to_slug, kind, weight, evidence_count, updated_at) FROM stdin;
\.


--
-- Data for Name: skill_evidence; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.skill_evidence (id, org_id, slug, candidate_id, requisition_id, source, strength, observed_at, created_at) FROM stdin;
\.


--
-- Data for Name: skill_nodes; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.skill_nodes (id, org_id, slug, name, category, aliases, parent_slug, supply, demand, validated, evidence_count, status, first_seen_at, last_seen_at, updated_at) FROM stdin;
\.


--
-- Data for Name: social_profiles; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.social_profiles (id, candidate_id, provider, profile_url, handle, score, signals, rationale, raw, status, fetched_at, last_synced_at, org_id) FROM stdin;
a98fc22e-e6f4-4809-805d-44ef01cf2dc5	bbbbbbb1-0000-0000-0000-000000000001	github	https://github.com/torvalds	torvalds	74	{"followers": 210, "public_repos": 8, "top_languages": ["Python", "Go"], "active_months_12": 7}	Consistent but bursty contribution pattern; repositories align with backend and infrastructure work.	\N	ok	2026-09-13 09:03:48.363459+05:30	\N	6a6a0000-0000-4000-8000-00000000d011
4b4d546f-a9b2-40d0-bf00-5f8bd9e96499	bbbbbbb1-0000-0000-0000-000000000001	linkedin	https://www.linkedin.com/in/priyasharma	priyasharma	70	{"progression": "steady", "tenure_stability": "good", "headline_alignment": "high"}	Steady progression with 2.5 year average tenure and a headline that maps directly to the JD.	\N	ok	2026-09-13 09:03:48.363459+05:30	\N	6a6a0000-0000-4000-8000-00000000d011
8200527d-5a6b-46ee-86da-70f81db97ff9	bbbbbbb1-0000-0000-0000-000000000003	github	https://github.com/sindresorhus	sindresorhus	96	{"followers": 1800, "public_repos": 42, "top_languages": ["Go", "Python", "TypeScript"], "active_months_12": 12}	Sustained monthly contribution across 12 months, widely used OSS libraries, strong peer following.	\N	ok	2026-09-13 09:03:48.363459+05:30	\N	6a6a0000-0000-4000-8000-00000000d011
c668e38d-7d06-4cd8-9941-357006cb5218	bbbbbbb1-0000-0000-0000-000000000003	linkedin	https://www.linkedin.com/in/nehaiyer	nehaiyer	88	{"progression": "fast", "tenure_stability": "strong", "headline_alignment": "high"}	Fast progression to staff level with long tenures and public speaking record.	\N	ok	2026-09-13 09:03:48.363459+05:30	\N	6a6a0000-0000-4000-8000-00000000d011
04d4f957-b1b0-458f-a7c6-07577300ac4e	bbbbbbb1-0000-0000-0000-000000000002	github	https://github.com/gaearon	gaearon	44	{"followers": 12, "public_repos": 5, "top_languages": ["Python"], "active_months_12": 2}	Sparse public activity; little evidence of infrastructure or scale work.	\N	ok	2026-09-13 09:03:48.363459+05:30	\N	6a6a0000-0000-4000-8000-00000000d011
\.


--
-- Data for Name: source_integrations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.source_integrations (id, provider, label, enabled, config, credential_fields, has_credentials, last_test_status, last_test_message, last_tested_at, updated_at, created_at, category, org_id) FROM stdin;
f2d5de75-e603-47cf-a3cb-ea1d3bd118df	linkedin	LinkedIn Talent Solutions	f	{"docs": "https://learn.microsoft.com/linkedin/talent/", "notes": "Recruiter System Connect / Job Postings API. Candidate profiles cannot be read via the public API."}	{client_id,client_secret}	f	untested	\N	\N	2026-09-13 09:03:48.38589+05:30	2026-09-13 09:03:48.38589+05:30	sourcing	\N
ae933204-a477-4d06-bd23-fa906da30a8c	naukri	Naukri Resdex / Recruiter API	f	{"docs": "https://www.naukri.com/recruiter", "notes": "Enterprise Resdex subscription required for resume search and applicant pulls."}	{client_id,client_secret,account_id}	f	untested	\N	\N	2026-09-13 09:03:48.38589+05:30	2026-09-13 09:03:48.38589+05:30	sourcing	\N
ea8f72e9-de83-47bc-bf58-20b0dbf2d931	indeed	Indeed Apply + Job Feed	f	{"docs": "https://docs.indeed.com/", "notes": "Job XML feed plus Indeed Apply webhook for applicants."}	{api_key,employer_id}	f	untested	\N	\N	2026-09-13 09:03:48.38589+05:30	2026-09-13 09:03:48.38589+05:30	sourcing	\N
1db3c191-467b-4dc1-85c5-fddf4f8444e5	github	GitHub Public API	t	{"docs": "https://docs.github.com/rest", "notes": "Token is optional; it raises the rate limit from 60 to 5000 requests/hour."}	{token}	f	ok	Built-in source — no credentials required.	\N	2026-09-13 09:03:48.38589+05:30	2026-09-13 09:03:48.38589+05:30	sourcing	\N
2db169c3-57d6-486b-ba0f-55d9c971507e	careers	Careers page / email applies	t	{"notes": "Always available. Candidates added manually or by resume paste."}	{}	f	ok	Built-in source — no credentials required.	\N	2026-09-13 09:03:48.38589+05:30	2026-09-13 09:03:48.38589+05:30	sourcing	\N
0695fec2-cd10-4bb8-a62f-594a3dc397d5	zoom	Zoom (meeting links)	f	{}	{account_id,client_id,client_secret}	f	untested	\N	\N	2026-09-13 09:03:48.580859+05:30	2026-09-13 09:03:48.580859+05:30	meeting	\N
606ea2b9-1703-45da-bf2b-c77c3e13dc3d	google_meet	Google Calendar / Meet	f	{}	{client_id,client_secret,refresh_token}	f	untested	\N	\N	2026-09-13 09:03:48.580859+05:30	2026-09-13 09:03:48.580859+05:30	meeting	\N
ad63bf09-b55f-40d5-8736-5c0bbe9f94c2	teams	Microsoft Teams	f	{}	{tenant_id,client_id,client_secret,organizer_email}	f	untested	\N	\N	2026-09-13 09:03:48.580859+05:30	2026-09-13 09:03:48.580859+05:30	meeting	\N
4f79e0d1-2d34-4036-9f80-b60c37a7a795	linkedin	LinkedIn Talent Solutions	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.929785+05:30	2026-09-15 07:32:50.929785+05:30	sourcing	6a6a0000-0000-4000-8000-00000000d011
ce26bff3-271a-4254-afb8-25a294cc17d1	naukri	Naukri Resdex / Recruiter API	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.929785+05:30	2026-09-15 07:32:50.929785+05:30	sourcing	6a6a0000-0000-4000-8000-00000000d011
fd36eb09-6bc3-49e6-8381-045e2c01db38	indeed	Indeed Apply + Job Feed	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.929785+05:30	2026-09-15 07:32:50.929785+05:30	sourcing	6a6a0000-0000-4000-8000-00000000d011
9269797f-ad70-4021-ae4a-cb1be3e969ec	github	GitHub Public API	t	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.929785+05:30	2026-09-15 07:32:50.929785+05:30	sourcing	6a6a0000-0000-4000-8000-00000000d011
1c5e98ac-cf7e-4219-9756-6d3cfc9e460b	careers	Careers page / email applies	t	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.929785+05:30	2026-09-15 07:32:50.929785+05:30	sourcing	6a6a0000-0000-4000-8000-00000000d011
fca68366-16e5-40a0-bead-ce67ccb8d49d	zoom	Zoom (meeting links)	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.929785+05:30	2026-09-15 07:32:50.929785+05:30	meeting	6a6a0000-0000-4000-8000-00000000d011
2acd1fbc-9629-4ddd-9e1f-f2b26f750348	google_meet	Google Calendar / Meet	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.929785+05:30	2026-09-15 07:32:50.929785+05:30	meeting	6a6a0000-0000-4000-8000-00000000d011
503e5d9b-0159-4e37-9c99-776c9e87ed39	teams	Microsoft Teams	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.929785+05:30	2026-09-15 07:32:50.929785+05:30	meeting	6a6a0000-0000-4000-8000-00000000d011
1cb115eb-6df0-4db3-8474-7bdc6915c57f	linkedin	LinkedIn Talent Solutions	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.933287+05:30	2026-09-15 07:32:50.933287+05:30	sourcing	6a6a0000-0000-4000-8000-00000000d012
fc90aed6-3f94-46ae-a166-775bd396267c	naukri	Naukri Resdex / Recruiter API	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.933287+05:30	2026-09-15 07:32:50.933287+05:30	sourcing	6a6a0000-0000-4000-8000-00000000d012
bed2950d-bc12-456f-9b19-ef7774b7571c	indeed	Indeed Apply + Job Feed	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.933287+05:30	2026-09-15 07:32:50.933287+05:30	sourcing	6a6a0000-0000-4000-8000-00000000d012
1929c8d4-9580-41f7-89f7-af52948fcc99	github	GitHub Public API	t	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.933287+05:30	2026-09-15 07:32:50.933287+05:30	sourcing	6a6a0000-0000-4000-8000-00000000d012
82e96c49-e2ed-4195-9bb3-da85f056c18e	careers	Careers page / email applies	t	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.933287+05:30	2026-09-15 07:32:50.933287+05:30	sourcing	6a6a0000-0000-4000-8000-00000000d012
2e8eadb6-ed2f-4b9b-ba32-389efff81be2	zoom	Zoom (meeting links)	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.933287+05:30	2026-09-15 07:32:50.933287+05:30	meeting	6a6a0000-0000-4000-8000-00000000d012
8238af17-3f3e-44ab-acfb-f84915be3908	google_meet	Google Calendar / Meet	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.933287+05:30	2026-09-15 07:32:50.933287+05:30	meeting	6a6a0000-0000-4000-8000-00000000d012
05164435-0399-4509-b395-e800888679ae	teams	Microsoft Teams	f	{}	{}	f	untested	\N	\N	2026-09-15 07:32:50.933287+05:30	2026-09-15 07:32:50.933287+05:30	meeting	6a6a0000-0000-4000-8000-00000000d012
\.


--
-- Data for Name: stage_events; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.stage_events (id, application_id, from_stage, to_stage, actor, reason, note, created_at, org_id) FROM stdin;
\.


--
-- Data for Name: talent_request_suggestions; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.talent_request_suggestions (id, org_id, request_id, candidate_id, suggested_by, note, status, created_at) FROM stdin;
\.


--
-- Data for Name: talent_requests; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.talent_requests (id, org_id, requisition_id, requester_id, title, skills, note, status, created_at, closed_at) FROM stdin;
\.


--
-- Data for Name: user_roles; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.user_roles (id, user_id, role, org_id) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.users (id, email, email_confirmed_at, password_hash, full_name, avatar_url, created_at, last_login_at) FROM stdin;
5e2e0000-0000-4000-8000-00000000e2e1	e2e-owner@atsiq-e2e.local	2026-09-13 18:34:09.995532+05:30	scrypt$16384$8$1$jgQ6U10qxhH0ZEg3-s8ikA$gFsF--y2pvdqF3-ptr3p2XsNn-ApNHjBLhL8pBv0g_aHXInxVBU5lC6v1ZEx3RFGIdeF3ZlTHd1vfWOCXEov1w	\N	\N	2026-09-13 18:34:09.995532+05:30	\N
6a6a0000-0000-4000-8000-00000000d001	madhu@demo.com	2026-09-13 18:34:09.995532+05:30	scrypt$16384$8$1$jBh6eHgR26bEAooyQ28Riw$YVQpJaIZ7Rb49pcuZkdW9PRXKvLmNMtXgxuYmKRkf58hj5pRTx3Jyuj1PVa8aEOBbj_D9ZKwUZK68pVdUNgZgQ	\N	\N	2026-09-13 18:34:09.995532+05:30	\N
6a6a0000-0000-4000-8000-00000000d002	hr@yavar.ai	2026-09-13 18:34:09.995532+05:30	scrypt$16384$8$1$jBh6eHgR26bEAooyQ28Riw$YVQpJaIZ7Rb49pcuZkdW9PRXKvLmNMtXgxuYmKRkf58hj5pRTx3Jyuj1PVa8aEOBbj_D9ZKwUZK68pVdUNgZgQ	\N	\N	2026-09-13 18:34:09.995532+05:30	\N
\.

COPY public.platform_admins (email, user_id, note) FROM stdin;
madhu@demo.com	6a6a0000-0000-4000-8000-00000000d001	local platform super-user
\.


--
-- Data for Name: buckets; Type: TABLE DATA; Schema: storage; Owner: postgres
--

COPY storage.buckets (id, name) FROM stdin;
resumes	resumes
\.


--
-- Data for Name: objects; Type: TABLE DATA; Schema: storage; Owner: postgres
--

COPY storage.objects (id, bucket_id, name, owner, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: auth; Owner: postgres
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: ai_interviews ai_interviews_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ai_interviews
    ADD CONSTRAINT ai_interviews_pkey PRIMARY KEY (id);


--
-- Name: ai_settings ai_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ai_settings
    ADD CONSTRAINT ai_settings_pkey PRIMARY KEY (id);


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);


--
-- Name: applications applications_requisition_id_candidate_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_requisition_id_candidate_id_key UNIQUE (requisition_id, candidate_id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: candidate_assessments candidate_assessments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_assessments
    ADD CONSTRAINT candidate_assessments_pkey PRIMARY KEY (id);


--
-- Name: candidate_assessments candidate_assessments_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_assessments
    ADD CONSTRAINT candidate_assessments_token_key UNIQUE (token);


--
-- Name: candidate_notes candidate_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_notes
    ADD CONSTRAINT candidate_notes_pkey PRIMARY KEY (id);


--
-- Name: candidate_ownership_events candidate_ownership_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_ownership_events
    ADD CONSTRAINT candidate_ownership_events_pkey PRIMARY KEY (id);


--
-- Name: candidate_referrals candidate_referrals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_referrals
    ADD CONSTRAINT candidate_referrals_pkey PRIMARY KEY (id);


--
-- Name: candidate_verifications candidate_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_verifications
    ADD CONSTRAINT candidate_verifications_pkey PRIMARY KEY (id);


--
-- Name: candidates candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_pkey PRIMARY KEY (id);


--
-- Name: capture_events capture_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.capture_events
    ADD CONSTRAINT capture_events_pkey PRIMARY KEY (id);


--
-- Name: copilot_messages copilot_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.copilot_messages
    ADD CONSTRAINT copilot_messages_pkey PRIMARY KEY (id);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: evaluations evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.evaluations
    ADD CONSTRAINT evaluations_pkey PRIMARY KEY (id);


--
-- Name: hr_incentive_schemes hr_incentive_schemes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hr_incentive_schemes
    ADD CONSTRAINT hr_incentive_schemes_pkey PRIMARY KEY (org_id);


--
-- Name: inbox_messages inbox_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inbox_messages
    ADD CONSTRAINT inbox_messages_pkey PRIMARY KEY (id);


--
-- Name: integration_credentials integration_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.integration_credentials
    ADD CONSTRAINT integration_credentials_pkey PRIMARY KEY (integration_id);


--
-- Name: interviews interviews_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interviews
    ADD CONSTRAINT interviews_pkey PRIMARY KEY (id);


--
-- Name: job_descriptions job_descriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_descriptions
    ADD CONSTRAINT job_descriptions_pkey PRIMARY KEY (id);


--
-- Name: linkedin_oauth_states linkedin_oauth_states_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.linkedin_oauth_states
    ADD CONSTRAINT linkedin_oauth_states_pkey PRIMARY KEY (id);


--
-- Name: master_items master_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.master_items
    ADD CONSTRAINT master_items_pkey PRIMARY KEY (id);


--
-- Name: match_scores match_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_scores
    ADD CONSTRAINT match_scores_pkey PRIMARY KEY (id);


--
-- Name: offers offers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_pkey PRIMARY KEY (id);


--
-- Name: ontology_snapshots ontology_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ontology_snapshots
    ADD CONSTRAINT ontology_snapshots_pkey PRIMARY KEY (id);


--
-- Name: org_linkedin_connections org_linkedin_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.org_linkedin_connections
    ADD CONSTRAINT org_linkedin_connections_pkey PRIMARY KEY (org_id);


--
-- Name: org_members org_members_org_id_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_org_id_email_key UNIQUE (org_id, email);


--
-- Name: org_members org_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_pkey PRIMARY KEY (id);


--
-- Name: org_pool_shares org_pool_shares_owner_org_partner_org_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.org_pool_shares
    ADD CONSTRAINT org_pool_shares_owner_org_partner_org_key UNIQUE (owner_org, partner_org);


--
-- Name: org_pool_shares org_pool_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.org_pool_shares
    ADD CONSTRAINT org_pool_shares_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_slug_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_key UNIQUE (slug);


--
-- Name: platform_admins platform_admins_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_email_key UNIQUE (email);


--
-- Name: platform_admins platform_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_pkey PRIMARY KEY (id);


--
-- Name: product_catalogue_commercials product_catalogue_commercials_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_catalogue_commercials
    ADD CONSTRAINT product_catalogue_commercials_pkey PRIMARY KEY (module_id);


--
-- Name: requisitions requisitions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.requisitions
    ADD CONSTRAINT requisitions_pkey PRIMARY KEY (id);


--
-- Name: salary_benchmarks salary_benchmarks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.salary_benchmarks
    ADD CONSTRAINT salary_benchmarks_pkey PRIMARY KEY (id);


--
-- Name: screening_kits screening_kits_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.screening_kits
    ADD CONSTRAINT screening_kits_pkey PRIMARY KEY (id);


--
-- Name: screening_runs screening_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.screening_runs
    ADD CONSTRAINT screening_runs_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: skill_edges skill_edges_org_id_from_slug_to_slug_kind_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_edges
    ADD CONSTRAINT skill_edges_org_id_from_slug_to_slug_kind_key UNIQUE (org_id, from_slug, to_slug, kind);


--
-- Name: skill_edges skill_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_edges
    ADD CONSTRAINT skill_edges_pkey PRIMARY KEY (id);


--
-- Name: skill_evidence skill_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_evidence
    ADD CONSTRAINT skill_evidence_pkey PRIMARY KEY (id);


--
-- Name: skill_nodes skill_nodes_org_id_slug_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_nodes
    ADD CONSTRAINT skill_nodes_org_id_slug_key UNIQUE (org_id, slug);


--
-- Name: skill_nodes skill_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_nodes
    ADD CONSTRAINT skill_nodes_pkey PRIMARY KEY (id);


--
-- Name: social_profiles social_profiles_candidate_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.social_profiles
    ADD CONSTRAINT social_profiles_candidate_id_provider_key UNIQUE (candidate_id, provider);


--
-- Name: social_profiles social_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.social_profiles
    ADD CONSTRAINT social_profiles_pkey PRIMARY KEY (id);


--
-- Name: source_integrations source_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.source_integrations
    ADD CONSTRAINT source_integrations_pkey PRIMARY KEY (id);


--
-- Name: stage_events stage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.stage_events
    ADD CONSTRAINT stage_events_pkey PRIMARY KEY (id);


--
-- Name: talent_request_suggestions talent_request_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.talent_request_suggestions
    ADD CONSTRAINT talent_request_suggestions_pkey PRIMARY KEY (id);


--
-- Name: talent_request_suggestions talent_request_suggestions_request_id_candidate_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.talent_request_suggestions
    ADD CONSTRAINT talent_request_suggestions_request_id_candidate_id_key UNIQUE (request_id, candidate_id);


--
-- Name: talent_requests talent_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.talent_requests
    ADD CONSTRAINT talent_requests_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: buckets buckets_pkey; Type: CONSTRAINT; Schema: storage; Owner: postgres
--

ALTER TABLE ONLY storage.buckets
    ADD CONSTRAINT buckets_pkey PRIMARY KEY (id);


--
-- Name: objects objects_pkey; Type: CONSTRAINT; Schema: storage; Owner: postgres
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);


--
-- Name: ai_interviews_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ai_interviews_org_idx ON public.ai_interviews USING btree (org_id);


--
-- Name: ai_provider_credentials_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ai_provider_credentials_org_idx ON public.ai_provider_credentials USING btree (org_id);


--
-- Name: ai_provider_credentials_org_provider_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX ai_provider_credentials_org_provider_key ON public.ai_provider_credentials USING btree (org_id, provider);


--
-- Name: ai_settings_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ai_settings_org_idx ON public.ai_settings USING btree (org_id);


--
-- Name: ai_settings_org_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX ai_settings_org_key ON public.ai_settings USING btree (org_id);


--
-- Name: applications_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX applications_org_idx ON public.applications USING btree (org_id);


--
-- Name: audit_log_org_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX audit_log_org_created_idx ON public.audit_log USING btree (org_id, created_at);


--
-- Name: candidate_assessments_candidate_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX candidate_assessments_candidate_idx ON public.candidate_assessments USING btree (candidate_id, created_at DESC);


--
-- Name: candidate_assessments_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX candidate_assessments_org_idx ON public.candidate_assessments USING btree (org_id);


--
-- Name: candidate_notes_candidate_id_created_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX candidate_notes_candidate_id_created_at_idx ON public.candidate_notes USING btree (candidate_id, created_at DESC);


--
-- Name: candidate_ownership_events_candidate_id_created_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX candidate_ownership_events_candidate_id_created_at_idx ON public.candidate_ownership_events USING btree (candidate_id, created_at DESC);


--
-- Name: candidate_referrals_candidate_id_created_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX candidate_referrals_candidate_id_created_at_idx ON public.candidate_referrals USING btree (candidate_id, created_at DESC);


--
-- Name: candidate_referrals_org_id_to_user_status_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX candidate_referrals_org_id_to_user_status_idx ON public.candidate_referrals USING btree (org_id, to_user, status);


--
-- Name: candidate_verifications_candidate_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX candidate_verifications_candidate_idx ON public.candidate_verifications USING btree (candidate_id, created_at DESC);


--
-- Name: candidate_verifications_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX candidate_verifications_org_idx ON public.candidate_verifications USING btree (org_id);


--
-- Name: candidates_external_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX candidates_external_unique ON public.candidates USING btree (external_provider, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: candidates_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX candidates_org_idx ON public.candidates USING btree (org_id);


--
-- Name: candidates_owner_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX candidates_owner_idx ON public.candidates USING btree (org_id, owner_id);


--
-- Name: candidates_skills_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX candidates_skills_idx ON public.candidates USING gin (skills);


--
-- Name: capture_events_org_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX capture_events_org_created_idx ON public.capture_events USING btree (org_id, created_at DESC);


--
-- Name: copilot_messages_user_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX copilot_messages_user_idx ON public.copilot_messages USING btree (user_id, created_at);


--
-- Name: departments_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX departments_org_idx ON public.departments USING btree (org_id);


--
-- Name: departments_org_name_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX departments_org_name_key ON public.departments USING btree (org_id, name);


--
-- Name: evaluations_interview_id_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX evaluations_interview_id_key ON public.evaluations USING btree (interview_id) WHERE (interview_id IS NOT NULL);


--
-- Name: evaluations_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX evaluations_org_idx ON public.evaluations USING btree (org_id);


--
-- Name: inbox_messages_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX inbox_messages_org_idx ON public.inbox_messages USING btree (org_id, received_at DESC);


--
-- Name: inbox_messages_provider_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX inbox_messages_provider_key ON public.inbox_messages USING btree (org_id, provider_message_id) WHERE (provider_message_id IS NOT NULL);


--
-- Name: integration_credentials_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX integration_credentials_org_idx ON public.integration_credentials USING btree (org_id);


--
-- Name: interviews_interviewer_email_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX interviews_interviewer_email_idx ON public.interviews USING btree (lower(interviewer_email));


--
-- Name: interviews_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX interviews_org_idx ON public.interviews USING btree (org_id);


--
-- Name: job_descriptions_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX job_descriptions_org_idx ON public.job_descriptions USING btree (org_id);


--
-- Name: linkedin_oauth_states_expires_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX linkedin_oauth_states_expires_at_idx ON public.linkedin_oauth_states USING btree (expires_at);


--
-- Name: master_items_kind_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX master_items_kind_idx ON public.master_items USING btree (kind, active);


--
-- Name: master_items_kind_name_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX master_items_kind_name_unique ON public.master_items USING btree (org_id, kind, lower(name));


--
-- Name: master_items_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX master_items_org_idx ON public.master_items USING btree (org_id);


--
-- Name: match_scores_application_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX match_scores_application_id_idx ON public.match_scores USING btree (application_id);


--
-- Name: match_scores_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX match_scores_org_idx ON public.match_scores USING btree (org_id);


--
-- Name: offers_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX offers_org_idx ON public.offers USING btree (org_id);


--
-- Name: ontology_snapshots_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ontology_snapshots_org_idx ON public.ontology_snapshots USING btree (org_id, created_at DESC);


--
-- Name: org_members_email_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX org_members_email_idx ON public.org_members USING btree (lower(email));


--
-- Name: org_members_org_user_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX org_members_org_user_key ON public.org_members USING btree (org_id, user_id) WHERE (user_id IS NOT NULL);


--
-- Name: org_members_user_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX org_members_user_idx ON public.org_members USING btree (user_id);


--
-- Name: organizations_capture_token_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX organizations_capture_token_key ON public.organizations USING btree (capture_token);


--
-- Name: organizations_careers_email_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX organizations_careers_email_key ON public.organizations USING btree (lower(careers_email)) WHERE (careers_email IS NOT NULL);


--
-- Name: organizations_email_domain_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX organizations_email_domain_idx ON public.organizations USING btree (email_domain) WHERE (email_domain IS NOT NULL);


--
-- Name: organizations_inbox_slug_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX organizations_inbox_slug_key ON public.organizations USING btree (lower(inbox_slug)) WHERE (inbox_slug IS NOT NULL);


--
-- Name: organizations_status_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX organizations_status_idx ON public.organizations USING btree (status);


--
-- Name: platform_admins_email_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX platform_admins_email_idx ON public.platform_admins USING btree (lower(email));


--
-- Name: requisitions_org_code_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX requisitions_org_code_key ON public.requisitions USING btree (org_id, code);


--
-- Name: requisitions_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX requisitions_org_idx ON public.requisitions USING btree (org_id);


--
-- Name: salary_benchmarks_org_input_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX salary_benchmarks_org_input_idx ON public.salary_benchmarks USING btree (org_id, input_key, created_at);


--
-- Name: screening_kits_candidate_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX screening_kits_candidate_idx ON public.screening_kits USING btree (candidate_id, created_at DESC);


--
-- Name: screening_kits_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX screening_kits_org_idx ON public.screening_kits USING btree (org_id);


--
-- Name: screening_runs_candidate_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX screening_runs_candidate_idx ON public.screening_runs USING btree (candidate_id, created_at DESC);


--
-- Name: screening_runs_kit_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX screening_runs_kit_idx ON public.screening_runs USING btree (kit_id, created_at DESC);


--
-- Name: screening_runs_org_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX screening_runs_org_created_idx ON public.screening_runs USING btree (org_id, created_at DESC);


--
-- Name: sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_token_hash_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX sessions_token_hash_key ON public.sessions USING btree (token_hash);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: skill_edges_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX skill_edges_org_idx ON public.skill_edges USING btree (org_id, from_slug);


--
-- Name: skill_evidence_org_slug_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX skill_evidence_org_slug_idx ON public.skill_evidence USING btree (org_id, slug);


--
-- Name: skill_nodes_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX skill_nodes_org_idx ON public.skill_nodes USING btree (org_id, status);


--
-- Name: social_profiles_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX social_profiles_org_idx ON public.social_profiles USING btree (org_id);


--
-- Name: source_integrations_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX source_integrations_org_idx ON public.source_integrations USING btree (org_id);


--
-- Name: source_integrations_org_provider_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX source_integrations_org_provider_key ON public.source_integrations USING btree (org_id, provider);


--
-- Name: stage_events_application_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX stage_events_application_idx ON public.stage_events USING btree (application_id, created_at DESC);


--
-- Name: stage_events_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX stage_events_org_idx ON public.stage_events USING btree (org_id);


--
-- Name: talent_request_suggestions_request_id_created_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX talent_request_suggestions_request_id_created_at_idx ON public.talent_request_suggestions USING btree (request_id, created_at DESC);


--
-- Name: talent_requests_org_id_status_created_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX talent_requests_org_id_status_created_at_idx ON public.talent_requests USING btree (org_id, status, created_at DESC);


--
-- Name: user_roles_org_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX user_roles_org_idx ON public.user_roles USING btree (org_id);


--
-- Name: user_roles_org_user_role_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX user_roles_org_user_role_key ON public.user_roles USING btree (org_id, user_id, role);


--
-- Name: users_email_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);


--
-- Name: ai_interviews ai_interviews_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER ai_interviews_fill_org BEFORE INSERT ON public.ai_interviews FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('applications', 'application_id');


--
-- Name: applications applications_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER applications_fill_org BEFORE INSERT ON public.applications FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('requisitions', 'requisition_id');


--
-- Name: candidate_assessments candidate_assessments_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER candidate_assessments_fill_org BEFORE INSERT ON public.candidate_assessments FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('candidates', 'candidate_id');


--
-- Name: candidate_notes candidate_notes_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER candidate_notes_fill_org BEFORE INSERT ON public.candidate_notes FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('candidates', 'candidate_id');


--
-- Name: candidate_ownership_events candidate_ownership_events_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER candidate_ownership_events_fill_org BEFORE INSERT ON public.candidate_ownership_events FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('candidates', 'candidate_id');


--
-- Name: candidate_referrals candidate_referrals_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER candidate_referrals_fill_org BEFORE INSERT ON public.candidate_referrals FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('candidates', 'candidate_id');


--
-- Name: candidate_verifications candidate_verifications_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER candidate_verifications_fill_org BEFORE INSERT ON public.candidate_verifications FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('candidates', 'candidate_id');


--
-- Name: evaluations evaluations_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER evaluations_fill_org BEFORE INSERT ON public.evaluations FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('applications', 'application_id');


--
-- Name: integration_credentials integration_credentials_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER integration_credentials_fill_org BEFORE INSERT ON public.integration_credentials FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('source_integrations', 'integration_id');


--
-- Name: interviews interviews_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER interviews_fill_org BEFORE INSERT ON public.interviews FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('applications', 'application_id');


--
-- Name: job_descriptions job_descriptions_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER job_descriptions_fill_org BEFORE INSERT ON public.job_descriptions FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('requisitions', 'requisition_id');


--
-- Name: match_scores match_scores_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER match_scores_fill_org BEFORE INSERT ON public.match_scores FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('applications', 'application_id');


--
-- Name: offers offers_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER offers_fill_org BEFORE INSERT ON public.offers FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('applications', 'application_id');


--
-- Name: screening_kits screening_kits_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER screening_kits_fill_org BEFORE INSERT ON public.screening_kits FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('candidates', 'candidate_id');


--
-- Name: screening_runs screening_runs_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER screening_runs_fill_org BEFORE INSERT ON public.screening_runs FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('candidates', 'candidate_id');


--
-- Name: social_profiles social_profiles_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER social_profiles_fill_org BEFORE INSERT ON public.social_profiles FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('candidates', 'candidate_id');


--
-- Name: stage_events stage_events_fill_org; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER stage_events_fill_org BEFORE INSERT ON public.stage_events FOR EACH ROW EXECUTE FUNCTION public.fill_org_from_parent('applications', 'application_id');


--
-- Name: ai_interviews ai_interviews_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ai_interviews
    ADD CONSTRAINT ai_interviews_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: ai_interviews ai_interviews_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ai_interviews
    ADD CONSTRAINT ai_interviews_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: ai_provider_credentials ai_provider_credentials_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ai_provider_credentials
    ADD CONSTRAINT ai_provider_credentials_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: ai_settings ai_settings_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ai_settings
    ADD CONSTRAINT ai_settings_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: applications applications_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: applications applications_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: applications applications_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES public.requisitions(id) ON DELETE CASCADE;


--
-- Name: candidate_assessments candidate_assessments_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_assessments
    ADD CONSTRAINT candidate_assessments_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: candidate_assessments candidate_assessments_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_assessments
    ADD CONSTRAINT candidate_assessments_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: candidate_assessments candidate_assessments_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_assessments
    ADD CONSTRAINT candidate_assessments_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES public.requisitions(id) ON DELETE SET NULL;


--
-- Name: candidate_notes candidate_notes_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_notes
    ADD CONSTRAINT candidate_notes_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: candidate_notes candidate_notes_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_notes
    ADD CONSTRAINT candidate_notes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: candidate_ownership_events candidate_ownership_events_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_ownership_events
    ADD CONSTRAINT candidate_ownership_events_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: candidate_ownership_events candidate_ownership_events_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_ownership_events
    ADD CONSTRAINT candidate_ownership_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: candidate_referrals candidate_referrals_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_referrals
    ADD CONSTRAINT candidate_referrals_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: candidate_referrals candidate_referrals_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_referrals
    ADD CONSTRAINT candidate_referrals_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: candidate_referrals candidate_referrals_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_referrals
    ADD CONSTRAINT candidate_referrals_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES public.requisitions(id) ON DELETE SET NULL;


--
-- Name: candidate_verifications candidate_verifications_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_verifications
    ADD CONSTRAINT candidate_verifications_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: candidate_verifications candidate_verifications_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidate_verifications
    ADD CONSTRAINT candidate_verifications_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: candidates candidates_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: capture_events capture_events_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.capture_events
    ADD CONSTRAINT capture_events_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE SET NULL;


--
-- Name: capture_events capture_events_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.capture_events
    ADD CONSTRAINT capture_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: capture_events capture_events_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.capture_events
    ADD CONSTRAINT capture_events_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES public.requisitions(id) ON DELETE SET NULL;


--
-- Name: copilot_messages copilot_messages_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.copilot_messages
    ADD CONSTRAINT copilot_messages_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: departments departments_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: evaluations evaluations_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.evaluations
    ADD CONSTRAINT evaluations_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: evaluations evaluations_interview_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.evaluations
    ADD CONSTRAINT evaluations_interview_id_fkey FOREIGN KEY (interview_id) REFERENCES public.interviews(id) ON DELETE SET NULL;


--
-- Name: evaluations evaluations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.evaluations
    ADD CONSTRAINT evaluations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: hr_incentive_schemes hr_incentive_schemes_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hr_incentive_schemes
    ADD CONSTRAINT hr_incentive_schemes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: inbox_messages inbox_messages_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inbox_messages
    ADD CONSTRAINT inbox_messages_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: integration_credentials integration_credentials_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.integration_credentials
    ADD CONSTRAINT integration_credentials_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.source_integrations(id) ON DELETE CASCADE;


--
-- Name: integration_credentials integration_credentials_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.integration_credentials
    ADD CONSTRAINT integration_credentials_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: interviews interviews_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interviews
    ADD CONSTRAINT interviews_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: interviews interviews_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interviews
    ADD CONSTRAINT interviews_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: job_descriptions job_descriptions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_descriptions
    ADD CONSTRAINT job_descriptions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: job_descriptions job_descriptions_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_descriptions
    ADD CONSTRAINT job_descriptions_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES public.requisitions(id) ON DELETE CASCADE;


--
-- Name: linkedin_oauth_states linkedin_oauth_states_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.linkedin_oauth_states
    ADD CONSTRAINT linkedin_oauth_states_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: master_items master_items_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.master_items
    ADD CONSTRAINT master_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: match_scores match_scores_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_scores
    ADD CONSTRAINT match_scores_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: match_scores match_scores_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.match_scores
    ADD CONSTRAINT match_scores_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: offers offers_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: offers offers_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: ontology_snapshots ontology_snapshots_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ontology_snapshots
    ADD CONSTRAINT ontology_snapshots_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_linkedin_connections org_linkedin_connections_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.org_linkedin_connections
    ADD CONSTRAINT org_linkedin_connections_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: org_pool_shares org_pool_shares_owner_org_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.org_pool_shares
    ADD CONSTRAINT org_pool_shares_owner_org_fkey FOREIGN KEY (owner_org) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_pool_shares org_pool_shares_partner_org_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.org_pool_shares
    ADD CONSTRAINT org_pool_shares_partner_org_fkey FOREIGN KEY (partner_org) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: requisitions requisitions_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.requisitions
    ADD CONSTRAINT requisitions_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;


--
-- Name: requisitions requisitions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.requisitions
    ADD CONSTRAINT requisitions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: salary_benchmarks salary_benchmarks_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.salary_benchmarks
    ADD CONSTRAINT salary_benchmarks_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: salary_benchmarks salary_benchmarks_requisition_id_requisitions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.salary_benchmarks
    ADD CONSTRAINT salary_benchmarks_requisition_id_requisitions_id_fk FOREIGN KEY (requisition_id) REFERENCES public.requisitions(id) ON DELETE SET NULL;


--
-- Name: screening_kits screening_kits_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.screening_kits
    ADD CONSTRAINT screening_kits_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: screening_kits screening_kits_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.screening_kits
    ADD CONSTRAINT screening_kits_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: screening_kits screening_kits_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.screening_kits
    ADD CONSTRAINT screening_kits_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: screening_kits screening_kits_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.screening_kits
    ADD CONSTRAINT screening_kits_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES public.requisitions(id) ON DELETE SET NULL;


--
-- Name: screening_runs screening_runs_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.screening_runs
    ADD CONSTRAINT screening_runs_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: screening_runs screening_runs_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.screening_runs
    ADD CONSTRAINT screening_runs_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: screening_runs screening_runs_kit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.screening_runs
    ADD CONSTRAINT screening_runs_kit_id_fkey FOREIGN KEY (kit_id) REFERENCES public.screening_kits(id) ON DELETE CASCADE;


--
-- Name: screening_runs screening_runs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.screening_runs
    ADD CONSTRAINT screening_runs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: screening_runs screening_runs_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.screening_runs
    ADD CONSTRAINT screening_runs_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES public.requisitions(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: skill_edges skill_edges_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_edges
    ADD CONSTRAINT skill_edges_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: skill_evidence skill_evidence_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_evidence
    ADD CONSTRAINT skill_evidence_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: skill_evidence skill_evidence_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_evidence
    ADD CONSTRAINT skill_evidence_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: skill_evidence skill_evidence_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_evidence
    ADD CONSTRAINT skill_evidence_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES public.requisitions(id) ON DELETE CASCADE;


--
-- Name: skill_nodes skill_nodes_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_nodes
    ADD CONSTRAINT skill_nodes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: social_profiles social_profiles_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.social_profiles
    ADD CONSTRAINT social_profiles_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: social_profiles social_profiles_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.social_profiles
    ADD CONSTRAINT social_profiles_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: source_integrations source_integrations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.source_integrations
    ADD CONSTRAINT source_integrations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: stage_events stage_events_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.stage_events
    ADD CONSTRAINT stage_events_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: stage_events stage_events_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.stage_events
    ADD CONSTRAINT stage_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: talent_request_suggestions talent_request_suggestions_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.talent_request_suggestions
    ADD CONSTRAINT talent_request_suggestions_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: talent_request_suggestions talent_request_suggestions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.talent_request_suggestions
    ADD CONSTRAINT talent_request_suggestions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: talent_request_suggestions talent_request_suggestions_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.talent_request_suggestions
    ADD CONSTRAINT talent_request_suggestions_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.talent_requests(id) ON DELETE CASCADE;


--
-- Name: talent_requests talent_requests_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.talent_requests
    ADD CONSTRAINT talent_requests_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: talent_requests talent_requests_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.talent_requests
    ADD CONSTRAINT talent_requests_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES public.requisitions(id) ON DELETE SET NULL;


--
-- Name: user_roles user_roles_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_interviews; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.ai_interviews ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_provider_credentials; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.ai_provider_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_settings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.ai_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: organizations anyone creates an org; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "anyone creates an org" ON public.organizations FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: applications; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;

--
-- Name: candidate_assessments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.candidate_assessments ENABLE ROW LEVEL SECURITY;

--
-- Name: candidate_notes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.candidate_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: candidate_ownership_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.candidate_ownership_events ENABLE ROW LEVEL SECURITY;

--
-- Name: candidate_referrals; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.candidate_referrals ENABLE ROW LEVEL SECURITY;

--
-- Name: candidate_verifications; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.candidate_verifications ENABLE ROW LEVEL SECURITY;

--
-- Name: candidates; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.candidates ENABLE ROW LEVEL SECURITY;

--
-- Name: capture_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.capture_events ENABLE ROW LEVEL SECURITY;

--
-- Name: candidates consortium partners read shared candidates; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "consortium partners read shared candidates" ON public.candidates FOR SELECT TO authenticated USING (public.shares_pool_with_me(org_id));


--
-- Name: copilot_messages; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.copilot_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: departments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

--
-- Name: org_pool_shares either side creates shares; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "either side creates shares" ON public.org_pool_shares FOR INSERT TO authenticated WITH CHECK ((public.is_org_member(owner_org) OR public.is_org_member(partner_org)));


--
-- Name: org_pool_shares either side deletes shares; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "either side deletes shares" ON public.org_pool_shares FOR DELETE TO authenticated USING ((public.is_org_member(owner_org) OR public.is_org_member(partner_org)));


--
-- Name: org_pool_shares either side reads shares; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "either side reads shares" ON public.org_pool_shares FOR SELECT TO authenticated USING ((public.is_org_member(owner_org) OR public.is_org_member(partner_org)));


--
-- Name: org_pool_shares either side updates shares; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "either side updates shares" ON public.org_pool_shares FOR UPDATE TO authenticated USING ((public.is_org_member(owner_org) OR public.is_org_member(partner_org)));


--
-- Name: evaluations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.evaluations ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_incentive_schemes hr_incentive_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY hr_incentive_delete ON public.hr_incentive_schemes FOR DELETE TO authenticated USING (public.is_org_owner(org_id));


--
-- Name: hr_incentive_schemes hr_incentive_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY hr_incentive_insert ON public.hr_incentive_schemes FOR INSERT TO authenticated WITH CHECK ((public.is_org_owner(org_id) OR public.has_org_role(auth.uid(), org_id, 'president_cbo'::public.app_role) OR public.has_org_role(auth.uid(), org_id, 'hr_head'::public.app_role)));


--
-- Name: hr_incentive_schemes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.hr_incentive_schemes ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_incentive_schemes hr_incentive_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY hr_incentive_select ON public.hr_incentive_schemes FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: hr_incentive_schemes hr_incentive_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY hr_incentive_update ON public.hr_incentive_schemes FOR UPDATE TO authenticated USING ((public.is_org_owner(org_id) OR public.has_org_role(auth.uid(), org_id, 'president_cbo'::public.app_role) OR public.has_org_role(auth.uid(), org_id, 'hr_head'::public.app_role)));


--
-- Name: inbox_messages; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.inbox_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_credentials; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.integration_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: interviews; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.interviews ENABLE ROW LEVEL SECURITY;

--
-- Name: job_descriptions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.job_descriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: linkedin_oauth_states; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.linkedin_oauth_states ENABLE ROW LEVEL SECURITY;

--
-- Name: master_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.master_items ENABLE ROW LEVEL SECURITY;

--
-- Name: match_scores; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.match_scores ENABLE ROW LEVEL SECURITY;

--
-- Name: skill_edges members delete skill edges; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members delete skill edges" ON public.skill_edges FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: skill_evidence members delete skill evidence; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members delete skill evidence" ON public.skill_evidence FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: skill_nodes members delete skill nodes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members delete skill nodes" ON public.skill_nodes FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: ontology_snapshots members read ontology snapshots; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members read ontology snapshots" ON public.ontology_snapshots FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: organizations members read own org; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members read own org" ON public.organizations FOR SELECT TO authenticated USING (public.is_org_member(id));


--
-- Name: org_members members read roster; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members read roster" ON public.org_members FOR SELECT TO authenticated USING ((public.is_org_member(org_id) OR (user_id = auth.uid()) OR (lower(email) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text)))));


--
-- Name: skill_edges members read skill edges; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members read skill edges" ON public.skill_edges FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: skill_evidence members read skill evidence; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members read skill evidence" ON public.skill_evidence FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: skill_nodes members read skill nodes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members read skill nodes" ON public.skill_nodes FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: skill_edges members update skill edges; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members update skill edges" ON public.skill_edges FOR UPDATE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: skill_evidence members update skill evidence; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members update skill evidence" ON public.skill_evidence FOR UPDATE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: skill_nodes members update skill nodes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members update skill nodes" ON public.skill_nodes FOR UPDATE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: ontology_snapshots members write ontology snapshots; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members write ontology snapshots" ON public.ontology_snapshots FOR INSERT TO authenticated WITH CHECK (public.is_org_member(org_id));


--
-- Name: skill_edges members write skill edges; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members write skill edges" ON public.skill_edges FOR INSERT TO authenticated WITH CHECK (public.is_org_member(org_id));


--
-- Name: skill_evidence members write skill evidence; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members write skill evidence" ON public.skill_evidence FOR INSERT TO authenticated WITH CHECK (public.is_org_member(org_id));


--
-- Name: skill_nodes members write skill nodes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "members write skill nodes" ON public.skill_nodes FOR INSERT TO authenticated WITH CHECK (public.is_org_member(org_id));


--
-- Name: offers; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;

--
-- Name: ontology_snapshots; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.ontology_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_interviews org delete ai_interviews; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete ai_interviews" ON public.ai_interviews FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: ai_settings org delete ai_settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete ai_settings" ON public.ai_settings FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: applications org delete applications; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete applications" ON public.applications FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidate_assessments org delete candidate_assessments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete candidate_assessments" ON public.candidate_assessments FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidate_verifications org delete candidate_verifications; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete candidate_verifications" ON public.candidate_verifications FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidates org delete candidates; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete candidates" ON public.candidates FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: departments org delete departments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete departments" ON public.departments FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: evaluations org delete evaluations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete evaluations" ON public.evaluations FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: inbox_messages org delete inbox; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete inbox" ON public.inbox_messages FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: interviews org delete interviews; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete interviews" ON public.interviews FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: job_descriptions org delete job_descriptions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete job_descriptions" ON public.job_descriptions FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: master_items org delete master_items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete master_items" ON public.master_items FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: match_scores org delete match_scores; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete match_scores" ON public.match_scores FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: offers org delete offers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete offers" ON public.offers FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: requisitions org delete requisitions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete requisitions" ON public.requisitions FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: social_profiles org delete social_profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete social_profiles" ON public.social_profiles FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: source_integrations org delete source_integrations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete source_integrations" ON public.source_integrations FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: stage_events org delete stage_events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org delete stage_events" ON public.stage_events FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: ai_interviews org insert ai_interviews; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert ai_interviews" ON public.ai_interviews FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: ai_settings org insert ai_settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert ai_settings" ON public.ai_settings FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: applications org insert applications; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert applications" ON public.applications FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: candidate_assessments org insert candidate_assessments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert candidate_assessments" ON public.candidate_assessments FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: candidate_verifications org insert candidate_verifications; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert candidate_verifications" ON public.candidate_verifications FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: candidates org insert candidates; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert candidates" ON public.candidates FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: departments org insert departments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert departments" ON public.departments FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: evaluations org insert evaluations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert evaluations" ON public.evaluations FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: interviews org insert interviews; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert interviews" ON public.interviews FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: job_descriptions org insert job_descriptions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert job_descriptions" ON public.job_descriptions FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: master_items org insert master_items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert master_items" ON public.master_items FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: match_scores org insert match_scores; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert match_scores" ON public.match_scores FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: offers org insert offers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert offers" ON public.offers FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: requisitions org insert requisitions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert requisitions" ON public.requisitions FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: social_profiles org insert social_profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert social_profiles" ON public.social_profiles FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: source_integrations org insert source_integrations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert source_integrations" ON public.source_integrations FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: stage_events org insert stage_events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org insert stage_events" ON public.stage_events FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: candidate_notes org members create notes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members create notes" ON public.candidate_notes FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: candidate_referrals org members create referrals; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members create referrals" ON public.candidate_referrals FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: talent_request_suggestions org members create suggestions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members create suggestions" ON public.talent_request_suggestions FOR INSERT TO authenticated WITH CHECK (public.is_org_member(org_id));


--
-- Name: talent_requests org members create talent requests; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members create talent requests" ON public.talent_requests FOR INSERT TO authenticated WITH CHECK (public.is_org_member(org_id));


--
-- Name: candidate_notes org members delete notes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members delete notes" ON public.candidate_notes FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidate_referrals org members delete referrals; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members delete referrals" ON public.candidate_referrals FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: talent_request_suggestions org members delete suggestions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members delete suggestions" ON public.talent_request_suggestions FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: talent_requests org members delete talent requests; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members delete talent requests" ON public.talent_requests FOR DELETE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidate_notes org members read notes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members read notes" ON public.candidate_notes FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidate_ownership_events org members read ownership events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members read ownership events" ON public.candidate_ownership_events FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidate_referrals org members read referrals; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members read referrals" ON public.candidate_referrals FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: talent_request_suggestions org members read suggestions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members read suggestions" ON public.talent_request_suggestions FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: talent_requests org members read talent requests; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members read talent requests" ON public.talent_requests FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidate_notes org members update notes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members update notes" ON public.candidate_notes FOR UPDATE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidate_referrals org members update referrals; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members update referrals" ON public.candidate_referrals FOR UPDATE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: talent_request_suggestions org members update suggestions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members update suggestions" ON public.talent_request_suggestions FOR UPDATE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: talent_requests org members update talent requests; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members update talent requests" ON public.talent_requests FOR UPDATE TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidate_ownership_events org members write ownership events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org members write ownership events" ON public.candidate_ownership_events FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: ai_interviews org read ai_interviews; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read ai_interviews" ON public.ai_interviews FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: ai_settings org read ai_settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read ai_settings" ON public.ai_settings FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: applications org read applications; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read applications" ON public.applications FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidate_assessments org read candidate_assessments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read candidate_assessments" ON public.candidate_assessments FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidate_verifications org read candidate_verifications; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read candidate_verifications" ON public.candidate_verifications FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: candidates org read candidates; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read candidates" ON public.candidates FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: capture_events org read captures; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read captures" ON public.capture_events FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: departments org read departments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read departments" ON public.departments FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: evaluations org read evaluations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read evaluations" ON public.evaluations FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: inbox_messages org read inbox; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read inbox" ON public.inbox_messages FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: interviews org read interviews; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read interviews" ON public.interviews FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: job_descriptions org read job_descriptions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read job_descriptions" ON public.job_descriptions FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: master_items org read master_items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read master_items" ON public.master_items FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: match_scores org read match_scores; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read match_scores" ON public.match_scores FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: offers org read offers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read offers" ON public.offers FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: requisitions org read requisitions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read requisitions" ON public.requisitions FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: user_roles org read roles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read roles" ON public.user_roles FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR public.is_org_member(org_id)));


--
-- Name: social_profiles org read social_profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read social_profiles" ON public.social_profiles FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: source_integrations org read source_integrations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read source_integrations" ON public.source_integrations FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: stage_events org read stage_events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org read stage_events" ON public.stage_events FOR SELECT TO authenticated USING (public.is_org_member(org_id));


--
-- Name: ai_interviews org update ai_interviews; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update ai_interviews" ON public.ai_interviews FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: ai_settings org update ai_settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update ai_settings" ON public.ai_settings FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: applications org update applications; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update applications" ON public.applications FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: candidate_assessments org update candidate_assessments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update candidate_assessments" ON public.candidate_assessments FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: candidate_verifications org update candidate_verifications; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update candidate_verifications" ON public.candidate_verifications FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: candidates org update candidates; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update candidates" ON public.candidates FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: departments org update departments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update departments" ON public.departments FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: evaluations org update evaluations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update evaluations" ON public.evaluations FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: interviews org update interviews; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update interviews" ON public.interviews FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: job_descriptions org update job_descriptions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update job_descriptions" ON public.job_descriptions FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: master_items org update master_items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update master_items" ON public.master_items FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: match_scores org update match_scores; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update match_scores" ON public.match_scores FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: offers org update offers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update offers" ON public.offers FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: requisitions org update requisitions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update requisitions" ON public.requisitions FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: social_profiles org update social_profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update social_profiles" ON public.social_profiles FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: source_integrations org update source_integrations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update source_integrations" ON public.source_integrations FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: stage_events org update stage_events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "org update stage_events" ON public.stage_events FOR UPDATE TO authenticated USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));


--
-- Name: org_linkedin_connections; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.org_linkedin_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: org_members; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;

--
-- Name: org_pool_shares; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.org_pool_shares ENABLE ROW LEVEL SECURITY;

--
-- Name: organizations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

--
-- Name: copilot_messages own copilot delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "own copilot delete" ON public.copilot_messages FOR DELETE TO authenticated USING ((user_id = auth.uid()));


--
-- Name: copilot_messages own copilot insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "own copilot insert" ON public.copilot_messages FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: copilot_messages own copilot read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "own copilot read" ON public.copilot_messages FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: user_roles owners grant roles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "owners grant roles" ON public.user_roles FOR INSERT TO authenticated WITH CHECK ((public.is_org_owner(org_id) OR (org_id IS NULL)));


--
-- Name: org_members owners invite; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "owners invite" ON public.org_members FOR INSERT TO authenticated WITH CHECK ((public.is_org_owner(org_id) OR (NOT (EXISTS ( SELECT 1
   FROM public.org_members m
  WHERE (m.org_id = m.org_id))))));


--
-- Name: org_members owners or self update membership; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "owners or self update membership" ON public.org_members FOR UPDATE TO authenticated USING ((public.is_org_owner(org_id) OR (user_id = auth.uid()) OR (lower(email) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))))) WITH CHECK (true);


--
-- Name: org_members owners remove members; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "owners remove members" ON public.org_members FOR DELETE TO authenticated USING (public.is_org_owner(org_id));


--
-- Name: user_roles owners revoke roles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "owners revoke roles" ON public.user_roles FOR DELETE TO authenticated USING (public.is_org_owner(org_id));


--
-- Name: organizations owners update own org; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "owners update own org" ON public.organizations FOR UPDATE TO authenticated USING (public.is_org_owner(id)) WITH CHECK (public.is_org_owner(id));


--
-- Name: platform_admins platform admins can read the allowlist; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "platform admins can read the allowlist" ON public.platform_admins FOR SELECT TO authenticated USING ((lower(email) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))));


--
-- Name: platform_admins; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

--
-- Name: product_catalogue_commercials; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.product_catalogue_commercials ENABLE ROW LEVEL SECURITY;

--
-- Name: requisitions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.requisitions ENABLE ROW LEVEL SECURITY;

--
-- Name: screening_kits; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.screening_kits ENABLE ROW LEVEL SECURITY;

--
-- Name: screening_kits screening_kits_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY screening_kits_delete ON public.screening_kits FOR DELETE TO authenticated USING (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: screening_kits screening_kits_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY screening_kits_insert ON public.screening_kits FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: screening_kits screening_kits_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY screening_kits_select ON public.screening_kits FOR SELECT TO authenticated USING (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: screening_kits screening_kits_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY screening_kits_update ON public.screening_kits FOR UPDATE TO authenticated USING (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: screening_runs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.screening_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: screening_runs screening_runs_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY screening_runs_delete ON public.screening_runs FOR DELETE TO authenticated USING (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: screening_runs screening_runs_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY screening_runs_insert ON public.screening_runs FOR INSERT TO authenticated WITH CHECK (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: screening_runs screening_runs_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY screening_runs_select ON public.screening_runs FOR SELECT TO authenticated USING (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: screening_runs screening_runs_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY screening_runs_update ON public.screening_runs FOR UPDATE TO authenticated USING (((org_id IS NULL) OR public.is_org_member(org_id)));


--
-- Name: skill_edges; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.skill_edges ENABLE ROW LEVEL SECURITY;

--
-- Name: skill_evidence; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.skill_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: skill_nodes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.skill_nodes ENABLE ROW LEVEL SECURITY;

--
-- Name: social_profiles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.social_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: source_integrations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.source_integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: stage_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.stage_events ENABLE ROW LEVEL SECURITY;

--
-- Name: talent_request_suggestions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.talent_request_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: talent_requests; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.talent_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: objects Org members can add CV files to their own vault; Type: POLICY; Schema: storage; Owner: postgres
--

CREATE POLICY "Org members can add CV files to their own vault" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'resumes'::text) AND public.is_org_member(((string_to_array(name, '/'::text))[1])::uuid)));


--
-- Name: objects Org members can read their CV files; Type: POLICY; Schema: storage; Owner: postgres
--

CREATE POLICY "Org members can read their CV files" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'resumes'::text) AND public.is_org_member(((string_to_array(name, '/'::text))[1])::uuid)));


--
-- Name: objects Org members can replace their CV files; Type: POLICY; Schema: storage; Owner: postgres
--

CREATE POLICY "Org members can replace their CV files" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'resumes'::text) AND public.is_org_member(((string_to_array(name, '/'::text))[1])::uuid)));


--
-- Name: objects screening_audio_member_insert; Type: POLICY; Schema: storage; Owner: postgres
--

CREATE POLICY screening_audio_member_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'screening-audio'::text) AND public.is_org_member((split_part(name, '/'::text, 1))::uuid)));


--
-- Name: objects screening_audio_member_read; Type: POLICY; Schema: storage; Owner: postgres
--

CREATE POLICY screening_audio_member_read ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'screening-audio'::text) AND public.is_org_member((split_part(name, '/'::text, 1))::uuid)));


--
-- Name: TABLE ai_interviews; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ai_interviews TO authenticated;
GRANT ALL ON TABLE public.ai_interviews TO service_role;


--
-- Name: TABLE ai_provider_credentials; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.ai_provider_credentials TO service_role;


--
-- Name: TABLE ai_settings; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.ai_settings TO authenticated;
GRANT ALL ON TABLE public.ai_settings TO service_role;


--
-- Name: TABLE applications; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.applications TO authenticated;
GRANT ALL ON TABLE public.applications TO service_role;


--
-- Name: TABLE candidate_assessments; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.candidate_assessments TO authenticated;
GRANT ALL ON TABLE public.candidate_assessments TO service_role;


--
-- Name: TABLE candidate_notes; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.candidate_notes TO authenticated;
GRANT ALL ON TABLE public.candidate_notes TO service_role;


--
-- Name: TABLE candidate_ownership_events; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.candidate_ownership_events TO authenticated;
GRANT ALL ON TABLE public.candidate_ownership_events TO service_role;


--
-- Name: TABLE candidate_referrals; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.candidate_referrals TO authenticated;
GRANT ALL ON TABLE public.candidate_referrals TO service_role;


--
-- Name: TABLE candidate_verifications; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.candidate_verifications TO authenticated;
GRANT ALL ON TABLE public.candidate_verifications TO service_role;


--
-- Name: TABLE candidates; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.candidates TO authenticated;
GRANT ALL ON TABLE public.candidates TO service_role;


--
-- Name: TABLE capture_events; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.capture_events TO authenticated;
GRANT ALL ON TABLE public.capture_events TO service_role;


--
-- Name: TABLE copilot_messages; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE ON TABLE public.copilot_messages TO authenticated;
GRANT ALL ON TABLE public.copilot_messages TO service_role;


--
-- Name: TABLE departments; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.departments TO authenticated;
GRANT ALL ON TABLE public.departments TO service_role;


--
-- Name: TABLE evaluations; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.evaluations TO authenticated;
GRANT ALL ON TABLE public.evaluations TO service_role;


--
-- Name: TABLE hr_incentive_schemes; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hr_incentive_schemes TO authenticated;
GRANT ALL ON TABLE public.hr_incentive_schemes TO service_role;


--
-- Name: TABLE inbox_messages; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,DELETE ON TABLE public.inbox_messages TO authenticated;
GRANT ALL ON TABLE public.inbox_messages TO service_role;


--
-- Name: TABLE integration_credentials; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.integration_credentials TO service_role;


--
-- Name: TABLE interviews; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.interviews TO authenticated;
GRANT ALL ON TABLE public.interviews TO service_role;


--
-- Name: TABLE job_descriptions; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.job_descriptions TO authenticated;
GRANT ALL ON TABLE public.job_descriptions TO service_role;


--
-- Name: TABLE master_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.master_items TO authenticated;
GRANT ALL ON TABLE public.master_items TO service_role;


--
-- Name: TABLE match_scores; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.match_scores TO authenticated;
GRANT ALL ON TABLE public.match_scores TO service_role;


--
-- Name: TABLE offers; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.offers TO authenticated;
GRANT ALL ON TABLE public.offers TO service_role;


--
-- Name: TABLE ontology_snapshots; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.ontology_snapshots TO authenticated;
GRANT ALL ON TABLE public.ontology_snapshots TO service_role;


--
-- Name: TABLE org_linkedin_connections; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.org_linkedin_connections TO service_role;


--
-- Name: TABLE org_members; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.org_members TO authenticated;
GRANT ALL ON TABLE public.org_members TO service_role;


--
-- Name: TABLE org_pool_shares; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.org_pool_shares TO authenticated;
GRANT ALL ON TABLE public.org_pool_shares TO service_role;


--
-- Name: TABLE organizations; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.organizations TO authenticated;
GRANT ALL ON TABLE public.organizations TO service_role;


--
-- Name: TABLE platform_admins; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.platform_admins TO authenticated;
GRANT ALL ON TABLE public.platform_admins TO service_role;


--
-- Name: TABLE product_catalogue_commercials; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.product_catalogue_commercials TO service_role;


--
-- Name: TABLE requisitions; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.requisitions TO authenticated;
GRANT ALL ON TABLE public.requisitions TO service_role;


--
-- Name: TABLE screening_kits; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.screening_kits TO authenticated;
GRANT ALL ON TABLE public.screening_kits TO service_role;


--
-- Name: TABLE screening_runs; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.screening_runs TO authenticated;
GRANT ALL ON TABLE public.screening_runs TO service_role;


--
-- Name: TABLE skill_edges; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.skill_edges TO authenticated;
GRANT ALL ON TABLE public.skill_edges TO service_role;


--
-- Name: TABLE skill_evidence; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.skill_evidence TO authenticated;
GRANT ALL ON TABLE public.skill_evidence TO service_role;


--
-- Name: TABLE skill_nodes; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.skill_nodes TO authenticated;
GRANT ALL ON TABLE public.skill_nodes TO service_role;


--
-- Name: TABLE social_profiles; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_profiles TO authenticated;
GRANT ALL ON TABLE public.social_profiles TO service_role;


--
-- Name: TABLE source_integrations; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_integrations TO authenticated;
GRANT ALL ON TABLE public.source_integrations TO service_role;


--
-- Name: TABLE stage_events; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.stage_events TO authenticated;
GRANT ALL ON TABLE public.stage_events TO service_role;


--
-- Name: TABLE talent_request_suggestions; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.talent_request_suggestions TO authenticated;
GRANT ALL ON TABLE public.talent_request_suggestions TO service_role;


--
-- Name: TABLE talent_requests; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.talent_requests TO authenticated;
GRANT ALL ON TABLE public.talent_requests TO service_role;


--
-- Name: TABLE user_roles; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.user_roles TO authenticated;
GRANT ALL ON TABLE public.user_roles TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict cxaf5JfuT0ORRKn0mv2MvpJTg9G4ZrDVHzdaBRhpSkdAAVsbDo7GNC87qTjAnEe

