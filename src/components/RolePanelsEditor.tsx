/**
 * Who sits on each round's panel, in the hiring plan editor (docs/panel-directory.md):
 * pick people from the panel directory — members and people added before, internal
 * or external — or add someone new right here. Saving a round's panel is the
 * person's decision (the hiring manager, HR head, department head or CBO), audited.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getInterviewPlan } from "@/lib/interview-plan.functions";
import { getPanelChoices, getRolePanels, saveRolePanel } from "@/lib/panels.functions";
import { addToPanelDirectory } from "@/lib/panelists.functions";

export function RolePanelsEditor({ requisitionId }: { requisitionId: string }) {
  const plan = useQuery({
    queryKey: ["interview_plan", requisitionId],
    queryFn: () => getInterviewPlan({ data: { requisitionId } }),
  });
  const panels = useQuery({
    queryKey: ["role_panels", requisitionId],
    queryFn: () => getRolePanels({ data: { requisitionId } }),
  });
  if (!plan.data || !panels.data)
    return <p className="text-xs text-muted-foreground">Loading the panels…</p>;
  return (
    <div className="space-y-3">
      {plan.data.plan.rounds.map((r) => (
        <RoundPanel
          key={r.level}
          requisitionId={requisitionId}
          level={r.level}
          name={r.name}
          panelSize={r.panelSize}
          current={panels.data[r.level] ?? []}
        />
      ))}
    </div>
  );
}

function RoundPanel(props: {
  requisitionId: string;
  level: number;
  name: string;
  panelSize: number;
  current: { memberId: string; name: string; kind: string }[];
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>(props.current.map((m) => m.memberId));
  const [busy, setBusy] = useState(false);
  const choices = useQuery({
    queryKey: ["panel_choices", props.requisitionId, props.level],
    queryFn: () =>
      getPanelChoices({ data: { requisitionId: props.requisitionId, level: props.level } }),
    enabled: open,
  });
  const people = [...(choices.data?.eligible ?? []), ...(choices.data?.others ?? [])];
  const toggle = (id: string) =>
    setPicked((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : p.length < props.panelSize ? [...p, id] : p,
    );
  const save = async () => {
    setBusy(true);
    try {
      await saveRolePanel({
        data: { requisitionId: props.requisitionId, level: props.level, memberIds: picked },
      });
      toast.success(`L${props.level} panel saved.`);
      setOpen(false);
      await qc.invalidateQueries({ queryKey: ["role_panels", props.requisitionId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the panel.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          L{props.level} · {props.name}
        </span>
        <span className="text-xs text-muted-foreground">panel of {props.panelSize}</span>
        {props.current.length ? (
          props.current.map((m) => (
            <Badge key={m.memberId} variant={m.kind === "external" ? "default" : "secondary"}>
              {m.name}
              {m.kind === "external" ? " · external" : ""}
            </Badge>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">
            No panel yet — the Interview coordinator proposes one, or choose it here.
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => {
            setPicked(props.current.map((m) => m.memberId));
            setOpen((o) => !o);
          }}
        >
          {open ? "Close" : props.current.length ? "Change the panel" : "Choose the panel"}
        </Button>
      </div>
      {open ? (
        <div className="mt-3 space-y-2">
          {choices.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading the panel directory…</p>
          ) : (
            <div className="grid gap-1 sm:grid-cols-2">
              {people.map((p) => (
                <label key={p.memberId} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={picked.includes(p.memberId)}
                    disabled={!picked.includes(p.memberId) && picked.length >= props.panelSize}
                    onChange={() => toggle(p.memberId)}
                  />
                  <span className="font-medium">{p.name}</span>
                  {"note" in p && typeof p.note === "string" && p.note ? (
                    <span className="text-muted-foreground">{p.note}</span>
                  ) : null}
                </label>
              ))}
            </div>
          )}
          {adding ? (
            <AddPanellist
              level={props.level}
              onAdded={async (id) => {
                setAdding(false);
                await qc.invalidateQueries({
                  queryKey: ["panel_choices", props.requisitionId, props.level],
                });
                await qc.invalidateQueries({ queryKey: ["panel_directory"] });
                setPicked((p) => (p.length < props.panelSize ? [...p, id] : p));
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              <UserPlus className="size-4" /> Add someone new to the panel directory
            </Button>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || picked.length < 1} onClick={save}>
              Save the L{props.level} panel
            </Button>
            <span className="self-center text-xs text-muted-foreground">
              {picked.length} of {props.panelSize} chosen
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AddPanellist(props: {
  level: number;
  onAdded: (id: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<"internal" | "external">("external");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [areas, setAreas] = useState("");
  const [busy, setBusy] = useState(false);
  const ok =
    fullName.trim().length >= 2 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) &&
    (kind === "internal" || company.trim().length > 0);
  const add = async () => {
    setBusy(true);
    try {
      const r = await addToPanelDirectory({
        data: {
          fullName,
          email,
          kind,
          title: title || null,
          company: kind === "external" ? company : null,
          areas: areas
            .split(",")
            .map((a) => a.trim())
            .filter((a) => a.length >= 2),
          rounds: [props.level],
        },
      });
      toast.success(`${fullName} added to the panel directory.`);
      await props.onAdded(r.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add them.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-2 rounded-md border border-dashed border-border p-3 sm:grid-cols-2">
      <div className="flex gap-3 text-xs sm:col-span-2">
        {(["internal", "external"] as const).map((k) => (
          <label key={k} className="flex items-center gap-1">
            <input type="radio" checked={kind === k} onChange={() => setKind(k)} />
            {k === "internal" ? "In our organisation" : "External (e.g. a client)"}
          </label>
        ))}
      </div>
      <Input
        placeholder="Full name"
        value={fullName}
        maxLength={120}
        onChange={(e) => setFullName(e.target.value)}
      />
      <Input
        placeholder="E-mail"
        type="email"
        value={email}
        maxLength={200}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Input
        placeholder="Job title (optional)"
        value={title}
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
      />
      {kind === "external" ? (
        <Input
          placeholder="Their organisation"
          value={company}
          maxLength={120}
          onChange={(e) => setCompany(e.target.value)}
        />
      ) : (
        <span />
      )}
      <Input
        className="sm:col-span-2"
        placeholder="What they assess, comma-separated"
        value={areas}
        onChange={(e) => setAreas(e.target.value)}
      />
      <p className="text-[11px] text-muted-foreground sm:col-span-2">
        You add and approve them in one step (recorded as self-approved, HR head or owner). They
        stay in the panel directory for future roles; external panellists score through a private
        link sent with their brief.
      </p>
      <div className="flex gap-2 sm:col-span-2">
        <Button size="sm" disabled={busy || !ok} onClick={add}>
          Add and approve
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
