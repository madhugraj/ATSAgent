/**
 * Data behind the HR copilot's tools, pool coverage and the demand outlook.
 * Every query carries `eq(table.orgId, orgId)`; requisition queries add the
 * person's scope (src/lib/copilot-scope.ts) so a tool never returns a row the
 * person could not open themselves.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db";
import {
  agentIssues,
  aiUsageEvents,
  applications,
  auditLog,
  candidates,
  demandOutlooks,
  departments,
  interviews,
  offers,
  orgMembers,
  organizations,
  requisitions,
  userRoles,
} from "@db/schema";
import { scopeFor, type CopilotRole, type CopilotScope } from "@/lib/copilot-scope";
import { findRoleProfile, type OrgOntology } from "@/lib/org-ontology";
import {
  computeCoverage,
  summariseCoverage,
  type CoverageDemand,
  type CoverageRow,
} from "@/lib/pool-coverage";
import {
  OUTLOOK_QUARTERS,
  MIN_HISTORY_QUARTERS,
  historyQuarters,
  rankOutlook,
  roleTrends,
  type DemandOutlook,
  type MarketSignal,
} from "@/lib/demand-outlook";
import { loadOntology } from "../org-ontology.server";

export type CopilotCtx = {
  orgId: string;
  userId: string;
  memberId: string | null;
  scope: CopilotScope;
};

export async function loadCopilotCtx(
  orgId: string,
  userId: string,
  isOwner: boolean,
): Promise<CopilotCtx> {
  const [roles, member] = await Promise.all([
    db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(and(eq(userRoles.orgId, orgId), eq(userRoles.userId, userId))),
    db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      .limit(1),
  ]);
  return {
    orgId,
    userId,
    memberId: member[0]?.id ?? null,
    scope: scopeFor(
      roles.map((r) => r.role as CopilotRole),
      isOwner,
    ),
  };
}

/* ---------------------------------------------------------- requisitions */

const OPEN_STATUSES = ["pending_dh", "pending_hr", "pending_cbo", "approved"] as const;
const WAITING_ON: Record<string, string> = {
  draft: "the person who raised it (not submitted yet)",
  pending_dh: "the department head",
  pending_hr: "the HR head",
  pending_cbo: "the CBO",
};
const APPROVER: Partial<Record<string, CopilotRole>> = {
  pending_dh: "department_head",
  pending_hr: "hr_head",
  pending_cbo: "president_cbo",
};

/** The requisitions this person may see. */
export function reqScope(ctx: CopilotCtx): SQL {
  const base = eq(requisitions.orgId, ctx.orgId);
  if (ctx.scope.wholeOrg) return base;
  const own = ctx.memberId
    ? or(
        eq(requisitions.createdBy, ctx.userId),
        eq(requisitions.hiringManagerMemberId, ctx.memberId),
      )!
    : eq(requisitions.createdBy, ctx.userId);
  const atMyStage = ctx.scope.roles.includes("department_head")
    ? eq(requisitions.status, "pending_dh")
    : null;
  return and(base, atMyStage ? or(own, atMyStage)! : own)!;
}

type TrailEntry = {
  from?: string;
  to?: string;
  actor?: string;
  comment?: string | null;
  at?: string;
};
const trailOf = (t: unknown): TrailEntry[] => (Array.isArray(t) ? (t as TrailEntry[]) : []);
const daysSince = (d: Date | string | null | undefined, now = Date.now()) =>
  d ? Math.max(0, Math.floor((now - new Date(d).getTime()) / 86_400_000)) : null;

function reqView(
  ctx: CopilotCtx,
  r: {
    code: string;
    title: string;
    status: string;
    openings: number;
    location: string | null;
    department: string | null;
    budgetCtc: string;
    createdAt: Date;
    approvalTrail: unknown;
  },
) {
  const trail = trailOf(r.approvalTrail);
  const lastMove = trail.at(-1)?.at ?? r.createdAt.toISOString();
  return {
    code: r.code,
    title: r.title,
    status: r.status,
    openings: r.openings,
    location: r.location,
    department: r.department,
    ...(ctx.scope.reqBudgets ? { budgetCtc: Number(r.budgetCtc) } : {}),
    ageDays: daysSince(r.createdAt),
    waitingOn: WAITING_ON[r.status] ?? null,
    daysInStatus: daysSince(lastMove),
  };
}

