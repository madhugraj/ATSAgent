/**
 * Job distribution — advertising an approved role beyond the partner boards:
 *  - Google for Jobs: structured data on the role's apply page, switched on
 *    per organisation (a person can exclude a role), with Google told through
 *    the Indexing API when a role is listed or taken down;
 *  - job feeds (Jooble, Adzuna, Jora): the organisation's public feed lists
 *    the roles a person put on it;
 *  - posting by hand: a copy-ready pack with a tracked apply link, then the
 *    person marks where it went live.
 *
 * Every channel's state for a role is one requisition_board_postings row
 * (provider = channel id), next to the partner boards'. Client input only
 * ever names a requisition and a channel; approval state, the client-hire
 * rule, the feed token and the audit trail are resolved here.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, ne, sql } from "drizzle-orm";

import {
  jobDescriptions,
  jobIndexNotifications,
  orgJobDistribution,
  organizations,
  requisitionBoardPostings,
  requisitions,
} from "@db/schema";
import { channelById, trackedApplyUrl, type FeedFormat, type JobChannel } from "@/lib/job-channels";
import { db } from "../db";
import { env } from "../env";
import { writeAudit } from "../audit";
import { decryptSecret, encryptSecret } from "../crypto";
import { assertRequisitionInOrg } from "../guards";
import {
  places,
  plainText,
  stripContactDetails,
  adzunaFeed,
  countryCode,
  describeJob,
  joobleFeed,
  joraFeed,
  jobPostingJsonLd,
  listingGaps,
  packText,
  type DistributableJob,
  type FeedJob,
} from "./content";
import { indexingConfigured, queueIndexNotification } from "./google-indexing.server";

/** A member, or (userId null) the organisation's paired browser extension. */
export type DistributionActor = { memberEmail: string; userId: string | null };

const GOOGLE = "google_jobs";
const site = () => env.PUBLIC_SITE_URL.replace(/\/$/, "");

/* ---------------------------------------------------------------- loading */

async function settingsOf(orgId: string) {
  const [row] = await db
    .select()
    .from(orgJobDistribution)
    .where(eq(orgJobDistribution.orgId, orgId))
    .limit(1);
  return row ?? null;
}

