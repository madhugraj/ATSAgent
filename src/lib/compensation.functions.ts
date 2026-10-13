/**
 * Pay & availability: the candidate's public form (behind a private token)
 * and the TA / HR view on the candidate's page. Everything a member does is
 * org-scoped and limited to TA, the HR head, the CBO and owners
 * (src/lib/compensation.server.ts holds the rules).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { applications, requisitions } from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";

const Token = z.object({ token: z.string().regex(/^[a-f0-9]{32,64}$/) });

/* ------------------------------------------------------------ candidate (public) */

export const getCompensationForm = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => Token.parse(d))
  .handler(async ({ data }) => {
    const { publicCompensationView } = await import("./compensation.server");
    return publicCompensationView(data.token);
  });

export const submitCompensationForm = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => Token.extend({ answers: z.unknown() }).parse(d))
  .handler(async ({ data }) => {
    const { submitCompensation, CandidateCompensationForm } = await import("./compensation.server");
    const parsed = CandidateCompensationForm.safeParse(data.answers);
    if (!parsed.success)
      throw new Error(
        "Please check the form: expected CTC, notice period and your consent are required, and amounts must be in rupees.",
      );
    return submitCompensation(data.token, parsed.data);
  });

/* ------------------------------------------------------------ TA / HR */

async function payAccess(userId: string, orgId: string): Promise<boolean> {
  const { PAY_ROLES } = await import("./compensation.server");
  try {
    await assertRole(userId, orgId, [...PAY_ROLES]);
    return true;
  } catch {
    return false;
  }
}

/** The candidate's pay per application — or `allowed: false` for anyone outside TA / HR. */
export const getCandidateCompensation = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ candidateId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    if (!(await payAccess(context.userId, context.orgId)))
      return { allowed: false as const, applications: [] };
    const comp = await import("./compensation.server");
    const { getOrgEmailSettings } = await import("./email-outbox.server");
    const { dayText } = await import("./assessment-timeline.server");
    const tz = (await getOrgEmailSettings(context.orgId)).timezone;
    const apps = await db
      .select({ id: applications.id, stage: applications.stage, title: requisitions.title })
      .from(applications)
      .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
      .where(
        and(eq(applications.orgId, context.orgId), eq(applications.candidateId, data.candidateId)),
      )
      .orderBy(desc(applications.appliedAt));
    return {
      allowed: true as const,
      applications: await Promise.all(
        apps.map(async (a) => {
          const r = await comp.latestRequest(context.orgId, a.id);
          return {
            applicationId: a.id,
            title: a.title,
            stage: a.stage,
            canAsk: comp.PAY_STAGES.has(a.stage),
            details: await comp.detailsFor(context.orgId, a.id),
            request: r
              ? {
                  id: r.id,
                  status: r.status,
                  sentOn: dayText(r.createdAt, tz),
                  due: r.dueAt ? dayText(r.dueAt, tz) : null,
                  remindersSent: r.remindersSent,
                  completedOn: r.completedAt ? dayText(r.completedAt, tz) : null,
                }
              : null,
          };
        }),
      ),
    };
  });

export const recordCandidateCompensation = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({
        applicationId: z.string().uuid(),
        source: z.enum(["screening_call", "recruiter"]),
        details: z.unknown(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { recordCompensation, CompensationFields } = await import("./compensation.server");
    const parsed = CompensationFields.safeParse(data.details);
    if (!parsed.success)
      throw new Error("Check the amounts (rupees) and the notice period (0–365 days).");
    return recordCompensation(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      data.applicationId,
      parsed.data,
      data.source,
    );
  });

/** Send (or remind about) the form by hand. */
export const sendCandidateCompensationForm = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("send"), applicationId: z.string().uuid() }),
        z.object({ action: z.literal("remind"), requestId: z.string().uuid() }),
      ])
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const comp = await import("./compensation.server");
    await assertRole(
      context.userId,
      context.orgId,
      [...comp.PAY_ROLES],
      "Only TA, the HR head or the CBO can ask a candidate about pay.",
    );
    const by = { userId: context.userId, memberEmail: context.memberEmail };
    if (data.action === "remind") return comp.remindCompensation(context.orgId, data.requestId, by);
    return comp.requestCompensation(context.orgId, data.applicationId, by);
  });
