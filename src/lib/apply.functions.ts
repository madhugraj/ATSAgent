/**
 * Public job-application intake.
 *
 * Every post, feed and portal listing carries the role's apply link, tagged
 * with where it was shared (?src=, see src/lib/job-channels.ts). Anyone who
 * taps it lands on /apply/<requisition>, uploads a CV, and the CV is parsed
 * and filed into the talent pool plus this requisition's pipeline
 * automatically, recorded under that source — no recruiter download step.
 *
 * These functions are intentionally unauthenticated (public applicants), so
 * every handler is narrow: read-only job summary for approved requisitions,
 * and a write path that only ever creates a candidate + application scoped to
 * the requisition's organisation. An existing candidate record is never
 * modified from this unauthenticated path — a repeat application simply
 * attaches to the requisition.
 */
import { and, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { applications, candidates, organizations, requisitions } from "@db/schema";
import { aiJson } from "./ai-gateway.server";
import { resolveSource } from "./job-channels";

const IdInput = z.object({ requisitionId: z.string().uuid() });

export type PublicJob = {
  id: string;
  title: string;
  location: string | null;
  openings: number;
  experienceMin: number;
  experienceMax: number;
  mustHave: string[];
  goodToHave: string[];
  responsibilities: string | null;
  company: string | null;
  open: boolean;
  /** The approved job description (plain text), when there is one. */
  description: string | null;
  /** Google for Jobs structured data, ready for an inline JSON-LD script; null when not listed. */
  jsonLd: string | null;
};

/** Job summary an applicant is allowed to see. Nothing commercial is exposed. */
export const publicJob = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }): Promise<PublicJob | null> => {
    const [r] = await db
      .select({
        id: requisitions.id,
        title: requisitions.title,
        location: requisitions.location,
        openings: requisitions.openings,
        experienceMin: requisitions.experienceMin,
        experienceMax: requisitions.experienceMax,
        mustHaveSkills: requisitions.mustHaveSkills,
        goodToHaveSkills: requisitions.goodToHaveSkills,
        responsibilities: requisitions.responsibilities,
        status: requisitions.status,
        orgId: requisitions.orgId,
      })
      .from(requisitions)
      .where(and(eq(requisitions.id, data.requisitionId), eq(requisitions.status, "approved")))
      .limit(1);
    if (!r) return null;

    let company: string | null = null;
    if (r.orgId) {
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, r.orgId))
        .limit(1);
      company = org?.name ?? null;
    }

    const { publicListing } = await import("../server/distribution/distribution.server");
    const { jsonForScript } = await import("../server/distribution/content");
    const listing = await publicListing(r.id);

    return {
      id: r.id,
      title: r.title,
      location: r.location,
      openings: r.openings,
      experienceMin: r.experienceMin,
      experienceMax: r.experienceMax,
      mustHave: r.mustHaveSkills ?? [],
      goodToHave: r.goodToHaveSkills ?? [],
      responsibilities: r.responsibilities,
      company,
      open: r.status === "approved",
      description: listing?.job.description ?? null,
      jsonLd: listing?.jsonLd ? jsonForScript(listing.jsonLd) : null,
    };
  });

const SubmitInput = z.object({
  requisitionId: z.string().uuid(),
  fileName: z.string().max(300),
  resumeText: z.string().min(50).max(60000),
  email: z.string().email().optional().nullable(),
  fullName: z.string().max(200).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  /** Where the link was shared (?src=); only known sources are kept. */
  source: z.string().max(60).nullish(),
  utmSource: z.string().max(60).nullish(),
});

/**
 * Parse an applicant's CV and file it against the requisition. Scoping is
 * strictly per-organisation: the talent-pool match and the application both
 * live inside the requisition's org, and an existing record is never rewritten
 * by this unauthenticated endpoint.
 */
export const submitApplication = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => SubmitInput.parse(data))
  .handler(async ({ data }) => submitApplicationImpl(data));

/** Handler body, exported for integration tests of the C2 overwrite-protection fix. */
export async function submitApplicationImpl(
  data: z.infer<typeof SubmitInput>,
): Promise<{ ok: true; alreadyApplied: boolean; merged: boolean; name: string }> {
  {
    const source = resolveSource(data.source, data.utmSource);
    const [r] = await db
      .select({
        id: requisitions.id,
        status: requisitions.status,
        orgId: requisitions.orgId,
        title: requisitions.title,
      })
      .from(requisitions)
      .where(eq(requisitions.id, data.requisitionId))
      .limit(1);
    if (!r || !r.orgId) throw new Error("This job link is no longer valid.");
    if (r.status !== "approved") throw new Error("This role is no longer accepting applications.");

    const parsed = await aiJson<{
      full_name: string | null;
      email: string | null;
      phone: string | null;
      location: string | null;
      experience_years: number | null;
      education: string | null;
      skills: string[] | null;
      linkedin_url: string | null;
      github_url: string | null;
      website_url: string | null;
    }>({
      system:
        "Extract structured candidate data from a resume. Return ONLY JSON with keys: full_name, email, phone, " +
        "location, experience_years (number), education, skills (string array), linkedin_url, github_url, website_url. " +
        "Use null when a field is genuinely absent. Never invent values.",
      prompt: data.resumeText.slice(0, 20000),
      orgId: r.orgId,
      feature: "resume_parse",
    });

    const p = parsed.ok ? parsed.data : null;
    const email = (data.email ?? p?.email ?? "").trim().toLowerCase();
    if (!email)
      throw new Error("We could not read an email address — please type yours in the form.");

    const fullName =
      (data.fullName ?? p?.full_name ?? "").trim() || data.fileName.replace(/\.[^.]+$/, "");

    const [existing] = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(and(eq(candidates.email, email), eq(candidates.orgId, r.orgId)))
      .limit(1);

    let candidateId: string;
    if (existing) {
      // Public applicants never overwrite an existing talent-pool record.
      candidateId = existing.id;
    } else {
      const [created] = await db
        .insert(candidates)
        .values({
          fullName,
          email,
          phone: (data.phone ?? p?.phone) || null,
          location: p?.location || null,
          experienceYears: String(Number(p?.experience_years ?? 0) || 0),
          education: p?.education || null,
          skills: p?.skills ?? [],
          linkedinUrl: p?.linkedin_url || null,
          githubUrl: p?.github_url || null,
          websiteUrl: p?.website_url || null,
          source,
          resumeText: data.resumeText,
          orgId: r.orgId,
          lastSyncedAt: new Date(),
        })
        .returning({ id: candidates.id });
      if (!created) throw new Error("Could not save your application.");
      candidateId = created.id;
    }

    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.candidateId, candidateId), eq(applications.requisitionId, r.id)))
      .limit(1);

    if (!app) {
      const [createdApp] = await db
        .insert(applications)
        .values({
          candidateId,
          requisitionId: r.id,
          source,
          orgId: r.orgId,
        })
        .returning({ id: applications.id });

      if (createdApp && r.orgId) {
        const { enqueueEmail } = await import("./email-outbox.server");
        const [org] = await db
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, r.orgId))
          .limit(1);
        await enqueueEmail({
          orgId: r.orgId,
          kind: "ack",
          templateName: "application_ack",
          toEmail: email,
          applicationId: createdApp.id,
          templateData: {
            candidateName: fullName,
            orgName: org?.name,
            jobTitle: r.title,
          },
          idempotencyKey: `ack:${createdApp.id}`,
        });
      }
    }

    return {
      ok: true as const,
      alreadyApplied: Boolean(app),
      merged: Boolean(existing),
      name: fullName,
    };
  }
}