async function postingOf(orgId: string, requisitionId: string, provider: string) {
  const [row] = await db
    .select()
    .from(requisitionBoardPostings)
    .where(
      and(
        eq(requisitionBoardPostings.orgId, orgId),
        eq(requisitionBoardPostings.requisitionId, requisitionId),
        eq(requisitionBoardPostings.provider, provider),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Everything a candidate may see about a role, whatever its status. */
export async function loadJob(
  orgId: string,
  requisitionId: string,
  channel?: string,
): Promise<(DistributableJob & { status: string }) | null> {
  const [r] = await db
    .select({
      id: requisitions.id,
      code: requisitions.code,
      title: requisitions.title,
      status: requisitions.status,
      location: requisitions.location,
      workMode: requisitions.workMode,
      openings: requisitions.openings,
      experienceMin: requisitions.experienceMin,
      experienceMax: requisitions.experienceMax,
      mustHave: requisitions.mustHaveSkills,
      goodToHave: requisitions.goodToHaveSkills,
      responsibilities: requisitions.responsibilities,
      clientName: requisitions.clientName,
      openedAt: requisitions.openedAt,
      company: organizations.name,
      hqCountry: organizations.hqCountry,
    })
    .from(requisitions)
    .innerJoin(organizations, eq(organizations.id, requisitions.orgId))
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!r) return null;
  const [jd] = await db
    .select({ fullText: jobDescriptions.fullText })
    .from(jobDescriptions)
    .where(
      and(
        eq(jobDescriptions.requisitionId, requisitionId),
        eq(jobDescriptions.orgId, orgId),
        eq(jobDescriptions.status, "approved"),
      ),
    )
    .orderBy(desc(jobDescriptions.version))
    .limit(1);
  const posting = channel ? await postingOf(orgId, requisitionId, channel) : null;
  const country = countryCode(r.hqCountry);
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    status: r.status,
    location: r.location,
    workMode: r.workMode ?? null,
    openings: r.openings,
    experienceMin: r.experienceMin,
    experienceMax: r.experienceMax,
    mustHave: r.mustHave ?? [],
    goodToHave: r.goodToHave ?? [],
    description: describeJob({
      jdText: jd?.fullText ?? null,
      responsibilities: r.responsibilities,
      mustHave: r.mustHave ?? [],
      goodToHave: r.goodToHave ?? [],
    }),
    company: r.company,
    country,
    countryName: r.hqCountry?.trim() || null,
    postedAt: posting?.publishedAt ?? r.openedAt,
    forClient: Boolean(r.clientName?.trim()),
  };
}

/**
 * What the public apply page shows, and its Google for Jobs structured data
 * when the organisation lists roles on Google and nobody excluded this one.
 * Null for anything but an approved role in an active organisation.
 */
export async function publicListing(
  requisitionId: string,
): Promise<{ job: DistributableJob; jsonLd: Record<string, unknown> | null } | null> {
  const [r] = await db
    .select({ orgId: requisitions.orgId, orgStatus: organizations.status })
    .from(requisitions)
    .innerJoin(organizations, eq(organizations.id, requisitions.orgId))
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.status, "approved")))
    .limit(1);
  if (!r?.orgId || r.orgStatus !== "active") return null;
  const job = await loadJob(r.orgId, requisitionId, GOOGLE);
  if (!job) return null;
  const settings = await settingsOf(r.orgId);
  const posting = await postingOf(r.orgId, requisitionId, GOOGLE);
  const listed = Boolean(settings?.googleJobsEnabled) && posting?.status !== "withdrawn";
  return { job, jsonLd: listed ? jobPostingJsonLd(job) : null };
}

/* ------------------------------------------------------------- postings */

async function upsertPosting(
  orgId: string,
  requisitionId: string,
  provider: string,
  values: {
    status: string;
    actor?: DistributionActor | null;
    externalUrl?: string | null;
    payload?: Record<string, unknown>;
    relist?: boolean;
  },
): Promise<void> {
  const now = new Date();
  const published = values.status === "published";
  const existing = await postingOf(orgId, requisitionId, provider);
  const set = {
    status: values.status,
    updatedAt: now,
    lastError: null,
    ...(values.externalUrl !== undefined ? { externalUrl: values.externalUrl } : {}),
    ...(values.payload ? { payload: values.payload } : {}),
    ...(published
      ? {
          closedAt: null,
          publishedBy: values.actor?.userId ?? existing?.publishedBy ?? null,
          publishedAt:
            existing?.publishedAt && existing.status === "published" && !values.relist
              ? existing.publishedAt
              : now,
        }
      : values.status === "pending"
        ? {}
        : { closedAt: now }),
  };
  if (existing) {
    await db
      .update(requisitionBoardPostings)
      .set({ ...set, attempts: existing.attempts + (published ? 1 : 0) })
      .where(eq(requisitionBoardPostings.id, existing.id));
  } else {
    await db
      .insert(requisitionBoardPostings)
      .values({ orgId, requisitionId, provider, attempts: published ? 1 : 0, ...set });
  }
}

async function approvedRole(orgId: string, requisitionId: string) {
  await assertRequisitionInOrg(requisitionId, orgId);
  const job = await loadJob(orgId, requisitionId);
  if (!job) throw new Error("Requisition not found.");
  if (job.status !== "approved")
    throw new Error("Only an approved requisition can be advertised outside the organisation.");
  return job;
}

function channelOrThrow(id: string, routes: JobChannel["route"][]): JobChannel {
  const channel = channelById(id);
  if (!channel || !routes.includes(channel.route)) throw new Error("Unknown channel.");
  return channel;
}

