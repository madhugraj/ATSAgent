# Candidate Identification — work assignments

Plan: [candidate-identification-plan.md](candidate-identification-plan.md) (section 7 is the approved execution table).
Team: **Developer 4 (D4)**, **Developer 5 (D5)**. Reviewer and sign-off: Claude, with the product owner's final approval.

## Tracks

| Track                 | Owner   | Rows            | Theme                                                                                                 |
| --------------------- | ------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| A — Candidate data    | D4      | 1 → 2 → 3 → 4   | Identity, CV versions, evidence profile, archive and ongoing intake                                   |
| B — Tenant & JD       | D5      | 0, 5 → 6 → 7    | Workflow profile, branded JD templates, bulk JD import, duplicate JD check                            |
| C — Matching & output | D4 + D5 | 8 → 9 → 10 → 11 | D4: matching engine (8). D5: shortlist view (9) and workflow template (10). Together: evaluation (11) |

The tracks don't touch the same tables or screens until track C. Row 8 needs both 2 (D4) and 6 (D5), so it starts only after both are merged.

## Milestones and sign-off gates

| #   | Milestone                                 | Owner   | PR contains                                                                                                                             | Gate before the next milestone   |
| --- | ----------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| M0  | Design notes                              | D4, D5  | One short design note per track in `docs/candidate-identification/` covering tables, server functions, screens and edge cases. No code. | Reviewer sign-off on the design  |
| A1  | Row 1 Candidate identity                  | D4      | Schema + migration, identity service, merge review queue UI, every intake path switched over                                            | Review + tests green             |
| A2  | Row 2 CV versions + evidence profile      | D4      | Version table, claims extraction (AI through the gateway), profile UI on the candidate page                                             | Review + eval sample             |
| A3  | Rows 3–4 Archive + ongoing intake         | D4      | Import job, progress UI, trial-run mode, intake channels routed through A1/A2                                                           | 300-CV trial-run report          |
| B1  | Row 0 Workflow profile                    | D5      | Tenant profile, nav driven by profile and grants, platform-admin "apply workflow" step                                                  | Review + audit entries checked   |
| B2  | Row 5 Branded JD templates                | D5      | Branding on `jd` templates, import from sample, PDF/Word export                                                                         | Output compared with a sample JD |
| B3  | Rows 6–7 Bulk JD import + duplicate check | D5      | Bulk upload, lightweight requisitions, requirement and pay extraction, duplicate/variant/distinct verdict UI                            | Review + seeded duplicate test   |
| C1  | Row 8 Matching engine                     | D4      | Profile-based scoring, sector factor, full-pool sweep, limits as settings                                                               | Ranking eval on seeded data      |
| C2  | Rows 9–10 Shortlist + template            | D5      | Shortlist view, feedback capture, Candidate Identification workflow published                                                           | Real-agent eval passes           |
| C3  | Row 11 Evaluation harness                 | D4 + D5 | Top-N vs ground-truth report per tenant                                                                                                 | Ready for first pilot            |

## Rules for both developers

**Working setup**

- Work in your own worktree (`../ATSAgent-d4`, `../ATSAgent-d5`), with its own `bun install`. Never work in the shared main checkout, and never switch its branch.
- Branches: `feat/ci-<milestone>-<slug>`, e.g. `feat/ci-a1-candidate-identity`. One milestone per PR, kept small; split a milestone if a PR would exceed about 800 changed lines.

**Before opening a PR**

- Run `bun run typecheck`, `bun run lint` and `bun run test`. Never open or merge a red PR.
- Add new tests under `scripts/*.test.ts`.

**Schema changes**

- Edit `drizzle/schema.ts`.
- Add an idempotent SQL file in `drizzle/pg-migrations/` using the next free number at the time you open the PR (the latest is `0093`). If both of you claim the same number, whoever merges second renumbers.
- Regenerate `docs/er-diagram.md` with `node scripts/gen-er-diagram.mjs`.

