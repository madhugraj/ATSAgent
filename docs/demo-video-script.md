# ATSIQ product demo video — narration script & shot list

**Format:** narrated screencast, ~30:00, chapter cards between acts.
**Audience:** prospective HR heads / CBOs (customer demo).
**Hard rules:**

- Product pages only — every frame is a real ATSIQ route (listed per act).
- Vendor- and model-neutral: narration and visible screens never name AI providers/models (per AGENTS.md; the only permitted place is Integrations → AI model settings, shown briefly and narrated neutrally).
- No real personal data: all candidates, phones, emails are demo data; blur any real inbox chrome.
- Never narrate a feature that isn't on screen; never fake a result — waiting time is time-remapped, not staged.
- Defaults used below (adjustable): candidate persona **Priya Sharma**; demo employer **Acme Technologies**; currency **₹ LPA**; narration **English**.

**Golden thread:** Priya, a frontend engineer pivoting to AI engineering, travels requisition → offer while the org's compliance/currency context visibly feeds every stage.

---

## Cast & demo data (seed before recording)

| Role                            | Value                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Org owner / CBO                 | demo owner account ("you" in the narration)                                                                                                           |
| HR head                         | second account for two-person moments                                                                                                                 |
| Dept head                       | third account for requisition approval                                                                                                                |
| Hiring manager                  | fourth account (expert brief, panel)                                                                                                                  |
| Candidate (golden thread)       | **Priya Sharma** — 5y frontend, React/TS, pivoting to AI (LangChain, PyTorch projects)                                                                |
| Candidate (compliance contrast) | **Rahul** — strong AI/ML, no frontend bridge (direction-gate hold)                                                                                    |
| Candidate (negotiation)         | reuses Priya (she counters in Act 6)                                                                                                                  |
| Bulk CVs                        | 15 synthetic CVs across frontend / data / AI (feeds Act 3 + Act 8 graphs)                                                                             |
| Phones                          | 2 demo mobiles on silent, DND off; recorder audio line clean                                                                                          |
| Org profile                     | Acme Technologies — India, ₹, hybrid (3 days), 5-day week, probation 6 months, notice 60 days, PF/Gratuity statutory components, leave policy 24 days |

---

# ACT 0 — Opening (0:00–1:00)

**Pages:** `index.tsx` (landing), `catalogue.tsx`.

| #   | Shot                 | Action               | Narration                                                                                                                    |
| --- | -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0.1 | Landing page hero    | slow scroll          | "This is ATSIQ — a hiring platform where twenty agents do the work, and people make every decision that matters."            |
| 0.2 | Product catalogue    | hover the agent list | "Requisition to offer release — each stage is an agent with an owner, a permission scope, and a rulebook it cannot break."   |
| 0.3 | Fade to chapter card | —                    | "In the next thirty minutes: one company, one candidate, one hire — with three live agent calls and every decision audited." |

**Chapter card:** _Part 1 · Setting up the organisation_

---

# ACT 1 — Registration & the organisation context (1:00–5:00)

**Pages:** auth/register pages, `organisation.tsx`, `org-profile.tsx`, `integrations.tsx`, `team.tsx`.

