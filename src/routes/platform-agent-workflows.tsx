import "@xyflow/react/dist/style.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useMemo, useState, type DragEvent } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Bot,
  CircleCheck,
  CircleStop,
  Download,
  FileText,
  Hourglass,
  Play,
  CircleX,
  FlaskConical,
  GitBranch,
  KeyRound,
  MessageSquare,
  SendHorizontal,
  Plus,
  Rocket,
  ShieldCheck,
  Trash2,
  Zap,
  Link2,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { usePlatform } from "@/hooks/usePlatform";
import { WorkflowRunRequests } from "@/components/agents/AgentTaskCard";
import { RunFlow } from "@/components/agents/RunFlow";
import { StoppedStepActions } from "@/components/agents/StoppedStepActions";
import { AGENT_LABEL } from "@/lib/agents.catalog";
import {
  approveWorkflow,
  assistWorkflow,
  archiveWorkflow,
  createWorkflowFromTemplate,
  grantWorkflow,
  publishWorkflow,
  revokeWorkflow,
  saveWorkflow,
  testWorkflow,
  platformWorkflowReport,
  runWorkflowNow,
  workflowBuilder,
  workflowOrgReadiness,
  type OrgReadinessRow,
  type SaveWorkflowInput,
  type WorkflowAssistResult,
  type WorkflowBuilderView,
  type WorkflowRow,
} from "@/lib/platform-agent-workflows.functions";

export const Route = createFileRoute("/platform-agent-workflows")({
  head: () => ({
    meta: [
      { title: "Agent workflows — ATSIQ" },
      { name: "description", content: "Draw flows of agents for the organisations you pick." },
    ],
  }),
  component: WorkflowsPage,
});

type Kind = "trigger" | "agent" | "condition" | "wait" | "report" | "end";
type NodeData = {
  label?: string | undefined;
  event?: string | undefined;
  timeoutHours?: number | undefined;
  agentType?: string | undefined;
  goal?: string | undefined;
  field?: string | undefined;
  op?: "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte" | "exists" | undefined;
  value?: string | undefined;
};
type FlowNode = Node<NodeData, Kind>;

const LIFECYCLE = ["draft", "tested", "approved", "published"] as const;
const OP_LABEL: Record<string, string> = {
  eq: "equals",
  neq: "is not",
  contains: "contains",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  exists: "is present",
};
/** A test's agent outcomes (stored as JSON text): step id → how it ends. */
const outcomesOf = (json: string): Record<string, { status: string; result: string }> => {
  try {
    const v = JSON.parse(json || "{}") as Record<string, { status?: string; result?: string }>;
    return Object.fromEntries(
      Object.entries(v).map(([k, o]) => [
        k,
        { status: o?.status ?? "done", result: o?.result ?? "" },
      ]),
    );
  } catch {
    return {};
  }
};
const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const eventLabel = (e?: string) =>
  e === "manual" ? "Hiring need (manual)" : e ? e.replace(/[._]/g, " ") : "Pick an event";

/* ----------------------------------------------------------------- nodes */

