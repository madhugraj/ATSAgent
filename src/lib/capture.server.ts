/**
 * Browser-companion capture.
 *
 * The recruiter stays signed in to the job board in their own browser; the
 * ATSIQ companion extension lifts the page they are looking at (a job
 * description, or an attached CV) and posts it here with the organisation's
 * capture token. Nothing on our side pretends to be the recruiter.
 */
import { eq } from "drizzle-orm";

import { db } from "../server/db";
import {
  captureEvents,
  candidateVerifications,
  organizations,
  requisitions,
  socialProfiles,
} from "@db/schema";
import { aiJson } from "./ai-gateway.server";
import { ingestCandidate } from "./intake.server";

export type CaptureKind = "cv" | "jd";

export type CaptureInput = {
  token: string;
  kind: CaptureKind;
  text?: string | null;
  /** base64 file body, for a CV attachment the companion could download. */
  file?: { filename: string; content: string } | null;
  sourceUrl?: string | null;
  publicProfileUrl?: string | null;
  title?: string | null;
  candidateName?: string | null;
  /** Retain validated LinkedIn evidence even when its original CV is still pending. */
  profileOnly?: boolean;
  requisitionId?: string | null;
};

export type CaptureResult = {
  status: "imported" | "updated" | "stored" | "skipped" | "error";
  detail: string;
  candidateId?: string | null;
  requisitionId?: string | null;
  title?: string | null;
};

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

type ParsedJd = {
  title: string | null;
  location: string | null;
  must_have_skills: string[] | null;
  good_to_have_skills: string[] | null;
  responsibilities: string | null;
  education_requirement: string | null;
  experience_min: number | null;
  experience_max: number | null;
};

async function parseJd(text: string, orgId?: string | null | undefined): Promise<ParsedJd | null> {
  const parsed = await aiJson<ParsedJd>({
    system:
      "Extract a structured job requisition from a job description. Return ONLY JSON with keys: title, location, " +
      "must_have_skills (string array), good_to_have_skills (string array), responsibilities, education_requirement, " +
      "experience_min (number of years), experience_max (number of years). Use null when a field is genuinely absent. " +
      "Never invent requirements. `title` MUST be the job title a candidate would recognise, such as " +
      "'Senior React Developer' or 'UI/UX Designer' — never the job board, product, tool or company name " +
      "(for example never 'LinkedIn', 'LinkedIn Talent Solutions', 'Recruiter', 'Naukri', 'Indeed', 'Careers'), " +
      "and never a browser tab or page heading. Include seniority when the description states it.",
    prompt: text.slice(0, 20000),
    orgId,
    feature: "jd_parse",
  });
  return parsed.ok ? parsed.data : null;
}

/**
 * Job boards put their own product name in the page title, so a captured role
 * arrived as "LinkedIn Talent Solutions" instead of the job. Reject that kind of
 * chrome, and only keep something that reads like a role.
 */
const BOARD_CHROME =
  /^(\(\d+\)\s*)?(linkedin|linkedin recruiter|linkedin talent solutions?|talent solutions?|recruiter|naukri|naukri recruiter|resdex|indeed|monster|shine|glassdoor|careers?|jobs?|job search|hiring|projects?|my jobs|applicants?|home|dashboard|feed|talent hub|hiring project)\b/i;

export function cleanRoleTitle(raw: string | null | undefined): string | null {
  const value = String(raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/^\(\d+\)\s*/, "")
    // drop the "| LinkedIn" / "- Naukri" suffix boards append
    .replace(/\s*[|·–—-]\s*(linkedin|naukri|indeed|monster|glassdoor|shine)[^|]*$/i, "")
    .trim();
  if (value.length < 3 || value.length > 120) return null;
  if (BOARD_CHROME.test(value)) return null;
  if (!/[a-z]/i.test(value)) return null;
  return value;
}

/** Last resort: the first line of the description that reads like a job title. */
function titleFromText(text: string): string | null {
  for (const line of text.split(/\r?\n/).slice(0, 40)) {
    const candidate = cleanRoleTitle(line.replace(/^[•*\-–\s]+/, ""));
    if (!candidate) continue;
    const words = candidate.split(" ").length;
    if (words >= 2 && words <= 10 && !/[.:;]$/.test(candidate)) return candidate;
  }
  return null;
}

