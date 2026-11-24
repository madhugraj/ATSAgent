import { ArrowRight, CornerDownRight } from "lucide-react";

import type { FlowActor, ManualFlow } from "@/lib/user-manual";
import { cn } from "@/lib/utils";

const ACTOR: Record<FlowActor, { label: string; box: string; dot: string }> = {
  person: { label: "Person", box: "border-primary/40 bg-primary/5", dot: "bg-primary" },
  agent: {
    label: "Agent",
    box: "border-emerald-500/40 bg-emerald-500/5",
    dot: "bg-emerald-500",
  },
  system: {
    label: "System",
    box: "border-border bg-muted/40",
    dot: "bg-muted-foreground",
  },
  candidate: {
    label: "Candidate",
    box: "border-amber-500/40 bg-amber-500/5",
    dot: "bg-amber-500",
  },
};

/** A manual flow drawn as numbered boxes joined by arrows, coloured by who acts. */
export function ManualFlowDiagram({ flow }: { flow: ManualFlow }) {
  const actors = [...new Set(flow.steps.map((s) => s.by))];
  return (
    <figure className="space-y-3 rounded-md border bg-background/60 p-4">
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-book text-sm font-medium">{flow.title}</span>
        <span className="flex flex-wrap gap-3">
          {actors.map((a) => (
            <span key={a} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("size-2 rounded-full", ACTOR[a].dot)} />
              {ACTOR[a].label}
            </span>
          ))}
        </span>
      </figcaption>
      <ol className="flex flex-wrap items-stretch gap-y-2">
        {flow.steps.map((step, i) => (
          <li key={i} className="flex items-center">
            <div
              className={cn(
                "flex h-full max-w-40 items-start gap-1.5 rounded-md border px-2.5 py-2 text-xs leading-snug",
                ACTOR[step.by].box,
              )}
            >
              <span className="tabular-nums text-muted-foreground">{i + 1}</span>
              <span>{step.label}</span>
            </div>
            {i < flow.steps.length - 1 && (
              <ArrowRight className="mx-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
          </li>
        ))}
      </ol>
      {flow.outcomes?.length ? (
        <ul className="space-y-1">
          {flow.outcomes.map((o) => (
            <li key={o} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CornerDownRight className="size-3.5 shrink-0" aria-hidden />
              {o}
            </li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}
