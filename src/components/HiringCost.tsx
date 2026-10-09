import { useQuery } from "@tanstack/react-query";

import { getCandidateCost, getRoleCost } from "@/lib/hiring-cost.functions";

const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : `${n}`;
const money = (cost: number | null, currency: string | null) =>
  cost == null || !currency
    ? null
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: cost < 1 ? 3 : 2,
      }).format(cost);
const both = (t: number, cost: number | null, currency: string | null) => {
  const m = money(cost, currency);
  return m ? `${tokens(t)} tokens · ${m}` : `${tokens(t)} tokens`;
};

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
      <dl className="grid grid-cols-3 gap-2">
        <div className="rounded-md border border-border p-2">
          <dt className="text-xs text-muted-foreground">Total so far</dt>
          <dd className="num font-semibold">{both(c.total.tokens, c.total.cost, c.currency)}</dd>
          <dd className="text-xs text-muted-foreground">{c.total.requests} AI requests</dd>
        </div>
        <div className="rounded-md border border-border p-2">
          <dt className="text-xs text-muted-foreground">Shared by the role</dt>
          <dd className="num font-semibold">{both(c.shared.tokens, c.shared.cost, c.currency)}</dd>
          <dd className="text-xs text-muted-foreground">requisition, JD, sourcing, desk</dd>
        </div>
        <div className="rounded-md border border-border p-2">
          <dt className="text-xs text-muted-foreground">Cost per hire</dt>
          <dd className="num font-semibold">
            {c.costPerHire
              ? both(c.costPerHire.tokens, c.costPerHire.cost, c.currency)
              : "— no hire yet"}
          </dd>
          <dd className="text-xs text-muted-foreground">{c.hires} hire(s)</dd>
        </div>
      </dl>
      {c.candidates.length ? (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-1 font-medium">Candidate</th>
              <th className="py-1 font-medium">Stage</th>
              <th className="py-1 text-right font-medium">Direct cost</th>
              <th className="py-1 font-medium">Where it went</th>
            </tr>
          </thead>
          <tbody>
            {c.candidates.map((x) => (
              <tr key={x.applicationId} className="border-b border-border/60 align-top">
                <td className="py-1">{x.candidate}</td>
                <td className="py-1">{x.stage.replace(/_/g, " ")}</td>
                <td className="num py-1 text-right">{both(x.tokens, x.cost, c.currency)}</td>
                <td className="py-1 text-muted-foreground">
                  {x.byStage.map((s) => `${s.stage} ${tokens(s.tokens)}`).join(" · ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {!c.currency ? (
        <p className="text-xs text-muted-foreground">
          Money appears once your token prices are set (Agent observability → Utilisation).
        </p>
      ) : null}
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
        <span className="num">{both(x.tokens, x.cost, role.currency)}</span>
        {x.byStage.length ? (
          <span className="text-muted-foreground">
            {" "}
            — {x.byStage.map((s) => `${s.stage} ${tokens(s.tokens)}`).join(" · ")}
          </span>
        ) : null}
      </p>
      <p className="text-muted-foreground">
        The role so far: {both(role.total.tokens, role.total.cost, role.currency)} across{" "}
        {role.candidates} candidate(s)
        {role.costPerHire
          ? ` · cost per hire ${both(role.costPerHire.tokens, role.costPerHire.cost, role.currency)}`
          : ""}
        .
      </p>
    </div>
  );
}