| #   | Shot                                            | Action                                                                                                                                       | Narration                                                                                                                                                                                         |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Sign-up                                         | register owner account                                                                                                                       | "Everything starts the way it would for you: register, verify, sign in."                                                                                                                          |
| 1.2 | Organisation registration                       | create Acme Technologies                                                                                                                     | "One organisation workspace. Everything you'll see — every record, every decision — is scoped inside it."                                                                                         |
| 1.3 | `organisation.tsx`                              | overview after creation                                                                                                                      | "Before any hiring: the org profile. This is the compliance backbone of the whole demo — watch how often we come back to it."                                                                     |
| 1.4 | `org-profile.tsx` — **org_context agent works** | run the org-context agent; it reads the Acme website and drafts the profile                                                                  | "The first agent is already working. It read the company website and drafted who you are — region, currency, work mode."                                                                          |
| 1.5 | same, zoom on fields                            | highlight: **India · ₹ · Hybrid (3 days) · 5-day week · probation 6 mo · notice 60 days · statutory components PF/Gratuity · leave 24 days** | "And this is where labour context enters the system: region, working hours, leave, statutory salary components. Every agent reads this profile from here on — not a prompt, the approved record." |
| 1.6 | clarifications                                  | answer 2 agent questions; approve profile v1                                                                                                 | "The agent asks when it's unsure. A person approves. Profile version one — signed."                                                                                                               |
| 1.7 | `integrations.tsx`                              | add the org's own AI key                                                                                                                     | "Bring your own key. Your model usage stays yours — scoped, capped, and auditable." _(neutral narration — no vendor names)_                                                                       |
| 1.8 | `integrations.tsx` — training consent           | toggle consent off-screen mention                                                                                                            | "Model-training capture is off until you, the owner, switch it on. Compliance first."                                                                                                             |
| 1.9 | `team.tsx`                                      | invite HR head, dept head, hiring manager                                                                                                    | "Roles follow the smallest permission needed. You'll see three approvers in this video — never one person deciding everything."                                                                   |

**Callout badge (recurring device from here on):** whenever org-profile data feeds a decision, show corner callout **`◆ org profile v1`**.

**Chapter card:** _Part 2 · Raising the role_

---

# ACT 2 — Requisition → JD → Publish (5:00–8:30)

**Pages:** `requisitions.index.tsx`, `requisitions.$id.tsx`, `inbox.tsx`, `templates.tsx`, `masters.tsx`.

| #   | Shot                                  | Action                                                   | Narration                                                                                                                                 |
| --- | ------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | `requisitions.index.tsx`              | raise manpower request                                   | "A hiring manager needs a Senior AI Engineer. The requisition agent drafts it — not from a blank form."                                   |
| 2.2 | `requisitions.$id.tsx` — draft        | zoom on band: **₹ 24–32 LPA**                            | "The band comes from the org profile's currency and benchmarks for this role family. `◆ org profile v1` — already feeding decisions."     |
| 2.3 | same                                  | must-have skills prefilled                               | "Skills, experience band, career level — drafted with evidence, editable by you."                                                         |
| 2.4 | `inbox.tsx` — DH approval             | dept head approves (show one fully)                      | "First gate: the department head. Approved in seconds — with a permanent trail."                                                          |
| 2.5 | `inbox.tsx` — HR → CBO                | montage the two approvals                                | "Then HR, then the CBO. Three people, one decision, zero meetings."                                                                       |
| 2.6 | `requisitions.$id.tsx` — **JD agent** | generate JD draft                                        | "The JD agent writes the posting from the approved requisition — working mode from the profile, band from finance, skills from the role." |
| 2.7 | JD revision round                     | dept head requests one change → agent revises → approved | "A revision requested, a revision made. The agent doesn't take feedback personally — it takes it literally."                              |
| 2.8 | **Publishing agent**                  | internal job board + external posting                    | "Publishing: internal first, then the boards. The same approved JD — no hand-retyping, no drift."                                         |

**Chapter card:** _Part 3 · Candidates arrive_

---

# ACT 3 — Intake, sourcing, matching (8:30–11:30)

**Pages:** `distribution.tsx`, `apply.$id.tsx` (candidate apply page), `candidates.index.tsx`, `matching.tsx`, `candidates.$id.tsx`.

