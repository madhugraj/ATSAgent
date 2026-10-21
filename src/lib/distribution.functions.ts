/**
 * Job distribution server functions: Google for Jobs, job feeds, hand-posted
 * portals and the per-channel source report. Reading is open to the
 * organisation's members; anything that advertises a role outside the
 * organisation, or replaces the feed links, is the HR head's (the same gate
 * as publishing to a partner board) and is audited server-side.
 *
 * Server-only modules are imported inside handlers so this module stays safe
 * for the client bundle.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireOrg, requireRole } from "./auth.middleware";

const ReqId = z.object({ requisitionId: z.string().uuid() });
const Channel = z.string().min(2).max(40);

const server = () => import("../server/distribution/distribution.server");
const actorOf = (c: { memberEmail: string; userId: string }) => ({
  memberEmail: c.memberEmail,
  userId: c.userId,
});

/** Every channel's state for one role. */
export const roleDistribution = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => ReqId.parse(data))
  .handler(async ({ data, context }) =>
    (await server()).distributionStatus(context.orgId, data.requisitionId),
  );

/** Copy and steps for posting one role on a portal by hand. */
export const rolePostingPack = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => ReqId.extend({ channel: Channel }).parse(data))
  .handler(async ({ data, context }) =>
    (await server()).postingPack(context.orgId, data.requisitionId, data.channel),
  );

export const addRoleToFeed = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .inputValidator((data: unknown) => ReqId.extend({ channel: Channel }).parse(data))
  .handler(async ({ data, context }) => {
    await (
      await server()
    ).addToFeed(context.orgId, actorOf(context), data.requisitionId, data.channel);
    return { ok: true as const };
  });

export const markRolePosted = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .inputValidator((data: unknown) =>
    ReqId.extend({ channel: Channel, url: z.string().max(500).nullish() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    await (
      await server()
    ).markPosted(
      context.orgId,
      actorOf(context),
      data.requisitionId,
      data.channel,
      data.url ?? null,
    );
    return { ok: true as const };
  });

export const takeRoleDown = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .inputValidator((data: unknown) => ReqId.extend({ channel: Channel }).parse(data))
  .handler(async ({ data, context }) => {
    await (
      await server()
    ).takeDown(context.orgId, actorOf(context), data.requisitionId, data.channel);
    return { ok: true as const };
  });

export const setRoleGoogleListing = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .inputValidator((data: unknown) => ReqId.extend({ listed: z.boolean() }).parse(data))
  .handler(async ({ data, context }) => {
    await (
      await server()
    ).setRoleOnGoogle(context.orgId, actorOf(context), data.requisitionId, data.listed);
    return { ok: true as const };
  });

/** Organisation settings for the Job distribution page. */
export const distributionOverview = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => (await server()).distributionSettings(context.orgId));

export const setGoogleJobsEnabled = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .inputValidator((data: unknown) => z.object({ enabled: z.boolean() }).parse(data))
  .handler(async ({ data, context }) => {
    await (await server()).setGoogleJobs(context.orgId, actorOf(context), data.enabled);
    return { ok: true as const };
  });

/** The feed links (they name the feed, so only the HR head sees them). */
export const jobFeedLinks = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .handler(async ({ context }) => (await server()).feedLinks(context.orgId));

export const rotateJobFeedLinks = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .handler(async ({ context }) => ({
    urls: await (await server()).rotateFeedToken(context.orgId, actorOf(context)),
  }));

/** Applicants and how far they got, per source. */
export const channelSourceReport = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z.object({ days: z.number().int().min(7).max(365).default(90) }).parse(data),
  )
  .handler(async ({ data, context }) => (await server()).channelReport(context.orgId, data.days));
