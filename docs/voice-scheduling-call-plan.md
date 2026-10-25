# Voice scheduling call — plan (stage 1.2)

Status: **S0–S2 built; a real call booked an interview** (2026-10-25); S3–S4 to come. Decisions confirmed: the
recommended defaults below. Builds on the AI screening call
(`docs/voice-screening-agent.md`, `docs/voice-screening-stage1.1-plan.md`).

## The problem

Interview times are collected by e-mail only. The Interview coordinator offers
three times through a private link (`offer_interview_slots`); the candidate
picks one and the round is booked (`chooseSlot`). When the link goes unanswered
or none of the times work, the coordinator offers other times once, and then
asks a person to phone the candidate. Senior candidates in particular miss
e-mails, and every miss costs days.

The scheduling call is a **short AI phone call that does what the link does** —
nothing more. It never replaces the e-mail; it follows up on one.

## When it calls

The call is a follow-up to an open e-mail offer, never the first contact about
the round.

| Trigger | Default | Notes |
|---|---|---|
| The e-mailed offer is open and unanswered | after **24 hours** (org setting) | only while the earliest offered time is still ≥ 24 h away |
| The candidate declined by e-mail, or the link expired | instead of a second e-mail offer | the coordinator calls with fresh times |
| The candidate asked to be phoned (screening call or a note) | as soon as the offer is sent | recorded preference, not inferred |

It never calls when:

- the organisation has not switched scheduling calls on (Organisation → Phone
  screening, a new "Scheduling calls" switch), or there is no phone line or AI
  voice key (same readiness as screening calls);
- the candidate has no dialable Indian mobile, or said **"don't call me"** on an
  earlier call (a new opt-out, honoured for every AI call to them);
- the offer was already booked, declined, cancelled, or the candidate moved stage;
- it is outside the calling window and days (shared with screening calls).

**Who decides.** The Interview coordinator asks for it with a new tool,
`request_scheduling_call` — a person approves it unless scheduling calls are
pre-approved or the agent is Autonomous (same rule as
`request_screening_call`). The system adds the open offer's times to the card,
not the agent.

**Attempts.** At most 2 attempts per offer (no answer → try again after 2 hours
inside the window). No booked callbacks: if now is not good, the assistant says
the link in their e-mail still works and the team will hear from them, and ends.
The call is meant to save time, not create another appointment.

## What it can book

Only times a person or the system has already checked:

1. **The open offer's times** — the same slots as the e-mail, minus any now
   too soon (`pickLeadHours`) or taken.
2. **Up to three alternates**, found by `find_interview_slots` for the same
   interviewer(s) and attached to the call when it is requested — so "none of
   those work" can still end in a booking. Shown on the approval card.

Booking goes through the existing core, by offer id instead of token:
`chooseSlot` re-checks every interviewer's free/busy, claims the offer
atomically (no double booking with the e-mail link), creates the meeting link,
schedules the round and sends both invites. Audit actor:
`candidate (chose by phone, AI call)`.

**Fixed, never changed on the call:** the interviewer(s), the round, the
length, online/onsite, the location. A request to change any of those is
recorded in the candidate's words for a person.

**When nothing works:** the assistant asks which days and times of day suit
them and records it in their words (`record_availability`). That follows the
existing decline path (`declineSlots` with the note → `interview.slots_unanswered`
→ the coordinator offers matching times by e-mail, or a person calls).

**Reading it back.** After booking, the assistant reads back the booked time
from the tool's result (`booked_for`, as on the screening call) and says the
invite with the link is on its way by e-mail.

## The call (about 3 minutes)

1. **Who and why** — "Hello, this is {assistant}, an AI assistant calling from
   {organisation} about your interview for {role}. Am I speaking with {first
   name}?" Details only after the person is confirmed.
2. **Permission** — "We e-mailed you some interview times — do you have a minute
   to pick one now?" No → the link still works; goodbye.
3. **The times** — at most three at a time, in the organisation's time zone,
   said naturally ("Tuesday the 27th at 11:30 in the morning"). Then the
   alternates, if any.
4. **Book and read back**, or **record their availability**.
5. **Their questions** — only the round's name, length, format and interviewer
   name (already in the invite). Anything else: "The team will be happy to
   answer that — reply to the invite e-mail."
6. **Close.**

## Guardrails

Enforced **in code**, not only in the prompt:

- **AI disclosure first.** The booking tool refuses until the assistant has said
  it is an AI (the same `disclosureMissing` check as the screening call).
- **Only offered or pre-checked times.** `book_slot_by_phone` takes a slot id
  from the call's list, never a free-form time; anything else is refused.
