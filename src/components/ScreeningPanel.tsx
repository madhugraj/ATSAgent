import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ChevronDown, Mic, Printer } from "lucide-react";

import {
  createScreeningKit,
  gradeScreeningAnswers,
  getScreeningAudioUrl,
  saveScreeningKit,
} from "@/lib/screening.functions";
import { screeningKitsQuery, screeningRunsQuery, type ScreeningRun } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScoreChip } from "@/components/ats";
import { PhoneScreeningCalls } from "@/components/PhoneScreeningCalls";

type Question = {
  id: string;
  focus: string;
  question: string;
  reason: string;
  expected_answer: string;
  weak_answer: string;
  weight: number;
};

type Verdict = {
  question_id: string;
  question: string;
  verdict: "strong" | "partial" | "weak" | "not_answered";
  score: number;
  evidence: string;
  rationale: string;
};

const FOCUS_LABEL: Record<string, string> = {
  must_have_skill: "Must-have skill",
  experience_depth: "Experience depth",
  ownership: "Ownership & impact",
  stability: "Stability & tenure",
  logistics: "Logistics & offer fit",
  culture_mindset: "Mindset & culture",
};

const VERDICT_LABEL: Record<string, string> = {
  strong: "Strong",
  partial: "Partial",
  weak: "Weak",
  not_answered: "Not answered",
};

const VERDICT_TONE: Record<string, string> = {
  strong: "text-emerald-600",
  partial: "text-amber-600",
  weak: "text-destructive",
  not_answered: "text-muted-foreground",
};

