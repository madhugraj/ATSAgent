/**
 * Silent panel agent settings and a candidate's opt-out
 * (docs/silent-panel-agent-plan.md, S1). The switch lives on the Organisation
 * page; the opt-out on the Interviews page, recorded by the hiring team when a
 * candidate replies that they do not want the call transcribed.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { assertRole, requireOrg } from "./auth.middleware";

const Policy = z.object({
  enabled: z.boolean(),
  levels: z.array(z.number().int().min(1).max(3)).min(1, "Choose at least one round.").max(3),
});

/** The switch, and per connected meeting provider whether it can read transcripts. */
export const getPanelAgent = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { panelAgentPolicyOf, panelAgentReadiness } =
      await import("../server/panel/transcripts.server");
    const [policy, providers] = await Promise.all([
      panelAgentPolicyOf(context.orgId),
      panelAgentReadiness(context.orgId),
    ]);
    return { policy, providers };
  });

/** Switch the silent panel agent on or off, and for which rounds — HR head, CBO or owner; audited. */
export const setPanelAgent = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => Policy.parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      ["hr_head", "president_cbo"],
      "Only the HR head, the CBO or an owner can change the silent panel agent.",
    );
    const { setPanelAgentPolicyCore } = await import("../server/panel/transcripts.server");
    await setPanelAgentPolicyCore(
      context.orgId,
      { userId: context.userId, memberEmail: context.memberEmail },
      data,
    );
    return { ok: true };
  });

/** The candidate does not want this round's call transcribed — the hiring team; audited. */
export const declineRoundTranscription = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({
        interviewId: z.string().uuid(),
        note: z.string().trim().max(300).default(""),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      ["recruiter", "hiring_manager", "hr_head", "president_cbo"],
      "Only the hiring team can record that a candidate declined transcription.",
    );
    const { declineRoundTranscriptionCore } = await import("../server/panel/transcripts.server");
    await declineRoundTranscriptionCore(
      { orgId: context.orgId, userId: context.userId, email: context.memberEmail },
      data.interviewId,
      data.note,
    );
    return { ok: true };
  });
