/**
 * Agent observability drawer: everything about one agent, loaded on click —
 * identity & definition, assigned tools (with contracts and usage), AI skills,
 * harness limits and recent runs, human-in-the-loop, evals, audit and issues.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, CheckCircle2, OctagonX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { agentObservabilityDetail, type AgentDetail } from "@/lib/agents-observability.functions";
import { ROLE_NAME } from "@/lib/agents.catalog";

export type DrawerTab =
  "identity" | "tools" | "skills" | "harness" | "hitl" | "evals" | "audit" | "issues";

const SEV: Record<string, { color: string; Icon: typeof CheckCircle2 }> = {
  warning: { color: "#fab219", Icon: AlertTriangle },
  serious: { color: "#ec835a", Icon: AlertOctagon },
  critical: { color: "#d03b3b", Icon: OctagonX },
};

const ms = (v: number | null) =>
  v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

function Bullets({ items, empty = "None" }: { items: string[]; empty?: string }) {
  return items.length ? (
    <ul className="list-disc space-y-0.5 pl-4 text-sm">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-muted-foreground">{empty}</p>
  );
}

function Kv({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="num">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="py-1 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r, i) => (
              <tr key={i} className="border-t border-border align-top">
                {r.map((c, j) => (
                  <td key={j} className="num py-1.5 pr-3">
                    {c}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={head.length} className="py-2 text-muted-foreground">
                Nothing recorded yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function AgentDetailDrawer({
  agentType,
  tab,
  onTab,
  onClose,
}: {
  agentType: string | null;
  tab: DrawerTab;
  onTab: (t: DrawerTab) => void;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["agent_detail", agentType],
    queryFn: () => agentObservabilityDetail({ data: { agentType: agentType! } }),
    enabled: Boolean(agentType),
    retry: false,
  });
  const d = q.data;
  return (
    <Sheet open={Boolean(agentType)} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{d ? `${d.identity.name} · v${d.identity.version}` : "Agent"}</SheetTitle>
          <SheetDescription>
            {d ? d.identity.responsibility : q.isLoading ? "Loading…" : "Not available."}
          </SheetDescription>
        </SheetHeader>
        {q.error ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {q.error instanceof Error ? q.error.message : "Not available."}
          </p>
        ) : d ? (
          <Tabs value={tab} onValueChange={(v) => onTab(v as DrawerTab)} className="mt-4">
            <TabsList className="flex h-auto flex-wrap">
              <TabsTrigger value="identity">Identity</TabsTrigger>
              <TabsTrigger value="tools">Tools ({d.tools.length})</TabsTrigger>
              <TabsTrigger value="skills">Skills ({d.skills.length})</TabsTrigger>
              <TabsTrigger value="harness">Harness</TabsTrigger>
              <TabsTrigger value="hitl">Human-in-the-loop</TabsTrigger>
              <TabsTrigger value="evals">Evals ({d.evals.length})</TabsTrigger>
              <TabsTrigger value="audit">Audit</TabsTrigger>
              <TabsTrigger value="issues">Issues ({d.issues.open.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="identity">
              <IdentityTab d={d} />
            </TabsContent>
            <TabsContent value="tools">
              <ToolsTab d={d} />
            </TabsContent>
            <TabsContent value="skills">
              <SkillsTab d={d} />
            </TabsContent>
            <TabsContent value="harness">
              <HarnessTab d={d} />
            </TabsContent>
            <TabsContent value="hitl">
              <HitlTab d={d} />
            </TabsContent>
            <TabsContent value="evals">
              <Section title="Eval scenarios (run in CI on every change; CI fails if none)">
                <Bullets items={d.evals.map((e) => e.name)} empty="None — CI blocks this agent." />
              </Section>
              <p className="mt-3 text-xs text-muted-foreground">
                Each scenario runs this exact agent and its real tools against seeded data with a
                scripted model, checking tool order, gate routing and the outcome. A live-model run
                uses the same scenarios (`bun run eval:agents`).
              </p>
            </TabsContent>
            <TabsContent value="audit">
              <Section title="Latest audit events written by this agent">
                <Table
                  head={["When", "Action", "Entity", "Actor"]}
                  rows={d.audit.map((a) => [
                    when(a.at),
                    a.action,
                    a.entityType ?? "—",
                    a.actor.split(":").slice(0, 2).join(":"),
                  ])}
                />
              </Section>
            </TabsContent>
            <TabsContent value="issues">
              <IssuesTab d={d} />
            </TabsContent>
          </Tabs>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function IdentityTab({ d }: { d: AgentDetail }) {
  const i = d.identity;
  return (
    <>
      <Section title="Identity">
        <Kv
          rows={[
            ["Agent id", i.type],
            ["Version", `v${i.version}`],
            [
              "Manifest hash",
              <code key="h" className="break-all text-xs">
                {i.hash}
              </code>,
            ],
            ["Accountable owner", ROLE_NAME[i.owner] ?? i.owner],
            ["Risk tier", i.riskTier],
            ["Ledger slug", i.feature],
            ["Acts as", "the person it works for — never with more rights"],
          ]}
        />
      </Section>
      <Section title="Current settings in this organisation">
        <Kv
          rows={[
            ["Status", i.policy.enabled ? "On" : "Off"],
            ["Autonomy", i.policy.autonomy.replace(/_/g, " ")],
            ["Pre-approved emails", i.policy.whitelistedTemplates.join(", ") || "none"],
            ["Monthly token budget", i.policy.monthlyTokenBudget?.toLocaleString() ?? "no cap"],
          ]}
        />
      </Section>
      <div className="grid gap-x-6 sm:grid-cols-3">
        <Section title="May read">
          <Bullets items={i.scope.reads} />
        </Section>
        <Section title="May change">
          <Bullets items={i.scope.writes} />
        </Section>
        <Section title="May send outside">
          <Bullets items={i.scope.external} />
        </Section>
      </div>
      <Section title="Must never">
        <Bullets items={i.mustNever} />
      </Section>
      <Section title="Human decisions it may request">
        <Bullets items={i.gates} />
      </Section>
      <Section title="Definition versions (each stored once by hash; runs record theirs)">
        <Table
          head={["Version", "Hash", "First seen", "Runs here"]}
          rows={i.versions.map((v) => [
            `v${v.version}`,
            <code key={v.hash}>{v.hash.slice(0, 16)}</code>,
            when(v.firstSeen),
            v.runs,
          ])}
        />
      </Section>
    </>
  );
}

function ToolsTab({ d }: { d: AgentDetail }) {
  return (
    <>
      <p className="mt-3 text-xs text-muted-foreground">
        The only tools this agent can call (plus ask a person, request an approval, hand off). Read
        tools always run; write and external tools follow the autonomy setting. Usage is the last 7
        days.
      </p>
      {d.tools.map((t) => (
        <details key={t.name} className="mt-3 rounded-md border border-border p-3">
          <summary className="cursor-pointer list-none">
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-sm font-medium">{t.name}</code>
              <Badge
                variant={
                  t.risk === "read"
                    ? "outline"
                    : t.risk === "external"
                      ? "destructive"
                      : "secondary"
                }
              >
                {t.risk}
              </Badge>
              {t.preApprovable ? <Badge variant="outline">pre-approvable</Badge> : null}
              {t.untrustedOutput ? <Badge variant="outline">output fenced</Badge> : null}
              <span className="num ml-auto text-xs text-muted-foreground">
                {t.calls7d} calls · {t.errors7d} errors · avg {ms(t.avgMs)}
                {t.awaitingApproval7d ? ` · ${t.awaitingApproval7d} sent for approval` : ""}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
          </summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <Kv
                rows={[
                  ["AI skills", t.skills.join(", ") || "none"],
                  ["Last used", when(t.lastUsedAt)],
                  ["Last error", t.lastError ?? "—"],
                ]}
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                Input contract (validated before it runs)
              </p>
              <pre className="mt-1 max-h-56 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-[11px]">
                {t.inputSchemaJson}
              </pre>
            </div>
          </div>
        </details>
      ))}
    </>
  );
}

function SkillsTab({ d }: { d: AgentDetail }) {
  return (
    <Section title="AI skills — every AI request in this agent's runs, incl. inside tools (7 days)">
      <Table
        head={["Skill (ledger slug)", "Used by", "Requests", "Errors", "Tokens", "Avg", "p95"]}
        rows={d.skills.map((s) => [
          <code key={s.feature}>{s.feature}</code>,
          s.usedBy.join(", ") || "—",
          s.requests7d,
          s.errors7d,
          s.tokens7d.toLocaleString(),
          ms(s.avgMs),
          ms(s.p95Ms),
        ])}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Models are the organisation's own; vendor and model names are kept to the AI settings page.
      </p>
    </Section>
  );
}

function HarnessTab({ d }: { d: AgentDetail }) {
  const h = d.harness;
  return (
    <>
      <Section title="Limits every run executes under">
        <Kv
          rows={[
            ["Max model steps per run", h.maxSteps],
            ["Max tokens per run", h.maxTokensPerRun.toLocaleString()],
            ["Model turns per scheduler tick", h.turnsPerTick],
            ["Worker lease", `${h.leaseMinutes} min (reclaimed if the worker dies)`],
            ["Attempts before failing", h.maxAttempts],
            ["Runs driven in parallel per tick", h.concurrency],
            ["Budget-paused runs re-checked every", `${h.budgetRecheckMinutes} min`],
          ]}
        />
      </Section>
      <Section title="Autonomy — what happens to each kind of tool call">
        <Table
          head={["Tool risk", "Suggest", "Act and notify", "Autonomous"]}
          rows={h.autonomyRules.map((r) => [r.risk, r.suggest, r.act_and_notify, r.autonomous])}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Approvals, releases, rejections and hiring decisions are never tools — only people decide
          them.
        </p>
      </Section>
      <Section title="Human-in-the-loop tools (always available)">
        <Table
          head={["Tool", "Purpose"]}
          rows={h.humanTools.map((t) => [<code key={t.name}>{t.name}</code>, t.description])}
        />
      </Section>
      <Section title="Recent runs">
        <Table
          head={["Started", "Status", "Steps", "Tokens", "Minutes", "Version", "Goal / error"]}
          rows={h.recentRuns.map((r) => [
            when(r.createdAt),
            r.status.replace(/_/g, " "),
            r.steps,
            r.tokens.toLocaleString(),
            r.durationMinutes ?? "—",
            r.definitionVersion ? `v${r.definitionVersion}` : "—",
            r.error ? (
              <span key="e" className="text-destructive">
                {r.error}
              </span>
            ) : (
              r.goal
            ),
          ])}
        />
      </Section>
      <Section title="Instructions (this version)">
        <pre className="whitespace-pre-wrap rounded border border-border bg-muted/30 p-2 text-xs">
          {h.instructions}
        </pre>
      </Section>
      <Section title="Shared rules prepended to every agent">
        <pre className="whitespace-pre-wrap rounded border border-border bg-muted/30 p-2 text-xs">
          {`${h.injectionRules}\n\n${h.sharedRules}`}
        </pre>
      </Section>
    </>
  );
}

function HitlTab({ d }: { d: AgentDetail }) {
  return (
    <>
      <Section title="Waiting on a person now">
        <Table
          head={["Request", "Kind", "Routed to", "Age"]}
          rows={d.hitl.open.map((t) => [
            t.title,
            t.kind,
            ROLE_NAME[t.assignee] ?? t.assignee,
            `${t.ageHours} h`,
          ])}
        />
      </Section>
      <Section title="Recent decisions">
        <Table
          head={["Decided", "Request", "Kind", "Outcome", "By", "Waited"]}
          rows={d.hitl.recent.map((t) => [
            when(t.decidedAt),
            t.title,
            t.kind,
            `${t.status}${t.edited ? " (edited)" : ""}`,
            t.decidedBy ?? "—",
            t.waitMinutes == null ? "—" : `${t.waitMinutes} min`,
          ])}
        />
      </Section>
    </>
  );
}

function IssuesTab({ d }: { d: AgentDetail }) {
  return (
    <>
      <Section title="Open">
        {d.issues.open.length ? (
          <ul className="space-y-2">
            {d.issues.open.map((i) => {
              const s = SEV[i.severity]!;
              return (
                <li key={i.id} className="text-sm">
                  <span className="inline-flex items-center gap-1 font-medium">
                    <s.Icon className="size-3.5" style={{ color: s.color }} aria-hidden />{" "}
                    {i.severity}
                  </span>{" "}
                  {i.title}
                  <p className="text-xs text-muted-foreground">
                    {i.element} · <code>{i.rule}</code> · since {when(i.firstSeenAt)} · {i.status} —{" "}
                    {i.description}
                  </p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="inline-flex items-center gap-1 text-sm">
            <CheckCircle2 className="size-3.5" style={{ color: "#0ca30c" }} aria-hidden /> No open
            issues
          </p>
        )}
      </Section>
      <Section title="Recently resolved">
        <Table
          head={["Rule", "Issue", "Severity", "Opened", "Resolved"]}
          rows={d.issues.resolved.map((r) => [
            <code key={r.rule + r.resolvedAt}>{r.rule}</code>,
            r.title,
            r.severity,
            when(r.firstSeenAt),
            when(r.resolvedAt),
          ])}
        />
      </Section>
    </>
  );
}