export function ScreeningPanel(props: {
  candidateId: string;
  candidateName: string;
  /** Roles this candidate is in the pipeline for. */
  roles: { requisitionId: string; title: string }[];
}) {
  const qc = useQueryClient();
  const buildKit = useServerFn(createScreeningKit);
  const saveKit = useServerFn(saveScreeningKit);
  const grade = useServerFn(gradeScreeningAnswers);
  const audioUrl = useServerFn(getScreeningAudioUrl);

  const kits = useQuery(screeningKitsQuery(props.candidateId));
  const runs = useQuery(screeningRunsQuery(props.candidateId));

  const [reqId, setReqId] = useState(props.roles[0]?.requisitionId ?? "");
  const [building, setBuilding] = useState(false);
  const [grading, setGrading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [audio, setAudio] = useState<File | null>(null);

  const kit = useMemo(() => {
    const list = kits.data ?? [];
    return list.find((k) => (reqId ? k.requisition_id === reqId : true)) ?? list[0] ?? null;
  }, [kits.data, reqId]);
  const questions = useMemo<Question[]>(
    () => (Array.isArray(kit?.questions) ? (kit!.questions as unknown as Question[]) : []),
    [kit],
  );
  const kitRuns = useMemo<ScreeningRun[]>(
    () => (runs.data ?? []).filter((r) => r.kit_id === kit?.id),
    [runs.data, kit?.id],
  );
  const latest = kitRuns[0] ?? null;
  const latestVerdicts = useMemo<Verdict[]>(
    () => (Array.isArray(latest?.verdicts) ? (latest!.verdicts as unknown as Verdict[]) : []),
    [latest],
  );

  async function prepare() {
    if (!reqId) {
      toast.error("Pick the role this call is for.");
      return;
    }
    setBuilding(true);
    try {
      const out = await buildKit({
        data: { candidateId: props.candidateId, requisitionId: reqId },
      });
      setAnswers({});
      await qc.invalidateQueries({ queryKey: ["screening_kits", props.candidateId] });
      toast.success(`${out.questions.length} questions ready — review and edit as needed.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not prepare the questions.");
    } finally {
      setBuilding(false);
    }
  }

  async function removeQuestion(qid: string) {
    if (!kit) return;
    const next = questions.filter((q) => q.id !== qid);
    if (!next.length) {
      toast.error("Keep at least one question.");
      return;
    }
    setSaving(true);
    try {
      await saveKit({ data: { kitId: kit.id, questions: next } });
      await qc.invalidateQueries({ queryKey: ["screening_kits", props.candidateId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the change.");
    } finally {
      setSaving(false);
    }
  }

  async function editQuestion(qid: string, value: string) {
    if (!kit) return;
    const next = questions.map((q) => (q.id === qid ? { ...q, question: value } : q));
    setSaving(true);
    try {
      await saveKit({ data: { kitId: kit.id, questions: next } });
      await qc.invalidateQueries({ queryKey: ["screening_kits", props.candidateId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the change.");
    } finally {
      setSaving(false);
    }
  }

  async function submitAnswers() {
    if (!kit) return;
    setGrading(true);
    try {
      let audioPayload: { filename: string; contentType: string; base64: string } | null = null;
      if (audio) {
        const buf = new Uint8Array(await audio.arrayBuffer());
        let binary = "";
        for (let i = 0; i < buf.length; i += 8192) {
          binary += String.fromCharCode(...buf.subarray(i, i + 8192));
        }
        audioPayload = {
          filename: audio.name,
          contentType: audio.type || "audio/webm",
          base64: btoa(binary),
        };
      }
      const out = await grade({
        data: {
          kitId: kit.id,
          answers: questions.map((q) => ({ question_id: q.id, answer: answers[q.id] ?? "" })),
          notes: notes.trim() || null,
          audio: audioPayload,
        },
      });
      setAudio(null);
      await qc.invalidateQueries({ queryKey: ["screening_runs", props.candidateId] });
      toast.success(`Screening ${out.screening_score}/100 · ${out.recommendation}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not score the answers.");
    } finally {
      setGrading(false);
    }
  }

  async function openRecording(runId: string) {
    try {
      const { dataUrl } = await audioUrl({ data: { runId } });
      // data: URLs cannot be opened as top-level targets — pipe through a blob.
      const blob = await (await fetch(dataUrl)).blob();
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open the recording.");
    }
  }

  const copyAll = () => {
    const text = questions
      .map(
        (q, i) =>
          `${i + 1}. ${q.question}\n   Why: ${q.reason}\n   Looking for: ${q.expected_answer}`,
      )
      .join("\n\n");
    navigator.clipboard?.writeText(text).catch(() => undefined);
    toast.success("Questions copied.");
  };

  return (
    <section id="screening" className="panel scroll-mt-24 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Screening call support</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Questions built from this CV against this job description, each with why it matters and
            the answer to listen for. Record what {props.candidateName.split(" ")[0]} says and get a
            second-level score.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {props.roles.length > 1 ? (
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={reqId}
              onChange={(e) => setReqId(e.target.value)}
            >
              {props.roles.map((r) => (
                <option key={r.requisitionId} value={r.requisitionId}>
                  {r.title}
                </option>
              ))}
            </select>
          ) : null}
          <Button size="sm" onClick={prepare} disabled={building || !props.roles.length}>
            {building ? "Preparing…" : questions.length ? "Rebuild questions" : "Prepare questions"}
          </Button>
        </div>
      </div>

      {reqId ? (
        <PhoneScreeningCalls
          candidateId={props.candidateId}
          requisitionId={reqId}
          hasKit={Boolean(kit && kit.requisition_id === reqId && questions.length)}
        />
      ) : null}

      {!props.roles.length ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Add this candidate to a role first — the questions are built from that job description.
        </p>
      ) : null}

      {kit && questions.length ? (
        <>
          {kit.focus_summary ? (
            <p className="mt-3 rounded-md border bg-muted/40 p-2.5 text-sm">{kit.focus_summary}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <button type="button" className="hover:text-foreground" onClick={copyAll}>
              Copy all
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 hover:text-foreground"
              onClick={() => window.print()}
            >
              <Printer className="size-3.5" /> Print
            </button>
          </div>

          <ol className="mt-4 space-y-2">
            {questions.map((q, i) => {
              const verdict = latestVerdicts.find((v) => v.question_id === q.id);
              const expanded = open === q.id;
              return (
                <li key={q.id} className="rounded-lg border">
                  <div className="flex items-start gap-2 p-3">
                    <span className="mt-0.5 text-xs text-muted-foreground">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                          {FOCUS_LABEL[q.focus] ?? "General"}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          weight {q.weight}/5
                        </span>
                        {verdict ? (
                          <span
                            className={`text-[11px] font-medium ${VERDICT_TONE[verdict.verdict]}`}
                          >
                            {VERDICT_LABEL[verdict.verdict]} · {verdict.score}/100
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-sm font-medium">{q.question}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Why ask: </span>
                        {q.reason}
                      </p>
                      <button
                        type="button"
                        className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary"
                        onClick={() => setOpen(expanded ? null : q.id)}
                      >
                        <ChevronDown
                          className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
                        />
                        {expanded ? "Hide" : "Expected answer & notes"}
                      </button>

                      {expanded ? (
                        <div className="mt-2 space-y-2 border-t pt-2">
                          <p className="text-xs">
                            <span className="font-medium">Strong answer contains: </span>
                            <span className="text-muted-foreground">{q.expected_answer}</span>
                          </p>
                          {q.weak_answer ? (
                            <p className="text-xs">
                              <span className="font-medium">Weak answer sounds like: </span>
                              <span className="text-muted-foreground">{q.weak_answer}</span>
                            </p>
                          ) : null}
                          <div className="space-y-1">
                            <Label className="text-xs">What the candidate said</Label>
                            <Textarea
                              rows={3}
                              value={answers[q.id] ?? ""}
                              onChange={(e) =>
                                setAnswers((a) => ({ ...a, [q.id]: e.target.value }))
                              }
                              placeholder="Type or paste the answer…"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Reword the question</Label>
                            <Input
                              defaultValue={q.question}
                              disabled={saving}
                              onBlur={(e) => {
                                if (e.target.value.trim() && e.target.value !== q.question) {
                                  editQuestion(q.id, e.target.value.trim());
                                }
                              }}
                            />
                          </div>
                          {verdict ? (
                            <div className="rounded-md bg-muted/50 p-2 text-xs">
                              <p className={`font-medium ${VERDICT_TONE[verdict.verdict]}`}>
                                {VERDICT_LABEL[verdict.verdict]} — {verdict.rationale}
                              </p>
                              {verdict.evidence ? (
                                <p className="mt-1 text-muted-foreground">
                                  Heard: “{verdict.evidence}”
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                          <button
                            type="button"
                            className="text-xs text-destructive"
                            disabled={saving}
                            onClick={() => removeQuestion(q.id)}
                          >
                            Remove this question
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="mt-4 space-y-2 rounded-lg border bg-card/50 p-3">
            <p className="text-sm font-semibold">Second-level scoring</p>
            <div className="space-y-1">
              <Label className="text-xs">Whole-call notes or transcript (optional)</Label>
              <Textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Paste the full conversation if you did not answer question by question…"
              />
            </div>
            <div className="space-y-1">
              <Label className="flex items-center gap-1.5 text-xs">
                <Mic className="size-3.5" /> Or upload the call recording
              </Label>
              <Input
                type="file"
                accept="audio/*"
                onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                Stored privately, transcribed with your organisation&apos;s configured AI, then
                matched to the questions above.
              </p>
            </div>
            <Button size="sm" onClick={submitAnswers} disabled={grading}>
              {grading ? "Scoring…" : "Score the answers"}
            </Button>
          </div>
        </>
      ) : null}

      {latest ? (
        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Screening</p>
              <ScoreChip score={latest.screening_score} />
            </div>
            {latest.match_score !== null ? (
              <div>
                <p className="text-xs text-muted-foreground">JD↔CV match</p>
                <ScoreChip score={latest.match_score} />
              </div>
            ) : null}
            {latest.combined_score !== null ? (
              <div>
                <p className="text-xs text-muted-foreground">Combined fit</p>
                <ScoreChip score={latest.combined_score} />
              </div>
            ) : null}
            <div className="text-xs">
              <p className="font-semibold capitalize">{latest.recommendation}</p>
              <p className="text-muted-foreground">{latest.recommendation_reason}</p>
            </div>
          </div>
          {latest.rationale ? <p className="mt-2 text-sm">{latest.rationale}</p> : null}
          {latest.red_flags.length ? (
            <ul className="mt-2 list-inside list-disc text-xs text-destructive">
              {latest.red_flags.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            {`Graded ${new Date(latest.created_at).toLocaleString()}`}
          </p>
          {latest.audio_path ? (
            <button
              type="button"
              className="mt-1 text-xs text-primary underline-offset-2 hover:underline"
              onClick={() => openRecording(latest.id)}
            >
              Open the recording
            </button>
          ) : null}
        </div>
      ) : null}

      {kitRuns.length > 1 ? (
        <div className="mt-3 overflow-x-auto">
          <p className="text-xs font-medium text-muted-foreground">Earlier calls</p>
          <table className="mt-1 w-full text-xs">
            <tbody>
              {kitRuns.slice(1).map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1.5 pr-2">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="py-1.5 pr-2">{r.screening_score}/100</td>
                  <td className="py-1.5 pr-2 capitalize">{r.recommendation}</td>
                  <td className="py-1.5 text-muted-foreground">{r.input_kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
