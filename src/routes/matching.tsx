import { Link, useRouter } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { useNavCtx } from "@/hooks/useNavCtx";
import { ChevronDown, Github, Linkedin, Loader2, PenLine, Target, UserPlus } from "lucide-react";
import { z } from "zod";

import {
  applicationsQuery,
  candidatesQuery,
  jdQuery,
  latestScores,
  matchScoresQuery,
  requisitionsQuery,
  socialProfilesQuery,
} from "@/lib/data";
import {
  listEnabledJobBoards,
  matchJdToCv,
  matchPipeline,
  persistMatchResult,
  saveRecruiterOverride,
  type MatchWire,
} from "@/lib/matching.functions";
import { addApplicationsToRequisition } from "@/lib/requisitions.functions";
import { moveStage } from "@/lib/lifecycle.functions";
import { importCandidates } from "@/lib/integrations.functions";
import { balanceWeights } from "@/lib/cv-extract";
import { rankPool } from "@/lib/shortlist";

import {
  EmptyState,
  PageHeader,
  ScoreBar,
  ScoreChip,
  SkillPills,
  educationLabel,
} from "@/components/ats";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/matching")({
  validateSearch: z.object({ req: z.string().optional() }),
  head: () => ({
    meta: [
      { title: "JD ↔ CV Matching Engine with Social Profiling — ATS" },
      {
        name: "description",
        content:
          "Weighted JD to CV matching: semantic skill mapping, deterministic experience bands, education fit and live GitHub, LinkedIn and public-writing social scores.",
      },
      { property: "og:title", content: "JD ↔ CV Matching Engine with Social Profiling" },
      {
        property: "og:description",
        content:
          "Auditable match scores with evidence, risk flags and recruiter override on every candidate.",
      },
    ],
  }),
  component: Matching,
});

type Weights = {
  skills: number;
  experience: number;
  career: number;
  impact: number;
  education: number;
  social: number;
};

const WEIGHT_LABELS: Record<keyof Weights, string> = {
  skills: "Skills fit",
  experience: "Experience",
  career: "Career history",
  impact: "Impact & innovation",
  education: "Education",
  social: "Social profiling",
};

/** Social signals are re-used for this many days instead of being re-fetched. */
const SOCIAL_TTL_DAYS = 14;

/** Map a live MatchResult onto the match_scores columns the server fn writes. */
function scoreInput(result: MatchWire) {
  return {
    skillsScore: result.skills_score,
    experienceScore: result.experience_score,
    careerScore: result.career_score,
    impactScore: result.impact_score,
    innovationScore: result.innovation_score,
    educationScore: result.education_score,
    socialScore: result.social_score,
    overallScore: result.overall_score,
    weights: result.weights,
    matchedSkills: result.matched_skills,
    missingSkills: result.missing_skills,
    rationale: result.rationale,
    riskFlags: result.risk_flags,
    customScores: result.custom_scores,
    recommendation: result.recommendation,
    careerMetrics: result.career.metrics,
    careerFlags: result.career.assessment.flags,
    logisticsFlags: [...(result.logistics?.flags ?? []), ...(result.logistics?.blockers ?? [])],
    impactHighlights: result.impact.highlights,
    innovationSignals: result.impact.innovation_signals,
  };
}

/** Fresh social signals from a result, in the shape the upsert expects. */
function socialInput(result: MatchWire) {
  return result.social.signals.map((s) => ({
    provider: s.provider,
    profileUrl: s.profile_url,
    handle: s.handle,
    score: s.score,
    signals: s.signals,
    rationale: s.rationale,
    status: s.status,
  }));
}

