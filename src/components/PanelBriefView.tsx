/**
 * A panellist's brief for one round: profile, the round's focus and rubric,
 * match and screening (members only) and the CV. Shared by My interviews and
 * the private scorecard link so the two show the same thing.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { PanelBrief } from "@/lib/panel-brief";

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function PanelBriefView({ brief }: { brief: PanelBrief }) {
  const [cvOpen, setCvOpen] = useState(false);
  const p = brief.profile;
  const profile = [p.employer, p.years != null ? `${p.years} years` : null, p.location]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Row label="Profile" value={profile} />
        <Row label="Education" value={p.education} />
        <Row label="Skills" value={p.skills.join(", ")} />
        <Row label="Match" value={brief.match} />
        <Row label="Screening" value={brief.screening} />
      </div>
      {brief.roundFocus || brief.competencies.length ? (
        <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            L{brief.level}
            {brief.roundName ? ` · ${brief.roundName}` : ""}
          </p>
          {brief.roundFocus ? <p className="text-sm">{brief.roundFocus}</p> : null}
          {brief.competencies.length ? (
            <div className="flex flex-wrap gap-1.5">
              {brief.competencies.map((c) => (
                <span key={c} className="rounded-full border border-border px-2 py-0.5 text-xs">
                  {c}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {brief.cv ? (
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-sm font-medium"
            onClick={() => setCvOpen((o) => !o)}
            aria-expanded={cvOpen}
          >
            {cvOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            CV
          </button>
          {cvOpen ? (
            <pre className="mt-2 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-3 font-sans text-[0.8125rem] leading-relaxed">
              {brief.cv}
            </pre>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No CV on file.</p>
      )}
    </div>
  );
}
