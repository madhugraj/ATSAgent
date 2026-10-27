# Interview panels — real test in the Yavar organisation (P4)

The end-to-end test of `docs/interview-panel-plan.md` P0–P3 with real people in
the **Yavar** organisation, on the local stack (dev server, `scripts/dev-agent-tick.ts`,
voice worker — restart the last two after any code change).

## Already set up (2026-10-27)

| Person | Address | Role | Interviews | Rounds | Areas |
|---|---|---|---|---|---|
| Madhu (owner) | madhu.r@yavar.ai | every role | yes | L2, L3 | AI strategy, Product, Leadership, Judgement |
| Saranya | saranya.r@yavar.ai | HR head (**invited**) | yes | L3 | Team fit, Motivation, Growth potential, Communication |
| ML Interviewer (test) | madhu.r+ml@yavar.ai | hiring manager (**invited**) | yes | L1, L2 | Machine learning, Deep learning, MLOps, Generative AI, Problem solving |
| Leadership Interviewer (test) | madhu.r+lead@yavar.ai | hiring manager (**invited**) | yes | L2, L3 | Team leadership, Stakeholder management, Ownership, Collaboration, Communication |

Weekly limit 4 each. The two test interviewers are plus-addresses, so their mail
arrives in Madhu's inbox. Invites and profiles are in the audit log
(`member.invited`, `member.interviewer_profile.set`).

**Only active members are eligible for a panel.** An invited person becomes
active when they sign in with the invited address — until then the coordinator
cannot propose them.

## Steps

1. **Accept the invites.** In a private window, sign up / sign in at
   `http://localhost:9000` as `madhu.r+ml@yavar.ai`, then as
   `madhu.r+lead@yavar.ai`. Ask Saranya to accept hers. On *Team* (as Madhu)
   all three show **Active**; the *Interviews* column shows their rounds and areas.
   *Tip:* set your own display name on the Team page so the desk can resolve
   "Madhu" by name (an e-mail always works).
2. **Raise a role in the hiring desk** (as Madhu), e.g. "Head of AI, Chennai,
   onsite, 12–18 years, 1 opening, must-haves machine learning, MLOps, team
   leadership, stakeholder management". The desk asks for the **hiring manager**
   last — answer `madhu.r@yavar.ai`.
   *Check:* a name that is not on the team is refused with the list of managers.
3. **The interview plan card** appears in the thread. Set **L2 to a panel of 2**
   (to test a multi-person panel) and save. *Check:* the plan is editable in
   the chat; removing a round later is refused once a candidate is in it.
4. **Approve the requisition and the JD** as they come up in the desk.
5. **Bring a candidate in** — apply with a CV to the published role (or upload
   one), using a mailbox you can read for the candidate's e-mail
   (e.g. `madhu.r+cand@yavar.ai`). Screening runs (the AI screening and
   scheduling calls are off in Yavar; switch them on in *Agent settings* to
   include them). Approve the **screening decision** card → the candidate moves to L1.
6. **L1 panel.** The Interview coordinator posts **"Who interviews for L1?"**.
   *Expect:* ML Interviewer (test), covering the role's ML competencies;
   the card says why and that Madhu (the hiring manager) decides.
   **Approve this panel.** Only then are times e-mailed to the candidate.
   *Check:* `role_panel.approved` in the audit log; the candidate's invite says
   "the hiring team", never a name.
7. **L2 panel (change it).** After L1, the coordinator proposes L2 (two people).
   Press **Change the people**, pick a different pair, approve.
   *Check:* the agent is told the panel you chose and offers times for exactly
   those two.
8. **Can't make it.** Sign in as `madhu.r+lead@yavar.ai` (or whoever is on a
   booked round), open *My interviews* → **Can't make it** before it starts.
   *Expect:* the desk thread says so; the coordinator posts a **stand-in** card
   for that candidate only. Approve it.
   - Stand-in free at the booked time → the booking keeps its time; the stand-in
     gets the invite and brief; the candidate sees nothing.
   - Stand-in busy → the booking is cancelled; the candidate gets new times with
     "your interview booked for … can no longer go ahead".
9. **Scorecards from the start time.** Before the interview starts, *My
   interviews* shows "Scorecard opens when it starts"; after it starts, submit it.
10. **L3** — Saranya (team fit) should be proposed once she has accepted.

## Notes

- Interview times are offered at least 18 hours ahead, so steps 6–10 span
  days. To move faster, a person can book a round directly from *Interviews* —
  but that bypasses the panel proposal you are testing.
- If nobody is eligible for a round (not accepted yet, or at the weekly limit),
  the coordinator asks a person and *Agent observability* shows
  `interview.no_eligible_panel`.
- An interviewer who said they can't make it and is still on a round within
  24 hours raises `interview.unavailable_unresolved` (critical).
