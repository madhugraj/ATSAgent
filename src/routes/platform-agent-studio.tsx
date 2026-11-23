import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  CircleCheck,
  CircleX,
  Copy,
  CopyPlus,
  Download,
  FlaskConical,
  KeyRound,
  Lock,
  Plus,
  RotateCcw,
  Rocket,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { usePlatform } from "@/hooks/usePlatform";
import { AGENT_LABEL, ROLE_NAME } from "@/lib/agents.catalog";
import {
  agentStudio,
  approveStudioAgent,
  archiveStudioAgent,
  createStudioKey,
  downloadStudioPackage,
  duplicateStudioAgent,
  grantStudioAgent,
  publishStudioAgent,
  revokeStudioAgent,
  revokeStudioKey,
  saveStudioAgent,
  setStudioWorkspace,
  testStudioAgent,
  type SaveStudioAgentInput,
  type StudioAgentRow,
  type StudioView,
} from "@/lib/platform-agent-studio.functions";

export const Route = createFileRoute("/platform-agent-studio")({
  head: () => ({
    meta: [
      { title: "Agent studio — ATSIQ" },
      {
        name: "description",
        content: "Build agents for organisations and external applications.",
      },
    ],
  }),
  component: AgentStudioPage,
});

const LIFECYCLE = ["draft", "tested", "approved", "published"] as const;
const STATUS_TONE: Record<string, "default" | "secondary" | "outline"> = {
  published: "default",
  approved: "default",
  tested: "secondary",
  draft: "secondary",
  archived: "outline",
};
const GATE_LABEL: Record<string, string> = {
  general: "Questions and approvals",
  requisition: "Requisition approval",
  jd: "JD approval",
  rejection: "Rejection batches",
  screening_decision: "Screening decision",
  hiring_decision: "Hiring decision",
  panel_approval: "Panel approval",
  panel_substitute: "Panel stand-in",
  org_profile: "Organisation profile",
  expert_brief: "Expert brief",
  panel_review: "Panel review",
  new_panelist: "New panellist",
  pay_conventions: "Pay conventions",
  policy_briefing: "Policy briefing",
  policy_finding: "Policy finding",
};

const agentName = (type: string, fallback?: string) => AGENT_LABEL[type] ?? fallback ?? type;
const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const lines = (t: string) =>
  t
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