/* ----------------------------------------------------------- Google for Jobs */

/** Switch Google for Jobs on or off for the organisation (audited). */
export async function setGoogleJobs(
  orgId: string,
  actor: DistributionActor,
  enabled: boolean,
): Promise<void> {
  await db
    .insert(orgJobDistribution)
    .values({ orgId, googleJobsEnabled: enabled, updatedBy: actor.userId })
    .onConflictDoUpdate({
      target: orgJobDistribution.orgId,
      set: { googleJobsEnabled: enabled, updatedBy: actor.userId, updatedAt: new Date() },
    });
  await writeAudit({
    actor: actor.memberEmail,
    orgId,
    actorUserId: actor.userId,
    action: "distribution.google_jobs.set",
    entityType: "organization",
    entityId: orgId,
    detail: { enabled },
  });
  await reconcileGoogleListings(orgId);
}

/** Exclude one role from Google for Jobs, or list it again (audited). */
export async function setRoleOnGoogle(
  orgId: string,
  actor: DistributionActor,
  requisitionId: string,
  listed: boolean,
): Promise<void> {
  await assertRequisitionInOrg(requisitionId, orgId);
  const existing = await postingOf(orgId, requisitionId, GOOGLE);
  if (listed) {
    if (existing?.status === "withdrawn")
      await upsertPosting(orgId, requisitionId, GOOGLE, { status: "closed", actor });
  } else {
    await upsertPosting(orgId, requisitionId, GOOGLE, { status: "withdrawn", actor });
    if (existing?.status === "published")
      await queueIndexNotification({
        orgId,
        requisitionId,
        url: trackedApplyUrl(site(), requisitionId),
        kind: "URL_DELETED",
      });
  }
  await writeAudit({
    actor: actor.memberEmail,
    orgId,
    actorUserId: actor.userId,
    action: listed ? "distribution.google_jobs.include" : "distribution.google_jobs.exclude",
    entityType: "requisition",
    entityId: requisitionId,
  });
  if (listed) await reconcileGoogleListings(orgId);
}

/**
 * Bring every role's Google for Jobs state in line with the rules — listed
 * when the organisation is on Google, active, the role approved, not excluded
 * and complete enough for Google; taken down otherwise — and queue the
 * Indexing API notification for each change. Run by the scheduler, and right
 * after a person changes a setting.
 */
export async function reconcileGoogleListings(
  orgId?: string,
): Promise<{ listed: number; unlisted: number }> {
  const shouldList = sql`(d.google_jobs_enabled and r.status = 'approved' and o.status = 'active')`;
  const rows = (await db.execute(sql`
    select r.id, r.org_id, p.status pstatus, ${shouldList} as should
    from requisitions r
    join organizations o on o.id = r.org_id
    left join org_job_distribution d on d.org_id = r.org_id
    left join requisition_board_postings p
      on p.requisition_id = r.id and p.provider = ${GOOGLE} and p.org_id = r.org_id
    where ${orgId ? sql`r.org_id = ${orgId} and` : sql``}
      ((${shouldList} and (p.id is null or p.status = 'closed'))
        or (p.status = 'published' and not coalesce(${shouldList}, false)))
    limit 100`)) as unknown as {
    id: string;
    org_id: string;
    pstatus: string | null;
    should: boolean;
  }[];
  let listed = 0;
  let unlisted = 0;
  for (const row of rows) {
    const url = trackedApplyUrl(site(), row.id);
    if (row.should) {
      const job = await loadJob(row.org_id, row.id);
      if (!job || listingGaps(job).length) continue;
      await upsertPosting(row.org_id, row.id, GOOGLE, {
        status: "published",
        externalUrl: url,
        payload: { route: "structured_data" },
        relist: true,
      });
      await queueIndexNotification({
        orgId: row.org_id,
        requisitionId: row.id,
        url,
        kind: "URL_UPDATED",
      });
      listed++;
    } else {
      await upsertPosting(row.org_id, row.id, GOOGLE, { status: "closed" });
      await queueIndexNotification({
        orgId: row.org_id,
        requisitionId: row.id,
        url,
        kind: "URL_DELETED",
      });
      unlisted++;
    }
  }
  return { listed, unlisted };
}

