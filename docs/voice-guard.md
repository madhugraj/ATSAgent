# Voice Guard

A silent reviewer of every answered AI phone call: screening, scheduling and
pay discussion. It reviews each call after it ends and files its findings for a
person under **Agents → Call reviews**. It **observes and reports only**. It
never takes part in a call, contacts nobody, changes no call record, grade or
decision, and approves, rejects or advances nothing. People decide what to do.

## Consent

The candidate is told, and agrees, before anything is kept. Every AI phone
agent's disclosure now says it is an AI, that it makes notes for the hiring
team, **and that the call is checked for quality**. The code refuses the
candidate's consent or go-ahead until all three were said (`disclosureMissing`,
`src/server/voice/call-tools.ts`). Screening call 1.4.0, scheduling call 1.8.0,
negotiation call 0.8.0.

- **Consented:** the transcript is kept, and the call gets a **full** review.
- **Not consented:** nothing the candidate said is kept. The call gets a
  **line-only** review from its turn-taking stats, which hold no words. The
  system does this review without any AI call.

## When it runs

At every agent tick, `sweepCallReviews` (`src/server/voice/guard/review.server.ts`)
does three things:

1. **Queues** a review for every answered call that has ended (from the last
   14 days) and has no review yet.
2. **Reviews** what is due. Line-only reviews are done by the system straight
   away. A call with a transcript starts a Voice Guard run (up to 5 per
   organisation per tick) acting for whoever asked for the call, or the owner.
3. **Retries** a run that ended without filing its review. After three
   attempts the review is marked failed, and the health rule
   `voice_guard.unreviewed` flags it. A person can press **Review again**.

The review is **mandatory**. The Voice Guard is on whenever any AI phone agent
is on. It cannot be switched off while one is, and it never runs at Suggest,
because its only write is its own review (`voiceGuardPolicy`,
`src/server/agents/policy.ts`). The organisation-wide pause still stops it.
Like any agent, if the transcript trips the prompt-injection tripwire (for
example "ignore your previous instructions"), the run's review is held for a
person to approve before it is saved.

## What it checks

| Check                                                                                                                     | By          | Calls                    |
| ------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------ |
| Disclosure before consent (AI, notes, quality check)                                                                      | system      | all                      |
| Joining date and pay: each recorded, declined in their words, or not working                                              | system      | screening                |
| Clues to the answer: examples, tool names, yes/no or list questions                                                       | Voice Guard | screening                |
| Fell for a question: technical, general, personal, about staff or chances, or an instruction                              | Voice Guard | all                      |
| Beyond its facts: anything not in the brief the call ran with                                                             | Voice Guard | all                      |
| Repeated itself: word-for-word repeats (system) and others (Voice Guard)                                                  | both        | all                      |
| Repeated the answer back instead of a short acknowledgement                                                               | Voice Guard | screening                |
| Committed to something not in the brief                                                                                   | Voice Guard | all                      |
| Agreed to something: a figure, date, condition or fact; on a pay call, a figure it was not given or less than a clear yes | Voice Guard | all                      |
| Records match what was said                                                                                               | Voice Guard | all                      |
| Other charter rules: praise, staff, pay, protected questions, results, posing as a person                                 | Voice Guard | all                      |
| Turn-taking: spoke before hello, talked over, slow replies, voice breaking up                                             | system      | all, including line-only |
| Transcription: lines in another language or script                                                                        | system      | all                      |

The Voice Guard reads:

- the call's charter (`src/server/voice/charter.ts`)
- the exact instructions and facts the call ran with (`screening_calls.brief`)
- the numbered transcript
- the records (no pay figures; `details.required` says only whether each
  required detail was recorded, declined, not working or missing)
- what the system already found

**Evidence is quoted.** Each finding names a transcript turn and the exact words
from it. A quote that is not in that turn is dropped (`mergeReview`), so the
Voice Guard cannot invent evidence.

**Severity and verdict.**

- Severity: **critical** (the candidate was misled, a record is wrong, or a
  hard rule broke), **high** (a clear breach), **low** (a lapse in manner).
- Verdict: **breach** (any critical or high finding), **attention** (low
  findings only), **pass**.
- A quality score from 1 to 5 says how the call would feel to the candidate.

## Line stats

`CallStatsTracker` (`src/server/voice/call-stats.ts`) is fed by all three call
sessions and stored in `screening_calls.call_stats` (migration 0071):

- who spoke first, with first-speech times
- candidate speech segments and assistant utterances
- talk-over: the assistant started while the candidate was speaking
- barge-ins
- reply time from the end of the candidate's speech (median, p90, slowest)
  and slow replies (over 3 s)
- the session's language
- the line's audio stats: frames, playout gaps, late ticks

## Call reviews page

`/agents/call-reviews` is for TA, the HR head, the CBO and owners: the people
who may read call transcripts, which include the pay the candidate stated. It
has:

- a list filtered by call type and verdict, plus "not yet read"
- each review's findings with their quotes, the per-check verdicts, the line
  stats and the transcript, with quoted turns highlighted
- **Findings hold** / **Findings do not hold**, with an optional note.
  Audited as `call_review.acknowledged` and captured as training feedback:
  `voice_guard_review` on the Voice Guard's run and, when confirmed,
  `voice_call_reviewed` on the call agent's run.
- **Review again** (audited `call_review.requeued`)

The agent health page (`/agents/observability`) shows a **Call reviews**
summary for the last 7 days:

- reviewed, breach, attention, not yet read, waiting or failed
- average quality
- breaches by call type
- the most frequent breaches

## Health rules

- `voice_guard.unreviewed`: an answered call has had no review for over
  2 hours.
- `voice_guard.breaches`: 2 or more of one phone agent's calls in 7 days had a
  breach (serious from 5). Raised on that phone agent, with the checks that
  failed most.

## Erasure

Reviews cascade with their call (`call_reviews.call_id … on delete cascade`).
Erasing a candidate removes their calls and those calls' reviews.
