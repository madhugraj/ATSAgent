/**
 * A role's hiring manager, picked from the organisation's registered members
 * (docs/interview-panel-plan.md, P1). The hiring manager approves the role's
 * interview panels.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getRoleHiringManager, setRoleHiringManager } from "@/lib/role-hiring-manager.functions";

export function HiringManagerPicker({ requisitionId }: { requisitionId: string }) {
  const qc = useQueryClient();
  const save = useServerFn(setRoleHiringManager);
  const q = useQuery({
    queryKey: ["role_hiring_manager", requisitionId],
    queryFn: () => getRoleHiringManager({ data: { requisitionId } }),
  });
  const [busy, setBusy] = useState(false);
  if (!q.data) return <p className="text-sm text-muted-foreground">—</p>;
  const { memberId, name, options } = q.data;

  async function pick(next: string) {
    if (next === memberId) return;
    setBusy(true);
    try {
      const r = await save({ data: { requisitionId, memberId: next } });
      toast.success(`${r.name} is now the hiring manager`);
      await qc.invalidateQueries({ queryKey: ["role_hiring_manager", requisitionId] });
      await qc.invalidateQueries({ queryKey: ["requisition", requisitionId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the hiring manager");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <Select value={memberId ?? ""} onValueChange={(v) => void pick(v)} disabled={busy}>
        <SelectTrigger className="h-8 text-sm" aria-label="Hiring manager">
          <SelectValue
            placeholder={name ? `${name} (not a registered member)` : "Choose a member"}
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.memberId} value={o.memberId}>
              {o.name}
              {o.manager ? "" : " · no manager role"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!memberId ? (
        <p className="text-xs text-muted-foreground">
          Pick a registered member — they approve this role&apos;s interview panels.
        </p>
      ) : null}
    </div>
  );
}