| #   | Shot                                        | Action                                 | Narration                                                                                                                                                                                                                |
| --- | ------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1 | `apply.$id.tsx`                             | show candidate-side apply page briefly | "Candidates apply through your branded page — or arrive from boards."                                                                                                                                                    |
| 3.2 | `distribution.tsx` — **distribution agent** | ingest a batch of 15 CVs               | "The distribution agent ingests the batch — parses, deduplicates, files."                                                                                                                                                |
| 3.3 | `candidates.index.tsx`                      | pool view                              | "Every CV lands in the organisation's own talent pool."                                                                                                                                                                  |
| 3.4 | **sourcing agent**                          | pool top-up for the req                | "The sourcing agent tops up from the pool — people already in your world, matched to the role."                                                                                                                          |
| 3.5 | `matching.tsx` — **intake agent scores**    | scores populate live                   | "Now the intake agent scores. Skills, experience against the band, direction of the career."                                                                                                                             |
| 3.6 | `candidates.$id.tsx` — Priya                | open her scorecard                     | "Priya: five years frontend, real AI projects. Strong score."                                                                                                                                                            |
| 3.7 | `candidates.$id.tsx` — Rahul, the hold      | show the **direction gate hold** flag  | "Rahul: excellent AI profile — but the role needs a bridge his career doesn't show yet. The graph says: no path. So it holds — for a person to decide. That flag is the system being honest about what it doesn't know." |

**Chapter card:** _Part 4 · Screening — the first live call_

---

# ACT 4 — Screening & voice call (11:30–14:30) ⭐ staged call #1

**Pages:** `screening.tsx`, `assess.$token.tsx` (candidate side, PiP), **voice screening call console** (call view with live transcript), `candidates.$id.tsx`.

**Staging:** screen shows the call console (transcript building live); candidate-side `assess.$token` form as picture-in-picture updating as answers land.

| #   | Shot                                                | Action                                                                   | Narration                                                                                                       |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 4.1 | `screening.tsx` — **screening agent**               | generate screening kit                                                   | "The screening agent builds the kit from the JD — the same approved skills, not a new opinion."                 |
| 4.2 | assessment send                                     | send to candidates                                                       | "Assessments go out. Pay and availability — captured in rupees, against the band. `◆ org profile v1`"           |
| 4.3 | call console — **screening_call agent dials Priya** | session starts                                                           | "And now, her screening call. Live transcript on the right — nothing is pre-typed."                             |
| 4.4 | **consent moment** (must be first)                  | agent: "This call is recorded for evaluation — do you consent?" → "Yes"  | "First question: consent. Not a setting — it's in the agent's manifest. It cannot skip it."                     |
| 4.5 | dialogue (below)                                    | current CTC, expectation, notice period, availability, skill walkthrough | "Genuine questions — compensation in rupees, notice period, availability. Structured data lands as she speaks." |
| 4.6 | end call                                            | structured summary + assessment recorded on candidate                    | "Call ends. Every answer already filed. The recruiter reads a summary — not a transcript hunt."                 |

### Staged dialogue — screening call (genuine questions)

> **Agent:** Hello, is this Priya? I'm calling from Acme Technologies about your application for Senior AI Engineer. This call is recorded for evaluation — do you consent?
> **Priya:** Yes, that's fine.
> **Agent:** Thank you. Could you share your current annual compensation?
> **Priya:** Eighteen lakhs fixed, about twenty with variable.
> **Agent:** And your expectation for this role?
> **Priya:** Around twenty-eight.
> **Agent:** Noted. What is your notice period?
> **Priya:** Sixty days.
> **Agent:** Your current role is frontend-focused — tell me about the AI work you've done.
> **Priya:** I built a RAG assistant on LangChain at my current company, and a PyTorch side project classifying support tickets — it's in production use by my team.
> **Agent:** Are you open to hybrid — three days a week from the office?
> **Priya:** Yes.
> **Agent:** Thank you — that's everything. You'll hear from us on next steps.
> _(~75 seconds when performed naturally; time-remap any AI pauses)_

**Chapter card:** _Part 5 · Interviews — agents in the room_

---

# ACT 5 — Interviews & the silent panel (14:30–18:00) ⭐ staged call #2

**Pages:** `interviews.index.tsx`, `inbox.tsx` (panel approval), **scheduling call console**, `schedule.$token.tsx` (panel-member PiP), `interviews.mine.tsx` (scorecard), `candidates.$id.tsx` (panel assessments), `agents.governance.tsx` (panel gate policy mention).

