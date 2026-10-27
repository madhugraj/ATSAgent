import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { BookOpenText, Eye, Lock, Plus, Trash2 } from "lucide-react";

import {
  decideOrgProfileVersion,
  discardOrgProfileDraft,
  getOrgProfile,
  saveOrgProfileDraft,
  setOrgProfileRequired,
  startOrgProfileDraft,
  submitOrgProfileDraft,
  type OrgProfileVersionView,
} from "@/lib/org-profile.functions";
import {
  candidateVisible,
  diffSections,
  MAX_ITEM_CHARS,
  PROFILE_SECTIONS,
  STATUS_LABEL,
  type OrgProfileItem,
  type OrgProfileSections,
  type Refusal,
  type SectionDef,
} from "@/lib/org-profile";
import { PageHeader } from "@/components/ats";
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
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["org_profile"] });
    qc.invalidateQueries({ queryKey: ["org_profile_gate"] });
  };
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading profile…</p>;
  if (q.error || !q.data)
    return <p className="text-sm text-destructive">Could not load the organisation profile.</p>;
  const p = q.data;
  const open = p.open;

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Organisation profile"
        description="What your organisation does and how it hires. Once the HR head or an owner approves it, this is the context every hiring agent works from. Pay figures and staff names are never kept here."
      />

      <RequireCard required={p.requireProfile} canChange={p.canDecide} onChanged={refresh} />

      <section className="panel mt-4 flex flex-wrap items-center gap-2 p-3 text-sm">
        {p.approved ? (
          <span>
            Approved: <strong>version {p.approved.version}</strong>
            {p.approved.decidedBy ? ` by ${p.approved.decidedBy}` : ""},{" "}
            {when(p.approved.decidedAt)}
          </span>
        ) : (
          <span className="text-muted-foreground">
            No approved profile yet — agents are working without your organisation&apos;s context.
          </span>
        )}
        {open ? (
          <Badge variant="outline" className="ml-auto">
            Version {open.version}: {STATUS_LABEL[open.status] ?? open.status}
          </Badge>
        ) : p.canEdit ? (
          <Button
            size="sm"
            className="ml-auto"
            onClick={async () => {
              try {
                await startOrgProfileDraft();
                refresh();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Could not start a draft");
              }
            }}
          >
            {p.approved ? "Change the profile" : "Write the profile"}
          </Button>
        ) : null}
      </section>

      {open && (open.status === "draft" || open.status === "changes_requested") && p.canEdit ? (
        <DraftEditor
          key={`${open.id}:${open.updatedAt}`}
          draft={open}
          approved={p.approved}
          onChanged={refresh}
        />
      ) : open ? (
        <PendingReview
          version={open}
          approved={p.approved}
          canDecide={p.canDecide && open.status === "pending"}
          onChanged={refresh}
        />
      ) : p.approved ? (
        <ReadOnlyProfile sections={p.approved.sections} />
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          {p.canEdit
            ? "Start with About: what the organisation does, in two or three sentences."
            : "The HR head, the CBO or an owner writes the profile."}
        </p>
      )}

      {p.history.length ? (
        <section className="panel mt-4 p-4">
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
        </section>
      ) : null}
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
    <section className="panel mt-4 flex items-start gap-3 p-4">
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

