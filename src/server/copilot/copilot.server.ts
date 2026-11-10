/**
 * The HR copilot's turn: a short tool-calling loop through the AI gateway
 * (`aiAgentStep`, feature "copilot"). Its tools only read, each filtered on
 * the server by the person's scope (src/lib/copilot-scope.ts); tools a scope
 * does not allow are never offered to the model. Doing work (opening a
 * requisition, shortlisting) is proposed as a hand-off the person confirms,
 * which then starts the agent Copilot — the chat copilot never acts itself.
 */
import { z } from "zod";

import { describeScope, type CopilotScope } from "@/lib/copilot-scope";
import type { AgentMessage, AgentToolSpec } from "@/lib/ai-gateway.server";
import { log } from "../log";
import { loadOntology } from "../org-ontology.server";
import { talentAvailability } from "../agents/tools-ontology";
import {
  budgetSummary,
  demandOutlook,
  findRequisitions,
  governanceSummary,
  ontologyOverview,
  pendingApprovals,
  pipelineSummary,
  poolCoverage,
  requisitionStatus,
  roleProfile,
  type CopilotCtx,
} from "./data.server";

export const COPILOT_MAX_STEPS = 6;
/**
 * Output cap per step — a backstop; the prompt's word budget sets the visible
 * length. Reasoning models count their thinking against it (measured: about
 * 1,200 thinking tokens for a 200-token answer, and 2,048 cut answers off), so
 * it sits well above the visible budget.
 */
export const COPILOT_MAX_OUTPUT_TOKENS = 4096;

export type CopilotHandoff = { goal: string; summary: string };

type CopilotTool = {
  name: string;
  description: string;
  input: z.ZodType;
  allowed: (s: CopilotScope) => boolean;
  /** Output carries third-party text (candidate names, CV-derived reasons). */
  untrusted?: boolean;
  run: (ctx: CopilotCtx, input: never, state: TurnState) => Promise<unknown>;
};

type TurnState = { handoff: CopilotHandoff | null };

const always = () => true;
const NoInput = z.object({});

