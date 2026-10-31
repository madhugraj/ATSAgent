import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { NotebookPen } from "lucide-react";

import { getPanelAgent, setPanelAgent } from "@/lib/panel-agent.functions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type Policy = Awaited<ReturnType<typeof getPanelAgent>>["policy"];

/**
 * Whether interview calls are transcribed for the silent panel agent, and for
 * which rounds (docs/silent-panel-agent-plan.md). Shows, per connected meeting
 * provider, whether its connection can read transcripts.
 */
export function SilentPanelCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["panel_agent"], queryFn: () => getPanelAgent() });
  const [draft, setDraft] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  if (!q.data) return null;
  const { providers } = q.data;
  const p = draft ?? q.data.policy;
  const set = (patch: Partial<Policy>) => setDraft({ ...p, ...patch });
  const toggleLevel = (level: number, on: boolean) =>
    set({
      levels: (on ? [...p.levels, level] : p.levels.filter((l) => l !== level)).sort(),
    });

  const missing = providers.filter((x) => x.transcripts === "missing").map((x) => x.label);
  const unknown = providers.filter((x) => x.transcripts === "unknown").map((x) => x.label);

  async function save() {
    setBusy(true);
    try {
      await setPanelAgent({ data: p });
      toast.success(
        p.enabled ? "Silent panel agent saved and switched on." : "Silent panel agent saved.",
      );
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["panel_agent"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <NotebookPen className="size-4" /> Silent panel agent
        </h2>
        <div className="flex items-center gap-2">
          <Label htmlFor="spa-enabled" className="text-xs text-muted-foreground">
            {p.enabled ? "On" : "Off"}
          </Label>
          <Switch
            id="spa-enabled"
            checked={p.enabled}
            disabled={!canEdit}
            onCheckedChange={(enabled) => set({ enabled })}
          />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        When on, the online interview rounds you choose are transcribed by your own meeting tool
        (Teams, Zoom or Google Meet), and the transcript is kept with the candidate. The candidate
        is told in their invite and can ask for it to be switched off; the hiring team records that
        on the Interviews page. In later steps the agent reads the transcript after the call, sends
        the panel a factual summary, and compares its own view with the panel's scorecards. It never
        speaks in the call and never decides — the panel and the HR head do.
      </p>
      {p.enabled && missing.length ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {missing.join(", ")} cannot read transcripts yet — disconnect and connect it again on the
          Integrations page so it asks for that permission (for Teams, your Microsoft admin must
          approve it).
        </p>
      ) : null}
      {p.enabled && unknown.length ? (
        <p className="text-xs text-muted-foreground">
          {unknown.join(", ")}: whether transcripts can be read shows after the first round.
          Transcription must be allowed on the meeting account&apos;s plan.
        </p>
      ) : null}
      {p.enabled && !providers.length ? (
        <p className="text-xs text-muted-foreground">
          No meeting provider is connected yet — connect Teams, Zoom or Google Meet on the
          Integrations page.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-xs text-muted-foreground">Rounds</span>
        {[1, 2, 3].map((level) => (
          <div key={level} className="flex items-center gap-1.5">
            <Checkbox
              id={`spa-l${level}`}
              disabled={!canEdit}
              checked={p.levels.includes(level)}
              onCheckedChange={(v) => toggleLevel(level, v === true)}
            />
            <Label htmlFor={`spa-l${level}`} className="text-sm">
              L{level}
            </Label>
          </div>
        ))}
      </div>
      {canEdit ? (
        <Button
          variant="outline"
          disabled={busy || !draft || !p.levels.length}
          onClick={() => void save()}
        >
          Save silent panel agent
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Only the HR head, the CBO or an owner can change this.
        </p>
      )}
    </section>
  );
}
