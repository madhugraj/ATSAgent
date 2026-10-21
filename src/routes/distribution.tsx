import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, ExternalLink, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  channelSourceReport,
  distributionOverview,
  jobFeedLinks,
  rotateJobFeedLinks,
  setGoogleJobsEnabled,
} from "@/lib/distribution.functions";
import { JOB_CHANNELS, ROUTE_LABEL, sourceLabel, type FeedFormat } from "@/lib/job-channels";
import { useOrg } from "@/hooks/useOrg";

export const Route = createFileRoute("/distribution")({
  head: () => ({ meta: [{ title: "Job distribution — ATSIQ" }] }),
  component: Distribution,
});

function Distribution() {
  const { isOwner, roles } = useOrg();
  const canManage = isOwner || roles.includes("hr_head");
  return (
    <>
      <PageHeader
        eyebrow="Sourcing"
        title="Job distribution"
        description="Where your approved roles are advertised, and which channels bring the people you hire. Each role's own channels are on its requisition page."
      />
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <GoogleCard canManage={canManage} />
        <FeedsCard canManage={canManage} />
      </div>
      <SourceReport />
      <ChannelCatalogue />
    </>
  );
}

function GoogleCard({ canManage }: { canManage: boolean }) {
  const load = useServerFn(distributionOverview);
  const save = useServerFn(setGoogleJobsEnabled);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["distribution_overview"], queryFn: () => load() });
  const d = q.data;

  return (
    <section className="panel p-5" data-testid="google-jobs-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Google for Jobs</h2>
          <p className="text-xs text-muted-foreground">
            Lists every approved role from its apply page, free. Exclude a role on its requisition
            page.
          </p>
        </div>
        {d ? (
          <Switch
            aria-label="List approved roles on Google for Jobs"
            checked={d.googleJobsEnabled}
            disabled={!canManage || busy}
            onCheckedChange={async (enabled) => {
              setBusy(true);
              try {
                await save({ data: { enabled } });
                toast.success(
                  enabled
                    ? "Approved roles will be listed on Google"
                    : "Google listing switched off",
                );
                await qc.invalidateQueries({ queryKey: ["distribution_overview"] });
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Could not change that.");
              } finally {
                setBusy(false);
              }
            }}
          />
        ) : null}
      </div>
      {q.isLoading || !d ? (
        <Loader2 className="mt-4 size-4 animate-spin text-muted-foreground" />
      ) : (
        <ul className="mt-4 space-y-1.5 text-sm">
          <li>
            {d.countryKnown
              ? `Country for remote roles: ${d.country}.`
              : "Set your HQ country in Organisation settings — remote roles need it to be listed."}
          </li>
          <li>
            {d.indexingConfigured
              ? `Google is told when a role opens or closes: ${d.notices.sent} told, ${d.notices.pending} waiting${d.notices.failed ? `, ${d.notices.failed} failed` : ""} in the last 30 days.`
              : "Google finds listed roles on its own visits. Your ATSIQ administrator can connect Google's Indexing API so it is told the same day."}
          </li>
          {!canManage ? (
            <li className="text-xs text-muted-foreground">The HR head switches this on or off.</li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

const FEED_ORDER: FeedFormat[] = ["jooble", "adzuna", "jora"];

function FeedsCard({ canManage }: { canManage: boolean }) {
  const loadOverview = useServerFn(distributionOverview);
  const loadLinks = useServerFn(jobFeedLinks);
  const rotate = useServerFn(rotateJobFeedLinks);
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ["distribution_overview"], queryFn: () => loadOverview() });
  const [urls, setUrls] = useState<Record<FeedFormat, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const created = overview.data?.feedCreated ?? false;

  async function show() {
    setBusy(true);
    try {
      const res = await loadLinks();
      setUrls(res?.urls ?? null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the links.");
    } finally {
      setBusy(false);
    }
  }

  async function replace() {
    if (
      created &&
      !window.confirm(
        "Replace the feed links? The current links stop working at once — give the new ones to every aggregator.",
      )
    )
      return;
    setBusy(true);
    try {
      const res = await rotate();
      setUrls(res.urls);
      toast.success(created ? "Feed links replaced" : "Feed links created");
      await qc.invalidateQueries({ queryKey: ["distribution_overview"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the links.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel p-5" data-testid="job-feeds-card">
      <h2 className="font-semibold">Job feeds</h2>
      <p className="text-xs text-muted-foreground">
        One feed per aggregator. A role appears on a feed only after it is added on its requisition
        page, and leaves it when the role closes. Roles hired for a client are never listed.
      </p>
      {!canManage ? (
        <p className="mt-4 text-sm text-muted-foreground">The HR head manages the feed links.</p>
      ) : urls ? (
        <ul className="mt-4 space-y-3 text-sm">
          {FEED_ORDER.map((f) => {
            const channel = JOB_CHANNELS.find((c) => c.id === f)!;
            return (
              <li key={f}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{channel.name}</span>
                  {channel.portalUrl ? (
                    <a
                      href={channel.portalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      How to register <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted/40 px-2 py-1 text-xs">
                    {urls[f]}
                  </code>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Copy the ${channel.name} feed link`}
                    onClick={() => {
                      void navigator.clipboard.writeText(urls[f]);
                      toast.success("Link copied");
                    }}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
                {channel.caution ? (
                  <p className="mt-1 text-xs text-muted-foreground">{channel.caution}</p>
                ) : null}
              </li>
            );
          })}
          <li>
            <Button size="sm" variant="outline" disabled={busy} onClick={replace}>
              Replace links
            </Button>
          </li>
        </ul>
      ) : (
        <div className="mt-4 flex gap-2">
          {created ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={show}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null} Show feed links
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={replace}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null} Create feed links
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function pct(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : "—";
}

function SourceReport() {
  const load = useServerFn(channelSourceReport);
  const [days, setDays] = useState(90);
  const q = useQuery({
    queryKey: ["channel_report", days],
    queryFn: () => load({ data: { days } }),
  });
  const rows = q.data ?? [];

  return (
    <section className="panel mt-4" data-testid="source-report">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div>
          <h2 className="font-semibold">Which channels bring the people you hire</h2>
          <p className="text-xs text-muted-foreground">
            Applicants by where they came from, and how far they got. Counted from tracked apply
            links, feeds, the careers inbox and uploads tagged with their source.
          </p>
        </div>
        <select
          aria-label="Period"
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {[30, 90, 180, 365].map((n) => (
            <option key={n} value={n}>
              Last {n} days
            </option>
          ))}
        </select>
      </div>
      {q.isLoading ? (
        <Loader2 className="m-4 size-4 animate-spin text-muted-foreground" />
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No applicants in this period yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 text-right font-medium">Live roles</th>
                <th className="px-4 py-2 text-right font-medium">Applicants</th>
                <th className="px-4 py-2 text-right font-medium">Shortlisted</th>
                <th className="px-4 py-2 text-right font-medium">Interviewed</th>
                <th className="px-4 py-2 text-right font-medium">Offered</th>
                <th className="px-4 py-2 text-right font-medium">Hired</th>
              </tr>
            </thead>
            <tbody className="num">
              {rows.map((r) => (
                <tr key={r.source} className="border-t border-border">
                  <td className="px-4 py-2">{sourceLabel(r.source)}</td>
                  <td className="px-4 py-2 text-right">{r.liveRoles}</td>
                  <td className="px-4 py-2 text-right font-semibold">{r.applicants}</td>
                  <td className="px-4 py-2 text-right">
                    {r.shortlisted}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({pct(r.shortlisted, r.applicants)})
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">{r.interviewed}</td>
                  <td className="px-4 py-2 text-right">{r.offered}</td>
                  <td className="px-4 py-2 text-right">{r.hired}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ChannelCatalogue() {
  return (
    <section className="panel mt-4" data-testid="channel-catalogue">
      <div className="border-b border-border p-4">
        <h2 className="font-semibold">Channels and how each one works</h2>
        <p className="text-xs text-muted-foreground">
          Checked against each portal's own employer, partner and developer pages on 21 October
          2026. No channel is read by automated logins or scraping — every portal's terms forbid it.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Channel</th>
              <th className="px-4 py-2 font-medium">How it works</th>
              <th className="px-4 py-2 font-medium">Applications come back</th>
              <th className="px-4 py-2 font-medium">Cost or approval</th>
            </tr>
          </thead>
          <tbody>
            {JOB_CHANNELS.map((c) => (
              <tr key={c.id} className="border-t border-border align-top">
                <td className="px-4 py-2">
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.region}</p>
                </td>
                <td className="px-4 py-2">
                  <Badge variant="secondary">{ROUTE_LABEL[c.route]}</Badge>
                  {c.caution ? (
                    <p className="mt-1 text-xs text-muted-foreground">{c.caution}</p>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-xs">{c.applications}</td>
                <td className="px-4 py-2 text-xs">{c.cost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
