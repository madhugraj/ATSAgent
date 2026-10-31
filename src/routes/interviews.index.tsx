import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { CalendarPlus, Loader2, Lock, Video } from "lucide-react";

import {
  applicationsQuery,
  candidatesQuery,
  evaluationsQuery,
  interviewsQuery,
  latestScores,
  matchScoresQuery,
  requisitionsQuery,
} from "@/lib/data";
import { scheduleInterview, submitScorecard } from "@/lib/interviews.functions";
import { declineRoundTranscription } from "@/lib/panel-agent.functions";
import { createMeetingLink, meetingProviders } from "@/lib/meetings.functions";
import { buildIcs, downloadIcs } from "@/lib/ics";
import { STAGE_LABEL } from "@/lib/lifecycle";
import { EmptyState, PageHeader, ScoreChip, StageBadge } from "@/components/ats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/interviews/")({
  head: () => ({
    meta: [
      { title: "Interviews & 3-Level Evaluations — ATS" },
      {
        name: "description",
        content:
          "Schedule L1 technical, L2 functional and L3 leadership interviews with panel invites, and capture locked scorecards that auto-advance candidates.",
      },
      { property: "og:title", content: "Interviews & 3-Level Evaluations" },
      {
        property: "og:description",
        content:
          "Level-wise scheduling with calendar invites, structured competency scorecards and select/hold/reject auto-progression.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Interviews,
});

const LEVELS = [
  { level: 1, label: "L1 — Technical / functional screen" },
  { level: 2, label: "L2 — Domain & role fit" },
  { level: 3, label: "L3 — Leadership & culture" },
];

/** A round's call transcript for the silent panel agent, in a word or two. */
const TRANSCRIPTION_LABEL: Record<string, string> = {
  requested: "Transcribed ·",
  ready: "Transcript in ·",
  unavailable: "No transcript",
  candidate_declined: "Not transcribed (candidate's wish)",
};

function localInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Interviews() {
  const qc = useQueryClient();
  const apps = useQuery(applicationsQuery);
  const cands = useQuery(candidatesQuery);
  const reqs = useQuery(requisitionsQuery);
  const scores = useQuery(matchScoresQuery);
  const ivs = useQuery(interviewsQuery);
  const evals = useQuery(evaluationsQuery);

  const doSchedule = useServerFn(scheduleInterview);
  const doSubmit = useServerFn(submitScorecard);
  const mintLink = useServerFn(createMeetingLink);
  const doDecline = useServerFn(declineRoundTranscription);

  /** The candidate replied that they do not want the call transcribed. */
  async function declineTranscription(interviewId: string) {
    if (
      !window.confirm(
        "Record that the candidate does not want this call transcribed? Transcription is switched off and any transcript is deleted.",
      )
    )
      return;
    try {
      await doDecline({ data: { interviewId, note: "" } });
      toast.success("Transcription switched off for this round.");
      qc.invalidateQueries({ queryKey: ["interviews"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record that");
    }
  }
  const providers = useQuery({
    queryKey: ["meeting_providers"],
    queryFn: () => meetingProviders(),
  });
  const readyProviders = (providers.data ?? []).filter((p) => p.ready);

  const [busy, setBusy] = useState(false);
  const [minting, setMinting] = useState(false);
  const [slot, setSlot] = useState<{
    applicationId: string;
    interviewId: string | null;
    level: number;
    interviewer: string;
    interviewerEmail: string;
    candidateEmail: string;
    scheduledAt: string;
    durationMins: string;
    mode: "online" | "onsite" | "phone";
    meetingLink: string;
    agenda: string;
    rescheduleReason: string;
  } | null>(null);

  const [form, setForm] = useState({
    application_id: "",
    level: "1",
    focus_area: "",
    rating: "3",
    recommendation: "select" as "select" | "hold" | "reject",
    comments: "",
    reason: "",
  });

  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("all");

  const scoreMap = latestScores(scores.data ?? []);
  const eligible = (apps.data ?? []).filter((a) =>
    ["shortlisted", "ai_screened", "l1", "l2", "l3", "offer", "offer_pending"].includes(a.stage),
  );

  /** Levels already scored for the selected candidate — mirrors the server's
   * finality rule: a scheduled round with a scorecard can never be re-scored. */
  const scoredLevelsFor = (applicationId: string) =>
    new Set(
      (evals.data ?? [])
        .filter((e) => e.application_id === applicationId && e.interview_id)
        .map((e) => e.level),
    );
  const scoredLevels = scoredLevelsFor(form.application_id);
  const levelLocked = scoredLevels.has(Number(form.level));

  /** Pick a candidate and land the form on the first level that is still open. */
  function pickApplication(applicationId: string) {
    const locked = scoredLevelsFor(applicationId);
    const firstOpen = LEVELS.find((l) => !locked.has(l.level));
    setForm({
      ...form,
      application_id: applicationId,
      level: locked.has(Number(form.level)) && firstOpen ? String(firstOpen.level) : form.level,
    });
  }

  const filtered = eligible.filter((a) => {
    const c = (cands.data ?? []).find((x) => x.id === a.candidate_id);
    const r = (reqs.data ?? []).find((x) => x.id === a.requisition_id);
    const q = search.trim().toLowerCase();
    if (q && ![c?.full_name, r?.title, r?.code].join(" ").toLowerCase().includes(q)) return false;
    if (stageFilter === "all") return true;
    if (stageFilter === "unscheduled") {
      return (
        (ivs.data ?? []).filter((i) => i.application_id === a.id && i.scheduled_at).length === 0
      );
    }
    return a.stage === stageFilter;
  });

  function openSlot(applicationId: string, level: number, interviewId: string | null) {
    const existing = (ivs.data ?? []).find((i) => i.id === interviewId);
    const app = (apps.data ?? []).find((a) => a.id === applicationId);
    const candidate = (cands.data ?? []).find((c) => c.id === app?.candidate_id);
    setSlot({
      applicationId,
      interviewId,
      level,
      interviewer: existing?.interviewer ?? "",
      interviewerEmail: existing?.interviewer_email ?? "",
      candidateEmail: candidate?.email ?? "",
      scheduledAt: localInputValue(
        existing?.scheduled_at
          ? new Date(existing.scheduled_at)
          : new Date(Date.now() + 86_400_000),
      ),
      durationMins: String(existing?.duration_mins ?? 60),
      mode: (existing?.mode as "online" | "onsite" | "phone") ?? "online",
      meetingLink: existing?.teams_link ?? "",
      agenda: existing?.agenda ?? "",
      rescheduleReason: "",
    });
  }

  async function saveSlot() {
    if (!slot) return;
    if (!slot.candidateEmail.trim()) {
      toast.error("The candidate needs an email address — that is where the invite goes");
      return;
    }
    if (slot.interviewId && !slot.rescheduleReason.trim()) {
      toast.error("Give a reason for the re-schedule");
      return;
    }
    setBusy(true);
    try {
      await doSchedule({
        data: {
          applicationId: slot.applicationId,
          interviewId: slot.interviewId,
          level: slot.level,
          interviewer: slot.interviewer || null,
          interviewerEmail: slot.interviewerEmail || null,
          candidateEmail: slot.candidateEmail.trim(),
          scheduledAt: slot.scheduledAt,
          durationMins: Number(slot.durationMins) || 60,
          mode: slot.mode,
          meetingLink: slot.meetingLink || null,
          agenda: slot.agenda || null,
          rescheduleReason: slot.rescheduleReason || null,
        },
      });
      toast.success(`L${slot.level} ${slot.interviewId ? "re-scheduled" : "scheduled"}`);
      setSlot(null);
      qc.invalidateQueries({ queryKey: ["interviews"] });
      qc.invalidateQueries({ queryKey: ["applications"] });
      qc.invalidateQueries({ queryKey: ["candidates"] });
      qc.invalidateQueries({ queryKey: ["stage_events"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not schedule the interview");
    } finally {
      setBusy(false);
    }
  }

  /** Mint a real join link with the HR-configured conferencing account. */
  async function generateLink(provider: "zoom" | "google_meet" | "teams") {
    if (!slot) return;
    const app = (apps.data ?? []).find((a) => a.id === slot.applicationId);
    const candidate = (cands.data ?? []).find((c) => c.id === app?.candidate_id);
    const req = (reqs.data ?? []).find((r) => r.id === app?.requisition_id);
    setMinting(true);
    try {
      const result = await mintLink({
        data: {
          provider,
          topic: `L${slot.level} interview — ${candidate?.full_name ?? "Candidate"} — ${req?.title ?? "Requisition"}`,
          startIso: new Date(slot.scheduledAt).toISOString(),
          durationMins: Number(slot.durationMins) || 60,
          attendees: [slot.interviewerEmail, slot.candidateEmail].filter((e): e is string =>
            Boolean(e),
          ),
          agenda: slot.agenda || null,
        },
      });

      setSlot({ ...slot, meetingLink: result.joinUrl, mode: "online" });
      toast.success("Meeting link created — save the slot to store it");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the meeting");
    } finally {
      setMinting(false);
    }
  }

  async function submitEvaluation() {
    if (!form.application_id) {
      toast.error("Pick a candidate first");
      return;
    }
    if (scoredLevels.has(Number(form.level))) {
      toast.error("This interview round has already been scored — scorecards are final.");
      return;
    }
    if (form.recommendation !== "select" && !form.reason.trim() && !form.comments.trim()) {
      toast.error("A hold or reject needs a written reason");
      return;
    }
    setBusy(true);
    try {
      const round = (ivs.data ?? []).find(
        (i) => i.application_id === form.application_id && i.level === Number(form.level),
      );
      const res = await doSubmit({
        data: {
          interviewId: round?.id ?? null,
          applicationId: form.application_id,
          level: Number(form.level),
          focusArea: form.focus_area || null,
          rating: Number(form.rating),
          verdict: form.recommendation,
          comments: form.comments || null,
          reason: form.reason || null,
          competencies: [],
        },
      });
      toast.success(
        res.movedTo
          ? `Evaluation recorded — moved to ${STAGE_LABEL[res.movedTo]}`
          : "Evaluation recorded",
      );
      if (res.blocked) toast.warning(res.blocked);
      if (res.nextInterviewCreated) toast.info("Next round queued for scheduling");
      setForm({ ...form, comments: "", focus_area: "", reason: "" });
      qc.invalidateQueries({ queryKey: ["evaluations"] });
      qc.invalidateQueries({ queryKey: ["applications"] });
      qc.invalidateQueries({ queryKey: ["interviews"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the evaluation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Selection"
        title="Interviews & evaluations"
        description="Assign a panel member by email, send the invite, and let the scorecard drive the pipeline: select advances a level (L3 select raises the offer), hold parks the candidate, reject closes them — every move audited."
      />

      <div className="space-y-6">
        <section className="panel min-w-0">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border p-4 sm:flex sm:justify-between">
            <div className="min-w-0">
              <h2 className="truncate font-semibold">Interview pipeline</h2>
              <p className="num text-xs text-muted-foreground">
                {filtered.length} of {eligible.length} candidates in play
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search candidate or role"
                className="h-9 w-52"
              />
              <Select value={stageFilter} onValueChange={setStageFilter}>
                <SelectTrigger className="h-9 w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All stages</SelectItem>
                  <SelectItem value="shortlisted">Shortlisted</SelectItem>
                  <SelectItem value="l1">L1</SelectItem>
                  <SelectItem value="l2">L2</SelectItem>
                  <SelectItem value="l3">L3</SelectItem>
                  <SelectItem value="unscheduled">Awaiting a slot</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {slot ? (
            <div className="grid gap-3 border-b border-border bg-surface-2 p-4 sm:grid-cols-2">
              <div className="text-xs font-semibold sm:col-span-2">
                {slot.interviewId ? "Re-schedule" : "Schedule"} L{slot.level} —{" "}
                {(cands.data ?? []).find(
                  (c) =>
                    c.id ===
                    (apps.data ?? []).find((a) => a.id === slot.applicationId)?.candidate_id,
                )?.full_name ?? "Candidate"}
              </div>
              <div className="sm:col-span-2">
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Candidate email — the invite goes here
                </Label>
                <Input
                  type="email"
                  value={slot.candidateEmail}
                  onChange={(e) => setSlot({ ...slot, candidateEmail: e.target.value })}
                  placeholder="candidate@example.com"
                />
              </div>
              {slot.interviewId ? (
                <div className="sm:col-span-2">
                  <Label className="mb-1.5 block text-xs text-muted-foreground">
                    Reason for re-scheduling (required, audited)
                  </Label>
                  <Input
                    value={slot.rescheduleReason}
                    onChange={(e) => setSlot({ ...slot, rescheduleReason: e.target.value })}
                    placeholder="Candidate travelling / panel conflict / client ask…"
                  />
                </div>
              ) : null}
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Interviewer name
                </Label>
                <Input
                  value={slot.interviewer}
                  onChange={(e) => setSlot({ ...slot, interviewer: e.target.value })}
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Interviewer email (gives them the queue)
                </Label>
                <Input
                  type="email"
                  value={slot.interviewerEmail}
                  onChange={(e) => setSlot({ ...slot, interviewerEmail: e.target.value })}
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">Date & time</Label>
                <Input
                  type="datetime-local"
                  value={slot.scheduledAt}
                  onChange={(e) => setSlot({ ...slot, scheduledAt: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Minutes</Label>
                  <Input
                    type="number"
                    min={15}
                    max={240}
                    value={slot.durationMins}
                    onChange={(e) => setSlot({ ...slot, durationMins: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Mode</Label>
                  <Select
                    value={slot.mode}
                    onValueChange={(v) => setSlot({ ...slot, mode: v as typeof slot.mode })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="online">Online</SelectItem>
                      <SelectItem value="onsite">Onsite</SelectItem>
                      <SelectItem value="phone">Phone</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">Meeting link</Label>
                <Input
                  value={slot.meetingLink}
                  onChange={(e) => setSlot({ ...slot, meetingLink: e.target.value })}
                  placeholder="Teams / Meet / Zoom URL"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {readyProviders.length ? (
                    readyProviders.map((p) => (
                      <Button
                        key={p.id}
                        size="sm"
                        variant="outline"
                        disabled={minting || busy}
                        onClick={() => generateLink(p.provider)}
                      >
                        {minting ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Video className="size-3.5" />
                        )}
                        Generate{" "}
                        {p.provider === "google_meet"
                          ? "Meet"
                          : p.provider === "teams"
                            ? "Teams"
                            : "Zoom"}{" "}
                        link
                      </Button>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Connect Zoom, Google Meet or Teams on the{" "}
                      <Link
                        to="/integrations"
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        Integrations
                      </Link>{" "}
                      page to generate links automatically.
                    </p>
                  )}
                </div>
              </div>
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">Agenda</Label>
                <Input
                  value={slot.agenda}
                  onChange={(e) => setSlot({ ...slot, agenda: e.target.value })}
                  placeholder="What this round must establish"
                />
              </div>
              <div className="flex gap-2 sm:col-span-2">
                <Button size="sm" onClick={saveSlot} disabled={busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null} Save slot
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSlot(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {filtered.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="Nothing matches this view"
                hint="Run the matching engine — candidates scoring 75+ are auto-shortlisted."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-xs">
                <thead className="border-b border-border bg-surface-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Candidate</th>
                    <th className="px-3 py-2 font-medium">Requisition</th>
                    <th className="px-3 py-2 font-medium">Stage</th>
                    <th className="px-2 py-2 text-right font-medium">Score</th>
                    <th className="px-2 py-2 font-medium">L1</th>
                    <th className="px-2 py-2 font-medium">L2</th>
                    <th className="px-2 py-2 font-medium">L3</th>
                    <th className="px-3 py-2 text-right font-medium">Feedback</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => {
                    const c = (cands.data ?? []).find((x) => x.id === a.candidate_id);
                    const r = (reqs.data ?? []).find((x) => x.id === a.requisition_id);
                    const s = scoreMap.get(a.id);
                    const rounds = (ivs.data ?? []).filter((i) => i.application_id === a.id);
                    const done = (evals.data ?? []).filter((e) => e.application_id === a.id);
                    return (
                      <tr
                        key={a.id}
                        className="border-b border-border align-top hover:bg-surface-2/60"
                      >
                        <td className="max-w-[190px] px-3 py-2">
                          <Link
                            to="/candidates/$id"
                            params={{ id: a.candidate_id }}
                            className="block truncate font-medium hover:underline"
                          >
                            {c?.full_name ?? "—"}
                          </Link>
                          <div className="num truncate text-[11px] text-muted-foreground">
                            {c?.experience_years ?? "—"} yrs{c?.location ? ` · ${c.location}` : ""}
                          </div>
                        </td>
                        <td className="max-w-[170px] px-3 py-2">
                          <div className="truncate">{r?.title ?? "—"}</div>
                          <div className="num truncate text-[11px] text-muted-foreground">
                            {r?.code}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <StageBadge stage={a.stage} />
                        </td>
                        <td className="num px-2 py-2 text-right font-semibold">
                          {s ? s.overall_score : "—"}
                        </td>
                        {LEVELS.map(({ level }) => {
                          const round = rounds.find((i) => i.level === level);
                          const evaluation = done.find((e) => e.level === level);
                          const when = round?.scheduled_at ? new Date(round.scheduled_at) : null;
                          return (
                            <td key={level} className="px-2 py-2">
                              {evaluation ? (
                                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium">
                                  <Lock className="size-3" /> {evaluation.recommendation}
                                  {evaluation.rating ? ` ${evaluation.rating}/5` : ""}
                                </span>
                              ) : (
                                <div className="flex flex-col items-start gap-1">
                                  <span className="num whitespace-nowrap text-[11px] text-muted-foreground">
                                    {when
                                      ? when.toLocaleString(undefined, {
                                          day: "2-digit",
                                          month: "short",
                                          hour: "2-digit",
                                          minute: "2-digit",
                                        })
                                      : round
                                        ? "awaiting slot"
                                        : "not scheduled"}
                                  </span>
                                  <div className="flex items-center gap-1">
                                    <Button
                                      size="sm"
                                      variant={round ? "secondary" : "outline"}
                                      className="h-6 px-2 text-[11px]"
                                      onClick={() => openSlot(a.id, level, round?.id ?? null)}
                                    >
                                      {round ? "Re-sched" : "Schedule"}
                                    </Button>
                                    {round?.teams_link ? (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 px-1.5"
                                        asChild
                                      >
                                        <a
                                          href={round.teams_link}
                                          target="_blank"
                                          rel="noreferrer noopener"
                                        >
                                          <Video className="size-3.5" />
                                        </a>
                                      </Button>
                                    ) : null}
                                    {round && when ? (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 px-1.5"
                                        aria-label={`Download L${level} invite`}
                                        onClick={() =>
                                          downloadIcs(
                                            `interview-l${level}-${(c?.full_name ?? "candidate").replace(/\s+/g, "-").toLowerCase()}`,
                                            buildIcs({
                                              uid: round.id,
                                              title: `L${level} interview — ${c?.full_name ?? "Candidate"} (${r?.title ?? ""})`,
                                              description: round.agenda ?? "",
                                              location: round.teams_link ?? round.mode,
                                              startsAt: round.scheduled_at!,
                                              durationMins: round.duration_mins,
                                              attendees: [round.interviewer_email, c?.email].filter(
                                                Boolean,
                                              ) as string[],
                                            }),
                                          )
                                        }
                                      >
                                        <CalendarPlus className="size-3.5" />
                                      </Button>
                                    ) : null}
                                  </div>
                                  {round && round.transcription !== "off" ? (
                                    <span
                                      className="flex items-center gap-1 text-[11px] text-muted-foreground"
                                      title={round.transcription_detail ?? undefined}
                                    >
                                      {TRANSCRIPTION_LABEL[round.transcription] ??
                                        round.transcription}
                                      {round.transcription === "requested" ||
                                      round.transcription === "ready" ? (
                                        <button
                                          type="button"
                                          className="underline"
                                          onClick={() => void declineTranscription(round.id)}
                                        >
                                          Candidate declined
                                        </button>
                                      ) : null}
                                    </span>
                                  ) : null}
                                </div>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => pickApplication(a.id)}
                          >
                            Record
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel p-5 lg:max-w-xl">
          <h2 className="font-semibold">Record an evaluation</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Use this when feedback comes to you offline. Panel members should submit their own
            scorecard from{" "}
            <Link to="/interviews/mine" className="underline">
              My interviews
            </Link>
            .
          </p>
          <div className="mt-4 space-y-4">
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Candidate</Label>
              <Select value={form.application_id} onValueChange={(v) => pickApplication(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select candidate" />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((a) => {
                    const c = (cands.data ?? []).find((x) => x.id === a.candidate_id);
                    return (
                      <SelectItem key={a.id} value={a.id}>
                        {c?.full_name}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Level</Label>
              <Select value={form.level} onValueChange={(v) => setForm({ ...form, level: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((l) => {
                    const locked = scoredLevels.has(l.level);
                    return (
                      <SelectItem key={l.level} value={String(l.level)} disabled={locked}>
                        {l.label}
                        {locked ? " — scored, final" : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {levelLocked ? (
                <p className="mt-1.5 text-xs text-destructive">
                  L{form.level} has already been scored — scorecards are final. Pick another level.
                </p>
              ) : null}
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Focus area</Label>
              <Input
                value={form.focus_area}
                onChange={(e) => setForm({ ...form, focus_area: e.target.value })}
                placeholder="System design, ownership, communication…"
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Rating (1–5)</Label>
              <Input
                type="number"
                min={1}
                max={5}
                value={form.rating}
                onChange={(e) => setForm({ ...form, rating: e.target.value })}
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Verdict</Label>
              <Select
                value={form.recommendation}
                onValueChange={(v) =>
                  setForm({ ...form, recommendation: v as typeof form.recommendation })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="select">
                    Select —{" "}
                    {form.level === "3" ? "raise offer" : `move to L${Number(form.level) + 1}`}
                  </SelectItem>
                  <SelectItem value="hold">Hold — park on hold</SelectItem>
                  <SelectItem value="reject">Reject — close the candidate</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.recommendation !== "select" && (
              <div>
                <Label className="mb-1.5 block text-xs text-muted-foreground">
                  Reason (required)
                </Label>
                <Input
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                />
              </div>
            )}
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Comments</Label>
              <Textarea
                rows={4}
                value={form.comments}
                onChange={(e) => setForm({ ...form, comments: e.target.value })}
              />
            </div>
            <Button className="w-full" onClick={submitEvaluation} disabled={busy || levelLocked}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null} Submit evaluation
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}
