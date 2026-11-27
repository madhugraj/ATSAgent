/**
 * Tenant capability vocabulary (docs/candidate-identification/track-b-design.md §1.2).
 *
 * A tenant's workflow profile resolves to a set of these; nav items, routes,
 * server functions and agent tools each declare the capability they need, so
 * nothing hidden in the menu stays reachable by URL, RPC or the copilot.
 * Client-safe on purpose: the nav predicates import this module, so it must
 * never touch the database or server-only code — enforcement lives in
 * capabilities.server.ts.
 */

/** Every tenant capability. `full_pipeline` resolves to all of them. */
export const CAPABILITIES = [
  "pipeline.requisitions",
  "pipeline.approvals",
  "recruiting.screening",
  "recruiting.interviews",
  "recruiting.offers",
  "recruiting.voice",
  "sourcing.distribution",
  "insights.reports",
  "matching.pool",
  "matching.shortlist",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Profile-level settings keys on org_workflow_profiles.settings (§1.3). */
export type WorkflowProfileSettings = {
  /** Lightweight requisitions: approval gate (default) or auto-approve on import. */
  jdRequisitionMode?: "approval_gate" | "auto_approved";
  /** Duplicate check: how far back a same-family requisition is a candidate (days). */
  jdDuplicateLookbackDays?: number;
  /** Duplicate check: pay bands diverging more than this fraction can never be duplicates. */
  payVarianceTolerance?: number;
};

export const DEFAULT_PROFILE_SETTINGS: Required<Pick<WorkflowProfileSettings, never>> & {
  jdDuplicateLookbackDays: number;
  payVarianceTolerance: number;
} = {
  jdDuplicateLookbackDays: 90,
  payVarianceTolerance: 0.2,
};

/**
 * Which capability each setting depends on (§1.2). A profile that resolves a
 * setting's dependency may use that setting; apply and settings changes are
 * refused when the dependency is missing (e.g. `approval_gate` without
 * `pipeline.approvals` has no chain to gate).
 */
export const SETTING_CAPABILITIES: {
  [K in keyof Required<WorkflowProfileSettings>]: Partial<Record<string, Capability[]>>;
} = {
  jdRequisitionMode: {
    approval_gate: ["pipeline.approvals"],
    auto_approved: [],
  },
  jdDuplicateLookbackDays: {},
  payVarianceTolerance: {},
};

/** Capabilities a setting value depends on (empty when it has none). */
export function capabilitiesForSetting(
  key: keyof WorkflowProfileSettings,
  value: unknown,
): Capability[] {
  const table = SETTING_CAPABILITIES[key] as Record<string, Capability[] | undefined> | undefined;
  return (value != null ? table?.[String(value)] : undefined) ?? [];
}

/**
 * Agent type → capabilities its tools need (§1.2). `startRun` skips an agent
 * whose every capability is gated off; empty array = the agent is not
 * capability-restricted (its individual tools still are, via `capability` on
 * the tool).
 */
export const AGENT_CAPABILITIES: Record<string, Capability[]> = {
  requisition: ["pipeline.requisitions", "pipeline.approvals"],
  jd: ["pipeline.requisitions"],
  publishing: ["sourcing.distribution"],
  distribution: ["sourcing.distribution"],
  intake: ["matching.pool", "recruiting.screening"],
  screening: ["recruiting.screening"],
  screening_call: ["recruiting.voice"],
  interview: ["recruiting.interviews"],
  expert_interview: ["recruiting.interviews"],
  panel_l1: ["recruiting.interviews"],
  panel_l2: ["recruiting.interviews"],
  panel_l3: ["recruiting.interviews"],
  scheduling_call: ["recruiting.interviews"],
  confirmation_call: ["recruiting.interviews"],
  panel_check_call: ["recruiting.interviews"],
  negotiation_call: ["recruiting.offers"],
  offer: ["recruiting.offers"],
  evaluation: ["recruiting.interviews"],
  onboarding: ["recruiting.offers"],
  sourcing: ["matching.pool"],
  voice_guard: ["recruiting.voice"],
  // Shared or cross-cutting agents: not capability-restricted as a whole;
  // the tools they call carry their own capability and are gated per call.
  copilot: [],
  followup: [],
  org_context: [],
  labour_policy: [],
};

/**
 * Path → capability for tenant routes (§1.2). Longest matching prefix wins.
 * `any: true` marks a shared work surface (hiring desk, agent runs) that needs
 * at least one capability rather than one specific one — a tenant with no
 * capabilities at all cannot run agents, so it has no use for the desk.
 */
export type RouteCapabilityRule = {
  prefix: string;
  capability?: Capability;
  any?: boolean;
};

export const ROUTE_CAPABILITIES: RouteCapabilityRule[] = [
  { prefix: "/requisitions", capability: "pipeline.requisitions" },
  { prefix: "/jd-import", capability: "pipeline.requisitions" },
  { prefix: "/matching", capability: "matching.pool" },
  { prefix: "/screening", capability: "recruiting.screening" },
  { prefix: "/interviews", capability: "recruiting.interviews" },
  { prefix: "/offers", capability: "recruiting.offers" },
  { prefix: "/inbox", capability: "sourcing.distribution" },
  { prefix: "/distribution", capability: "sourcing.distribution" },
  { prefix: "/ijp", capability: "sourcing.distribution" },
  { prefix: "/reports", capability: "insights.reports" },
  { prefix: "/hiring-cost", capability: "insights.reports" },
  { prefix: "/roi", capability: "insights.reports" },
  { prefix: "/candidates", capability: "matching.pool" },
  // Shared surfaces: reachable while the tenant runs any capability at all.
  { prefix: "/desk", any: true },
  { prefix: "/agents", any: true },
  { prefix: "/collaboration", any: true },
];

function prefixHit(prefix: string, path: string): boolean {
  return prefix === "/" ? path === "/" : path === prefix || path.startsWith(`${prefix}/`);
}

/** The rule for a pathname (longest prefix wins; null = not capability-gated). */
export function routeCapabilityOf(pathname: string): RouteCapabilityRule | null {
  // Strip any search/hash defensively: callers may pass a full href (pathname +
  // search + hash in TanStack Router), and a query string must never defeat a rule.
  const cutoff = pathname.search(/[?#]/);
  const stripped = cutoff >= 0 ? pathname.slice(0, cutoff) : pathname;
  const path = stripped.length > 1 ? stripped.replace(/\/+$/, "") : stripped;
  // Exemptions win over rules regardless of length (e.g. /interviews/mine stays
  // open to panel-only interviewers even though /interviews is gated).
  for (const exempt of NAV_EXEMPT_PREFIXES) if (prefixHit(exempt, path)) return null;
  let best: RouteCapabilityRule | null = null;
  for (const rule of ROUTE_CAPABILITIES) {
    if (prefixHit(rule.prefix, path) && (!best || rule.prefix.length > best.prefix.length))
      best = rule;
  }
  return best;
}

/** Does a resolved capability set admit this route rule? */
export function capabilitiesAdmitRoute(capabilities: string[], rule: RouteCapabilityRule): boolean {
  if (rule.any) return capabilities.length > 0;
  return rule.capability != null && capabilities.includes(rule.capability);
}

/**
 * Nav paths explicitly exempt from capabilities — role-gated as today
 * (governance settings, the platform console, help). The completeness sweep
 * requires every NavItem to carry a `cap`, an `anyCap` flag, or appear here.
 */
export const NAV_EXEMPT_PREFIXES = [
  // The dashboard is every member's landing page on every profile.
  "/",
  "/team",
  "/organisation",
  "/org-profile",
  "/integrations",
  "/masters",
  "/templates",
  "/brain",
  "/platform",
  "/platform-ai-usage",
  "/platform-agents",
  "/platform-agent-studio",
  "/platform-agent-workflows",
  "/platform-health",
  "/catalogue",
  "/help",
  // Workflow desk access is already gated per tenant by agent_workflow_grants
  // server-side (org-workflows.functions.ts VIEW_ROLES + grant check).
  "/w",
  // Redirects straight to /brain.
  "/skill-ontology",
  "/interviews/mine",
  // Agent-admin subpages: governance-role-gated, not capability-gated — they
  // must stay open on every profile to configure and oversee the agents.
  "/agents/settings",
  "/agents/observability",
  "/agents/governance",
  "/agents/intelligence",
  "/agents/register",
  "/agents/call-reviews",
] as const;

/** Error copy surfaced by capability refusals (vendor- and profile-neutral). */
export const CAPABILITY_MESSAGE = "This area is not part of your organisation's current workflow.";

/**
 * Agent tools deliberately exempt from per-tool capability gating (§1.2):
 * read-only global tools (orientation stays open so a gated agent can still
 * see its context) and cross-cutting domains with no capability at all
 * (ontology, org profile, pay conventions, labour policy — their agents are
 * unrestricted in AGENT_CAPABILITIES). The CI sweep requires every registered
 * tool either to declare a `capability` or to appear here; a tool that does
 * both is a mapping error the sweep reports.
 */
/**
 * CONSCIOUS DECISION (B1a review, 2026-11-27): a tool's `capability` is a
 * tenant gate, not part of the agent's contract with the model — it is
 * deliberately excluded from manifest.server.ts's canonicalManifest, so
 * declaring or changing it does NOT bump agent versions or agents.lock.json.
 * A reviewer seeing agents.lock unchanged next to new `capability:` fields is
 * looking at intent, not a missed version bump.
 */
export const TOOL_EXEMPT: ReadonlySet<string> = new Set([
  // Requisition / JD context reads.
  "list_departments",
  "list_requisitions",
  "find_similar_requisitions",
  "get_requisition",
  "research_compensation",
  "suggest_weights",
  "draft_linkedin_post",
  // Pipeline / screening reads.
  "pipeline_summary",
  "list_applications",
  "search_talent_pool",
  "get_screening_status",
  "list_overdue",
  "list_members",
  // Interview / panel reads.
  "get_interview_plan",
  "list_panel_options",
  "list_substitutes",
  "find_interview_slots",
  "list_pending_scorecards",
  "get_candidate_dossier",
  "selection_parity",
  "get_round_for_panel",
  // Offer / onboarding reads.
  "get_offer_context",
  "check_offer_against_policy",
  "onboarding_status",
  "compensation_cross_check",
  // Sourcing / distribution reads.
  "list_publish_channels",
  "get_role_traction",
  "get_role_channels",
  "check_cv_inflow",
  "list_role_limited_cvs",
  // Call / voice reads.
  "read_call_for_review",
  // Ontology, org profile, pay conventions and labour policy: cross-cutting
  // domains with no capability; the person's decision in app code is gated by
  // the server functions, not by the tool that asks for it.
  "get_role_profile",
  "check_talent_availability",
  "read_role_for_expert",
  "read_org_profile",
  "read_org_records",
  "read_org_website",
  "read_org_sources",
  "read_org_document",
  "read_pay_conventions",
  "propose_profile_items",
  "submit_profile_version",
  "propose_pay_conventions",
  "list_policy_sources",
  "read_policy_source",
  "read_policy_document",
  "submit_policy_briefing",
  "record_policy_finding",
  // The copilot's dispatcher: it creates no work itself — startRun gates each
  // agent type it hands off to.
  "start_agent",
  // Internal nudge to a member's end-of-day summary about work already waiting
  // for them (any capability area); it writes no record of its own.
  "remind_member",
]);

/* ------------------------------------------------ server-fn capability map */

/**
 * Per MODULE capability assignment for tenant-scoped server functions
 * (B1b, design note §1.5/§1.8). `null` = reviewed exemption: the module is
 * governance-role-gated, cross-cutting, or shares files with public/integration
 * paths — its existing auth stays as-is, and it must never gain a capability.
 * A capability means: every tenant-scoped server fn of that module's gated
 * surface composes `requireCapability(<cap>)` AFTER its existing middleware.
 * Mixed modules (some fns gated, some public) attach the capability only to
 * the gated surface's fns — stricter than needed is fine, looser never is.
 * The completeness sweep (scripts/capability-completeness.test.ts) enforces
 * both directions.
 */
export const SERVER_FN_MODULE_CAPABILITY: Record<string, Capability | null> = {
  // Pipeline — requisitions & JD.
  "requisitions.functions.ts": "pipeline.requisitions",
  "jd-import.functions.ts": "pipeline.requisitions",
  "lifecycle.functions.ts": "pipeline.requisitions",
  "role-hiring-manager.functions.ts": "pipeline.requisitions",
  "role-profile.functions.ts": "pipeline.requisitions",
  // Matching — pool & shortlist.
  "matching.functions.ts": "matching.pool",
  "candidates.functions.ts": "matching.pool",
  "candidates.identity.functions.ts": "matching.pool",
  "candidates.profile.functions.ts": "matching.pool",
  "candidates.archive.functions.ts": "matching.pool",
  "resume.functions.ts": "matching.pool",
  "intake.functions.ts": "matching.pool",
  "dedupe.functions.ts": "matching.pool",
  // Screening.
  "screening.functions.ts": "recruiting.screening",
  "screening-queue.functions.ts": "recruiting.screening",
  "screening-rationale.functions.ts": "recruiting.screening",
  "assessment.functions.ts": "recruiting.screening",
  // Voice.
  "phone-screening.functions.ts": "recruiting.voice",
  "screening-calls.functions.ts": "recruiting.voice",
  "call-reviews.functions.ts": "recruiting.voice",
  // Interviews.
  "interviews.functions.ts": "recruiting.interviews",
  "interview-plan.functions.ts": "recruiting.interviews",
  "interview-confirmations.functions.ts": "recruiting.interviews",
  "interviewers.functions.ts": "recruiting.interviews",
  "panels.functions.ts": "recruiting.interviews",
  "panelists.functions.ts": "recruiting.interviews",
  "meetings.functions.ts": "recruiting.interviews",
  // Offers.
  "offers.functions.ts": "recruiting.offers",
  "offer-check.functions.ts": "recruiting.offers",
  // Sourcing / distribution (local-inbox: gate the inbox fns, not integrations).
  "boards.functions.ts": "sourcing.distribution",
  "distribution.functions.ts": "sourcing.distribution",
  "local-inbox.functions.ts": "sourcing.distribution",
  // Insights.
  "hiring-cost.functions.ts": "insights.reports",
  // Offers (pre-onboarding dialog serves the offers route).
  "onboarding.functions.ts": "recruiting.offers",
  // Reviewed exemptions — governance-role-gated, cross-cutting, or sharing
  // files with public/integration paths; existing auth stays as-is.
  "agents.functions.ts": null, // Agent admin (governance nav group)
  "agent-governance.functions.ts": null,
  "agent-intelligence.functions.ts": null,
  "agents-observability.functions.ts": null,
  "agents-telemetry.functions.ts": null,
  "panel-agent.functions.ts": null, // silent-panel settings (governance)
  "ai-settings.functions.ts": null, // Integrations (governance)
  "email-brand.functions.ts": null,
  "email-settings.functions.ts": null,
  "integrations.functions.ts": null,
  "integrations-oauth.functions.ts": null,
  "linkedin.functions.ts": null, // integration + public callback
  "hrms.functions.ts": null,
  "collect.functions.ts": null, // public collection links
  "verification.functions.ts": null, // public candidate sync shares this module
  // Mixed modules (B1b review follow-up): the public token fns (candidate
  // pages /negotiate/:token, /pay/:token) stay ungated — the token is the key;
  // the logged-in, offer-related fns carry recruiting.offers.
  "negotiation.functions.ts": "recruiting.offers",
  "compensation.functions.ts": "recruiting.offers",
  "master.functions.ts": null, // Masters (governance)
  "org-profile.functions.ts": null, // Organisation profile (governance)
  "org-agreements.functions.ts": null, // governance
  "org-context.functions.ts": null, // org profile reads (agents + governance)
  "org-ontology.functions.ts": null, // Talent Brain / ontology (governance)
  "org-workflows.functions.ts": null, // /w/:id — grant-gated server-side already
  "pay-settings.functions.ts": null, // pay conventions gate (governance)
  "labour-policy.functions.ts": null, // cross-cutting policy sources
  "templates.functions.ts": null, // Content templates (governance)
  "training.functions.ts": null, // training settings (governance)
  "capture.functions.ts": null, // consent-gated capture + public token paths
  "step-up.functions.ts": null, // auth infrastructure
  "nudges.functions.ts": null, // cross-cutting notifications
  "hr-performance.functions.ts": null, // dashboard surface (exempt)
  "queries.functions.ts": null, // hiring-desk queries (desk = any-capability)
  "hiring-desk.functions.ts": null, // desk (any-capability; tools gate per call)
  "copilot.functions.ts": null, // copilot (any-capability; tools gate per call)
  "org-desk.functions.ts": null, // desk (any-capability)
  "workflow-profile.functions.ts": null, // the capability read itself + governance settings
  "hiring-oversight.functions.ts": null, // cross-cutting oversight reads: exempt dashboard + gated pages
  "salary-benchmark.functions.ts": null, // benchmark reads shared by dashboard and requisition pages
  "market.functions.ts": null, // market benchmark reads shared by dashboard and requisition pages
  "comp-knowledge.functions.ts": null, // comp knowledge reads shared by dashboard and requisition pages
};
