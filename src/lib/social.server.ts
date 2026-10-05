import { aiJson, INJECTION_RULES, untrusted } from "./ai-gateway.server";

export type SocialSignal = {
  provider: "github" | "linkedin" | "writing";
  profile_url: string | null;
  handle: string | null;
  score: number;
  /** Serialisable sub-scores/details; kept concrete so SocialSignal can cross server-fn boundaries. */
  signals: Record<string, string | number | null | string[] | Record<string, number>>;
  rationale: string;
  status: "ok" | "unavailable" | "error";
  raw?: {
    login?: string | undefined;
    name?: string | null | undefined;
    bio?: string | null | undefined;
    company?: string | null | undefined;
    blog?: string | null | undefined;
  };
};

/** Fields read off the public GitHub REST API responses (all optional). */
type GithubUser = {
  login?: string;
  name?: string | null;
  bio?: string | null;
  company?: string | null;
  blog?: string | null;
  followers?: number;
  updated_at?: string;
};
type GithubRepo = {
  fork?: boolean;
  stargazers_count?: number;
  language?: string | null;
  pushed_at?: string;
};
type GithubEvent = { created_at?: string };

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function githubHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/github\.com\/([A-Za-z0-9-_.]+)/i);
  return m?.[1] ?? (/^[A-Za-z0-9-_.]+$/.test(url) ? url : null);
}

function linkedinHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/in\/([A-Za-z0-9-_%]+)/i);
  return m?.[1] ?? null;
}

/**
 * Real-time GitHub read via the public REST API.
 * A GITHUB_TOKEN (optional) raises the rate limit from 60 to 5000 req/hour.
 */
export async function fetchGithubSignal(
  url: string | null,
  jdSkills: string[],
): Promise<SocialSignal | null> {
  const handle = githubHandle(url);
  if (!handle) return null;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "atsiq",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const base = "https://api.github.com";
  const fail = (message: string, status: SocialSignal["status"] = "error"): SocialSignal => ({
    provider: "github",
    profile_url: url,
    handle,
    score: 0,
    signals: { error: message },
    rationale: message,
    status,
  });

  try {
    const [userRes, reposRes, eventsRes] = await Promise.all([
      fetch(`${base}/users/${handle}`, { headers }),
      fetch(`${base}/users/${handle}/repos?per_page=100&sort=pushed`, { headers }),
      fetch(`${base}/users/${handle}/events/public?per_page=100`, { headers }),
    ]);

    if (userRes.status === 404) return fail("GitHub profile not found.", "unavailable");
    if (userRes.status === 403)
      return fail("GitHub rate limit reached — add a GitHub token to raise it.", "unavailable");
    if (!userRes.ok) return fail(`GitHub returned ${userRes.status}.`);

    const user = (await userRes.json()) as GithubUser;
    const repos: GithubRepo[] = reposRes.ok ? await reposRes.json() : [];
    const events: GithubEvent[] = eventsRes.ok ? await eventsRes.json() : [];

    const owned = repos.filter((r) => !r.fork);
    const stars = owned.reduce((sum, r) => sum + (r.stargazers_count ?? 0), 0);
    const languages = [...new Set(owned.map((r) => r.language).filter(Boolean))] as string[];
    const months = new Set(
      events.map((e) => String(e.created_at ?? "").slice(0, 7)).filter(Boolean),
    );
    const lastPush = owned[0]?.pushed_at ?? user.updated_at ?? null;
    const daysSincePush = lastPush
      ? Math.round((Date.now() - new Date(lastPush).getTime()) / 86_400_000)
      : null;

    const wanted = jdSkills.map((s) => s.toLowerCase());
    const langOverlap = languages.filter((l) =>
      wanted.some((w) => w.includes(l.toLowerCase()) || l.toLowerCase().includes(w)),
    );

    // Deterministic, explainable sub-scores (each out of its cap).
    const volume = Math.min(25, owned.length * 2.5);
    const quality = Math.min(20, Math.log10(stars + 1) * 12);
    const reach = Math.min(15, Math.log10((user.followers ?? 0) + 1) * 8);
    const consistency = Math.min(25, months.size * 3);
    const relevance = Math.min(15, langOverlap.length * 6 + (langOverlap.length ? 3 : 0));
    const recencyPenalty = daysSincePush !== null && daysSincePush > 365 ? 10 : 0;
    const score = clamp(volume + quality + reach + consistency + relevance - recencyPenalty);

    return {
      provider: "github",
      profile_url: url,
      handle,
      score,
      signals: {
        public_repos: owned.length,
        total_stars: stars,
        followers: user.followers ?? 0,
        active_months_recent: months.size,
        days_since_last_push: daysSincePush,
        top_languages: languages.slice(0, 6),
        jd_language_overlap: langOverlap,
        components: {
          volume: Math.round(volume),
          quality: Math.round(quality),
          reach: Math.round(reach),
          consistency: Math.round(consistency),
          jd_relevance: Math.round(relevance),
          recency_penalty: -recencyPenalty,
        },
      },
      rationale:
        `${owned.length} original repos, ${stars} stars, ${user.followers ?? 0} followers, ` +
        `activity in ${months.size} recent month(s). ` +
        (langOverlap.length
          ? `Languages overlap the JD on ${langOverlap.join(", ")}.`
          : "No language overlap with the JD must-haves."),
      status: "ok",
      raw: {
        login: user.login,
        name: user.name,
        bio: user.bio,
        company: user.company,
        blog: user.blog,
      },
    };
  } catch (e) {
    return fail(`GitHub fetch failed: ${(e as Error).message}`);
  }
}

