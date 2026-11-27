/**
 * One side of a merge-review pair (design §1.5): the fields identity actually
 * compares, with the survivor pick built in. Layout language follows the
 * existing side-by-side comparison blocks.
 */
import { Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { MergeCandidateView } from "@/lib/candidates.identity.functions";

export function CandidateSide({
  side,
  survivor,
  onPickSurvivor,
}: {
  side: MergeCandidateView;
  survivor: boolean;
  onPickSurvivor?: (() => void) | undefined;
}) {
  const timeline = side.employmentHistory.slice(0, 5);
  return (
    <div
      className={
        "rounded-md border p-3 " + (survivor ? "border-primary bg-primary/5" : "border-border")
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{side.fullName}</span>
        {survivor ? (
          <Badge variant="default">
            <Check className="size-3" /> Survivor
          </Badge>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground num">
          {new Date(side.createdAt).toLocaleDateString()}
        </span>
      </div>
      <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        <div className="truncate">{side.email}</div>
        {side.phone ? <div className="num">{side.phone}</div> : null}
        {side.linkedinUrl ? <div className="truncate">{side.linkedinUrl}</div> : null}
        {side.currentEmployer ? <div>{side.currentEmployer}</div> : null}
        {side.location ? <div>{side.location}</div> : null}
        {side.education ? <div className="truncate">{side.education}</div> : null}
      </div>
      {timeline.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-xs">
          {timeline.map((h, i) => (
            <li key={i} className="text-muted-foreground">
              <span className="text-foreground">{h.company ?? h.employer}</span>
              {h.start ? <span className="num"> · {String(h.start)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <Badge variant="outline">{side.source}</Badge>
        {onPickSurvivor ? (
          <button
            type="button"
            onClick={onPickSurvivor}
            className="ml-auto text-xs font-medium underline-offset-2 hover:underline"
          >
            Merge into this one
          </button>
        ) : null}
      </div>
    </div>
  );
}
