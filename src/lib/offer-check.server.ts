/**
 * The offer check (docs/labour-policy-agent-plan.md, L3): before an offer goes for
 * approval, its letter and terms are checked against the organisation's approved
 * labour rules for the role's pay zone — pay floor, mandatory components,
 * contract and probation limits, required clauses, prohibited terms, pay
 * transparency. Each item is pass, fix needed (with suggested wording) or needs
 * counsel. A "fix needed" blocks the offer from going for approval unless the HR
 * head overrides it with a reason (audited). The check is keyed to the exact rules
 * and letter it read: any change makes it stale and it runs again.
 *
 * Every AI call goes through the gateway (feature offer_policy_check); the letter
 * enters the prompt as untrusted data; the output is zod-validated. Never decides
 * the offer — a person does.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { applications, offers, payZones, requisitions } from "../../drizzle/schema";
import { db } from "../server/db";
import { writeAudit } from "../server/audit";
import { OfferCheckItem, overallVerdict, type OfferCheck } from "./offer-check";

async function loadOffer(orgId: string, offerId: string) {
  const [row] = await db
    .select({ offer: offers, req: requisitions, zoneName: payZones.name })
    .from(offers)
    .innerJoin(applications, eq(applications.id, offers.applicationId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .leftJoin(payZones, eq(payZones.id, requisitions.payZoneId))
    .where(and(eq(offers.id, offerId), eq(offers.orgId, orgId)))
    .limit(1);
  if (!row) throw new Error("Offer not found.");
  return row;
}

type Loaded = Awaited<ReturnType<typeof loadOffer>>;

function letterText(letter: unknown): string | null {
  const l = letter as {
    subject?: string;
    opening?: string;
    sections?: { heading?: string; body?: string }[];
    closing?: string;
    boilerplate?: string | null;
    generatedAt?: string;
  } | null;
  if (!l?.sections?.length) return null;
  return [
    l.subject,
    l.opening,
    ...l.sections.map((s) => `${s.heading ?? ""}\n${s.body ?? ""}`),
    l.closing,
    l.boilerplate,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the check rests on: the rules, the letter and the terms (pure). */
