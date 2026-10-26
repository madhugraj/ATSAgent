# Interview panels — plan

Status: **P0 and P1 built** (2026-10-26). P0 — interviewer profiles, hiring manager as a member, the desk asks for it, invites audited. P1 — the plan in the desk thread (posted when the role is raised, and on "show the interview plan"), editable in place with the hiring manager; the hiring manager picked from members on the requisition page (audited, `requisition.hiring_manager_set`); a plan cannot drop a round a candidate is in or an interview is booked for. P2–P4 to come.

Decisions (2026-10-26): test in the Yavar organisation; the role's hiring manager approves panels; one panel per role and round; weekly cap 4; members only.

## The problem

The fresh Head of AI test (REQ-2026-106) booked an L1 with "Arun Kumar" — a demo
member added for testing — only because he was the one hiring manager on record.
Nobody chose him for this role, nobody approved him, and nothing would have
chosen a different person for a different round or role. A panel is never
constant: it depends on the role, the round, who is free and who knows the
area. The organisation's people, though, are registered once.

## How it works today

- **People.** The owner invites members on the Team page (`src/routes/team.tsx`,
  `inviteMember` in `src/lib/org.functions.ts`) with approval roles — recruiter,
  hiring manager, department head, HR head, CBO. A member has a name and a title;
  there is no notion of "interviewer", their areas or their load. In the real
  Yavar organisation the only member is the owner, with every role;
  `saranya.r@yavar.ai` (HR) has no account.
- **The role.** A requisition's hiring manager is a free-text field
  (`requisitions.hiring_manager`), not a member; the hiring desk never asks for
  it. The interview plan — rounds, focus, competencies, panel size 1–3
  (`src/lib/interview-plan.ts`) — is editable on the requisition page
  (`InterviewPlanCard`) but not shown in the desk; most roles run on the default.
- **The panel.** When a round is due, the Interview coordinator calls
  `list_panel_options` (every active member, ranked: past interviewers for the
  role, then hiring managers and department heads, then anyone) and picks
  `panelSize` people itself. No person approves the panel. Times are then
  checked free for everyone on it (`findFreeSlots`, `chooseSlot`).
- **The interviewer.** Gets an invite and a brief by e-mail
  (`src/lib/interviewer-brief.server.ts`) and sees the round on *My interviews*
  (matched on their e-mail). A scorecard can be submitted while the round is
  scheduled — even before it has happened.
- **The candidate** never learns who interviews them ("the hiring team" / "a
  panel of N"), which stays.

## Principles

1. **Registered once, by the admin:** the people, their roles, and who may
   interview (and on what). Audited.
2. **Chosen per role and per round, never constant:** proposed from the
   registered pool against the round's focus, **approved by a person**, and
   changeable at any time.
3. **Agents propose, people decide** (AGENTS.md): no agent appoints a panel.
4. **Confidential to candidates**, as today.

## 1. One-time setup by the admin

On the Team page, in the first-login journey (`src/lib/user-manual.ts`):

- **Register people and roles** — as today (invite by e-mail, approval roles).
  Example: `saranya.r@yavar.ai` as HR head.
- **Interviewer profile** for members who interview — a new section per member:
  - interviews: yes / no;
  - **areas** — skills and competencies they assess (e.g. machine learning,
    MLOps, system design, leadership), matched against round competencies;
  - **rounds** they take (L1 / L2 / L3) and, optionally, departments;
  - **weekly cap** (default 4 interviews);
  - calendar connected or not (Google / Microsoft 365 — read from the existing
    integration; without it only ATSIQ bookings are known).
- Data: `member_interviewer_profiles` (org_id, member_id, active, areas[],
  rounds[], department_ids[], weekly_cap, updated_by, updated_at) — a migration
  under `drizzle/pg-migrations/`; changes audited (`member.interviewer_profile.set`).
- A health rule: a role reaches interviews with no eligible interviewer for a
  round's competencies.

## 2. Per role: hiring manager and interview plan

- **Hiring manager is a member**, not text: `requisitions.hiring_manager_member_id`.
  The hiring desk asks for it when the role is raised ("Who is the hiring
  manager? — Saranya, Madhu, …" from registered members; never invented). The
  Requisition agent cannot set it.
- **The interview plan is shown and editable** on the requisition page and in
  the desk: rounds (name, focus, competencies), panel size per round, who
  approves panels (default: the hiring manager). The Requisition agent proposes
  the plan from the must-haves (it does today, silently, via the default) and it
  is approved with the requisition.

## 3. Per round: the panel is proposed, approved, then used

- When a role first needs round N (its first candidate reaches it), the
  Interview coordinator calls a new tool **`propose_panel`**{requisitionId,
  level, memberIds, reason}. The system ranks the eligible members (interviewer
  profile on, round allowed, areas covering the round's competencies, under
  their weekly cap, not the candidate's own manager or a past colleague when
  known) and refuses anyone outside that list.
- A **panel approval card** in the desk (gate `panel_approval`, addressed to the
  role's hiring manager or HR head): the round, its focus, the proposed people
  with why each fits, and **Approve / Change**. Changing opens a picker of the
  eligible members. The approved panel is stored per role and round
  (`role_panels`: requisition_id, level, member_ids, approved_by, approved_at,
  version) and is **reused for every candidate of that role and round** until a
  person changes it.
- Times are offered only once the round has an approved panel, free for all of
  them (as today). If a panellist is away for a candidate's window, the
  coordinator proposes a substitute for that interview only, approved the same
  way.
- **Interviewer declines** ("I can't make it" on *My interviews* or by e-mail
  reply): the round is re-proposed with a substitute; the candidate is re-offered
  times only if the change moves the interview.
- `list_panel_options` becomes the ranked eligible list; the coordinator's
  instructions change to "propose, wait for approval, then offer times".

## 4. The interviewer's side

- Invite and brief by e-mail, *My interviews* — as today.
- **Scorecards only from the interview's start time** (today they can be
  submitted before it happens).
- A "Can't make it" button that tells the coordinator.

## 5. Testing it

- Register Saranya as HR head, and two or three interviewers (plus-addresses
  such as `madhu.r+ml@yavar.ai` reach your inbox as separate accounts), with
  areas that differ.
- Raise a role with two rounds of different focus; approve the proposed panel
  for L1, change it for L2; book both; sign in as an interviewer to see *My
  interviews* and submit a scorecard after the start time.

## Milestones

| Step | What |
|---|---|
| P0 | Interviewer profiles on the Team page (migration, audit); hiring manager as a member on the requisition; the desk asks for it |
| P1 | Interview plan editor on the requisition page and in the desk |
| P2 | `propose_panel`, the panel approval card, `role_panels`; the coordinator proposes → waits → offers times; eligibility ranking; health rule |
| P3 | Substitutes and interviewer declines; scorecards only from the start time |
| P4 | Real test with Saranya and registered interviewers |

## Open decisions

1. **Where to test:** the real *Yavar* organisation (where you and Saranya
   belong) or keep the demo organisation?
2. **Who approves a panel:** the role's hiring manager (recommended), the HR
   head, or either?
3. **Panel reuse:** one approved panel per role and round for all its candidates
   (recommended), or approved per candidate?
4. **Weekly cap default:** 4 interviews per interviewer per week?
5. **Interviewers who are not members** (e.g. an external expert): out of scope
   (recommended) — they must be registered first.