/* ----------------------------------------------------------------- feeds */

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function feedUrls(token: string): Record<FeedFormat, string> {
  return {
    jooble: `${site()}/api/public/feeds/${token}/jooble`,
    adzuna: `${site()}/api/public/feeds/${token}/adzuna`,
    jora: `${site()}/api/public/feeds/${token}/jora`,
  };
}

/** The organisation's feed links, or null before the first one is created. */
export async function feedLinks(orgId: string): Promise<{
  urls: Record<FeedFormat, string>;
  rotatedAt: string | null;
} | null> {
  const s = await settingsOf(orgId);
  if (!s?.feedToken) return null;
  return {
    urls: feedUrls(decryptSecret(s.feedToken)),
    rotatedAt: s.feedRotatedAt?.toISOString() ?? null,
  };
}

/**
 * Create the feed links, or replace them: the old links stop working at once,
 * so every aggregator must be given the new ones (audited).
 */
export async function rotateFeedToken(
  orgId: string,
  actor: DistributionActor,
): Promise<Record<FeedFormat, string>> {
  const token = randomBytes(24).toString("hex");
  const now = new Date();
  const values = {
    feedToken: encryptSecret(token),
    feedTokenHash: hashToken(token),
    feedRotatedAt: now,
    updatedBy: actor.userId,
    updatedAt: now,
  };
  const had = await settingsOf(orgId);
  await db
    .insert(orgJobDistribution)
    .values({ orgId, ...values })
    .onConflictDoUpdate({ target: orgJobDistribution.orgId, set: values });
  await writeAudit({
    actor: actor.memberEmail,
    orgId,
    actorUserId: actor.userId,
    action: had?.feedToken ? "distribution.feed.rotate" : "distribution.feed.create",
    entityType: "organization",
    entityId: orgId,
  });
  return feedUrls(token);
}

/** The XML for one organisation's feed in one aggregator's format; null = no such feed. */
export async function feedXml(token: string, format: string): Promise<string | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const channel = channelById(format);
  if (!channel?.feedFormat) return null;
  const [s] = await db
    .select({
      orgId: orgJobDistribution.orgId,
      orgName: organizations.name,
      orgStatus: organizations.status,
    })
    .from(orgJobDistribution)
    .innerJoin(organizations, eq(organizations.id, orgJobDistribution.orgId))
    .where(eq(orgJobDistribution.feedTokenHash, hashToken(token)))
    .limit(1);
  if (!s || s.orgStatus !== "active") return null;
  const rows = await db
    .select({ requisitionId: requisitionBoardPostings.requisitionId })
    .from(requisitionBoardPostings)
    .innerJoin(requisitions, eq(requisitions.id, requisitionBoardPostings.requisitionId))
    .where(
      and(
        eq(requisitionBoardPostings.orgId, s.orgId),
        eq(requisitions.orgId, s.orgId),
        eq(requisitionBoardPostings.provider, channel.id),
        eq(requisitionBoardPostings.status, "published"),
        eq(requisitions.status, "approved"),
      ),
    )
    .orderBy(requisitionBoardPostings.publishedAt)
    .limit(1000);
  const jobs: FeedJob[] = [];
  for (const row of rows) {
    const job = await loadJob(s.orgId, row.requisitionId, channel.id);
    // Aggregators accept only roles the organisation hires for itself.
    if (!job || job.forClient) continue;
    jobs.push({ ...job, applyUrl: trackedApplyUrl(site(), job.id, channel.id) });
  }
  switch (channel.feedFormat) {
    case "jooble":
      return joobleFeed(jobs);
    case "adzuna":
      return adzunaFeed(jobs);
    case "jora":
      return joraFeed(jobs, { name: s.orgName, url: site() });
  }
}

