/**
 * Server-side candidate intake shared by the public apply page and the
 * automatic careers-inbox import: parse a CV, upsert the talent-pool record by
 * email, and raise the application against a requisition.
 */
import { poolUseFor } from "./job-channels";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createHash } from "crypto";
import { z } from "zod";

import { db } from "../server/db";
import { looksLikeInjection } from "../server/agents/injection";
import { contentTypeFor, putObject, resumeObjectPath, safeFileName } from "../server/storage";
import { applications, candidateIdentityKeys, candidates } from "@db/schema";
import { computeIdentityKeys, type NewKey } from "../server/candidates/identity.server";
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
  /** True when a fuzzy/shared match was queued for the merge review queue. */
  reviewQueued?: boolean;
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
  /** sha256 of the bytes: keeps each distinct CV version as its own object. */
  contentHash?: string | null;
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
    const name = input.contentHash
      ? `${input.contentHash.slice(0, 12)}-${input.filename}`
      : input.filename;
    const path = resumeObjectPath(input.orgId, input.candidateId, name);
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

  /** Identity keys for this arrival (design §1.2), computed once. */
  const keysOf = (
    row: {
      fullName: string;
      phone: string | null;
      linkedinUrl: string | null;
      githubUrl: string | null;
    },
    email: string,
    fileHash: string | null,
  ) => {
    return computeIdentityKeys({
      fullName: row.fullName,
      email,
      phone: row.phone,
      linkedinUrl: row.linkedinUrl,
      githubUrl: row.githubUrl,
      fileHash,
    });
  };

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
      (/linkedin\.com\/(?:talent\/|in\/)/i.test(input.profileUrl ?? "")
        ? input.profileUrl
        : null) ||
      null,
    githubUrl: p?.github_url || null,
    websiteUrl: p?.website_url || null,
    currentEmployer: p?.current_employer || p?.employment_history?.[0]?.company || null,
    employmentHistory: p?.employment_history ?? [],
    source: input.source,
    resumeText: input.resumeText,
    orgId: input.orgId,
    // The parser model's own flag, or the deterministic tripwire on the raw CV
    // text (it catches what a model talked out of flagging would miss).
    suspectedPromptInjection:
      Boolean(p?.suspected_prompt_injection) || looksLikeInjection(input.resumeText ?? ""),
    lastSyncedAt: new Date(),
  };

  // Dedupe strictly inside the target organisation (or the unassigned pool when
  // no org is known), matching how the record will later be read. Org-scoped
  // arrivals resolve through the identity module (plan row 1) — strong keys,
  // shared keys, file hash and fuzzy career-history evidence — while the
  // unassigned pool keeps the legacy linkedin/email lookup (design §1.6).
  const orgScope = input.orgId ? eq(candidates.orgId, input.orgId) : isNull(candidates.orgId);
  const fileHash = input.resumeFile?.bytes?.length
    ? createHash("sha256").update(input.resumeFile.bytes).digest("hex")
    : null;

  const result = await db.transaction(
    async (
      tx,
    ): Promise<{
      candidateId: string;
      alreadyApplied: boolean;
      merged: boolean;
      reviewQueued: boolean;
      reviewMatch: {
        candidateId: string;
        score: number;
        reasons: { signal: string; detail: string }[];
      } | null;
    }> => {
      const { resolveIdentity, insertCandidateKeys, lookupKeyOwners, legacyIdentityLookup } =
        await import("../server/candidates/identity.server");
      let keys: NewKey[] = [];
      let reviewQueued = false;

      let existing: { id: string; skills: string[] | null } | undefined;
      let reviewMatch: {
        candidateId: string;
        score: number;
        reasons: { signal: string; detail: string }[];
      } | null = null;

      if (input.orgId) {
        const outcome = await resolveIdentity(
          {
            orgId: input.orgId,
            fullName: row.fullName,
            email,
            phone: row.phone ?? null,
            linkedinUrl: row.linkedinUrl ?? null,
            githubUrl: row.githubUrl ?? null,
            fileHash,
            employmentHistory: row.employmentHistory,
            education: row.education,
            location: row.location,
          },
          tx,
        );
        keys = keysOf(row, email, fileHash);
        if (outcome.outcome === "merged" || outcome.outcome === "attach") {
          [existing] = await tx
            .select({ id: candidates.id, skills: candidates.skills })
            .from(candidates)
            .where(and(orgScope, eq(candidates.id, outcome.candidateId)))
            .limit(1);
        } else {
          // Keyless rows (pre-A1 records, fixtures, rows created outside the
          // module) are invisible to the key lookup — fall back to the legacy
          // exact email/linkedin match so they keep deduping. A legacy match
          // beats a fuzzy review: a strong contact detail is the better
          // evidence (design §1.7, migration-safe wiring).
          const legacy = await legacyIdentityLookup(tx, input.orgId, {
            email,
            linkedinUrl: row.linkedinUrl,
          });
          if (legacy) {
            [existing] = await tx
              .select({ id: candidates.id, skills: candidates.skills })
              .from(candidates)
              .where(and(orgScope, eq(candidates.id, legacy.id)))
              .limit(1);
            reviewMatch = null;
          } else if (outcome.outcome === "review") {
            reviewMatch = {
              candidateId: outcome.matchedCandidateId,
              score: outcome.score,
              reasons: outcome.reasons,
            };
          }
        }
      } else {
        // Legacy pool lookup: linkedin first, then the (possibly placeholder)
        // email — placeholder equality is exactly what email matching did.
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
      }

      let candidateId: string;
      let createdHere = false;
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
        // Where the person first came from is kept; this arrival's source is
        // recorded on the application below (portal credit, migration 0045).
        const { source: _firstSourceKept, ...refresh } = updateRow as typeof row;
        await tx
          .update(candidates)
          .set({ ...refresh, skills: [...skills], ...(fileHash ? { fileHash } : {}) })
          .where(eq(candidates.id, existing.id));
        candidateId = existing.id;
      } else {
        // A CV a portal handed over may be limited to its role by the portal's
        // terms (src/lib/job-channels.ts); an existing record keeps its own rule.
        const poolUse = poolUseFor(input.source);
        const [created] = await tx
          .insert(candidates)
          .values({
            ...row,
            ...(fileHash ? { fileHash } : {}),
            poolUse,
            poolUseSource: poolUse === "role_only" ? input.source : null,
          })
          .returning({ id: candidates.id });
        if (!created) throw new Error("Could not save the candidate.");
        candidateId = created.id;
        createdHere = true;
      }

      // Identity keys: written only for org-scoped candidates (design §1.6).
      // For a merged arrival the survivor already holds the colliding key —
      // conflicts are skipped. For a fresh arrival a key collision means a
      // concurrent intake won the race while we were inserting: the newcomer
      // is rolled back and the arrival resolves into the key's owner instead
      // (design §1.3, concurrency).
      if (input.orgId) {
        let placed = false;
        if (createdHere) {
          try {
            await tx.transaction(async (sp) => {
              await sp.insert(candidateIdentityKeys).values(
                keys.map((k) => ({
                  orgId: input.orgId as string,
                  candidateId,
                  keyType: k.keyType,
                  keyValue: k.keyValue,
                })),
              );
            });
            placed = true;
          } catch (e) {
            if ((e as { code?: string }).code !== "23505") throw e;
            // Lost the race: a concurrent arrival inserted the same key first.
            // Fall back to its owner rather than leaving a keyless duplicate.
            const owners = await lookupKeyOwners(tx, input.orgId, keys);
            const owner = owners.find((o) => o.candidateId !== candidateId);
            if (owner) {
              await tx.delete(candidates).where(eq(candidates.id, candidateId));
              const [ownerRow] = await tx
                .select({ id: candidates.id, skills: candidates.skills })
                .from(candidates)
                .where(and(orgScope, eq(candidates.id, owner.candidateId)))
                .limit(1);
              if (!ownerRow) throw e;
              existing = ownerRow;
              const skills = new Set(
                [...(ownerRow.skills ?? []), ...row.skills].map((s) => s.trim()).filter(Boolean),
              );
              const { source: _s, ...refresh } = row;
              await tx
                .update(candidates)
                .set({ ...refresh, skills: [...skills], ...(fileHash ? { fileHash } : {}) })
                .where(eq(candidates.id, owner.candidateId));
              candidateId = owner.candidateId;
              reviewQueued = false;
              reviewMatch = null;
              placed = true;
            }
          }
        }
        if (!placed) {
          // Merged arrivals: record the newcomer's other keys against the
          // survivor; colliding keys stay with their current owner.
          await insertCandidateKeys(tx, input.orgId, candidateId, keys);
        }
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

      return { candidateId, alreadyApplied, merged: Boolean(existing), reviewQueued, reviewMatch };
    },
  );

  // A fuzzy or shared-evidence match on a trusted surface enqueues a pair for
  // the merge review queue — never an automatic merge (design §1.3).
  if (result.reviewMatch && input.orgId) {
    try {
      const { enqueueMergeSuggestion } = await import("../server/candidates/identity.server");
      await enqueueMergeSuggestion({
        orgId: input.orgId,
        existingId: result.reviewMatch.candidateId,
        newcomerId: result.candidateId,
        score: result.reviewMatch.score,
        reasons: result.reviewMatch.reasons,
      });
      result.reviewQueued = true;
    } catch (e) {
      console.error("[intake] could not enqueue the merge suggestion:", e);
    }
  }

  let resumeStored = false;
  let resumeError: string | null = null;
  let storedPath: string | null = null;
  if (input.resumeFile?.bytes?.length) {
    const stored = await storeResumeFile({
      orgId: input.orgId,
      candidateId: result.candidateId,
      filename: input.resumeFile.filename,
      bytes: input.resumeFile.bytes,
      contentHash: fileHash,
    });
    resumeStored = Boolean(stored.path);
    resumeError = stored.error;
    storedPath = stored.path;
  }

  // Every CV is a version (design §2): history is kept, claims are queued.
  if (input.orgId && !input.profileOnly && (input.resumeText ?? "").trim()) {
    try {
      const { recordCvVersion } = await import("../server/candidates/versions.server");
      await recordCvVersion({
        orgId: input.orgId,
        candidateId: result.candidateId,
        requisitionId: input.requisitionId,
        source: input.source,
        fileHash,
        filePath: storedPath,
        fileName: input.resumeFile?.filename ?? input.fileName ?? null,
        parsedText: input.resumeText,
      });
    } catch (e) {
      console.error("[intake] could not record the CV version:", e);
    }
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
