import { createFileRoute, Link } from "@tanstack/react-router";
import { explainEval } from "@/lib/eval-catalog";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ArrowRight, Search, ShieldCheck } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

/** What each kind of human decision an agent may ask for is, in plain words. */
const GATE_LABEL: Record<string, string> = {
  general: "Questions and approvals to a named role",
  requisition: "Requisition approval (performed by the approver)",
  jd: "JD approval (performed by the approver)",
  rejection: "Candidate rejection batches",
  screening_decision: "Who moves on after screening",
  hiring_decision: "The hiring decision (the hiring manager decides)",
  panel_approval: "Who interviews for a round",
  panel_substitute: "A stand-in for a panellist who can't make it",
  panel_review:
    "A review when its view of an interview differs from the panel's (the HR head decides)",
  org_profile: "Organisation profile approval",
  expert_brief: "The role's expert brief (the hiring manager approves)",
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
        <RegisterBody agents={q.data} />
      )}
    </>
  );
}

/** The anchor of an agent's card (a link with #agent-… opens it). */
const anchorOf = (type: string) => `agent-${type}`;

/** Words an agent is found by: its name, id, responsibility and owner. */
const searchText = (a: AgentRegisterEntry) =>
  [a.manifest.name, a.type, a.manifest.responsibility, ROLE_NAME[a.manifest.owner] ?? ""]
    .join(" ")
    .toLowerCase();

const riskLabel = (r: string) => `${r.charAt(0).toUpperCase()}${r.slice(1)} risk`;

const RISK_FILTERS = ["all", "low", "medium", "high"] as const;
type RiskFilter = (typeof RISK_FILTERS)[number];

type RiskStyle = { chip: string; dot: string; bar: string };
const LOW_RISK: RiskStyle = {
  chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  dot: "bg-emerald-500",
  bar: "bg-emerald-500",
};
const RISK_STYLE: Record<string, RiskStyle> = {
  low: LOW_RISK,
  medium: {
    chip: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
    bar: "bg-amber-500",
  },
  high: {
    chip: "bg-destructive/10 text-destructive",
    dot: "bg-destructive",
    bar: "bg-destructive",
  },
};