const reqColumns = {
  id: requisitions.id,
  code: requisitions.code,
  title: requisitions.title,
  status: requisitions.status,
  openings: requisitions.openings,
  location: requisitions.location,
  department: departments.name,
  budgetCtc: requisitions.budgetCtc,
  createdAt: requisitions.createdAt,
  approvalTrail: requisitions.approvalTrail,
  mustHaveSkills: requisitions.mustHaveSkills,
};

export async function findRequisitions(
  ctx: CopilotCtx,
  i: { query?: string; status?: string; limit?: number },
) {
  const where = [reqScope(ctx)];
  if (i.status) where.push(sql`${requisitions.status}::text = ${i.status}`);
  if (i.query) {
    const like = `%${i.query.replace(/[%_\\]/g, "\\$&")}%`;
    where.push(
      or(
        sql`${requisitions.title} ilike ${like}`,
        sql`${requisitions.code} ilike ${like}`,
        sql`${departments.name} ilike ${like}`,
      )!,
    );
  }
  const rows = await db
    .select(reqColumns)
    .from(requisitions)
    .leftJoin(
      departments,
      and(eq(departments.id, requisitions.departmentId), eq(departments.orgId, ctx.orgId)),
    )
    .where(and(...where))
    .orderBy(desc(requisitions.createdAt))
    .limit(Math.min(i.limit ?? 25, 50));
  const total = await db
    .select({ status: requisitions.status, n: sql<number>`count(*)::int` })
    .from(requisitions)
    .where(reqScope(ctx))
    .groupBy(requisitions.status);
  return {
    countsByStatus: Object.fromEntries(total.map((t) => [t.status, t.n])),
    requisitions: rows.map((r) => reqView(ctx, r)),
  };
}

export async function requisitionStatus(ctx: CopilotCtx, code: string) {
  const [r] = await db
    .select(reqColumns)
    .from(requisitions)
    .leftJoin(
      departments,
      and(eq(departments.id, requisitions.departmentId), eq(departments.orgId, ctx.orgId)),
    )
    .where(and(reqScope(ctx), sql`lower(${requisitions.code}) = lower(${code.trim()})`))
    .limit(1);
  if (!r) return { found: false, note: "No requisition with that code that this person can see." };
  const stages = await db
    .select({ stage: applications.stage, n: sql<number>`count(*)::int` })
    .from(applications)
    .where(and(eq(applications.orgId, ctx.orgId), eq(applications.requisitionId, r.id)))
    .groupBy(applications.stage);
  return {
    found: true,
    ...reqView(ctx, r),
    mustHaveSkills: r.mustHaveSkills,
    approvalTrail: trailOf(r.approvalTrail).map((t) => ({
      from: t.from,
      to: t.to,
      by: t.actor,
      at: t.at,
      comment: t.comment ?? null,
    })),
    pipeline: Object.fromEntries(stages.map((s) => [s.stage, s.n])),
  };
}