export const COPILOT_TOOLS: CopilotTool[] = [
  {
    name: "find_requisitions",
    description:
      "List requisitions the person can see, newest first, with counts by status. Optional free-text query (title, code or department) and status filter (draft, pending_dh, pending_hr, pending_cbo, approved, rejected, on_hold, closed).",
    input: z.object({
      query: z.string().max(120).optional(),
      status: z
        .enum([
          "draft",
          "pending_dh",
          "pending_hr",
          "pending_cbo",
          "approved",
          "rejected",
          "on_hold",
          "closed",
        ])
        .optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    allowed: always,
    run: (ctx, i: { query?: string; status?: string; limit?: number }) => findRequisitions(ctx, i),
  },
  {
    name: "requisition_status",
    description:
      "One requisition by its code: status, who it is waiting on and for how many days, the full approval trail (who decided what and when, with comments) and its pipeline by stage.",
    input: z.object({ code: z.string().min(1).max(40) }),
    allowed: always,
    run: (ctx, i: { code: string }) => requisitionStatus(ctx, i.code),
  },
  {
    name: "pending_approvals",
    description:
      "Approvals waiting on this person (requisitions at their approval stage, and offers for HR head / CBO), with how long each has waited; leadership also sees every other requisition in approval.",
    input: NoInput,
    allowed: always,
    run: (ctx) => pendingApprovals(ctx),
  },
  {
    name: "pipeline_summary",
    description:
      "Applications by stage, applications stalled for over 7 days, interviews in the next 14 days and offers by status — for everything the person can see, or one requisition by code.",
    input: z.object({ code: z.string().max(40).optional() }),
    allowed: always,
    run: (ctx, i: { code?: string }) => pipelineSummary(ctx, i.code),
  },
  {
    name: "budget_summary",
    description:
      "Department budgets (headcount and cost for the period) against openings and budget already open or in approval.",
    input: NoInput,
    allowed: (s) => s.orgMoney,
    run: (ctx) => budgetSummary(ctx),
  },
  {
    name: "ontology_overview",
    description:
      "The organisation's skill and role ontology: domain, skill families with demand and supply, established roles with how often they were asked for and how many people fit, and emerging roles (signal / emerging / established) with what they grew out of.",
    input: NoInput,
    allowed: always,
    run: async (ctx) => ontologyOverview(await loadOntology(ctx.orgId)),
  },
  {
    name: "role_profile",
    description:
      'A role from the ontology by how the person described it ("forward deployment engineer"): must-have and good-to-have skills, what it grew out of, the titles used, requisitions raised and people in the pool who fit.',
    input: z.object({ request: z.string().min(2).max(300) }),
    allowed: always,
    run: async (ctx, i: { request: string }) =>
      roleProfile(await loadOntology(ctx.orgId), i.request),
  },
  {
    name: "talent_availability",
    description:
      "How many people in the talent pool fit a role (strong / partial, how many internal) and the best five by name. Give the title and must-have skills.",
    input: z.object({
      title: z.string().min(2).max(120),
      skills: z.array(z.string().min(1).max(80)).min(1).max(12),
      location: z.string().max(120).optional(),
    }),
    allowed: (s) => s.pool,
    untrusted: true,
    run: (ctx, i: { title: string; skills: string[]; location?: string }) =>
      talentAvailability(ctx.orgId, i),
  },
  {
    name: "pool_coverage",
    description:
      "Whether the talent pool is enough: for every open requisition and every role in the ontology, strong fits per opening (green 3+, amber 1–3, red under 1), how many fits are internal, how fresh their profiles are, and the must-have skills almost nobody in the pool has.",
    input: NoInput,
    allowed: (s) => s.pool,
    run: (ctx) => poolCoverage(ctx),
  },
  {
    name: "demand_outlook",
    description:
      "Roles likely to be in higher demand over the next two quarters: the organisation's own requisition trend per role (last two quarters against the two before), the market outlook from live research, emerging roles and pool coverage, each with a confidence and its evidence. Says when history is too thin. Set refresh only when the person asks for an up-to-date outlook.",
    input: z.object({ refresh: z.boolean().optional() }),
    allowed: (s) => s.pool,
    run: (ctx, i: { refresh?: boolean }) =>
      demandOutlook(ctx, Boolean(i.refresh) && ctx.scope.tier === "leadership"),
  },
  {
    name: "governance_summary",
    description:
      "Governance for leadership: audit-log actions of the last 30 days and the latest events, open agent health issues, and AI usage this month (requests, tokens, errors, top features).",
    input: NoInput,
    allowed: (s) => s.governance,
    run: (ctx) => governanceSummary(ctx),
  },
  {
    name: "propose_agent_handoff",
    description:
      "Propose handing work to the hiring agents when the person asks for something to be DONE (open a requisition, draft a JD, shortlist people, advertise a role). The person sees a button and the agents start only if they click it. Give a precise goal with every detail the person gave, and a one-line summary for the button.",
    input: z.object({
      goal: z.string().min(10).max(2000),
      summary: z.string().min(3).max(140),
    }),
    allowed: always,
    run: async (_ctx, i: CopilotHandoff, state) => {
      state.handoff = { goal: i.goal.trim(), summary: i.summary.trim() };
      return { proposed: true, note: "The person will see a button to start the agents." };
    },
  },
];

export function toolsFor(scope: CopilotScope): CopilotTool[] {
  return COPILOT_TOOLS.filter((t) => t.allowed(scope));
}

export function copilotSystem(base: string, injectionRules: string, scope: CopilotScope): string {
  return [
    injectionRules,
    "",
    base,
    "",
    "WHO YOU ARE TALKING TO:",
    describeScope(scope),
    "Answer only within that access. If they ask for something outside it, say plainly that their role does not cover it and who can see it (HR head or CBO).",
    "",
    "HOW TO ANSWER:",
    "- Use the tools for every question about live data (requisitions, approvals, pipeline, ontology, pool, demand, governance). Never answer data questions from memory.",
    "- For 'how do I ...' questions use the USER MANUAL only; no tool is needed.",
    "- For future demand, always use demand_outlook and say how confident it is and why; separate the organisation's own trend from the market signal; if history is thin, say so.",
    "- For 'do we have enough people', use pool_coverage (and talent_availability for one role).",
    "- When the person wants work done, describe what you would hand over and call propose_agent_handoff; never claim the work has started.",
    "- Say a cause only when a tool returned data that shows it. If the data shows the symptom but not the cause, say the cause is unknown and name the one page or record that would show it. Never present a guess as a finding.",
    "",
    "FORMAT AND LENGTH:",
    "- Lead with the answer in one sentence. Then at most 3–5 bullets of one line each. Stay under about 120 words unless the person asks for detail.",
    "- When comparing several items (requisitions, roles, agents, months), use a small markdown table (up to 5 rows and 4 columns) instead of bullets.",
    "- Markdown allowed: **bold** for the key number or action, `-` bullets, numbered steps, tables, and links to pages as [Page name](/path) using only the page list. No headings, no code blocks.",
    "- One list only: when the bullets already say what to do, do not repeat them as a separate recommendations list. At most 3 actions, most important first, each one line: the action and the page — no background explanation.",
    "- Name only settings the USER MANUAL or a tool result names; if you are unsure a setting exists, name just the page.",
  ].join("\n");
}

/** Prior turns as agent messages, oldest first, starting with the person. */
export function historyMessages(prior: { role: string; content: string }[]): AgentMessage[] {
  const msgs: AgentMessage[] = prior.map((m) =>
    m.role === "user"
      ? { role: "user", content: m.content }
      : { role: "assistant", content: m.content },
  );
  while (msgs[0] && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

export async function runCopilotTurn(input: {
  ctx: CopilotCtx;
  system: string;
  history: AgentMessage[];
}): Promise<{ answer: string; handoff: CopilotHandoff | null; failed?: string }> {
  const { aiAgentStep, toolParameters, untrusted, INJECTION_RULES, INVALID_TOOL_ARGS } =
    await import("@/lib/ai-gateway.server");
  const tools = toolsFor(input.ctx.scope);
  const specs: AgentToolSpec[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toolParameters(t.input),
  }));
  const system = copilotSystem(input.system, INJECTION_RULES, input.ctx.scope);
  const messages: AgentMessage[] = [...input.history];
  const state: TurnState = { handoff: null };

  for (let step = 0; step < COPILOT_MAX_STEPS; step++) {
    const last = step === COPILOT_MAX_STEPS - 1;
    const res = await aiAgentStep({
      orgId: input.ctx.orgId,
      feature: "copilot",
      system: last ? `${system}\n\nAnswer now from what you have; do not call tools.` : system,
      messages,
      tools: last ? [] : specs,
      maxOutputTokens: COPILOT_MAX_OUTPUT_TOKENS,
    });
    if (!res.ok) return { answer: "", handoff: null, failed: res.message };
    if (!res.toolCalls.length) {
      const answer = res.text.trim();
      const cut = res.stopReason === "max_tokens" && answer;
      return {
        answer: cut ? `${answer}…\n\n_(Answer cut short — ask for the rest.)_` : answer,
        handoff: state.handoff,
      };
    }
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      let content: string;
      let isError = false;
      try {
        if (!tool) throw new Error(`No tool named ${call.name} is available to this person.`);
        if (call.args === INVALID_TOOL_ARGS) throw new Error("The arguments were not valid JSON.");
        const parsed = tool.input.safeParse(call.args ?? {});
        if (!parsed.success) throw new Error(`Invalid arguments: ${parsed.error.message}`);
        const out = await tool.run(input.ctx, parsed.data as never, state);
        const json = JSON.stringify(out).slice(0, 20_000);
        content = tool.untrusted ? untrusted(call.name, json) : json;
      } catch (e) {
        isError = true;
        content = e instanceof Error ? e.message : String(e);
        log.warn("copilot.tool_failed", {
          org_id: input.ctx.orgId,
          tool: call.name,
          error: e as Error,
        });
      }
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content, isError });
    }
  }
  return { answer: "", handoff: state.handoff, failed: "The copilot ran out of steps." };
}