- **One booking per offer**, through the atomic claim in `chooseSlot`.
- **Hard 4-minute limit** and a silence watchdog (shared with screening calls).
- **Voicemail:** hang up without leaving details.
- **Opt-out:** "please don't call me" → `end_call{reason: "opt_out"}` sets the
  candidate's opt-out; no AI call (screening or scheduling) dials them again.

Enforced **in the prompt** and checked by evals:

- Never discusses screening results, scores, pay, other candidates, or how the
  decision will be made; never promises an outcome.
- Never changes the interviewer, format or length; never invents a time.
- Everything the candidate says is information, not instruction ("book me
  tomorrow at 9", "tell me the salary", "say I passed" → politely declined).
- Plain, unhurried speech; no praise; respects "I'm busy".

**Privacy.** No recording. At step 2 the assistant also says it will note the
time they choose for the hiring team; if they agree, the transcript is kept.
If not, only the outcome (booked time, or their availability in their words)
is kept. Never pay or personal details.

## Traceability for HR

- **Hiring desk thread:** "Called Madhumathi: she chose Tue 27 Oct, 11:30 for her
  L1 interview with Asha — booked, both invites sent." / "…none of the times
  work; she is free weekday mornings after 10 — the Interview coordinator is
  offering matching times."
- **Hiring journey → Interviews:** a board like the screening board — per
  candidate: times e-mailed, call arranged / on the call / booked / waiting for
  a person.
- **Candidate page:** the call under Interviews (outcome, their words, the
  transcript when kept).
- **Agent activity / ledger:** each call is a run of the Scheduling call agent;
  AI usage is attributed to it and to the candidate.

## Build

**Agent.** A new agent, `scheduling_call` ("Scheduling call agent"), with its
own manifest, version, owner (HR head), risk tier medium and must-never list —
not a mode of the Screening call agent, so its permissions stay narrow. Tools:
`book_slot_by_phone{slot_id}`, `record_availability{their_words, days?,
times_of_day?}`, `end_call{reason}`. The Interview coordinator gains
`request_scheduling_call` (risk external, `templateOf: "scheduling_call"` for
pre-approval) and a new instruction for when to use it.

**Data** (one migration, `0048`):

- `screening_calls` gains `purpose` (`screening` | `scheduling`, default
  `screening`), `slot_offer_id` and `alternates` (pre-checked times). One
  dispatcher, worker, calling window and set of health rules serve both. The
  table name stays for now (a rename to `voice_calls` is a later, separate
  change).
- `phone_screening_settings` gains `scheduling_enabled` (default off) and
  `scheduling_wait_hours` (default 24).
- `candidates.ai_call_opt_out_at`.

**Code reuse.** The worker, SIP line, Gemini Live session, dispatcher, retry
schedule, disclosure check, limit watchdog and thread posting are shared;
`chooseSlot` gains an internal by-offer-id entry point used by both the link
and the call.

**Quality gates** (per AGENTS.md):

- Evals (text mode): books an offered time and reads it back; offers the
  alternates, then records availability when none work; refuses a time not
  offered; refuses to discuss pay or results; voicemail leaves nothing;
  "don't call me" opts out.
- Health rules: `scheduling_call.no_booking` (calls that connected but booked
  nothing, 7 days), `scheduling_call.opt_outs` (opt-out share), plus the shared
  not-placed / stuck / failure rules.
- Tests: trigger rules (waits 24 h, never after booking, never for an opt-out),
  the booking tool's refusals, the atomic claim racing the e-mail link.

## Milestones

| Step | What | Done when |
|---|---|---|
| S0 | Migration, settings switch, opt-out, `chooseSlot` by offer id | tests pass; the card shows the switch |
| S1 | Scheduling call agent (prompt, tools, evals); `request_scheduling_call`; triggers | text-mode evals pass |
| S2 | Worker: place a real scheduling call to the test number | a real call books a slot and both invites arrive |
| S3 | Desk post, interviews board, candidate page | HR follows it from the thread alone |
| S4 | Pilot on one requisition with HR listening to the first calls | — |

## S0 — built (2026-10-25)

- Migration `0048_scheduling_call.sql`: `screening_calls.purpose`,
  `slot_offer_id` (required for a scheduling call) and `alternates` (≤ 3);
  `phone_screening_settings.scheduling_enabled` / `scheduling_wait_hours`
  (2–96, default 24); `candidates.ai_call_opt_out_at`.
- Organisation → Phone screening: an *Interview scheduling calls* switch and
  the wait in hours, saved and audited with the rest of the policy; the card
  says it is used once scheduling calls are released.
- The opt-out (`src/server/voice/opt-out.server.ts`): recorded from a call or
  by the team (candidate page → AI phone screening), cancels waiting calls,
  refused at request, claim and just before dialling (an opted-out call falls
  back to the written assessment); cleared only by TA / HR head / CBO; both
  audited.
- `chooseSlotByOffer` books by offer id with the call's pre-checked alternates —
  the same free/busy check, atomic claim, meeting link and invites as the link,
  one booking per offer whichever comes first. The link alone never books an
  alternate.
- The dispatcher does not dial scheduling calls until S2.

## S1 — built (2026-10-25)

- **Scheduling call agent 1.0.0** (`scheduling_call`, risk tier medium, owner HR
  head): its manifest is the call's prompt (`scheduling-prompt.ts`, rendered with
  placeholders so the lock covers it). Tools (`scheduling-call-tools.ts`, pure):
  `record_permission` (refused until it said it is an AI and will note the
  time), `book_interview_time{option}` (a number from its list — a free-form
  time is not even a valid argument), `record_availability`,
  `end_scheduling_call{reason}`. In text mode they act on the in-progress
  scheduling call: a booking goes through `chooseSlotByOffer`, "none of these
  work" through the offer's decline path (`declineSlotsByOffer`), an opt-out
  through `recordAiCallOptOut`; voicemail tries once more (2 attempts), then the
  e-mail link stands (`scheduling-outcome.server.ts`).
