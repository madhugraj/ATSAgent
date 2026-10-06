import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROLE_NAME } from "@/lib/agents.catalog";
import { agentRegister, type AgentRegisterEntry } from "@/lib/agents.functions";

export const Route = createFileRoute("/agents/register")({
  head: () => ({
    meta: [
      { title: "Agent register — ATSIQ" },
      {
        name: "description",
        content:
          "Every hiring agent's identity, owner, version, responsibility, permissions, tools, skills, evals and activity.",
      },
    ],
  }),
  component: AgentRegisterPage,
});

const RISK_TONE: Record<string, "default" | "secondary" | "destructive"> = {
  low: "secondary",
  medium: "default",
  high: "destructive",
};

function AgentRegisterPage() {
  const q = useQuery({
    queryKey: ["agent_register"],
    queryFn: () => agentRegister(),
    retry: false,
  });
  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Agent register"
        description="What each hiring agent is, who owns it, what it may and must never do, the tools and AI skills it uses, how it is tested, and what it has done here. Every run records the exact version it ran under; export a run's trail from Agent decisions → Agent activity."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/agents/settings">Agent settings</Link>
          </Button>
        }
      />
      {q.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {q.error instanceof Error ? q.error.message : "Not available."}
        </p>
      ) : !q.data?.length ? (
        <EmptyState title="No agents in this build" />
      ) : (
        <div className="mt-4 space-y-4">
          {q.data.map((a) => (
            <AgentCard key={a.type} a={a} />
          ))}
        </div>
      )}
    </>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {items.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
          {items.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">None</p>
      )}
    </div>
  );
}

function AgentCard({ a }: { a: AgentRegisterEntry }) {
  const [showInstructions, setShowInstructions] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  const m = a.manifest;
  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-4 text-primary" />
        <h2 className="font-semibold">{m.name}</h2>
        <Badge variant="outline" className="num">
          v{a.version}
        </Badge>
        <Badge variant={RISK_TONE[m.riskTier] ?? "secondary"}>{m.riskTier} risk</Badge>
        <Badge variant={a.policy.enabled ? "default" : "outline"}>
          {a.policy.enabled ? `On · ${a.policy.autonomy.replace(/_/g, " ")}` : "Off"}
        </Badge>
        <span className="num ml-auto text-[11px] text-muted-foreground">
          id {a.type} · hash {a.hash.slice(0, 12)}
        </span>
      </div>
      <p className="mt-2 text-sm">{m.responsibility}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Accountable owner: {ROLE_NAME[m.owner] ?? m.owner} · acts on behalf of the person it works
        for, never with more rights · step limit {m.maxSteps}
      </p>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <List title="May read" items={m.scope.reads} />
        <List title="May change (inside the organisation)" items={m.scope.writes} />
        <List title="May send outside the organisation" items={m.scope.external} />
        <List title="Must never" items={m.mustNever} />
        <List
          title="Human decisions it may request"
          items={m.gates.map((g) =>
            g === "general"
              ? "Questions and approvals to a named role"
              : g === "rejection"
                ? "Candidate rejection batches"
                : `${g === "jd" ? "JD" : "Requisition"} approval (performed by the approver)`,
          )}
        />
        <List title="AI skills used" items={m.skills} />
      </div>

      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tools ({m.tools.length})
        </p>
        <div className="mt-1 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Tool</th>
                <th className="py-1 pr-3 font-medium">Risk</th>
                <th className="py-1 pr-3 font-medium">AI skills</th>
                <th className="py-1 font-medium">What it does</th>
              </tr>
            </thead>
            <tbody>
              {m.tools.map((t) => (
                <tr key={t.name} className="border-t border-border align-top">
                  <td className="py-1.5 pr-3">
                    <code className="text-xs">{t.name}</code>
                  </td>
                  <td className="py-1.5 pr-3 text-xs">
                    {t.risk}
                    {t.preApprovable ? " · pre-approvable" : ""}
                    {t.untrustedOutput ? " · fenced output" : ""}
                  </td>
                  <td className="py-1.5 pr-3 text-xs">{t.skills.join(", ") || "—"}</td>
                  <td className="py-1.5 text-xs text-muted-foreground">{t.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Always available: ask a person, request an approval, hand off.
        </p>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <List title="Evals (run in CI on every change)" items={m.evals} />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Activity here (30 days)
          </p>
          <p className="num mt-1 text-sm">
            {a.last30.runs} runs · {a.last30.done} done · {a.last30.failed} stopped ·{" "}
            {a.last30.decisions} human decisions · {a.last30.edited} edited before approval
          </p>
          <p className="num mt-1 text-xs text-muted-foreground">
            {a.monthTokens.toLocaleString()} tokens this month
            {a.policy.monthlyTokenBudget != null
              ? ` of ${a.policy.monthlyTokenBudget.toLocaleString()} budget`
              : " (no budget set)"}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Version history
          </p>
          {a.versions.length ? (
            <ul className="num mt-1 space-y-0.5 text-xs">
              {a.versions.map((v) => (
                <li key={v.hash}>
                  v{v.version} · {v.hash.slice(0, 12)} · first ran{" "}
                  {new Date(v.firstSeen).toLocaleDateString()}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Not run yet.</p>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => setShowInstructions((v) => !v)}>
          {showInstructions ? "Hide instructions" : "Instructions"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowManifest((v) => !v)}>
          {showManifest ? "Hide full manifest" : "Full manifest (JSON)"}
        </Button>
      </div>
      {showInstructions ? (
        <pre className="mt-2 whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs">
          {m.instructions}
        </pre>
      ) : null}
      {showManifest ? (
        <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px]">
          {a.manifestJson}
        </pre>
      ) : null}
    </section>
  );
}
