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
