# Candidate Identification — platform plan

Status: draft (2026-11-27).

**The need:** staffing firms, RPOs and in-house teams that hold a large archive of CVs and only want one thing from us: _find the right people for these JDs_. They don't need interviews, scheduling or offers.

**What we build:** a platform capability that any tenant can switch on. It is not a one-client project. Each client's specifics (template, sectors, currency, intake source) are **configuration**, never code. The first pilot client becomes test data and nothing more.

## 1. Capabilities every tenant gets

1. **Archive import:** a one-time load of thousands of historical CVs, parsed, merged where duplicated, and searchable.
2. **Ongoing intake:** new CVs from uploads, a mailbox, the API, or a scheduled pull from a job-board export or another ATS.
3. **Branded JDs:** JDs written in the tenant's own template (layout, logo, fonts, theme, writing style). Tenants can upload one JD or many at once.
4. **Matching:** across the whole pool, by domain/sector and requirements, with any tenant's sector taxonomy.
5. **Shortlist view:** a ranked list per JD with scores, reasons, quoted CV evidence and knock-outs. Recruiters shortlist or reject, and those decisions are recorded as feedback.

## 2. Where the platform stands today

| Area                 | Today                                                                                                                     | Platform gap                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JD storage           | `job_descriptions.requisition_id NOT NULL`, so every JD belongs to a requisition.                                         | Keep this model. Each JD gets a requisition. Add a **lightweight requisition** setting per tenant or workflow: created automatically from the JD, with no approval gate, panel or budget fields.                                         |
| JD template          | `content_templates` of kind `jd` captures headings, section order, boilerplate and tone (it can be imported from a file). | Add branding to `jd` templates (logo, fonts, theme, accent colour), reusing the `job_card`/`offer_letter` fields. Add branded PDF/DOCX export.                                                                                           |
| Multiple JDs         | Requisitions are opened one at a time.                                                                                    | **Bulk JD import** that creates one requisition and one JD per file.                                                                                                                                                                     |
| JD duplicates        | An agent tool suggests similar titles (advice only).                                                                      | Deterministic check: an optional external reference per tenant (each client's job code), a normalised text hash, and a near-duplicate score.                                                                                             |
| Bulk CV upload       | Exists. The parser takes files up to 15 MB.                                                                               | A **queued, resumable archive import job** with progress, failure list and idempotent re-runs, sized for 5,000–50,000+ CVs per tenant.                                                                                                   |
| CV duplicates        | Exact email match on some intake paths only. There is no unique constraint and no file hash.                              | A **candidate identity service** used by _every_ intake path: file hash, normalised email and phone, and a fuzzy name+contact key. Duplicates merge into one candidate with CV version history, and a review queue handles unsure cases. |
| Pool → role matching | `pool-match` uses a 7-day window, 50 CVs per sweep, 5 per role.                                                           | Turn these into tenant/workflow settings. Add a **full-pool sweep per JD** and run incremental matching as new CVs arrive.                                                                                                               |
| Currency / pay       | `pay_currency` (ISO), with INR as the default.                                                                            | Extract currency, pay period and bound type (up to / range / exact) from the JD. If the JD gives no salary, record it as **unknown**, never as INR by default. Each tenant has a reporting currency and normalises to it.                |
| Domain fit           | Skills ontology plus must-have coverage.                                                                                  | A **tenant sector taxonomy** (configurable, with a seeded default) as a scoring dimension, alongside skills, experience, location/right-to-work and pay.                                                                                 |
| Ranked view          | `match_scores` and the Matching page.                                                                                     | A **shortlist view** per JD: rank, score breakdown, must-haves with evidence, knock-outs, and shortlist/reject actions recorded through `captureFeedback`.                                                                               |
| Product surface      | The full ATS is visible to everyone.                                                                                      | A **product mode / plan** that shows only the identification surfaces (pool, JDs, shortlist) and hides interview, offer and voice.                                                                                                       |

## 2a. Detecting duplicate JDs by meaning, not by text

Text hashes and title matches miss the real cases: the same role reposted with different wording, re-ordered bullets, or a new reference number. Equally, two JDs can look alike and still be different roles (same title, different country or seniority). The check compares the **structured requirements**, not the text.

1. **Normalise each JD** into a requirement profile: role family, seniority, sector/domain, location and remote policy, employment type, pay band (converted to the reporting currency), must-haves, nice-to-haves, responsibility themes, language requirements, and the hiring client or project.
2. **Narrow the candidates cheaply:** compare only against JDs in the same tenant and role family that are open or recent (within a set number of days), using embedding similarity on responsibilities and requirements.
3. **Compare in depth, field by field:**
   - Must-haves: set overlap after mapping equivalent terms through the skills ontology ("B2B sales" ≈ "business development").
   - Responsibilities: theme-level similarity, ignoring order and wording.
   - Hard differences that make two JDs separate roles whatever the text says: country, seniority band, employment type, a different hiring client, pay band beyond a tolerance.
4. **Give one of three verdicts, with the reasons:**
   - **Duplicate (repost):** offer to link it to the existing requisition and reuse its shortlist.
   - **Variant:** same role but a different location or level. Create a new requisition seeded from the earlier one's shortlist.
   - **Distinct:** no action.
5. **The recruiter decides.** They see a side-by-side diff of the two requirement profiles. The system never merges JDs on its own. Recruiter verdicts are recorded as feedback, so the thresholds can be tuned per tenant.

## 2b. Tailored CVs: one person, many versions

Candidates now generate a CV for each JD, so different versions bring different skills and projects to the front and leave others out. The design separates **who the person is** from **what they claim**.

### 1. Identity resolution: is this the same person?

- **Strong keys:** normalised email, phone (E.164) and LinkedIn/profile URL.
- **Supporting evidence** when the contact details differ: name plus employment timeline (employers and dates), education (institution and year) and location. The tailored text changes from version to version, but the career timeline mostly doesn't.
- **Outcome:** merge automatically on a strong key. When the supporting evidence alone is high-confidence, send the pair to a **merge review queue**. Below that, keep them separate.
- Every merge is reversible and audited.

### 2. Keep every version and build an evidence-backed profile from them

- Each CV version is stored with its source, date and, where known, the JD it was submitted against.
- A **consolidated profile** combines what all versions say, built from **claims**. A claim is a skill, role, project, certification or achievement, and each one keeps:
  - which versions mention it, and when it first appeared;
  - how strong its evidence is: _demonstrated_ (described inside a role or project with context), _listed_ (keyword only), or _inferred_.
- The employment timeline is merged across versions. Projects that one CV explains and another leaves out are combined, so the fullest explanation wins.

### 3. Consistency signals, shown to the recruiter and never applied silently

- **Conflicts:** dates, titles or employers that differ between versions.
- **Single-source claims:** a skill that appears only in the version sent for _this_ JD, with no supporting detail anywhere else.
- **JD mirroring:** a version whose wording closely copies the JD's (keyword stuffing).
- These are integrity flags. They never auto-reject anyone, because people genuinely leave things off a CV and emphasise different strengths for different roles.

### 4. Scoring against the profile, not one document

- Match each JD against the **consolidated profile**, so a skill left out of one tailored CV still counts if another version proves it.
- Weight evidence by strength: demonstrated > listed > inferred. A must-have backed only by a keyword in a JD-mirrored version earns partial credit and a flag.
- The shortlist reason cites **which version and passage** each piece of evidence comes from.

### 5. Data and privacy

- Erasure removes the person and every version.
- Retention applies per version.
- Candidates are not profiled across tenants. Identity resolution runs only inside one tenant.

## 3. Tenant onboarding playbook (repeat for every client)

1. Create the tenant, its owner and recruiter roles, with grants written to `audit_log`.
2. Switch on the "Candidate Identification" workflow. Only the Intake & matching and Sourcing agents run.
3. Import their JD sample, which produces a branded `jd` template.
4. Configure: sector taxonomy, reporting currency, whether pay is a hard filter, and intake channels.
5. Set the AI key (bring-your-own) or a spend cap. Training capture stays off until consent.
6. Data: DPA, data residency, archive retention, and an erasure test.
7. Archive dry run (200–300 CVs): parse quality, duplicate rate, cost per CV, then the full import.
8. Evaluation: on 5–10 past JDs, compare our top 10 with their real shortlists or placements.

Steps 1–5 should become a one-screen **tenant setup** for platform admins.

## 4. The workflow

```
JD(s) in ──► template-normalised JD + structured requirements
            (must / nice, years, location, right-to-work, pay+currency, sector)
        ──► lightweight requisition (auto, no approval gate)
        ──► full-pool match ──► ranked shortlist with evidence
        ──► recruiter shortlist / reject (feedback recorded)
new CV  ──► identity merge ──► incremental match against open JDs
```

It is a workflow definition granted per tenant, usable from `/w/:workflowId` and from the tenant's API key.

## 5. Build order

1. Candidate identity resolution, CV versions and the claims-based consolidated profile (2b): everything else relies on it.
   Then the semantic JD duplicate check (2a), which sits on top of bulk JD import.
2. Archive import job (queued, resumable, with progress).
3. Bulk JD import with lightweight requisitions, JD duplicate check, and pay/currency extraction.
4. Branded `jd` templates and export.
5. Configurable sector taxonomy, matching limits as settings, full-pool sweep.
6. Shortlist view and feedback.
7. Product mode and the tenant setup screen.
8. An evaluation harness that is reusable per tenant (our top-N against their ground truth).

The AGENTS.md rules apply to each step: migration plus ER diagram for schema changes; agent version bump plus `agents:lock`; AI only through the gateway with a feature slug; vendor-neutral text; README, roadmap and SECURITY updated in the same change.

## 6. Questions to ask every new client

- Hosting and data residency.
- Archive size, CV formats, share of scanned CVs, languages.
- Their JD template file and job-code format.
- Sector list, reporting currency, whether pay is a hard filter.
- How new CVs arrive (mailbox / board export / other ATS / API).
- Past shortlists or placements we can use for evaluation.

## 7. Execution plan (approved 2026-11-27; row 0 revised)

Every row covers both the backend and the frontend. All of it is platform capability; each client's specifics are configuration.

| #   | Phase                             | What we build                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Configurable per tenant                                             | Depends on | Done when                                                                             |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| 0   | Tenant setup by workflow          | A new tenant starts on the **default** setup (the current full ATS). A platform admin then applies a workflow: **(1) Full pipeline**, the default; **(2) Predefined template**, a published workflow from the library such as Candidate Identification; or **(3) New workflow**, built in the workflow studio and then granted. The tenant's agents and navigation follow the granted workflow(s) from a new tenant "workflow profile". Switching profiles later never deletes data. | Profile, granted workflows, roles, currency, AI key or cap, consent | —          | Create → apply profile → the tenant sees only what its workflow uses; changes audited |
| 1   | Candidate identity                | Strong keys and career-history matching; merge review queue; merges reversible and audited                                                                                                                                                                                                                                                                                                                                                                                           | Merge thresholds                                                    | —          | Duplicates and tailored CVs merge correctly                                           |
| 2   | CV versions + evidence profile    | Claims with source versions and evidence strength; merged timeline; consistency flags                                                                                                                                                                                                                                                                                                                                                                                                | Which flags show                                                    | 1          | Each claim traces back to its CV version                                              |
| 3   | Archive import                    | Queued, resumable, idempotent bulk job; OCR; progress and failures; trial run first                                                                                                                                                                                                                                                                                                                                                                                                  | Batch size, retention                                               | 1, 2       | 5,000 CVs load with a report                                                          |
| 4   | Ongoing intake                    | Upload, mailbox, API and scheduled pull, all through steps 1–2                                                                                                                                                                                                                                                                                                                                                                                                                       | Channels, schedule                                                  | 1, 2       | New CVs are matched within minutes                                                    |
| 5   | Branded JD templates              | Logo, fonts, theme and writing style; PDF/Word export                                                                                                                                                                                                                                                                                                                                                                                                                                | The template                                                        | —          | Output matches the client's sample                                                    |
| 6   | Bulk JD import                    | One lightweight requisition per JD; requirement extraction including pay, currency, period and bound                                                                                                                                                                                                                                                                                                                                                                                 | Approval needed?, job-code format                                   | 5          | N JDs in → N requisitions                                                             |
| 7   | Duplicate JD check                | Field-by-field requirement comparison; duplicate / variant / distinct; the recruiter decides                                                                                                                                                                                                                                                                                                                                                                                         | Thresholds, how far back                                            | 6          | Reworded reposts are caught                                                           |
| 8   | Matching engine                   | Score against the whole profile weighted by evidence; sector factor; full-pool sweep; limits as settings                                                                                                                                                                                                                                                                                                                                                                             | Sectors, weights, pay filter                                        | 2, 6       | Every JD ranks the whole pool                                                         |
| 9   | Shortlist view                    | Score breakdown, evidence with CV passages, knock-outs, flags; shortlist/reject as feedback                                                                                                                                                                                                                                                                                                                                                                                          | Columns, how many shown                                             | 8          | A recruiter can act without opening CVs                                               |
| 10  | Candidate Identification template | Published to the workflow library (option 2 in row 0); app and API access; rate-limited                                                                                                                                                                                                                                                                                                                                                                                              | Which tenants get it                                                | 6, 8, 9    | Grant → tenant runs JD to shortlist                                                   |
| 11  | Evaluation harness                | Our top-N against the client's real outcomes, as a per-tenant report                                                                                                                                                                                                                                                                                                                                                                                                                 | The client's past data                                              | 9          | Measured accuracy for any tenant                                                      |
| 12  | First pilot                       | Trial run → full archive → 5–10 JDs evaluated                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                   | All        | Client signs off                                                                      |

Work assignments and developer briefs: [candidate-identification-assignments.md](candidate-identification-assignments.md).
