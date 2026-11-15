import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Download, KeyRound, Plus, Trash2 } from "lucide-react";

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
import { AGENT_LABEL } from "@/lib/agents.catalog";
import {
  agentStudio,
  archiveAgentExport,
  createExportKey,
  downloadAgentPackage,
  revokeExportKey,
  saveAgentExport,
  type StudioAgent,
  type StudioExport,
} from "@/lib/agent-exports.functions";

export const Route = createFileRoute("/agents/studio")({
  head: () => ({
    meta: [
      { title: "Agent studio — ATSIQ" },
      {
        name: "description",
        content: "Customise hiring agents for other applications and export them.",
      },
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

function errorText(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback;
}

function AgentStudioPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["agent_studio"], queryFn: () => agentStudio(), retry: false });
  const [open, setOpen] = useState<{ exportId: string | null; agentType: string | null } | null>(
    null,
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ["agent_studio"] });
  const data = q.data;
  const live = data?.exports.filter((e) => e.status !== "archived") ?? [];
  const editing = open?.exportId ? data?.exports.find((e) => e.id === open.exportId) : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Agent administration"
        title="Agent studio"
        description="Customise an agent for another application, then download it as a package or run it here through the hosted API."
        actions={
          data?.canEdit ? (
            <Button size="sm" onClick={() => setOpen({ exportId: null, agentType: null })}>
              <Plus className="size-4" /> New export
            </Button>
          ) : null
        }
      />
      {q.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <p className="mt-4 text-sm text-muted-foreground">{errorText(q.error, "Not available.")}</p>
      ) : !live.length ? (
        <EmptyState title="No exports yet" />
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Export</th>
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">Tools</th>
                <th className="px-4 py-2 font-medium">Keys</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {live.map((e) => (
                <tr
                  key={e.id}
                  className="cursor-pointer border-t hover:bg-muted/30"
                  onClick={() => setOpen({ exportId: e.id, agentType: e.agentType })}
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{e.name}</div>
                    <div className="text-xs text-muted-foreground">v{e.version}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    {agentName(e.agentType)}
                    {e.outOfDate ? (
                      <Badge variant="outline" className="ml-2">
                        Agent updated
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{e.tools.length}</td>
                  <td className="px-4 py-2.5 tabular-nums">{e.keys.length}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={STATUS_TONE[e.status]}>{e.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={Boolean(open)} onOpenChange={(o) => (!o ? setOpen(null) : undefined)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {open && data && (!open.exportId || editing) ? (
            <ExportEditor
              key={editing ? `${editing.id}:${editing.version}` : "new"}
              agents={data.agents}
              existing={editing}
              canEdit={data.canEdit}
              onSaved={(id) => {
                refresh();
                setOpen({ exportId: id, agentType: null });
              }}
              onArchived={() => {
                refresh();
                setOpen(null);
              }}
              onKeysChanged={refresh}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

function ExportEditor({
  agents,
  existing,
  canEdit,
  onSaved,
  onArchived,
  onKeysChanged,
}: {
  agents: StudioAgent[];
  existing: StudioExport | undefined;
  canEdit: boolean;
  onSaved: (id: string) => void;
  onArchived: () => void;
  onKeysChanged: () => void;
}) {
  const [agentType, setAgentType] = useState(existing?.agentType ?? "");
  const agent = agents.find((a) => a.type === agentType);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [extra, setExtra] = useState(existing?.extraInstructions ?? "");
  const [tools, setTools] = useState<string[]>(existing?.tools ?? []);
  const [mustNever, setMustNever] = useState((existing?.extraMustNever ?? []).join("\n"));
  const [steps, setSteps] = useState(existing?.maxSteps?.toString() ?? "");
  const [saving, setSaving] = useState(false);

  const pickAgent = (type: string) => {
    const a = agents.find((x) => x.type === type);
    setAgentType(type);
    setTools(a?.tools.map((t) => t.name) ?? []);
    if (!name.trim() && a) setName(`${agentName(a.type, a.name)} (custom)`);
  };

  const save = async (status: "draft" | "published") => {
    if (!agent) return;
    setSaving(true);
    try {
      const r = await saveAgentExport({
        data: {
          id: existing?.id,
          agentType: agent.type,
          name,
          description,
          extraInstructions: extra,
          tools,
          extraMustNever: mustNever.split("\n"),
          maxSteps: steps.trim() ? Number(steps) : null,
          maxTokens: existing?.maxTokens ?? null,
          status,
        },
      });
      toast.success(status === "published" ? "Published" : "Saved");
      onSaved(r.id);
    } catch (e) {
      toast.error(errorText(e, "Could not save"));
    } finally {
      setSaving(false);
    }
  };

  const download = async () => {
    if (!existing) return;
    try {
      const { fileName, json } = await downloadAgentPackage({ data: { id: existing.id } });
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(errorText(e, "Could not download"));
    }
  };

  const archive = async () => {
    if (!existing) return;
    try {
      await archiveAgentExport({ data: { id: existing.id } });
      toast.success("Archived");
      onArchived();
    } catch (e) {
      toast.error(errorText(e, "Could not archive"));
    }
  };

  const locked = !canEdit;

  return (
    <>
      <SheetHeader className="pr-8 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle>{existing ? existing.name : "New export"}</SheetTitle>
          {existing ? (
            <Badge variant={STATUS_TONE[existing.status]}>{existing.status}</Badge>
          ) : null}
          {existing?.outOfDate ? <Badge variant="outline">Agent updated</Badge> : null}
        </div>
      </SheetHeader>

      <Tabs defaultValue="customise" className="mt-4">
        <TabsList>
          <TabsTrigger value="customise">Customise</TabsTrigger>
          <TabsTrigger value="api" disabled={!existing}>
            Hosted API
          </TabsTrigger>
        </TabsList>

        <TabsContent value="customise" className="mt-4 space-y-5">
          <div>
            <Label className="text-xs">Agent</Label>
            <Select
              value={agentType}
              disabled={Boolean(existing) || locked}
              onValueChange={pickAgent}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.type} value={a.type}>
                    {agentName(a.type, a.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {agent ? (
            <>
              <div>
                <Label className="text-xs" htmlFor="exp-name">
                  Name
                </Label>
                <Input
                  id="exp-name"
                  className="mt-1"
                  value={name}
                  maxLength={80}
                  disabled={locked}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs" htmlFor="exp-desc">
                  Description
                </Label>
                <Input
                  id="exp-desc"
                  className="mt-1"
                  value={description}
                  maxLength={500}
                  disabled={locked}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <details className="rounded-md border px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium">Stock instructions</summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-muted-foreground">
                  {agent.instructions}
                </pre>
              </details>

              <div>
                <Label className="text-xs" htmlFor="exp-extra">
                  Extra instructions
                </Label>
                <Textarea
                  id="exp-extra"
                  className="mt-1 min-h-28"
                  value={extra}
                  maxLength={4000}
                  disabled={locked}
                  onChange={(e) => setExtra(e.target.value)}
                />
              </div>

              <div>
                <Label className="text-xs">
                  Tools ({tools.length} of {agent.tools.length})
                </Label>
                <div className="mt-2 space-y-1.5">
                  {agent.tools.map((t) => (
                    <label
                      key={t.name}
                      className="flex items-start gap-2 text-sm"
                      title={t.description}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={tools.includes(t.name)}
                        disabled={locked}
                        onCheckedChange={(v) =>
                          setTools(
                            v
                              ? agent.tools
                                  .map((x) => x.name)
                                  .filter((n) => n === t.name || tools.includes(n))
                              : tools.filter((x) => x !== t.name),
                          )
                        }
                      />
                      <span className="font-mono text-xs">{t.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <Label className="text-xs">Must never</Label>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {agent.mustNever.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
                <Textarea
                  className="mt-2 min-h-20"
                  placeholder="One rule per line"
                  value={mustNever}
                  disabled={locked}
                  onChange={(e) => setMustNever(e.target.value)}
                />
              </div>

              <div>
                <Label className="text-xs" htmlFor="exp-steps">
                  Steps before a person decides
                </Label>
                <Input
                  id="exp-steps"
                  className="mt-1 w-32"
                  inputMode="numeric"
                  placeholder={String(agent.maxSteps)}
                  value={steps}
                  disabled={locked}
                  onChange={(e) => setSteps(e.target.value.replace(/\D/g, ""))}
                />
              </div>

              {canEdit ? (
                <div className="flex flex-wrap gap-2 border-t pt-4">
                  <Button disabled={saving} onClick={() => save("published")}>
                    {existing?.status === "published" ? "Save" : "Publish"}
                  </Button>
                  {existing?.status !== "published" ? (
                    <Button variant="outline" disabled={saving} onClick={() => save("draft")}>
                      Save draft
                    </Button>
                  ) : null}
                  {existing ? (
                    <>
                      <Button variant="outline" onClick={download}>
                        <Download className="size-4" /> Download package
                      </Button>
                      <Button
                        variant="ghost"
                        className="ml-auto text-destructive"
                        onClick={archive}
                      >
                        <Trash2 className="size-4" /> Archive
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="api" className="mt-4">
          {existing ? (
            <HostedApi exp={existing} canEdit={canEdit} onChanged={onKeysChanged} />
          ) : null}
        </TabsContent>
      </Tabs>
    </>
  );
}

function HostedApi({
  exp,
  canEdit,
  onChanged,
}: {
  exp: StudioExport;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const base = `${origin}/api/agents/${exp.id}/runs`;

  const create = async () => {
    try {
      const r = await createExportKey({ data: { exportId: exp.id, label } });
      setShown(r.key);
      setLabel("");
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Could not create key"));
    }
  };
  const revoke = async (keyId: string) => {
    try {
      await revokeExportKey({ data: { keyId } });
      toast.success("Revoked");
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Could not revoke"));
    }
  };
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    toast.success("Copied");
  };

  if (exp.status !== "published")
    return (
      <p className="text-sm text-muted-foreground">Publish the export to use the hosted API.</p>
    );

  return (
    <div className="space-y-5">
      <div className="space-y-1.5 text-xs">
        <Label className="text-xs">Endpoints</Label>
        <code className="block rounded bg-muted px-2 py-1.5">POST {base}</code>
        <code className="block rounded bg-muted px-2 py-1.5">
          GET {origin}/api/agents/runs/:runId
        </code>
        <code className="block rounded bg-muted px-2 py-1.5">MCP {origin}/api/mcp</code>
      </div>

      {shown ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <Label className="text-xs">New key — shown once</Label>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 break-all text-xs">{shown}</code>
            <Button size="icon" variant="outline" className="size-7" onClick={() => copy(shown)}>
              <Copy className="size-3.5" />
            </Button>
          </div>
        </div>
      ) : null}

      <div>
        <Label className="text-xs">Keys</Label>
        {exp.keys.length ? (
          <ul className="mt-2 divide-y rounded-md border text-sm">
            {exp.keys.map((k) => (
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
                {canEdit ? (
                  <Button size="sm" variant="ghost" onClick={() => revoke(k.id)}>
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">None</p>
        )}
        {canEdit ? (
          <div className="mt-3 flex gap-2">
            <Input
              placeholder="Label"
              value={label}
              maxLength={80}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Button variant="outline" onClick={create}>
              <Plus className="size-4" /> Create key
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
