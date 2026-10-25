# Voice scheduling call — plan (stage 1.2)

Status: **S0 built** (2026-10-25); S1–S4 to come. Decisions confirmed: the
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

## Decisions (confirmed 2026-10-25)

1. **Wait before calling:** 24 hours after the e-mail (an organisation setting).
2. **Alternates:** up to three pre-checked extra times on the call.
3. **Approval:** a person approves each scheduling call at first.
4. **Scope:** booking new rounds only; moving an already booked interview by
   phone comes later.
