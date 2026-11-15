import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, CopyPlus, Download, KeyRound, Lock, Plus, RotateCcw, Trash2 } from "lucide-react";

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
import { AGENT_LABEL } from "@/lib/agents.catalog";
import {
  agentStudio,
  archiveBlueprint,
  createBlueprintKey,
  downloadBlueprintPackage,
  duplicateBlueprint,
  revokeBlueprintKey,
  saveBlueprint,
  setBlueprintWorkspace,
  type StudioAgent,
  type StudioBlueprint,
  type StudioView,
} from "@/lib/platform-agent-studio.functions";

export const Route = createFileRoute("/platform-agent-studio")({
  head: () => ({
    meta: [
      { title: "Agent studio — ATSIQ" },
      { name: "description", content: "Adapt hiring agents to other domains and applications." },
    ],
  }),
  component: AgentStudioPage,
});

const STATUS_TONE: Record<string, "default" | "secondary" | "outline"> = {
  published: "default",
  draft: "secondary",
  archived: "outline",
};

const agentName = (type: string, fallback?: string) => AGENT_LABEL[type] ?? fallback ?? type;
const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

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
  const editing = open && open !== "new" ? data?.blueprints.find((b) => b.id === open) : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Agent studio"
        description="Adapt a hiring agent to another domain, then download it as a package or run it through the hosted API."
        actions={
          <Button size="sm" onClick={() => setOpen("new")}>
            <Plus className="size-4" /> New blueprint
          </Button>
        }
      />
      {q.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <p className="mt-4 text-sm text-muted-foreground">{errorText(q.error, "Not available.")}</p>
      ) : !data?.blueprints.length ? (
        <EmptyState title="No blueprints yet" />
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Blueprint</th>
                <th className="px-4 py-2 font-medium">Based on</th>
                <th className="px-4 py-2 font-medium">Tools</th>
                <th className="px-4 py-2 font-medium">Keys</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.blueprints.map((b) => (
                <tr
                  key={b.id}
                  className="cursor-pointer border-t hover:bg-muted/30"
                  onClick={() => setOpen(b.id)}
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{b.name}</div>
                    <div className="text-xs text-muted-foreground">v{b.version}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    {agentName(b.agentType)}
                    <span className="ml-1 text-xs text-muted-foreground">{b.baseVersion}</span>
                    {b.outOfDate ? (
                      <Badge variant="outline" className="ml-2">
                        Agent updated
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{b.tools.length}</td>
                  <td className="px-4 py-2.5 tabular-nums">{b.keys.length}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={STATUS_TONE[b.status]}>{b.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={Boolean(open)} onOpenChange={(o) => (!o ? setOpen(null) : undefined)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
          {data && (open === "new" || editing) ? (
            <BlueprintEditor
              key={editing ? `${editing.id}:${editing.version}` : "new"}
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

type ToolRow = { include: boolean; name: string; description: string };

function toolRows(agent: StudioAgent, bp?: StudioBlueprint): Record<string, ToolRow> {
  return Object.fromEntries(
    agent.tools.map((t) => [
      t.name,
      {
        include: bp ? bp.tools.includes(t.name) : true,
        name: bp?.toolOverrides[t.name]?.name || t.name,
        description: bp?.toolOverrides[t.name]?.description || t.description,
      },
    ]),
  );
}

function BlueprintEditor({
  view,
  existing,
  onSaved,
  onClosed,
  onChanged,
}: {
  view: StudioView;
  existing: StudioBlueprint | undefined;
  onSaved: (id: string) => void;
  onClosed: () => void;
  onChanged: () => void;
}) {
  const initialAgent = view.agents.find((a) => a.type === existing?.agentType);
  const [agentType, setAgentType] = useState(existing?.agentType ?? "");
  const agent = view.agents.find((a) => a.type === agentType);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [responsibility, setResponsibility] = useState(existing?.responsibility ?? "");
  const [instructions, setInstructions] = useState(existing?.instructions ?? "");
  const [mustNever, setMustNever] = useState((existing?.mustNever ?? []).join("\n"));
  const [tools, setTools] = useState<Record<string, ToolRow>>(
    initialAgent ? toolRows(initialAgent, existing) : {},
  );
  const [steps, setSteps] = useState(existing?.maxSteps?.toString() ?? "");
  const [busy, setBusy] = useState(false);

  const pickAgent = (type: string) => {
    const a = view.agents.find((x) => x.type === type);
    if (!a) return;
    setAgentType(type);
    setName(`${agentName(a.type, a.name)} (adapted)`);
    setResponsibility(a.responsibility);
    setInstructions(a.instructions);
    setMustNever(a.mustNever.join("\n"));
    setTools(toolRows(a));
    setSteps("");
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

  const save = (status: "draft" | "published") =>
    run(async () => {
      if (!agent) return;
      const kept = agent.tools.map((t) => t.name).filter((n) => tools[n]?.include);
      const r = await saveBlueprint({
        data: {
          id: existing?.id,
          agentType: agent.type,
          name,
          description,
          responsibility,
          instructions,
          mustNever: mustNever.split("\n"),
          tools: kept,
          toolOverrides: Object.fromEntries(
            kept.map((n) => [n, { name: tools[n]!.name, description: tools[n]!.description }]),
          ),
          maxSteps: steps.trim() ? Number(steps) : null,
          status,
        },
      });
      toast.success(status === "published" ? "Published" : "Saved");
      onSaved(r.id);
    }, "Could not save");

  const download = () =>
    run(async () => {
      if (!existing) return;
      const { fileName, json } = await downloadBlueprintPackage({ data: { id: existing.id } });
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, "Could not download");

  const duplicate = () =>
    run(async () => {
      if (!existing) return;
      const r = await duplicateBlueprint({ data: { id: existing.id } });
      toast.success("Copied");
      onSaved(r.id);
    }, "Could not copy");

  const archive = () =>
    run(async () => {
      if (!existing) return;
      await archiveBlueprint({ data: { id: existing.id } });
      toast.success("Archived");
      onClosed();
    }, "Could not archive");

  const setTool = (n: string, patch: Partial<ToolRow>) =>
    setTools((t) => ({ ...t, [n]: { ...t[n]!, ...patch } }));
  const kept = agent ? agent.tools.filter((t) => tools[t.name]?.include).length : 0;

  return (
    <>
      <SheetHeader className="pr-8 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle>{existing ? existing.name : "New blueprint"}</SheetTitle>
          {existing ? (
            <Badge variant={STATUS_TONE[existing.status]}>{existing.status}</Badge>
          ) : null}
          {existing?.outOfDate ? <Badge variant="outline">Agent updated</Badge> : null}
        </div>
      </SheetHeader>

      <Tabs defaultValue="adapt" className="mt-4">
        <TabsList>
          <TabsTrigger value="adapt">Adapt</TabsTrigger>
          <TabsTrigger value="deliver" disabled={!existing}>
            Delivery
          </TabsTrigger>
        </TabsList>

        <TabsContent value="adapt" className="mt-4 space-y-5">
          <div>
            <Label className="text-xs">Start from</Label>
            <Select value={agentType} disabled={Boolean(existing)} onValueChange={pickAgent}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent>
                {view.agents.map((a) => (
                  <SelectItem key={a.type} value={a.type}>
                    {agentName(a.type, a.name)} · {a.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {agent ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label className="text-xs" htmlFor="bp-name">
                    Name
                  </Label>
                  <Input
                    id="bp-name"
                    className="mt-1"
                    value={name}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div>
                  <Label className="text-xs" htmlFor="bp-desc">
                    Description
                  </Label>
                  <Input
                    id="bp-desc"
                    className="mt-1"
                    value={description}
                    maxLength={500}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <Label className="text-xs" htmlFor="bp-resp">
                  Responsibility
                </Label>
                <Textarea
                  id="bp-resp"
                  className="mt-1 min-h-16"
                  value={responsibility}
                  maxLength={600}
                  onChange={(e) => setResponsibility(e.target.value)}
                />
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
                  <Label className="text-xs" htmlFor="bp-instr">
                    Instructions
                  </Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    onClick={() => setInstructions(agent.instructions)}
                  >
                    <RotateCcw className="size-3" /> Reset to stock
                  </Button>
                </div>
                <Textarea
                  id="bp-instr"
                  className="mt-1 min-h-64 font-mono text-xs"
                  value={instructions}
                  maxLength={20_000}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </div>

              <div>
                <Label className="text-xs" htmlFor="bp-never">
                  Must never
                </Label>
                <Textarea
                  id="bp-never"
                  className="mt-1 min-h-24"
                  value={mustNever}
                  onChange={(e) => setMustNever(e.target.value)}
                />
              </div>

              <div>
                <Label className="text-xs">
                  Tools ({kept} of {agent.tools.length})
                </Label>
                <div className="mt-2 space-y-2">
                  {agent.tools.map((t) => {
                    const row = tools[t.name]!;
                    return (
                      <div
                        key={t.name}
                        className={`rounded-md border p-3 ${row.include ? "" : "opacity-50"}`}
                      >
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={row.include}
                            onCheckedChange={(v) => setTool(t.name, { include: Boolean(v) })}
                            aria-label={`Include ${t.name}`}
                          />
                          <Input
                            className="h-8 font-mono text-xs"
                            value={row.name}
                            maxLength={61}
                            disabled={!row.include}
                            aria-label={`Name for ${t.name}`}
                            onChange={(e) => setTool(t.name, { name: e.target.value })}
                          />
                          {row.name !== t.name ? (
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                              ← {t.name}
                            </span>
                          ) : null}
                        </div>
                        {row.include ? (
                          <>
                            <Textarea
                              className="mt-2 min-h-16 text-xs"
                              value={row.description}
                              maxLength={1500}
                              aria-label={`Description for ${t.name}`}
                              onChange={(e) => setTool(t.name, { description: e.target.value })}
                            />
                            {t.fields.length ? (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {t.fields.map((f) => (
                                  <Badge
                                    key={f.name}
                                    variant="outline"
                                    className="font-mono text-[10px]"
                                  >
                                    {f.name}
                                    {f.required ? "*" : ""}: {f.type}
                                  </Badge>
                                ))}
                              </div>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                <Label className="text-xs" htmlFor="bp-steps">
                  Steps before a person decides
                </Label>
                <Input
                  id="bp-steps"
                  className="mt-1 w-32"
                  inputMode="numeric"
                  placeholder={String(agent.maxSteps)}
                  value={steps}
                  onChange={(e) => setSteps(e.target.value.replace(/\D/g, ""))}
                />
              </div>

              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button disabled={busy} onClick={() => save("published")}>
                  {existing?.status === "published" ? "Save" : "Publish"}
                </Button>
                {existing?.status !== "published" ? (
                  <Button variant="outline" disabled={busy} onClick={() => save("draft")}>
                    Save draft
                  </Button>
                ) : null}
                {existing ? (
                  <>
                    <Button variant="outline" disabled={busy} onClick={duplicate}>
                      <CopyPlus className="size-4" /> Duplicate
                    </Button>
                    <Button
                      variant="ghost"
                      className="ml-auto text-destructive"
                      disabled={busy}
                      onClick={archive}
                    >
                      <Trash2 className="size-4" /> Archive
                    </Button>
                  </>
                ) : null}
              </div>
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="deliver" className="mt-4">
          {existing ? (
            <Delivery
              bp={existing}
              workspaces={view.workspaces}
              onDownload={download}
              onChanged={onChanged}
            />
          ) : null}
        </TabsContent>
      </Tabs>
    </>
  );
}

function Delivery({
  bp,
  workspaces,
  onDownload,
  onChanged,
}: {
  bp: StudioBlueprint;
  workspaces: { id: string; name: string }[];
  onDownload: () => void;
  onChanged: () => void;
}) {
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const hosted = bp.status === "published" && bp.workspaceOrgId;

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
        <Label className="text-xs">Package</Label>
        <div className="mt-1">
          <Button variant="outline" onClick={onDownload}>
            <Download className="size-4" /> Download package
          </Button>
        </div>
      </div>

      <div>
        <Label className="text-xs">Hosted workspace</Label>
        <Select
          value={bp.workspaceOrgId ?? "none"}
          onValueChange={(v) =>
            act(
              () => setBlueprintWorkspace({ data: { id: bp.id, orgId: v === "none" ? null : v } }),
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
              POST {origin}/api/agents/{bp.id}/runs
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
            {bp.keys.length ? (
              <ul className="mt-2 divide-y rounded-md border text-sm">
                {bp.keys.map((k) => (
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
                          () => revokeBlueprintKey({ data: { keyId: k.id } }),
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
                      const r = await createBlueprintKey({ data: { id: bp.id, label } });
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