/** Every agent as a card in a grid; a card opens its full register entry in a side panel. */
function RegisterBody({ agents }: { agents: AgentRegisterEntry[] }) {
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState<RiskFilter>("all");
  const [openType, setOpenType] = useState<string | null>(null);
  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.replace(/^#agent-/, "");
      if (h && agents.some((a) => a.type === h)) setOpenType(h);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [agents]);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = agents.filter(
    (a) =>
      (risk === "all" || a.manifest.riskTier === risk) &&
      words.every((w) => searchText(a).includes(w)),
  );
  const count = (r: RiskFilter) =>
    r === "all" ? agents.length : agents.filter((a) => a.manifest.riskTier === r).length;
  const opened = agents.find((a) => a.type === openType) ?? null;
  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">Agents</h2>
        <div
          role="radiogroup"
          aria-label="Show agents by risk"
          className="inline-flex rounded-full border bg-muted/40 p-0.5"
        >
          {RISK_FILTERS.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={risk === r}
              onClick={() => setRisk(r)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                risk === r
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r === "all" ? "All" : riskLabel(r)}{" "}
              <span className="num text-muted-foreground">{count(r)}</span>
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search agents"
            placeholder="Search name, id or owner"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-8"
          />
        </div>
      </div>

      {shown.length ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((a) => (
            <AgentTile
              key={a.type}
              a={a}
              selected={openType === a.type}
              onOpen={() => setOpenType(a.type)}
            />
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">No agent matches.</p>
      )}

      <Sheet
        open={!!opened}
        onOpenChange={(o) => {
          if (o) return;
          setOpenType(null);
          if (window.location.hash.startsWith("#agent-"))
            history.replaceState(null, "", window.location.pathname + window.location.search);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          {opened ? <AgentDetail key={opened.type} a={opened} /> : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

function AgentTile({
  a,
  selected,
  onOpen,
}: {
  a: AgentRegisterEntry;
  selected: boolean;
  onOpen: () => void;
}) {
  const m = a.manifest;
  const style = RISK_STYLE[m.riskTier] ?? LOW_RISK;
  const owner = ROLE_NAME[m.owner] ?? m.owner;
  const budget = a.policy.monthlyTokenBudget;
  const used = budget ? Math.min(100, Math.round((a.monthTokens / budget) * 100)) : null;
  return (
    <article
      id={anchorOf(a.type)}
      onClick={onOpen}
      className={`glass-card group flex cursor-pointer flex-col overflow-hidden p-3.5 pb-4 ${
        selected ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <div className="flex items-center gap-2 text-[0.6875rem]">
        <span className="num font-medium text-muted-foreground">v{a.version}</span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium ${style.chip}`}
        >
          <span className={`size-1.5 rounded-full ${style.dot}`} />
          {riskLabel(m.riskTier)}
        </span>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 font-medium ${
            a.policy.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
          }`}
        >
          {a.policy.enabled ? "On" : "Off"}
        </span>
      </div>

      <h3 className="mt-2.5 text-sm font-semibold leading-snug">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {m.name}
        </button>
      </h3>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{m.responsibility}</p>

      <div className="mt-auto pt-3">
        <p className="text-[0.6875rem] text-muted-foreground">
          <span className="font-medium text-foreground">{a.last30.runs}</span> runs ·{" "}
          {a.last30.done} done · {a.last30.failed} stopped
        </p>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          {used !== null ? (
            <div
              className={`h-full rounded-full ${used >= 90 ? "bg-destructive" : "bg-foreground"}`}
              style={{ width: `${used}%` }}
            />
          ) : null}
        </div>
        <div className="mt-1 flex items-baseline gap-2 text-[0.6875rem] text-muted-foreground">
          <span className="num min-w-0 truncate">
            {a.monthTokens.toLocaleString()}
            {budget != null ? ` / ${budget.toLocaleString()}` : ""} tokens
          </span>
          <span className="ml-auto shrink-0">{m.tools.length} tools</span>
        </div>

        <div className="mt-3 flex items-center gap-2 border-t border-foreground/5 pt-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[0.625rem] font-semibold text-primary">
            {owner
              .split(/[\s/]+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((w) => w[0]?.toUpperCase())
              .join("")}
          </span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-xs font-medium">{owner}</p>
            <p className="text-[0.625rem] text-muted-foreground">Accountable owner</p>
          </div>
          <Button
            size="icon"
            className="ml-auto size-6 shrink-0 rounded-full"
            aria-label={`Open ${m.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
      <span className={`absolute inset-x-3.5 bottom-0 h-1 rounded-t-full ${style.bar}`} />
    </article>
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

function AgentDetail({ a }: { a: AgentRegisterEntry }) {
  const [showInstructions, setShowInstructions] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  const m = a.manifest;
  return (
    <>
      <SheetHeader className="pr-8 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <SheetTitle>{m.name}</SheetTitle>
          <Badge variant="outline" className="num">
            v{a.version}
          </Badge>
          <Badge variant={RISK_TONE[m.riskTier] ?? "secondary"}>{m.riskTier} risk</Badge>
          <Badge variant={a.policy.enabled ? "default" : "outline"}>
            {a.policy.enabled ? `On · ${a.policy.autonomy.replace(/_/g, " ")}` : "Off"}
          </Badge>
        </div>
        <SheetDescription className="num text-[0.6875rem]">
          id {a.type} · hash {a.hash.slice(0, 12)}
        </SheetDescription>
      </SheetHeader>
      <div>
        <p className="mt-2 text-sm">{m.responsibility}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Accountable owner: {ROLE_NAME[m.owner] ?? m.owner} · acts on behalf of the person it works
          for, never with more rights · step limit {m.maxSteps}
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <List title="May read" items={m.scope.reads} />
          <List title="May change (inside the organisation)" items={m.scope.writes} />
          <List title="May send outside the organisation" items={m.scope.external} />
          <List title="Must never" items={m.mustNever} />
          <List
            title="Human decisions it may request"
            items={m.gates.map((g) => GATE_LABEL[g] ?? g.replace(/_/g, " "))}
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

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <List
            title="Rehearsals before every release"
            items={m.evals.map((e) => explainEval(e).title)}
          />
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
          <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[0.6875rem]">
            {a.manifestJson}
          </pre>
        ) : null}
      </div>
    </>
  );
}
