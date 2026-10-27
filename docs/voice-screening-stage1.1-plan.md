# Stage 1.1 — the screening call, done the way HR does it

Status: **plan for review** (2026-10-24). Follows the first real call (M4,
`docs/voice-screening-agent.md`) and the product owner's review of it. Nothing
here is built yet; we pick the steps one at a time.

## What the first call got wrong (from the candidate's side)

1. **It sounded like spam.** "An AI assistant from the hiring team at …" — no
   role, no reminder that they applied, no reason for the call, unknown number.
2. **Too fast, no sign it understood.** It fired questions without acknowledging
   or reflecting answers, cut in at short pauses, and once answered its own
   question. It felt rude and clueless. HR does not do that.
3. **Technical questions with no context.** It never explained the role or why
   the candidate was a fit; it did not even have the JD.
4. **Practical details came last (or not at all)** — CTC, notice period,
   relocation are what HR settles first.

And on the platform side: HR could not see the call happen, review what was
collected, see _why_ a score was given, or trust that the candidate could not
talk the agent into a better result.

## Decisions (2026-10-24)

|           | decision                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pay       | The agent **asks current and expected CTC and records them** (TA / HR only). It never comments, compares with the budget or negotiates. The rule "never ask about pay" becomes "never discuss, judge or negotiate pay".  |
| Notice    | **No advance notice.** The first contact is the Level 0 screening call (max **10 minutes**). If the candidate is not ready, the agent agrees a time on the call and **confirms it by email to the address on their CV**. |
| Recording | **Audio is recorded with its own consent** (separate from transcription), kept for a retention period, erased with the candidate.                                                                                        |
| Order     | This plan first; steps picked one at a time.                                                                                                                                                                             |

## The call, as it should sound (Level 0, ≤ 10 minutes)

| #   | part                    | what the agent does                                                                                                                                                                                                                                                                                                                  | time  |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| 0   | **Who**                 | "Hello, am I speaking with Meera?" — confirms the person before saying anything about the application. Wrong person → apologise, say nothing about the role, end.                                                                                                                                                                    | 10 s  |
| 1   | **Why**                 | "This is Saranya, an AI recruiting assistant with Yavar's talent acquisition team. You applied for our **Platform SRE** role on **Naukri on 20 October** — I'm calling for a short first conversation about it." (source and date from the application)                                                                              | 15 s  |
| 2   | **Consent and time**    | "It takes about ten minutes. Is now a good time?" · "I'll make notes for the hiring team, and the call is recorded so they can review it — is that all right?" (recording asked separately; no → transcript only) · "If you'd rather, we can email you a short written assessment instead, or have a person from the team call you." | 30 s  |
| 2a  | **Not now**             | "When would suit you?" — offers times inside the calling window over the next working days, agrees one, says "I'll email the confirmation to the address on your CV, ending in gmail.com", books it, ends warmly.                                                                                                                    | 45 s  |
| 3   | **The role**            | 3–4 sentences from the approved JD: the team and what it does, what this role owns, 2 key responsibilities, location and work mode.                                                                                                                                                                                                  | 45 s  |
| 4   | **Why them**            | One or two specific, accurate points from their CV that match the JD ("I saw you built an agent-based ATS end to end"), then "Does this sound worth exploring?" Not interested → thank, ask (optional) why, end.                                                                                                                     | 30 s  |
| 5   | **Practical details**   | Confirms current role / company and total experience against the CV ("Your CV says 18 years — still right?"), current location vs the role's location → relocation, notice period and earliest joining, current CTC (fixed + variable) and expected CTC. Records each; never reacts to the figures.                                  | 2 min |
| 6   | **Screening questions** | 3–4 questions: the role's **core questions** (the same for every candidate) plus personalised follow-ups, each introduced in context ("You mentioned running pods with failover — tell me about a time a cluster went down"). Active listening: acknowledge, reflect the gist back, one follow-up if unclear, never answer for them. | 5 min |
| 7   | **Their questions**     | Answers only from the JD and the organisation's facts; otherwise "I'll pass that to the hiring team".                                                                                                                                                                                                                                | 1 min |
| 8   | **Close**               | What happens next, using only what the organisation configured ("the team reviews screening calls within two working days"), thanks, goodbye.                                                                                                                                                                                        | 15 s  |