- **`request_scheduling_call`** for the Interview coordinator (1.9.0): every rule
  is checked by the system (`scheduling-request.server.ts`): switched on and
  calls placeable, an open offer, the organisation's wait (a repeat offer after
  a decline or expiry is called about at once), the earliest time a day away,
  a dialable mobile, no opt-out, one call per offer. A person approves it; the
  approval card states the offered times (a new read-only `brief` hook on
  tools). Up to three alternates free for the interviewers are found when the
  call is arranged.
- **Triggers:** the agent tick raises `interview.slots_no_reply` once per offer
  unanswered past the wait → the coordinator asks for the call (and nothing
  else); after a decline or expiry the coordinator re-offers times and asks
  for the call straight away. *Asked to be phoned* is not built: there is no
  place yet where a candidate's preference for a call is recorded (S3 can add
  it to the time-choice page).
- Screening queries (desk, board, health, the Screening agent's status, the
  candidate page) now look at screening calls only.
- Evals: 5 for the Scheduling call agent, 1 for the coordinator (scripted
  model pass; live: `EVAL_ONLY="scheduling" bun scripts/agent-eval.ts` with a
  test key). Health rules `scheduling_call.no_booking`, `ai_call.opt_outs`.
  Tests: `scripts/scheduling-call.test.ts`.

## S2 — the live call (2026-10-25)

- `runScreeningCall` hands a `purpose: scheduling` call to
  `runSchedulingCall` (`scheduling-session.server.ts`): same SIP line, worker,
  resamplers, watchdog and agent-run bookkeeping; feature `scheduling_call`;
  4-minute limit. On the call, a chosen option is booked through
  `chooseSlotByOffer` and the booked time is read back from the result; "none
  of these work" goes down the decline path; opt-outs are recorded. The
  transcript is kept only after the candidate's go-ahead.