**Security invariants** (AGENTS.md; a PR that breaks one is rejected)

- Every server function uses `requireOrg`/`requireRole`, and every query carries `eq(table.orgId, context.orgId)`. Identity matching **never** crosses tenants.
- A client-supplied `requisitionId` must pass `assertRequisitionInOrg` before use.
- CV and JD text enter prompts only through `untrusted(...)`. Every AI call goes through `aiJson` with a new `AI_FEATURES` slug and a zod `schema`.
- User-facing text never names the AI vendor. Wire returns strip `model`/`engine` fields.
- Merges, profile changes, workflow grants and template changes are written with `writeAudit`.
- Erasure must remove every CV version and claim. Extend `erase.server.ts` and test it.
- Any agent instruction or tool change: bump `version`, run `bun run agents:lock`, add or update an eval in `scripts/evals/scenarios.ts`, and add a health rule for any new failure mode.
- No agent tool approves, rejects or merges by itself. Use `propose_` / `request_` and let a person decide.

**Docs in the same PR**

- Update `README.md`, `roadmap.md` and `SECURITY.md` when behaviour changes.
- Keep `src/lib/user-manual.ts` as the single source for help text.

**UI**

- Self-explanatory screens: no helper sentences, no repeated numbers or labels.
- Follow the existing components and card styles.

**PR description must include**

- Which plan row(s) it covers.
- Screenshots or a short recording of the UI.
- Test output.
- Any invariant the PR touches, called out explicitly.

## Brief — Developer 4 (Track A, then C1)

**Goal:** every CV, whatever its source, resolves to one person with a versioned, evidence-backed profile, and the archive import can load 5,000 or more CVs safely.

**A1 — Candidate identity (row 1)**

- **Today:** duplicate checks are exact-email matches scattered across `src/lib/intake.server.ts:331`, `src/lib/apply.functions.ts:184` and `src/lib/requisitions.functions.ts:563`. There is no unique key and no file hash.
- **Build:** one module, `src/server/candidates/identity.server.ts`:
  - **Normalise:** email to lowercase (Gmail dots and `+tags` handled), phone to E.164 (default region from the tenant), LinkedIn URL to its canonical form, file sha256.
  - **Strong-key match:** merge automatically.
  - **Fuzzy match:** name similarity plus employment-timeline overlap (employer + start year) plus education. A score above the high threshold goes to the review queue; below the low threshold the person is kept as new. Both thresholds are tenant settings.
- **Merge review UI:** two profiles side by side, with Merge / Keep separate. Merges can be undone, and both actions are audited.
- **Every intake path calls this module.** Remove the scattered email checks.
- **Tests:** same person with different email; same name but a different person; tailored CVs of one person; cross-tenant isolation.

**A2 — CV versions + evidence profile (row 2)**

- Store each CV upload as a version: file, source, date, and the requisition it was submitted for, if any.
- **Claims extraction** through the gateway (new feature slug). Each claim has type (skill / role / project / cert / achievement), normalised value, evidence strength (demonstrated / listed / inferred), and the source version plus passage.
- The **consolidated profile** merges claims across versions, merges the timeline, and keeps the fullest project description.
- **Consistency flags:** date/title/employer conflicts, single-source claims, JD-mirroring (similarity between the CV version and the JD it was submitted for).
- On the candidate page, show the profile with the version each claim came from and the flags.
- **Erasure** removes all versions and claims.

**A3 — Archive + ongoing intake (rows 3–4)**

- A queued, resumable, idempotent import job, keyed by file hash so re-runs never duplicate anything. It runs OCR on scanned PDFs, has per-tenant concurrency and an AI spend guard, and shows progress (done / failed / merged / needs review) with a downloadable failure list.
- **Trial-run mode** processes N files and produces a report: parse quality, duplicate rate, cost per CV.
- Route ongoing intake (upload, mailbox, API, scheduled pull) through A1 and A2.

**C1 — Matching engine (row 8), after A2 and B3 are merged**