export async function pendingApprovals(ctx: CopilotCtx) {
  const leadership = ctx.scope.tier === "leadership";
  const mine = Object.entries(APPROVER)
    .filter(([, role]) => ctx.scope.isOwner || ctx.scope.roles.includes(role!))
    .map(([status]) => status);
  const statuses = leadership ? Object.keys(APPROVER) : mine;
  const reqs = statuses.length
    ? await db
        .select(reqColumns)
        .from(requisitions)
        .leftJoin(
          departments,
          and(eq(departments.id, requisitions.departmentId), eq(departments.orgId, ctx.orgId)),
        )
        .where(
          and(
            eq(requisitions.orgId, ctx.orgId),
            inArray(requisitions.status, statuses as (typeof OPEN_STATUSES)[number][]),
          ),
        )
        .orderBy(asc(requisitions.createdAt))
        .limit(50)
    : [];
  const offerStatuses = (["pending_hr", "pending_cbo"] as const).filter(
    (s) =>
      leadership &&
      (ctx.scope.isOwner ||
        ctx.scope.roles.includes(s === "pending_hr" ? "hr_head" : "president_cbo")),
  );
  const offerRows = offerStatuses.length
    ? await db
        .select({
          status: offers.status,
          offeredCtc: offers.offeredCtc,
          updatedAt: offers.createdAt,
          approvalTrail: offers.approvalTrail,
          code: requisitions.code,
          title: requisitions.title,
        })
        .from(offers)
        .innerJoin(
          applications,
          and(eq(applications.id, offers.applicationId), eq(applications.orgId, ctx.orgId)),
        )
        .innerJoin(
          requisitions,
          and(eq(requisitions.id, applications.requisitionId), eq(requisitions.orgId, ctx.orgId)),
        )
        .where(and(eq(offers.orgId, ctx.orgId), inArray(offers.status, offerStatuses)))
        .limit(50)
    : [];
  const view = reqs.map((r) => ({
    ...reqView(ctx, r),
    yourTurn: mine.includes(r.status),
  }));
  return {
    requisitionsWaitingOnYou: view.filter((v) => v.yourTurn),
    otherRequisitionsInApproval: view.filter((v) => !v.yourTurn),
    offersWaiting: offerRows.map((o) => ({
      requisition: `${o.code} ${o.title}`,
      status: o.status,
      waitingOn: o.status === "pending_hr" ? "the HR head" : "the CBO",
      daysInStatus: daysSince(trailOf(o.approvalTrail).at(-1)?.at ?? o.updatedAt),
      ...(ctx.scope.orgMoney ? { offeredCtc: Number(o.offeredCtc) } : {}),
    })),
  };
}

export async function pipelineSummary(ctx: CopilotCtx, code?: string) {
  const reqIds = db
    .select({ id: requisitions.id })
    .from(requisitions)
    .where(
      code
        ? and(reqScope(ctx), sql`lower(${requisitions.code}) = lower(${code.trim()})`)!
        : reqScope(ctx),
    );
  const appWhere = and(
    eq(applications.orgId, ctx.orgId),
    inArray(applications.requisitionId, reqIds),
  );
  const stalledBefore = new Date(Date.now() - 7 * 86_400_000);
  const [stages, stalled, upcoming, offerRows] = await Promise.all([
    db
      .select({ stage: applications.stage, n: sql<number>`count(*)::int` })
      .from(applications)
      .where(appWhere)
      .groupBy(applications.stage),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(applications)
      .where(
        and(
          appWhere,
          lt(applications.lastActivityAt, stalledBefore),
          sql`${applications.stage}::text not in ('rejected','hired','withdrawn','joined','offer_declined','no_show','reserve','on_hold')`,
        ),
      ),
    db
      .select({ status: interviews.status, n: sql<number>`count(*)::int` })
      .from(interviews)
      .innerJoin(applications, eq(applications.id, interviews.applicationId))
      .where(
        and(
          eq(interviews.orgId, ctx.orgId),
          appWhere,
          gte(interviews.scheduledAt, new Date()),
          sql`${interviews.scheduledAt} < now() + interval '14 days'`,
        ),
      )
      .groupBy(interviews.status),
    db
      .select({
        status: offers.status,
        n: sql<number>`count(*)::int`,
        ctc: sql<string>`coalesce(sum(${offers.offeredCtc}),0)`,
      })
      .from(offers)
      .innerJoin(applications, eq(applications.id, offers.applicationId))
      .where(and(eq(offers.orgId, ctx.orgId), appWhere))
      .groupBy(offers.status),
  ]);
  return {
    scope: code ?? (ctx.scope.wholeOrg ? "whole organisation" : "your requisitions"),
    applicationsByStage: Object.fromEntries(stages.map((s) => [s.stage, s.n])),
    stalledOver7Days: stalled[0]?.n ?? 0,
    interviewsNext14Days: Object.fromEntries(upcoming.map((u) => [u.status, u.n])),
    offersByStatus: Object.fromEntries(
      offerRows.map((o) => [
        o.status,
        ctx.scope.orgMoney ? { count: o.n, totalCtc: Number(o.ctc) } : { count: o.n },
      ]),
    ),
  };
}

