import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  BookOpenText,
  Eye,
  FileText,
  Globe,
  Lock,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import {
  acceptOrgSource,
  deleteOrgDocument,
  getOrgContextAdmin,
  readOrgWebsiteNow,
  resetOrgProfile,
  setOrgWebsite,
  startOrgContextBuild,
  uploadOrgDocument,
} from "@/lib/org-context.functions";
import {
  decideOrgProfileVersion,
  getOrgProfile,
  setOrgProfileRequired,
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
import { OrgDeskChat } from "@/components/OrgDeskChat";
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

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Organisation profile"
        description="What your organisation does and how it hires — built with the Organisation context agent from your answers, your website and your documents, then approved by the HR head or an owner. This approved profile is the context every hiring agent works from. Pay figures and staff names are never kept here."
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
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {open ? (
            <Badge variant="outline">
              Version {open.version}: {STATUS_LABEL[open.status] ?? open.status}
            </Badge>
          ) : null}
          {p.canDecide && (p.approved || open) ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              title="Delete every version and start from nothing (the reason is kept in the audit trail)"
              onClick={async () => {
                const reason = window.prompt(
                  "Why are you deleting the profile? (kept in the audit trail)",
                );
                if (!reason || reason.trim().length < 3) return;
                if (
                  !window.confirm(
                    "Delete the organisation profile — every draft and version, the saved website, its read pages, uploaded documents, and the agent's chat? You start from nothing.",
                  )
                )
                  return;
                try {
                  await resetOrgProfile({ data: { reason: reason.trim() } });
                  toast.success(
                    "Profile deleted — build it again from the chat or with Build with the agent.",
                  );
                  refresh();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Could not delete the profile");
                }
              }}
            >
              Delete profile
            </Button>
          ) : null}
        </div>
      </section>

      {p.canEdit ? <SourcesCard onChanged={refresh} /> : null}

      {p.canEdit ? (
        <OrgDeskChat onProfileChanged={refresh} />
      ) : open ? (
        <PendingReview
          version={open}
          approved={p.approved}
          canDecide={p.canDecide && open.status === "pending"}
          removedSourceIds={removedIds}
          onChanged={refresh}
        />
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          The HR head, the CBO or an owner writes the profile with the Organisation context agent.
        </p>
      )}

      {p.canEdit && open && open.status !== "pending" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          A draft (version {open.version}) is being built in the chat above; it appears here for
          approval once submitted.
        </p>
      ) : null}
      {p.approved ? (
        <ReadOnlyProfile sections={p.approved.sections} removedSourceIds={removedIds} />
      ) : null}

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

type ContextAdmin = Awaited<ReturnType<typeof getOrgContextAdmin>>;