- Score each JD against the **consolidated profile**, weighting evidence strength, with a sector factor from the tenant's taxonomy.
- Turn the `POOL_MATCH` constants in `src/server/agents/pool-match.server.ts` into tenant/workflow settings. Add a full-pool sweep per JD and incremental matching for new CVs.
- Output, per factor: the score breakdown and the evidence references. The shortlist view (C2) relies on this contract, so agree it with D5 first.

## Brief — Developer 5 (Track B, then C2)

**Goal:** any client can be set up by workflow, and can load their JDs in bulk in their own branded template, with duplicates caught by meaning.

**B1 — Workflow profile (row 0)**

- **Today:** workflows (`agent_workflows`) are granted per tenant (`agent_workflow_grants`) and run at `/w/:workflowId`. Navigation is driven by role only (`src/components/nav-config.ts`, `src/hooks/useNavCtx.ts`). A tenant has no record of which profile it is on.
- **Build:**
  - Tenant workflow profile: `full_pipeline` (the default for every new tenant) / `template` / `custom`.
  - A platform-admin "Apply workflow" step on the tenant page (`src/lib/platform.functions.ts`): pick a profile, then pick from the published workflow library or the workflow studio.
  - `NavCtx` gains the profile and the granted capabilities. Each nav item declares the capability it needs, and the matching routes and server functions refuse access the same way, so nothing is hidden in the menu yet reachable by URL.
  - Switching profile never deletes data. Every switch and grant is audited.
- **Tests:** new tenant is on full pipeline; switching to a template hides and blocks the unused capabilities; switching back restores them.

**B2 — Branded JD templates (row 5)**

- `content_templates` kind `jd` today holds headings, order and tone (`src/lib/templates.server.ts`). Add logo, fonts, theme and accent, reusing the `job_card` / `offer_letter` fields and storage paths.
- Template import from a sample JD (PDF/DOCX) picks up layout, the fixed fields (title, employment, start, country, salary, contact, reference), boilerplate and writing style.
- Branded PDF and Word export of a JD. The acceptance check is that the output matches the sample.

**B3 — Bulk JD import + duplicate check (rows 6–7)**

- Upload many JDs at once. Each one gets a lightweight requisition (approval gate optional per tenant) plus a JD version created from the tenant template.
- Requirement extraction (gateway, zod schema): must / nice, years, location and remote policy, right to work, languages, sector, job code, and **pay** (currency ISO, period, bound type). When the JD gives no pay, record it as unknown; never fall back to the INR default.
- **Duplicate check:**
  - Build the requirement profile.
  - Narrow to the same tenant, same role family and a recent window, using embedding similarity.
  - Compare field by field: must-haves via ontology equivalents, responsibilities by theme, and the hard differences (country, seniority, client, pay band beyond tolerance).
  - Give a verdict of **duplicate / variant / distinct** with reasons, shown in a side-by-side UI. The recruiter decides; record that decision as feedback (`captureFeedback`).
- **Tests:** reworded repost → duplicate; same title in another country → variant or distinct; same job code → duplicate.

**C2 — Shortlist view + workflow template (rows 9–10), after C1 is merged**

- A ranked shortlist per JD showing the score breakdown, must-haves with CV passages, knock-outs and consistency flags. Shortlist/reject actions are recorded as feedback.
- Publish **Candidate Identification** to the workflow library (JD → requirements → full-pool match → shortlist → person decides). It needs a real-agent eval, an `agents:lock` refresh and health rules.

## Review and sign-off process

1. **The developer opens a PR.** Its description lists the plan row(s), the invariants touched, screenshots and test output.
2. **Claude reviews** for correctness, the security invariants, scope against this plan, tests and docs. The verdict is **Approved** or **Changes requested**, with numbered findings.
3. **The product owner gives final approval** on invariant-touching PRs (identity, erasure, grants, AI calls). Nothing merges red or unreviewed.
4. **After merge,** the reviewer ticks the milestone in the table above and the next gate opens.