/**
 * LinkedIn: the LinkedIn API only exposes the *connected member's* own profile,
 * so third-party candidate profiles cannot be read programmatically. We score
 * the career narrative the recruiter has on file (resume + pasted profile text)
 * against the JD, and flag the profile as needing manual verification.
 */
export async function fetchLinkedinSignal(opts: {
  url: string | null;
  jobTitle: string;
  jdSkills: string[];
  resumeText: string | null;
  profileText?: string | null;
  orgId?: string | null | undefined;
}): Promise<SocialSignal | null> {
  const handle = linkedinHandle(opts.url);
  if (!opts.url) return null;

  const result = await aiJson<{
    score: number;
    tenure_stability: string;
    progression: string;
    headline_alignment: string;
    rationale: string;
  }>({
    feature: "linkedin_signal",
    system:
      INJECTION_RULES +
      "\nYou are a talent-intelligence analyst scoring a candidate's professional/LinkedIn narrative against a job description. " +
      "Score 0-100 on career progression, tenure stability, seniority trajectory and headline/role alignment. " +
      "Be conservative when evidence is thin. Return ONLY JSON with keys: score, tenure_stability, progression, headline_alignment, rationale.",
    prompt: untrusted(
      "profile_pages",
      JSON.stringify({
        target_role: opts.jobTitle,
        jd_must_have_skills: opts.jdSkills,
        linkedin_url: opts.url,
        profile_text: opts.profileText ?? null,
        resume_text: opts.resumeText?.slice(0, 6000) ?? null,
      }),
    ),
    orgId: opts.orgId,
  });

  if (!result.ok) {
    return {
      provider: "linkedin",
      profile_url: opts.url,
      handle,
      score: 0,
      signals: { error: result.message },
      rationale: result.message,
      status: "error",
    };
  }

  return {
    provider: "linkedin",
    profile_url: opts.url,
    handle,
    score: clamp(result.data.score),
    signals: {
      tenure_stability: result.data.tenure_stability,
      progression: result.data.progression,
      headline_alignment: result.data.headline_alignment,
      source: opts.profileText ? "recruiter-supplied profile text" : "resume narrative",
    },
    rationale: result.data.rationale,
    status: "ok",
  };
}

/** Public writing / portfolio / X — page is fetched live, then scored by AI. */
export async function fetchWritingSignal(opts: {
  urls: string[];
  jobTitle: string;
  jdSkills: string[];
  orgId?: string | null | undefined;
}): Promise<SocialSignal | null> {
  const urls = opts.urls.filter(Boolean);
  if (!urls.length) return null;

  const pages: { url: string; excerpt: string }[] = [];
  const { safeFetchText } = await import("../server/safe-fetch");
  for (const url of urls.slice(0, 3)) {
    try {
      const { text: html } = await safeFetchText(url, { maxBytes: 512_000, timeoutMs: 10_000 });
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) pages.push({ url, excerpt: text.slice(0, 4000) });
    } catch {
      /* unreachable or blocked page is simply not scored */
    }
  }

  if (!pages.length) {
    return {
      provider: "writing",
      profile_url: urls[0] ?? null,
      handle: null,
      score: 0,
      signals: { fetched: 0, attempted: urls.length },
      rationale: "None of the supplied portfolio/writing links could be read.",
      status: "unavailable",
    };
  }

  const result = await aiJson<{ score: number; themes: string[]; rationale: string }>({
    feature: "writing_signal",
    system:
      INJECTION_RULES +
      "\nYou score a candidate's public writing/portfolio for domain relevance, depth and communication quality against a role. " +
      "Return ONLY JSON with keys: score (0-100), themes (string array), rationale.",
    prompt: untrusted(
      "profile_pages",
      JSON.stringify({
        target_role: opts.jobTitle,
        jd_must_have_skills: opts.jdSkills,
        pages,
      }),
    ),
    orgId: opts.orgId,
  });

  if (!result.ok) {
    return {
      provider: "writing",
      profile_url: urls[0] ?? null,
      handle: null,
      score: 0,
      signals: { error: result.message },
      rationale: result.message,
      status: "error",
    };
  }

  return {
    provider: "writing",
    profile_url: urls[0] ?? null,
    handle: null,
    score: clamp(result.data.score),
    signals: { pages_read: pages.map((p) => p.url), themes: result.data.themes },
    rationale: result.data.rationale,
    status: "ok",
  };
}

/** Blended social score: GitHub 45%, LinkedIn 40%, writing 15% — renormalised over available sources. */
export function blendSocial(signals: SocialSignal[]): { score: number; basis: string } {
  const weightFor = (p: SocialSignal["provider"]) =>
    p === "github" ? 45 : p === "linkedin" ? 40 : 15;
  const usable = signals.filter((s) => s.status === "ok");
  if (!usable.length) return { score: 0, basis: "No usable public profile signals." };
  const totalWeight = usable.reduce((sum, s) => sum + weightFor(s.provider), 0);
  const score = clamp(
    usable.reduce((sum, s) => sum + s.score * weightFor(s.provider), 0) / totalWeight,
  );
  return {
    score,
    basis: usable
      .map(
        (s) =>
          `${s.provider} ${s.score} (${Math.round((weightFor(s.provider) / totalWeight) * 100)}% of social)`,
      )
      .join(", "),
  };
}