export async function budgetSummary(ctx: CopilotCtx) {
  const [depts, open] = await Promise.all([
    db
      .select({
        id: departments.id,
        name: departments.name,
        headcount: departments.budgetedHeadcount,
        cost: departments.budgetedCost,
        period: departments.period,
      })
      .from(departments)
      .where(eq(departments.orgId, ctx.orgId)),
    db
      .select({
        departmentId: requisitions.departmentId,
        openings: sql<number>`coalesce(sum(${requisitions.openings}),0)::int`,
        budget: sql<string>`coalesce(sum(${requisitions.budgetCtc} * ${requisitions.openings}),0)`,
      })
      .from(requisitions)
      .where(
        and(eq(requisitions.orgId, ctx.orgId), inArray(requisitions.status, [...OPEN_STATUSES])),
      )
      .groupBy(requisitions.departmentId),
  ]);
  return depts.map((d) => {
    const o = open.find((x) => x.departmentId === d.id);
    return {
      department: d.name,
      period: d.period,
      budgetedHeadcount: d.headcount,
      budgetedCost: Number(d.cost),
      openOrInApprovalOpenings: o?.openings ?? 0,
      openOrInApprovalBudget: Number(o?.budget ?? 0),
    };
  });
}

/* ------------------------------------------------------------- ontology */

export function ontologyOverview(ont: OrgOntology) {
  return {
    domain: ont.domain.name,
    stats: ont.stats,
    families: ont.families.slice(0, 12).map((f) => ({
      name: f.name,
      topSkills: [...f.skills]
        .sort((a, b) => b.demand - a.demand)
        .slice(0, 6)
        .map((s) => ({ skill: s.name, demand: s.demand, supply: s.supply })),
    })),
    roles: [...ont.roles]
      .sort((a, b) => b.demand - a.demand)
      .slice(0, 20)
      .map((r) => ({
        name: r.name,
        requisitions: r.demand,
        peopleWhoFit: r.supply,
        source: r.source,
      })),
    emergingRoles: ont.emerging.map((e) => ({
      name: e.name,
      status: e.status,
      bornFrom: e.parents,
      skills: e.skills.slice(0, 8),
      requisitions: e.requisitions,
      peopleWhoFit: e.supply,
      confirmed: e.confirmed,
    })),
  };
}

export function roleProfile(ont: OrgOntology, request: string) {
  const p = findRoleProfile(ont, request);
  if (p) return { found: true, ...p };
  return {
    found: false,
    knownRoles: [...ont.roles.map((r) => r.name), ...ont.emerging.map((e) => e.name)],
  };
}

/* --------------------------------------------------------- pool coverage */

async function loadPool(orgId: string) {
  const rows = await db
    .select({
      id: candidates.id,
      skills: candidates.skills,
      isInternal: candidates.isInternal,
      createdAt: candidates.createdAt,
      lastSyncedAt: candidates.lastSyncedAt,
    })
    .from(candidates)
    .where(eq(candidates.orgId, orgId));
  return rows.map((c) => ({
    id: c.id,
    skills: (c.skills as string[] | null) ?? [],
    isInternal: c.isInternal,
    seenAt: c.lastSyncedAt && c.lastSyncedAt > c.createdAt ? c.lastSyncedAt : c.createdAt,
  }));
}

export async function poolCoverage(
  ctx: CopilotCtx,
  ont?: OrgOntology,
): Promise<{
  poolSize: number;
  summary: ReturnType<typeof summariseCoverage>;
  requisitions: CoverageRow[];
  roles: CoverageRow[];
}> {
  const [pool, open, ontology] = await Promise.all([
    loadPool(ctx.orgId),
    db
      .select({
        id: requisitions.id,
        code: requisitions.code,
        title: requisitions.title,
        openings: requisitions.openings,
        must: requisitions.mustHaveSkills,
      })
      .from(requisitions)
      .where(and(reqScope(ctx), inArray(requisitions.status, [...OPEN_STATUSES]))),
    ont ? Promise.resolve(ont) : loadOntology(ctx.orgId),
  ]);
  const reqDemand: CoverageDemand[] = open.map((r) => ({
    key: r.id,
    kind: "requisition",
    label: `${r.code} ${r.title}`,
    skills: (r.must as string[] | null) ?? [],
    demand: r.openings,
  }));
  const roleDemand: CoverageDemand[] = [
    ...ontology.roles
      .filter((r) => r.demand > 0)
      .map((r) => ({ name: r.name, skills: r.skills, demand: r.demand })),
    ...ontology.emerging.map((e) => ({ name: e.name, skills: e.skills, demand: e.requisitions })),
  ].map((r) => ({
    key: r.name,
    kind: "role" as const,
    label: r.name,
    skills: r.skills,
    demand: r.demand,
  }));
  const requisitionRows = computeCoverage(reqDemand, pool);
  const roleRows = computeCoverage(roleDemand, pool);
  return {
    poolSize: pool.length,
    summary: summariseCoverage(requisitionRows.length ? requisitionRows : roleRows),
    requisitions: requisitionRows.slice(0, 25),
    roles: roleRows.slice(0, 25),
  };
}

