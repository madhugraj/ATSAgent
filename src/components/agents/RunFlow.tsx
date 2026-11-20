import type React from "react";
import { Bot, CircleCheck, GitBranch, Hourglass } from "lucide-react";

import type { WorkflowGraph } from "@db/schema";

/**
 * A run drawn as its flow: the steps it took (done), the step it is on (waiting
 * on a person, working, or failed) and what comes next — up to the next
 * condition, shown with both of its ways out.
 */
export function RunFlow({
  run,
  graph,
  label,
}: {
  run: {
    status: string;
    currentNode: string | null;
    history: { node: string }[];
    waitingOn?: { kind: string } | null;
  };
  graph: WorkflowGraph;
  label?: (id: string) => string;
}) {
  label ??= (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n ? n.data.label || n.data.agentType || n.kind : id;
  };
  const visited: string[] = [];
  for (const h of run.history) if (h.node && !visited.includes(h.node)) visited.push(h.node);
  const current = run.status === "waiting" || run.status === "running" ? run.currentNode : null;
  const done = visited.filter((id) => id !== current);
  const outOf = (id: string) => graph.edges.filter((e) => e.source === id);
  const upcoming: string[] = [];
  let branches: { yes: string | undefined; no: string | undefined } | null = null;
  let at = current;
  for (let i = 0; at && i < 8; i++) {
    const node = graph.nodes.find((n) => n.id === at);
    const outs = outOf(at);
    if (node?.kind === "condition") {
      branches = {
        yes: outs.find((e) => e.branch === "yes")?.target,
        no: outs.find((e) => e.branch === "no")?.target,
      };
      break;
    }
    const next = outs[0]?.target;
    if (!next || visited.includes(next) || upcoming.includes(next)) break;
    upcoming.push(next);
    at = next;
  }
  const kindOf = (id: string) => graph.nodes.find((n) => n.id === id)?.kind;
  const chip = (id: string, state: "done" | "current" | "next") => {
    const k = kindOf(id);
    const tone =
      state === "done"
        ? "border-emerald-600/40 bg-emerald-600/10 text-foreground"
        : state === "current"
          ? run.waitingOn?.kind === "person" || run.waitingOn?.kind === "stopped"
            ? "border-amber-500 bg-amber-500/15 font-medium text-foreground ring-2 ring-amber-500/30"
            : "border-primary bg-primary/10 font-medium text-foreground ring-2 ring-primary/30"
          : "border-dashed text-muted-foreground";
    return (
      <span
        key={`${state}-${id}`}
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${tone}`}
      >
        {state === "done" ? (
          <CircleCheck className="size-3 text-emerald-600" />
        ) : state === "current" ? (
          <Hourglass className="size-3" />
        ) : null}
        {k === "agent" ? (
          <Bot className="size-3" />
        ) : k === "condition" ? (
          <GitBranch className="size-3" />
        ) : null}
        {label(id)}
      </span>
    );
  };
  const arrow = (k: string) => (
    <span key={k} className="text-muted-foreground">
      →
    </span>
  );
  const items: React.ReactNode[] = [];
  done.forEach((id, i) => {
    if (i) items.push(arrow(`a-d-${i}`));
    items.push(chip(id, "done"));
  });
  if (current) {
    if (items.length) items.push(arrow("a-c"));
    items.push(chip(current, "current"));
  }
  upcoming.forEach((id, i) => {
    items.push(arrow(`a-u-${i}`));
    items.push(chip(id, "next"));
  });
  if (branches) {
    items.push(arrow("a-b"));
    items.push(
      <span key="branches" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        yes {branches.yes ? chip(branches.yes, "next") : "—"} · no{" "}
        {branches.no ? chip(branches.no, "next") : "—"}
      </span>,
    );
  }
  return <div className="flex flex-wrap items-center gap-1.5 py-1">{items}</div>;
}
