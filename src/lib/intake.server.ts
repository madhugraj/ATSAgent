/**
 * Server-side candidate intake shared by the public apply page and the
 * automatic careers-inbox import: parse a CV, upsert the talent-pool record by
 * email, and raise the application against a requisition.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createHash } from "crypto";
import { z } from "zod";

import { db } from "../server/db";
import { contentTypeFor, putObject, resumeObjectPath, safeFileName } from "../server/storage";
import { applications, candidates } from "@db/schema";
import { aiJson } from "./ai-gateway.server";

export type ParsedCv = {
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
  current_employer: string | null;
  /** Model judged the CV text contains injection-style instructions. */
  suspected_prompt_injection?: boolean | null;
  employment_history:
    | {
        company: string | null;
        title: string | null;
        start: string | null;
        end: string | null;
        level_hint?: string | null;
      }[]
    | null;
};

export async function parseCv(
  resumeText: string,
  orgId?: string | null | undefined,
): Promise<ParsedCv | null> {
  const { aiJson, INJECTION_RULES, untrusted } = await import("./ai-gateway.server");
  const loose = <T extends z.ZodTypeAny>(inner: T) => inner.nullish().catch(null);
  const ParsedCvSchema = z
    .object({
      full_name: loose(z.string()),
      email: loose(z.string()),
      phone: loose(z.string()),
      location: loose(z.string()),
      experience_years: loose(z.number()),
      education: loose(z.string()),
      skills: loose(z.array(z.string())),
      linkedin_url: loose(z.string()),
      github_url: loose(z.string()),
      website_url: loose(z.string()),
      current_employer: loose(z.string()),
      suspected_prompt_injection: loose(z.boolean()),
      employment_history: loose(
        z.array(
          z.object({
            company: loose(z.string()),
            title: loose(z.string()),
            start: loose(z.string()),
            end: loose(z.string()),
            level_hint: loose(z.string()),
          }),
        ),
      ),
    })
    .transform((v): ParsedCv => ({
      full_name: v.full_name ?? null,
      email: v.email ?? null,
      phone: v.phone ?? null,
      location: v.location ?? null,
      experience_years: v.experience_years ?? null,
      education: v.education ?? null,
      skills: v.skills ?? null,
      linkedin_url: v.linkedin_url ?? null,
      github_url: v.github_url ?? null,
      website_url: v.website_url ?? null,
      current_employer: v.current_employer ?? null,
      suspected_prompt_injection: v.suspected_prompt_injection ?? null,
      employment_history:
        v.employment_history?.map((h) => ({
          company: h.company ?? null,
          title: h.title ?? null,
          start: h.start ?? null,
          end: h.end ?? null,
          level_hint: h.level_hint ?? null,
        })) ?? null,
    }));
  const parsed = await aiJson<ParsedCv>({
    system:
      INJECTION_RULES +
      "\nExtract structured candidate data from a resume. Return ONLY JSON with keys: full_name, email, phone, " +
      "location, experience_years (number), education, skills (string array), linkedin_url, github_url, website_url, " +
      "current_employer, employment_history (array of {company, title, start, end, level_hint}, newest first). " +
      "Use null when a field is genuinely absent. Never invent values. URLs must be real URLs read from the resume — never fabricate one.",
    prompt: untrusted("resume", resumeText.slice(0, 20000)),
    orgId,
    feature: "resume_parse",
    schema: ParsedCvSchema,
  });
  return parsed.ok ? parsed.data : null;
}

export type IngestResult = {
  candidateId: string;
  name: string;
  email: string;
  alreadyApplied: boolean;
  merged: boolean;
  /** True when no email could be read and a placeholder was used. */
  emailMissing?: boolean;
  resumeStored: boolean;
  /** Why the original CV file could not be kept, when it could not. */
  resumeError?: string | null;
  skills: string[];
  linkedinUrl: string | null;
  githubUrl: string | null;
  websiteUrl: string | null;
};

/**
 * Keep the original CV file in the private `resumes` bucket, one folder per
 * organisation (<org>/<candidate>/<file>), and point the candidate row at it.
 * Never throws — a failed store must not lose the candidate.
 */
