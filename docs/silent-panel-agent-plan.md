# Silent panel agents (L1 / L2 / L3) — plan

Status: **S0 and S1 built** (2026-10-31); the live check on real accounts is
still to do. S1 (migration 0060): the switch and rounds on the Organisation
page (`panel_agent_settings`, audited); transcription switched on with the
provider right after booking (`syncRoundTranscription`) and off when the
candidate declines (_Candidate declined_ on Interviews, audited, transcript
deleted); the consent line in the invite; the read-transcript permission asked
at connect time only while the agent is on; the fetch sweep on the agent tick
into `interview_transcripts` (event `interview.transcript_ready`); health rule
`panel.transcript_missing` (src/server/panel/transcripts.server.ts).

S0 status: Every booked round records its meeting provider and reference
(`interviews.meeting_provider` / `meeting_external_id`, migration 0059, read
from the join link in `src/lib/meeting-ref.ts`; existing rounds backfilled).
`fetchTranscript` (`src/lib/meeting-transcripts.server.ts`) reads a held call's
transcript back from Zoom, Teams or Meet, read-only; try it with
`bun scripts/spike-transcripts.ts`.

S0 findings:

- **No connect flow asks for transcript access yet**
  (`src/lib/meetings-oauth.server.ts`): Teams grants `OnlineMeetings.ReadWrite`
  and `Calendars.ReadWrite` only (checked on the local Yavar connection), Google
  `calendar` only, Zoom `meeting:read/write` only. S1 adds
  `OnlineMeetingTranscript.Read.All` (Teams; needs tenant admin consent),
  `meetings.space.readonly` (Google) and the cloud-recording read scope (Zoom),
  and each organisation reconnects. Asked only when the silent panel agent is
  switched on, so connecting a provider without it does not need admin consent.
- A Teams lookup of a meeting that does not exist returns 400 (code 1026), not
  an empty list. The lookup of a real meeting is still to be checked.
- Transcription is not switched on at creation yet (S1). Until then the spike
  needs a call where someone started transcription by hand.

Decisions (2026-10-31): the call's own transcription (Teams, Zoom, Meet) instead
of a bot that joins; the default agreement rule (below); in a partial match the
next round is booked and the HR head can stop it; the panel performance score is
seen by the HR head only.

## The problem

Once screening is done, a candidate goes through up to three panel rounds. The
panel's scorecard is the only record of what happened in the room: nothing
checks it, nothing notices when a panel is far harsher or kinder than the
conversation supports, and nobody sees how well the panel ran the interview.
We want a silent member on every round who listens, takes notes, forms its own
view and keeps it to itself until the panel has spoken. Then it compares the
two: if they match, the panel's verdict stands; if they don't, a person decides.

## How it works today

- **Booking.** The candidate picks a time from a slot offer
  (`src/lib/slot-offers.server.ts`); the round, the meeting and both invites are
  created then. The meeting is made with the organisation's own Zoom, Teams or
  Meet account (`createMeeting` in `src/lib/meetings.server.ts`). Only the join
  link is kept (`interviews.teams_link`); **the provider's meeting id is thrown
  away**, so we could not fetch anything about the meeting later.
- **Scorecards.** Each panellist submits one final scorecard from the start
  time (`submitScorecardCore`, `src/lib/interviews.functions.ts`): rating 1–5,
  verdict select / hold / reject, competencies, comments, stored as-is in
  `evaluations`. When everyone on the round has scored, the round verdict is
  the strictest one (`roundVerdict`: any reject → reject, any hold → hold).
- **Progression.** `progressionFor` moves the candidate: a select before the
  final round opens the next one (`l2`, `l3`) and queues it for scheduling;
  after the final round the hiring manager decides (`recommend` policy).
  `scorecard.submitted` sends the Evaluation agent to write a debrief.
- Nobody but the panel has an independent view of the conversation.

## Principles

1. **Silent.** The agent never speaks, never shows up as a person in the call,
   and never tells the panel its view before they have all scored.
2. **The panel's scorecard is never changed.** The agent's assessment sits
   beside it, written separately.
3. **Agents propose, people decide** (AGENTS.md). The agent cannot move a
   candidate. When it agrees, the _panel's_ verdict moves the candidate
   exactly as today. When it does not, it can only hold the move back and hand
   it to the HR head.
4. **Consent.** The candidate is told in the invite that the call is
   transcribed and an AI note-taker assesses it; a candidate who objects gets a
   round without it, and the panel's verdict applies as before.
