/**
 * Hiring oversight (HR dashboard, governance roles): are people really
 * deciding on agent proposals, where do they disagree (with the reasons
 * given), and is anything skipping a person. Deterministic, org-scoped.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";

import { db } from "../server/db";
import { agentRuns, agentTasks, stageEvents } from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";

export type Tone = "good" | "warn" | "bad";
export type Oversight = {
  headline: { tone: Tone; title: string; detail: string }[];
  weekly: { week: string; approved: number; declined: number }[];
  disagreements: {
    agent: string;
    proposal: string;
    declined: number;
    total: number;
    reasons: string[];
  }[];
  staleOpen: { agent: string; title: string; ageHours: number }[];
  closedUndecided: number;
  stageMoves: { stage: string; agent: number; person: number }[];
};

export const hiringOversight = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<Oversight> => {
    const org = context.orgId;
    await assertRole(context.userId, org, ["hr_head", "president_cbo"]);
    const [decisionRows, stageRows] = await Promise.all([
      db
        .select({
          agentType: agentRuns.agentType,
          status: agentTasks.status,
          title: agentTasks.title,
          response: agentTasks.response,
          decidedAt: agentTasks.decidedAt,
          createdAt: agentTasks.createdAt,
        })
        .from(agentTasks)
        .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
        .where(and(eq(agentTasks.orgId, org), eq(agentRuns.orgId, org))),
      db
        .select({ toStage: stageEvents.toStage, actor: stageEvents.actor })
        .from(stageEvents)
        .where(eq(stageEvents.orgId, org)),
    ]);

    // ---------------- oversight (governance tab, plain answers) ----------------
    const now = Date.now();
    const weekStart = (d: Date) => {
      const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
      return x.toISOString().slice(0, 10);
    };
    const weeks: string[] = [];
    for (let i = 7; i >= 0; i--) weeks.push(weekStart(new Date(now - i * 7 * 864e5)));
    const weekly = weeks.map((week) => ({ week, approved: 0, declined: 0 }));
    const dis = new Map<
      string,
      { agent: string; proposal: string; declined: number; total: number; reasons: string[] }
    >();
    const staleOpen: Oversight["staleOpen"] = [];
    let closedUndecided = 0;
    for (const t of decisionRows) {
      if (t.status === "cancelled" || t.status === "expired") closedUndecided += 1;
      if (t.status === "open") {
        const ageHours = Math.round((now - t.createdAt.getTime()) / 36e5);
        if (ageHours >= 48)
          staleOpen.push({ agent: t.agentType, title: t.title.slice(0, 80), ageHours });
      }
      if (t.status !== "approved" && t.status !== "rejected") continue;
      if (t.decidedAt) {
        const w = weekly.find((x) => x.week === weekStart(t.decidedAt!));
        if (w && t.status === "approved") w.approved += 1;
        else if (w) w.declined += 1;
      }
      const key = `${t.agentType}|${t.title}`;
      const d = dis.get(key) ?? {
        agent: t.agentType,
        proposal: t.title.slice(0, 80),
        declined: 0,
        total: 0,
        reasons: [],
      };
      d.total += 1;
      if (t.status === "rejected") {
        d.declined += 1;
        const reason = (t.response as { reason?: unknown } | null)?.reason;
        if (
          typeof reason === "string" &&
          reason.trim() &&
          d.reasons.length < 3 &&
          !d.reasons.includes(reason.trim())
        )
          d.reasons.push(reason.trim().slice(0, 140));
      }
      dis.set(key, d);
    }
    const disagreements = [...dis.values()]
      .filter((d) => d.declined > 0)
      .sort((a, b) => b.declined - a.declined);
    staleOpen.sort((a, b) => b.ageHours - a.ageHours);
    const moves = new Map<string, { stage: string; agent: number; person: number }>();
    for (const e of stageRows) {
      if (e.actor === "candidate") continue; // candidate's own action (e.g. withdrew) is neither
      const m = moves.get(e.toStage) ?? { stage: e.toStage, agent: 0, person: 0 };
      if (e.actor === "ai") m.agent += 1;
      else m.person += 1;
      moves.set(e.toStage, m);
    }
    const stageMoves = [...moves.values()].sort((a, b) => b.agent - a.agent || b.person - a.person);
    const govOk = decisionRows.filter((t) => t.status === "approved").length;
    const govRej = decisionRows.filter((t) => t.status === "rejected").length;
    const decided = govOk + govRej;
    const declinePct = Math.round((govRej / Math.max(decided, 1)) * 100);
    const agentOnlyStages = stageMoves
      .filter((m) => m.agent > 0 && m.person === 0)
      .map((m) => m.stage.replace(/_/g, " "));
    const headline: Oversight["headline"] = [
      decided === 0
        ? {
            tone: "warn",
            title: "No decisions yet",
            detail:
              "People have not approved or declined any agent proposal yet, so oversight is untested.",
          }
        : declinePct === 0 && decided >= 20
          ? {
              tone: "warn",
              title: "Every proposal approved",
              detail: `${decided} of ${decided} approved — check reviewers are reading, not just clicking approve.`,
            }
          : {
              tone: "good",
              title: "People are deciding",
              detail: `${decided} decisions on agent proposals — ${govOk} approved, ${govRej} declined (${declinePct}%).`,
            },
      disagreements.length === 0
        ? {
            tone: "good",
            title: "No disagreements",
            detail: "People have not declined any agent proposal.",
          }
        : {
            tone: disagreements[0]!.declined >= 3 || declinePct >= 20 ? "bad" : "warn",
            title: `People disagree with ${disagreements[0]!.agent.replace(/_/g, " ")}`,
            detail: `"${disagreements[0]!.proposal}" declined ${disagreements[0]!.declined} of ${disagreements[0]!.total} times.`,
          },
      staleOpen.length + closedUndecided + agentOnlyStages.length === 0
        ? {
            tone: "good",
            title: "Nothing slipping past a person",
            detail: "No old open cards, no undecided closures, no stage a person never touches.",
          }
        : {
            tone: staleOpen.length > 0 || agentOnlyStages.length > 0 ? "bad" : "warn",
            title: "Some work skips a person",
            detail:
              [
                staleOpen.length
                  ? `${staleOpen.length} card${staleOpen.length === 1 ? "" : "s"} waiting over 48h`
                  : "",
                closedUndecided ? `${closedUndecided} closed without a decision` : "",
                agentOnlyStages.length
                  ? `only agents move candidates to: ${agentOnlyStages.join(", ")}`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ") + ".",
          },
    ];
    return {
      headline,
      weekly,
      disagreements: disagreements.slice(0, 10),
      staleOpen: staleOpen.slice(0, 10),
      closedUndecided,
      stageMoves,
    };
  });
