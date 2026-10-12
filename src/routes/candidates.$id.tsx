import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { ScreeningPanel } from "@/components/ScreeningPanel";
import { CandidateCollab } from "@/components/CandidateCollab";
import { ArrowLeft, Download, ExternalLink, ShieldCheck, Sparkles } from "lucide-react";

import {
  aiInterviewsQuery,
  applicationsQuery,
  candidateQuery,
  candidateVerificationsQuery,
  candidateAssessmentsQuery,
  evaluationsQuery,
  jdQuery,
  latestScores,
  matchScoresQuery,
  requisitionsQuery,
  socialProfilesQuery,
  stageEventsQuery,
} from "@/lib/data";
import { runAiScreening } from "@/lib/matching.functions";
import { saveAiInterview } from "@/lib/interviews.functions";
import { verifyCandidate } from "@/lib/verification.functions";
import { createAssessment } from "@/lib/assessment.functions";
import { getResumeDownloadUrl } from "@/lib/resume.functions";
import { downloadResume } from "@/lib/resume-download";
import { normalizeExternalUrl } from "@/lib/external-links";
import { nextAction, STAGE_LABEL, type Stage } from "@/lib/lifecycle";
import { CandidateCostLine } from "@/components/HiringCost";
import { StageMover } from "@/components/StageMover";
import {
  EmptyState,
  educationLabel,
  PageHeader,
  ScoreBar,
  ScoreChip,
  SkillPills,
  StageBadge,
} from "@/components/ats";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/candidates/$id")({
  head: () => ({
    meta: [
      { title: "Candidate profile — match, social score & interviews" },
      {
        name: "description",
        content:
          "Full candidate view: parsed resume, skills, social profiling breakdown, JD match scores per requisition and interview evaluations.",
      },
      { property: "og:title", content: "Candidate profile — match, social score & interviews" },
      {
        property: "og:description",
        content:
          "Evidence-backed match detail, AI screening results and L1–L3 evaluation history for one candidate.",
      },
    ],
  }),
  component: CandidateDetail,
});

function CandidateDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const cand = useQuery(candidateQuery(id));
  const apps = useQuery(applicationsQuery);
  const reqs = useQuery(requisitionsQuery);
  const scores = useQuery(matchScoresQuery);
  const socials = useQuery(socialProfilesQuery);
  const evals = useQuery(evaluationsQuery);
  const aiRuns = useQuery(aiInterviewsQuery);
  const screen = useServerFn(runAiScreening);
  const saveScreen = useServerFn(saveAiInterview);
  const verify = useServerFn(verifyCandidate);
  const makeAssessment = useServerFn(createAssessment);
  const getResumeUrl = useServerFn(getResumeDownloadUrl);
  const [downloading, setDownloading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [mover, setMover] = useState<{ id: string; stage: Stage } | null>(null);

  const c = cand.data;
  const myApps = (apps.data ?? []).filter((a) => a.candidate_id === id);
  const firstReqId = myApps[0]?.requisition_id ?? "";
  const jds = useQuery({ ...jdQuery(firstReqId), enabled: Boolean(firstReqId) });
  const scoreMap = latestScores(scores.data ?? []);
  const social = (socials.data ?? []).filter((s) => s.candidate_id === id);
  const verifs = useQuery(candidateVerificationsQuery(id));
  const assessments = useQuery(candidateAssessmentsQuery(id));
  const assessment = (assessments.data ?? [])[0] ?? null;
  const verification = (verifs.data ?? [])[0] ?? null;
  const appIds = myApps.map((a) => a.id);
  const events = useQuery({ ...stageEventsQuery(appIds), enabled: appIds.length > 0 });

  if (cand.isLoading) return <p className="text-sm text-muted-foreground">Loading candidate…</p>;
  if (!c) return <EmptyState title="Candidate not found" />;

  async function aiScreen(applicationId: string, requisitionId: string) {
    const req = (reqs.data ?? []).find((r) => r.id === requisitionId);
    if (!req) return;
    setBusy(applicationId);
    try {
      const jdText =
        (jds.data ?? [])[0]?.full_text ??
        `${req.title}. Must have: ${req.must_have_skills.join(", ")}. Responsibilities: ${req.responsibilities ?? "—"}`;
      const out = await screen({
        data: {
          jobTitle: req.title,
          jdText,
          candidateName: c!.full_name,
          resumeText: c!.resume_text,
          matchRationale: scoreMap.get(applicationId)?.rationale ?? null,
        },
      });
      await saveScreen({
        data: {
          applicationId,
          jdMatchScore: out.jd_match_score,
          skillsetScore: out.skillset_score,
          transcript: out.transcript,
          summary: out.summary,
        },
      });
      toast.success("AI screening interview completed");
      qc.invalidateQueries({ queryKey: ["ai_interviews"] });
      qc.invalidateQueries({ queryKey: ["applications"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "AI screening failed");
    } finally {
      setBusy(null);
    }
  }

  /** Issue a role-specific mindset questionnaire the candidate fills in themselves. */
  async function sendAssessment() {
    setAssessing(true);
    try {
      const out = await makeAssessment({
        data: { candidateId: id, requisitionId: firstReqId || null, count: 6 },
      });
      const link = `${window.location.origin}/assess/${out.token}`;
      await navigator.clipboard?.writeText(link).catch(() => undefined);
      toast.success("Questionnaire created — private link copied to your clipboard");
      qc.invalidateQueries({ queryKey: ["candidate_assessments", id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the questionnaire");
    } finally {
      setAssessing(false);
    }
  }

  /** Re-run the verification agent against the live public evidence. */
  async function runVerification() {
    setVerifying(true);
    try {
      const out = await verify({ data: { candidateId: id } });
      toast.success(
        `Authenticity ${out.authenticity_score}/100 — ${out.claims.length} claims checked`,
      );
      qc.invalidateQueries({ queryKey: ["candidate_verifications"] });
      qc.invalidateQueries({ queryKey: ["candidate", id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setVerifying(false);
    }
  }

  const links = [
    ["LinkedIn", normalizeExternalUrl(c.linkedin_url)],
    ["GitHub", normalizeExternalUrl(c.github_url)],
    ["Portfolio", normalizeExternalUrl(c.website_url)],
    ["X", normalizeExternalUrl(c.x_url)],
  ] as const;

  return (
    <>
      <Link
        to="/candidates"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Talent pool
      </Link>

      <PageHeader
        eyebrow={`${c.source} · ${c.experience_years} yrs experience`}
        title={c.full_name}
        description={[c.email, c.location, educationLabel(c.education)].filter(Boolean).join(" · ")}
      />

      {c.resume_file_path ? (
        <div className="-mt-2">
          <Button
            size="sm"
            variant="outline"
            disabled={downloading}
            onClick={async () => {
              setDownloading(true);
              try {
                const out = await getResumeUrl({ data: { candidateId: c.id } });
                if (out.ok) downloadResume(out);
                else toast.error(out.error);
              } finally {
                setDownloading(false);
              }
            }}
          >
            <Download className="mr-1.5 size-3.5" />
            {downloading ? "Opening…" : "Download original CV"}
          </Button>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="panel p-5">
            <h2 className="font-semibold">Applications & match scores</h2>
            {myApps.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Not attached to any requisition yet.
              </p>
            ) : (
              <ul className="mt-4 space-y-4">
                {myApps.map((a) => {
                  const req = (reqs.data ?? []).find((r) => r.id === a.requisition_id);
                  const s = scoreMap.get(a.id);
                  const ai = (aiRuns.data ?? []).find((x) => x.application_id === a.id);
                  return (
                    <li key={a.id} className="rounded-lg border border-border p-4">
                      <div className="flex flex-wrap items-center gap-3">
                        {s ? <ScoreChip score={s.overall_score} /> : null}
                        <div className="min-w-0 flex-1">
                          <Link
                            to="/requisitions/$id"
                            params={{ id: a.requisition_id }}
                            className="font-medium hover:underline"
                          >
                            {req?.title}
                          </Link>
                          <div className="num text-xs text-muted-foreground">{req?.code}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <StageBadge stage={a.stage} />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setMover({ id: a.id, stage: a.stage as Stage })}
                          >
                            Move
                          </Button>
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Next action: {nextAction(a.stage as Stage)}
                      </p>
                      <div className="mt-2">
                        <CandidateCostLine applicationId={a.id} />
                      </div>

                      {s ? (
                        <>
                          <div className="mt-4 grid gap-3 sm:grid-cols-3">
                            <ScoreBar label="Skills" score={s.skills_score} />
                            <ScoreBar label="Experience" score={s.experience_score} />
                            <ScoreBar label="Career history" score={s.career_score ?? 0} />
                            <ScoreBar label="Impact & innovation" score={s.impact_score ?? 0} />
                            <ScoreBar label="Education" score={s.education_score} />
                            <ScoreBar label="Social" score={s.social_score} />
                          </div>
                          <p className="mt-3 text-sm">{s.rationale}</p>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <div>
                              <Label className="text-xs text-muted-foreground">Evidenced</Label>
                              <div className="mt-1.5">
                                <SkillPills skills={s.matched_skills} tone="match" />
                              </div>
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">Gaps</Label>
                              <div className="mt-1.5">
                                <SkillPills skills={s.missing_skills} tone="miss" />
                              </div>
                            </div>
                          </div>
                        </>
                      ) : (
                        <p className="mt-3 text-sm text-muted-foreground">
                          Not scored yet —{" "}
                          <Link
                            to="/matching"
                            search={{ req: a.requisition_id }}
                            className="underline"
                          >
                            run the matching engine
                          </Link>
                          .
                        </p>
                      )}

                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => aiScreen(a.id, a.requisition_id)}
                          disabled={busy === a.id}
                        >
                          <Sparkles className="size-4" />{" "}
                          {ai ? "Re-run AI screening" : "Run AI screening"}
                        </Button>
                      </div>

                      {ai ? (
                        <div className="mt-4 rounded-lg bg-surface-2 p-4">
                          <div className="num grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                            <Metric label="JD match" value={ai.jd_match_score} />
                            <Metric label="Skillset" value={ai.skillset_score} />
                          </div>
                          <p className="mt-3 text-sm">{ai.summary}</p>
                          <ol className="mt-3 space-y-2 text-xs text-muted-foreground">
                            {(Array.isArray(ai.transcript)
                              ? (ai.transcript as unknown as {
                                  question: string;
                                  expected_signal: string;
                                }[])
                              : []
                            ).map((t, i) => (
                              <li key={i}>
                                <span className="text-foreground">{t.question}</span> —{" "}
                                {t.expected_signal}
                              </li>
                            ))}
                          </ol>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <ScreeningPanel
            candidateId={id}
            candidateName={c.full_name}
            roles={myApps.map((a) => ({
              requisitionId: a.requisition_id,
              title: (reqs.data ?? []).find((r) => r.id === a.requisition_id)?.title ?? "Role",
            }))}
          />

          <CandidateCollab candidateId={id} ownerId={c.owner_id ?? null} />

          <section className="panel p-5">
            <h2 className="font-semibold">Interview evaluations</h2>
            {(evals.data ?? []).filter((e) => myApps.some((a) => a.id === e.application_id))
              .length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No L1–L3 evaluations recorded yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-3 text-sm">
                {(evals.data ?? [])
                  .filter((e) => myApps.some((a) => a.id === e.application_id))
                  .map((e) => (
                    <li key={e.id} className="rounded-lg border border-border p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          L{e.level} · {e.focus_area ?? "General"}
                        </span>
                        <span className="num">{e.rating ?? "—"}/5</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {e.evaluator ?? "Unnamed"} · {e.recommendation}
                      </p>
                      {e.comments ? <p className="mt-1 text-xs">{e.comments}</p> : null}
                    </li>
                  ))}
              </ul>
            )}
          </section>

          <section className="panel p-5">
            <h2 className="font-semibold">Lifecycle timeline</h2>
            <p className="text-xs text-muted-foreground">
              Every stage change, who made it and why — the audit trail behind this candidate.
            </p>
            {(events.data ?? []).length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No stage changes recorded yet.</p>
            ) : (
              <ol className="mt-4 space-y-3 border-l border-border pl-4 text-sm">
                {(events.data ?? []).map((e) => (
                  <li key={e.id} className="relative">
                    <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-primary" />
                    <div className="font-medium">
                      {e.from_stage ? `${STAGE_LABEL[e.from_stage as Stage]} → ` : ""}
                      {STAGE_LABEL[e.to_stage as Stage] ?? e.to_stage}
                    </div>
                    <div className="num text-xs text-muted-foreground">
                      {new Date(e.created_at).toLocaleString()} · {e.actor ?? "system"}
                      {e.reason ? ` · ${e.reason}` : ""}
                    </div>
                    {e.note ? <p className="mt-1 text-xs">{e.note}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <section className="panel p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">Authenticity check</h2>
                <p className="text-xs text-muted-foreground">
                  The verification agent cross-checks CV claims against live public evidence.
                </p>
              </div>
              {verification ? (
                <span
                  className={
                    "num inline-flex items-center gap-1 text-lg font-semibold " +
                    (verification.authenticity_score >= 70
                      ? "text-emerald-600"
                      : verification.authenticity_score >= 45
                        ? "text-amber-600"
                        : "text-destructive")
                  }
                >
                  <ShieldCheck className="size-4" /> {verification.authenticity_score}
                </span>
              ) : null}
            </div>

            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={runVerification}
              disabled={verifying}
            >
              <Sparkles className="size-4" />{" "}
              {verifying ? "Verifying…" : verification ? "Re-verify" : "Run verification"}
            </Button>

            {verification ? (
              <div className="mt-4 space-y-3 text-sm">
                <p>{verification.summary}</p>

                {(verification.red_flags ?? []).length > 0 ? (
                  <div>
                    <Label className="text-xs text-muted-foreground">Red flags</Label>
                    <ul className="mt-1.5 space-y-1 text-xs text-destructive">
                      {(verification.red_flags ?? []).map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div>
                  <Label className="text-xs text-muted-foreground">Claim-by-claim</Label>
                  <ul className="mt-1.5 space-y-2">
                    {(Array.isArray(verification.claims)
                      ? (verification.claims as unknown as {
                          claim: string;
                          verdict: string;
                          confidence: number;
                          evidence: string;
                        }[])
                      : []
                    ).map((cl, i) => (
                      <li key={i} className="rounded-lg border border-border p-2.5 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium text-foreground">{cl.claim}</span>
                          <span
                            className={
                              "whitespace-nowrap rounded border px-1.5 py-0.5 " +
                              (cl.verdict === "supported"
                                ? "border-emerald-500/30 text-emerald-600"
                                : cl.verdict === "contradicted"
                                  ? "border-destructive/30 text-destructive"
                                  : "border-border text-muted-foreground")
                            }
                          >
                            {cl.verdict}
                          </span>
                        </div>
                        <p className="mt-1 text-muted-foreground">{cl.evidence}</p>
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="num text-xs text-muted-foreground">
                  Last run {new Date(verification.created_at).toLocaleString()}
                </p>
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                Not verified yet. A verdict of <span className="font-medium">unverified</span> means
                no public trace was found — not that the claim is false.
              </p>
            )}
          </section>

          <section className="panel p-5">
            <h2 className="font-semibold">Social profiling</h2>
            <p className="text-xs text-muted-foreground">
              Fetched live during scoring; 15% of the default weight.
            </p>
            <div className="mt-4 space-y-3">
              {social.length === 0 ? (
                <p className="text-sm text-muted-foreground">No signals captured yet.</p>
              ) : (
                social.map((s) => (
                  <div key={s.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium capitalize">{s.provider}</span>
                      <span className="num text-sm font-semibold">
                        {s.status === "ok" ? s.score : "n/a"}
                      </span>
                    </div>
                    {s.handle ? (
                      <p className="num text-xs text-muted-foreground">@{s.handle}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted-foreground">{s.rationale}</p>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="font-semibold">Profile links</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {links.map(([label, url]) =>
                url ? (
                  <li key={label}>
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1.5 hover:underline"
                    >
                      {label} <ExternalLink className="size-3.5" />
                    </a>
                  </li>
                ) : null,
              )}
              {links.every(([, u]) => !u) ? (
                <li className="text-muted-foreground">No public profiles on file.</li>
              ) : null}
            </ul>
          </section>

          <section className="panel p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">Mindset & ways of working</h2>
                <p className="text-xs text-muted-foreground">
                  Measured from the candidate&apos;s own situational answers — never inferred from
                  the CV.
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={sendAssessment} disabled={assessing}>
                {assessing
                  ? "Writing questions…"
                  : assessment
                    ? "New questionnaire"
                    : "Send questionnaire"}
              </Button>
            </div>

            {!assessment ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No questionnaire sent yet. Creating one copies a private link you can email to the
                candidate.
              </p>
            ) : assessment.status !== "completed" ? (
              <div className="mt-3 space-y-2 text-sm">
                <p className="text-muted-foreground">
                  Sent, awaiting the candidate&apos;s answers.
                </p>
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => {
                    navigator.clipboard?.writeText(
                      `${window.location.origin}/assess/${assessment.token}`,
                    );
                    toast.success("Link copied");
                  }}
                >
                  Copy the candidate link again
                </button>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-semibold">{assessment.mindset_score ?? 0}</span>
                  <span className="text-xs text-muted-foreground">/ 100 mindset</span>
                </div>
                {(
                  (assessment.dimensions as unknown as {
                    dimension: string;
                    score: number;
                    evidence: string;
                  }[]) ?? []
                ).map((d) => (
                  <div key={d.dimension}>
                    <ScoreBar label={d.dimension} score={d.score} />
                    <p className="mt-1 text-xs text-muted-foreground">{d.evidence}</p>
                  </div>
                ))}
                {assessment.strengths.length ? (
                  <div>
                    <Label className="text-xs text-muted-foreground">Strengths</Label>
                    <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                      {assessment.strengths.map((x) => (
                        <li key={x}>• {x}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {assessment.red_flags.length ? (
                  <div>
                    <Label className="text-xs text-muted-foreground">Watch-outs</Label>
                    <ul className="mt-1 space-y-0.5 text-sm text-destructive">
                      {assessment.red_flags.map((x) => (
                        <li key={x}>! {x}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {assessment.summary ? (
                  <p className="text-sm text-muted-foreground">{assessment.summary}</p>
                ) : null}
              </div>
            )}
          </section>

          <section className="panel p-5">
            <h2 className="font-semibold">Skills</h2>
            <div className="mt-3">
              <SkillPills skills={c.skills} />
            </div>
          </section>
        </div>
      </div>

      <StageMover
        open={mover !== null}
        onOpenChange={(v) => !v && setMover(null)}
        applicationIds={mover ? [mover.id] : []}
        {...(mover ? { currentStage: mover.stage } : {})}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["applications"] });
          qc.invalidateQueries({ queryKey: ["stage_events"] });
        }}
      />
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