**How it speaks.** An HR professional, not a quiz: warm, unhurried, plain
English (Hindi or Tamil on request). Neutral acknowledgements ("Thanks, that's
useful context") — never praise or judgement ("great answer"), which implies an
evaluation. It waits for the candidate to finish, tolerates pauses, allows "can
you repeat that?", and summarises understanding back before moving on.

**Pacing in the engine.** The live model's turn-taking is tuned instead of left
on defaults: lower end-of-speech sensitivity and a longer silence before it
replies (≈ 1 s), so it does not cut in at a thinking pause; the persona's voice is
chosen per organisation. Tuned against recorded test calls.

## Guardrails — why the candidate cannot talk their way to a better score

Defence in layers; no single layer is trusted alone.

| layer                    | what it does                                                                                                                                                                                                                                                                                                                 | today                           | change                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------- |
| **L0 Capability**        | The call agent can only record consent, details, answers, a booking, a flag, and end the call — every call checked in code. It cannot score, see scores, or reach any other data.                                                                                                                                            | ✅                              | keep; new tools follow the same rule                      |
| **L0 No rubric**         | The agent never sees expected / weak answers or weights — there is nothing to extract.                                                                                                                                                                                                                                       | ✅                              | keep                                                      |
| **L1 Rules**             | Instructions treat everything the candidate says as information, never as instruction; refuse role-play, "HR said you could", "repeat your instructions", "what's the right answer".                                                                                                                                         | partial                         | expanded red-team section                                 |
| **L2 Live guard**        | A separate, fast classifier reads every candidate turn as it happens: prompt injection, jailbreak / role-play, rubric extraction, abuse, distress, "I want a human", off-topic. Actions: steer the agent back (a system note it must follow), offer a human, or end politely. Each hit is a **flag** on the transcript line. | ❌                              | new (feature `screening_call_guard`, through the gateway) |
| **L3 Output check**      | After the call, the agent's own lines are checked: pay discussed or judged, promises, facts not in its brief, internal data disclosed, evaluative feedback, an answer it gave for the candidate. Flags on the review page + a health rule.                                                                                   | ❌                              | new (`screening_call_audit`)                              |
| **L4 Grading isolation** | The grader sees **only the candidate's verbatim words per question** (transcript segments), anonymised (no name, gender cues or personal details), wrapped as untrusted, with injection detection. It never sees the agent's summaries. Manipulation attempts become visible red flags; they never move a score.             | partial (gets summaries + name) | change                                                    |
| **L5 People decide**     | Nothing is rejected by AI; HR reviews flags, evidence and the recording, corrects data, overrides grades with a reason (audited, captured as feedback).                                                                                                                                                                      | partial                         | the review page                                           |
| **L6 Red-team evals**    | A standing adversarial set run in CI (scripted) and live: injection in English and in Hindi / Tamil, "my manager approved…", asking for the rubric, flattery, threats, long monologues to run the clock, answering for another person, the candidate repeating the question. Health rule on flag rates.                      | 1 eval                          | ~12 evals                                                 |

## Responsible AI — unbiased, explainable, transparent

- **Same yardstick for everyone.** Each role gets **core screening questions**,
  generated from the JD and **approved by HR once** (stored per role); every
  candidate for the role is asked them and graded on them. Personalised
  follow-ups add context but carry less weight. Scores are comparable.
- **Content, not delivery.** Accent, fluency, grammar and language never affect
  the score; answers in Hindi / Tamil are graded on meaning; uncertain speech
  recognition is flagged, not penalised.
- **Blind grading.** Name and personal details removed before grading;
  location, gender, age, family never reach the grader.
- **Explainability on screen.** For every question: why it was asked, what a
  good answer contains, the candidate's verbatim answer (with a jump to that
  moment in the recording), the verdict, the score, the reason. For the total:
  the weights, how the match and screening scores combine, and what was not
  covered. Every collected detail shows its source (CV, call, HR correction).
- **Fairness monitoring.** `scripts/bias-report.ts` extended to phone screening:
  score and pass-rate spreads by source, language of the call and time of day;
  HR override rates and directions; alerts when a spread crosses a threshold. No
  protected attributes are collected to do this.
