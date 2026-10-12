/**
 * Publishing-channel and sourcing tools (docs/agentic-plan.md §13.4). Reads
 * report the real state of channels and supply; the one outward action —
 * inviting a past candidate to apply — leaves the organisation, so a person
 * approves it unless the invitation template is pre-approved.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";

import { db } from "../db";
import { organizations, requisitions } from "@db/schema";
import { registerTool } from "./registry";

const ReqId = z.object({ requisitionId: z.string().uuid() });

export function registerSourcingTools(): void {
  registerTool({
    name: "list_publish_channels",
    description:
      "Where this requisition can be published and where it is live: the internal job board, its public apply link, the organisation's careers inbox address, and each job board (LinkedIn, Naukri, Indeed) with whether it is connected, switched on, allowed to post on this connection (and why not), and whether a post is already live. Check this before publishing anywhere.",
    input: ReqId,
    risk: "read",
    run: async (ctx, i) => {
      const { publishChannels } = await import("./sourcing.server");
      return publishChannels(ctx.orgId, i.requisitionId);
    },
  });

  registerTool({
    name: "get_role_traction",
    description:
      "How much supply an approved role is getting: days live, applicants in total and in the last 7 days by source (apply page, careers inbox, boards, internal…), scored and shortlisted counts against the shortlist target, and a verdict on whether it is starving, citing the thresholds.",
    input: ReqId,
    risk: "read",
    run: async (ctx, i) => {
      const { roleTraction } = await import("./sourcing.server");
      return roleTraction(ctx.orgId, i.requisitionId);
    },
  });

  registerTool({
    name: "find_past_candidates",
    description:
      "People the organisation already knows who did well for other roles (shortlisted, interviewed, held in reserve or declined an offer), consented to be contacted, are not in this role's pipeline, are not employees and were not invited for this role in the last 30 days — ranked against this role's must-haves by meaning, each with why they matched and how far they got before.",
    input: ReqId.extend({ limit: z.number().int().min(1).max(20).default(10) }),
    risk: "read",
    untrustedOutput: true,
    skills: ["talent_search"],
    run: async (ctx, i) => {
      const { pastCandidates } = await import("./sourcing.server");
      return pastCandidates(ctx.orgId, i.requisitionId, i.limit);
    },
  });

  registerTool({
    name: "invite_to_apply",
    description:
      "Email up to 10 past candidates an invitation to apply for this approved role, with its public apply link (they apply themselves; nobody is added to the pipeline). Skips anyone without consent, without an email, already in the pipeline or invited for this role in the last 30 days. Leaves the organisation, so a person approves it unless the invitation template is pre-approved.",
    input: ReqId.extend({
      candidateIds: z.array(z.string().uuid()).min(1).max(10),
    }),
    risk: "external",
    templateOf: () => "role_invite",
    describe: (i) => `Invite ${i.candidateIds.length} past candidate(s) to apply`,
    run: async (ctx, i) => {
      const [r] = await db
        .select({
          id: requisitions.id,
          title: requisitions.title,
          status: requisitions.status,
          location: requisitions.location,
        })
        .from(requisitions)
        .where(and(eq(requisitions.id, i.requisitionId), eq(requisitions.orgId, ctx.orgId)))
        .limit(1);
      if (!r) throw new Error("Requisition not found.");
      if (r.status !== "approved") throw new Error("Only an approved role can be advertised.");
      const { invitable, applyUrl, pastCandidates } = await import("./sourcing.server");
      const { ok, skipped } = await invitable(ctx.orgId, r.id, i.candidateIds);
      // Only people this role's past-candidate search would offer (no 30-day re-invites).
      const eligible = new Set(
        (await pastCandidates(ctx.orgId, r.id, 20)).matches.map((m) => m.candidateId),
      );
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      const { enqueueEmail } = await import("@/lib/email-outbox.server");
      const invited: string[] = [];
      for (const c of ok) {
        if (!eligible.has(c.id)) {
          skipped.push({ id: c.id, reason: "was invited recently or is not a past candidate" });
          continue;
        }
        await enqueueEmail({
          orgId: ctx.orgId,
          kind: "role_invite",
          templateName: "role_invite",
          toEmail: c.email,
          // One per person, role and 30-day window (the window is checked in pastCandidates).
          idempotencyKey: `role_invite:${r.id}:${c.id}:${Math.floor(Date.now() / (30 * 864e5))}`,
          templateData: {
            candidateName: c.name,
            orgName: org?.name ?? "the hiring team",
            jobTitle: r.title,
            location: r.location ?? undefined,
            applyUrl: applyUrl(r.id),
          },
        });
        invited.push(c.name);
      }
      return { invited, skipped };
    },
  });
}
