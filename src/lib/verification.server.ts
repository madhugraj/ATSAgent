/**
 * Genuineness agent.
 *
 * Social scoring answers "how strong is this candidate's public footprint?".
 * This module answers a different, harder question: "are the projects,
 * presentations and skills written in the CV actually corroborated by public
 * evidence?"
 *
 * It is evidence-bounded on purpose: no public trace is reported as
 * `unverified`, never as fake. Only a direct conflict between the CV and the
 * evidence is `contradicted`.
 */
import { aiJson, INJECTION_RULES, untrusted } from "./ai-gateway.server";
import { harvestProfileLinks } from "./matching.server";

export type ClaimVerdict = "verified" | "partially_verified" | "unverified" | "contradicted";

export type VerifiedClaim = {
  claim: string;
  type: "project" | "skill" | "employer" | "publication" | "certification" | "education" | "other";
  verdict: ClaimVerdict;
  evidence: string;
  source: string;
};

export type VerificationResult = {
  authenticity_score: number;
  claims: VerifiedClaim[];
  red_flags: string[];
  summary: string;
  evidence: {
    /** githubEvidence shape — concrete (serialisable) for server-fn boundaries. */
    github: Awaited<ReturnType<typeof githubEvidence>>;
    pages: { url: string; excerpt: string }[];
    links: Record<string, string | null>;
    linkedin_text: string | null;
  };
  model: string;
};

/** Fields read off the public GitHub REST API responses (all optional). */
type GithubUser = {
  name?: string | null;
  bio?: string | null;
  company?: string | null;
  created_at?: string;
  public_repos?: number;
  followers?: number;
};
type GithubRepo = {
  name?: string | undefined;
  fork?: boolean;
  description?: string | null;
  language?: string | null;
  topics?: string[];
  stargazers_count?: number;
  created_at?: string | undefined;
  pushed_at?: string | undefined;
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function githubHandle(url: string | null | undefined) {
  if (!url) return null;
  return url.match(/github\.com\/([A-Za-z0-9-_.]+)/i)?.[1] ?? null;
}

/** Repo-level GitHub evidence: names, descriptions, topics, languages, recency. */
async function githubEvidence(url: string | null): Promise<{
  handle: string | null;
  name?: string | null;
  bio?: string | null;
  company?: string | null;
  account_created_at?: string | null;
  public_repos?: number;
  followers?: number;
  error?: string;
  repos: GithubRepo[];
} | null> {
  const handle = githubHandle(url);
  if (!handle) return null;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "atsiq",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const [userRes, reposRes] = await Promise.all([
      fetch(`https://api.github.com/users/${handle}`, { headers }),
      fetch(`https://api.github.com/users/${handle}/repos?per_page=100&sort=pushed`, { headers }),
    ]);
    if (!userRes.ok) {
      return { handle, error: `GitHub returned ${userRes.status}`, repos: [] as GithubRepo[] };
    }
    const user = (await userRes.json()) as GithubUser;
    const repos: GithubRepo[] = reposRes.ok ? await reposRes.json() : [];
    return {
      handle,
      name: user.name ?? null,
      bio: user.bio ?? null,
      company: user.company ?? null,
      account_created_at: user.created_at ?? null,
      public_repos: user.public_repos ?? 0,
      followers: user.followers ?? 0,
      repos: repos.slice(0, 40).map((r) => ({
        name: r.name,
        fork: !!r.fork,
        description: r.description ?? null,
        language: r.language ?? null,
        topics: r.topics ?? [],
        stars: r.stargazers_count ?? 0,
        created_at: r.created_at,
        pushed_at: r.pushed_at,
      })),
    };
  } catch (e) {
    return {
      handle,
      error: `GitHub fetch failed: ${(e as Error).message}`,
      repos: [] as GithubRepo[],
    };
  }
}

/** Fetch and flatten portfolio / blog / talk pages so claims can be cross-checked. */
async function pageEvidence(urls: string[]) {
  const { safeFetchText } = await import("../server/safe-fetch");
  const pages: { url: string; excerpt: string }[] = [];
  for (const url of urls.filter(Boolean).slice(0, 4)) {
    try {
      const { text: html } = await safeFetchText(url, { maxBytes: 512_000, timeoutMs: 10_000 });
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push({ url, excerpt: text.slice(0, 5000) || "EMPTY PAGE" });
    } catch (e) {
      // Blocked SSRF attempts read as ordinary unreachability — no detail.
      pages.push({ url, excerpt: "UNREACHABLE" });
    }
  }
  return pages;
}

