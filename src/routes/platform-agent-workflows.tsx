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
  CircleX,
  FlaskConical,
  GitBranch,
  KeyRound,
  Plus,
  Rocket,
  ShieldCheck,
  Trash2,
  Zap,
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
import { AGENT_LABEL } from "@/lib/agents.catalog";
import {
  approveWorkflow,
  archiveWorkflow,
  grantWorkflow,
  publishWorkflow,
  revokeWorkflow,
  saveWorkflow,
  testWorkflow,
  workflowBuilder,
  type SaveWorkflowInput,
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

type Kind = "trigger" | "agent" | "condition" | "end";
type NodeData = {
  label?: string | undefined;
  event?: string | undefined;
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
const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const eventLabel = (e?: string) => (e ? e.replace(/[._]/g, " ") : "Pick an event");

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
        <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{sub}</div>
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
      <div className="pointer-events-none flex justify-between px-6 text-[10px] text-muted-foreground">
        <span>yes</span>
        <span>no</span>
      </div>
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
  });
  const [open, setOpen] = useState<string | "new" | null>(null);
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
            setOpen(null);
          }}
          onSaved={(id) => {
            refresh();
            setOpen(id);
          }}
          onChanged={refresh}
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
          <Button size="sm" onClick={() => setOpen("new")}>
            <Plus className="size-4" /> New workflow
          </Button>
        }
      />
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
                  onClick={() => setOpen(w.id)}
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
}: {
  view: WorkflowBuilderView;
  existing: WorkflowRow | undefined;
  onBack: () => void;
  onSaved: (id: string) => void;
  onChanged: () => void;
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
  const flow = useReactFlow();

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
                className={`rounded-full px-2 py-0.5 text-[11px] ${
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
          <Button size="sm" disabled={busy} onClick={save}>
            Save draft
          </Button>
          {existing ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={test}>
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
              <Label className="mt-1 text-[11px] text-muted-foreground">Agents</Label>
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
                      <Badge variant="secondary" className="ml-auto px-1 text-[9px]">
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
              {view.events.map((e) => (
                <SelectItem key={e} value={e}>
                  {eventLabel(e)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              {"{{payload.<field>}} {{subject_type}} {{last.result}}"}
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
              placeholder="last.status · payload.level"
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
        nodes.filter((n) => n.type === "agent").map((n) => [n.id, { status: "done", result: "" }]),
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
            <Textarea
              className="mt-1 min-h-32 font-mono text-xs"
              value={t.outcomesJson}
              onChange={(e) => set(i, { outcomesJson: e.target.value })}
            />
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
                  payloadJson: "{}",
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
  const set = async (orgId: string, on: boolean) => {
    try {
      if (on) await grantWorkflow({ data: { id: workflow.id, orgId } });
      else await revokeWorkflow({ data: { id: workflow.id, orgId } });
      toast.success(on ? "Granted" : "Withdrawn");
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Could not change"));
    }
  };
  return (
    <ul className="max-w-xl divide-y rounded-md border text-sm">
      {view.organisations.map((o) => (
        <li key={o.id} className="flex items-center gap-3 px-3 py-2">
          <Checkbox
            checked={workflow.grants.includes(o.id)}
            onCheckedChange={(v) => set(o.id, Boolean(v))}
            aria-label={`Grant to ${o.name}`}
          />
          <span className="flex-1">{o.name}</span>
          {o.status !== "active" ? <Badge variant="outline">{o.status}</Badge> : null}
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
  const label = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n ? n.data.label || n.data.agentType || n.type : id;
  };
  if (!runs.length) return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  return (
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
          </div>
          <div className="text-xs text-muted-foreground">
            {r.history.map((h) => `${label(h.node)}: ${h.note}`).join(" → ")}
          </div>
          {r.error ? <div className="text-xs text-destructive">{r.error}</div> : null}
        </li>
      ))}
    </ul>
  );
}