/* -------------------------------------------------------- demand outlook */

export const OUTLOOK_TTL_DAYS = 7;

const MarketSchema = z.object({
  roles: z
    .array(
      z.object({
        role: z.string().min(1).max(120),
        outlook: z.enum(["rising", "steady", "falling"]),
        reason: z.string().max(400),
      }),
    )
    .max(25),
});

async function marketSignal(
  orgId: string,
  industry: string | null,
  domain: string,
  roles: string[],
): Promise<{ signals: MarketSignal[]; grounded: boolean; available: boolean }> {
  if (!roles.length) return { signals: [], grounded: false, available: false };
  const { aiResearchJson, untrusted, INJECTION_RULES } = await import("@/lib/ai-gateway.server");
  const res = await aiResearchJson<unknown>({
    orgId,
    feature: "demand_outlook",
    system: [
      INJECTION_RULES,
      "You are a labour-market analyst. For each role, judge whether hiring demand for it is rising, steady or falling over the next two quarters in this industry, from current job-market evidence.",
      'Return JSON: { "roles": [{ "role": "<exact role name given>", "outlook": "rising" | "steady" | "falling", "reason": "<one sentence with the evidence>" }] }.',
      "Use the exact role names given. Do not add roles. Keep each reason to one plain sentence.",
    ].join("\n"),
    prompt: [
      `Industry: ${untrusted("industry", industry ?? domain)}`,
      `Roles: ${untrusted("roles", roles.join("\n"))}`,
    ].join("\n"),
  });
  if (!res.ok) return { signals: [], grounded: false, available: false };
  const parsed = MarketSchema.safeParse(res.data);
  if (!parsed.success) return { signals: [], grounded: false, available: false };
  const known = new Set(roles.map((r) => r.toLowerCase()));
  return {
    signals: parsed.data.roles.filter((r) => known.has(r.role.toLowerCase())),
    grounded: res.grounded,
    available: true,
  };
}

export async function buildDemandOutlook(ctx: CopilotCtx): Promise<DemandOutlook> {
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - OUTLOOK_QUARTERS * 3);
  const [ont, org, reqs] = await Promise.all([
    loadOntology(ctx.orgId),
    db
      .select({ industry: organizations.industry })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId)),
    db
      .select({
        title: requisitions.title,
        openings: requisitions.openings,
        createdAt: requisitions.createdAt,
      })
      .from(requisitions)
      .where(and(eq(requisitions.orgId, ctx.orgId), gte(requisitions.createdAt, since))),
  ]);
  // Whole-organisation figures: the outlook is an organisation view, shown to
  // leadership and recruiters only (scope.pool) and carries no pay figures.
  const fullCtx: CopilotCtx = { ...ctx, scope: { ...ctx.scope, wholeOrg: true } };
  const classified = reqs.map((r) => ({
    role: findRoleProfile(ont, r.title)?.name ?? r.title,
    openings: r.openings,
    createdAt: r.createdAt,
  }));
  const trends = roleTrends(classified);
  const history = historyQuarters(reqs);
  const candidates = [
    ...[...trends].sort((a, b) => b.recent + b.prior - (a.recent + a.prior)).map((t) => t.role),
    ...ont.emerging.map((e) => e.name),
  ];
  const marketRoles = [...new Set(candidates)].slice(0, 15);
  const [market, coverage] = await Promise.all([
    marketSignal(ctx.orgId, org[0]?.industry ?? null, ont.domain.name, marketRoles),
    poolCoverage(fullCtx, ont),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    historyQuarters: history,
    thinHistory: history < MIN_HISTORY_QUARTERS,
    marketGrounded: market.grounded,
    marketAvailable: market.available,
    rows: rankOutlook({
      trends,
      market: market.signals,
      emerging: ont.emerging.map((e) => ({ name: e.name, status: e.status })),
      coverage: coverage.roles.map((r) => ({ label: r.label, status: r.status })),
      historyQuarters: history,
      marketGrounded: market.grounded,
    }),
  };
}