5. **Job-relevant only.** The agent scores against the round's competencies and
   the role's rubric — never on accent, appearance, or anything protected.

## 1. One agent per round, with its own identity

Three agents — **L1 panel agent**, **L2 panel agent**, **L3 panel agent** — each
registered in `src/server/agents/definitions.ts` with its own type
(`panel_l1`, `panel_l2`, `panel_l3`), switch, ledger, owner and eval. They are
built from one shared definition (same tools and instructions, the level fixed)
so their versions move together.

"Unique credentials" means each agent's access is scoped to its own level: the
L2 agent can read only L2 rounds' transcripts and write only L2 assessments.
The tools check the level on every call, and runs carry the agent type, so cost
and actions are traceable per level. Nobody signs in to the meeting as the
agent. The transcript comes from the meeting provider under the organisation's
own credentials.

## 2. The transcript

**When the meeting is created**, transcription is switched on for that meeting:

| Provider | Switch on at creation                                                                        | Fetch after the call                                                      |
| -------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Zoom     | `settings.auto_recording: "cloud"` (account must allow audio transcripts)                    | `GET /meetings/{id}/recordings` → the `TRANSCRIPT` file (VTT)             |
| Teams    | `recordAutomatically` on the online meeting (tenant meeting policy must allow transcription) | `GET /users/{organizer}/onlineMeetings/{id}/transcripts` → content as VTT |
| Meet     | the space's automatic transcription (Meet REST API space config)                             | `conferenceRecords` for the space → `transcripts/…/entries`               |

These calls are to be verified on the Yavar organisation's real plans in step S0.
Each may need a new scope and a re-consent of the integration, handled like
today's "grant predates the Calendar scope" message.

- `interviews` gains `meeting_provider`, `meeting_external_id` and
  `transcription` (`off | requested | unavailable | candidate_declined`).
- **Fetching:** the voice worker polls rounds whose end time has passed
  (+10 min, then backing off to 6 h) until the transcript is there or the
  provider says there is none. Provider endpoints use the stored credentials
  (decrypted via `decryptSecret`); any download URL the provider returns goes
  through `safeFetch`.
- **Stored** in a new `interview_transcripts` table (org-scoped, cascades with
  the application so candidate erasure removes it, retention like CVs), as
  speaker-labelled segments. Speakers are matched to the panel by display name
  or e-mail where the provider gives it, else left as "Speaker 1/2".
- **No transcript** (in-person round, licence missing, candidate declined, or
  nothing after 6 h): the round runs as today, and the HR head sees "no
  independent check for this round".

## 3. What the agent does after the call

When the transcript is stored, `interview.transcript_ready` dispatches the
level's agent. It:

1. **Assesses the candidate** (AI feature `panel_assess`): a 1–5 rating, a
   verdict (select / hold / reject), per-competency notes with short quoted
   evidence, and open questions. Uses the same scale and competencies as the
   scorecard. The transcript enters the prompt only through `untrusted(...)`
   with `INJECTION_RULES` — a candidate saying "rate me five" must not work;
   the output is zod-validated.
2. **Assesses the panel** (same call): competencies of the round actually
   covered, talk-time split, number of questions, and any question that
   strays into protected ground (age, marital status, religion, caste,
   pregnancy, health…), with the quote.
3. **Writes both, hidden**, to `panel_assessments` (one per round).
4. **Sends the panel a factual summary** (AI feature `panel_summary`) by
   e-mail: what was asked and how the candidate answered, per competency.
   No score, no verdict, nothing about the panel's own performance.

## 4. When the panel has scored: agree, partial, disagree

When the last scorecard of a round arrives, `submitScorecardCore` compares the
round's panel result with the agent's assessment, by a fixed rule in code
(`src/lib/panel-reconcile.ts`, unit-tested), never by the model:

- Panel rating = the average of the panellists' ratings; panel verdict = the
  round verdict as today.

| Result       | Rule                                                    | What happens                                                                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agree**    | same verdict and ratings within 1                       | Nothing changes: the panel's verdict moves the candidate as today (select → next round queued). Recorded as "independent check: agrees".                                                                                                                                                                    |
| **Disagree** | select vs reject, or ratings 3 or more apart            | **The move is held.** The candidate stays at the current round. The HR head gets an alert card (gate `panel_disagreement`) showing both views side by side with the evidence, and decides: advance to the next round, hold, or reject.                                                                      |
| **Partial**  | everything else (e.g. select vs hold, or a 2-point gap) | The panel's verdict goes ahead and the next round is queued and booked. The HR head gets a card (gate `panel_conditional`): "advanced on condition". They can confirm it, or stop the candidate before the next round happens, which cancels the booking and tells the candidate the time no longer stands. |