function Matching() {
  const router = useRouter();
  const { req } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { leadership } = useNavCtx();
  const qc = useQueryClient();

  const reqs = useQuery(requisitionsQuery);
  const apps = useQuery(applicationsQuery);
  const cands = useQuery(candidatesQuery);
  const scores = useQuery(matchScoresQuery);
  const socials = useQuery(socialProfilesQuery);
  const runMatch = useServerFn(matchJdToCv);
  const runPipeline = useServerFn(matchPipeline);
  const runImport = useServerFn(importCandidates);
  const boards = useQuery({
    queryKey: ["source_integrations", "enabled"],
    queryFn: async () => (await listEnabledJobBoards()) ?? [],
  });

  const requisitions = reqs.data ?? [];
  const activeId = req ?? requisitions[0]?.id ?? "";
  const requisition = requisitions.find((r) => r.id === activeId);
  const jds = useQuery({ ...jdQuery(activeId), enabled: Boolean(activeId) });
  const jd = (jds.data ?? [])[0];

  const [weights, setWeights] = useState<Weights | null>(null);
  const [includeSocial, setIncludeSocial] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, MatchWire>>({});
  const [overrideReason, setOverrideReason] = useState("");
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [rescoreAll, setRescoreAll] = useState(false);
  const [board, setBoard] = useState("");
  const [importing, setImporting] = useState(false);
  const [addingFromPool, setAddingFromPool] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [poolQuery, setPoolQuery] = useState("");
  const [minFit, setMinFit] = useState("60");

  function toggleSelected(applicationId: string, on: boolean) {
    setSelected((prev) =>
      on ? [...new Set([...prev, applicationId])] : prev.filter((id) => id !== applicationId),
    );
  }

  const effWeights: Weights = weights ?? {
    skills: requisition?.weight_skills ?? 40,
    experience: requisition?.weight_experience ?? 15,
    career: requisition?.weight_career ?? 10,
    impact: requisition?.weight_impact ?? 10,
    education: requisition?.weight_education ?? 10,
    social: requisition?.weight_social ?? 15,
  };
  /** The requisition's own dimensions, defined with the weights on its page. */
  const customDimensions =
    (
      requisition as {
        custom_weights?: { key: string; label: string; hint: string; weight: number }[];
      }
    )?.custom_weights ?? [];
  const weightTotal =
    (Object.keys(effWeights) as (keyof Weights)[]).reduce((s, k) => s + effWeights[k], 0) +
    customDimensions.reduce((s, d) => s + d.weight, 0);

  /** Set one weight and spread the remaining points across the others, keeping the total at 100. */
  function setWeight(key: keyof Weights, raw: number) {
    const value = Math.max(0, Math.min(100, Math.round(Number.isFinite(raw) ? raw : 0)));
    const others = (Object.keys(effWeights) as (keyof Weights)[]).filter((k) => k !== key);
    const otherTotal = others.reduce((s, k) => s + effWeights[k], 0);
    const remaining = 100 - value;
    const next = { ...effWeights, [key]: value } as Weights;

    if (otherTotal === 0) {
      const n = others.length;
      others.forEach((k, i) => (next[k] = Math.floor(remaining / n) + (i < remaining % n ? 1 : 0)));
    } else {
      let assigned = 0;
      others.forEach((k, i) => {
        const v =
          i === others.length - 1
            ? remaining - assigned
            : Math.round((effWeights[k] / otherTotal) * remaining);
        next[k] = Math.max(0, v);
        assigned += next[k];
      });
    }
    setWeights(next);
  }

  const scoreMap = latestScores(scores.data ?? []);
  const pipeline = useMemo(() => {
    const rows = (apps.data ?? [])
      .filter((a) => a.requisition_id === activeId)
      .map((a) => ({
        app: a,
        candidate: (cands.data ?? []).find((c) => c.id === a.candidate_id),
        stored: scoreMap.get(a.id),
        live: results[a.id],
      }));
    return rows.sort((x, y) => {
      const xs = x.live?.overall_score ?? x.stored?.overall_score ?? -1;
      const ys = y.live?.overall_score ?? y.stored?.overall_score ?? -1;
      return ys - xs;
    });
  }, [apps.data, cands.data, scoreMap, results, activeId]);

  /** Every unattached person in the pool, pre-ranked against this JD. */
  const poolRanked = useMemo(() => {
    if (!requisition) return [];
    const attached = new Set(pipeline.map((row) => row.app.candidate_id));
    return rankPool(
      (cands.data ?? []).filter((candidate) => !attached.has(candidate.id)),
      requisition,
    );
  }, [cands.data, pipeline, requisition]);

  /** Only the probable CVs: above the fit floor, optionally narrowed by a keyword. */
  const suggestedPool = useMemo(() => {
    const q = poolQuery.trim().toLowerCase();
    const floor = Number(minFit) || 0;
    return poolRanked
      .filter((row) => row.fit >= floor)
      .filter((row) =>
        q
          ? [
              row.candidate.full_name,
              row.candidate.location ?? "",
              (row.candidate.skills ?? []).join(" "),
            ]
              .join(" ")
              .toLowerCase()
              .includes(q)
          : true,
      )
      .slice(0, 50);
  }, [poolRanked, poolQuery, minFit]);

  async function addFromTalentPool(candidateIds: string[]) {
    if (!requisition || candidateIds.length === 0) return;
    setAddingFromPool(true);
    try {
      await addApplicationsToRequisition({
        data: { requisitionId: requisition.id, candidateIds, source: "talent_pool" },
      });
      await qc.invalidateQueries({ queryKey: ["applications"] });
      toast.success(
        `${candidateIds.length} candidate${candidateIds.length === 1 ? "" : "s"} added to the pipeline`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add candidates");
    } finally {
      setAddingFromPool(false);
    }
  }

  async function score(applicationId: string) {
    const row = pipeline.find((p) => p.app.id === applicationId);
    if (!row?.candidate || !requisition) return;
    if (weightTotal !== 100) {
      toast.error("Weights must total 100 before scoring");
      return;
    }
    setRunning(applicationId);
    try {
      const result = await runMatch({
        data: {
          jd: {
            title: requisition.title,
            mustHave: jd?.must_have?.length ? jd.must_have : requisition.must_have_skills,
            goodToHave: jd?.good_to_have?.length
              ? jd.good_to_have
              : requisition.good_to_have_skills,
            responsibilities: jd?.responsibilities ?? requisition.responsibilities,
            education: requisition.education_requirement,
            experienceMin: requisition.experience_min,
            experienceMax: requisition.experience_max,
            jdText: jd?.full_text ?? null,
            constraints: {
              ctcBandMin: requisition.ctc_band_min ? Number(requisition.ctc_band_min) : null,
              ctcBandMax: requisition.ctc_band_max ? Number(requisition.ctc_band_max) : null,
              maxNoticePeriodDays: requisition.max_notice_period_days,
              locations: requisition.location ? [requisition.location] : null,
              workAuthorizationRequired: requisition.work_authorization_required,
            },
          },
          candidate: {
            name: row.candidate.full_name,
            skills: row.candidate.skills,
            experienceYears: Number(row.candidate.experience_years),
            education: row.candidate.education,
            resumeText: row.candidate.resume_text,
            linkedinUrl: row.candidate.linkedin_url,
            githubUrl: row.candidate.github_url,
            websiteUrl: row.candidate.website_url,
            xUrl: row.candidate.x_url,
            noticePeriodDays: row.candidate.notice_period_days,
            currentCtc: row.candidate.current_ctc ? Number(row.candidate.current_ctc) : null,
            expectedCtc: row.candidate.expected_ctc ? Number(row.candidate.expected_ctc) : null,
            location: row.candidate.location,
            preferredLocations: row.candidate.preferred_locations ?? null,
            willingToRelocate: row.candidate.willing_to_relocate,
            workAuthorization: row.candidate.work_authorization,
          },
          weights: effWeights,
          customDimensions,
          includeSocial,
        },
      });

      setResults((prev) => ({ ...prev, [applicationId]: result }));
      setExpanded(applicationId);

      await persistMatchResult({
        data: {
          applicationId,
          autoShortlist: result.recommendation === "select" && row.app.stage === "applied",
          socialSignals: socialInput(result),
          score: scoreInput(result),
        },
      });

      qc.invalidateQueries({ queryKey: ["match_scores"] });
      qc.invalidateQueries({ queryKey: ["social_profiles"] });
      qc.invalidateQueries({ queryKey: ["applications"] });
      toast.success(`${row.candidate.full_name} scored ${result.overall_score}/100`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Matching failed");
    } finally {
      setRunning(null);
    }
  }

  async function importApplicants() {
    if (!board || !requisition) return;
    setImporting(true);
    try {
      const res = await runImport({
        data: {
          provider: board as "naukri" | "indeed" | "linkedin",
          requisitionId: requisition.id,
          limit: 10,
        },
      });
      toast.success(`${res.imported} of ${res.found} candidates imported from ${board}.`);
      qc.invalidateQueries({ queryKey: ["candidates"] });
      qc.invalidateQueries({ queryKey: ["applications"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  /** Reuse a social signal we already fetched for this candidate if it is fresh. */
  function cachedSocialFor(candidateId: string) {
    const ttl = SOCIAL_TTL_DAYS * 86_400_000;
    return (socials.data ?? [])
      .filter(
        (s) =>
          s.candidate_id === candidateId &&
          s.status === "ok" &&
          Date.now() - new Date(s.fetched_at).getTime() < ttl,
      )
      .map((s) => ({
        provider: s.provider,
        profile_url: s.profile_url,
        handle: s.handle,
        score: s.score,
        signals: s.signals,
        rationale: s.rationale,
        status: s.status,
      }));
  }

  async function persistResult(applicationId: string, stage: string, result: MatchWire) {
    await persistMatchResult({
      data: {
        applicationId,
        autoShortlist: result.recommendation === "select" && stage === "applied",
        socialSignals: result.social.cached ? undefined : socialInput(result),
        score: scoreInput(result),
      },
    });
  }

  /** One JD vs many CVs: bounded concurrency, cached social signals, per-row error isolation. */
  async function scoreAll(applicationIds?: string[]) {
    if (!requisition) return;
    if (weightTotal !== 100) {
      toast.error("Weights must total 100 before scoring");
      return;
    }
    const explicit = applicationIds?.length ? new Set(applicationIds) : null;
    const targets = pipeline.filter(
      (r) =>
        r.candidate && (explicit ? explicit.has(r.app.id) : rescoreAll || (!r.live && !r.stored)),
    );
    if (!targets.length) {
      toast.info(
        explicit
          ? "Select at least one candidate to score."
          : "Every applicant already has a score — switch on re-score to run them again.",
      );
      return;
    }

    setBulk({ done: 0, total: targets.length });
    try {
      const rows = await runPipeline({
        data: {
          jd: {
            title: requisition.title,
            mustHave: jd?.must_have?.length ? jd.must_have : requisition.must_have_skills,
            goodToHave: jd?.good_to_have?.length
              ? jd.good_to_have
              : requisition.good_to_have_skills,
            responsibilities: jd?.responsibilities ?? requisition.responsibilities,
            education: requisition.education_requirement,
            experienceMin: requisition.experience_min,
            experienceMax: requisition.experience_max,
            jdText: jd?.full_text ?? null,
            constraints: {
              ctcBandMin: requisition.ctc_band_min ? Number(requisition.ctc_band_min) : null,
              ctcBandMax: requisition.ctc_band_max ? Number(requisition.ctc_band_max) : null,
              maxNoticePeriodDays: requisition.max_notice_period_days,
              locations: requisition.location ? [requisition.location] : null,
              workAuthorizationRequired: requisition.work_authorization_required,
            },
          },
          weights: effWeights,
          customDimensions,
          includeSocial,
          concurrency: 3,
          rows: targets.map((r) => ({
            applicationId: r.app.id,
            candidate: {
              name: r.candidate!.full_name,
              skills: r.candidate!.skills,
              experienceYears: Number(r.candidate!.experience_years),
              education: r.candidate!.education,
              resumeText: r.candidate!.resume_text,
              linkedinUrl: r.candidate!.linkedin_url,
              githubUrl: r.candidate!.github_url,
              websiteUrl: r.candidate!.website_url,
              xUrl: r.candidate!.x_url,
              noticePeriodDays: r.candidate!.notice_period_days,
              currentCtc: r.candidate!.current_ctc ? Number(r.candidate!.current_ctc) : null,
              expectedCtc: r.candidate!.expected_ctc ? Number(r.candidate!.expected_ctc) : null,
              location: r.candidate!.location,
              preferredLocations: r.candidate!.preferred_locations ?? null,
              willingToRelocate: r.candidate!.willing_to_relocate,
              workAuthorization: r.candidate!.work_authorization,
              cachedSocial: includeSocial ? cachedSocialFor(r.candidate!.id) : [],
            },
          })),
        },
      });

      let failures = 0;
      for (const row of rows) {
        const target = targets.find((t) => t.app.id === row.applicationId);
        if (!row.ok || !target?.candidate) {
          failures += 1;
          continue;
        }
        setResults((prev) => ({ ...prev, [row.applicationId]: row.result }));
        try {
          await persistResult(row.applicationId, target.app.stage, row.result);
        } catch {
          failures += 1;
        }
        setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
      }

      qc.invalidateQueries({ queryKey: ["match_scores"] });
      qc.invalidateQueries({ queryKey: ["social_profiles"] });
      qc.invalidateQueries({ queryKey: ["applications"] });
      if (failures)
        toast.warning(`Scored ${rows.length - failures} of ${rows.length} — ${failures} failed.`);
      else
        toast.success(
          `Scored ${rows.length} candidate${rows.length === 1 ? "" : "s"} against this JD.`,
        );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Pipeline run failed");
    } finally {
      setBulk(null);
    }
  }

  async function saveOverride(applicationId: string, verdict: "select" | "reject" | "hold") {
    const stored = scoreMap.get(applicationId);
    if (!stored) return;
    try {
      await saveRecruiterOverride({
        data: { id: stored.id, verdict, reason: overrideReason || null },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the override");
      return;
    }

    // Overriding a parked/closed candidate to "select" means "I want to
    // interview them" — return them to Shortlisted in the same action instead
    // of making the recruiter hunt for the stage mover. Goes through the
    // audited moveStage path, so the trail stays honest.
    let returned = false;
    if (verdict === "select") {
      const row = pipeline.find((r) => r.app.id === applicationId);
      const stage = row?.app.stage as string | undefined;
      if (
        stage &&
        !["shortlisted", "ai_screened", "l1", "l2", "l3", "offer", "offer_pending"].includes(stage)
      ) {
        try {
          await moveStage({
            data: {
              applicationId,
              toStage: "shortlisted",
              reason: overrideReason.trim() || "Recruiter override — returned to scheduling",
            },
          });
          returned = true;
          qc.invalidateQueries({ queryKey: ["applications"] });
        } catch (e) {
          toast.warning(
            e instanceof Error
              ? `Override saved, but returning to Shortlisted failed: ${e.message}`
              : "Override saved, but returning to Shortlisted failed — move the stage manually.",
          );
        }
      }
    }

    setOverrideReason("");
    if (returned) {
      toast.success("Override recorded — candidate returned to Shortlisted", {
        action: {
          label: "Schedule interview",
          onClick: () => router.navigate({ to: "/interviews" }),
        },
      });
    } else {
      toast.success("Recruiter override recorded");
    }
    qc.invalidateQueries({ queryKey: ["match_scores"] });
  }

  return (
    <>
      <PageHeader
        eyebrow="Screening"
        title="JD ↔ CV matching engine"
        description="Every score is a weighted roll-up of semantic skill mapping, a deterministic experience band, education fit and live social profiling — with the evidence behind each number."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {leadership ? (
              <Link
                to="/brain"
                className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary"
              >
                Talent Brain — skill gaps
              </Link>
            ) : null}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={rescoreAll} onCheckedChange={setRescoreAll} />
              Re-score already scored
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={selected.length > 0 && selected.length === pipeline.length}
                onCheckedChange={(v) => setSelected(v ? pipeline.map((r) => r.app.id) : [])}
              />
              Select all
            </label>
            {selected.length > 0 && (
              <Button
                variant="outline"
                onClick={() => scoreAll(selected)}
                disabled={Boolean(running) || Boolean(bulk)}
              >
                {bulk ? <Loader2 className="size-4 animate-spin" /> : <Target className="size-4" />}
                Score selected ({selected.length})
              </Button>
            )}
            <Button
              onClick={() => scoreAll()}
              disabled={Boolean(running) || Boolean(bulk) || pipeline.length === 0}
            >
              {bulk ? <Loader2 className="size-4 animate-spin" /> : <Target className="size-4" />}
              {bulk ? `Scoring ${bulk.done}/${bulk.total}` : "Score whole pipeline"}
            </Button>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-4">
        <aside className="space-y-6 lg:col-span-1">
          <section className="panel p-5">
            <Label className="mb-1.5 block text-xs text-muted-foreground">Requisition</Label>
            <Select value={activeId} onValueChange={(v) => navigate({ search: { req: v } })}>
              <SelectTrigger>
                <SelectValue placeholder="Select requisition" />
              </SelectTrigger>
              <SelectContent>
                {requisitions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.code} — {r.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {requisition ? (
              <div className="mt-4 space-y-3 text-sm">
                <div className="num text-xs text-muted-foreground">
                  {requisition.experience_min}–{requisition.experience_max} yrs ·{" "}
                  {requisition.location}
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Must-have baseline</Label>
                  <div className="mt-1.5">
                    <SkillPills
                      skills={(jd?.must_have?.length
                        ? jd.must_have
                        : requisition.must_have_skills
                      ).slice(0, 10)}
                      tone="match"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {jd
                    ? `Scoring against JD v${jd.version} (${jd.status})`
                    : "No JD drafted — scoring against requisition inputs"}
                </p>
              </div>
            ) : null}
          </section>

          <section className="panel p-5">
            <h2 className="font-semibold">Probable CVs from the pool</h2>
            <p className="text-xs text-muted-foreground">
              Ranked against this JD. Only people clearing the fit floor are listed — add the right
              ones, then run the full AI and social score.
            </p>
            {!requisition ? (
              <p className="mt-3 text-xs text-muted-foreground">Select a requisition first.</p>
            ) : poolRanked.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Everyone in the talent pool is already attached.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <Input
                    value={poolQuery}
                    onChange={(e) => setPoolQuery(e.target.value)}
                    placeholder="Filter by name, skill or location"
                    className="h-9"
                  />
                  <Select value={minFit} onValueChange={setMinFit}>
                    <SelectTrigger className="h-9 w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="75">Strong ≥ 75</SelectItem>
                      <SelectItem value="60">Probable ≥ 60</SelectItem>
                      <SelectItem value="40">Possible ≥ 40</SelectItem>
                      <SelectItem value="0">Everyone</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="num text-xs text-muted-foreground">
                    {suggestedPool.length} of {poolRanked.length} unattached
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      addFromTalentPool(suggestedPool.slice(0, 10).map((row) => row.candidate.id))
                    }
                    disabled={addingFromPool || suggestedPool.length === 0}
                  >
                    {addingFromPool ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <UserPlus className="size-4" />
                    )}
                    Add top {Math.min(10, suggestedPool.length)}
                  </Button>
                </div>
                {suggestedPool.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Nobody clears this fit floor. Lower it, or source externally below.
                  </p>
                ) : (
                  <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border">
                    {suggestedPool.map((row) => (
                      <li key={row.candidate.id} className="flex items-center gap-2 p-2.5">
                        <ScoreChip score={row.fit} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">
                            {row.candidate.full_name}
                          </div>
                          <div className="num truncate text-xs text-muted-foreground">
                            {row.mustHits.length}/{Math.max(1, requisition.must_have_skills.length)}{" "}
                            must-haves · {row.candidate.experience_years} yrs
                            {row.candidate.location ? ` · ${row.candidate.location}` : ""}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Add ${row.candidate.full_name} to pipeline`}
                          onClick={() => addFromTalentPool([row.candidate.id])}
                          disabled={addingFromPool}
                        >
                          <UserPlus className="size-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  Fit is a live skill and experience pre-rank, not the final AI score.
                </p>
              </div>
            )}

            <div className="mt-4 border-t border-border pt-4">
              <p className="text-xs font-medium">External job boards</p>
              {(boards.data ?? []).length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Optional: connect a licensed LinkedIn, Naukri or Indeed recruiter API to import
                  external applicants.
                </p>
              ) : (
                <div className="mt-2 space-y-2">
                  <Select value={board} onValueChange={setBoard}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose board" />
                    </SelectTrigger>
                    <SelectContent>
                      {(boards.data ?? []).map((b) => (
                        <SelectItem key={b.provider} value={b.provider}>
                          {b.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={importApplicants}
                    disabled={!board || importing}
                  >
                    {importing ? <Loader2 className="size-4 animate-spin" /> : null} Import 10
                    matching CVs
                  </Button>
                </div>
              )}
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="font-semibold">Scoring weights</h2>
            <p className="text-xs text-muted-foreground">
              Move a slider or type a number — the others rebalance so the total always stays 100.
            </p>
            <div className="mt-4 space-y-4">
              {(Object.keys(WEIGHT_LABELS) as (keyof Weights)[]).map((key) => {
                const label = WEIGHT_LABELS[key];
                return (
                  <div key={key}>
                    <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                      <span>{label}</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={effWeights[key]}
                        onChange={(e) => setWeight(key, Number(e.target.value))}
                        className="num h-8 w-16 rounded-md border border-border bg-background px-2 text-right text-sm"
                      />
                    </div>
                    <Slider
                      value={[effWeights[key]]}
                      min={0}
                      max={100}
                      step={1}
                      onValueChange={([v]) => setWeight(key, v ?? 0)}
                    />
                  </div>
                );
              })}

              <div className="flex items-center justify-between gap-3">
                <p
                  className={
                    weightTotal === 100
                      ? "num text-xs text-muted-foreground"
                      : "num text-xs text-destructive"
                  }
                >
                  Total {weightTotal} / 100
                  {weightTotal !== 100 ? " — rebalance to score" : ""}
                </p>
                <div className="flex gap-2">
                  {weightTotal !== 100 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setWeights(balanceWeights(effWeights))}
                    >
                      Balance to 100
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setWeights(null)}>
                    Reset to requisition
                  </Button>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-border pt-4">
                <div>
                  <div className="text-sm">Live social profiling</div>
                  <p className="text-xs text-muted-foreground">
                    Fetches GitHub, LinkedIn & writing signals
                  </p>
                </div>
                <Switch checked={includeSocial} onCheckedChange={setIncludeSocial} />
              </div>
            </div>
          </section>
        </aside>

        <section className="space-y-4 lg:col-span-3">
          {pipeline.length === 0 ? (
            <EmptyState
              title="No applicants on this requisition"
              hint="Add candidates from the talent pool and attach them to this requisition."
            />
          ) : (
            pipeline.map(({ app, candidate, stored, live }) => {
              const result = live;
              const overall = result?.overall_score ?? stored?.overall_score;
              const isOpen = expanded === app.id;
              const social = (socials.data ?? []).filter(
                (s) => s.candidate_id === app.candidate_id,
              );
              return (
                <article key={app.id} className="panel overflow-hidden">
                  <div className="flex flex-wrap items-center gap-4 p-5">
                    <Checkbox
                      checked={selected.includes(app.id)}
                      onCheckedChange={(v) => toggleSelected(app.id, Boolean(v))}
                      aria-label={`Select ${candidate?.full_name ?? "candidate"} for matching`}
                    />
                    {overall !== undefined ? (
                      <ScoreChip score={overall} size="lg" />
                    ) : (
                      <div className="num flex size-14 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
                        —
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-semibold">
                        {candidate?.full_name ?? "Unknown candidate"}
                      </h3>
                      <p className="num line-clamp-2 text-xs text-muted-foreground">
                        {candidate?.experience_years} yrs ·{" "}
                        {educationLabel(candidate?.education) || "education not captured"}
                      </p>

                      <div className="mt-2 flex items-center gap-3 text-muted-foreground">
                        {candidate?.linkedin_url ? <Linkedin className="size-4" /> : null}
                        {candidate?.github_url ? <Github className="size-4" /> : null}
                        {candidate?.website_url || candidate?.x_url ? (
                          <PenLine className="size-4" />
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => score(app.id)}
                        disabled={running === app.id}
                      >
                        {running === app.id ? <Loader2 className="size-4 animate-spin" /> : null}
                        {overall === undefined ? "Run match" : "Re-score"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpanded(isOpen ? null : app.id)}
                        disabled={!result && !stored}
                      >
                        Detail <ChevronDown className={isOpen ? "size-4 rotate-180" : "size-4"} />
                      </Button>
                    </div>
                  </div>

                  {(result || stored) && (
                    <div className="grid gap-3 border-t border-border bg-surface-2 p-5 sm:grid-cols-3 lg:grid-cols-6">
                      <ScoreBar
                        label="Skills"
                        score={result?.skills_score ?? stored!.skills_score}
                        weight={effWeights.skills}
                      />
                      <ScoreBar
                        label="Experience"
                        score={result?.experience_score ?? stored!.experience_score}
                        weight={effWeights.experience}
                      />
                      <ScoreBar
                        label="Career history"
                        score={result?.career_score ?? stored!.career_score}
                        weight={effWeights.career}
                      />
                      <ScoreBar
                        label="Impact & innov."
                        score={
                          result?.impact_innovation_score ??
                          Math.round(stored!.impact_score * 0.6 + stored!.innovation_score * 0.4)
                        }
                        weight={effWeights.impact}
                      />
                      <ScoreBar
                        label="Education"
                        score={result?.education_score ?? stored!.education_score}
                        weight={effWeights.education}
                      />
                      <ScoreBar
                        label="Social"
                        score={result?.social_score ?? stored!.social_score}
                        weight={effWeights.social}
                      />
                    </div>
                  )}

                  {isOpen && (result || stored) && (
                    <div className="space-y-6 border-t border-border p-5">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <Label className="text-xs text-muted-foreground">Evidenced skills</Label>
                          <div className="mt-1.5">
                            <SkillPills
                              skills={result?.matched_skills ?? stored!.matched_skills}
                              tone="match"
                            />
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Gaps</Label>
                          <div className="mt-1.5">
                            <SkillPills
                              skills={result?.missing_skills ?? stored!.missing_skills}
                              tone="miss"
                            />
                          </div>
                        </div>
                        {result?.transferable_skills?.length ? (
                          <div className="sm:col-span-2">
                            <Label className="text-xs text-muted-foreground">
                              Transferable / adjacent
                            </Label>
                            <div className="mt-1.5">
                              <SkillPills skills={result.transferable_skills} />
                            </div>
                          </div>
                        ) : null}
                      </div>

                      {result?.contributions ? (
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            Weighted contribution
                          </Label>
                          <table className="num mt-2 w-full text-sm">
                            <thead className="text-xs text-muted-foreground">
                              <tr>
                                <th className="py-1 text-left font-normal">Dimension</th>
                                <th className="py-1 text-right font-normal">Raw</th>
                                <th className="py-1 text-right font-normal">Weight</th>
                                <th className="py-1 text-right font-normal">Points</th>
                              </tr>
                            </thead>
                            <tbody>
                              {result.contributions.map((c) => (
                                <tr key={c.label} className="border-t border-border">
                                  <td className="py-1.5 text-left">{c.label}</td>
                                  <td className="py-1.5 text-right">{c.raw}</td>
                                  <td className="py-1.5 text-right text-muted-foreground">
                                    {c.weight}%
                                  </td>
                                  <td className="py-1.5 text-right font-semibold">{c.weighted}</td>
                                </tr>
                              ))}
                              <tr className="border-t border-border">
                                <td className="py-1.5 font-medium">Overall</td>
                                <td />
                                <td />
                                <td className="py-1.5 text-right font-semibold">
                                  {result.overall_score}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      ) : null}

                      {result?.career ? (
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div>
                            <Label className="text-xs text-muted-foreground">
                              Career history (measured, not guessed)
                            </Label>
                            <dl className="num mt-2 space-y-1 text-sm">
                              {(
                                [
                                  ["Employers", String(result.career.metrics.employers)],
                                  ["Avg tenure", `${result.career.metrics.avg_tenure_years} yrs`],
                                  [
                                    "Current tenure",
                                    result.career.metrics.current_tenure_years === null
                                      ? "—"
                                      : `${result.career.metrics.current_tenure_years} yrs`,
                                  ],
                                  [
                                    "Jobs in last 5 yrs",
                                    String(result.career.metrics.jobs_last_5y),
                                  ],
                                  ["Longest gap", `${result.career.metrics.longest_gap_months} mo`],
                                  ["Progression", result.career.metrics.progression],
                                ] as const
                              ).map(([k, v]) => (
                                <div
                                  key={k}
                                  className="flex justify-between border-b border-border pb-1"
                                >
                                  <dt className="text-muted-foreground">{k}</dt>
                                  <dd>{v}</dd>
                                </div>
                              ))}
                            </dl>
                            {result.career.assessment.notes.length ? (
                              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                                {result.career.assessment.notes.map((n) => (
                                  <li key={n}>{n}</li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                          <div className="space-y-3">
                            <div>
                              <Label className="text-xs text-muted-foreground">
                                Impact {result.impact_score} · Innovation {result.innovation_score}
                              </Label>
                              <ul className="mt-1.5 space-y-1 text-sm">
                                {[
                                  ...result.impact.highlights,
                                  ...result.impact.innovation_signals,
                                ].map((h) => (
                                  <li key={h} className="text-muted-foreground">
                                    • {h}
                                  </li>
                                ))}
                              </ul>
                              {result.impact.rationale ? (
                                <p className="mt-1.5 text-xs text-muted-foreground">
                                  {result.impact.rationale}
                                </p>
                              ) : null}
                            </div>
                            {result.logistics ? (
                              <div>
                                <Label className="text-xs text-muted-foreground">
                                  Logistics — joining risk: {result.logistics.join_risk} (never
                                  affects the score)
                                </Label>
                                <ul className="mt-1.5 space-y-1 text-sm">
                                  {result.logistics.blockers.map((b) => (
                                    <li key={b} className="text-destructive">
                                      ✕ {b}
                                    </li>
                                  ))}
                                  {result.logistics.flags.map((f) => (
                                    <li key={f} className="text-muted-foreground">
                                      ! {f}
                                    </li>
                                  ))}
                                  {!result.logistics.blockers.length &&
                                  !result.logistics.flags.length ? (
                                    <li className="text-muted-foreground">
                                      No compensation, notice or location issues.
                                    </li>
                                  ) : null}
                                </ul>
                                {result.logistics.missing.length ? (
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    Not captured yet: {result.logistics.missing.join(", ")}
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      <div>
                        <Label className="text-xs text-muted-foreground">Social profiling</Label>
                        <p className="mb-2 text-xs text-muted-foreground">
                          {result?.social.basis ?? "Stored from the last scoring run"}
                        </p>
                        <div className="grid gap-3 sm:grid-cols-3">
                          {(result?.social.signals ?? []).map((s) => (
                            <div key={s.provider} className="rounded-lg border border-border p-3">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium capitalize">{s.provider}</span>
                                <span className="num text-sm font-semibold">
                                  {s.status === "ok" ? s.score : "n/a"}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">{s.rationale}</p>
                              {s.status === "ok" ? (
                                <dl className="num mt-2 space-y-0.5 text-xs text-muted-foreground">
                                  {Object.entries(s.signals)
                                    .slice(0, 5)
                                    .map(([k, v]) => (
                                      <div key={k} className="flex justify-between gap-2">
                                        <dt className="truncate">{k.replace(/_/g, " ")}</dt>
                                        <dd>
                                          {typeof v === "object" ? JSON.stringify(v) : String(v)}
                                        </dd>
                                      </div>
                                    ))}
                                </dl>
                              ) : null}
                            </div>
                          ))}
                          {!result &&
                            social.map((s) => (
                              <div key={s.id} className="rounded-lg border border-border p-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium capitalize">
                                    {s.provider}
                                  </span>
                                  <span className="num text-sm font-semibold">{s.score}</span>
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">{s.rationale}</p>
                              </div>
                            ))}
                          {!result && social.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No social signals captured yet.
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <div>
                        <Label className="text-xs text-muted-foreground">Rationale</Label>
                        <p className="mt-1 text-sm">{result?.rationale ?? stored?.rationale}</p>
                      </div>

                      {(result?.risk_flags ?? stored?.risk_flags ?? []).length > 0 ? (
                        <div>
                          <Label className="text-xs text-muted-foreground">Risk flags</Label>
                          <ul className="mt-1 space-y-1 text-sm text-destructive">
                            {(result?.risk_flags ?? stored!.risk_flags).map((f) => (
                              <li key={f}>· {f}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      <div className="rounded-lg border border-border p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground">
                              AI recommendation
                            </Label>
                            <p className="text-sm font-semibold capitalize">
                              {result?.recommendation ?? stored?.recommendation ?? "—"}
                            </p>
                            {stored?.recruiter_override ? (
                              <p className="text-xs text-muted-foreground">
                                Recruiter override: {stored.recruiter_override}
                                {stored.override_reason ? ` — ${stored.override_reason}` : ""}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex gap-2">
                            {(["select", "hold", "reject"] as const).map((v) => (
                              <Button
                                key={v}
                                size="sm"
                                variant="outline"
                                onClick={() => saveOverride(app.id, v)}
                              >
                                Override: {v}
                              </Button>
                            ))}
                          </div>
                        </div>
                        <Textarea
                          className="mt-3"
                          rows={2}
                          placeholder="Reason for override (kept on the audit trail)"
                          value={overrideReason}
                          onChange={(e) => setOverrideReason(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </section>
      </div>
    </>
  );
}
