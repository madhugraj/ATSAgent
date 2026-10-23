/**
 * "Where this role is advertised" on the requisition page: Google for Jobs,
 * the job feeds (Jooble, Adzuna, Jora) and the portals a person posts on by
 * hand, each with its state. Partner boards that post through an integration
 * keep their own panel (requisition-job-boards.tsx); posting them by hand is
 * here. Changes are the HR head's and are audited on the server.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";

import {
  addRoleToFeed,
  markRolePosted,
  roleDistribution,
  rolePostingPack,
  setRoleGoogleListing,
  takeRoleDown,
} from "@/lib/distribution.functions";
import { JOB_CHANNELS, ROUTE_LABEL, type ChannelRoute, type JobChannel } from "@/lib/job-channels";
import { useOrg } from "@/hooks/useOrg";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Status = Awaited<ReturnType<typeof roleDistribution>>;

const GROUPS: { route: ChannelRoute; hint: string }[] = [
  {
    route: "feed",
    hint: "Aggregators read your organisation's feed. Candidates apply on your apply page.",
  },
  {
    route: "partner_api",
    hint: "Until the partner integration is in place, post by hand with the prepared text.",
  },
  {
    route: "assisted",
    hint: "No integration exists. Post the prepared text yourself, then mark it posted.",
  },
];

function useCanPublish(): boolean {
  const { isOwner, roles } = useOrg();
  return isOwner || roles.includes("hr_head");
}

export function RoleDistributionSection({ requisitionId }: { requisitionId: string }) {
  const load = useServerFn(roleDistribution);
  const addFeed = useServerFn(addRoleToFeed);
  const remove = useServerFn(takeRoleDown);
  const setGoogle = useServerFn(setRoleGoogleListing);
  const qc = useQueryClient();
  const canPublish = useCanPublish();
  const [busy, setBusy] = useState<string | null>(null);
  const [pack, setPack] = useState<JobChannel | null>(null);

  const q = useQuery({
    queryKey: ["role_distribution", requisitionId],
    queryFn: () => load({ data: { requisitionId } }),
  });
  const d = q.data as Status | undefined;

  async function act(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await qc.invalidateQueries({ queryKey: ["role_distribution", requisitionId] });
      await qc.invalidateQueries({ queryKey: ["board_postings", requisitionId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  const postingOf = (id: string) => d?.postings.find((p) => p.provider === id);

  return (
    <section className="panel p-5" data-testid="role-distribution">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Where this role is advertised</h2>
          <p className="text-xs text-muted-foreground">
            {d && !d.approved
              ? "Available once the requisition is approved — only approved roles may be advertised outside the organisation."
              : "Every link is tagged with where it was shared, so applicants are counted against the right channel."}
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <a href="/distribution">Job distribution</a>
        </Button>
      </div>

      {q.isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking where this role is live…
        </div>
      ) : q.isError || !d ? (
        <p className="mt-4 text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load this role's channels."}
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          <div
            className="rounded-xl border border-border bg-card p-4"
            data-testid="channel-google_jobs"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Google for Jobs</p>
                <p className="text-xs text-muted-foreground">
                  {!d.google.orgEnabled
                    ? "Off for your organisation — switch it on in Job distribution."
                    : d.google.excluded
                      ? "Excluded: this role is not listed on Google."
                      : !d.approved
                        ? "Listed once the role is approved."
                        : d.google.gaps.length
                          ? `Not listed yet: ${d.google.gaps.join(" ")}`
                          : d.google.indexingConfigured
                            ? noticeLine(d.google.lastNotice)
                            : "Listed from the apply page; Google picks it up on its next visit."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={d.google.listed ? "default" : "secondary"}>
                  {d.google.listed ? "Listed" : "Not listed"}
                </Badge>
                {canPublish && d.google.orgEnabled ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      act(
                        "google",
                        () => setGoogle({ data: { requisitionId, listed: d.google.excluded } }),
                        d.google.excluded
                          ? "This role will be listed on Google"
                          : "Excluded from Google",
                      )
                    }
                  >
                    {busy === "google" ? <Loader2 className="size-4 animate-spin" /> : null}
                    {d.google.excluded ? "List on Google" : "Exclude"}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          {GROUPS.map((g) => (
            <div key={g.route}>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {ROUTE_LABEL[g.route]}
              </p>
              <p className="mb-2 text-xs text-muted-foreground">{g.hint}</p>
              <ul className="grid gap-2">
                {JOB_CHANNELS.filter((c) => c.route === g.route).map((c) => {
                  const p = postingOf(c.id);
                  const live = p?.status === "published";
                  // Planned by the Distribution agent; posted in the person's browser.
                  const waiting = p?.status === "pending";
                  return (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                      data-testid={`channel-${c.id}`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {c.name}{" "}
                          <span className="text-xs font-normal text-muted-foreground">
                            · {c.region}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {live
                            ? `${p.viaIntegration ? "Live through the integration" : c.route === "feed" ? "On your feed" : "Posted"} since ${new Date(p.publishedAt ?? Date.now()).toLocaleDateString()}`
                            : waiting
                              ? `Waiting to be posted — open ${c.name} signed in, and the ATSIQ browser extension fills the form and records it.`
                              : c.applications}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {live && p.url && c.route !== "feed" ? (
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            Listing <ExternalLink className="size-3" />
                          </a>
                        ) : null}
                        {live ? <Badge>Live</Badge> : null}
                        {waiting ? <Badge variant="secondary">Waiting</Badge> : null}
                        {c.route === "feed" ? (
                          canPublish ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy !== null || (!live && (!d.approved || d.forClient))}
                              title={
                                d.forClient
                                  ? `${c.name} accepts only roles your organisation hires for itself.`
                                  : undefined
                              }
                              onClick={() =>
                                act(
                                  c.id,
                                  () =>
                                    live
                                      ? remove({ data: { requisitionId, channel: c.id } })
                                      : addFeed({ data: { requisitionId, channel: c.id } }),
                                  live
                                    ? `Taken off the ${c.name} feed`
                                    : `Added to the ${c.name} feed`,
                                )
                              }
                            >
                              {busy === c.id ? <Loader2 className="size-4 animate-spin" /> : null}
                              {live ? "Take off feed" : "Add to feed"}
                            </Button>
                          ) : null
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy !== null || p?.viaIntegration === true}
                            onClick={() => setPack(c)}
                          >
                            {live ? "Manage" : "Post by hand"}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {g.route === "feed" && !d.feedReady ? (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  Your feed links are not created yet — the HR head creates them in Job distribution
                  and gives them to each aggregator once.
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {pack && d ? (
        <PostingPackDialog
          requisitionId={requisitionId}
          channel={pack}
          live={postingOf(pack.id)?.status === "published"}
          approved={d.approved}
          canPublish={canPublish}
          onClose={() => setPack(null)}
          onChanged={async () => {
            await qc.invalidateQueries({ queryKey: ["role_distribution", requisitionId] });
            await qc.invalidateQueries({ queryKey: ["board_postings", requisitionId] });
          }}
        />
      ) : null}
    </section>
  );
}

function noticeLine(n: Status["google"]["lastNotice"]): string {
  if (!n) return "Listed from the apply page; Google is told shortly.";
  if (n.status === "sent")
    return `Google was told ${n.kind === "URL_DELETED" ? "it closed" : "it is live"} on ${new Date(n.sentAt ?? Date.now()).toLocaleString()}.`;
  if (n.status === "failed") return `Google could not be told: ${n.lastError ?? "unknown error"}.`;
  return "Listed from the apply page; Google is told within the day's quota.";
}

function PostingPackDialog({
  requisitionId,
  channel,
  live,
  approved,
  canPublish,
  onClose,
  onChanged,
}: {
  requisitionId: string;
  channel: JobChannel;
  live: boolean;
  approved: boolean;
  canPublish: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const loadPack = useServerFn(rolePostingPack);
  const mark = useServerFn(markRolePosted);
  const remove = useServerFn(takeRoleDown);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const q = useQuery({
    queryKey: ["posting_pack", requisitionId, channel.id],
    queryFn: () => loadPack({ data: { requisitionId, channel: channel.id } }),
  });
  const p = q.data;

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      await onChanged();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Post on {channel.name}</DialogTitle>
          <DialogDescription>{channel.cost}</DialogDescription>
        </DialogHeader>
        {q.isLoading || !p ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Preparing the text…
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <ol className="list-decimal space-y-1 pl-5">
              {p.channel.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {p.channel.caution ? (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                {p.channel.caution}
              </p>
            ) : null}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <Label htmlFor="pack-text">Text to paste</Label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(p.text);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />} Copy
                </Button>
              </div>
              <Textarea
                id="pack-text"
                readOnly
                rows={10}
                value={p.text}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                E-mail addresses, phone numbers and links are taken out — portals refuse or strip
                them.{" "}
                {p.applyUrl
                  ? `The apply link is tagged for ${channel.name}.`
                  : `${channel.name} keeps applications on its own site; add the people you take forward with source ${channel.name}.`}
              </p>
            </div>
            {p.channel.portalUrl ? (
              <a
                href={p.channel.portalUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Open {channel.name} <ExternalLink className="size-3.5" />
              </a>
            ) : null}
            {canPublish && !live ? (
              <div className="space-y-1">
                <Label htmlFor="listing-url">Link to the listing (optional)</Label>
                <Input
                  id="listing-url"
                  placeholder="https://…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {!canPublish ? (
            <p className="mr-auto text-xs text-muted-foreground">
              The HR head records where a role is posted.
            </p>
          ) : live ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(
                  () => remove({ data: { requisitionId, channel: channel.id } }),
                  `Recorded as taken down on ${channel.name}`,
                )
              }
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null} It is taken down
            </Button>
          ) : (
            <Button
              disabled={busy || !approved || !p}
              onClick={() =>
                run(
                  () =>
                    mark({ data: { requisitionId, channel: channel.id, url: url.trim() || null } }),
                  `Recorded as posted on ${channel.name}`,
                )
              }
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null} I have posted it
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