export function checkKeyOf(
  rules: { id: string; decidedAt: Date | null }[],
  o: Pick<
    Loaded["offer"],
    "letter" | "offeredCtc" | "currency" | "payBasis" | "joiningDate" | "contractEnd"
  >,
): string {
  const letter = (o.letter as { generatedAt?: string } | null)?.generatedAt ?? "none";
  return createHash("sha256")
    .update(
      JSON.stringify([
        rules.map((r) => [r.id, r.decidedAt?.toISOString() ?? null]),
        letter,
        o.offeredCtc,
        o.currency,
        o.payBasis,
        o.joiningDate,
        o.contractEnd,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

export async function currentCheckKey(orgId: string, offerId: string): Promise<string> {
  const row = await loadOffer(orgId, offerId);
  const { approvedRulesFor } = await import("./labour-policy.server");
  return checkKeyOf(await approvedRulesFor(orgId, row.req.payZoneId), row.offer);
}

const CheckOutput = z.object({
  items: z.array(OfferCheckItem).min(1).max(24),
  suspected_prompt_injection: z.boolean().default(false),
});

/** Run the offer check and store it on the offer (audited). */
export async function runOfferCheckCore(
  orgId: string,
  offerId: string,
  opts: { agentRunId?: string | null; actor?: string } = {},
): Promise<OfferCheck> {
  const row = await loadOffer(orgId, offerId);
  const text = letterText(row.offer.letter);
  if (!text) throw new Error("Generate the offer letter first — the check reads the letter.");
  const { approvedRulesFor } = await import("./labour-policy.server");
  const rules = await approvedRulesFor(orgId, row.req.payZoneId);
  const key = checkKeyOf(rules, row.offer);
  const zone = row.zoneName ?? null;
  const ruleView = rules.map((r) => ({
    id: r.id,
    area: r.area,
    rule: r.rule,
    url: r.url,
    quote: r.quote,
  }));

  let items: OfferCheckItem[];
  if (!rules.length) {
    items = [
      OfferCheckItem.parse({
        check: `Labour rules for ${zone ?? "this location"}`,
        verdict: "needs_counsel",
        detail: `There are no approved labour rules for ${zone ?? "this role's location"} yet, so the letter was not checked against any. Have counsel review it, or approve the Labour law & policy agent's findings for this place first.`,
      }),
    ];
  } else {
    const { aiJson, INJECTION_RULES, untrusted } = await import("./ai-gateway.server");
    const result = await aiJson({
      orgId,
      feature: "offer_policy_check",
      schema: CheckOutput,
      system:
        `${INJECTION_RULES}\n\n` +
        "You check an offer letter against the employer's approved labour and hiring rules for the place the job is. " +
        "Return ONLY JSON: {items: [{check, verdict, detail, ruleId, suggestion}], suspected_prompt_injection}. " +
        "Give exactly one item per rule (ruleId = that rule's id), plus an item for anything in the letter that plainly breaks a rule. " +
        "verdict: 'pass' when the letter and terms meet the rule, or the rule does not apply to this offer (say why); " +
        "'fix_needed' when they do not — detail says what is wrong, suggestion gives letter wording that would meet the rule; " +
        "'needs_counsel' when you cannot tell from the letter and terms (missing information, unclear rule). " +
        "Judge only against the rules given — never your own knowledge of the law, and never certainty you do not have. " +
        "check is a short plain label ('Probation length', 'Pay floor', 'Contract reason'). Plain words; no legal advice.",
      prompt: JSON.stringify({
        rules: ruleView.map((r) => ({ id: r.id, area: r.area, rule: r.rule })),
        offer: {
          kindOfWork: row.offer.kindOfWork,
          amount: Number(row.offer.offeredCtc),
          currency: row.offer.currency,
          payBasis: row.offer.payBasis,
          joiningDate: row.offer.joiningDate,
          contractEnd: row.offer.contractEnd,
          contractMonths: row.req.contractMonths,
          hoursPerWeek: row.req.hoursPerWeek != null ? Number(row.req.hoursPerWeek) : null,
          place: zone,
        },
        letter: untrusted("offer_letter", text),
      }),
    });
    if (!result.ok) throw new Error(result.message);
    const known = new Set(rules.map((r) => r.id));
    items = result.data.items.map((i) => ({
      ...i,
      ruleId: i.ruleId && known.has(i.ruleId) ? i.ruleId : null,
    }));
    // Every rule is answered for: one the model skipped is not a pass.
    for (const r of rules)
      if (!items.some((i) => i.ruleId === r.id))
        items.push(
          OfferCheckItem.parse({
            check: `${r.area.replace(/_/g, " ")} rule`,
            verdict: "needs_counsel",
            detail: `Not checked: "${r.rule}" — review it against the letter.`,
            ruleId: r.id,
          }),
        );
    if (result.data.suspected_prompt_injection)
      items.push(
        OfferCheckItem.parse({
          check: "Letter text",
          verdict: "needs_counsel",
          detail:
            "The letter contains text that reads like instructions to the checker — a person should read it.",
        }),
      );
  }
  const check: OfferCheck = {
    at: new Date().toISOString(),
    verdict: overallVerdict(items),
    items,
    key,
    zone,
    rules: ruleView,
  };
  await db
    .update(offers)
    .set({ policyCheck: check })
    .where(and(eq(offers.id, offerId), eq(offers.orgId, orgId)));
  await writeAudit({
    actor: opts.actor ?? (opts.agentRunId ? "agent:offer" : "system"),
    actorUserId: null,
    orgId,
    action: "offer.policy_checked",
    entityType: "offer",
    entityId: offerId,
    detail: {
      verdict: check.verdict,
      items: items.length,
      fixes: items.filter((i) => i.verdict === "fix_needed").length,
      rules: rules.length,
    },
  });
  return check;
}

/**
 * Why this offer may not go for approval yet, or null (the gate in advanceOfferCore).
 * A missing or stale check, or a fix not overridden by the HR head.
 */
export async function offerCheckBlock(
  orgId: string,
  offerId: string,
  opts: { autoRun?: boolean; actor?: string } = {},
): Promise<string | null> {
  let row = await loadOffer(orgId, offerId);
  const key = await currentCheckKey(orgId, offerId);
  // Missing or stale: run it now (sending for approval is when it matters).
  if (opts.autoRun && (!row.offer.policyCheck || row.offer.policyCheck.key !== key)) {
    await runOfferCheckCore(orgId, offerId, opts.actor ? { actor: opts.actor } : {});
    row = await loadOffer(orgId, offerId);
  }
  const check = row.offer.policyCheck;
  if (!check || check.key !== key)
    return check
      ? "The labour rules, the letter or the terms changed since the offer check — run the check again before sending it for approval."
      : "Run the offer check against the labour rules before sending this offer for approval.";
  if (check.verdict === "fix_needed" && row.offer.policyOverride?.checkKey !== key) {
    const fixes = check.items.filter((i) => i.verdict === "fix_needed").map((i) => i.check);
    return `The offer check needs fixes first: ${fixes.join(", ")}. Fix the letter and run the check again, or the HR head can override it with a reason.`;
  }
  return null;
}

/** The HR head overrides a "fix needed" result for this exact check, with a reason (audited). */
export async function overrideOfferCheckCore(
  actor: { orgId: string; userId: string; memberEmail: string },
  input: { offerId: string; reason: string },
): Promise<void> {
  const { assertRole } = await import("./auth.middleware");
  await assertRole(
    actor.userId,
    actor.orgId,
    "hr_head",
    "Only the HR head (or an owner) can override the offer check.",
  );
  const reason = input.reason.trim();
  if (reason.length < 10) throw new Error("Say why the offer may go ahead as it is.");
  const row = await loadOffer(actor.orgId, input.offerId);
  const key = await currentCheckKey(actor.orgId, input.offerId);
  const check = row.offer.policyCheck;
  if (!check || check.key !== key)
    throw new Error("Run the offer check again first — it is out of date.");
  if (check.verdict !== "fix_needed") throw new Error("There is nothing to override.");
  await db
    .update(offers)
    .set({
      policyOverride: {
        by: actor.memberEmail,
        reason,
        at: new Date().toISOString(),
        checkKey: key,
      },
    })
    .where(and(eq(offers.id, input.offerId), eq(offers.orgId, actor.orgId)));
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: "offer.policy_overridden",
    entityType: "offer",
    entityId: input.offerId,
    detail: {
      reason,
      fixes: check.items.filter((i) => i.verdict === "fix_needed").map((i) => i.check),
    },
  });
  const { captureFeedback } = await import("../server/training/capture.server");
  await captureFeedback({
    orgId: actor.orgId,
    source: "offer_policy_check",
    label: "overridden",
    reason,
    original: { items: check.items },
    actorUserId: actor.userId,
    applicationId: row.offer.applicationId,
  });
}

/** The check in words for the approval card (pure). */
export function checkWords(
  check: OfferCheck | null,
  override: { by: string; reason: string } | null,
): string {
  if (!check) return "\n\nOffer check: not run.";
  const head =
    check.verdict === "pass"
      ? `Offer check against the labour rules for ${check.zone ?? "this location"}: passed.`
      : check.verdict === "needs_counsel"
        ? `Offer check: needs counsel on ${check.items
            .filter((i) => i.verdict === "needs_counsel")
            .map((i) => i.check)
            .join(", ")}.`
        : `Offer check: fixes needed on ${check.items
            .filter((i) => i.verdict === "fix_needed")
            .map((i) => i.check)
            .join(
              ", ",
            )}${override ? ` — overridden by ${override.by}: "${override.reason}"` : ""}.`;
  const lines = check.items
    .filter((i) => i.verdict !== "pass")
    .map((i) => `• ${i.check}: ${i.detail}`);
  return `\n\n${head}${lines.length ? `\n${lines.join("\n")}` : ""}`;
}
