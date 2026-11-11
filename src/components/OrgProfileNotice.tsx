import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BookOpenText } from "lucide-react";

import { getOrgProfileGate } from "@/lib/org-profile.functions";

/**
 * The soft gate (docs/org-context-agent-plan.md): while the organisation has
 * no approved profile, say so where roles are raised. When the organisation
 * requires one, say that raising a role will be refused.
 */
export function OrgProfileNotice() {
  const q = useQuery({
    queryKey: ["org_profile_gate"],
    queryFn: () => getOrgProfileGate(),
    staleTime: 60_000,
  });
  if (!q.data || q.data.approved) return null;
  return (
    <div
      role="status"
      className="panel mb-3 flex flex-wrap items-center gap-2 border-amber-500/40 p-3 text-sm"
    >
      <BookOpenText className="size-4 text-amber-600" />
      <span>
        {q.data.required
          ? "No approved organisation profile — your organisation requires one before a role is raised."
          : "No organisation profile — agents are working without your organisation's context."}
      </span>
      <Link to="/org-profile" className="ml-auto text-xs text-primary underline">
        Organisation profile
      </Link>
    </div>
  );
}
