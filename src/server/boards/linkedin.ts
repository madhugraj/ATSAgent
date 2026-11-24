/**
 * LinkedIn board adapter.
 *
 * Wraps the organisation's own OAuth connection (linkedin.server.ts). The
 * Jobs-board write path (/rest/jobPostings) is partner-gated: probeCapabilities
 * asks LinkedIn what the contract actually opens, and publishing refuses
 * honestly until the Job Posting product answers 200 — the feed-post designer
 * on the requisition page remains the always-available fallback.
 */
import { safeFetch } from "../safe-fetch";
import type { LinkedinCapability } from "../../lib/linkedin.server";
import {
  LinkedinAuthError,
  postAsMember,
  probeCapabilities,
  REST_VERSION,
} from "../../lib/linkedin.server";
import {
  integrationConfig,
  type BoardAdapter,
  type BoardCapabilities,
  type BoardConnection,
  type NormalizedApplication,
  type PublishOutcome,
  type RequisitionSnapshot,
} from "./types";

const API_URL = "https://api.linkedin.com";

function restHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": REST_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

/** Compose a readable listing description from the requisition itself. */
export function listingDescription(
  requisition: RequisitionSnapshot,
  postText: string | null,
): string {
  if (postText?.trim()) return postText.trim();
  const lines: string[] = [];
  if (requisition.location) lines.push(`Location: ${requisition.location}`);
  lines.push(
    `Experience: ${requisition.experienceMin}–${requisition.experienceMax} years`,
    "",
    "Must have:",
    ...requisition.mustHaveSkills.map((s) => `• ${s}`),
  );
  if (requisition.goodToHaveSkills.length) {
    lines.push("", "Good to have:", ...requisition.goodToHaveSkills.map((s) => `• ${s}`));
  }
  if (requisition.responsibilities) {
    lines.push("", "About the role:", requisition.responsibilities.slice(0, 4000));
  }
  return lines.join("\n");
}

async function capabilitiesImpl(conn: BoardConnection): Promise<BoardCapabilities> {
  if (!conn.accessToken) {
    return {
      posting: null,
      applications: null,
      applicationsMode: "none",
      detail: "Connect the organisation's LinkedIn account first.",
    };
  }
  let probes: LinkedinCapability[];
  try {
    probes = await probeCapabilities(conn.accessToken, integrationConfig(conn, "scope") || null);
  } catch (e) {
    return {
      posting: null,
      applications: null,
      applicationsMode: "none",
      detail:
        e instanceof LinkedinAuthError
          ? e.message
          : "LinkedIn did not answer the capability check — try again in a moment.",
    };
  }
  const posting = probes.find((p) => p.id === "job_postings");
  const applications = probes.find((p) => p.id === "applications");
  // Without the Job Posting product the role still goes out as a post on the
  // connected member's feed with the apply link (the same as the page's
  // "Publish to LinkedIn"); applicants come back through that link.
  const feed =
    !posting?.ready && Boolean(conn.memberSub) && !integrationConfig(conn, "organization_urn");
  if (feed)
    return {
      posting: true,
      applications: null,
      applicationsMode: "none",
      detail:
        "Posts on the connected member's LinkedIn feed with your apply link; applicants come back through that link. Jobs-board listings need LinkedIn's Job Posting product.",
    };
  return {
    posting: posting?.ready ?? null,
    applications: applications?.ready ?? null,
    applicationsMode: applications?.ready ? "polling" : "none",
    detail: [posting?.detail, applications?.detail].filter(Boolean).join(" "),
  };
}