| #   | Shot                                             | Action                                                    | Narration                                                                                                                              |
| --- | ------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | coordinator proposes panel                       | panel card with named members                             | "The interview coordinator proposes the panel — L1, L2, L3 with named interviewers. A person approves it."                             |
| 5.2 | `inbox.tsx`                                      | approve panel                                             | "Approved. Now someone has to find a slot…"                                                                                            |
| 5.3 | **scheduling_call agent dials the panel member** | live transcript                                           | "…so the agent phones them instead of you chasing calendars."                                                                          |
| 5.4 | dialogue (below)                                 | slot negotiation                                          | "A genuine conversation — the panelist moves Thursday to Friday eleven a.m. Booked, calendar updated."                                 |
| 5.5 | interview happens                                | CUT — jump to scorecard arriving in `interviews.mine.tsx` | "The interview happens. This part is human, and stays human. The scorecard lands."                                                     |
| 5.6 | `candidates.$id.tsx` — **panel agents L1/L2/L3** | reveal hidden assessments                                 | "Meanwhile, three silent panel agents assessed the same interview — hidden from the interviewers while it ran."                        |
| 5.7 | **disagreement**                                 | panel agent disagrees with human scorecard → round holds  | "And one of them disagrees with the human scorecard. The system stops the round. Not an alarm — a hold, with both views side by side." |
| 5.8 | HR head resolves                                 | show both views → confirm                                 | "The HR head compares, decides, moves it forward. Every agent judgement here was captured as training feedback."                       |

### Staged dialogue — scheduling call (~40s)

> **Agent:** Hello, this is Acme's hiring assistant. You're on the panel for the Senior AI Engineer role — could we find an L1 slot this week?
> **Interviewer:** Thursday afternoon works.
> **Agent:** Proposed: Thursday, 3 PM. Does that work?
> **Interviewer:** Actually, move it — Friday 11 AM is safer.
> **Agent:** Updated: Friday, 11 AM. You'll get the invite shortly. Thank you!

### Panel L1/L2/L3 — genuine assessment questions (shown in transcripts)

- **L1 (fundamentals):** "Walk me through how you'd debug a retrieval pipeline returning irrelevant chunks." / "Explain embeddings vs. fine-tuning — when each?"
- **L2 (system design):** "Design resume parsing for 10k uploads a day — where do the failure modes live?" / "How would you evaluate the matcher before shipping it?"
- **L3 (judgment/architecture):** "The model wants to auto-reject a strong candidate on one signal — what does a safe design do?" / "Where should a hiring system never be autonomous?"

_(The L3 answers deliberately echo the product's own governance philosophy — good for the demo's coherence.)_

**Chapter card:** _Part 6 · The offer — templates, law, and a negotiation_

---

# ACT 6 — Evaluation, offer letter, negotiation (18:00–22:00) ⭐ staged call #3

**Pages:** `candidates.$id.tsx` (dossier), `offers.tsx`, `templates.tsx` (offer letter template), offer letter preview, `inbox.tsx` (HR + CBO two-person release), `offer.$token.tsx` + `negotiate.$token.tsx` (candidate side, PiP), **negotiation call console**.