- The thresholds are organisation settings with these defaults.
- **The assessment is not ready yet** when the panel finishes (the transcript
  can lag): the move waits up to 2 hours for it, then goes ahead as today and
  the HR head is told there was no independent check. If the assessment arrives
  later and disagrees, the HR head gets the disagreement card, which can stop
  the candidate before the next round.
- **After the final round**, nothing moves on its own today (the hiring manager
  decides). The reconciliation result goes into the hiring-decision card and
  the Evaluation agent's debrief instead; a disagreement also alerts the HR head.
- The HR head's decisions are taken server-side with `assertRole`, audited
  (`panel_review.decided`), and recorded with `captureFeedback`: a person
  judging the agent's assessment is training data.

## 5. Who sees what

|                                   | Panel                            | Hiring manager              | HR head                     |
| --------------------------------- | -------------------------------- | --------------------------- | --------------------------- |
| Factual summary                   | yes, after the call              | yes                         | yes                         |
| Agent's candidate score and notes | after every panellist has scored | after the round is complete | after the round is complete |
| Agreement result                  | no                               | yes                         | yes                         |
| Panel performance                 | no                               | no                          | **yes, only**               |

Server functions return the hidden fields only to the right role
(`requireRole`), never to the client before the reveal. No vendor or model name
reaches the client.

## 6. Settings

On the phone and AI settings page, under the HR head's control:
"Silent panel agent" on / off (off by default), which levels, and the two
thresholds. Turning it on shows what it needs: transcription allowed on the
meeting account. Changes are audited.

## 7. Governance

- Manifests: owner `hr_head`, risk tier **high**, must-never list: never speak or
  message the candidate; never change a scorecard; never reveal its view before
  the panel has scored; never move or decide on a candidate; never score on
  anything but job-relevant evidence. Gates: `panel_disagreement`,
  `panel_conditional`. Tools: `get_round_transcript`, `get_round_context`,
  `save_panel_assessment`, `send_panel_summary` (all level-checked).
- `bun run agents:lock`; an eval per agent in `scripts/evals/scenarios.ts`,
  including one with an injection attempt in the transcript and one with a
  protected-ground question from the panel.
- Health rules (`health.server.ts`, tests in `scripts/agent-health.test.ts`):
  `panel.transcript_missing` (round completed, no transcript after 6 h),
  `panel.assessment_failed`, `panel.review_unresolved` (HR card open > 48 h).
- Schema: migration (next free number in `drizzle/pg-migrations/`) for the
  `interviews` columns, `interview_transcripts`, `panel_assessments`, the
  settings; regenerate `docs/er-diagram.md`.
- Docs in the same change as behaviour: `README.md`, `SECURITY.md` (transcripts
  as candidate data; retention), `roadmap.md`, the manual in
  `src/lib/user-manual.ts`, and the candidate-facing invite text.

## 8. Testing it

In the Yavar organisation, with the test interviewers from the panel plan: book
an L1 on each provider; run a short mock interview; check the transcript
arrives, the panel gets the summary, the score stays hidden; submit scorecards
that agree, partly agree and disagree with what was said, and check the three
outcomes and the HR head's cards.

## Milestones

| Step | What                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S0   | Spike: switch on and fetch a transcript on Zoom, Teams and Meet with Yavar's real accounts; store provider + meeting id on every new round (migration) |
| S1   | Transcription at creation, consent text in the invite, the fetch job, `interview_transcripts`, health rule `panel.transcript_missing`                  |
| S2   | The three agents: assessment, panel summary e-mail, `panel_assessments` (hidden); manifests, evals, lock                                               |
| S3   | Reconciliation in `submitScorecardCore`, the HR head's two cards, audit, training capture, late-assessment handling                                    |
| S4   | Views: the assessment beside the scorecards, panel performance for the HR head; settings; manual and docs                                              |
| S5   | Real test in the Yavar organisation                                                                                                                    |

## Open decisions

1. **Waiting for a late assessment:** hold the move up to 2 hours
   (recommended), not at all, or until the assessment arrives?
2. **Disagreement after the final round:** alert the HR head as well as
   informing the hiring manager's decision (recommended), or the hiring
   manager only?
3. **Transcript retention:** keep as long as the candidate's CV (recommended),
   or delete the transcript once the round's review is closed and keep only the
   assessment?
4. **Panel performance:** shown per round only (recommended), or also as a
   running profile per interviewer?