export async function storeResumeFile(input: {
  orgId: string | null;
  candidateId: string;
  filename: string;
  bytes: Uint8Array;
}): Promise<{ path: string | null; error: string | null }> {
  if (!input.orgId || input.bytes.byteLength === 0) {
    return {
      path: null,
      error: !input.orgId
        ? "no organisation on the candidate"
        : "the CV file buffer was empty after parsing",
    };
  }
  try {
    const path = resumeObjectPath(input.orgId, input.candidateId, input.filename);
    await putObject(
      path,
      Uint8Array.from(input.bytes),
      contentTypeFor(safeFileName(input.filename)),
    );

    await db
      .update(candidates)
      .set({ resumeFilePath: path })
      .where(eq(candidates.id, input.candidateId));
    return { path, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : "unknown vault error";
    console.error("[resumes] could not store CV file:", e);
    return { path: null, error };
  }
}

/**
 * Upsert the candidate and attach them to the requisition. Admin client only.
 * The AI work of reading the CV counts towards this candidate's hiring cost:
 * the calls are collected while the candidate is still unknown and labelled
 * once they are saved (together with any parse done by the caller in the
 * same scope).
 */
export async function ingestCandidate(
  input: Parameters<typeof ingestCandidateInner>[0],
): Promise<IngestResult> {
  const { withAiSubject, currentAiSubject } = await import("../server/agents/context");
  const events = currentAiSubject()?.events ?? [];
  const res = await withAiSubject({ requisitionId: input.requisitionId, events }, () =>
    ingestCandidateInner(input),
  );
  await labelCvCost(events, res.candidateId, input.requisitionId);
  return res;
}

/** Label the CV-reading AI calls with the candidate (and their application to this role). */
export async function labelCvCost(
  eventIds: string[],
  candidateId: string | null | undefined,
  requisitionId: string | null | undefined,
): Promise<void> {
  if (!eventIds.length || !candidateId) return;
  try {
    const { aiUsageEvents } = await import("@db/schema");
    let applicationId: string | null = null;
    if (requisitionId) {
      const [a] = await db
        .select({ id: applications.id })
        .from(applications)
        .where(
          and(
            eq(applications.candidateId, candidateId),
            eq(applications.requisitionId, requisitionId),
          ),
        )
        .limit(1);
      applicationId = a?.id ?? null;
    }
    await db
      .update(aiUsageEvents)
      .set({ candidateId, applicationId, requisitionId: requisitionId ?? null })
      .where(inArray(aiUsageEvents.id, eventIds));
  } catch (e) {
    console.error("[intake] could not attribute CV cost:", e);
  }
}

async function ingestCandidateInner(input: {
  resumeText: string;
  fileName: string;
  requisitionId: string | null;
  orgId: string | null;
  source: string;
  email?: string | null;
  fullName?: string | null;
  phone?: string | null;
  parsed?: ParsedCv | null;
  identityKey?: string | null;
  /** Signed-in source profile shown by the companion, retained for recruiters. */
  profileUrl?: string | null;
  /** Original CV file, kept in the private resume vault when provided. */
  resumeFile?: { filename: string; bytes: Uint8Array } | null;
  /** Companion captures must never leave a text-only candidate behind. */
  requireResumeStored?: boolean;
  /** LinkedIn evidence retained before its original CV becomes available. */
  profileOnly?: boolean;
}): Promise<IngestResult> {
  const p = input.parsed ?? (await parseCv(input.resumeText, input.orgId));

  // A client-supplied requisitionId is only honoured when it belongs to the
  // caller's org — otherwise applications could be pinned to a foreign
  // requisition and its JD/budget metadata would leak through scoring.
  if (input.requisitionId && input.orgId) {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(input.requisitionId, input.orgId);
  }

  const normalizedName = (value: string | null | undefined) =>
    (value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((part) => part.length > 1);
  const expectedParts = normalizedName(input.fullName);
  const parsedParts = normalizedName(p?.full_name);
  if (expectedParts.length && parsedParts.length) {
    const overlap = expectedParts.filter((part) => parsedParts.includes(part)).length;
    if (overlap === 0) {
      throw new Error(
        `The downloaded CV belongs to ${p?.full_name ?? "another applicant"}, not ${input.fullName}. Nothing was filed.`,
      );
    }
  }

  const readName =
    (input.fullName ?? p?.full_name ?? "").trim() || input.fileName.replace(/\.[^.]+$/, "");

  // Some sources (a captured profile page, a CV with only a phone number) carry
  // no email. Rather than losing the person, file them under a placeholder
  // address the recruiter can correct later.
  let email = (input.email ?? p?.email ?? "").trim().toLowerCase();
  let emailMissing = false;
  if (!email) {
    const slug =
      readName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ".")
        .replace(/^\.|\.$/g, "") || "candidate";
    const identity = input.identityKey || p?.linkedin_url || `${input.orgId ?? "org"}:${readName}`;
    const stableId = createHash("sha256")
      .update(identity.trim().toLowerCase())
      .digest("hex")
      .slice(0, 12);
    email = `${slug}.${stableId}@no-email.atsiq.local`;
    emailMissing = true;
  }

  const row = {
    fullName: readName,
    email,
    phone: (input.phone ?? p?.phone) || null,
    location: p?.location || null,
    experienceYears: String(Number(p?.experience_years ?? 0) || 0),
    education: p?.education || null,
    skills: p?.skills ?? [],
    linkedinUrl:
      p?.linkedin_url ||
      (/linkedin\.com\/(?:talent\/|in\/)/i.test(input.profileUrl ?? "") ? input.profileUrl : null),
    githubUrl: p?.github_url || null,
    websiteUrl: p?.website_url || null,
    currentEmployer: p?.current_employer || p?.employment_history?.[0]?.company || null,
    employmentHistory: p?.employment_history ?? [],
    source: input.source,
    resumeText: input.resumeText,
    orgId: input.orgId,
    suspectedPromptInjection: Boolean(p?.suspected_prompt_injection),
    lastSyncedAt: new Date(),
  };

  // Dedupe strictly inside the target organisation (or the unassigned pool when
  // no org is known), matching how the record will later be read.
  const orgScope = input.orgId ? eq(candidates.orgId, input.orgId) : isNull(candidates.orgId);

  const result = await db.transaction(
    async (tx): Promise<{ candidateId: string; alreadyApplied: boolean; merged: boolean }> => {
      let existing: { id: string; skills: string[] | null } | undefined;
      if (row.linkedinUrl) {
        [existing] = await tx
          .select({ id: candidates.id, skills: candidates.skills })
          .from(candidates)
          .where(and(orgScope, eq(candidates.linkedinUrl, row.linkedinUrl)))
          .limit(1);
      }
      if (!existing) {
        [existing] = await tx
          .select({ id: candidates.id, skills: candidates.skills })
          .from(candidates)
          .where(and(orgScope, eq(candidates.email, email)))
          .limit(1);
      }

      let candidateId: string;
      if (existing) {
        const skills = new Set(
          [...(existing.skills ?? []), ...row.skills].map((s) => s.trim()).filter(Boolean),
        );
        const updateRow = input.profileOnly
          ? Object.fromEntries(
              Object.entries(row).filter(
                ([key, value]) =>
                  key !== "email" &&
                  value !== null &&
                  value !== "" &&
                  (!Array.isArray(value) || value.length > 0) &&
                  (key !== "experienceYears" || value !== "0"),
              ),
            )
          : row;
        await tx
          .update(candidates)
          .set({ ...updateRow, skills: [...skills] })
          .where(eq(candidates.id, existing.id));
        candidateId = existing.id;
      } else {
        const [created] = await tx.insert(candidates).values(row).returning({ id: candidates.id });
        if (!created) throw new Error("Could not save the candidate.");
        candidateId = created.id;
      }

      let alreadyApplied = false;
      if (input.requisitionId) {
        const [app] = await tx
          .select({ id: applications.id })
          .from(applications)
          .where(
            and(
              eq(applications.candidateId, candidateId),
              eq(applications.requisitionId, input.requisitionId),
            ),
          )
          .limit(1);
        alreadyApplied = Boolean(app);
        if (!app) {
          await tx.insert(applications).values({
            candidateId,
            requisitionId: input.requisitionId,
            source: input.source,
            orgId: input.orgId,
          });
        }
      }

      return { candidateId, alreadyApplied, merged: Boolean(existing) };
    },
  );

  let resumeStored = false;
  let resumeError: string | null = null;
  if (input.resumeFile?.bytes?.length) {
    const stored = await storeResumeFile({
      orgId: input.orgId,
      candidateId: result.candidateId,
      filename: input.resumeFile.filename,
      bytes: input.resumeFile.bytes,
    });
    resumeStored = Boolean(stored.path);
    resumeError = stored.error;
  }

  return {
    candidateId: result.candidateId,
    name: row.fullName,
    email,
    alreadyApplied: result.alreadyApplied,
    merged: result.merged,
    emailMissing,
    resumeStored,
    resumeError,
    skills: row.skills,
    linkedinUrl: row.linkedinUrl ?? null,
    githubUrl: row.githubUrl,
    websiteUrl: row.websiteUrl,
  };
}
