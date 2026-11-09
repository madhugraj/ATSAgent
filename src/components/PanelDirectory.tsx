/**
 * The panel directory on the Team page (docs/panel-directory.md): everyone who
 * may sit on an interview panel — org members and people HR added, internal or
 * external. The HR head (or an owner) adds people and takes them off panels.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { UserPlus, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addToPanelDirectory,
  listPanelDirectory,
  setPanelDirectoryActive,
} from "@/lib/panelists.functions";

export function PanelDirectory({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const list = useServerFn(listPanelDirectory);
  const add = useServerFn(addToPanelDirectory);
  const setActive = useServerFn(setPanelDirectoryActive);
  const q = useQuery({ queryKey: ["panel_directory"], queryFn: () => list({}) });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"internal" | "external">("external");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [areas, setAreas] = useState("");
  const [rounds, setRounds] = useState<number[]>([1, 2, 3]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["panel_directory"] });
  const save = async () => {
    setBusy(true);
    try {
      await add({
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
          rounds,
        },
      });
      toast.success(`${fullName} added to the panel directory.`);
      setFullName("");
      setEmail("");
      setTitle("");
      setCompany("");
      setAreas("");
      setOpen(false);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add them.");
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (id: string, active: boolean) => {
    try {
      await setActive({ data: { id, active } });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change it.");
    }
  };

  const rows = q.data ?? [];
  return (
    <section className="panel space-y-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Users className="size-4" /> Panel directory
        </h2>
        {canEdit ? (
          <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
            <UserPlus className="size-4" /> Add a panellist
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Everyone who can sit on an interview panel: your members, and people added here or when the
        Interview coordinator asks for someone new. External panellists score through a private link
        sent with their interviewer brief.
      </p>
      {open ? (
        <div className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2">
          <div className="flex gap-3 text-xs sm:col-span-2">
            {(["internal", "external"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input type="radio" checked={kind === k} onChange={() => setKind(k)} />
                {k === "internal"
                  ? "In our organisation (no login needed)"
                  : "External (e.g. a client)"}
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
          <div className="flex items-center gap-3 text-xs">
            <span>Rounds:</span>
            {[1, 2, 3].map((r) => (
              <label key={r} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={rounds.includes(r)}
                  onChange={() =>
                    setRounds((x) => (x.includes(r) ? x.filter((y) => y !== r) : [...x, r].sort()))
                  }
                />
                L{r}
              </label>
            ))}
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={
                busy ||
                fullName.trim().length < 2 ||
                !email.includes("@") ||
                !rounds.length ||
                (kind === "external" && !company.trim())
              }
              onClick={save}
            >
              Add and approve
            </Button>
          </div>
        </div>
      ) : null}
      {q.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="divide-y divide-border text-sm">
          {rows.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 py-2">
              <span
                className={`font-medium ${p.active ? "" : "text-muted-foreground line-through"}`}
              >
                {p.fullName}
              </span>
              <span className="text-xs text-muted-foreground">{p.email}</span>
              <Badge variant={p.kind === "external" ? "default" : "secondary"}>
                {p.kind === "external"
                  ? `External${p.company ? ` · ${p.company}` : ""}`
                  : p.member
                    ? "Member"
                    : "Internal"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {p.rounds.map((r) => `L${r}`).join(" ")}
                {p.areas.length ? ` · ${p.areas.join(", ")}` : ""}
              </span>
              {canEdit && !p.member ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => toggle(p.id, !p.active)}
                >
                  {p.active ? "Take off panels" : "Put back on panels"}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