function AgentStudioPage() {
  const { isSuperUser, isLoading } = usePlatform();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["platform_agent_studio"],
    queryFn: () => agentStudio(),
    enabled: isSuperUser,
    retry: false,
  });
  const [open, setOpen] = useState<string | "new" | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["platform_agent_studio"] });

  if (isLoading) return <p className="text-sm text-muted-foreground">Checking platform access…</p>;
  if (!isSuperUser)
    return (
      <>
        <PageHeader eyebrow="Platform" title="Agent studio" />
        <section className="panel max-w-lg p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4 text-muted-foreground" /> Super-user access only
          </h2>
        </section>
      </>
    );

  const data = q.data;
  const editing = open && open !== "new" ? data?.agents.find((b) => b.id === open) : undefined;
  const orgName = (id: string) => data?.organisations.find((o) => o.id === id)?.name ?? "—";

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Agent studio"
        description="Build agents, test them with sample data, approve and publish them to the organisations you pick, or deliver them to external applications."
        actions={
          <Button size="sm" onClick={() => setOpen("new")}>
            <Plus className="size-4" /> New agent
          </Button>
        }
      />
      {q.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <p className="mt-4 text-sm text-muted-foreground">{errorText(q.error, "Not available.")}</p>
      ) : !data?.agents.length ? (
        <EmptyState title="No studio agents yet" />
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">Origin</th>
                <th className="px-4 py-2 font-medium">Live</th>
                <th className="px-4 py-2 font-medium">Organisations</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((b) => (
                <tr
                  key={b.id}
                  className="cursor-pointer border-t hover:bg-muted/30"
                  onClick={() => setOpen(b.id)}
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{b.name}</div>
                    <div className="font-mono text-[0.6875rem] text-muted-foreground">{b.type}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    {b.baseType ? agentName(b.baseType) : "New"}
                    {b.outOfDate ? (
                      <Badge variant="outline" className="ml-2">
                        Agent updated
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {b.publishedVersion ? `v${b.publishedVersion}` : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {b.grants.length
                      ? b.grants
                          .map((g) => orgName(g.orgId))
                          .slice(0, 2)
                          .join(", ") + (b.grants.length > 2 ? ` +${b.grants.length - 2}` : "")
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={STATUS_TONE[b.status]}>
                      {b.status} · v{b.version}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={Boolean(open)} onOpenChange={(o) => (!o ? setOpen(null) : undefined)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-4xl">
          {data && (open === "new" || editing) ? (
            <AgentEditor
              key={editing ? `${editing.id}:${editing.version}:${editing.status}` : "new"}
              view={data}
              existing={editing}
              onSaved={(id) => {
                refresh();
                setOpen(id);
              }}
              onClosed={() => {
                refresh();
                setOpen(null);
              }}
              onChanged={refresh}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

type ToolRow = { name: string; description: string };
type ScenarioDraft = {
  name: string;
  goal: string;
  fixturesJson: string;
  expectCalls: string;
  expectApproval: boolean;
};

function toolDescription(view: StudioView, name: string): string {
  for (const g of view.catalogue) {
    const t = g.tools.find((x) => x.name === name);
    if (t) return t.description;
  }
  return "";
}

function AgentEditor({
  view,
  existing,
  onSaved,
  onClosed,
  onChanged,
}: {
  view: StudioView;
  existing: StudioAgentRow | undefined;
  onSaved: (id: string) => void;
  onClosed: () => void;
  onChanged: () => void;
}) {
  const [origin, setOrigin] = useState<"adapted" | "new">(existing?.origin ?? "adapted");
  const [baseType, setBaseType] = useState(existing?.baseType ?? "");
  const base = view.stockAgents.find((a) => a.type === baseType);
  const started = Boolean(existing) || origin === "new" || Boolean(base);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [responsibility, setResponsibility] = useState(existing?.responsibility ?? "");
  const [instructions, setInstructions] = useState(existing?.instructions ?? "");
  const [mustNever, setMustNever] = useState((existing?.mustNever ?? []).join("\n"));
  const [riskTier, setRiskTier] = useState<"low" | "medium" | "high">(
    existing?.riskTier ?? "medium",
  );
  const [ownerRole, setOwnerRole] = useState(existing?.ownerRole ?? "hr_head");
  const [gates, setGates] = useState<string[]>(existing?.gates ?? ["general"]);
  const [reads, setReads] = useState((existing?.scope.reads ?? []).join("\n"));
  const [writes, setWrites] = useState((existing?.scope.writes ?? []).join("\n"));
  const [external, setExternal] = useState((existing?.scope.external ?? []).join("\n"));
  const [tools, setTools] = useState<Record<string, ToolRow>>(
    Object.fromEntries(
      (existing?.tools ?? []).map((t) => [
        t,
        {
          name: existing?.toolOverrides[t]?.name || t,
          description: existing?.toolOverrides[t]?.description || toolDescription(view, t),
        },
      ]),
    ),
  );
  const [steps, setSteps] = useState(existing?.maxSteps?.toString() ?? "");
  const [scenarios, setScenarios] = useState<ScenarioDraft[]>(
    (existing?.testScenarios ?? []).map((t) => ({
      name: t.name,
      goal: t.goal,
      fixturesJson: t.fixturesJson,
      expectCalls: t.expectCalls.join(", "),
      expectApproval: t.expectApproval,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [testOrg, setTestOrg] = useState(view.owned[0]?.id ?? "");

  const pickBase = (type: string) => {
    const a = view.stockAgents.find((x) => x.type === type);
    if (!a) return;
    setBaseType(type);
    setName(`${agentName(a.type, a.name)} (studio)`);
    setResponsibility(a.responsibility);
    setInstructions(a.instructions);
    setMustNever(a.mustNever.join("\n"));
    setRiskTier(a.riskTier);
    setOwnerRole(a.owner);
    setGates(a.gates.filter((g) => view.gateKinds.includes(g)));
    setReads(a.scope.reads.join("\n"));
    setWrites(a.scope.writes.join("\n"));
    setExternal(a.scope.external.join("\n"));
    setTools(
      Object.fromEntries(
        a.tools.map((t) => [t, { name: t, description: toolDescription(view, t) }]),
      ),
    );
  };

  const run = async (fn: () => Promise<void>, fail: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorText(e, fail));
    } finally {
      setBusy(false);
    }
  };

  const input = (): SaveStudioAgentInput => ({
    id: existing?.id,
    origin,
    baseType: origin === "adapted" ? baseType : null,
    name,
    description,
    responsibility,
    instructions,
    mustNever: lines(mustNever),
    tools: Object.keys(tools),
    toolOverrides: tools,
    maxSteps: steps.trim() ? Number(steps) : null,
    riskTier,
    ownerRole,
    gates,
    scope: { reads: lines(reads), writes: lines(writes), external: lines(external) },
    testScenarios: scenarios.map((s) => ({
      name: s.name,
      goal: s.goal,
      fixturesJson: s.fixturesJson,
      expectCalls: s.expectCalls
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      expectApproval: s.expectApproval,
    })),
  });

  const save = () =>
    run(async () => {
      const r = await saveStudioAgent({ data: input() });
      toast.success("Saved as a draft");
      onSaved(r.id);
    }, "Could not save");

  const test = () =>
    run(async () => {
      if (!existing) return;
      const r = await testStudioAgent({ data: { id: existing.id, orgId: testOrg } });
      toast[r.passed ? "success" : "error"](r.passed ? "All tests passed" : "Tests failed");
      onChanged();
    }, "Could not run the tests");

  const lifecycleAction = (fn: (a: { data: { id: string } }) => Promise<unknown>, ok: string) =>
    run(async () => {
      if (!existing) return;
      await fn({ data: { id: existing.id } });
      toast.success(ok);
      onChanged();
    }, "Could not do that");

  const toggleTool = (t: string, on: boolean) =>
    setTools((cur) => {
      const next = { ...cur };
      if (on) next[t] = { name: t, description: toolDescription(view, t) };
      else delete next[t];
      return next;
    });

  const sampleTemplate = () =>
    JSON.stringify(Object.fromEntries(Object.keys(tools).map((t) => [t, {}])), null, 2);

  const status = existing?.status ?? "draft";
  const stage = LIFECYCLE.indexOf(status as (typeof LIFECYCLE)[number]);
  const stockMax = origin === "new" ? 30 : (base?.maxSteps ?? existing?.stepsCap ?? 20);

  return (
    <>
      <SheetHeader className="pr-8 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle>{existing ? existing.name : "New agent"}</SheetTitle>
          {existing ? (
            <span className="font-mono text-xs text-muted-foreground">{existing.type}</span>
          ) : null}
          {existing?.publishedVersion ? <Badge>live v{existing.publishedVersion}</Badge> : null}
          {existing?.outOfDate ? <Badge variant="outline">Agent updated</Badge> : null}
        </div>
        {existing ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {LIFECYCLE.map((l, i) => (
              <span key={l} className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs ${
                    i <= stage ? "bg-foreground text-background" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {l} {i === stage ? `· v${existing.version}` : ""}
                </span>
                {i < LIFECYCLE.length - 1 ? <span className="text-muted-foreground">→</span> : null}
              </span>
            ))}
            <div className="ml-auto flex gap-2">
              {status === "tested" ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => lifecycleAction(approveStudioAgent, "Approved")}
                >
                  <ShieldCheck className="size-4" /> Approve v{existing.version}
                </Button>
              ) : null}
              {status === "approved" ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => lifecycleAction(publishStudioAgent, "Published")}
                >
                  <Rocket className="size-4" /> Publish v{existing.version}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </SheetHeader>

      <Tabs defaultValue="build" className="mt-4">
        <TabsList>
          <TabsTrigger value="build">Build</TabsTrigger>
          <TabsTrigger value="test" disabled={!existing}>
            Test{existing?.lastTest ? (existing.lastTest.passed ? " ✓" : " ✗") : ""}
          </TabsTrigger>
          <TabsTrigger value="orgs" disabled={!existing?.publishedVersion}>
            Organisations{existing?.grants.length ? ` (${existing.grants.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="deliver" disabled={!existing?.publishedVersion}>
            Delivery
          </TabsTrigger>
        </TabsList>

        <TabsContent value="build" className="mt-4 space-y-5">
          {!existing ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Start</Label>
                <Select value={origin} onValueChange={(v) => setOrigin(v as "adapted" | "new")}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="adapted">From a stock agent</SelectItem>
                    <SelectItem value="new">New agent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {origin === "adapted" ? (
                <div>
                  <Label className="text-xs">Stock agent</Label>
                  <Select value={baseType} onValueChange={pickBase}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Choose an agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {view.stockAgents.map((a) => (
                        <SelectItem key={a.type} value={a.type}>
                          {agentName(a.type, a.name)} · {a.version}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          ) : null}

          {started ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" id="sa-name">
                  <Input
                    id="sa-name"
                    value={name}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label="Description" id="sa-desc">
                  <Input
                    id="sa-desc"
                    value={description}
                    maxLength={500}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Responsibility" id="sa-resp">
                <Textarea
                  id="sa-resp"
                  className="min-h-16"
                  value={responsibility}
                  maxLength={600}
                  onChange={(e) => setResponsibility(e.target.value)}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <Label className="text-xs">Risk tier</Label>
                  <Select
                    value={riskTier}
                    onValueChange={(v) => setRiskTier(v as "low" | "medium" | "high")}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Accountable role</Label>
                  <Select value={ownerRole} onValueChange={setOwnerRole}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {view.roles.map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_NAME[r] ?? r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Field label={`Steps before a person decides (max ${stockMax})`} id="sa-steps">
                  <Input
                    id="sa-steps"
                    inputMode="numeric"
                    placeholder={String(stockMax)}
                    value={steps}
                    onChange={(e) => setSteps(e.target.value.replace(/\D/g, ""))}
                  />
                </Field>
              </div>

              <details className="rounded-md border px-3 py-2 text-xs">
                <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
                  <Lock className="size-3.5" /> Always added
                </summary>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-muted-foreground">
                  {view.lockedRules}
                </pre>
              </details>

              <div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs" htmlFor="sa-instr">
                    Instructions
                  </Label>
                  {base ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs"
                      onClick={() => setInstructions(base.instructions)}
                    >
                      <RotateCcw className="size-3" /> Reset to stock
                    </Button>
                  ) : null}
                </div>
                <Textarea
                  id="sa-instr"
                  className="mt-1 min-h-56 font-mono text-xs"
                  value={instructions}
                  maxLength={20_000}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Must never" id="sa-never">
                  <Textarea
                    id="sa-never"
                    className="min-h-28"
                    value={mustNever}
                    onChange={(e) => setMustNever(e.target.value)}
                  />
                </Field>
                <div>
                  <Label className="text-xs">Human decisions it may ask for</Label>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    {view.gateKinds.map((g) => (
                      <label key={g} className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={gates.includes(g)}
                          onCheckedChange={(v) =>
                            setGates((cur) => (v ? [...cur, g] : cur.filter((x) => x !== g)))
                          }
                        />
                        {GATE_LABEL[g] ?? g}
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="May read" id="sa-reads">
                  <Textarea
                    id="sa-reads"
                    className="min-h-20 text-xs"
                    value={reads}
                    onChange={(e) => setReads(e.target.value)}
                  />
                </Field>
                <Field label="May change" id="sa-writes">
                  <Textarea
                    id="sa-writes"
                    className="min-h-20 text-xs"
                    value={writes}
                    onChange={(e) => setWrites(e.target.value)}
                  />
                </Field>
                <Field label="Outside the organisation" id="sa-ext">
                  <Textarea
                    id="sa-ext"
                    className="min-h-20 text-xs"
                    value={external}
                    onChange={(e) => setExternal(e.target.value)}
                  />
                </Field>
              </div>

              <ToolPicker view={view} tools={tools} setTools={setTools} toggle={toggleTool} />

              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button disabled={busy} onClick={save}>
                  Save draft
                </Button>
                {existing ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const r = await duplicateStudioAgent({ data: { id: existing.id } });
                          toast.success("Copied");
                          onSaved(r.id);
                        }, "Could not copy")
                      }
                    >
                      <CopyPlus className="size-4" /> Duplicate
                    </Button>
                    <Button
                      variant="ghost"
                      className="ml-auto text-destructive"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await archiveStudioAgent({ data: { id: existing.id } });
                          toast.success("Archived");
                          onClosed();
                        }, "Could not archive")
                      }
                    >
                      <Trash2 className="size-4" /> Archive
                    </Button>
                  </>
                ) : null}
              </div>
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="test" className="mt-4 space-y-4">
          {existing ? (
            <>
              {scenarios.map((s, i) => (
                <div key={i} className="space-y-2 rounded-md border p-3">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Test name"
                      value={s.name}
                      maxLength={80}
                      onChange={(e) =>
                        setScenarios((cur) =>
                          cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Remove test"
                      onClick={() => setScenarios((cur) => cur.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <Textarea
                    placeholder="Goal the agent is given"
                    className="min-h-14 text-sm"
                    value={s.goal}
                    onChange={(e) =>
                      setScenarios((cur) =>
                        cur.map((x, j) => (j === i ? { ...x, goal: e.target.value } : x)),
                      )
                    }
                  />
                  <Label className="text-xs">Sample data (tool → result, JSON)</Label>
                  <Textarea
                    className="min-h-32 font-mono text-xs"
                    value={s.fixturesJson}
                    onChange={(e) =>
                      setScenarios((cur) =>
                        cur.map((x, j) => (j === i ? { ...x, fixturesJson: e.target.value } : x)),
                      )
                    }
                  />
                  <div className="flex flex-wrap items-center gap-4">
                    <Input
                      className="max-w-md text-xs"
                      placeholder="Expected tools in order, e.g. list_applications, add_candidate_note"
                      value={s.expectCalls}
                      onChange={(e) =>
                        setScenarios((cur) =>
                          cur.map((x, j) => (j === i ? { ...x, expectCalls: e.target.value } : x)),
                        )
                      }
                    />
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={s.expectApproval}
                        onCheckedChange={(v) =>
                          setScenarios((cur) =>
                            cur.map((x, j) => (j === i ? { ...x, expectApproval: Boolean(v) } : x)),
                          )
                        }
                      />
                      Must ask a person
                    </label>
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                {scenarios.length < 5 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setScenarios((cur) => [
                        ...cur,
                        {
                          name: `Test ${cur.length + 1}`,
                          goal: "",
                          fixturesJson: sampleTemplate(),
                          expectCalls: "",
                          expectApproval: false,
                        },
                      ])
                    }
                  >
                    <Plus className="size-4" /> Add test
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" disabled={busy} onClick={save}>
                  Save tests
                </Button>
                <div className="ml-auto flex items-center gap-2">
                  <Select value={testOrg} onValueChange={setTestOrg}>
                    <SelectTrigger className="h-8 w-56">
                      <SelectValue placeholder="Test organisation" />
                    </SelectTrigger>
                    <SelectContent>
                      {view.owned.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={busy || !testOrg || !existing.testScenarios.length}
                    onClick={test}
                  >
                    <FlaskConical className="size-4" />
                    {busy ? "Running…" : `Run tests on v${existing.version}`}
                  </Button>
                </div>
              </div>
              {existing.lastTest ? (
                <TestReport result={existing.lastTest} current={existing.version} />
              ) : null}
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="orgs" className="mt-4">
          {existing ? <Organisations view={view} agent={existing} onChanged={onChanged} /> : null}
        </TabsContent>

        <TabsContent value="deliver" className="mt-4">
          {existing ? (
            <Delivery
              agent={existing}
              view={view}
              onDownload={() =>
                run(async () => {
                  const { fileName, json } = await downloadStudioPackage({
                    data: { id: existing.id },
                  });
                  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = fileName;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                }, "Could not download")
              }
              onChanged={onChanged}
            />
          ) : null}
        </TabsContent>
      </Tabs>
    </>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs" htmlFor={id}>
        {label}
      </Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function ToolPicker({
  view,
  tools,
  setTools,
  toggle,
}: {
  view: StudioView;
  tools: Record<string, ToolRow>;
  setTools: React.Dispatch<React.SetStateAction<Record<string, ToolRow>>>;
  toggle: (t: string, on: boolean) => void;
}) {
  const [filter, setFilter] = useState("");
  const all = useMemo(
    () => new Map(view.catalogue.flatMap((g) => g.tools.map((t) => [t.name, t] as const))),
    [view.catalogue],
  );
  const chosen = Object.keys(tools);
  return (
    <div className="space-y-3">
      <Label className="text-xs">Tools ({chosen.length})</Label>
      {chosen.length ? (
        <div className="space-y-2">
          {chosen.map((real) => {
            const t = all.get(real);
            const row = tools[real]!;
            return (
              <div key={real} className="rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked
                    onCheckedChange={() => toggle(real, false)}
                    aria-label={`Remove ${real}`}
                  />
                  <Input
                    className="h-8 font-mono text-xs"
                    value={row.name}
                    maxLength={61}
                    aria-label={`Name for ${real}`}
                    onChange={(e) =>
                      setTools((cur) => ({ ...cur, [real]: { ...row, name: e.target.value } }))
                    }
                  />
                  {row.name !== real ? (
                    <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
                      ← {real}
                    </span>
                  ) : null}
                  {t?.needsPersonApproval ? (
                    <Badge variant="outline" className="shrink-0 text-[0.625rem]">
                      person approves
                    </Badge>
                  ) : null}
                </div>
                <Textarea
                  className="mt-2 min-h-14 text-xs"
                  value={row.description}
                  maxLength={1500}
                  aria-label={`Description for ${real}`}
                  onChange={(e) =>
                    setTools((cur) => ({ ...cur, [real]: { ...row, description: e.target.value } }))
                  }
                />
                {t?.fields.length ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.fields.map((f) => (
                      <Badge key={f.name} variant="outline" className="font-mono text-[0.625rem]">
                        {f.name}
                        {f.required ? "*" : ""}: {f.type}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <details className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium">Tool catalogue</summary>
        <Input
          className="mt-2 h-8 text-xs"
          placeholder="Filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="mt-2 max-h-80 space-y-3 overflow-auto">
          {view.catalogue.map((g) => {
            const shown = g.tools.filter(
              (t) =>
                !filter ||
                t.name.includes(filter.toLowerCase()) ||
                t.description.toLowerCase().includes(filter.toLowerCase()),
            );
            if (!shown.length) return null;
            return (
              <div key={g.agent}>
                <div className="text-[0.6875rem] font-medium text-muted-foreground">
                  {agentName(g.agent)}
                </div>
                <div className="mt-1 space-y-1">
                  {shown.map((t) => (
                    <label
                      key={t.name}
                      className="flex items-start gap-2 text-xs"
                      title={t.description}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={Boolean(tools[t.name])}
                        onCheckedChange={(v) => toggle(t.name, Boolean(v))}
                      />
                      <span className="font-mono">{t.name}</span>
                      <span className="line-clamp-1 text-muted-foreground">{t.description}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

function TestReport({
  result,
  current,
}: {
  result: NonNullable<StudioAgentRow["lastTest"]>;
  current: number;
}) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        {result.passed ? (
          <CircleCheck className="size-4 text-emerald-600" />
        ) : (
          <CircleX className="size-4 text-destructive" />
        )}
        <span className="font-medium">v{result.version}</span>
        <span className="text-xs text-muted-foreground">
          {new Date(result.at).toLocaleString()}
        </span>
        {result.version !== current ? (
          <Badge variant="outline" className="ml-auto">
            older version
          </Badge>
        ) : null}
      </div>
      <ul className="divide-y text-xs">
        {result.runs.map((r) => (
          <li key={r.scenario} className="space-y-1 px-3 py-2">
            <div className="flex items-center gap-2">
              {r.passed ? (
                <Check className="size-3.5 text-emerald-600" />
              ) : (
                <CircleX className="size-3.5 text-destructive" />
              )}
              <span className="font-medium">{r.scenario}</span>
              <span className="ml-auto tabular-nums text-muted-foreground">
                {r.steps} steps · {r.tokens.toLocaleString()} tokens
              </span>
            </div>
            <div className="font-mono text-[0.6875rem] text-muted-foreground">
              {r.calls.join(" → ") || "no tools called"}
            </div>
            {r.failures.map((f) => (
              <div key={f} className="text-destructive">
                {f}
              </div>
            ))}
            {r.result ? <div className="text-muted-foreground">{r.result}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Organisations({
  view,
  agent,
  onChanged,
}: {
  view: StudioView;
  agent: StudioAgentRow;
  onChanged: () => void;
}) {
  const granted = new Set(agent.grants.map((g) => g.orgId));
  const set = async (orgId: string, on: boolean) => {
    try {
      if (on) await grantStudioAgent({ data: { id: agent.id, orgId } });
      else await revokeStudioAgent({ data: { id: agent.id, orgId } });
      toast.success(on ? "Granted" : "Withdrawn");
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Could not change"));
    }
  };
  return (
    <ul className="divide-y rounded-md border text-sm">
      {view.organisations.map((o) => (
        <li key={o.id} className="flex items-center gap-3 px-3 py-2">
          <Checkbox
            checked={granted.has(o.id)}
            onCheckedChange={(v) => set(o.id, Boolean(v))}
            aria-label={`Grant to ${o.name}`}
          />
          <span className="flex-1">{o.name}</span>
          {o.status !== "active" ? <Badge variant="outline">{o.status}</Badge> : null}
          {granted.has(o.id) ? (
            <span className="text-xs text-muted-foreground">
              since{" "}
              {new Date(agent.grants.find((g) => g.orgId === o.id)!.grantedAt).toLocaleDateString()}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Delivery({
  agent,
  view,
  onDownload,
  onChanged,
}: {
  agent: StudioAgentRow;
  view: StudioView;
  onDownload: () => void;
  onChanged: () => void;
}) {
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const granted = new Set(agent.grants.map((g) => g.orgId));
  const workspaces = view.owned.filter((o) => granted.has(o.id));
  const hosted = agent.publishedVersion && agent.workspaceOrgId;

  const act = async (fn: () => Promise<unknown>, ok: string | null, fail: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
      onChanged();
    } catch (e) {
      toast.error(errorText(e, fail));
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Label className="text-xs">Package · v{agent.publishedVersion}</Label>
        <div className="mt-1">
          <Button variant="outline" onClick={onDownload}>
            <Download className="size-4" /> Download package
          </Button>
        </div>
      </div>

      <div>
        <Label className="text-xs">Hosted workspace</Label>
        <Select
          value={agent.workspaceOrgId ?? "none"}
          onValueChange={(v) =>
            act(
              () => setStudioWorkspace({ data: { id: agent.id, orgId: v === "none" ? null : v } }),
              "Saved",
              "Could not save",
            )
          }
        >
          <SelectTrigger className="mt-1 max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Package only</SelectItem>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hosted ? (
        <>
          <div className="space-y-1.5 text-xs">
            <Label className="text-xs">Endpoints</Label>
            <code className="block break-all rounded bg-muted px-2 py-1.5">
              POST {origin}/api/agents/{agent.id}/runs
            </code>
            <code className="block rounded bg-muted px-2 py-1.5">
              GET {origin}/api/agents/runs/:runId
            </code>
            <code className="block rounded bg-muted px-2 py-1.5">MCP {origin}/api/mcp</code>
          </div>

          {shown ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              <Label className="text-xs">New key — shown once</Label>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 break-all text-xs" data-testid="new-key">
                  {shown}
                </code>
                <Button
                  size="icon"
                  variant="outline"
                  className="size-7"
                  aria-label="Copy key"
                  onClick={() => {
                    void navigator.clipboard.writeText(shown);
                    toast.success("Copied");
                  }}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            </div>
          ) : null}

          <div>
            <Label className="text-xs">Keys</Label>
            {agent.keys.length ? (
              <ul className="mt-2 divide-y rounded-md border text-sm">
                {agent.keys.map((k) => (
                  <li key={k.id} className="flex items-center gap-3 px-3 py-2">
                    <KeyRound className="size-4 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs">{k.prefix}…</div>
                      <div className="text-xs text-muted-foreground">
                        {k.label ? `${k.label} · ` : ""}
                        {k.lastUsedAt
                          ? `used ${new Date(k.lastUsedAt).toLocaleString()}`
                          : "never used"}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        act(
                          () => revokeStudioKey({ data: { keyId: k.id } }),
                          "Revoked",
                          "Could not revoke",
                        )
                      }
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-3 flex gap-2">
              <Input
                placeholder="Label"
                value={label}
                maxLength={80}
                onChange={(e) => setLabel(e.target.value)}
              />
              <Button
                variant="outline"
                onClick={() =>
                  act(
                    async () => {
                      const r = await createStudioKey({ data: { id: agent.id, label } });
                      setShown(r.key);
                      setLabel("");
                    },
                    null,
                    "Could not create key",
                  )
                }
              >
                <Plus className="size-4" /> Create key
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