function ReadOnlyProfile({ sections }: { sections: OrgProfileSections }) {
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

function DraftEditor({
  draft,
  approved,
  onChanged,
}: {
  draft: OrgProfileVersionView;
  approved: OrgProfileVersionView | null;
  onChanged: () => void;
}) {
  const [sections, setSections] = useState<OrgProfileSections>(draft.sections);
  const [refused, setRefused] = useState<Refusal[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => setSections(draft.sections), [draft.sections]);
  const refusedById = useMemo(() => new Map(refused.map((r) => [r.itemId, r.reason])), [refused]);

  const update = (key: string, items: OrgProfileItem[]) => {
    setSections((s) => ({ ...s, [key]: items }));
    setDirty(true);
  };

  async function save(): Promise<boolean> {
    const res = await saveOrgProfileDraft({
      data: {
        versionId: draft.id,
        sections: Object.fromEntries(
          Object.entries(sections).map(([k, items]) => [
            k,
            items.map(({ id, text, visibility }) => ({ id, text, visibility })),
          ]),
        ),
      },
    });
    if (!res.ok) {
      setRefused(res.refused);
      setProblems(res.problems);
      toast.error(
        res.refused.length
          ? `${res.refused.length} item(s) cannot be kept — see the reasons below. Nothing was saved.`
          : "Nothing was saved — see the problems below.",
      );
      return false;
    }
    setRefused([]);
    setProblems([]);
    setDirty(false);
    if (res.injectionFlagged)
      toast.warning("Some text reads like instructions to an AI; the approver will be warned.");
    return true;
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {draft.status === "changes_requested" && draft.decisionNote ? (
        <section className="panel mt-4 border-primary/40 p-3 text-sm">
          <strong>Sent back{draft.decidedBy ? ` by ${draft.decidedBy}` : ""}:</strong> “
          {draft.decisionNote}”
        </section>
      ) : null}
      {problems.length ? (
        <section className="panel mt-4 border-destructive/40 p-3 text-sm text-destructive">
          {problems.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </section>
      ) : null}

      <div className="mt-4 space-y-3">
        {PROFILE_SECTIONS.map((def) => {
          const items = sections[def.key] ?? [];
          return (
            <section key={def.key} className="panel space-y-2 p-4">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <BookOpenText className="size-4 text-muted-foreground" /> {def.title}
                  {def.internalOnly ? (
                    <Badge variant="secondary" className="gap-1">
                      <Lock className="size-3" /> Never shown to candidates
                    </Badge>
                  ) : null}
                </h2>
                <p className="text-xs text-muted-foreground">{def.hint}</p>
              </div>
              {items.map((item, n) => (
                <div key={item.id} className="space-y-1">
                  <div className="flex items-start gap-2">
                    <Textarea
                      rows={2}
                      maxLength={MAX_ITEM_CHARS}
                      value={item.text}
                      aria-label={`${def.title} item ${n + 1}`}
                      className={refusedById.has(item.id) ? "border-destructive" : ""}
                      onChange={(e) =>
                        update(
                          def.key,
                          items.map((i) => (i.id === item.id ? { ...i, text: e.target.value } : i)),
                        )
                      }
                    />
                    <div className="flex shrink-0 flex-col gap-1">
                      {def.internalOnly ? (
                        <Badge variant="secondary" className="gap-1">
                          <Lock className="size-3" /> Internal
                        </Badge>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          title="Who may hear or read this line"
                          onClick={() =>
                            update(
                              def.key,
                              items.map((i) =>
                                i.id === item.id
                                  ? {
                                      ...i,
                                      visibility:
                                        i.visibility === "candidate" ? "internal" : "candidate",
                                    }
                                  : i,
                              ),
                            )
                          }
                        >
                          {item.visibility === "candidate" ? (
                            <>
                              <Eye className="size-3" /> Candidates
                            </>
                          ) : (
                            <>
                              <Lock className="size-3" /> Internal
                            </>
                          )}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label="Remove this line"
                        onClick={() =>
                          update(
                            def.key,
                            items.filter((i) => i.id !== item.id),
                          )
                        }
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </div>
                  {refusedById.has(item.id) ? (
                    <p className="text-xs text-destructive">{refusedById.get(item.id)}</p>
                  ) : null}
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  update(def.key, [
                    ...items,
                    {
                      id: crypto.randomUUID(),
                      text: "",
                      visibility: def.defaultVisibility,
                      source: { kind: "person" },
                    },
                  ])
                }
              >
                <Plus className="size-3" /> Add a line
              </Button>
            </section>
          );
        })}
      </div>

      <DiffPanel approved={approved?.sections ?? null} sections={sections} />

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          disabled={busy || !dirty}
          onClick={() =>
            run(async () => {
              if (await save()) {
                toast.success("Draft saved");
                onChanged();
              }
            })
          }
        >
          Save draft
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (dirty && !(await save())) return;
              await submitOrgProfileDraft({ data: { versionId: draft.id } });
              toast.success("Sent to the HR head or an owner for approval");
              onChanged();
            })
          }
        >
          Submit for approval
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await discardOrgProfileDraft({ data: { versionId: draft.id } });
              toast.success("Draft discarded");
              onChanged();
            })
          }
        >
          Discard draft
        </Button>
      </div>
    </>
  );
}

function PendingReview({
  version,
  approved,
  canDecide,
  onChanged,
}: {
  version: OrgProfileVersionView;
  approved: OrgProfileVersionView | null;
  canDecide: boolean;
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
      <ReadOnlyProfile sections={version.sections} />
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
