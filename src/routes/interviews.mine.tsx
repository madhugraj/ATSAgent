import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { CalendarPlus, FileText, Loader2, Lock, Video } from "lucide-react";

import {
  interviewerUnavailable,
  markInterviewOutcome,
  myInterviews,
  myRoundBrief,
  submitScorecard,
  type MyInterview,
} from "@/lib/interviews.functions";
import { buildIcs, downloadIcs } from "@/lib/ics";
import { STAGE_LABEL } from "@/lib/lifecycle";
import { EmptyState, PageHeader, StageBadge } from "@/components/ats";
import {
  EMPTY_SCORECARD,
  ScorecardFields,
  scorecardReady,
  type ScorecardValue,
} from "@/components/CompetencyRating";
import { PanelBriefView } from "@/components/PanelBriefView";
import { ChangeTime, ScorecardChange } from "@/components/interviews/PanelChanges";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useOrg } from "@/hooks/useOrg";
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

export const Route = createFileRoute("/interviews/mine")({
  head: () => ({
    meta: [
      { title: "My Interviews & Scorecards — ATS" },
      {
        name: "description",
        content:
          "The interviewer's own queue: upcoming rounds, meeting links, calendar invites and a locked competency scorecard that auto-advances the candidate.",
      },
      { property: "og:title", content: "My Interviews & Scorecards" },
      {
        property: "og:description",
        content:
          "Submit competency ratings and a select/hold/reject verdict — the pipeline moves itself, fully audited.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MyInterviewsPage,
});

const COMPETENCIES_BY_LEVEL: Record<number, string[]> = {
  1: ["Core technical depth", "Problem solving", "Code / craft quality", "Communication"],
  2: ["Domain knowledge", "Role fit", "Ownership", "Collaboration"],
  3: ["Leadership", "Strategic thinking", "Culture alignment", "Growth potential"],
};

function MyInterviewsPage() {
  const qc = useQueryClient();
  const fetchMine = useServerFn(myInterviews);
  const submit = useServerFn(submitScorecard);

  const mine = useQuery({ queryKey: ["my_interviews"], queryFn: () => fetchMine({}) });
  const { panelOnly } = useOrg();
  const [briefId, setBriefId] = useState<string | null>(null);
  const rounds = (mine.data ?? []) as MyInterview[];

  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<ScorecardValue & { focus: string }>({
    ...EMPTY_SCORECARD,
    focus: "",
  });

  function openScorecard(round: MyInterview) {
    setOpenId(round.id);
    setForm({ ...EMPTY_SCORECARD, focus: "" });
  }

  const [changing, setChanging] = useState<MyInterview | null>(null);
  const cannot = useServerFn(interviewerUnavailable);
  async function cannotMakeIt(round: MyInterview) {
    const note = window.prompt(
      "You can't make this interview? A stand-in will be proposed to the hiring manager; the candidate keeps their time if the stand-in is free. Anything to add? (optional)",
    );
    if (note === null) return;
    try {
      await cannot({ data: { interviewId: round.id, note } });
      toast.success("Recorded — a stand-in will be arranged");
      qc.invalidateQueries({ queryKey: ["my_interviews"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record this");
    }
  }

  const outcome = useServerFn(markInterviewOutcome);
  async function didNotHappen(
    round: MyInterview,
    kind: "candidate_no_show" | "interviewer_unavailable" | "cancelled",
  ) {
    const note = window.prompt("Anything to add for the team? (optional)") ?? "";
    try {
      await outcome({ data: { interviewId: round.id, outcome: kind, note } });
      toast.success("Recorded — the team is told and new times will be offered");
      qc.invalidateQueries({ queryKey: ["my_interviews"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record this");
    }
  }

  async function send(round: MyInterview) {
    const names = round.competencies.length
      ? round.competencies
      : (COMPETENCIES_BY_LEVEL[round.level] ?? []);
    const competencies = names
      .filter((n) => form.ratings[n])
      .map((n) => ({ name: n, rating: form.ratings[n]! }));
    if (!form.verdict || !scorecardReady(form, names)) {
      toast.error("Rate every competency, pick a verdict and give a reason for a hold or reject");
      return;
    }
    setBusy(true);
    try {
      const res = await submit({
        data: {
          interviewId: round.id,
          applicationId: round.application_id,
          level: round.level,
          focusArea: form.focus || null,
          verdict: form.verdict,
          comments: form.comments || null,
          reason: form.reason || null,
          competencies,
        },
      });
      toast.success(
        !res.roundComplete
          ? `Scorecard locked — waiting for ${res.waitingFor.join(", ")} to score this round`
          : res.movedTo
            ? `Scorecard locked — candidate moved to ${STAGE_LABEL[res.movedTo]}`
            : "Scorecard locked",
      );
      if (res.decisionPending) toast.info(res.decisionPending);
      if (res.blocked) toast.warning(res.blocked);
      if (res.nextInterviewCreated) toast.info("Next round queued for scheduling");
      setOpenId(null);
      qc.invalidateQueries({ queryKey: ["my_interviews"] });
      qc.invalidateQueries({ queryKey: ["applications"] });
      qc.invalidateQueries({ queryKey: ["interviews"] });
      qc.invalidateQueries({ queryKey: ["evaluations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not submit the scorecard");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={!!changing} onOpenChange={(o) => !o && setChanging(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {changing ? `L${changing.level} · ${changing.candidate_name}` : ""}
            </DialogTitle>
          </DialogHeader>
          {changing?.change_token ? (
            <div className="space-y-4">
              <ChangeTime
                token={changing.change_token}
                onDone={() => {
                  setChanging(null);
                  void qc.invalidateQueries({ queryKey: ["my_interviews"] });
                }}
              />
              <ScorecardChange token={changing.change_token} />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <PageHeader
        eyebrow="Interviewer"
        title="My interviews"
        description="Your rounds, including panels you sit on. Rate the role's own competencies and give your verdict once — it locks and is attributed to you. When everyone on the panel has scored, the round completes; the hiring manager makes the hiring decision."
        actions={
          panelOnly ? null : (
            <Button variant="outline" asChild>
              <Link to="/interviews">Recruiter view</Link>
            </Button>
          )
        }
      />

      {mine.isLoading ? (
        <div className="panel flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading your queue…
        </div>
      ) : rounds.length === 0 ? (
        <EmptyState
          title="No interviews assigned to you"
          hint="A recruiter assigns rounds by your email address on the Interviews page."
        />
      ) : (
        <div className="space-y-4">
          {rounds.map((round) => {
            const when = round.scheduled_at ? new Date(round.scheduled_at) : null;
            // Scorecards and "didn't happen" are for after the start; before it, "can't make it".
            const started = !when || when.getTime() <= Date.now();
            const booked = ["scheduled", "rescheduled"].includes(round.status);
            const isOpen = openId === round.id;
            const names = round.competencies.length
              ? round.competencies
              : (COMPETENCIES_BY_LEVEL[round.level] ?? []);
            return (
              <article key={round.id} className="panel overflow-hidden">
                <div className="flex flex-wrap items-center gap-4 p-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {panelOnly ? (
                        <span className="font-semibold">{round.candidate_name}</span>
                      ) : (
                        <Link
                          to="/candidates/$id"
                          params={{ id: round.candidate_id }}
                          className="font-semibold hover:underline"
                        >
                          {round.candidate_name}
                        </Link>
                      )}
                      {round.stage !== `l${round.level}` ? (
                        <span className="text-xs text-muted-foreground">now</span>
                      ) : null}
                      <StageBadge stage={round.stage} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      L{round.level} · {round.requisition_title} ·{" "}
                      {when ? when.toLocaleString() : "not scheduled yet"} · {round.duration_mins}{" "}
                      min · {round.mode}
                    </p>
                    {round.round_name ? (
                      <p className="mt-1 text-xs">
                        <span className="font-medium">{round.round_name}</span>
                        {round.panel.length > 1 ? ` · panel: ${round.panel.join(", ")}` : ""}
                      </p>
                    ) : null}
                    {round.agenda ? (
                      <p className="mt-1 text-xs text-muted-foreground">{round.agenda}</p>
                    ) : null}
                    {round.submitted && round.waiting_for.length ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Waiting for {round.waiting_for.join(", ")} to score this round.
                      </p>
                    ) : null}
                    {["cancelled", "no_show"].includes(round.status) ? (
                      <p className="mt-1 text-xs font-medium text-destructive">
                        Did not happen ({round.status.replace("_", " ")}).
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={briefId === round.id}
                      onClick={() => setBriefId(briefId === round.id ? null : round.id)}
                    >
                      <FileText className="size-4" /> Brief & CV
                    </Button>
                    {round.teams_link ? (
                      <Button variant="ghost" size="sm" asChild>
                        <a href={round.teams_link} target="_blank" rel="noreferrer noopener">
                          <Video className="size-4" /> Join
                        </a>
                      </Button>
                    ) : null}
                    {when ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          downloadIcs(
                            `interview-l${round.level}-${round.candidate_name.replace(/\s+/g, "-").toLowerCase()}`,
                            buildIcs({
                              uid: round.id,
                              title: `L${round.level} interview — ${round.candidate_name} (${round.requisition_title})`,
                              description: round.agenda ?? "",
                              location: round.teams_link ?? round.mode,
                              startsAt: round.scheduled_at!,
                              durationMins: round.duration_mins,
                            }),
                          )
                        }
                      >
                        <CalendarPlus className="size-4" /> Add to calendar
                      </Button>
                    ) : null}
                    {booked && !started ? (
                      round.i_cannot_make_it ? (
                        <span className="text-xs text-muted-foreground">
                          You can&apos;t make it — a stand-in is being arranged
                        </span>
                      ) : round.change_token ? (
                        <Button variant="outline" size="sm" onClick={() => setChanging(round)}>
                          Change time or scorecard
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void cannotMakeIt(round)}
                        >
                          Can&apos;t make it
                        </Button>
                      )
                    ) : null}
                    {!round.submitted && booked && started ? (
                      <Select value="" onValueChange={(v) => void didNotHappen(round, v as never)}>
                        <SelectTrigger className="h-8 w-auto text-xs">
                          <SelectValue placeholder="Didn't happen?" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="candidate_no_show">Candidate did not join</SelectItem>
                          <SelectItem value="interviewer_unavailable">
                            I could not make it
                          </SelectItem>
                          <SelectItem value="cancelled">Cancelled</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : null}
                    {["cancelled", "no_show"].includes(round.status) ? null : round.submitted ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Lock className="size-3.5" /> Scored
                      </span>
                    ) : !started ? (
                      <span
                        className="flex items-center gap-1.5 text-xs text-muted-foreground"
                        title="A scorecard records what happened in the interview"
                      >
                        <Lock className="size-3.5" /> Scorecard opens when it starts
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => (isOpen ? setOpenId(null) : openScorecard(round))}
                      >
                        {isOpen ? "Close" : "Submit scorecard"}
                      </Button>
                    )}
                  </div>
                </div>
                {briefId === round.id ? <RoundBrief interviewId={round.id} /> : null}

                {isOpen && !round.submitted && (
                  <div className="grid gap-4 border-t border-border bg-surface-2 p-5 md:grid-cols-2">
                    <ScorecardFields
                      competencies={names}
                      rubric={round}
                      value={form}
                      onChange={(v) => setForm((f) => ({ ...f, ...v }))}
                    />
                    <div className="space-y-3">
                      <div>
                        <Label className="mb-1.5 block text-xs text-muted-foreground">
                          Focus area covered
                        </Label>
                        <Input
                          value={form.focus}
                          onChange={(e) => setForm((f) => ({ ...f, focus: e.target.value }))}
                          placeholder="System design, ownership, communication…"
                        />
                      </div>
                      <Button className="w-full" onClick={() => send(round)} disabled={busy}>
                        {busy ? <Loader2 className="size-4 animate-spin" /> : null} Submit & lock
                        scorecard
                      </Button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

function RoundBrief({ interviewId }: { interviewId: string }) {
  const fetchBrief = useServerFn(myRoundBrief);
  const q = useQuery({
    queryKey: ["round_brief", interviewId],
    queryFn: () => fetchBrief({ data: { interviewId } }),
  });
  return (
    <div className="border-t border-border p-5">
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : q.data ? (
        <PanelBriefView brief={q.data} />
      ) : (
        <p className="text-sm text-destructive">{(q.error as Error | null)?.message}</p>
      )}
    </div>
  );
}
