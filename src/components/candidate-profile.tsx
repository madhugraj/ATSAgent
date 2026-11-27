/**
 * The consolidated profile (A2, design §2.3–2.4): every CV version, the claims
 * all accepted versions make with their evidence strength and source passage,
 * and the consistency flags. Flags are information for the recruiter only.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, FileText } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  acceptCvVersionFn,
  getCandidateProfileFn,
  requeueClaimsFn,
} from "@/lib/candidates.profile.functions";
import type { ProfileClaim, ProfileFlag } from "@/server/candidates/versions.server";

const TYPE_LABEL: Record<ProfileClaim["type"], string> = {
  role: "Roles",
  project: "Projects",
  skill: "Skills",
  cert: "Certifications",
  achievement: "Achievements",
};
const TYPE_ORDER: ProfileClaim["type"][] = ["role", "project", "skill", "achievement", "cert"];

const STRENGTH_TONE: Record<ProfileClaim["strength"], string> = {
  demonstrated: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  listed: "border-border bg-muted text-foreground",
  inferred: "border-dashed border-border text-muted-foreground",
};

function flagText(f: ProfileFlag): string {
  switch (f.kind) {
    case "date_conflict":
      return `Dates differ at ${f.employer}: ${f.detail.join(" / ")}`;
    case "title_conflict":
      return `Titles differ at ${f.employer} (${f.detail[0]}): ${f.detail.slice(1).join(" / ")}`;
    case "employer_overlap":
      return `Overlapping employers: ${f.detail.join(" and ")}`;
    case "single_source":
      return `Only in the CV sent for this role: ${f.values.join(", ")}`;
    case "jd_mirroring":
      return `CV wording copies the job description (${Math.round(f.overlap * 100)}%)`;
  }
}

export function CandidateProfileSection({
  candidateId,
  requisitionId,
}: {
  candidateId: string;
  requisitionId?: string | null;
}) {
  const qc = useQueryClient();
  const getProfile = useServerFn(getCandidateProfileFn);
  const accept = useServerFn(acceptCvVersionFn);
  const requeue = useServerFn(requeueClaimsFn);
  const key = ["candidate_profile", candidateId, requisitionId ?? null];
  const profile = useQuery({
    queryKey: key,
    queryFn: () => getProfile({ data: { candidateId, requisitionId: requisitionId || null } }),
    refetchInterval: (q) =>
      q.state.data?.versions.some(
        (v) => v.extractionStatus === "pending" || v.extractionStatus === "running",
      )
        ? 10_000
        : false,
  });
  const acceptM = useMutation({
    mutationFn: (versionId: string) => accept({ data: { versionId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not accept"),
  });
  const requeueM = useMutation({
    mutationFn: () => requeue({ data: { candidateId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not queue"),
  });
  const [open, setOpen] = useState<string | null>(null);

  const data = profile.data;
  if (!data || data.versions.length === 0) return null;
  const canExtract = data.versions.some(
    (v) => v.accepted && (v.extractionStatus === "skipped" || v.extractionStatus === "failed"),
  );
  const byType = TYPE_ORDER.map((t) => ({
    type: t,
    claims: data.claims.filter((c) => c.type === t),
  })).filter((g) => g.claims.length);

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Profile</h2>
        {canExtract ? (
          <Button
            size="sm"
            variant="outline"
            disabled={requeueM.isPending}
            onClick={() => requeueM.mutate()}
          >
            Extract evidence
          </Button>
        ) : null}
      </div>

      {data.flags.length ? (
        <ul className="mt-3 space-y-1">
          {data.flags.map((f, i) => (
            <li
              key={i}
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              {flagText(f)}
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="mt-3 space-y-1 text-sm">
        {data.versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-2">
            <FileText className="size-3.5 text-muted-foreground" />
            <span className="truncate">{v.fileName ?? v.source}</span>
            <span className="num text-xs text-muted-foreground">
              {new Date(v.submittedAt).toLocaleDateString()}
            </span>
            <Badge variant="outline" className="text-[10px]">
              {v.source}
            </Badge>
            {v.accepted ? (
              v.extractionStatus === "done" ? (
                <span className="num text-xs text-muted-foreground">{v.claimCount}</span>
              ) : (
                <Badge variant="secondary" className="text-[10px]">
                  {v.extractionStatus}
                </Badge>
              )
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                disabled={acceptM.isPending}
                onClick={() => acceptM.mutate(v.id)}
              >
                Accept into profile
              </Button>
            )}
          </li>
        ))}
      </ul>

      {byType.map((g) => (
        <div key={g.type} className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {TYPE_LABEL[g.type]}
          </h3>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {g.claims.map((c) => (
              <button
                key={c.claimId}
                type="button"
                onClick={() => setOpen(open === c.claimId ? null : c.claimId)}
                className={`rounded-md border px-2 py-0.5 text-xs ${STRENGTH_TONE[c.strength]} ${
                  c.singleSource ? "ring-1 ring-amber-500/60" : ""
                }`}
                title={c.strength}
              >
                {c.value}
                {c.type === "role" && (c.start || c.end) ? (
                  <span className="num ml-1 opacity-70">
                    {c.start ?? "?"}–{c.end ?? "?"}
                  </span>
                ) : null}
                {c.versionIds.length > 1 ? (
                  <span className="num ml-1 opacity-70">×{c.versionIds.length}</span>
                ) : null}
              </button>
            ))}
          </div>
          {g.claims
            .filter((c) => c.claimId === open)
            .map((c) => (
              <blockquote
                key={c.claimId}
                className="mt-2 border-l-2 border-primary/50 pl-3 text-xs text-muted-foreground"
              >
                “{c.passage}”
                <span className="ml-2 not-italic">
                  — {data.versions.find((v) => v.id === c.passageVersionId)?.fileName ?? "CV"} ·{" "}
                  {c.strength}
                </span>
              </blockquote>
            ))}
        </div>
      ))}
    </section>
  );
}