/* ------------------------------------------------- feeds and hand posting */

const httpUrl = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/** Put a role on one aggregator's feed (audited). */
export async function addToFeed(
  orgId: string,
  actor: DistributionActor,
  requisitionId: string,
  channelId: string,
): Promise<void> {
  const channel = channelOrThrow(channelId, ["feed"]);
  const job = await approvedRole(orgId, requisitionId);
  if (job.forClient)
    throw new Error(
      `${channel.name} accepts only roles your organisation hires for itself, not roles hired for a client.`,
    );
  await upsertPosting(orgId, requisitionId, channel.id, {
    status: "published",
    actor,
    externalUrl: trackedApplyUrl(site(), requisitionId, channel.id),
    payload: { route: "feed" },
  });
  await writeAudit({
    actor: actor.memberEmail,
    orgId,
    actorUserId: actor.userId,
    action: "board.posting.publish",
    entityType: "requisition",
    entityId: requisitionId,
    detail: { provider: channel.id, route: "feed" },
  });
}

/** Record that a person posted the role on a portal by hand (audited). */
export async function markPosted(
  orgId: string,
  actor: DistributionActor,
  requisitionId: string,
  channelId: string,
  listingUrl: string | null,
  via: "page" | "browser_extension" = "page",
): Promise<void> {
  const channel = channelOrThrow(channelId, ["assisted", "partner_api"]);
  await approvedRole(orgId, requisitionId);
  const url = listingUrl?.trim() || null;
  if (url && (url.length > 500 || !httpUrl(url)))
    throw new Error("The listing link must be a web address starting with https://.");
  if (via === "browser_extension" && (!url || !onPortal(channel.id, url)))
    throw new Error(`Record it from the ${channel.name} listing page itself.`);
  const existing = await postingOf(orgId, requisitionId, channel.id);
  if (existing?.status === "published" && existing.externalId)
    throw new Error(`This role is already live on ${channel.name} through the integration.`);
  await upsertPosting(orgId, requisitionId, channel.id, {
    status: "published",
    actor,
    externalUrl: url,
    payload: { route: "manual" },
  });
  await writeAudit({
    actor: actor.memberEmail,
    orgId,
    actorUserId: actor.userId,
    action: "board.posting.publish",
    entityType: "requisition",
    entityId: requisitionId,
    detail: { provider: channel.id, route: "manual", url, via },
  });
}

