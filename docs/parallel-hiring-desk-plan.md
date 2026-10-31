# Parallel hiring needs on the hiring desk

Status: **planned** (decided 2026-10-29). Not started.

## The problem

A person types "I have 3 requirements: Head of AI, Intern – AI, Data Scientist" and the
desk picks one and asks for priority. The pause is polite, but the whole point of agents
is that three tracks run at once — each with its own thread, its own agent runs, its own
approvals — while the human decides per track, not one-at-a-time.

## What the platform already does (verified 2026-10-29, file:line evidence below)

- **Parallel agent runs across requisitions already work.** Scheduler claims are
  `FOR UPDATE SKIP LOCKED` row leases (runtime.server.ts:1397); there is no per-org
  serialisation; the dispatch dedupe key is (orgId, agentType, subjectId) — three
  requisitions get three runs (tools.ts:555-567, orchestrator.server.ts:211).
- **Approval chains are independent per requisition** — all state lives on the
  requisition row; gates/tasks are per-run; `awaiting_human` never trips the stuck-run
  rules (health.server.ts:145-146, runtime.server.ts:1690-1694).
- **The desk can hold N gathering threads today** — no unique constraint on
  `hiring_conversations`, the sidebar renders N threads, and `advanceGathering` touches
  nothing outside its own conversation (desk.server.ts:3015-3069).
- The only serial thing is the **conversation model**: one thread = one role
  (`REQUIRED_SLOTS`, desk.server.ts:81-90), and the desk asks for priority instead of
  fanning out.

So this is primarily a desk-flow feature — not a runtime change.

## Decisions

1. **One thread per need, spawned from the message that named them.** The current
   thread becomes need #1; the desk spawns N−1 children. Threads are cheap, safe to
   create in one request (every write is conversation-keyed), and the sidebar already
   shows them.
2. **Fan-out is a model output, not a hard-coded parser.** `TurnOutput` gains a
   `needs` field (and a `split_needs` command): when a message names ≥ 2 distinct
   roles, the model returns one entry per need with whatever per-need details it
   extracted. `handleUserMessageInner` branches on it before `mergeSlots`
   (desk.server.ts:1088-1091).
3. **Shared questions are asked once.** After the split, details all needs share
   (work mode, hiring manager) are asked once in the originating thread with
   apply-to-all semantics; per-need specifics (openings, skills, budget) are asked
   inside each child thread.
4. **The originating thread becomes a control panel**: one card per need — title,
   live status (gathering / role created `REQ-…` / awaiting you / active) — linking to
   each child. Approvals already aggregate in "Needs you today" and the bell.
5. **Split screen only at the moment of the split.** There is no standing
   split-screen layout mode. When the HR states 2–3 requirements at once (the
   `split_needs` moment), the single thread visibly **animates apart** into 2–3 panes
   — one per hiring agent — and each pane then runs its track live: compact thread,
   its own composer, its own cards (including approval cards), a needs-attention dot
   per column header, a focus toggle to expand one column, single-pane fallback below
   ~1200 px. The panes are independent react-queries over the existing per-thread
   server functions; the agents run in parallel whether or not the screen is split.
6. **Parallelism is a choice**: an org setting on Agent settings — "Handle multiple
   hiring needs in parallel" (default on). Off restores today's priority-asking
   behaviour for teams that prefer focus.

## Phases

### Phase 1 — Detect and fan out (the core)

- `TurnOutput` gains `needs` + a `split_needs` command; SYSTEM prompt updated
  (desk is not an agent manifest — no lock change, but desk test suites must pass).
- `handleUserMessageInner`: on `split_needs`, create the child threads, run each
  child's first turn in parallel (`Promise.all` — one request must not serialise N AI
  turns), post router notes.
- The current thread keeps its own need and gets the control-panel card.

### Phase 2 — Shared questions asked once

- Compute the question set common to all children (work mode, hiring manager); ask
  once in the originating thread; apply answers to every child that lacks them.

