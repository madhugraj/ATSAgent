/**
 * Distribution agent tools (docs/job-distribution-research.md). Reads report
 * where a role is advertised and what each channel brings in. The outward
 * and destructive actions only ask: putting a role on an aggregator's feed
 * goes to the HR head (or runs on a feed the organisation pre-approved for an
 * Autonomous agent), and erasing CVs a portal limited to their role always
 * goes to the HR head. Posting on a portal by hand is a person's job — the
 * agent reminds them (remind_member) and never records a posting itself.
 */
import { z } from "zod/v4";

import { JOB_CHANNELS, channelById } from "@/lib/job-channels";
import { registerTool, type ToolContext } from "./registry";

const ReqId = z.object({ requisitionId: z.string().uuid() });
const FEEDS = JOB_CHANNELS.filter((c) => c.route === "feed").map((c) => c.id) as [
  string,
  ...string[],
];

const actor = async (ctx: ToolContext) => {
  const { actorFor } = await import("@/lib/requisitions.server");
  return actorFor(ctx.orgId, ctx.principalUserId);
};

export function registerDistributionTools(): void {
  registerTool({
    name: "get_role_channels",
    description:
      "Where one requisition is advertised and what each channel brings in: Google for Jobs (switched on, listed, excluded, what is missing), whether the organisation's feed links exist, and for every portal its route (feed, partner integration, posted by hand), whether it is live and since when, CVs from it in total and in the last 7 days, and whether its CVs may join the talent pool or are limited to the role. Also: channels live for a week or more with no CV ('quiet'), and which channels brought applicants, shortlists and hires for this organisation over the last year.",
    input: ReqId,
    risk: "read",
    run: async (ctx, i) => {
      const { roleChannels } = await import("./distribution-agent.server");
      return roleChannels(ctx.orgId, i.requisitionId);
    },
  });

  registerTool({
    name: "check_cv_inflow",
    description:
      "Across all open roles: CVs that arrived in the last 7 days by source; portal listings live for a week or more that have not produced a single CV (with how that portal's CVs come back); careers-inbox mail that could not be read in the last 7 days; and portal CVs from the last 14 days filed against no role.",
    input: z.object({}),
    risk: "read",
    run: async (ctx) => {
      const { cvInflow } = await import("./distribution-agent.server");
      return cvInflow(ctx.orgId);
    },
  });

  registerTool({
    name: "request_feed_listing",
    description:
      "Put an approved requisition on one aggregator's job feed (jooble, adzuna or jora); the aggregator lists it from the organisation's feed and candidates apply on the role's apply page. The HR head approves each listing unless the organisation pre-approved that feed for an Autonomous agent. Roles hired for a client are never listed. Jora lists Australian roles only.",
    input: ReqId.extend({ channel: z.enum(FEEDS) }),
    risk: "external",
    templateOf: (i) => `job_board:${i.channel}`,
    approverRole: "hr_head",
    describe: (i) => `List the role on the ${channelById(i.channel)?.name ?? i.channel} job feed`,
    precheck: async (ctx, i) => {
      const { distributionStatus } = await import("../distribution/distribution.server");
      const s = await distributionStatus(ctx.orgId, i.requisitionId);
      if (!s.approved) return "The role is not approved, so it cannot be advertised.";
      if (s.forClient) return "The role is hired for a client; aggregators list only direct hires.";
      if (s.postings.some((p) => p.provider === i.channel && p.status === "published"))
        return `The role is already on the ${channelById(i.channel)?.name ?? i.channel} feed.`;
      return null;
    },
    run: async (ctx, i) => {
      const a = await actor(ctx);
      const { addToFeed, distributionStatus } = await import("../distribution/distribution.server");
      await addToFeed(ctx.orgId, a, i.requisitionId, i.channel);
      const s = await distributionStatus(ctx.orgId, i.requisitionId);
      return {
        listed: i.channel,
        feedLinksCreated: s.feedReady,
        note: s.feedReady
          ? "The aggregator picks it up on its next read of the feed."
          : "The feed links are not created yet — the HR head creates them on the Job distribution page and registers them with the aggregator once.",
      };
    },
  });

  registerTool({
    name: "list_role_limited_cvs",
    description:
      "CVs a portal limited to the role they were for (its terms), whose roles are over — closed, or the person was turned down or withdrew — for longer than the grace period, and nobody hired. Each with the portal and why. These must be erased once a person approves.",
    input: z.object({}),
    risk: "read",
    untrustedOutput: true,
    run: async (ctx) => {
      const { restrictedPastRetention } = await import("./distribution-agent.server");
      return restrictedPastRetention(ctx.orgId);
    },
  });

  registerTool({
    name: "request_role_limited_cv_erasure",
    description:
      "Ask the HR head to erase CVs a portal limited to their role, now that the role is over (up to 25 at a time, ids from list_role_limited_cvs). Erasing removes the person, their applications and their CV file for good. Anyone hired or back in an open role is skipped.",
    input: z.object({ candidateIds: z.array(z.string().uuid()).min(1).max(25) }),
    risk: "external",
    approverRole: "hr_head",
    describe: (i) => `Erase ${i.candidateIds.length} CV(s) a portal limited to their role`,
    precheck: async (ctx, i) => {
      const { restrictedPastRetention } = await import("./distribution-agent.server");
      const due = new Set(
        (await restrictedPastRetention(ctx.orgId)).candidates.map((c) => c.candidateId),
      );
      return i.candidateIds.some((id) => due.has(id))
        ? null
        : "None of these CVs is due for erasure (list_role_limited_cvs).";
    },
    run: async (ctx, i) => {
      const a = await actor(ctx);
      const { assertRole } = await import("@/lib/auth.middleware");
      await assertRole(
        a.userId,
        ctx.orgId,
        ["hr_head", "president_cbo"],
        "Only the HR head or the CBO can erase candidates.",
      );
      const { eraseRestricted } = await import("./distribution-agent.server");
      return eraseRestricted(
        ctx.orgId,
        { memberEmail: a.memberEmail, userId: a.userId, label: ctx.actor },
        i.candidateIds,
      );
    },
  });
}