/** The cached outlook; rebuilt when missing, older than a week, or on request. */
export async function demandOutlook(ctx: CopilotCtx, refresh = false): Promise<DemandOutlook> {
  const [cached] = await db
    .select({ payload: demandOutlooks.payload, generatedAt: demandOutlooks.generatedAt })
    .from(demandOutlooks)
    .where(eq(demandOutlooks.orgId, ctx.orgId))
    .limit(1);
  const fresh = cached && Date.now() - cached.generatedAt.getTime() < OUTLOOK_TTL_DAYS * 86_400_000;
  if (cached && fresh && !refresh) return cached.payload;
  const payload = await buildDemandOutlook(ctx);
  await db
    .insert(demandOutlooks)
    .values({ orgId: ctx.orgId, payload, generatedBy: ctx.userId, generatedAt: new Date() })
    .onConflictDoUpdate({
      target: demandOutlooks.orgId,
      set: { payload, generatedBy: ctx.userId, generatedAt: new Date() },
    });
  return payload;
}

/* ------------------------------------------------------------ governance */

export async function governanceSummary(ctx: CopilotCtx) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [actions, recent, issues, usage, byFeature] = await Promise.all([
    db
      .select({ action: auditLog.action, n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, ctx.orgId), gte(auditLog.createdAt, since)))
      .groupBy(auditLog.action)
      .orderBy(desc(sql`count(*)`))
      .limit(15),
    db
      .select({
        actor: auditLog.actor,
        action: auditLog.action,
        entityType: auditLog.entityType,
        at: auditLog.createdAt,
      })
      .from(auditLog)
      .where(eq(auditLog.orgId, ctx.orgId))
      .orderBy(desc(auditLog.createdAt))
      .limit(10),
    db
      .select({
        agent: agentIssues.agentType,
        severity: agentIssues.severity,
        status: agentIssues.status,
        title: agentIssues.title,
        since: agentIssues.firstSeenAt,
      })
      .from(agentIssues)
      .where(
        and(
          eq(agentIssues.orgId, ctx.orgId),
          sql`${agentIssues.status} <> 'resolved'`,
          isNull(agentIssues.resolvedAt),
        ),
      )
      .orderBy(desc(agentIssues.lastSeenAt))
      .limit(15),
    db
      .select({
        requests: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}),0)::int`,
        errors: sql<number>`count(*) filter (where ${aiUsageEvents.status} <> 'ok')::int`,
      })
      .from(aiUsageEvents)
      .where(and(eq(aiUsageEvents.orgId, ctx.orgId), gte(aiUsageEvents.createdAt, monthStart))),
    // Feature slugs only — never provider or model names.
    db
      .select({
        feature: aiUsageEvents.feature,
        requests: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}),0)::int`,
      })
      .from(aiUsageEvents)
      .where(and(eq(aiUsageEvents.orgId, ctx.orgId), gte(aiUsageEvents.createdAt, monthStart)))
      .groupBy(aiUsageEvents.feature)
      .orderBy(desc(sql`sum(${aiUsageEvents.totalTokens})`))
      .limit(8),
  ]);
  return {
    auditLast30Days: actions,
    latestAuditEvents: recent.map((r) => ({ ...r, at: r.at.toISOString() })),
    openAgentIssues: issues.map((i) => ({ ...i, since: i.since.toISOString() })),
    aiUsageThisMonth: { ...usage[0], topFeatures: byFeature },
  };
}
