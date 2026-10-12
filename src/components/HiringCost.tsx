import { useQuery } from "@tanstack/react-query";

import { getCandidateCost, getRoleCost } from "@/lib/hiring-cost.functions";
import { fmtMoney, fmtTokens } from "@/lib/cost-format";

type Line = { tokens: number; cost: number | null; unpricedTokens?: number };

/** Money first when known, tokens always. */
export function CostFigure({ line, currency }: { line: Line; currency: string | null }) {
  const m = fmtMoney(line.cost, currency);
  return (
    <span className="num">
      {m ? <span className="font-semibold">{m}</span> : null}
      <span className={m ? "ml-1 text-xs text-muted-foreground" : "font-semibold"}>
        {m ? `· ${fmtTokens(line.tokens)} tokens` : `${fmtTokens(line.tokens)} tokens`}
      </span>
    </span>
  );
}

/** Where the money comes from, said plainly (never the vendor or model). */
export function PricingNote({
  basis,
  checkedOn,
  unpricedTokens,
}: {
  basis: "org_rate" | "list_price" | null;
  checkedOn: string | null;
  unpricedTokens: number;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      {basis === "org_rate"
        ? "Money at your organisation's own token prices (Agent observability → Utilisation)."
        : basis === "list_price"
          ? `Money at your AI provider's published list price for the model you use${checkedOn ? ` (checked ${checkedOn})` : ""}, by the day of each request; set your own prices under Agent observability → Utilisation if you pay a different rate.`
          : "Money appears once a price is known: set your token prices under Agent observability → Utilisation."}
      {unpricedTokens > 0
        ? ` ${fmtTokens(unpricedTokens)} tokens ran on a model with no price on file and are counted in tokens only.`
        : ""}
    </p>
  );
}

/** A role's AI cost: total, shared work, each candidate and cost per hire. */
export function RoleCostCard({ requisitionId }: { requisitionId: string }) {
  const q = useQuery({
    queryKey: ["role_cost", requisitionId],
    queryFn: () => getRoleCost({ data: { requisitionId } }),
  });
  if (q.isLoading || !q.data) return <p className="text-xs text-muted-foreground">Loading cost…</p>;
  const c = q.data;
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-md border border-border p-2">
          <dt className="text-xs text-muted-foreground">Total so far</dt>
          <dd>
            <CostFigure line={c.total} currency={c.currency} />
          </dd>
          <dd className="text-xs text-muted-foreground">{c.total.requests} AI requests</dd>
        </div>
        <div className="rounded-md border border-border p-2">
          <dt className="text-xs text-muted-foreground">Shared by the role</dt>
          <dd>
            <CostFigure line={c.shared} currency={c.currency} />
          </dd>
          <dd className="text-xs text-muted-foreground">requisition, JD, sourcing, desk</dd>
        </div>
        <div className="rounded-md border border-border p-2">
          <dt className="text-xs text-muted-foreground">Cost per hire</dt>
          <dd>
            {c.costPerHire ? (
              <CostFigure line={c.costPerHire} currency={c.currency} />
            ) : (
              <span className="text-muted-foreground">— no hire yet</span>
            )}
          </dd>
          <dd className="text-xs text-muted-foreground">{c.hires} hire(s)</dd>
        </div>
      </dl>
      {c.candidates.length ? (
        <ul className="divide-y divide-border/60 rounded-md border border-border">
          {c.candidates.map((x) => (
            <li key={x.applicationId} className="space-y-1 p-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium">{x.candidate}</span>
                <span className="text-xs text-muted-foreground">{x.stage.replace(/_/g, " ")}</span>
                <span className="ml-auto">
                  <CostFigure line={x} currency={c.currency} />
                </span>
              </div>
              {x.byStage.length ? (
                <p className="text-xs text-muted-foreground">
                  {x.byStage
                    .map(
                      (s) =>
                        `${s.stage} ${fmtMoney(s.cost, c.currency) ?? `${fmtTokens(s.tokens)} tokens`}`,
                    )
                    .join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <PricingNote
        basis={c.basis}
        checkedOn={c.checkedOn}
        unpricedTokens={c.total.unpricedTokens}
      />
    </div>
  );
}

/** One candidate's direct AI cost for one role, by hiring stage. */
export function CandidateCostLine({ applicationId }: { applicationId: string }) {
  const q = useQuery({
    queryKey: ["candidate_cost", applicationId],
    queryFn: () => getCandidateCost({ data: { applicationId } }),
  });
  if (!q.data) return null;
  const { candidate: x, role } = q.data;
  return (
    <div className="rounded-md border border-border p-2 text-xs">
      <p>
        <span className="font-medium">AI cost for this candidate:</span>{" "}
        <CostFigure line={x} currency={role.currency} />
        {x.byStage.length ? (
          <span className="text-muted-foreground">
            {" "}
            —{" "}
            {x.byStage
              .map(
                (s) =>
                  `${s.stage} ${fmtMoney(s.cost, role.currency) ?? `${fmtTokens(s.tokens)} tokens`}`,
              )
              .join(" · ")}
          </span>
        ) : null}
      </p>
      <p className="text-muted-foreground">
        The role so far:{" "}
        {fmtMoney(role.total.cost, role.currency) ?? `${fmtTokens(role.total.tokens)} tokens`}{" "}
        across {role.candidates} candidate(s)
        {role.costPerHire
          ? ` · cost per hire ${fmtMoney(role.costPerHire.cost, role.currency) ?? `${fmtTokens(role.costPerHire.tokens)} tokens`}`
          : ""}
        .
      </p>
    </div>
  );
}
