/**
 * What the HR copilot may show a person, from their roles. The copilot's
 * tools filter on the server with this scope — the model never sees data the
 * person could not open themselves, so a prompt cannot talk it into leaking.
 *
 * - leadership (owner, HR head, CBO): the whole organisation, pay and budgets,
 *   governance (audit log, agent health, AI usage).
 * - recruiter: the whole pipeline, no pay or budget figures, no governance.
 * - manager (department head, hiring manager): the roles they raised or are
 *   hiring manager for, plus approvals waiting at their stage; those roles'
 *   budgets, nothing else with money.
 * - member (no role yet): only the roles they raised, no money.
 */
export type CopilotRole =
  "recruiter" | "hiring_manager" | "department_head" | "hr_head" | "president_cbo";

export type CopilotTier = "leadership" | "recruiter" | "manager" | "member";

export type CopilotScope = {
  tier: CopilotTier;
  roles: CopilotRole[];
  isOwner: boolean;
  /** Every requisition in the organisation (otherwise only the person's own). */
  wholeOrg: boolean;
  /** Budget CTC on requisitions in scope. */
  reqBudgets: boolean;
  /** Offer CTC, department budgets and hiring cost. */
  orgMoney: boolean;
  /** Audit log, agent health and AI usage. */
  governance: boolean;
  /** Talent-pool search, coverage and demand outlook. */
  pool: boolean;
};

export function scopeFor(roles: readonly CopilotRole[], isOwner: boolean): CopilotScope {
  const has = (r: CopilotRole) => roles.includes(r);
  const tier: CopilotTier =
    isOwner || has("hr_head") || has("president_cbo")
      ? "leadership"
      : has("recruiter")
        ? "recruiter"
        : has("department_head") || has("hiring_manager")
          ? "manager"
          : "member";
  return {
    tier,
    roles: [...roles],
    isOwner,
    wholeOrg: tier === "leadership" || tier === "recruiter",
    reqBudgets: tier === "leadership" || tier === "manager",
    orgMoney: tier === "leadership",
    governance: tier === "leadership",
    pool: tier !== "member",
  };
}

/** Plain-language description of the scope, for the system prompt. */
export function describeScope(s: CopilotScope): string {
  const who = s.isOwner
    ? "the organisation owner"
    : s.roles.length
      ? s.roles.map((r) => r.replace(/_/g, " ")).join(", ")
      : "a member with no hiring role yet";
  const sees = [
    s.wholeOrg ? "every requisition" : "only the requisitions they raised or manage",
    s.reqBudgets ? "requisition budgets" : null,
    s.orgMoney ? "offer pay, department budgets" : null,
    s.governance ? "governance (audit log, agent health, AI usage)" : null,
    s.pool ? "the talent pool, coverage and demand outlook" : null,
  ].filter(Boolean);
  return `The person is ${who}. Their access covers: ${sees.join("; ")}.`;
}
