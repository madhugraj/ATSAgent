import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Eye, Lock } from "lucide-react";

import { getOrgContextAdmin, resetOrgProfile } from "@/lib/org-context.functions";
import {
  decideOrgProfileVersion,
  getOrgProfile,
  setOrgProfileRequired,
  type OrgProfileVersionView,
} from "@/lib/org-profile.functions";
import {
  candidateVisible,
  diffSections,
  PROFILE_SECTIONS,
  STATUS_LABEL,
  type OrgProfileItem,
  type OrgProfileSections,
  type SectionDef,
} from "@/lib/org-profile";
import { PageHeader } from "@/components/ats";
import { OrgAgentWorkspace } from "@/components/OrgAgentWorkspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/org-profile")({
  head: () => ({
    meta: [
      { title: "Organisation profile — Talent Acquisition" },
      {
        name: "description",
        content:
          "What your organisation does, its domain, locations, culture, hiring norms and policies — approved by the HR head or owner, and the context every hiring agent works from.",
      },
    ],
  }),
  component: OrgProfilePage,
});

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");

function OrgProfilePage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["org_profile"], queryFn: () => getOrgProfile() });
  const qa = useQuery({
    queryKey: ["org_context_admin"],
    queryFn: () => getOrgContextAdmin(),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["org_profile"] });
    qc.invalidateQueries({ queryKey: ["org_profile_gate"] });
    qc.invalidateQueries({ queryKey: ["org_context_admin"] });
  };
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading profile…</p>;
  if (q.error || !q.data)
    return <p className="text-sm text-destructive">Could not load the organisation profile.</p>;
  const p = q.data;
  const open = p.open;
  const removedIds = new Set((qa.data?.sources ?? []).filter((s) => s.deleted).map((s) => s.id));

  const deleteProfile = async () => {
    const reason = window.prompt("Why are you deleting the profile? (kept in the audit trail)");
    if (!reason || reason.trim().length < 3) return;
    if (
      !window.confirm(
        "Delete the organisation profile — every draft and version, the saved website, its read pages, uploaded documents, and the agent's chat? You start from nothing.",
      )
    )
      return;
    try {
      await resetOrgProfile({ data: { reason: reason.trim() } });
      toast.success("Profile deleted — start again in the chat.");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the profile");
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Organisation profile"
        description="The context every hiring agent works from — written by the Organisation context agent from your website, your documents and what you tell it, and approved by the HR head or an owner."
      />

      {p.canEdit ? (
        <OrgAgentWorkspace onChanged={refresh} />
      ) : open ? (
        <PendingReview
          version={open}
          approved={p.approved}
          canDecide={p.canDecide && open.status === "pending"}
          removedSourceIds={removedIds}
          onChanged={refresh}
        />
      ) : p.approved ? (
        <ReadOnlyProfile sections={p.approved.sections} removedSourceIds={removedIds} />
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          No approved profile yet. The HR head, the CBO or an owner writes it with the Organisation
          context agent.
        </p>
      )}

      {/* Rarely touched: the rule, the history, the reset — out of the way. */}
      <details className="panel mt-4 p-3 text-sm">
        <summary className="cursor-pointer select-none font-medium text-muted-foreground">
          Profile settings and history
          {p.approved
            ? ` · approved version ${p.approved.version}${p.approved.decidedBy ? ` by ${p.approved.decidedBy}` : ""}, ${when(p.approved.decidedAt)}`
            : " · nothing approved yet"}
        </summary>
        <div className="mt-3 space-y-4">
          <RequireCard required={p.requireProfile} canChange={p.canDecide} onChanged={refresh} />
          {p.history.length ? (
            <div>
              <h2 className="text-sm font-semibold">Versions</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {p.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap gap-2">
                    <span className="num font-medium">v{h.version}</span>
                    <span>{STATUS_LABEL[h.status] ?? h.status}</span>
                    <span className="text-muted-foreground">
                      {h.decidedAt ? when(h.decidedAt) : when(h.createdAt)}
                    </span>
                    {h.decisionNote ? (
                      <span className="text-muted-foreground">— “{h.decisionNote}”</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {p.canDecide && (p.approved || open) ? (
            <div className="flex items-center gap-3 border-t border-border pt-3">
              <p className="flex-1 text-xs text-muted-foreground">
                Start from nothing: every version, the website, its pages, the documents and the
                agent&apos;s chat are deleted (the reason is kept in the audit trail).
              </p>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                onClick={() => void deleteProfile()}
              >
                Delete profile
              </Button>
            </div>
          ) : null}
        </div>
      </details>
    </>
  );
}

function RequireCard({
  required,
  canChange,
  onChanged,
}: {
  required: boolean;
  canChange: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="flex items-start gap-3">
      <Switch
        id="require-profile"
        checked={required}
        disabled={!canChange || busy}
        onCheckedChange={async (v) => {
          setBusy(true);
          try {
            await setOrgProfileRequired({ data: { required: v } });
            toast.success(
              v
                ? "No role can be raised until a profile is approved."
                : "Roles can be raised without an approved profile (with a warning).",
            );
            onChanged();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not save");
          } finally {
            setBusy(false);
          }
        }}
      />
      <div>
        <Label htmlFor="require-profile" className="text-sm font-medium">
          Require an approved profile before roles are raised
        </Label>
        <p className="text-xs text-muted-foreground">
          Off: roles can be raised, with a warning that agents lack your organisation&apos;s
          context. On: the hiring desk, the Requisition agent and the requisition page refuse until
          a profile is approved. {canChange ? "" : "Only the HR head or an owner can change this."}
        </p>
      </div>
    </section>
  );
}

function VisibilityBadge({ item, def }: { item: OrgProfileItem; def: SectionDef }) {
  return item.visibility === "candidate" && !def.internalOnly ? (
    <Badge variant="outline" className="gap-1">
      <Eye className="size-3" /> Candidates
    </Badge>
  ) : (
    <Badge variant="secondary" className="gap-1">
      <Lock className="size-3" /> Internal
    </Badge>
  );
}

function ReadOnlyProfile({
  sections,
  removedSourceIds,
}: {
  sections: OrgProfileSections;
  removedSourceIds?: Set<string>;
}) {
  return (
    <div className="mt-4 space-y-3">
      {PROFILE_SECTIONS.map((def) => {
        const items = sections[def.key] ?? [];
        if (!items.length) return null;
        return (
          <section key={def.key} className="panel p-4">
            <h2 className="text-sm font-semibold">{def.title}</h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              {items.map((i) => (
                <li key={i.id} className="flex items-start gap-2">
                  <VisibilityBadge item={i} def={def} />
                  <span className="whitespace-pre-wrap">{i.text}</span>
                  {i.source.ref && removedSourceIds?.has(i.source.ref) ? (
                    <Badge variant="outline" className="shrink-0 text-muted-foreground">
                      source removed
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function DiffPanel({
  approved,
  sections,
}: {
  approved: OrgProfileSections | null;
  sections: OrgProfileSections;
}) {
  const diff = diffSections(approved, sections);
  const visible = candidateVisible(sections);
  return (
    <section className="panel mt-4 space-y-3 p-4 text-sm">
      <div>
        <h2 className="font-semibold">
          {approved ? "Changes against the approved version" : "First version"}
        </h2>
        {approved && !diff.length ? (
          <p className="text-muted-foreground">No changes.</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {diff.map((d) => (
              <li key={d.section}>
                <p className="font-medium">{d.title}</p>
                <ul className="ml-4 list-disc text-xs">
                  {d.added.map((i) => (
                    <li key={`a${i.id}`} className="text-emerald-700 dark:text-emerald-400">
                      Added: {i.text}
                    </li>
                  ))}
                  {d.changed.map((c) => (
                    <li key={`c${c.after.id}`}>
                      Changed:{" "}
                      {c.before.text !== c.after.text ? (
                        <>
                          <span className="line-through text-muted-foreground">
                            {c.before.text}
                          </span>{" "}
                          → {c.after.text}
                        </>
                      ) : (
                        c.after.text
                      )}
                      {c.before.visibility !== c.after.visibility
                        ? ` (now ${c.after.visibility === "candidate" ? "visible to candidates" : "internal"})`
                        : ""}
                    </li>
                  ))}
                  {d.removed.map((i) => (
                    <li key={`r${i.id}`} className="text-destructive">
                      Removed: {i.text}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h2 className="font-semibold">Candidates may hear or read ({visible.length})</h2>
        {visible.length ? (
          <ul className="ml-4 mt-1 list-disc text-xs">
            {visible.map((v, n) => (
              <li key={n}>
                <span className="text-muted-foreground">{v.title}:</span> {v.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Nothing is marked for candidates.</p>
        )}
      </div>
    </section>
  );
}

function PendingReview({
  version,
  approved,
  canDecide,
  removedSourceIds,
  onChanged,
}: {
  version: OrgProfileVersionView;
  approved: OrgProfileVersionView | null;
  canDecide: boolean;
  removedSourceIds: Set<string>;
  onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function decide(decision: "approve" | "decline" | "send_back") {
    setBusy(true);
    try {
      await decideOrgProfileVersion({
        data: { versionId: version.id, decision, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      toast.success(
        decision === "approve"
          ? "Approved — agents now work from this profile."
          : decision === "send_back"
            ? "Sent back with your changes."
            : "Declined.",
      );
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the decision");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="panel mt-4 p-3 text-sm">
        {version.status === "pending" ? (
          <>
            Submitted{version.submittedBy ? ` by ${version.submittedBy}` : ""},{" "}
            {when(version.submittedAt)}.{" "}
            {canDecide
              ? "Read the changes and every line candidates may hear, then decide."
              : "Waiting for the HR head or an owner."}
          </>
        ) : (
          <>
            {STATUS_LABEL[version.status] ?? version.status}. The HR head, the CBO or an owner can
            change it.
          </>
        )}
        {version.injectionFlagged ? (
          <p className="mt-1 font-medium text-destructive">
            Some text reads like instructions to an AI — read it before approving.
          </p>
        ) : null}
      </section>
      <DiffPanel approved={approved?.sections ?? null} sections={version.sections} />
      <ReadOnlyProfile sections={version.sections} removedSourceIds={removedSourceIds} />
      {canDecide ? (
        <section className="panel mt-4 space-y-2 p-4">
          <Textarea
            rows={2}
            maxLength={2000}
            value={note}
            placeholder="What should change, or why you decline (required for both); optional when approving"
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => decide("approve")}>
              Approve
            </Button>
            <Button
              variant="outline"
              disabled={busy || note.trim().length < 3}
              onClick={() => decide("send_back")}
            >
              Send back for changes
            </Button>
            <Button
              variant="outline"
              disabled={busy || note.trim().length < 3}
              onClick={() => decide("decline")}
            >
              Decline
            </Button>
          </div>
        </section>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        Agent requests to approve a profile also appear in{" "}
        <Link to="/agents" className="underline">
          Waiting for you
        </Link>
        .
      </p>
    </>
  );
}