/** Whether a listing link is on the portal's own site (the paired browser must not record elsewhere). */
export function onPortal(channelId: string, listingUrl: string): boolean {
  const channel = channelById(channelId);
  try {
    const host = new URL(listingUrl).hostname.toLowerCase();
    return (channel?.senderDomains ?? []).some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * The Distribution agent plans a role for portals a person posts on: each
 * becomes "waiting to be posted" until the person posts it (the ATSIQ browser
 * extension fills the portal's form and records it). Live postings are left
 * alone. Audited.
 */
export async function planHandPosting(
  orgId: string,
  actor: DistributionActor,
  requisitionId: string,
  channelIds: string[],
): Promise<{ planned: string[]; alreadyLive: string[] }> {
  const job = await approvedRole(orgId, requisitionId);
  const planned: string[] = [];
  const alreadyLive: string[] = [];
  for (const id of [...new Set(channelIds)]) {
    const channel = channelOrThrow(id, ["assisted", "partner_api"]);
    const existing = await postingOf(orgId, requisitionId, channel.id);
    if (existing?.status === "published") {
      alreadyLive.push(channel.name);
      continue;
    }
    if (existing?.status !== "pending")
      await upsertPosting(orgId, requisitionId, channel.id, {
        status: "pending",
        actor,
        payload: { route: "manual", planned: true },
      });
    planned.push(channel.name);
  }
  if (planned.length)
    await writeAudit({
      actor: actor.memberEmail,
      orgId,
      actorUserId: actor.userId,
      action: "distribution.hand_posting.planned",
      entityType: "requisition",
      entityId: requisitionId,
      detail: { channels: planned, role: job.code },
    });
  return { planned, alreadyLive };
}

/** Roles to post (or posted) on one portal, with the text for its form — for the browser extension. */
export async function handPostingQueue(orgId: string, channelId: string) {
  const channel = channelOrThrow(channelId, ["assisted", "partner_api"]);
  const rows = await db
    .select({
      requisitionId: requisitionBoardPostings.requisitionId,
      status: requisitionBoardPostings.status,
      url: requisitionBoardPostings.externalUrl,
      publishedAt: requisitionBoardPostings.publishedAt,
    })
    .from(requisitionBoardPostings)
    .innerJoin(requisitions, eq(requisitions.id, requisitionBoardPostings.requisitionId))
    .where(
      and(
        eq(requisitionBoardPostings.orgId, orgId),
        eq(requisitions.orgId, orgId),
        eq(requisitionBoardPostings.provider, channel.id),
        eq(requisitions.status, "approved"),
        sql`${requisitionBoardPostings.status} in ('pending', 'published')`,
      ),
    )
    .orderBy(requisitionBoardPostings.updatedAt)
    .limit(50);
  const out = [];
  for (const r of rows) {
    const job = await loadJob(orgId, r.requisitionId, channel.id);
    if (!job) continue;
    const applyUrl =
      channel.externalLink === "no" ? null : trackedApplyUrl(site(), job.id, channel.id);
    out.push({
      requisitionId: job.id,
      code: job.code,
      title: job.title,
      status: r.status === "published" ? "posted" : "waiting",
      listingUrl: r.url,
      postedAt: r.publishedAt?.toISOString() ?? null,
      fields: {
        title: job.title,
        location: places(job.location).join(", ") || null,
        workMode: job.workMode,
        openings: job.openings,
        experienceMin: job.experienceMin,
        experienceMax: job.experienceMax,
        skills: [...job.mustHave, ...job.goodToHave],
        description: stripContactDetails(plainText(job.description)),
        applyUrl,
      },
      text: packText(job, applyUrl),
    });
  }
  return {
    channel: { id: channel.id, name: channel.name, steps: channel.steps ?? [] },
    roles: out,
  };
}

/**
 * Take a role off a feed, or record that it was taken down on a portal
 * (audited). Integration postings close through the board's own route.
 */
export async function takeDown(
  orgId: string,
  actor: DistributionActor,
  requisitionId: string,
  channelId: string,
): Promise<void> {
  const channel = channelOrThrow(channelId, ["feed", "assisted", "partner_api"]);
  await assertRequisitionInOrg(requisitionId, orgId);
  const existing = await postingOf(orgId, requisitionId, channel.id);
  if (!existing || existing.status !== "published")
    throw new Error(`This role is not live on ${channel.name}.`);
  if (channel.route === "partner_api" && existing.externalId) {
    if (!actor.userId) throw new Error("A member closes integration postings.");
    const { closeBoardPostingImpl } = await import("../boards/publish.server");
    await closeBoardPostingImpl({
      orgId,
      actor: { memberEmail: actor.memberEmail, userId: actor.userId },
      requisitionId,
      provider: channel.id as "linkedin" | "indeed" | "naukri",
      reason: "closed",
    });
    return;
  }
  await upsertPosting(orgId, requisitionId, channel.id, { status: "closed", actor });
  await writeAudit({
    actor: actor.memberEmail,
    orgId,
    actorUserId: actor.userId,
    action: "board.posting.close",
    entityType: "requisition",
    entityId: requisitionId,
    detail: { provider: channel.id, route: channel.route === "feed" ? "feed" : "manual" },
  });
}

/** The copy and steps for posting a role on a portal by hand. */
export async function postingPack(orgId: string, requisitionId: string, channelId: string) {
  const channel = channelOrThrow(channelId, ["assisted", "partner_api"]);
  await assertRequisitionInOrg(requisitionId, orgId);
  const job = await loadJob(orgId, requisitionId, channel.id);
  if (!job) throw new Error("Requisition not found.");
  const applyUrl =
    channel.externalLink === "no" ? null : trackedApplyUrl(site(), job.id, channel.id);
  return {
    channel: {
      id: channel.id,
      name: channel.name,
      portalUrl: channel.portalUrl,
      steps: channel.steps ?? [],
      caution: channel.caution ?? null,
      applications: channel.applications,
      externalLink: channel.externalLink,
    },
    approved: job.status === "approved",
    applyUrl,
    text: packText(job, applyUrl),
  };
}

/* ---------------------------------------------------------------- status */

export async function distributionStatus(orgId: string, requisitionId: string) {
  await assertRequisitionInOrg(requisitionId, orgId);
  const job = await loadJob(orgId, requisitionId);
  if (!job) throw new Error("Requisition not found.");
  const settings = await settingsOf(orgId);
  const postings = await db
    .select({
      provider: requisitionBoardPostings.provider,
      status: requisitionBoardPostings.status,
      externalId: requisitionBoardPostings.externalId,
      externalUrl: requisitionBoardPostings.externalUrl,
      publishedAt: requisitionBoardPostings.publishedAt,
      payload: requisitionBoardPostings.payload,
    })
    .from(requisitionBoardPostings)
    .where(
      and(
        eq(requisitionBoardPostings.orgId, orgId),
        eq(requisitionBoardPostings.requisitionId, requisitionId),
      ),
    );
  const [lastNotice] = await db
    .select({
      kind: jobIndexNotifications.kind,
      status: jobIndexNotifications.status,
      sentAt: jobIndexNotifications.sentAt,
      lastError: jobIndexNotifications.lastError,
    })
    .from(jobIndexNotifications)
    .where(
      and(
        eq(jobIndexNotifications.orgId, orgId),
        eq(jobIndexNotifications.requisitionId, requisitionId),
        ne(jobIndexNotifications.status, "expired"),
      ),
    )
    .orderBy(desc(jobIndexNotifications.createdAt))
    .limit(1);
  const google = postings.find((p) => p.provider === GOOGLE);
  const approved = job.status === "approved";
  const gaps = listingGaps(job);
  return {
    approved,
    forClient: job.forClient,
    applyUrl: trackedApplyUrl(site(), requisitionId),
    google: {
      orgEnabled: Boolean(settings?.googleJobsEnabled),
      excluded: google?.status === "withdrawn",
      listed:
        Boolean(settings?.googleJobsEnabled) &&
        approved &&
        google?.status !== "withdrawn" &&
        !gaps.length,
      gaps,
      indexingConfigured: indexingConfigured(),
      lastNotice: lastNotice
        ? {
            kind: lastNotice.kind,
            status: lastNotice.status,
            sentAt: lastNotice.sentAt?.toISOString() ?? null,
            lastError: lastNotice.lastError,
          }
        : null,
    },
    feedReady: Boolean(settings?.feedToken),
    postings: postings
      .filter((p) => p.provider !== GOOGLE)
      .map((p) => ({
        provider: p.provider,
        status: p.status,
        viaIntegration: Boolean(p.externalId),
        url: p.externalUrl,
        publishedAt: p.publishedAt?.toISOString() ?? null,
      })),
  };
}

/* ----------------------------------------------------------------- report */

const REACHED = {
  shortlisted: [
    "shortlisted",
    "l1",
    "l2",
    "l3",
    "offer",
    "offer_pending",
    "offer_released",
    "offer_accepted",
    "offer_declined",
    "hired",
    "joined",
    "no_show",
    "joining_deferred",
  ],
  interviewed: [
    "l1",
    "l2",
    "l3",
    "offer",
    "offer_pending",
    "offer_released",
    "offer_accepted",
    "offer_declined",
    "hired",
    "joined",
    "no_show",
    "joining_deferred",
  ],
  offered: [
    "offer_released",
    "offer_accepted",
    "offer_declined",
    "hired",
    "joined",
    "no_show",
    "joining_deferred",
  ],
  hired: ["hired", "joined"],
} as const;

function reached(stages: readonly string[]) {
  const list = sql.join(
    stages.map((s) => sql`${s}`),
    sql`, `,
  );
  return sql`(a.stage::text in (${list}) or exists (
    select 1 from stage_events e where e.application_id = a.id and e.to_stage::text in (${list})))`;
}

export type ChannelReportRow = {
  source: string;
  applicants: number;
  shortlisted: number;
  interviewed: number;
  offered: number;
  hired: number;
  liveRoles: number;
};

/** Applicants and how far they got, per source, over the last `days` days. */
export async function channelReport(orgId: string, days: number): Promise<ChannelReportRow[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = (await db.execute(sql`
    select a.source,
      count(*)::int applicants,
      count(*) filter (where ${reached(REACHED.shortlisted)})::int shortlisted,
      count(*) filter (where ${reached(REACHED.interviewed)})::int interviewed,
      count(*) filter (where ${reached(REACHED.offered)})::int offered,
      count(*) filter (where ${reached(REACHED.hired)})::int hired
    from applications a
    where a.org_id = ${orgId} and a.applied_at >= ${since.toISOString()}::timestamptz
    group by a.source`)) as unknown as Omit<ChannelReportRow, "liveRoles">[];
  const live = (await db.execute(sql`
    select p.provider source, count(*)::int n
    from requisition_board_postings p
    join requisitions r on r.id = p.requisition_id and r.org_id = p.org_id
    where p.org_id = ${orgId} and p.status = 'published' and r.status = 'approved'
    group by p.provider`)) as unknown as { source: string; n: number }[];
  const out = new Map<string, ChannelReportRow>();
  for (const r of rows) out.set(r.source, { ...r, liveRoles: 0 });
  for (const l of live) {
    const row = out.get(l.source) ?? {
      source: l.source,
      applicants: 0,
      shortlisted: 0,
      interviewed: 0,
      offered: 0,
      hired: 0,
      liveRoles: 0,
    };
    row.liveRoles = l.n;
    out.set(l.source, row);
  }
  return [...out.values()].sort((a, b) => b.applicants - a.applicants || b.liveRoles - a.liveRoles);
}

/** Organisation-level settings for the Job distribution page. */
export async function distributionSettings(orgId: string) {
  const s = await settingsOf(orgId);
  const [org] = await db
    .select({ hqCountry: organizations.hqCountry })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const [notices] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${jobIndexNotifications.status} = 'sent')::int`,
      pending: sql<number>`count(*) filter (where ${jobIndexNotifications.status} = 'pending')::int`,
      failed: sql<number>`count(*) filter (where ${jobIndexNotifications.status} = 'failed')::int`,
    })
    .from(jobIndexNotifications)
    .where(
      and(
        eq(jobIndexNotifications.orgId, orgId),
        sql`${jobIndexNotifications.createdAt} >= now() - interval '30 days'`,
      ),
    );
  return {
    googleJobsEnabled: Boolean(s?.googleJobsEnabled),
    indexingConfigured: indexingConfigured(),
    country: org?.hqCountry?.trim() || null,
    countryKnown: Boolean(countryCode(org?.hqCountry)),
    notices: notices ?? { sent: 0, pending: 0, failed: 0 },
    feedCreated: Boolean(s?.feedToken),
  };
}