/** Base64 for a file up to a few MB, without blowing the call stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The agent's sources: the organisation's website and its uploaded documents. */
function SourcesCard({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient();
  const qa = useQuery({ queryKey: ["org_context_admin"], queryFn: () => getOrgContextAdmin() });
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "read" | "upload">("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["org_context_admin"] });
    onChanged();
  };
  const run = async (kind: typeof busy, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy("");
    }
  };
  const data = qa.data;
  // The input carries the saved website; Save arms only on a change.
  useEffect(() => {
    if (data?.website && !url) setUrl(data.website.url);
  }, [data?.website, url]);
  const saved = data?.website?.url ?? null;
  const dirty = url.trim() !== "" && url.trim() !== (saved ?? "");
  const flagged = (data?.sources ?? []).filter((s) => s.injectionFlagged && !s.deleted);
  const documents = (data?.sources ?? []).filter((s) => s.kind === "document" && !s.deleted);
  const pages = (data?.sources ?? []).filter((s) => s.kind === "website_page" && !s.deleted);
  const pathOf = (u: string) => {
    try {
      return new URL(u).pathname === "/" ? new URL(u).hostname : new URL(u).pathname;
    } catch {
      return u;
    }
  };

  const save = () =>
    run("save", async () => {
      const first = await setOrgWebsite({ data: { url: url.trim() } });
      const res = first.ok
        ? first
        : await setOrgWebsite({ data: { url: url.trim(), confirm: true } });
      if (res.ok) {
        toast.success(
          saved && saved !== url.trim()
            ? "Website updated."
            : res === first
              ? "Website saved."
              : "Website saved with an owner's confirmation.",
        );
        refresh();
      } else {
        toast.error("Only an owner can confirm a website outside the registered e-mail domain.");
      }
    });

  return (
    <section className="panel mt-4 space-y-4 p-4 text-sm">
      <h2 className="flex items-center gap-2 font-semibold">
        <Globe className="size-4 text-muted-foreground" /> Sources the agent reads
      </h2>

      {flagged.length ? (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
          <p className="flex items-center gap-1.5 font-medium">
            <TriangleAlert className="size-4 text-amber-600" /> {flagged.length} source(s) look like
            instructions to an AI and nothing was kept from them.
          </p>
          {flagged.map((f) => (
            <div key={f.id} className="mt-1 flex items-center justify-between gap-2">
              <span className="break-all text-xs text-muted-foreground">{f.url ?? f.fileName}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== ""}
                onClick={() =>
                  run("save", async () => {
                    await acceptOrgSource({ data: { sourceId: f.id } });
                    toast.success("Accepted — the source was read into the draft.");
                    refresh();
                  })
                }
              >
                I have read it — accept it
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-6 md:min-w-0 md:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="org-website" className="text-sm font-medium">
            Your website
          </Label>
          <div className="flex gap-2">
            <input
              id="org-website"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              placeholder="https://www.your-company.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button size="sm" variant="outline" disabled={busy !== "" || !dirty} onClick={save}>
              Save
            </Button>
          </div>
          <p className="break-words text-xs text-muted-foreground">
            The agent reads only this host — it should match your registered e-mail domain; a
            different address needs an owner&apos;s confirmation.
          </p>

          {saved ? (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span
                  className={`inline-block size-2 rounded-full ${
                    data?.website?.lastRereadStatus === "failed" ? "bg-red-500" : "bg-emerald-500"
                  }`}
                />
                <span className="font-medium">{saved.replace(/^https?:\/\//, "")}</span>
                {data?.website?.confirmedAt ? (
                  <Badge variant="outline">owner-confirmed</Badge>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {pages.length
                  ? `${pages.length} page${pages.length === 1 ? "" : "s"} read`
                  : "Not read yet"}
                {data?.website?.lastRereadAt ? ` · last ${when(data.website.lastRereadAt)}` : ""}
                {data?.website?.nextRereadAt
                  ? ` · re-reads monthly (next ${when(data.website.nextRereadAt)})`
                  : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  disabled={busy !== ""}
                  onClick={() =>
                    run("read", async () => {
                      const r = await readOrgWebsiteNow({ data: {} });
                      toast.success(
                        `Read ${r.pagesFetched} page(s): ${r.pagesChanged} changed, ${r.pagesUnchanged} unchanged${
                          r.flagged.length ? `, ${r.flagged.length} held back for review` : ""
                        }. ${r.itemsKept} item(s) proposed into the draft.`,
                      );
                      refresh();
                    })
                  }
                >
                  <RefreshCw className="size-3.5" /> Read it now
                </Button>
              </div>
              {pages.length ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    Pages read ({pages.length})
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {pages.map((p) => (
                      <li key={p.id} className="truncate">
                        <a
                          href={p.url ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted-foreground underline decoration-dotted hover:text-foreground"
                        >
                          {pathOf(p.url ?? "")}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="min-w-0 space-y-2">
          <Label className="text-sm font-medium">Documents</Label>
          <p className="break-words text-xs text-muted-foreground">
            PDF or DOCX up to 10 MB — handbooks, policies, brochures; anything that states what the
            organisation does. Scanned pages are read through the AI model.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              void run("upload", async () => {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const r = await uploadOrgDocument({
                  data: { fileName: file.name, dataBase64: bytesToBase64(bytes) },
                });
                toast.success(
                  `${file.name}: ${r.pages} page(s)${r.ocr ? " (read through the AI model)" : ""}, ${r.itemsKept} item(s) proposed into the draft.`,
                );
                refresh();
              });
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            disabled={busy !== ""}
            onClick={() => fileRef.current?.click()}
          >
            <FileText className="size-3.5" /> Upload a document
          </Button>
          {documents.length ? (
            <ul className="space-y-1">
              {documents.map((d) => (
                <li key={d.id} className="flex items-center gap-2 text-xs">
                  <FileText className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate" title={d.fileName ?? ""}>
                    {d.fileName}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {d.ocr ? "· scanned" : ""} {d.bytes ? `· ${Math.round(d.bytes / 1024)} kB` : ""}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${d.fileName}`}
                    className="ml-auto"
                    disabled={busy !== ""}
                    onClick={() =>
                      run("save", async () => {
                        await deleteOrgDocument({ data: { sourceId: d.id } });
                        toast.success(
                          "Document removed — lines from it are marked until the next approval.",
                        );
                        refresh();
                      })
                    }
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {data && !data.agentEnabled ? (
        <p className="text-xs text-muted-foreground">
          The Organisation context agent is switched off — switch it on in Governance → Agent
          settings so it can build the profile from these sources.
        </p>
      ) : null}
    </section>
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