function Box({
  tone,
  icon,
  title,
  sub,
  selected,
}: {
  tone: string;
  icon: React.ReactNode;
  title: string;
  sub?: string;
  selected?: boolean;
}) {
  return (
    <div
      className={`min-w-44 max-w-60 rounded-lg border bg-card px-3 py-2 shadow-sm ${tone} ${
        selected ? "ring-2 ring-primary" : ""
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        {icon}
        <span className="truncate">{title}</span>
      </div>
      {sub ? (
        <div className="mt-0.5 line-clamp-2 text-[0.6875rem] text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  );
}

function TriggerNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <Box
        tone="border-amber-400/70"
        icon={<Zap className="size-3.5 text-amber-500" />}
        title={data.label || "When"}
        sub={eventLabel(data.event)}
        selected={selected}
      />
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

function AgentNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <Box
        tone="border-primary/50"
        icon={<Bot className="size-3.5 text-primary" />}
        title={
          data.label || (data.agentType ? (AGENT_LABEL[data.agentType] ?? data.agentType) : "Agent")
        }
        sub={data.goal || "Write the goal"}
        selected={selected}
      />
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

function ConditionNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <Box
        tone="border-sky-400/70"
        icon={<GitBranch className="size-3.5 text-sky-500" />}
        title={data.label || "If"}
        sub={
          data.field
            ? `${data.field} ${OP_LABEL[data.op ?? "eq"]}${data.op === "exists" ? "" : ` ${data.value ?? ""}`}`
            : "Set the condition"
        }
        selected={selected}
      />
      <Handle id="yes" type="source" position={Position.Bottom} style={{ left: "30%" }} />
      <Handle id="no" type="source" position={Position.Bottom} style={{ left: "70%" }} />
      <div className="pointer-events-none flex justify-between px-6 text-[0.625rem] text-muted-foreground">
        <span>yes</span>
        <span>no</span>
      </div>
    </>
  );
}

function WaitNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <Box
        tone="border-violet-400/70"
        icon={<Hourglass className="size-3.5 text-violet-500" />}
        title={data.label || "Wait for"}
        sub={`${eventLabel(data.event)}${data.field ? ` · ${data.field} ${OP_LABEL[data.op ?? "eq"]} ${data.op === "exists" ? "" : (data.value ?? "")}` : ""} · up to ${data.timeoutHours ?? 72} h`}
        selected={selected}
      />
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

function ReportNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <Box
        tone="border-emerald-400/70"
        icon={<FileText className="size-3.5 text-emerald-600" />}
        title={data.label || "Report"}
        sub="PDF · Excel"
        selected={selected}
      />
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

function EndNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <Box
        tone="border-muted-foreground/40"
        icon={<CircleStop className="size-3.5 text-muted-foreground" />}
        title={data.label || "End"}
        selected={selected}
      />
    </>
  );
}

const nodeTypes = {
  wait: WaitNode,
  report: ReportNode,
  trigger: TriggerNode,
  agent: AgentNode,
  condition: ConditionNode,
  end: EndNode,
};

/* ---------------------------------------------------------------- page */

function WorkflowsPage() {
  const { isSuperUser, isLoading } = usePlatform();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["platform_agent_workflows"],
    queryFn: () => workflowBuilder(),
    enabled: isSuperUser,
    retry: false,
    // Live runs move on their own: keep the Runs tab current while any is live.
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === "waiting" || r.status === "running")
        ? 10_000
        : false,
  });
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const openWorkflow = (id: string | "new" | null) => {
    if (id !== open) setChat([]);
    setOpen(id);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ["platform_agent_workflows"] });

  if (isLoading) return <p className="text-sm text-muted-foreground">Checking platform access…</p>;
  if (!isSuperUser)
    return (
      <>
        <PageHeader eyebrow="Platform" title="Agent workflows" />
        <section className="panel max-w-lg p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4 text-muted-foreground" /> Super-user access only
          </h2>
        </section>
      </>
    );

  const data = q.data;
  const editing = open && open !== "new" ? data?.workflows.find((w) => w.id === open) : undefined;
  if (data && (open === "new" || editing))
    return (
      <ReactFlowProvider>
        <Editor
          key={editing ? `${editing.id}:${editing.version}:${editing.status}` : "new"}
          view={data}
          existing={editing}
          onBack={() => {
            refresh();
            openWorkflow(null);
          }}
          onSaved={(id) => {
            refresh();
            setOpen(id);
          }}
          onChanged={refresh}
          chat={chat}
          setChat={setChat}
        />
      </ReactFlowProvider>
    );

  const orgName = (id: string) => data?.organisations.find((o) => o.id === id)?.name ?? "—";
  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Agent workflows"
        description="Draw how agents follow each other, test the flow, approve and publish it to the organisations you pick."
        actions={
          <Button size="sm" onClick={() => openWorkflow("new")}>
            <Plus className="size-4" /> New workflow
          </Button>
        }
      />
      {data?.templates.length ? (
        <section className="mt-4">
          <h2 className="text-sm font-semibold">Start from a template</h2>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.templates.map((t) => (
              <article key={t.id} className="glass-card flex flex-col p-3.5">
                <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                  <Zap className="size-3 text-amber-500" />
                  {eventLabel(t.trigger)} · {t.steps} steps
                </div>
                <h3 className="mt-1.5 text-sm font-semibold">{t.name}</h3>
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{t.description}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-auto self-start"
                  style={{ marginTop: 12 }}
                  onClick={async () => {
                    try {
                      const r = await createWorkflowFromTemplate({ data: { templateId: t.id } });
                      toast.success("Draft created");
                      await refresh();
                      openWorkflow(r.id);
                    } catch (e) {
                      toast.error(errorText(e, "Could not create"));
                    }
                  }}
                >
                  Use
                </Button>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {q.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <p className="mt-4 text-sm text-muted-foreground">{errorText(q.error, "Not available.")}</p>
      ) : !data?.workflows.length ? (
        <EmptyState title="No workflows yet" />
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Workflow</th>
                <th className="px-4 py-2 font-medium">Starts on</th>
                <th className="px-4 py-2 font-medium">Steps</th>
                <th className="px-4 py-2 font-medium">Organisations</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.workflows.map((w) => (
                <tr
                  key={w.id}
                  className="cursor-pointer border-t hover:bg-muted/30"
                  onClick={() => openWorkflow(w.id)}
                >
                  <td className="px-4 py-2.5 font-medium">{w.name}</td>
                  <td className="px-4 py-2.5">
                    {eventLabel(w.graph.nodes.find((n) => n.kind === "trigger")?.data.event)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{w.graph.nodes.length}</td>
                  <td className="px-4 py-2.5">
                    {w.grants.length ? w.grants.map(orgName).join(", ") : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={w.status === "published" ? "default" : "secondary"}>
                      {w.status} · v{w.version}
                    </Badge>
                    {w.publishedVersion ? (
                      <Badge className="ml-1">live v{w.publishedVersion}</Badge>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------------------- editor */

const newId = (kind: string) => `${kind}_${Math.random().toString(36).slice(2, 8)}`;

function toFlow(w?: WorkflowRow): { nodes: FlowNode[]; edges: Edge[] } {
  if (!w)
    return {
      nodes: [{ id: "trigger_start", type: "trigger", position: { x: 260, y: 40 }, data: {} }],
      edges: [],
    };
  return {
    nodes: w.graph.nodes.map((n) => ({
      id: n.id,
      type: n.kind,
      position: n.position,
      data: { ...n.data },
    })),
    edges: w.graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.branch ?? null,
      label: e.branch,
      markerEnd: { type: MarkerType.ArrowClosed },
    })),
  };
}

function Editor({
  view,
  existing,
  onBack,
  onSaved,
  onChanged,
  chat,
  setChat,
}: {
  view: WorkflowBuilderView;
  existing: WorkflowRow | undefined;
  onBack: () => void;
  onSaved: (id: string) => void;
  onChanged: () => void;
  chat: ChatTurn[];
  setChat: React.Dispatch<React.SetStateAction<ChatTurn[]>>;
}) {
  const initial = useMemo(() => toFlow(existing), [existing]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [tests, setTests] = useState(existing?.testScenarios ?? []);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [chatOpen, setChatOpen] = useState(chat.length > 0);
  const [dirty, setDirty] = useState(false);
  const flow = useReactFlow();

  const applyDraft = (d: WorkflowAssistResult) => {
    const f = toFlow({ graph: d.graph } as WorkflowRow);
    setNodes(f.nodes);
    setEdges(f.edges);
    setTests(d.testScenarios);
    if (d.name) setName(d.name);
    if (d.description) setDescription(d.description);
    setProblems(d.problems);
    setSelected(null);
    setDirty(true);
    window.setTimeout(() => flow.fitView({ padding: 0.2 }), 50);
  };

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((eds) =>
        addEdge(
          {
            ...c,
            id: newId("edge"),
            label: c.sourceHandle ?? undefined,
            markerEnd: { type: MarkerType.ArrowClosed },
          },
          eds.filter(
            // One connection out of a step (or out of each condition branch).
            (e) =>
              !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)),
          ),
        ),
      ),
    [setEdges],
  );

  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    const raw = ev.dataTransfer.getData("application/x-workflow-step");
    if (!raw) return;
    const item = JSON.parse(raw) as { kind: Kind; agentType?: string; name?: string };
    if (item.kind === "trigger" && nodes.some((n) => n.type === "trigger")) {
      toast.error("A workflow has one trigger.");
      return;
    }
    const position = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    const id = newId(item.kind);
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: item.kind,
        position,
        data:
          item.kind === "agent"
            ? { agentType: item.agentType, label: item.name }
            : item.kind === "condition"
              ? { field: "last.status", op: "eq", value: "done" }
              : {},
      },
    ]);
    setSelected(id);
  };

  const setData = (id: string, patch: Partial<NodeData>) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));

  const graph = (): SaveWorkflowInput["graph"] => ({
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.type as Kind,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: Object.fromEntries(
        Object.entries(n.data).filter(([, v]) => v !== undefined && v !== ""),
      ) as NodeData,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle === "yes" || e.sourceHandle === "no" ? { branch: e.sourceHandle } : {}),
    })),
  });

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

  const save = () =>
    run(async () => {
      const r = await saveWorkflow({
        data: { id: existing?.id, name, description, graph: graph(), testScenarios: tests },
      });
      toast.success("Saved as a draft");
      setDirty(false);
      onSaved(r.id);
    }, "Could not save");

  const test = () =>
    run(async () => {
      if (!existing) return;
      const r = await testWorkflow({ data: { id: existing.id } });
      setProblems(r.problems);
      toast[r.passed ? "success" : "error"](r.passed ? "All tests passed" : "Not passing yet");
      onChanged();
    }, "Could not test");

  const lifecycle = (fn: (a: { data: { id: string } }) => Promise<unknown>, ok: string) =>
    run(async () => {
      if (!existing) return;
      await fn({ data: { id: existing.id } });
      toast.success(ok);
      onChanged();
    }, "Could not do that");

  const node = nodes.find((n) => n.id === selected);
  const status = existing?.status ?? "draft";
  const stage = LIFECYCLE.indexOf(status as (typeof LIFECYCLE)[number]);
  const agents = view.agents.filter(
    (a) =>
      !filter ||
      a.name.toLowerCase().includes(filter.toLowerCase()) ||
      a.type.includes(filter.toLowerCase()),
  );
  const drag = (ev: DragEvent, item: Record<string, unknown>) => {
    ev.dataTransfer.setData("application/x-workflow-step", JSON.stringify(item));
    ev.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> Workflows
        </Button>
        <Input
          className="h-8 max-w-xs font-medium"
          placeholder="Workflow name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          className="h-8 max-w-md"
          placeholder="Description"
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
        />
        {existing ? (
          <div className="flex items-center gap-1.5">
            {LIFECYCLE.map((l, i) => (
              <span
                key={l}
                className={`rounded-full px-2 py-0.5 text-[0.6875rem] ${
                  i <= stage ? "bg-foreground text-background" : "bg-muted text-muted-foreground"
                }`}
              >
                {l}
                {i === stage ? ` · v${existing.version}` : ""}
              </span>
            ))}
            {existing.publishedVersion ? <Badge>live v{existing.publishedVersion}</Badge> : null}
          </div>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant={chatOpen ? "secondary" : "outline"}
            onClick={() => setChatOpen((o) => !o)}
          >
            <MessageSquare className="size-4" /> Build with chat
          </Button>
          <Button size="sm" disabled={busy} onClick={save}>
            Save draft{dirty ? " •" : ""}
          </Button>
          {existing ? (
            <Button size="sm" variant="outline" disabled={busy || dirty} onClick={test}>
              <FlaskConical className="size-4" /> Test v{existing.version}
            </Button>
          ) : null}
          {status === "tested" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => lifecycle(approveWorkflow, "Approved")}
            >
              <ShieldCheck className="size-4" /> Approve
            </Button>
          ) : null}
          {status === "approved" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => lifecycle(publishWorkflow, "Published")}
            >
              <Rocket className="size-4" /> Publish
            </Button>
          ) : null}
          {existing ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await archiveWorkflow({ data: { id: existing.id } });
                  toast.success("Archived");
                  onBack();
                }, "Could not archive")
              }
            >
              <Trash2 className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      {problems.length ? (
        <ul className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}

      {chatOpen ? (
        <WorkflowChat
          view={view}
          workflowId={existing?.id}
          chat={chat}
          setChat={setChat}
          current={graph}
          onDraft={applyDraft}
        />
      ) : null}

      <Tabs defaultValue="canvas">
        <TabsList>
          <TabsTrigger value="canvas">Canvas</TabsTrigger>
          <TabsTrigger value="tests">
            Tests{existing?.lastTest ? (existing.lastTest.passed ? " ✓" : " ✗") : ""}
          </TabsTrigger>
          <TabsTrigger value="orgs" disabled={!existing?.publishedVersion}>
            Organisations{existing?.grants.length ? ` (${existing.grants.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="runs" disabled={!existing}>
            Runs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="canvas" className="mt-3">
          <div className="grid h-[680px] grid-cols-[220px_1fr_300px] gap-3">
            <aside className="flex flex-col gap-2 overflow-hidden rounded-lg border p-2">
              <div className="space-y-1.5">
                {(
                  [
                    ["trigger", "Trigger", <Zap key="t" className="size-3.5 text-amber-500" />],
                    [
                      "condition",
                      "Condition",
                      <GitBranch key="c" className="size-3.5 text-sky-500" />,
                    ],
                    [
                      "wait",
                      "Wait for",
                      <Hourglass key="w" className="size-3.5 text-violet-500" />,
                    ],
                    [
                      "report",
                      "Report",
                      <FileText key="r" className="size-3.5 text-emerald-600" />,
                    ],
                    ["end", "End", <CircleStop key="e" className="size-3.5" />],
                  ] as const
                ).map(([kind, label, icon]) => (
                  <div
                    key={kind}
                    draggable
                    onDragStart={(ev) => drag(ev, { kind })}
                    className="flex cursor-grab items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-xs"
                  >
                    {icon} {label}
                  </div>
                ))}
              </div>
              <Label className="mt-1 text-[0.6875rem] text-muted-foreground">Agents</Label>
              <Input
                className="h-7 text-xs"
                placeholder="Filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="flex-1 space-y-1 overflow-auto">
                {agents.map((a) => (
                  <div
                    key={a.type}
                    draggable
                    onDragStart={(ev) =>
                      drag(ev, {
                        kind: "agent",
                        agentType: a.type,
                        name: AGENT_LABEL[a.type] ?? a.name,
                      })
                    }
                    className="flex cursor-grab items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs"
                    title={a.type}
                  >
                    <Bot className="size-3.5 text-primary" />
                    <span className="truncate">{AGENT_LABEL[a.type] ?? a.name}</span>
                    {a.studio ? (
                      <Badge variant="secondary" className="ml-auto px-1 text-[0.5625rem]">
                        studio
                      </Badge>
                    ) : null}
                  </div>
                ))}
              </div>
            </aside>

            <div
              className="overflow-hidden rounded-lg border"
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={onDrop}
              data-testid="workflow-canvas"
            >
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, n) => setSelected(n.id)}
                onPaneClick={() => setSelected(null)}
                deleteKeyCode={["Backspace", "Delete"]}
                fitView
                fitViewOptions={{ maxZoom: 1 }}
              >
                <Background gap={16} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>

            <aside className="overflow-auto rounded-lg border p-3">
              {node ? (
                <Properties
                  node={node}
                  view={view}
                  setData={(p) => setData(node.id, p)}
                  onDelete={() => {
                    setNodes((ns) => ns.filter((n) => n.id !== node.id));
                    setEdges((es) =>
                      es.filter((e) => e.source !== node.id && e.target !== node.id),
                    );
                    setSelected(null);
                  }}
                />
              ) : (
                <p className="text-xs text-muted-foreground">Select a step.</p>
              )}
            </aside>
          </div>
        </TabsContent>

        <TabsContent value="tests" className="mt-3">
          <Tests
            tests={tests}
            setTests={setTests}
            nodes={nodes}
            existing={existing}
            onSave={save}
            busy={busy}
          />
        </TabsContent>

        <TabsContent value="orgs" className="mt-3">
          {existing ? <Orgs view={view} workflow={existing} onChanged={onChanged} /> : null}
        </TabsContent>

        <TabsContent value="runs" className="mt-3">
          {existing ? <Runs view={view} workflow={existing} nodes={nodes} /> : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ---------------------------------------------------------- build with chat */

type ChatTurn = { role: "user" | "assistant"; text: string; passed?: boolean; problems?: string[] };

function WorkflowChat({
  view,
  workflowId,
  chat,
  setChat,
  current,
  onDraft,
}: {
  view: WorkflowBuilderView;
  workflowId: string | undefined;
  chat: ChatTurn[];
  setChat: React.Dispatch<React.SetStateAction<ChatTurn[]>>;
  current: () => SaveWorkflowInput["graph"];
  onDraft: (d: WorkflowAssistResult) => void;
}) {
  const [org, setOrg] = useState(view.owned[0]?.id ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const msg = text.trim();
    if (!msg || busy || !org) return;
    const turns: ChatTurn[] = [...chat, { role: "user", text: msg }];
    setChat(turns);
    setText("");
    setBusy(true);
    try {
      const g = current();
      const d = await assistWorkflow({
        data: {
          orgId: org,
          ...(workflowId ? { workflowId } : {}),
          messages: turns.map(({ role, text: t }) => ({ role, text: t })),
          current: g.nodes.some((n) => n.kind !== "trigger" || n.data.event) ? g : null,
        },
      });
      onDraft(d);
      setChat((c) => [
        ...c,
        { role: "assistant", text: d.reply, passed: d.testsPassed, problems: d.problems },
      ]);
    } catch (e) {
      setChat((c) => [...c, { role: "assistant", text: errorText(e, "Could not draft that.") }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border p-3">
      <div className="mb-2 flex items-center gap-2">
        <MessageSquare className="size-4 text-primary" />
        <h2 className="text-sm font-semibold">Build with chat</h2>
        {view.owned.length > 1 ? (
          <Select value={org} onValueChange={setOrg}>
            <SelectTrigger className="ml-auto h-7 w-56 text-xs" aria-label="AI key from">
              <SelectValue placeholder="Organisation" />
            </SelectTrigger>
            <SelectContent>
              {view.owned.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {!view.owned.length ? (
        <p className="text-xs text-muted-foreground">
          Own an organisation with an AI key to build with chat.
        </p>
      ) : (
        <>
          {chat.length ? (
            <ol className="mb-2 max-h-56 space-y-2 overflow-y-auto text-sm">
              {chat.map((m, i) => (
                <li
                  key={i}
                  className={
                    m.role === "user"
                      ? "ml-auto w-fit max-w-[80%] rounded-lg bg-primary px-3 py-1.5 text-primary-foreground"
                      : "w-fit max-w-[80%] rounded-lg bg-muted px-3 py-1.5"
                  }
                >
                  {m.text}
                  {m.role === "assistant" && m.passed !== undefined ? (
                    <div className="mt-1 flex items-center gap-1 text-xs">
                      {m.passed ? (
                        <>
                          <CircleCheck className="size-3.5 text-emerald-600" /> Dry-run tests pass
                        </>
                      ) : (
                        <>
                          <CircleX className="size-3.5 text-destructive" />{" "}
                          {m.problems?.[0] ?? "Tests not passing"}
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
              {busy ? (
                <li className="w-fit rounded-lg bg-muted px-3 py-1.5 text-muted-foreground">
                  Drafting…
                </li>
              ) : null}
            </ol>
          ) : null}
          <div className="flex gap-2">
            <Textarea
              rows={2}
              className="min-h-0 resize-none text-sm"
              placeholder="When candidates are shortlisted, screen them; if screening fails, have the follow-up agent remind the team"
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <Button
              size="icon"
              aria-label="Send"
              disabled={busy || !text.trim() || !org}
              onClick={() => void send()}
            >
              <SendHorizontal className="size-4" />
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function Properties({
  node,
  view,
  setData,
  onDelete,
}: {
  node: FlowNode;
  view: WorkflowBuilderView;
  setData: (p: Partial<NodeData>) => void;
  onDelete: () => void;
}) {
  const d = node.data;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-muted-foreground">{node.type}</span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Delete step"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div>
        <Label className="text-xs" htmlFor="wf-label">
          Label
        </Label>
        <Input
          id="wf-label"
          className="mt-1 h-8"
          value={d.label ?? ""}
          maxLength={80}
          onChange={(e) => setData({ label: e.target.value })}
        />
      </div>
      {node.type === "trigger" ? (
        <div>
          <Label className="text-xs">Event</Label>
          <Select value={d.event ?? ""} onValueChange={(v) => setData({ event: v })}>
            <SelectTrigger className="mt-1 h-8">
              <SelectValue placeholder="Pick an event" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">{eventLabel("manual")}</SelectItem>
              {view.events.map((e) => (
                <SelectItem key={e} value={e}>
                  {eventLabel(e)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {node.type === "wait" ? (
        <>
          <div>
            <Label className="text-xs">Wait for</Label>
            <Select value={d.event ?? ""} onValueChange={(v) => setData({ event: v })}>
              <SelectTrigger className="mt-1 h-8">
                <SelectValue placeholder="Pick an event" />
              </SelectTrigger>
              <SelectContent>
                {view.events.map((e) => (
                  <SelectItem key={e} value={e}>
                    {eventLabel(e)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Only when</Label>
            <Input
              className="mt-1 h-8 font-mono text-xs"
              placeholder="payload.to"
              value={d.field ?? ""}
              onChange={(e) => setData({ field: e.target.value || undefined })}
            />
            {d.field ? (
              <div className="mt-1 flex gap-1">
                <Select
                  value={d.op ?? "eq"}
                  onValueChange={(v) => setData({ op: v as NodeData["op"] })}
                >
                  <SelectTrigger className="h-8 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(OP_LABEL).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {d.op !== "exists" ? (
                  <Input
                    className="h-8"
                    placeholder="approved"
                    value={d.value ?? ""}
                    onChange={(e) => setData({ value: e.target.value })}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
          <div>
            <Label className="text-xs" htmlFor="wf-timeout">
              Give up after (hours)
            </Label>
            <Input
              id="wf-timeout"
              className="mt-1 h-8 w-28"
              inputMode="numeric"
              value={String(d.timeoutHours ?? 72)}
              onChange={(e) => {
                const v = Number(e.target.value.replace(/\D/g, ""));
                setData({ timeoutHours: v || undefined });
              }}
            />
          </div>
        </>
      ) : null}
      {node.type === "agent" ? (
        <>
          <div>
            <Label className="text-xs">Agent</Label>
            <Select value={d.agentType ?? ""} onValueChange={(v) => setData({ agentType: v })}>
              <SelectTrigger className="mt-1 h-8">
                <SelectValue placeholder="Pick an agent" />
              </SelectTrigger>
              <SelectContent>
                {view.agents.map((a) => (
                  <SelectItem key={a.type} value={a.type}>
                    {AGENT_LABEL[a.type] ?? a.name}
                    {a.studio ? " (studio)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs" htmlFor="wf-goal">
              Goal
            </Label>
            <Textarea
              id="wf-goal"
              className="mt-1 min-h-32 text-xs"
              placeholder="e.g. Screen the shortlisted candidate {{payload.applicationId}}"
              value={d.goal ?? ""}
              maxLength={2000}
              onChange={(e) => setData({ goal: e.target.value })}
            />
            <p className="mt-1 font-mono text-[0.625rem] text-muted-foreground">
              {"{{payload.need}} {{payload.<field>}} {{last.result}}"}
            </p>
          </div>
        </>
      ) : null}
      {node.type === "condition" ? (
        <>
          <div>
            <Label className="text-xs" htmlFor="wf-field">
              Field
            </Label>
            <Input
              id="wf-field"
              className="mt-1 h-8 font-mono text-xs"
              placeholder="last.status · wait.status · payload.level"
              value={d.field ?? ""}
              onChange={(e) => setData({ field: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-xs">Comparison</Label>
            <Select
              value={d.op ?? "eq"}
              onValueChange={(v) => setData({ op: v as NodeData["op"] })}
            >
              <SelectTrigger className="mt-1 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(OP_LABEL).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {d.op !== "exists" ? (
            <div>
              <Label className="text-xs" htmlFor="wf-value">
                Value
              </Label>
              <Input
                id="wf-value"
                className="mt-1 h-8"
                value={d.value ?? ""}
                maxLength={200}
                onChange={(e) => setData({ value: e.target.value })}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Tests({
  tests,
  setTests,
  nodes,
  existing,
  onSave,
  busy,
}: {
  tests: WorkflowRow["testScenarios"];
  setTests: React.Dispatch<React.SetStateAction<WorkflowRow["testScenarios"]>>;
  nodes: FlowNode[];
  existing: WorkflowRow | undefined;
  onSave: () => void;
  busy: boolean;
}) {
  const label = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n
      ? n.data.label ||
          (n.data.agentType ? (AGENT_LABEL[n.data.agentType] ?? n.data.agentType) : n.type)
      : id;
  };
  const outcomesTemplate = () =>
    JSON.stringify(
      Object.fromEntries(
        nodes
          .filter((n) => n.type === "agent" || n.type === "wait")
          .map((n) => [n.id, { status: "done", result: "" }]),
      ),
      null,
      2,
    );
  const set = (i: number, patch: Partial<WorkflowRow["testScenarios"][number]>) =>
    setTests((cur) => cur.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div className="space-y-3">
      {tests.map((t, i) => (
        <div key={i} className="grid gap-2 rounded-md border p-3 md:grid-cols-2">
          <div className="flex gap-2 md:col-span-2">
            <Input
              value={t.name}
              maxLength={80}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <Select value={t.subjectType} onValueChange={(v) => set(i, { subjectType: v })}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["requisition", "application", "jd", "offer"].map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={t.expectEnd || "any"}
              onValueChange={(v) => set(i, { expectEnd: v === "any" ? "" : v })}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any end</SelectItem>
                {nodes.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    Ends at {label(n.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Remove test"
              onClick={() => setTests((cur) => cur.filter((_, j) => j !== i))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          <div>
            <Label className="text-xs">Sample event payload</Label>
            <Textarea
              className="mt-1 min-h-32 font-mono text-xs"
              value={t.payloadJson}
              onChange={(e) => set(i, { payloadJson: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-xs">How each agent ends</Label>
            <div className="mt-1 space-y-1.5">
              {nodes
                .filter((n) => n.type === "agent" || n.type === "wait")
                .map((n) => {
                  const all = outcomesOf(t.outcomesJson);
                  const o = all[n.id] ?? { status: "done", result: "" };
                  const put = (patch: Partial<{ status: string; result: string }>) =>
                    set(i, {
                      outcomesJson: JSON.stringify({ ...all, [n.id]: { ...o, ...patch } }),
                    });
                  return (
                    <div key={n.id} className="flex items-center gap-2">
                      <span className="w-40 truncate text-xs">{label(n.id)}</span>
                      <Select value={o.status} onValueChange={(v) => put({ status: v })}>
                        <SelectTrigger className="h-8 w-28 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="done">
                            {n.type === "wait" ? "happens" : "finishes"}
                          </SelectItem>
                          <SelectItem value="failed">
                            {n.type === "wait" ? "times out" : "fails"}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        className="h-8 text-xs"
                        placeholder="Result text"
                        value={o.result}
                        onChange={(e) => put({ result: e.target.value })}
                      />
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        {tests.length < 5 ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setTests((cur) => [
                ...cur,
                {
                  name: `Test ${cur.length + 1}`,
                  payloadJson: nodes.some((n) => n.type === "trigger" && n.data.event === "manual")
                    ? JSON.stringify({ need: "" }, null, 2)
                    : "{}",
                  subjectType: "requisition",
                  outcomesJson: outcomesTemplate(),
                  expectEnd: "",
                },
              ])
            }
          >
            <Plus className="size-4" /> Add test
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy} onClick={onSave}>
          Save tests
        </Button>
      </div>
      {existing?.lastTest ? (
        <div className="rounded-md border text-xs">
          <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
            {existing.lastTest.passed ? (
              <CircleCheck className="size-4 text-emerald-600" />
            ) : (
              <CircleX className="size-4 text-destructive" />
            )}
            v{existing.lastTest.version} · {new Date(existing.lastTest.at).toLocaleString()}
          </div>
          <ul className="divide-y">
            {existing.lastTest.runs.map((r) => (
              <li key={r.scenario} className="space-y-1 px-3 py-2">
                <div className="flex items-center gap-2 font-medium">
                  {r.passed ? (
                    <CircleCheck className="size-3.5 text-emerald-600" />
                  ) : (
                    <CircleX className="size-3.5 text-destructive" />
                  )}
                  {r.scenario}
                </div>
                <div className="text-muted-foreground">{r.path.map(label).join(" → ")}</div>
                {r.failures.map((f) => (
                  <div key={f} className="text-destructive">
                    {f}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Orgs({
  view,
  workflow,
  onChanged,
}: {
  view: WorkflowBuilderView;
  workflow: WorkflowRow;
  onChanged: () => void;
}) {
  const readiness = useQuery({
    queryKey: ["workflow_org_readiness", workflow.id, workflow.publishedVersion],
    queryFn: () => workflowOrgReadiness({ data: { id: workflow.id } }),
  });
  const byOrg = new Map((readiness.data ?? []).map((r) => [r.orgId, r]));
  const set = async (orgId: string, on: boolean) => {
    try {
      if (on) await grantWorkflow({ data: { id: workflow.id, orgId } });
      else await revokeWorkflow({ data: { id: workflow.id, orgId } });
      const r = byOrg.get(orgId);
      if (on && r && !r.ready)
        toast.warning("Granted — it will not run there until the missing items are fixed");
      else toast.success(on ? "Granted" : "Withdrawn");
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Could not change"));
    }
  };
  return (
    <ul className="max-w-3xl divide-y rounded-md border text-sm">
      {view.organisations.map((o) => {
        const r = byOrg.get(o.id);
        return (
          <li key={o.id} className="px-3 py-2">
            <div className="flex items-center gap-3">
              <Checkbox
                checked={workflow.grants.includes(o.id)}
                onCheckedChange={(v) => set(o.id, Boolean(v))}
                aria-label={`Grant to ${o.name}`}
              />
              <span className="flex-1 font-medium">{o.name}</span>
              {workflow.grants.includes(o.id) ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(`${window.location.origin}/desk?workflow=${workflow.id}`)
                      .then(() => toast.success(`Link copied — share it with ${o.name}'s HR or TA`))
                  }
                >
                  <Link2 className="size-3.5" /> Copy link
                </Button>
              ) : null}
              {o.status !== "active" ? (
                <Badge variant="outline">{o.status}</Badge>
              ) : r ? (
                <Badge variant={r.ready ? "default" : "outline"}>
                  {r.ready ? "Ready" : "Not ready"}
                </Badge>
              ) : null}
            </div>
            {r ? <ReadinessList items={r.items} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function ReadinessList({ items }: { items: OrgReadinessRow["items"] }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 pl-7 text-xs">
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-1">
          {i.ok ? (
            <CircleCheck className="size-3.5 text-emerald-600" />
          ) : (
            <CircleX className="size-3.5 text-destructive" />
          )}
          <span>{i.label}</span>
          <span className="text-muted-foreground">· {i.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function Runs({
  view,
  workflow,
  nodes,
}: {
  view: WorkflowBuilderView;
  workflow: WorkflowRow;
  nodes: FlowNode[];
}) {
  const runs = view.runs.filter((r) => r.workflowId === workflow.id);
  const [org, setOrg] = useState("");
  const [need, setNeed] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const manual = workflow.graph.nodes.some(
    (n) => n.kind === "trigger" && n.data.event === "manual",
  );
  const startable = view.owned.filter((o) => workflow.grants.includes(o.id));
  const label = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n ? n.data.label || n.data.agentType || n.type : id;
  };
  const download = async (runId: string, kind: "pdf" | "xlsx") => {
    try {
      const r = await platformWorkflowReport({ data: { runId } });
      const { downloadWorkflowRunReport } = await import("@/lib/agent-reports");
      downloadWorkflowRunReport(kind, r);
    } catch (e) {
      toast.error(errorText(e, "Could not build the report"));
    }
  };
  return (
    <div className="space-y-3">
      {manual && workflow.publishedVersion ? (
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex gap-2">
            <Select value={org} onValueChange={setOrg}>
              <SelectTrigger className="h-8 w-64">
                <SelectValue placeholder="Organisation" />
              </SelectTrigger>
              <SelectContent>
                {startable.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={busy || !org || need.trim().length < 5}
              onClick={async () => {
                setBusy(true);
                try {
                  await runWorkflowNow({ data: { id: workflow.id, orgId: org, need } });
                  toast.success("Started");
                  setNeed("");
                  await qc.invalidateQueries({ queryKey: ["platform_agent_workflows"] });
                } catch (e) {
                  toast.error(errorText(e, "Could not start"));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Play className="size-4" /> Run now
            </Button>
          </div>
          <Textarea
            className="min-h-16 text-sm"
            placeholder="Hiring need, e.g. We need two AI engineers in Chennai by March"
            value={need}
            maxLength={4000}
            onChange={(e) => setNeed(e.target.value)}
          />
        </div>
      ) : null}
      {!runs.length ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {runs.map((r) => (
            <li key={r.id} className="space-y-1 px-3 py-2">
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    r.status === "failed"
                      ? "destructive"
                      : r.status === "done"
                        ? "default"
                        : "secondary"
                  }
                >
                  {r.status}
                </Badge>
                <span className="font-medium">{r.orgName}</span>
                <span className="text-xs text-muted-foreground">
                  v{r.version} · {new Date(r.createdAt).toLocaleString()}
                </span>
                <div className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() => download(r.id, "pdf")}
                  >
                    <Download className="size-3.5" /> PDF
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() => download(r.id, "xlsx")}
                  >
                    <Download className="size-3.5" /> Excel
                  </Button>
                </div>
              </div>
              {r.waitingOn ? (
                <div
                  className={`text-xs font-medium ${r.waitingOn.kind === "person" || r.waitingOn.kind === "stopped" ? "text-amber-700" : "text-foreground"}`}
                >
                  {r.waitingOn.text}
                </div>
              ) : null}
              <RunFlow
                run={r}
                graph={r.graph ?? workflow.graph}
                label={(id) => {
                  const n = (r.graph ?? workflow.graph).nodes.find((x) => x.id === id);
                  return n ? n.data.label || n.data.agentType || n.kind : label(id);
                }}
              />
              {r.waitingOn?.kind === "stopped" && view.owned.some((o) => o.id === r.orgId) ? (
                <StoppedStepActions
                  workflowRunId={r.id}
                  invalidate={["platform_agent_workflows"]}
                />
              ) : null}
              {r.waitingOn?.kind === "person" && view.owned.some((o) => o.id === r.orgId) ? (
                <WorkflowRunRequests
                  workflowRunId={r.id}
                  onDecided={() =>
                    void qc.invalidateQueries({ queryKey: ["platform_agent_workflows"] })
                  }
                />
              ) : null}
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">History</summary>
                <ol className="mt-1 space-y-0.5">
                  {r.history.map((h, i) => (
                    <li key={i}>
                      {new Date(h.at).toLocaleTimeString()} · {label(h.node)}: {h.note}
                    </li>
                  ))}
                </ol>
              </details>
              {r.error ? <div className="text-xs text-destructive">{r.error}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