| #    | Shot                                   | Action                                                 | Narration                                                                                                                                                                                                                    |
| ---- | -------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1  | dossier — **evaluation agent**         | cross-round evidence, parity check                     | "The evaluation agent assembles the dossier — every round, every scorecard, one view. It checks parity: was she evaluated like everyone else?"                                                                               |
| 6.2  | recommendation                         | person advances to offer                               | "Recommendation: offer. A person agrees."                                                                                                                                                                                    |
| 6.3  | `templates.tsx`                        | open the approved offer template                       | "The offer letter is not written from scratch. Acme's approved template: probation six months, notice sixty days, statutory components as a share of CTC — PF, gratuity — all fixed by the organisation. `◆ org profile v1`" |
| 6.4  | **offer agent drafts in band**         | letter preview builds: ₹28 LPA breakup, clauses render | "The offer agent drafts within the band the CBO approved in Act 2 — the letter assembles itself from the template: breakup, clauses, dates."                                                                                 |
| 6.5  | letter preview zoom                    | clause-by-clause pass                                  | "Probation. Notice. Statutory breakup. Working days from the profile. Nothing improvised."                                                                                                                                   |
| 6.6  | `inbox.tsx` — **two-person rule**      | HR approves → CBO releases (step-up confirmation)      | "Release needs two people. HR approves; the CBO releases with step-up re-authentication. This rule is the platform's, not a policy document's."                                                                              |
| 6.7  | `offer.$token.tsx` PiP                 | Priya opens her offer                                  | "Priya sees the same letter — in her own portal."                                                                                                                                                                            |
| 6.8  | **negotiation_call agent dials Priya** | live transcript                                        | "She counters. So the negotiation agent calls — with the band, not a bluff."                                                                                                                                                 |
| 6.9  | dialogue (below)                       | counter, band check, person-approved revision          | "She asks twenty-nine; band ceiling is thirty-two; the agent proposes twenty-nine with joined-in-30-days — a person approves the revision. Accepted."                                                                        |
| 6.10 | offer accepted                         | status: accepted                                       | "The counter is inside the approved band, the trail is complete, and the offer is accepted."                                                                                                                                 |

### Staged dialogue — negotiation call (~60s)

> **Agent:** Hello Priya — congratulations from Acme! Your offer: twenty-eight lakhs. Any questions?
> **Priya:** I was hoping for twenty-nine — I have a competing process at that number.
> **Agent:** Understood. I can propose twenty-nine, with joining within thirty days — shall I place that before the team?
> **Priya:** Yes, please.
> **Agent:** I've recorded your counter — twenty-nine, thirty-day joining. Our team will confirm shortly. Thank you!
> _(cut to: revision approved in inbox → `offer.$token` shows ₹29 → Priya accepts)_

**Chapter card:** _Part 7 · Joining — verified, not assumed_

---

# ACT 7 — Pre-onboarding & release (22:00–23:30)

**Pages:** `candidates.$id.tsx` (onboarding card), `pay.$token.tsx` (candidate uploads breakup), document validation view.

| #   | Shot                                    | Action                                                         | Narration                                                                                            |
| --- | --------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 7.1 | **onboarding agent** requests documents | request list sent                                              | "The pre-onboarding agent asks for documents — nothing more than the role requires."                 |
| 7.2 | `pay.$token.tsx`                        | Priya uploads her current salary breakup (scanned, multi-page) | "She uploads her current breakup — scanned pages, read as one document each."                        |
| 7.3 | **compensation cross-check**            | validation result: verbatim match/mismatch flag                | "The agent cross-checks it against what she declared in the screening call. Verified — not assumed." |
| 7.4 | release                                 | validated and released                                         | "Documents validated. Release. Priya joins in thirty days."                                          |

**Chapter card:** _Part 8 · How you trust all of this_

---

# ACT 8 — Governance: inbox, intelligence, observability, Talent Brain (23:30–28:00)

**Pages:** `inbox.tsx`, `agents.intelligence.tsx`, `agents.observability.tsx`, `agents.call-reviews.tsx`, `hiring-cost.tsx`, `brain.tsx`, `skill-ontology.tsx`, `roi.tsx`, `reports.tsx`.