async function publishPostingImpl(
  conn: BoardConnection,
  input: { requisition: RequisitionSnapshot; postText: string | null; applyUrl: string },
): Promise<PublishOutcome> {
  if (!conn.accessToken) throw new Error("Connect the organisation's LinkedIn account first.");
  const organizationUrn = integrationConfig(conn, "organization_urn");
  if (!organizationUrn) {
    // No Job Posting contract: a feed post as the connected member, with the apply link.
    if (!conn.memberSub) throw new Error("Reconnect LinkedIn on the Integrations page first.");
    const base = listingDescription(input.requisition, input.postText);
    const text = (
      base.includes(input.applyUrl) ? base : `${base}\n\nApply: ${input.applyUrl}`
    ).slice(0, 3000);
    const urn = await postAsMember(conn.accessToken, conn.memberSub, text);
    return {
      externalId: urn,
      externalUrl: urn ? `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}` : null,
    };
  }

  const body = {
    title: input.requisition.title,
    description: listingDescription(input.requisition, input.postText),
    company: organizationUrn,
    companyApplyUrl: input.applyUrl,
    listedAt: Date.now(),
    jobPostingStatus: "LISTED",
    location: input.requisition.location ?? undefined,
  };
  const res = await safeFetch(`${API_URL}/rest/jobPostings`, {
    method: "POST",
    headers: { ...restHeaders(conn.accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 201 || res.status === 200) {
    const externalId = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
    return { externalId, externalUrl: null };
  }
  const text = await res.text();
  if (res.status === 401) throw new LinkedinAuthError();
  if (res.status === 403 || res.status === 422) {
    throw new Error(
      `LinkedIn declined the listing (${res.status}). The Job Posting product may not cover this contract — ${text.slice(0, 200)}`,
    );
  }
  throw new Error(`LinkedIn job posting failed [${res.status}]: ${text.slice(0, 200)}`);
}

async function closePostingImpl(
  conn: BoardConnection,
  externalId: string,
  reason: "filled" | "closed" | "withdrawn",
): Promise<void> {
  if (!conn.accessToken) throw new Error("Connect the organisation's LinkedIn account first.");
  // A feed post is not a listing: it stays on the member's feed (the apply link closes with the role).
  if (/^urn:li:(share|ugcPost):/.test(externalId)) return;
  const res = await safeFetch(`${API_URL}/rest/jobPostings/${encodeURIComponent(externalId)}`, {
    method: "PATCH",
    headers: { ...restHeaders(conn.accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ jobPostingStatus: reason === "filled" ? "FILLED" : "CLOSED" }),
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`LinkedIn could not close the listing [${res.status}]: ${text.slice(0, 200)}`);
  }
}

async function pollApplicationsImpl(
  conn: BoardConnection,
  opts: { since: Date | null; limit: number },
): Promise<NormalizedApplication[]> {
  if (!conn.accessToken) return [];
  const path = integrationConfig(conn, "applications_path") || "/rest/jobApplications";
  const params = new URLSearchParams({ start: "0", count: String(Math.min(opts.limit, 50)) });
  const res = await safeFetch(`${API_URL}${path}?${params.toString()}`, {
    headers: restHeaders(conn.accessToken),
  });
  if (res.status === 401) throw new LinkedinAuthError();
  if (!res.ok) throw new Error(`LinkedIn applications pull failed [${res.status}].`);
  const text = await res.text();
  const parsed = JSON.parse(text) as {
    elements?: Record<string, unknown>[];
  } | null;
  return (parsed?.elements ?? []).map(mapLinkedInApplication);
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function mapLinkedInApplication(raw: Record<string, unknown>): NormalizedApplication {
  const applicant = (raw["applicant"] as Record<string, unknown> | undefined) ?? {};
  return {
    externalEventId:
      firstString(raw, ["id", "applicationUrn", "applicationId"]) ?? crypto.randomUUID(),
    externalCandidateId: firstString(applicant, ["id", "applicantUrn"]),
    fullName: firstString(applicant, ["fullName", "name", "fullNameLocalized"]),
    email: firstString(applicant, ["email", "emailAddress"]),
    phone: firstString(applicant, ["phone", "phoneNumber"]),
    location: null,
    resumeText: null,
    resumeUrl: firstString(raw, ["resumeUrl", "cvUrl"]),
    postingExternalId: firstString(raw, ["jobPostingUrn", "jobPosting", "jobId"]),
    appliedAt: typeof raw["listedAt"] === "number" ? new Date(raw["listedAt"] as number) : null,
    raw,
  };
}

async function verifyDeliveryImpl(): Promise<{ ok: boolean; reason?: string }> {
  return {
    ok: false,
    reason:
      "LinkedIn does not deliver applicants to this endpoint. Applications arrive through your ATSIQ apply link, or through the partner sync once your contract opens it.",
  };
}

async function mapApplicationImpl(
  payload: unknown,
  conn: BoardConnection,
): Promise<NormalizedApplication | null> {
  if (!payload || typeof payload !== "object") return null;
  return mapLinkedInApplication(payload as Record<string, unknown>);
}

export const linkedinAdapter: BoardAdapter = {
  provider: "linkedin",
  capabilities: capabilitiesImpl,
  publishPosting: publishPostingImpl,
  closePosting: closePostingImpl,
  pollApplications: pollApplicationsImpl,
  verifyDelivery: verifyDeliveryImpl,
  mapApplication: mapApplicationImpl,
};
