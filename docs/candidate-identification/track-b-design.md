# Track B design — workflow profile, branded JD templates, bulk JD import, duplicate JD check

Developer 5 · plan rows 0, 5, 6, 7.
Everything here is platform capability for every tenant; client specifics are settings, never code.
Milestone mapping: **B1** = row 0 (§1), split into **B1a + B1b** (§1.8, per review condition 6); **B2** = row 5 (§2); **B3** = rows 6–7 (§3–4); follow-up **B3b** = §6 Q8. One PR per milestone.

All paths are relative to the repo root; line references are against `origin/main` at 6f5d8350.
Updated 2026-11-27 with the M0 review verdict (PR #113: approved with conditions 1–6, folded in here).

---

## 1. Workflow profile (row 0 / B1)

### 1.1 Today

- Tenants are rows in `organizations` (drizzle/schema.ts:166). There is no tenant-settings table and no workflow-profile concept anywhere.
- Workflows live in `agent_workflows` (org-agnostic, platform-owned) with immutable published versions in `agent_workflow_versions` and per-tenant soft-revoked grants in `agent_workflow_grants` (partial unique index on `(workflow_id, org_id) where revoked_at is null`, schema.ts:2933). Grant/revoke happen in `src/lib/platform-agent-workflows.functions.ts` (`grantWorkflow` :435, `revokeWorkflow` :479), both `requirePlatformAdmin` and audited.
- Navigation is gated by role-derived booleans only: `NavCtx` (src/hooks/useNavCtx.ts:9) computes `inOrg / isOwner / recruiterView / approver / governance / leadership / isSuperUser / claimable`, and each `NavItem` in `NAV_GROUPS` (src/components/nav-config.ts:73) carries `show: (c) => boolean`. The doc comment is explicit that predicates _mirror — never replace_ server-side enforcement.
- **No route is gated**: TanStack Router has zero `beforeLoad` role checks (the only one is a redirect, src/routes/skill-ontology.tsx:8). A hidden-menu page opened by URL renders an empty shell whose server queries fail — it is not redirected.
- Server functions are the real boundary: `requireOrg` / `requireRole` / `requireOrgOwner` / `requirePlatformAdmin` middleware (src/lib/auth.middleware.ts), every query carries `eq(table.orgId, context.orgId)`. **But they are not the only path**: agent tools (src/server/agents/tools.ts — `draft_requisition` :291, `submit_jd_version` :477, `publish_to_job_board` :567, …) call the lifecycle cores directly as the run's human principal, bypassing server-fn middleware. The hiring copilot (`/desk`, visible to every in-org member) reaches those tools, so capability gating must cover the agent path too, not just RPC.

### 1.2 Capability model

A fixed capability vocabulary in a new module `src/lib/capabilities.ts` (plain constants, no table):

| Capability              | Covers (nav + routes)                    | Server functions / cores                                                                                              |
| ----------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pipeline.requisitions` | `/requisitions` (+ detail)               | requisitions.functions.ts, JD save/sync, requisition cores                                                            |
| `pipeline.approvals`    | requisition/JD approval chain UI         | `advanceRequisition`, `sendBackRequisition`, `editRequisitionInApproval`, `approveJobDescription`, `requestJdChanges` |
| `recruiting.screening`  | `/screening`                             | screening server fns                                                                                                  |
| `recruiting.interviews` | `/interviews`, `/interviews/mine`        | interview/panel/schedule fns (incl. the `requirePanel` fns in interviews.functions.ts)                                |
| `recruiting.voice`      | phone screening                          | voice call session fns                                                                                                |
| `sourcing.distribution` | `/inbox`, `/distribution`, `/ijp`        | distribution / board-publish fns                                                                                      |
| `insights.reports`      | `/reports`, `/hiring-cost`, `/roi`       | reports / cost fns                                                                                                    |
| `matching.pool`         | `/matching`, `/candidates` (talent pool) | matching.functions.ts, pool surfaces                                                                                  |
| `matching.shortlist`    | shortlist view (row 9, C2)               | shortlist fns                                                                                                         |

**Completeness rule (the design's central promise):** _every_ `NavItem` in `nav-config.ts` and _every_ tenant route in `src/routes/` gets exactly one classification — a capability from the table above, or an explicit exemption recorded in `capabilities.ts`:

- **Role-gated, unchanged (exempt from capabilities):** `/team`, `/organisation`, `/org-profile`, `/integrations`, `/masters`, `/templates`, `/brain`, `/agents/settings|observability|governance|intelligence|register`, `/platform*` — every profile needs the governance surfaces to configure the tenant; the platform surface is super-user only.
- **Capability-gated but currently shown to everyone, called out explicitly because they reach agent tools:** `/desk` (hiring copilot), `/agents` ("Waiting for you" + agent activity — recruiter-facing, _not_ part of the governance exemption), `/collaboration`, `/catalogue`, `/skill-ontology`, `/w/$workflowId`. These are classified per capability at build time in `capabilities.ts`; e.g. a Candidate Identification tenant keeps `/desk` (its copilot drives JD → shortlist) but loses offer/voice tools.
- A CI sweep test (§5) enumerates `NAV_GROUPS` and the generated route tree and **fails if any item is unclassified** — the completeness rule is enforced, not asserted. (In B1a it runs **report-only**; it is switched to failing in B1b — §1.8.)

**Agent → capability map** (static, in `capabilities.ts`): each agent _type_ in `src/server/agents/definitions.ts` declares which capabilities its tools need (e.g. `interview`/panel agents → `recruiting.interviews`; the `*_call` agents — `screening_call`, `scheduling_call`, `confirmation_call`, `panel_check_call`, `negotiation_call` — → `recruiting.voice`; `intake`+`sourcing` → `matching.pool`; `publishing` → `sourcing.distribution`; `requisition`/`jd` → `pipeline.requisitions`). This map is the deterministic bridge from a workflow graph to a capability set, and the basis for tool gating (§1.5).

**Setting → capability dependencies:** `jdRequisitionMode: 'approval_gate'` requires `pipeline.approvals`; `auto_approved` does not (§3.4). `applyWorkflowProfile` refuses (with a plain-language error) an apply whose chosen settings depend on a capability the profile does not resolve; changing settings later re-checks the same rule (§1.4).

### 1.3 Storage

New table `org_workflow_profiles`, following the `panel_agent_settings` orgId-primary-key pattern (schema.ts:3798) — exactly one row per org, tighter than a nullable singleton:

- `orgId uuid primaryKey references organizations onDelete cascade`
- `profile text not null` — CHECK in `('full_pipeline', 'template', 'custom')`
- `workflowId uuid null references agent_workflows` — set for `template` / `custom` (which published workflow the tenant runs)
- `resolvedCapabilities jsonb not null default '[]'` — the capability set computed at apply time (transparency + cheap reads; always recomputed server-side at apply, never trusted from client)
- `settings jsonb not null default '{}'` — profile-level settings, declared keys and defaults:
  - `jdRequisitionMode: 'approval_gate' | 'auto_approved'` — **default `approval_gate`** (review condition 1; supersedes the earlier Q5 proposal)
  - `jdDuplicateLookbackDays: number` (default 90, §4.3)
  - `payVarianceTolerance: number` (default 0.20, §4.3 hard-difference pay band)
- `appliedBy` → users, `appliedAt`, `updatedAt`

**Who may change what (review condition 1):** non-default settings are chosen by the platform admin in the apply step, or later by **tenant governance only** (`hr_head`/president_cbo/owner). Enabling `auto_approved` additionally requires **step-up re-authentication** (`withStepUp`, src/lib/step-up-client.ts, with the server signalling `STEP_UP_REQUIRED`) and is audited (`workflow_profile.settings_updated` / `platform.workflow_profile.settings_updated` with before/after); the audit row's id is what auto-approvals trace back to (§3.4). The other settings keys are governance-editable with audit but no step-up.

**Absence of a row means `full_pipeline` with all capabilities** — so every existing tenant and every new tenant is untouched by default, and no seeding is needed in `src/lib/org.functions.ts`. A resolver `capabilitiesOf(orgId)` (new `src/lib/capabilities.server.ts`, 30 s per-process cache like `captureEnabled`) returns the full set when the row is absent. `full_pipeline` resolves to all capabilities, preserving today's behaviour exactly. The 30 s staleness after a tightening apply is accepted and stated (server fns are authoritative; the apply is audited); the cache-invalidation test is scoped to a single process (§5).

Capability derivation for `template` / `custom`: union of capabilities declared by the _published version's_ graph via the agent→capability map. If the referenced workflow has no `publishedVersion`, apply is refused (same gate as `grantWorkflow`, platform-agent-workflows.functions.ts:437).

### 1.4 Platform-admin "Apply workflow" step

A new per-row action **Workflow** on the tenant table in `src/routes/platform.tsx` (~lines 330–365, alongside Edit / Users / Archive), backed by two new server fns in `src/lib/platform.functions.ts`, both `.middleware([requirePlatformAdmin])`, following the `grantWorkflow` / `updateOrganizationAsSuperUser` patterns:

- `applyWorkflowProfile` — input `{ orgId, profile, workflowId?, settings? }`. Steps: verify org exists; for `template`/`custom` verify the workflow is published and (reusing the `grantWorkflow` logic) that every `studio:` agent in its graph has an org grant — surface "Grant the studio agent … first." otherwise; grant the workflow if not already live-granted; soft-revoke grants of workflows no longer referenced; resolve capabilities and **refuse when a chosen setting depends on a capability the resolved set lacks** (e.g. `jdRequisitionMode: 'approval_gate'` with a profile whose graph grants no `pipeline.approvals`); upsert the profile row with resolved capabilities; `writeAudit({ action: "platform.workflow_profile.applied", entityType: "organization", entityId: orgId, orgId, detail: { from, to, workflowId, resolvedCapabilities, settings } })`. The platform admin may set `auto_approved` here — audited on the same row.
- `readWorkflowProfile` — admin read for the dialog (current profile, grants, settings, readiness).
- Tenant-side `saveWorkflowProfileSettings` (`requireRole`-gated to governance): settings changes with the §1.3 rules — `auto_approved` demands step-up; every change audited with before/after.

A **custom** profile points at a workflow built in the workflow studio (`agent_blueprints` / studio flow) and published; the apply step is identical — the difference is only provenance, not storage. This is deliberately _not_ an extension of `WORKFLOW_TEMPLATES` (src/lib/workflow-templates.ts), which is the graph-template library for super admins; the Candidate Identification template (row 10, C2) becomes a sixth entry there, gets published, and is then selectable by this step.

### 1.5 Enforcement: nav, routes, server functions, agent tools — one rule everywhere

- **NavCtx** gains `capabilities: string[]` (resolved server-side, delivered by `myOrg` or a sibling query in useNavCtx). `nav-config.ts` items gain `cap?: Capability`; `show` becomes `has(cap) && <existing role predicate>`. AppShell and CommandPalette both filter via `show(ctx)` already, so both follow.
- **Routes**: a shared TanStack `beforeLoad` helper `requireRouteCapability(cap)` — async, calls a small server fn (`requireOrg` + resolver) and `redirect({ to: "/" })` when the capability is missing. This is the first route guard in the tree; the note accepts that router context must not be widened (the async server-fn check is the pattern, matching how `/platform` answers rather than throws).
- **Server functions are authoritative**: new `requireCapability(cap)` middleware composes after `requireOrg`/`requireRole`/`requirePanel` in each function's `.middleware([...])` chain (it needs only `context.orgId`, which `requirePanel` also yields — the panel-only interviewer's own `requirePanel` interview fns keep working under `recruiting.interviews`), plus an imperative `assertCapability(orgId, cap)` (mirroring `assertRole`) for functions with conditional behaviour. _(Added across server functions in B1b — §1.8.)_
- **Agent tools are gated too**: the `AgentTool` shape (src/server/agents/registry.ts:24) gains an optional `capability`; the tool executor refuses a tool whose capability is missing from `capabilitiesOf(run.orgId)` with a vendor-neutral error, and `enabledOrgs`/`startRun` skip agent types whose entire toolset is gated off, so a gated-off agent never starts and never bills. Without this, the copilot (`/desk`) and tools like `draft_requisition`/`publish_to_job_board` would bypass the profile entirely — the profile would be cosmetic. _(In B1a.)_ The `capability` declaration is runtime gating metadata, deliberately excluded from the canonical manifest hash: declaring it changes no agent name, input, description or instruction, so it requires no version bump and no `agents.lock.json` refresh.
- **Completeness is enforced, not asserted**: a CI sweep test (the `agents.lock.json` precedent) walks every tenant-scoped server fn (anything behind a `requireOrg`-chain middleware) and the agent tool registry, and fails unless each declares `requireCapability`/`assertCapability`/a tool `capability`, or appears on a reviewed explicit allowlist in `capabilities.ts` (governance fns, platform fns, public/apply paths). _(B1a: the tool-registry half fails and the server-fn half runs report-only; B1b: both fail — §1.8.)_
- **Rate limiting**: new fns are server-fn RPCs and inherit the per-caller per-path `/_serverFn` limiter in src/server.ts (60/min) automatically; no new public routes.

### 1.6 Switching never deletes data

The apply step writes only the profile row and grant bookkeeping. Requisitions, applications, JDs, interviews, offers, scores — nothing is deleted, and `full_pipeline` re-resolution restores every surface instantly (verified by test: switch → hide/block → switch back → everything present).

### 1.7 Edge cases

- **In-flight agent runs at apply time**: switching profiles soft-revokes replaced grants and — following `revokeWorkflow`'s existing semantics — cancels their live runs (audited on the grant trail). Switching back does not resurrect cancelled runs; only new work proceeds.
- Panel-only members resolve no org — `requireOrg` denies by default, and capability checks never loosen that; the exception stays exactly as today: `requirePanel` fns admit panel-only members to their own interview surfaces, which remain available under `recruiting.interviews`.
- `leadership` in NavCtx is not org-scoped (useNavCtx.ts:58) — the capability predicate is checked _in addition_, never as a replacement, so no profile change can expose leadership-only pages.
- BASELINE flash: while `myOrg` loads, NavCtx returns recruiter-shaped defaults; capability-gated items may flash then hide. Same trade-off as today's role predicates; no flash-gating of server access because the server is authoritative.
- Concurrent applies: upsert on the orgId PK; last apply wins; both audited with actor + before/after.
- Workflow archived or version unpublished after apply: `grantedWorkflows(orgId)` already joins on live grants and non-archived workflows; the capability cache re-resolves on expiry, and the tenant falls back to gated-off surfaces (never to a broken page).
- Capability cache staleness: 30 s per process (module-level map, `captureEnabled` precedent, capture.server.ts:40) — after a tightening apply another instance may serve the broader set for up to 30 s; accepted, and the apply is audited.

### 1.8 Milestone split (review condition 6)

- **B1a**: `org_workflow_profiles` table + migration + ER diagram; `capabilities.ts` (vocabulary, agent→capability map, exemptions, allowlist) and `capabilities.server.ts` (resolver, cache, `assertCapability`); apply step + tenant settings fn; **nav gating** (`cap` on NavItems) + **route `beforeLoad` guard** + **agent-tool gating** (executor refusal + `startRun` skip); completeness sweep with the server-fn half in **report-only** mode; tests + screenshots.
- **B1b**: `requireCapability` added across all tenant-scoped server functions per the sweep's report; sweep switched to **failing**; tests.
- Both land before B2. The B1 PRs carry this note update.

---

## 2. Branded JD templates (row 5 / B2)

### 2.1 Today

`content_templates` kind `jd` (schema.ts:1952) holds only `JdTemplateConfig` = `sections[]` + `boilerplate` (src/lib/templates.server.ts:45). Branding fields exist on the table but are documented as job_card/offer_letter: `logoPath/logoContentType` (already used by offer letters), `backgroundPath`, plus per-kind config fields `accentColor` (offer_letter :137), `headerLines/footerLines/refFormat/signatory`, and `fontFamily` enum `system|serif|mono` on job-card zones (:79). Import from a sample file exists (`analyzeTemplateFile`, templates.functions.ts:87, feature `template_import`, suggestion-only) — note this path today interpolates the uploaded file's text into the prompt **without `untrusted()` fencing and without `INJECTION_RULES`**, a pre-existing gap B2 fixes as part of the work (invariant-touching; called out in the B2 PR). PDF generation is exclusively client-side jsPDF; the offer letter (`src/lib/offer-letter-pdf.ts`) is the closest branded-export precedent: logo via `getTemplateLogo`, accent via `hexRgb`, WinAnsi `pdfText()` glyph sanitizer (₹ → "Rs. "), per-page footer. **There is no Word/DOCX writer anywhere** — mammoth/fflate DOCX code is read-only.

### 2.2 Branding on the `jd` template

Extend `JdTemplateConfig` (zod in `templates.server.ts`) with the offer_letter-shaped fields; **no schema migration is needed** — config lives in the jsonb `config` column and the logo columns are already kind-agnostic at the DB level:

- `accentColor` (`#rrggbb`, default `#4f46e5` — same default as offer_letter)
- `headerLines` (≤6) and `footerLines` (≤4) — letterhead/footer furniture
- `writingStyle` (≤500 chars) — extracted/declared tone rules
- `fontFamily: 'system' | 'serif' | 'mono'` — the job_card enum; maps to the same CSS/jsPDF built-in stacks

Logo: reuse the existing `logoPath/logoContentType` columns and `uploadTemplateLogo` / `getTemplateLogo` (templates.functions.ts:405/:513) unchanged — the comment on schema.ts:1966 ("job_card only") is corrected. Storage keys stay `${orgId}/branding/logo-<templateId>-<ts>`. Theme = accent + footer/header furniture; a full-bleed background is _not_ offered for JDs (it is a print layout, not a card).

**Fonts: deferred by review** (Q3 answer) — jsPDF built-in stacks + accent + logo in B2; true brand fonts (TTF embedding or an HTML-render path) stay out of scope until the pilot demands them.

**Prompt hygiene**: extracted `writingStyle`, `boilerplate`, section headings and `instructions` originate in an uploaded external file — stored as template _data_ and rendered into `buildTemplateSystemPrompt` inside an `untrusted_data` fence (reusing the gateway's `untrusted()` sanitation), never spliced into the system prompt as bare instructions. The same fencing applies to the import analyst call (§2.3).

### 2.3 Import from a sample JD

Extend the existing `analyzeTemplateFile` jd path rather than adding a flow: `TEMPLATE_EXTRACTION_HINT.jd` (templates.server.ts:28) and the jd analyst spec gain "header/footer lines and a writing-style summary" alongside the existing section-order/boilerplate/tone extraction. **Fix the pre-existing invariant gap on this path in the same PR**: the sample file's text enters the prompt through `untrusted("sample_jd", text)` and the analyst system prompt starts with `INJECTION_RULES` (matching `suggestWeightsCore`/`parseResume`, not the legacy shape). **Accent colour is not AI-extracted from text**: the editor pre-fills from `organizations.brandColor` and the user picks; only image/vision samples may hint at colour later. Same rules as today otherwise: one `aiJson` call, feature `template_import`, zod-validated suggestion, nothing persists until Save; the sample's original file is kept via the existing `uploadTemplateSource`. Save-time validation: the editor path validates the jd config against the kind schema at save (today `saveTemplate` accepts any record, templates.functions.ts:311, and a corrupt config silently degrades on read — kept as backstop only).

### 2.4 PDF / Word export

- **PDF** (client-side jsPDF, new `src/lib/jd-pdf.ts` mirroring `offer-letter-pdf.ts`): A4, logo from `getTemplateLogo`, accent-coloured section headings built from the template's `sections` order, `pdfText()` glyph sanitizer, footer lines per page. Input is the JD's `full_text` markdown (render headings/paragraphs/bullets; no tables in v1). Trigger: "Download PDF" on the requisition JD panel.
- **Word** (dependency `docx` npm — **approved at review, MIT** — client-side, new `src/lib/jd-docx.ts`): same content model → `.docx` Blob download. The Docker bundle-import guard from #111 (`scripts/check-bundle-imports.mjs`) must cover the new package so the image build fails if it stops resolving.
- Template changes are audited: `templates.functions.ts` has zero `writeAudit` calls today — B2 adds `writeAudit` (`jd_template.updated` / `jd_template.deleted` / `jd_template.default_set`, actor `context.memberEmail`) on save/delete/set-default for the jd kind. Exports are reads; they are not audited (consistent with the offer letter).

### 2.5 Edge cases

- Corrupt branding config → read-time degrade to built-in (documented, unchanged), save-time validation prevents new corruption.
- Glyphs outside WinAnsi (₹, unicode dashes) sanitized exactly as the offer letter does.
- Logo uploads stay within the existing guards — ≈1 MB decoded (`MAX_LOGO_BASE64`, templates.functions.ts:403) and the png/jpeg/webp content-type allowlist; template delete already removes logo/source objects (`deleteTemplate`, templates.functions.ts:350).
- Acceptance check (milestone gate): exported PDF/DOCX compared against the client's sample JD — layout skeleton, heading order, accent, logo position; not pixel-identity.

---

## 3. Bulk JD import with lightweight requisitions (row 6 / B3)

### 3.1 Today

One JD per requisition, created manually: paste-or-file import on the requisition page (`importJd`, matching.functions.ts:131, feature `jd_import` — it predates `untrusted()`/`schema` and extracts no pay/sector/job-code fields). `createRequisition` always submits to `pending_dh` (requisitions.functions.ts:409); true drafts exist only via the agent tool. No bulk path, no job code, no sector column. Bulk CV intake (src/lib/cv-intake.ts) is the established bulk-file pattern: client-side `extractResumeText` per file, per-file status states, `mapWithLimit` concurrency, per-row error isolation. `assertProfileAllowsRequisition` gates every requisition insert (requisitions.server.ts:103).

### 3.2 Flow, with server-side pending review (review condition 4)

New screen **JD import** (route `/jd-import`, capability `pipeline.requisitions`, roles `hr_head | president_cbo | recruiter` via `requireOrg` middleware plus an in-handler `assertRole(userId, orgId, ["hr_head","president_cbo","recruiter"])` — `requireRole` takes exactly one role in this codebase (auth.middleware.ts:186), so the array form goes through `assertRole`, matching its existing signature). The UI mirrors `CvUpload`:

1. Recruiter drops N files (PDF/DOCX/TXT; client-side extraction via `extractResumeText`, scanned-PDF and `.doc` refused as today).
2. Per file, client → `importJdBulk` (server fn, `mapWithLimit` 3 in the client): server extracts the **requirement profile** (§3.3), runs the duplicate check **before creating anything** (§4), and returns one of `created` (requisition + JD made), `duplicate_review` (**persisted server-side** — an `jd_import_items` row plus the standalone `jd_requirement_profiles` row, org-scoped, so closing the tab loses nothing and the paid-for extraction survives), or `error`.
3. Review list shows per-file state from the server rows; `duplicate_review` rows open the side-by-side UI (§4.4). Decisions are server fns; pending rows are erased with the import session (§4.5).

All per-file failures are isolated; the batch never aborts. AI spend is capped automatically by the existing per-org monthly cap; comparison counts are bounded per §4.5 (per-JD K=5 and a per-import ceiling).

### 3.3 Requirement extraction schema

New module `src/lib/jd-requirements.ts` with the shared zod `RequirementProfile`. Storage: `jd_requirement_profiles` (orgId column for tenant scoping; **`jobDescriptionId uuid null`** with a partial unique index `where job_description_id is not null` — the row is created at extraction time, before any requisition/JD exists, and is linked to the JD only when the requisition is created; duplicate-review rows keep it standalone). Payload: jsonb `profile` + plain `roleFamily` + `sector` columns for narrowing.

**Tenant sector taxonomy (Track A Q8, assigned to B3)**: new table `sector_taxonomy_terms` (`orgId`, `term`, `parentId` for a simple hierarchy, `seededDefault boolean`) seeded with a platform default taxonomy on first use, editable by tenant governance as a tenant setting. Extraction maps the JD's sector against this taxonomy; C1's matching engine consumes it as its sector factor.

Extraction is one `aiJson` call, **new AI_FEATURES slug `jd_requirements`**, `INJECTION_RULES` + `untrusted("job_description", text)` (≤20k chars), zod `schema`, following the `parseResume` "use null when genuinely absent" precedent — _not_ the legacy `importJd` shape:

```
title, roleFamily (from the tenant's role archetypes/ontology)
seniority: unknown | ic | senior | staff | lead | manager | ...
sector: unknown | <tenant taxonomy term>
employmentType: unknown | permanent | fixed_term | contract | part_time | intern
location: { city?, country?, remotePolicy: unknown|onsite|hybrid|remote }
rightToWork: unknown | string
languages: [{ name, level? }]           // [] when absent
experienceYears: { min?, max? }          // null when absent
mustHave[] / niceToHave[]                // ontology-mapped skill terms
responsibilities[]                       // themes, order normalised
hiringClient: unknown | string           // for RPO tenants; from JD or tenant default
jobCode: null | string                   // the tenant's external reference
pay: { status: 'unknown' }
     | { status: 'known', currency: ISO-4217|null, period: 'hour'|'day'|'month'|'year'|null,
         bound: 'up_to'|'range'|'exact'|null, min?, max?, exact? }
```

**Pay is never defaulted.** `requisitions.payCurrency` is `NOT NULL default 'INR'` (schema.ts:552) and is _not_ written from extraction; the extracted truth lives in `jd_requirement_profiles.profile.pay`, `status: 'unknown'` when the JD says nothing, regardless of tenant reporting currency. This consciously avoids repeating the INR defaults on `salaryBenchmarks.currency` (schema.ts:665) and friends; the reporting-currency normalisation for comparisons (§4) uses `organizations.currency` at compare time, never as a storage default.

Sync to existing columns happens only where semantics match and the field is empty (the `syncRequisitionFromJd` "fills blanks, never overwrites" pattern): must/nice → skill arrays, experience → `experienceMin/Max`, location → `location`, remote → `workMode`, right-to-work → `workAuthorizationRequired`. New column `externalJobCode text null` on `requisitions` (check-only + index `(orgId, external_job_code)` — **no unique constraint**, agreed at review, §6 Q6) for §4's deterministic check. Legacy JDs get profiles on demand via a governance-gated `backfillJdProfile` server fn that extracts once, **persists** to `jd_requirement_profiles` (so it is never re-derived), and counts its AI call against the caps in §4.5.

### 3.4 Lightweight requisition (review condition 1)

Created only after the duplicate verdict is **distinct** (or the recruiter accepts a variant, §4.4). Per-tenant setting `settings.jdRequisitionMode` (§1.3):

- **`approval_gate` (default — for every new tenant and until governance opts out)**: requisition at `pending_dh` and JD at `pending_dh` — the existing chain runs untouched. This mode requires the `pipeline.approvals` capability (§1.2 dependency rule).
- **`auto_approved`**: requisition created directly at `status: 'approved'` via a **dedicated opt-in on the core** — `createRequisitionCore(payload, { autoApprove: true })`, a separate explicit field that only the bulk server fn passes (a widened status parameter on the shared core would silently extend the capability to the desk and agent-tool callers, which must remain on `draft`/`pending_dh`). Guards around the setting:
  - **Only tenant governance can turn `auto_approved` on**, with **step-up re-authentication**; the platform admin may also set it at apply time (§1.4). Every enabling/change is audited.
  - **The trail entry traces to the authorising policy**: the core builds `{ from: null, to: "approved", actor: <importer email>, decision: "auto_approved", comment: "Bulk JD import", policyAuditId: <id of the audit_log row that enabled auto_approved for this org> }` server-side — every auto-approval links back to the person who authorised the policy.
  - `writeAudit("requisition.auto_created", ...)` fires per row.
  - The opt-in stays **bulk-path-only**.
  - Matching (which requires approved requisitions) can run immediately; the JD version is saved at `status: 'approved'` through the same explicit mechanism (today JDs land at `pending_dh`, requisitions.server.ts:612).

Both modes skip panel/budget fields (lightweight = `openings`, title, location, skills, pay-band fields only). `assertProfileAllowsRequisition` still runs per row — a tenant with an unapproved org profile refuses the whole file with a clear row error.

### 3.5 Migration & audit

Migration (one idempotent SQL file, next free number when the B3 PR opens; `docs/er-diagram.md` regenerated): `jd_requirement_profiles` (with nullable `jobDescriptionId`), `jd_import_items`, `sector_taxonomy_terms`, `requisitions.externalJobCode`. Audit: `jd_import.bulk_completed` (summary counts), `requisition.auto_created` per auto-approved row.

---

## 4. Duplicate JD check by meaning (row 7 / B3)

### 4.1 Today

`src/lib/jd-dedupe.ts` is lexical only: token-Jaccard on title (+ department/location/skill boosts), an acknowledgement gate before create (requisitions.index.tsx:264). The agent tool `find_similar_requisitions` is ILIKE word overlap. **No embedding/vector infrastructure exists in the repo.** (Review answer to Q1: none is needed for B3 — deterministic narrowing + pairwise comparison ships; embeddings are revisited after the C3 evaluation and would go through the gateway.)

### 4.2 Requirement profile

Built once per JD at import and **persisted immediately** (standalone `jd_requirement_profiles` row, §3.3 — it exists before and independent of any requisition); legacy JDs are backfilled on demand and persisted once. Comparison uses the profile, never the raw text.

### 4.3 Narrowing, then field-by-field comparison — before the requisition is created

**Narrow (cheap, deterministic):** candidate set = same org, same `roleFamily`, requisition status live (or created within `settings.jdDuplicateLookbackDays`, default 90), cap K=5 most-recent. Files earlier in the **same batch count too**: files are processed sequentially, so a requisition created earlier in the import is a narrowing candidate for later files, and two files in one batch that duplicate each other resolve through the same side-by-side UI.

**Job code rule (review condition 3, replacing the earlier absolute rule):** an `externalJobCode` match against a **live** requisition _proposes_ `duplicate` with **no AI call**; a match against a **closed** requisition is just a normal comparison candidate (codes may legitimately be reused after close-out, which is why there is no unique constraint). Either way the recruiter confirms — nothing is linked without a click, as §4.4 promises.

**Compare (new AI_FEATURES slug `jd_duplicate_check`):** one `aiJson` call per pair, `untrusted()`-fenced with both requirement profiles (small structured JSON, not raw text), zod schema `{ similarity: 0–1, mustHaveOverlap, responsibilityThemes, fieldDiffs[] }`. Ontology equivalents ("B2B sales" ≈ "business development") come from the existing skill-expansion groups (`groupsFor`, pool-match.server.ts:40).

**Hard differences are decided in code, before and after the AI call:** differing country, seniority band (where both known), employment type, hiring client, or pay bands beyond `settings.payVarianceTolerance` ⇒ the pair cannot be `duplicate` (at most `variant`), whatever the AI says.

**Verdicts, with reasons:**

- **Duplicate (repost)** → the `jd_import_items` row is marked _linked_ to the existing requisition (which passes `assertRequisitionInOrg` before being accepted) and **no requisition is created** — the existing requisition's shortlist is reused as-is, nothing deleted, no status transitions on live rows.
- **Variant** (same role, different location/level) → recruiter accepts; _then_ the lightweight requisition is created (§3.4) and its shortlist seeded by copying the earlier requisition's shortlist rows once with `source: 'seeded'` (org-scoped, additive, the source shortlist untouched) — **skipping candidates whose `poolUse` is `'role_only'`** (review condition 2: portal terms limit them to their original role).
- **Distinct** → the lightweight requisition is created (§3.4), no seeding.

Because creation waits for the verdict, there is no "withdraw an auto-approved requisition" problem: nothing to undo.

### 4.4 Side-by-side UI, recruiter decides

The review row (rendered from the server-side `jd_import_items` row, §3.2) shows both requirement profiles field by field: pay/currency/period/bound, location + remote, seniority, employment type, must-haves as set-overlap chips with ontology equivalents called out, responsibility themes, job code, hiring client — with the verdict reasons listed and the hard-difference flags marked. Buttons: **Duplicate / Variant / Distinct**. The system never merges JDs on its own; the AI verdict is a suggestion and the recruiter's click is the decision.

**Feedback:** every decision is recorded with `captureFeedback` (src/server/training/capture.server.ts:242): `source: "jd_duplicate_review"`, `label: <verdict>`, `original: { aiVerdict, similarity, fieldDiffs }`, `corrected: { chosenAction }`, `requisitionId` (the existing twin, or the newly created variant). **Inference linkage is B3 scope (review answer to Q4 — this module change is owned here; D4 rebases on it)**: the `jd_duplicate_check` call runs wrapped in `withAiSubject({ requisitionId })` (src/server/agents/context.ts — the gateway already stamps `requisitionId` onto `training_inferences` through it), and `latestInferenceFor` (capture.server.ts:279, which today hard-returns null without an `applicationId`/`candidateId`) gains a `requisitionId` subject branch, so the feedback row links to the exact comparison instead of silently recording `inferenceId: null`. Capture stays consent-gated and never blocks the action.

### 4.5 Caps, erasure and edge cases

- **Comparison caps**: per new JD, at most K=5 pairs; per import run, at most 50 comparisons (rows beyond the cap fall back to the lexical verdict with a `not_compared` flag, so the batch never stalls). The per-org monthly AI cap still applies on top of both.
- **Pending-review rows (`jd_import_items`) are erased with the import**: dismissing/completing a session deletes that session's pending rows (org-scoped delete); decided rows' feedback lives in `training_feedback`/`audit_log` and is not lost. No requisition, JD or profile row is deleted by a dismissal — only the review bookkeeping.
- JD with no pay in both profiles → pay is _equal-unknown_, never a hard difference and never a similarity signal.
- `roleFamily` extraction uncertain → widen the narrowed set to unfamily'd JDs rather than skip the check.
- The lexical check on the manual create-requisition flow stays as-is in B3; the semantic check attaches to the manual requisition-page import in a follow-up **B3b** after B3 merges (review answer to Q8), sharing the core in `src/lib/jd-duplicate.server.ts`.

---

## 5. Test list

**B1a** — `scripts/workflow-profile.test.ts`, plus the completeness sweep (report-only on server fns)

- New tenant / tenant without a profile row behaves exactly as `full_pipeline` (all capabilities; every existing server fn passes unchanged).
- Apply `template` with a published workflow: nav items with missing capabilities hidden; route `beforeLoad` redirects; **agent tools of gated-off types are refused by the executor and their agent types never start** (`startRun`/`enabledOrgs`).
- Switch back to `full_pipeline`: all data still present (requisitions/applications/interviews rows untouched), everything visible again; cancelled runs stay cancelled.
- **Completeness sweep**: enumerates every `NavItem` and every route in the generated tree and fails on any item without a capability or recorded exemption; the tool-registry half fails on ungated tools; the server-fn half logs a report (B1a) / fails (B1b).
- Audit rows written for every apply (`platform.workflow_profile.applied`) and grant/revoke; `from`/`to` in detail; settings changes audited on both the platform and tenant paths.
- Refusals: unpublished workflow, missing studio-agent grant, unknown profile value (zod), non-platform-admin caller, **and a settings/capability dependency violation** (e.g. `approval_gate` on a capability set without `pipeline.approvals` — refused; switching the setting later re-checked).
- `auto_approved` toggle: governance-only change requires step-up (`STEP_UP_REQUIRED` without it) and is audited; a recruiter/owner-without-step-up path is refused.
- Capability cache invalidated on apply **within the same process** (cross-instance staleness ≤30 s is accepted and documented).
- Panel-only members are denied everywhere except their own `requirePanel` interview surfaces, which keep working under `recruiting.interviews`; `/platform*` unaffected by tenant profile.

**B1b** — sweep switched to failing; `requireCapability` present on every tenant-scoped server fn; rerun of the B1a suite green.

**B2 (row 5)** — `scripts/jd-template-branding.test.ts`

- `JdTemplateConfig` zod round-trip with new fields; defaults on omission; `fontFamily` enum rejects junk.
- Save-time validation rejects an invalid branding config; read-time degrade to null still behaves for legacy rows.
- `resolveTemplate(orgId, 'jd')` returns logoPath; `getTemplateLogo` refuses a path outside `${orgId}/branding/`.
- `writeAudit` fired on save/delete/set-default of a jd template.
- Import path fencing: the sample text reaches the analyst prompt only inside an `untrusted_data` fence with `INJECTION_RULES` in the system prompt; extracted `writingStyle`/`boilerplate` are stored as data, and `buildTemplateSystemPrompt` renders them fenced.
- Bundle-import guard covers the `docx` package (Docker build fails if it stops resolving).
- PDF/DOCX builder unit tests: section order from template, accent applied, WinAnsi sanitization (₹ → "Rs. "), footer lines per page. Visual acceptance vs sample JD is manual (milestone gate, screenshots in the PR).

**B3 (rows 6–7)** — `scripts/jd-bulk-import.test.ts`, `scripts/jd-duplicate.test.ts`

- Extraction schema: JD with explicit USD/monthly/range → `pay.status 'known'` with fields; JD without salary → `pay.status 'unknown'`, and `requisitions.payCurrency` left untouched (never INR-by-default).
- Sector: extraction maps to the tenant's `sector_taxonomy_terms` (seeded default present on first use; governance edit reflected in the next extraction).
- `untrusted()` + zod enforced: extraction refuses when the model returns shape-invalid JSON (gateway 502 path, one corrective retry).
- Reworded repost (same role, re-worded bullets, new ref) → `duplicate`; same title, different country → blocked to `variant`/`distinct` by the hard-difference rule; same `externalJobCode` against a **live** requisition → proposed `duplicate` with zero AI calls; same code against a **closed** requisition → normal AI comparison.
- **Duplicate action**: no requisition created for the linked row; the existing requisition and its shortlist are untouched; linking with a foreign-org requisitionId is refused (`assertRequisitionInOrg`).
- **Variant action**: exactly one pass of shortlist rows copied with `source: 'seeded'`, org-scoped, additive, the source shortlist unchanged, **and `poolUse: 'role_only'` candidates are skipped**.
- **Pending review is server-side**: a `duplicate_review` row survives in `jd_import_items` (with its persisted profile) across a simulated new session; dismissing the session erases exactly that session's pending rows and nothing else.
- Narrowing never crosses tenants (org predicate on every query), stays inside the role family + lookback window, **and includes requisitions created earlier in the same batch** (in-batch duplicate resolves via the same UI).
- Recruiter decision recorded via `captureFeedback` only when the org's capture consent is on (and `resetCaptureCache` in tests), with `inferenceId` resolved through the `withAiSubject`/`requisitionId` branch; nothing recorded when consent is off; the action never blocks either way.
- Both requisition modes: `approval_gate` (default) lands at `pending_dh`; `auto_approved` trail entry carries `policyAuditId` pointing at the audit row that enabled the setting + `requisition.auto_created` audit (and the desk/agent-tool callers still cannot produce an auto-approved row — the opt-in is bulk-path-only); lightweight row has no panel/budget writes.
- Caps: per-JD K=5 and per-import 50 respected; over-cap rows fall back to lexical with `not_compared`.
- Per-file failure isolation: one bad file leaves the rest of the batch `created`; `backfillJdProfile` persists once and does not re-derive.

**B3b (follow-up)** — semantic check wired into the single-requisition import path; tests ported from the bulk suite.

---

## 6. Questions — resolved at M0 review (2026-11-27)

1. **Embeddings**: not needed for B3. Role family + recency narrowing with pairwise comparison ships; revisited after the C3 evaluation, and any embeddings path goes through the gateway.
2. **Word export**: `docx` npm (MIT) approved; the Docker bundle-import guard (#111) must cover it.
3. **Brand fonts**: deferred — built-in stacks + accent + logo for B2.
4. **Capture plumbing**: the `capture.server.ts` extension lands in B3, owned here; D4 rebases on it.
5. **Default `jdRequisitionMode`**: superseded by review condition 1 — `approval_gate` is the default; `auto_approved` is governance-only with step-up.
6. **`externalJobCode`**: check-only + index, no unique constraint.
7. **Score contract**: agreed with D4 before C1/C2 code. Surfaces today: `rankPool` (src/lib/shortlist.ts:9–18: `candidate, fit, mustHits, mustMisses, goodHits, experienceOk, locationOk`), the talent-search agent result (src/server/agents/talent-search.server.ts:24–31: `skillHits, textHits, inBand, why`), and `match_scores` (schema.ts:800 — seven dimension scores — skills, experience, career, impact, innovation, education, social — plus `overallScore`, `customScores` evidence, `rationale`, `riskFlags`, `recommendation`).
8. **Semantic check on single imports**: follow-up B3b after B3 merges, not inside B3.
