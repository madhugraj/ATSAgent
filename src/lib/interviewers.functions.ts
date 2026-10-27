/**
 * Interviewer profiles for the Team page (docs/interview-panel-plan.md, P0).
 * Anyone in the organisation may see who interviews (people pick panels from
 * it); the owner, the CBO and the HR head may change it.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { assertRole, requireOrg } from "./auth.middleware";

const Profile = z.object({
  active: z.boolean(),
  areas: z.array(z.string().max(60)).max(20),
  rounds: z.array(z.number().int().min(1).max(3)).min(1).max(3),
  weeklyCap: z.number().int().min(1).max(20),
});

export const listInterviewerProfiles = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { interviewerProfilesOf } = await import("./interviewers.server");
    return interviewerProfilesOf(context.orgId);
  });

export const setInterviewerProfile = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ memberId: z.string().uuid(), profile: Profile }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      ["hr_head", "president_cbo"],
      "Only the owner, the CBO or the HR head can change who interviews.",
    );
    const { setInterviewerProfileCore } = await import("./interviewers.server");
    return setInterviewerProfileCore(
      context.orgId,
      { userId: context.userId, memberEmail: context.memberEmail },
      data.memberId,
      data.profile,
    );
  });