async function nextCaptureCode(orgId: string): Promise<string> {
  const count = await db.$count(requisitions, eq(requisitions.orgId, orgId));
  return `CAP-${String(count + 1).padStart(4, "0")}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

/** Resolve the organisation behind a capture token. */
export async function orgForCaptureToken(
  token: string,
): Promise<{ id: string; name: string; status: string } | null> {
  if (!token || token.length < 20) return null;
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(token).digest("hex");
  const { or } = await import("drizzle-orm");
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, status: organizations.status })
    .from(organizations)
    // Hash match covers encrypted tokens; the plaintext equality is the
    // pre-migration fallback and disappears once every org rotates its key.
    .where(or(eq(organizations.captureTokenHash, hash), eq(organizations.captureToken, token)))
    .limit(1);
  if (!org) return null;
  if (org.status && org.status !== "active") return null;
  return org;
}

export async function capture(input: CaptureInput): Promise<CaptureResult> {
  const org = await orgForCaptureToken(input.token);
  if (!org) return { status: "error", detail: "This capture key is not valid any more." };
  if (input.requisitionId) {
    const { assertRequisitionInOrg } = await import("../server/guards");
    try {
      await assertRequisitionInOrg(input.requisitionId, org.id);
    } catch {
      return { status: "error", detail: "That role is not in your organisation." };
    }
  }

  const log = async (result: CaptureResult) => {
    await db.insert(captureEvents).values({
      orgId: org.id,
      kind: input.kind,
      sourceUrl: input.sourceUrl ?? null,
      title: result.title ?? input.title ?? null,
      status: result.status,
      detail: result.detail,
      candidateId: result.candidateId ?? null,
      requisitionId: result.requisitionId ?? null,
    });
    return result;
  };

  const pageText = (input.text ?? "").trim();
  let text = pageText;
  let fileName = input.file?.filename ?? "captured.txt";
  let fileBytes: Uint8Array | null = null;

  if (input.file?.content) {
    try {
      const { attachmentText } = await import("./cv-text.server");
      fileBytes = base64ToBytes(input.file.content);
      // PDF parsers may transfer/detach the ArrayBuffer they receive. Parse a
      // copy so the original bytes remain intact for the private CV vault.
      const parseBytes = Uint8Array.from(fileBytes);
      const fromFile = (await attachmentText(input.file.filename, parseBytes)).trim();
      // The attached CV is the better source; the page text stays as a fallback
      // and as extra context when the file yields little.
      text = fromFile.length >= 200 ? fromFile : [fromFile, pageText].filter(Boolean).join("\n\n");
      fileName = input.file.filename;
    } catch (e) {
      return log({
        status: "error",
        detail:
          e instanceof Error
            ? `The downloaded CV could not be read: ${e.message}`
            : "That file could not be read.",
      });
    }
  }

  // No file? Keep the readable profile as evidence rather than losing the person;
  // a later capture of the same profile attaches the CV and re-parses everything.
  const profileOnly = input.kind === "cv" && !fileBytes;

  if (text.length < 80) {
    return log({ status: "skipped", detail: "There was not enough readable text on that page." });
  }

  if (input.kind === "cv") {
    try {
      const ingested = await ingestCandidate({
        resumeText: text,
        fileName,
        requisitionId: input.requisitionId ?? null,
        orgId: org.id,
        source: "browser_capture",
        fullName: input.candidateName ?? null,
        identityKey: input.publicProfileUrl ?? input.sourceUrl ?? null,
        profileUrl: input.publicProfileUrl ?? input.sourceUrl ?? null,
        resumeFile: fileBytes ? { filename: fileName, bytes: fileBytes } : null,
        requireResumeStored: false,
        profileOnly: profileOnly || Boolean(input.profileOnly),
      });
      // A vault problem must never lose the person: keep the parsed profile and
      // say plainly why the original file is still missing.
      const vaultNote =
        fileBytes && !ingested.resumeStored
          ? `original CV could not be saved (${ingested.resumeError ?? "unknown reason"}) — profile kept, file pending`
          : fileBytes
            ? "original CV secured"
            : "LinkedIn profile retained — original CV still pending";

      let verificationNote = "verification queued";
      try {
        const { verifyClaims } = await import("./verification.server");
        const verified = await verifyClaims({
          orgId: org.id,
          name: ingested.name,
          resumeText: text,
          skills: ingested.skills,
          linkedinUrl: ingested.linkedinUrl,
          githubUrl: ingested.githubUrl,
          websiteUrl: ingested.websiteUrl,
          linkedinProfileText: pageText || null,
        });
        await db.insert(candidateVerifications).values({
          candidateId: ingested.candidateId,
          authenticityScore: verified.authenticity_score,
          claims: verified.claims,
          redFlags: verified.red_flags,
          evidence: verified.evidence,
          summary: verified.summary,
          model: verified.model,
          status: "ok",
          orgId: org.id,
        });
        verificationNote = `verification ${verified.authenticity_score}/100`;
      } catch (e) {
        console.error("capture verification failed", e);
        verificationNote = "verification needs retry";
      }

      let socialNote = "profile analysis needs retry";
      try {
        const { fetchLinkedinSignal } = await import("./social.server");
        let roleTitle = "Candidate profile";
        let jdSkills: string[] = [];
        if (input.requisitionId) {
          const [requisition] = await db
            .select({
              title: requisitions.title,
              mustHaveSkills: requisitions.mustHaveSkills,
              goodToHaveSkills: requisitions.goodToHaveSkills,
            })
            .from(requisitions)
            .where(eq(requisitions.id, input.requisitionId))
            .limit(1);
          roleTitle = requisition?.title ?? roleTitle;
          jdSkills = [
            ...(requisition?.mustHaveSkills ?? []),
            ...(requisition?.goodToHaveSkills ?? []),
          ];
        }
        const linkedin = await fetchLinkedinSignal({
          orgId: org.id,
          url: ingested.linkedinUrl,
          jobTitle: roleTitle,
          jdSkills,
          resumeText: text,
          profileText: pageText || null,
        });
        if (linkedin) {
          const now = new Date();
          await db
            .insert(socialProfiles)
            .values({
              candidateId: ingested.candidateId,
              orgId: org.id,
              provider: linkedin.provider,
              profileUrl: linkedin.profile_url,
              handle: linkedin.handle,
              score: linkedin.score,
              signals: linkedin.signals,
              rationale: linkedin.rationale,
              status: linkedin.status,
              fetchedAt: now,
              lastSyncedAt: now,
            })
            .onConflictDoUpdate({
              target: [socialProfiles.candidateId, socialProfiles.provider],
              set: {
                orgId: org.id,
                profileUrl: linkedin.profile_url,
                handle: linkedin.handle,
                score: linkedin.score,
                signals: linkedin.signals,
                rationale: linkedin.rationale,
                status: linkedin.status,
                fetchedAt: now,
                lastSyncedAt: now,
              },
            });
          socialNote = `LinkedIn analysis ${linkedin.score}/100`;
        }
      } catch (e) {
        console.error("capture social analysis failed", e);
      }

      if (input.requisitionId) {
        try {
          const { scoreUnscored } = await import("./autoscore.server");
          await scoreUnscored({ orgId: org.id, requisitionId: input.requisitionId, limit: 1 });
        } catch (e) {
          console.error("capture background match failed", e);
        }
      }
      return log({
        status:
          profileOnly || input.profileOnly || !ingested.resumeStored
            ? "stored"
            : ingested.alreadyApplied
              ? "updated"
              : "imported",
        detail: `${ingested.name} (${
          ingested.emailMissing ? "no email on the CV — add it later" : ingested.email
        })${input.requisitionId ? " added to the role" : " filed in the talent pool"}; ${vaultNote}; ${verificationNote}; ${socialNote}.`,
        candidateId: ingested.candidateId,
        requisitionId: input.requisitionId ?? null,
        title: ingested.name,
      });
    } catch (e) {
      return log({
        status: "error",
        detail: e instanceof Error ? e.message : "That CV could not be filed.",
      });
    }
  }

  const p = await parseJd(text, org.id);
  // Prefer the title the model read out of the description; the page title the
  // companion sends is usually the job board's own name.
  const title =
    cleanRoleTitle(p?.title) ??
    cleanRoleTitle(input.title) ??
    titleFromText(text) ??
    "Captured role — needs a title";
  try {
    const [created] = await db
      .insert(requisitions)
      .values({
        orgId: org.id,
        code: await nextCaptureCode(org.id),
        title,
        status: "draft",
        location: p?.location ?? null,
        mustHaveSkills: p?.must_have_skills ?? [],
        goodToHaveSkills: p?.good_to_have_skills ?? [],
        responsibilities: p?.responsibilities ?? text.slice(0, 8000),
        educationRequirement: p?.education_requirement ?? null,
        experienceMin: Number(p?.experience_min ?? 0) || 0,
        experienceMax: Number(p?.experience_max ?? 0) || 0,
      })
      .returning({ id: requisitions.id });
    if (!created) throw new Error("The role could not be saved.");
    return log({
      status: "imported",
      detail: `"${title}" saved as a draft role for review.`,
      requisitionId: created.id,
      title,
    });
  } catch (e) {
    return log({
      status: "error",
      detail: e instanceof Error ? e.message : "That job description could not be saved.",
      title,
    });
  }
}