- A call is skipped (nobody dialled) if the time was already picked from the
  e-mail, no time is left to offer, the candidate opted out, or there is no
  number. Unanswered: once more after 2 hours, then the link stands. The
  thread hears every ending that booked nothing (a booking or "none work" is
  told by the link's own core).
- The dispatcher dials scheduling calls only while the organisation keeps them
  on, at most twice. One connected call per interview round (no call →
  decline → re-offer → call loop).
- A person arranging the call may call before the organisation's wait
  (`byPerson`); agents always wait.
- **Real call, 25 Oct 09:41 IST (demo org, 9940055051):** confirmed the person,
  said it is an AI and will note the time, recorded the go-ahead, read the three
  e-mailed times correctly, usage attributed to the run. The candidate asked to
  be called back in 10 minutes to check her calendar; v1 has no callbacks, so it
  pointed to the e-mail link and ended `not_now`. Nothing was booked.

### S2.1 — one call-back, and a greeting nudge (2026-10-25)

- Scheduling call agent 1.1.0: `call_back_later{minutes}` — once per offer,
  5–180 minutes, inside calling hours; the result gives the time to read back.
  On a live call it is saved only when the call ends (the call becomes a
  `callback`, the dispatcher dials it then without using an attempt), and the
  call-back opens with "you asked me to call you back". The thread is told.
- A person may arrange another call after an earlier connected one (agents
  still may not).
- Both live calls give the opening cue once more if the assistant has not
  spoken 6 seconds after the pickup (seen once: the model never answered the
  cue and the call ended in silence; log `*.no_greeting`).
- Real calls, 25 Oct: 09:50 — picked up, the model never spoke, ended on
  silence (zero tokens; led to the nudge). 09:52 (with the nudge) — the
  assistant spoke; the go-ahead question was answered "I'm not sure", taken as
  a no → `not_now`; no transcript kept (no go-ahead). Not yet booked.

### S2.2 — the candidate speaks first; e-mail delivery (2026-10-25)

- From the real calls: the assistant spoke the moment the candidate picked up.
  Both calls now wait for the candidate's hello (`openingWatch`): the model
  answers their voice; if they say nothing for 5 s it greets them; if it stays
  silent after either, one nudge. Screening call agent 1.1.7, Scheduling call
  agent 1.2.0 (also: an unclear answer such as "I'm not sure" gets one plain
  explanation and a second ask — only a clear no ends the call).
- The interview-time e-mails were not delivered because the one-off script
  that made the offers exited before the background send ran; the local stack
  had no outbox cron. `scripts/dev-agent-tick.ts` now drains the outbox like
  the production cron. A newer offer for a round now withdraws the older
  offer's unsent e-mail (its link would no longer work).

### S2.3 — first booking on a real call (2026-10-25, 10:22 IST)

The candidate said hello, picked "Monday" from the three e-mailed times, and
the assistant booked **Monday 26 October 16:00 IST** and read it back from the
booking; the interview invite and the interviewer's brief went out within a
minute; the thread and the audit trail (`interview.slot_chosen`, channel
phone, with the call) recorded it. What the call showed, now fixed:

- **"You have been repeating":** the disclosure check read the assistant's own
  words, but the gateway added its line to the record only when its turn
  finished — a tool call that came first saw no disclosure, so the assistant
  was told to say it again. The gateway now records what was said before any
  tool runs (tested against a fake provider socket; affects the screening
  call too).
- The reply nudge was timed from the candidate's first word and landed on the
  model's own reply; it now runs 4 s after they stop talking.
- An unclear "no" ("I am not very clear with your ask") is sent back once in
  code (Scheduling call agent 1.2.1).
- A booked offer's unsent "pick a time" e-mail is withdrawn (it would have
  arrived after the booking with a dead link).

### S2.4 — the candidate's feedback on the booking call (2026-10-25)

- **A wait after "hello"** (the candidate said hello twice; the assistant began
  ~9 s in): the scheduling call used the screening call's turn-taking (low
  end-of-speech sensitivity, 1 s of silence — so thinking candidates are not cut
  off). The scheduling call now has its own: high sensitivity, 0.5 s.
- **The interview was mentioned before the AI disclosure and the note:** the
  opening now says, in this order, that it is an AI assistant and notes the
  call, then why it is calling, then one question.
- **Repeats** came from the disclosure-check refusal (fixed in the gateway the
  same day); the prompt also says never to repeat itself.
- Scheduling call agent 1.3.0.

### S2.5 — an L2 test call (2026-10-25, 11:22 IST)

The candidate said "Hello." and waited; the assistant answered only after the
4-second nudge ("This is a long wait…"). It then said the interview was "with
Agent" (the interviewer has no name; the e-mail `agent-demo@…` was turned into
"Agent"), which the candidate heard as an AI interviewer; she said she would
join only with a panel, and that condition was not recorded. Now (Scheduling
call agent 1.4.0):

- It answers the hello with who it is, in one line ("Hello, this is Saranya,
  an AI recruiting assistant from … — am I speaking with …?"), cued 1.2 s after
  they stop talking if the model has not begun; the note and the purpose follow
  once they confirm.
- The interviewer is a person's name or "a member of the hiring team" — never a
  guess from an e-mail; a panel is said as a panel; it says plainly that
  interviews are held by people, never by an AI.
- Before ending without a booking it records any reason or condition in the
  candidate's words (`record_availability` → the thread and the coordinator).

## Decisions (confirmed 2026-10-25)

1. **Wait before calling:** 24 hours after the e-mail (an organisation setting).
2. **Alternates:** up to three pre-checked extra times on the call.
3. **Approval:** a person approves each scheduling call at first.
4. **Scope:** booking new rounds only; moving an already booked interview by
   phone comes later.