export async function verifyClaims(opts: {
  orgId?: string | null | undefined;
  name: string;
  resumeText: string | null | undefined;
  skills: string[];
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  websiteUrl?: string | null;
  xUrl?: string | null;
  linkedinProfileText?: string | null;
}): Promise<VerificationResult> {
  const harvested = harvestProfileLinks(opts.resumeText);
  const links = {
    githubUrl: opts.githubUrl || harvested.githubUrl,
    linkedinUrl: opts.linkedinUrl || harvested.linkedinUrl,
    websiteUrl: opts.websiteUrl || harvested.websiteUrl,
    xUrl: opts.xUrl || harvested.xUrl,
  };

  const [github, pages] = await Promise.all([
    githubEvidence(links.githubUrl),
    pageEvidence([links.websiteUrl ?? "", links.xUrl ?? ""]),
  ]);

  const ai = await aiJson<{
    authenticity_score: number;
    claims: VerifiedClaim[];
    red_flags: string[];
    summary: string;
  }>({
    feature: "claim_verify",
    system:
      INJECTION_RULES +
      "\nYou are a hiring-integrity analyst. Extract the concrete claims from a candidate's CV " +
      "(projects, technologies, employers, publications/talks, certifications, education, dates) and " +
      "cross-check each one ONLY against the supplied public evidence: GitHub repositories (names, " +
      "descriptions, topics, languages, created/pushed dates), fetched portfolio/blog/X pages, and any " +
      "professional profile text on file.\n" +
      "Rules: (1) 'verified' needs a specific evidence match you can quote. (2) 'partially_verified' when " +
      "the evidence is adjacent but not conclusive. (3) 'unverified' when there is no public trace — this " +
      "is NOT an accusation and must never be worded as fraud. (4) 'contradicted' only for a direct " +
      "conflict (e.g. a flagship project dated before the GitHub account existed, a repo that is an " +
      "unmodified fork or tutorial clone presented as original work, a title that conflicts with the " +
      "profile text). (5) Pages marked UNREACHABLE or EMPTY PAGE are evidence of a dead/placeholder link. " +
      "authenticity_score: start from the share of material claims that are verified or partially " +
      "verified, penalise contradictions heavily, and penalise a CV whose flagship claims have zero " +
      "public trace only mildly. red_flags are short recruiter-facing strings. " +
      "Return ONLY JSON with keys: authenticity_score (0-100), claims (array of {claim, type, verdict, " +
      "evidence, source}), red_flags (string array), summary (3-4 sentences).",
    prompt: untrusted(
      "candidate_and_evidence",
      JSON.stringify({
        candidate: {
          name: opts.name,
          skills_claimed: opts.skills,
          resume_text: (opts.resumeText ?? "").slice(0, 14000),
          linkedin_profile_text: opts.linkedinProfileText ?? null,
          links,
        },
        evidence: { github, pages },
      }),
    ),
    orgId: opts.orgId,
  });

  if (!ai.ok) throw new Error(ai.message);

  const redFlags = [...(ai.data.red_flags ?? [])];
  if (!github) redFlags.push("No GitHub profile on file — technical claims cannot be corroborated");
  else if ("error" in github) redFlags.push(`GitHub evidence unavailable: ${github.error}`);
  if (pages.some((p) => p.excerpt.startsWith("UNREACHABLE")))
    redFlags.push("A portfolio/writing link on the CV could not be opened");
  if (!links.linkedinUrl) redFlags.push("No professional profile link on file");

  return {
    authenticity_score: clamp(ai.data.authenticity_score),
    claims: (ai.data.claims ?? []).map((c) => ({
      claim: c.claim,
      type: c.type ?? "other",
      verdict: c.verdict ?? "unverified",
      evidence: c.evidence ?? "",
      source: c.source ?? "",
    })),
    red_flags: [...new Set(redFlags)],
    summary: ai.data.summary,
    evidence: {
      github: github ?? null,
      pages,
      links,
      linkedin_text: opts.linkedinProfileText ?? null,
    },
    model: ai.model,
  };
}
