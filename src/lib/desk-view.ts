/**
 * Pure view rules for the hiring desk thread (src/routes/desk.tsx), kept
 * here so they are unit-tested: which action cards a later step overtook,
 * how many messages show before "Show earlier", and long-text folding.
 */
type Msg = { id: string; card: unknown };

/** How many of the latest messages a thread shows before "Show earlier". */
export const RECENT_MESSAGES = 20;
/** Stages at which a candidate can still be sent to screening. */
export const SCREENABLE = new Set(["sourced", "applied", "ai_screened", "shortlisted", "reserve"]);
/** Stages at which a role has an offer in play: asking for more candidates is moot. */
const OFFER_OR_LATER = new Set([
  "offer",
  "offer_pending",
  "offer_released",
  "offer_accepted",
  "hired",
  "joined",
]);

/**
 * Action cards that a later step has overtaken (a newer ranked list, a newer
 * "bring candidates in", or an offer already in play): shown folded, with why.
 */
export function supersededMessages(d: {
  messages: Msg[];
  stages: Record<string, string>;
}): Map<string, string> {
  const out = new Map<string, string>();
  const offerInPlay = Object.values(d.stages).some((s) => OFFER_OR_LATER.has(s));
  const type = (m: Msg) => (m.card as { type?: string } | null)?.type;
  d.messages.forEach((m, i) => {
    const t = type(m);
    if (t !== "bring_candidates" && t !== "ranked_candidates") return;
    const later = d.messages.slice(i + 1).map(type);
    if (t === "ranked_candidates" && later.includes("ranked_candidates"))
      out.set(m.id, "An earlier ranking — a newer list is further down.");
    else if (t === "bring_candidates" && offerInPlay)
      out.set(
        m.id,
        "An earlier suggestion to bring more candidates in — the role has an offer in play now.",
      );
    else if (
      t === "bring_candidates" &&
      (later.includes("bring_candidates") || later.includes("ranked_candidates"))
    )
      out.set(
        m.id,
        "An earlier suggestion to bring more candidates in — candidates have arrived since.",
      );
  });
  return out;
}

/** Long agent text: the first part, cut at a paragraph, with "Show more". */
const LONG_TEXT = 1400;
export function foldText(body: string): { head: string; folded: boolean } {
  if (body.length <= LONG_TEXT) return { head: body, folded: false };
  const cut = body.lastIndexOf("\n\n", 1000);
  const at =
    cut > 400 ? cut : body.lastIndexOf("\n", 1000) > 400 ? body.lastIndexOf("\n", 1000) : 1000;
  return { head: body.slice(0, at).trimEnd(), folded: true };
}

/* ----------------------------------------- decisions on the hiring journey */

/** The journey step each agent's requests belong to; unknown agents go to the current step. */
const STEP_OF_AGENT: Record<string, string> = {
  requisition: "requisition",
  jd: "jd",
  intake: "candidates",
  sourcing: "candidates",
  distribution: "candidates",
  publishing: "candidates",
  screening: "screening",
  screening_call: "screening",
  interview: "interviews",
  scheduling_call: "interviews",
  panel_l1: "interviews",
  panel_l2: "interviews",
  panel_l3: "interviews",
  expert: "interviews",
  evaluation: "decision",
  offer: "offer",
  negotiation_call: "offer",
  onboarding: "joining",
};

export type JourneyDecision = {
  /** The first open request with this title (Review scrolls to it). */
  taskId: string;
  title: string;
  /** Open requests with the same title on this step, folded into one row. */
  count: number;
  at: string;
  /** A disagreement or other review that should be read first. */
  urgent: boolean;
  /** Someone else decides; this person can only watch. */
  waitingFor: string | null;
};

type TaskMsg = {
  agentType?: string | null;
  at: string;
  card: unknown;
};

/**
 * Open requests in a thread, filed under the journey step their agent works
 * on (oldest first), with same-titled requests folded into one row.
 */
export function decisionsByStep(
  d: {
    messages: TaskMsg[];
    tasks: Record<string, string>;
    /** Task id → its subject type, when the card does not carry it. */
    taskSubjects?: Record<string, string | null | undefined>;
    deciders?: Record<string, { canDecide?: boolean; waitingFor?: string | null } | undefined>;
  },
  steps: string[],
  current: string | null,
): Map<string, JourneyDecision[]> {
  const out = new Map<string, JourneyDecision[]>();
  const fallback = current ?? steps.at(-1) ?? "";
  for (const m of d.messages) {
    const c = m.card as {
      type?: string;
      taskId?: string;
      title?: string;
      subjectType?: string;
    } | null;
    if (c?.type !== "task" || !c.taskId) continue;
    if ((d.tasks[c.taskId] ?? "open") !== "open") continue;
    const mapped = STEP_OF_AGENT[m.agentType ?? ""];
    const step = mapped && steps.includes(mapped) ? mapped : fallback;
    const title = (c.title ?? "").trim() || "A decision";
    const decider = d.deciders?.[c.taskId];
    const row: JourneyDecision = {
      taskId: c.taskId,
      title,
      count: 1,
      at: m.at,
      urgent: (c.subjectType ?? d.taskSubjects?.[c.taskId]) === "panel_review",
      waitingFor: decider?.canDecide === false ? (decider.waitingFor ?? "someone else") : null,
    };
    const list = out.get(step) ?? [];
    const same = list.find((x) => x.title === title && !!x.waitingFor === !!row.waitingFor);
    if (same) same.count++;
    else list.push(row);
    out.set(step, list);
  }
  for (const list of out.values()) list.sort((a, b) => Number(b.urgent) - Number(a.urgent));
  return out;
}

/**
 * An agent's report in one line: its first heading or sentence, without
 * markdown, for the folded view (the full text is one click away).
 */
export function reportLine(body: string, max = 120): string {
  const first =
    body
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/, "")
          .replace(/\*\*|__|`/g, "")
          .trim(),
      )
      .find((l) => l && !/^-{3,}$/.test(l)) ?? "";
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}