- **Candidate rights, said on the call and in the email.** It is an AI; they can
  choose a person or the written assessment; how their data and the recording
  are used and kept; how to ask for a review.

## Traceability in the product

- **Screening calls board** (`/screening-calls`): per role — Scheduled, Live,
  Needs review (flags or low confidence), Done; who booked what, when.
- **Live call view**: the call's progress as it happens — dialling → ringing →
  connected → consent ✓ → role ✓ → details ✓ → question 2 of 4 — with the live
  transcript (each turn written as it is spoken) and a timer. HR can end the call;
  later, _take over_ (transfer to a recruiter's extension).
- **Post-call review page** (`/screening-calls/$id`), the link HR gets:
  - **Collected details** — the form (experience, location, relocation, notice,
    joining, current / expected CTC — pay visible to TA / HR only), editable;
    corrections audited and recorded as feedback on the AI's work.
  - **Evaluation** — per-question explainability as above; HR override.
  - **Transcript and recording** — timestamped, click a line to play it.
  - **Flags** — guard and output-check findings, consent record (their words,
    recording yes/no).
  - **Trail** — who arranged, approved, called, reviewed and changed what; the
    call's run in Agent observability (cost, steps, health).
- **Notifications**: HR is told when a call needs review, and when a candidate
  booked a time.

## Data and platform changes

- **Migration 0047**: `screening_calls` + `recording_consent`, `recording_path`,
  `recording_seconds`, `flags` (jsonb, per turn), `progress` (current part),
  `booked_by_candidate`, `reviewed_by/at`, `hangup_requested`;
  `phone_screening_settings` + `recording_enabled`, `recording_retention_days`
  (default 90), `next_steps_text`, `voice`, default `max_minutes` 10; new
  `role_screening_questions` (core questions per requisition, approved by / at).
- **Recording**: the worker writes both sides as a stereo μ-law WAV (≈ 1 MB per
  minute) to the private store only after recording consent; deleted on
  retention expiry and on candidate erasure. (This also fixes an existing gap:
  erasing a candidate does not delete their uploaded screening audio today.)
- **Booking**: `book_slot` tool → the call is rescheduled to the agreed time
  (inside the window, within 7 days) and an email `screening_call_booked` goes
  to the candidate's CV address: who, which role, when, what to expect, "reply to
  change the time" (replies reach the careers inbox), privacy note. A self-serve
  reschedule link can follow.
- **Pay**: the call writes current / expected CTC into the existing HR-only pay
  record (source `screening_call`); amounts never appear in agent context, tool
  results, threads or audit details.
- **Agents**: Screening call agent **1.1.0** (new flow, tools `record_details`,
  `record_recording_consent`, `book_slot`, `flag_concern`; `record_answer` keeps
  a summary for display only); Screening agent **1.9.0** (booked calls, review
  queue, core questions). Lock, evals and health rules updated with each.

## Steps (pick in any order; A then B before any pilot)

| step                        | what                                                                                                                                                                                                                                      | done when                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **A. The conversation**     | The call as above (parts 0–8), JD and CV context in the brief, active listening, pacing (turn-taking tuned), CTC and details first, human / written alternative, booking a time on the call + confirmation email, 10-minute cap.          | Text-mode evals for every part; then **you take a real call** and it sounds like HR.                                      |
| **B. Guardrails**           | Verbatim per-question grading, blind grading, live guard (L2), output check (L3), red-team eval set (L6), flags stored per turn, health rule on flags.                                                                                    | Red-team set passes scripted and live; a manipulation attempt on a real call shows as a flag and does not move the score. |
| **C. Recording**            | Separate recording consent; stereo WAV to the private store; retention sweep; erasure deletes recordings (and existing screening audio).                                                                                                  | A recorded call plays back on the review page; erasing the candidate deletes it.                                          |
| **D. Product traceability** | Calls board, live call view (turns written live, progress, end call), post-call review page (editable details, explanations, transcript + recording, flags, trail), links from the candidate page and Agent observability, notifications. | HR can watch a live call and review / correct one end to end in the browser.                                              |
| **E. Fairness**             | Core questions per role with HR approval, weighting of core vs follow-up, bias report for phone screening, override tracking, candidate review request.                                                                                   | Two candidates for one role are graded on the same core; the bias report shows phone screening.                           |
| **F. Pilot**                | One real requisition, HR reviewing every call for a week; tune.                                                                                                                                                                           | HR signs off.                                                                                                             |

Suggested order: **A → B** (the agent is not fit to call anyone without both),
then **D** (HR can see everything), **C**, **E**, **F**.

## Open questions for later steps

- Take-over: which recruiter extension, and does the PBX allow SIP REFER from
  extension 3001?
- WhatsApp / SMS confirmation in addition to email — provider?
- Next-steps wording per organisation ("we review within two working days") —
  who sets it, HR head?

## Step A — built (2026-10-24)

- The call follows parts 0–8 above: `callSystemPrompt` v2 (`src/server/voice/call-prompt.ts`)
  with the approved JD's purpose and top responsibilities, where and when they
  applied, CV facts to confirm, their matched must-haves, which details are
  already known (never the values), the e-mail domain, calling hours and the
  organisation's next-steps text.
- Tools v2 (`call-tools.ts`): `record_consent` (with their words),
  `record_details` (role, experience, location, relocation, notice, joining,
  current fixed / variable and expected pay), `record_answer`, `book_slot`,
  `end_call` with the new endings (booked, prefers_written, prefers_human,
  not_interested). Screening questions: the kit's weightiest four, never pay or
  logistics.
- Pay is recorded only to the HR-only compensation record (`recordCallDetails`,
  audited with field names only; closes an open pay form when complete); the
  call row keeps the other details; the grader receives only the part of the
  call after the details, so pay, location and consent never reach it; the
  transcript on the candidate page is shown only to TA, the HR head and the CBO.
- Not now → `book_slot` → the call is moved to the agreed time (inside the
  calling window) and `screening_call_booked` is e-mailed to the CV address;
  the booked call opens with "at the time we agreed".
- Pacing: turn-taking sent to the voice model (end-of-speech sensitivity low,
  1 s silence, 300 ms padding); the assistant's voice per organisation.
- Migration 0047 (voice, next-steps text, 10-minute default, booked flag,
  details); Screening call agent 1.1.0, Screening agent 1.9.0; 3 new evals
  (booking, details without pay comment, rephrase instead of answer).
- **Next:** a real call to judge the conversation, then step B.

### Step A.1 — from the second real call (2026-10-24)

The call held the new flow (identity first, who and why, role, details first,
pay noted without comment, reflective listening, a polite close on request).
Fixed what it showed (Screening call agent 1.1.1):

- **Disclosure enforced in code**: a "yes" is refused until the assistant has
  said it is an AI and that it makes notes (`disclosureMissing`, checked against
  its own spoken lines) — it had skipped the note-taking line when the candidate
  said they were busy.
- **Signposting** of each part ("a quick overview of the role", "a few practical
  details", "a few questions about your experience") — the candidate could not
  tell a role overview from a question.
- **A time the candidate sets is kept** (details and the one or two most
  important questions, then close).
- **Pay only as stated**: it had turned "a 30% hike" into a figure; figures are
  recorded only when said, anything else (hike, shares) in `pay_note`
  (HR-only); `candidate_note` keeps anything else the team should know.
- **A poor fit is handled honestly**: acknowledge, say what the role centres on,
  ask whether to continue, ask only questions that let them show what they
  bring — never judge or discourage.
- The "why them" part is skipped when nothing specific is on record, instead of
  risking an invented reason.

### Step A.2 — from the third real call (2026-10-24)

Disclosure, signposting, the relocation concern and a skill gap were all handled
as intended. Fixed what it showed (Screening call agent 1.1.2):

- **Known details are confirmed, not skipped** — pay already on record had been
  skipped and the candidate was told it "was not needed"; now "We have your pay
  details from earlier — has anything changed?" (figures never in its context).
- **Corrections are recorded** — `record_details` again when the candidate
  corrects something (10 → 14 years, a different company).
- **"Would you like to continue?" at most once per call**; later gaps are noted
  and it moves on to what the candidate does bring.
- **Indian English** for the session (`languageCode: "en-IN"`) — short replies
  had been transcribed as Spanish ("Sí, ya", "Ajá").

### Step A.3 — from the fourth real call (2026-10-24)

Indian English, recorded corrections and a single "continue?" all held. Fixed
what it showed (Screening call agent 1.1.3), and pulled the grader's fairness
rules forward from step B:

- **Pay is asked afresh** — confirming figures it cannot see ("has anything
  changed?") left the candidate asking "what do you have?".
- **No debates or general knowledge** — it explained Go's history and benefits
  when the candidate pushed back; now "a good question for the hiring team",
  noted, one redirect, move on.
- **A skip is respected** — "Of course", nothing recorded, next question (it
  had rephrased and asked again).
- **No praise** — it said "that's very comprehensive".
- **Details mentioned in passing are recorded** (a company named mid-answer).
- **The security rule no longer conflicts with skipping** a question (only the
  consent cannot be skipped).
- **Grader fairness (every screening grade, not only calls)**: only the
  job-relevant content of answers to the listed questions counts — never tone,
  manner, attitude, confidence, accent, fluency, grammar, language, hesitation,
  asking back, pushing back or skipping; red flags only about job evidence; pay,
  location and notice never considered; **blind grading** — the candidate's name
  is removed from what the grader sees (`blindName`). The fourth call's grade had
  cited "a confrontational communication style".

### Scoring v2 — fair grading of a phone screen (2026-10-24)

The agent-driven call's grade was 17/100 "reject": the grader scored all nine kit
questions — six never asked counted as 0, the pay and logistics questions were
graded (declining to share pay cost points and a red flag), and one-minute spoken
answers were held to written-essay depth. Now:

- **Only the questions answered** on the call are graded (`gradeCallAnswers`,
  `onlyQuestionIds`); unasked questions are excluded, never zero. Pay and
  logistics are never in the call's questions, so never graded.
- **Spoken-answer rubric** (`SPOKEN_RUBRIC`): strong = specific example + own
  action + outcome/reasoning; partial = one missing; weak = general; brevity is
  not penalised; promising but brief → "probe in interview".
- **Coverage and confidence** stored with the run (`screening_runs.coverage`:
  planned, answered, high ≥ 75 % / medium ≥ 50 % / low) and shown beside the
  score; the Screening agent (1.9.1) never puts anyone on hold for a low- or
  medium-confidence phone score.
- **Never reject from a phone screen**: advance or hold ("Probe further").
- The call posts its outcome to the role's **hiring-desk thread** (score, coverage,
  where the details are; never amounts).
- `scripts/dev-agent-tick.ts` runs the agent scheduler locally (production uses
  the agent-tick cron) so events from the voice worker reach the agents.

### The decision in the hiring desk (2026-10-24, part of step D)

From HR's side, with five candidates screened the desk thread is where progress
is followed and decisions are made — not the candidate page.

- **Asked versus planned.** `record_answer` takes `declined` (the candidate chose
  not to answer: asked, never graded); coverage stores `asked`, `plannedIds` and
  `askedIds`, and every surface says it the same way (`coverageWords`): "2 asked
  of 4 planned · both answered · 2 not reached on the call". Older runs read "2 of
  4 planned questions answered". Screening call agent 1.1.6.
- **Why this score.** The call's thread post carries a `screening_result` card
  (score, coverage, confidence, recommendation) with a *Why this score* pop-up
  (`getScreeningRationale`): each question's verdict, what they said, why, its
  weight; the questions not reached; CV match and combined fit; how the score is
  built. Never the transcript, pay or the AI engine.
- **The decision as an approval card.** The Screening agent (1.10.0) ends with
  `request_approval` subject `screening_decision` {applicationId, proceed | hold,
  rationale} to the person it works for; the system adds the graded result to the
  card. *Approve — move to interview (L1)* moves the candidate as that person
  (`application.advanced` → the Interview coordinator books the round);
  *Approve — put on hold* parks them; *Decline* keeps them in screening (reason
  noted) or *Reject candidate* with a required reason. The agent can no longer
  move anyone itself (`move_candidate` removed). Refused without a graded result,
  and never two open decisions for one candidate; a candidate moved elsewhere
  closes the card.
- **Screening board.** The hiring journey's Screening step lists every
  shortlisted or screened candidate — where they are ("Call booked for …", "On
  the call now", "Your decision", "Moved to interview (L1)"), score,
  recommendation and coverage — with *Decide* (jumps to the card) and *Why this
  score*; it stays with the step after the first candidate moves on.