| #    | Shot                                     | Action                                                  | Narration                                                                                                                                                       |
| ---- | ---------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1  | `inbox.tsx`                              | scroll today's decisions                                | "Everything a person decided today, in one inbox. Approvals, holds, reviews — with the agent's proposal and the person's answer, side by side."                 |
| 8.2  | `agents.intelligence.tsx` — behavior tab | fleet graph, system read                                | "Agent Intelligence — the system watching itself. Every agent you met today, its gate stops, its overturns — candidates folded into the counts, never exposed." |
| 8.3  | same — governance tab                    | Priya's decision chain visible                          | "And the governance graph: Priya's journey as a chain — screen, interview, offer, release — each decision tied to the gate it passed."                          |
| 8.4  | same — vocabulary tab                    | skills from today's CVs                                 | "Even the vocabulary learns: skills from today's CVs are already in the graph."                                                                                 |
| 8.5  | `agents.observability.tsx`               | per-agent vitals: runs, errors, latency, trends, issues | "Observability is the health chart: runs, tool errors, latency, spend per agent — with fourteen-day trends and open issues that carry severity."                |
| 8.6  | `agents.call-reviews.tsx`                | today's three calls listed                              | "All three calls you heard — recorded, reviewable, consented."                                                                                                  |
| 8.7  | `hiring-cost.tsx`                        | cost per candidate/hire                                 | "Cost, per candidate and per hire — real spend, not estimates."                                                                                                 |
| 8.8  | `brain.tsx` + `roi.tsx`                  | supply/demand, market compensation, RoI view            | "And Talent Brain turns the same data outward: skill supply against demand, live market compensation, and the return on every individual you hire."             |
| 8.9  | `skill-ontology.tsx`                     | skill graph growing                                     | "The skill ontology — the vocabulary every agent shares — grows with every CV and every verdict."                                                               |
| 8.10 | audit spot-check                         | open one audit trail                                    | "Pick any decision from today — the trail is there: who, what, which version of the org profile it ran under."                                                  |

**Chapter card:** _Part 9 · What just happened_

---

# ACT 9 — Recap & close (28:00–29:30)

**Pages:** `index.tsx` (landing), `catalogue.tsx` (end frame).

| #   | Shot                                            | Action                                                                       | Narration                                                                                                                               |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1 | decision ledger overlay (on real pages montage) | counts: ~40 agent proposals · 12 person decisions · 3 calls · 1 hire         | "Thirty minutes, one hire. Around forty agent proposals. Twelve human decisions. Three calls — each one consented. Every step audited." |
| 9.2 | security in three beats                         | on-screen: encryption · rate limits · vendor-neutral · fairness/parity check | "Your data encrypted at rest. Your candidates never see a vendor's name. Every shortlist checked for parity."                           |
| 9.3 | `catalogue.tsx`                                 | slow hover                                                                   | "Twenty agents. Each with an owner, a scope, and rules it cannot break."                                                                |
| 9.4 | end card                                        | logo + CTA                                                                   | "ATSIQ. Agents do the work. People make the decisions."                                                                                 |

---

## Production rules & post

- **Recording:** two sessions — (A) all UI acts (0–3, 7–9), (B) the three staged calls with both phones. Two takes per call minimum.
- **Time-remap** model pauses in calls; never stage a result.
- **Privacy:** demo data only; blur OS/browser chrome, bookmarks, real emails; clean browser profile, no extensions with vendor logos.
- **Post:** chapter cards between acts, burned-in captions (accessibility + sound-off social), light music bed under narration only.
- **Deliverables:** 30:00 master · 3:00 overview (Acts 0, 4, 6 highlights, 8) · 0:60 trailer · per-act clips.

## Risks & mitigations

| Risk                                          | Mitigation                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Staged call feels scripted                    | Rehearse twice, keep hesitations in; genuine questions only                           |
| Latency gaps on screen                        | Time-remap with a zoom cutaway; disclose nothing — it's editing, not faking           |
| Approvals montage feels fake                  | Show Act 2.4 approval fully real; montage only 2.5                                    |
| Statutory fields differ from template reality | Pre-verify Act 6.5 clause list against the actual template; narrate only what renders |
| Vendor name leaks on screen                   | Checklist pass on every frame before export                                           |

## Pre-flight checklist (before session A)

- [ ] Demo org + 4 user accounts ready; org profile v1 approved with statutory fields above
- [ ] Offer template with probation/notice/statutory breakup renders on a test offer
- [ ] 15 CVs + Priya + Rahul in pool; Rahul's direction-hold reproduces
- [ ] Screening kit + assessment form live on `assess.$token`
- [ ] Panel members exist for L1/L2/L3; scheduling token link works
- [ ] `skill-ontology`, `brain`, `roi`, `hiring-cost` have plausible demo data
- [ ] Voice calls rehearsed end-to-end twice