### Phase 3 — Control panel, split animation + panes

- Parent router card with per-need live status.
- The split **animation**: the moment the desk detects 2–3 needs, the one thread
  visually divides into the panes (the fan-out made visible), then each pane runs its
  track live. Pure `desk.tsx`: a pane component reusing the existing thread rendering
  plus the entrance animation; panes exist only for this fan-out moment.
- As shipped: the panes are fed by **one** batched poll (`getDeskThreads`) —
  one poll per pane ran into the per-function rate limit (60/min/IP) and a
  throttled pane silently froze, so a reply showed in one pane and not another.
  The split opens automatically only right after the fan-out (once per tab
  session); later it is entered from the fan-out card or the conversation list,
  which groups the tracks of a split. Each pane has Focus (open alone) and the
  view has Exit. Deleting a track asks "only this one" or "all tracks of the
  split"; a track already in approval is kept and named. While the desk works
  on the person's last message (research takes up to a minute), every pane
  says so.

### Phase 4 — Runtime hardening for real parallelism

Small, independently valuable fixes the verification surfaced (several are real
today, amplified by parallel load):

- `CONCURRENCY` → env-configurable (`AGENT_CONCURRENCY`, default stays 2) — three
  same-agent runs otherwise queue two-at-a-time (runtime.server.ts:73).
- Dispatch dedupe is check-then-insert: add a partial unique index on active runs
  (org, agent, subject) or an advisory lock — and make the desk's `startForThread`
  consult `activeRunFor` (it bypasses dedupe entirely, desk.server.ts:554).
- Requisition-code generation: retry on the (orgId, code) unique conflict
  (requisitions.server.ts:106-113).
- `advanceRequisitionCore`: guard the status write with `eq(status, from)` +
  returning check (the pattern `sendBackRequisitionCore` already uses,
  requisitions.server.ts:318-329) — concurrent approvals of one requisition
  currently double-write the trail.
- Lease renewal inside the turn loop — today a slow run can be reclaimed mid-flight
  by the next tick (ghost worker: duplicate AI spend, duplicate side effects).

As shipped (2026-10-31): `AGENT_CONCURRENCY` (default 6, 1–20) sets how many runs
one tick drives at once; the lease is renewed every turn, and a run cancelled or
reclaimed meanwhile stops at its next turn; inline kicks no longer serialise an
organisation's runs — a kick while another is still driving a long run claims
and drives what is queued now (claims stay disjoint), so a second pane's run
starts at once. Measured: two Requisition agent runs started 3 s apart — before,
the second took its first step after 145 s (once the first paused for approval);
after, at 9 s, both researching pay at the same time. Closed the same day: a
partial unique index (migration 0058, `agent_runs_active_requisition_key`)
allows one active live run per organisation, agent and requisition — `startRun`
returns the run already working instead of stacking a second; and
`advanceRequisitionCore` writes only from the status it read, so two approvers
deciding at once leave one step on the trail and the second is told. Both
races are tests in `scripts/agent-edge-cases.test.ts`. Voice call runs (per
application) stay outside the index: a crashed call must never block the next.

### Phase 5 — Org choice

"Handle multiple hiring needs in parallel" on Agent settings (HR head / CBO /
owner, audited). Off = today's serial behaviour.

## Testing

- Desk suites: split detection, N-thread creation, shared-answer fan-out, control
  panel card, split-screen component.
- Runtime suite: three runs, three subjects, one org — parallel progress, no
  duplicates (dedupe index).
- Eval scenario: "three needs named in one message → three threads → three
  requisitions".

## Explicitly out of scope

- No schema migration (threads and runs already support everything).
- No change to agent governance: each parallel track keeps its own gates, human
  decisions and audit trail; parallel runs share one monthly budget per agent per org
  (checked before every turn — a bounded, benign race, runtime.server.ts:2282-2285).
- Retroactive parallelism for past threads.
