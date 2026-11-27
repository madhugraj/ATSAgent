# Track B design — workflow profile, branded JD templates, bulk JD import, duplicate JD check

Developer 5 · milestone M0 (design only, no code) · plan rows 0, 5, 6, 7.
Everything here is platform capability for every tenant; client specifics are settings, never code.
Milestone mapping: **B1** = row 0 (§1), **B2** = row 5 (§2), **B3** = rows 6–7 (§3–4). One PR per milestone after this note is signed off.

All paths are relative to the repo root; line references are against `origin/main` at 6f5d8350.

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
- A CI test (§5) enumerates `NAV_GROUPS` and the generated route tree and **fails if any item is unclassified** — the completeness rule is enforced, not asserted.

**Agent → capability map** (static, in `capabilities.ts`): each agent _type_ in `src/server/agents/definitions.ts` declares which capabilities its tools need (e.g. `interview`/panel agents → `recruiting.interviews`; the `*_call` agents — `screening_call`, `scheduling_call`, `confirmation_call`, `panel_check_call`, `negotiation_call` — → `recruiting.voice`; `intake`+`sourcing` → `matching.pool`; `publishing` → `sourcing.distribution`; `requisition`/`jd` → `pipeline.requisitions`). This map is the deterministic bridge from a workflow graph to a capability set, and the basis for tool gating (§1.5).

### 1.3 Storage

New table `org_workflow_profiles`, following the `panel_agent_settings` orgId-primary-key pattern (schema.ts:3798) — exactly one row per org, tighter than a nullable singleton:

- `orgId uuid primaryKey references organizations onDelete cascade`
- `profile text not null` — CHECK in `('full_pipeline', 'template', 'custom')`
- `workflowId uuid null references agent_workflows` — set for `template` / `custom` (which published workflow the tenant runs)
- `resolvedCapabilities jsonb not null default '[]'` — the capability set computed at apply time (transparency + cheap reads; always recomputed server-side at apply, never trusted from client)
- `settings jsonb not null default '{}'` — profile-level settings, declared keys: `jdRequisitionMode: 'auto_approved' | 'approval_gate'` (§3.4), `jdDuplicateLookbackDays: number` (default 90, §4.3), `payVarianceTolerance: number` (default 0.20, §4.3 hard-difference pay band)
- `appliedBy` → users, `appliedAt`, `updatedAt`

Settings are chosen by the platform admin in the apply step and changeable later by tenant governance (`hr_head`/owner) through a small tenant-side settings fn; **both paths are audited** (`platform.workflow_profile.settings_updated` / `workflow_profile.settings_updated` with before/after).

**Absence of a row means `full_pipeline` with all capabilities** — so every existing tenant and every new tenant is untouched by default, and no seeding is needed in `src/lib/org.functions.ts`. A resolver `capabilitiesOf(orgId)` (new `src/lib/capabilities.server.ts`, 30 s per-process cache like `captureEnabled`) returns the full set when the row is absent. `full_pipeline` resolves to all capabilities, preserving today's behaviour exactly. The 30 s staleness after a tightening apply is accepted and stated (server fns are authoritative; the apply is audited); the cache-invalidation test is scoped to a single process (§5).

Capability derivation for `template` / `custom`: union of capabilities declared by the _published version's_ graph via the agent→capability map. If the referenced workflow has no `publishedVersion`, apply is refused (same gate as `grantWorkflow`, platform-agent-workflows.functions.ts:437).

### 1.4 Platform-admin "Apply workflow" step

A new per-row action **Workflow** on the tenant table in `src/routes/platform.tsx` (~lines 330–365, alongside Edit / Users / Archive), backed by two new server fns in `src/lib/platform.functions.ts`, both `.middleware([requirePlatformAdmin])`, following the `grantWorkflow` / `updateOrganizationAsSuperUser` patterns:

- `applyWorkflowProfile` — input `{ orgId, profile, workflowId?, settings? }`. Steps: verify org exists; for `template`/`custom` verify the workflow is published and (reusing the `grantWorkflow` logic) that every `studio:` agent in its graph has an org grant — surface "Grant the studio agent … first." otherwise; grant the workflow if not already live-granted; soft-revoke grants of workflows no longer referenced; upsert the profile row with resolved capabilities; `writeAudit({ action: "platform.workflow_profile.applied", entityType: "organization", entityId: orgId, orgId, detail: { from, to, workflowId, resolvedCapabilities, settings } })`.
- `readWorkflowProfile` — admin read for the dialog (current profile, grants, settings, readiness).

A **custom** profile points at a workflow built in the workflow studio (`agent_blueprints` / studio flow) and published; the apply step is identical — the difference is only provenance, not storage. This is deliberately _not_ an extension of `WORKFLOW_TEMPLATES` (src/lib/workflow-templates.ts), which is the graph-template library for super admins; the Candidate Identification template (row 10, C2) becomes a sixth entry there, gets published, and is then selectable by this step.

### 1.5 Enforcement: nav, routes, server functions, agent tools — one rule everywhere

- **NavCtx** gains `capabilities: string[]` (resolved server-side, delivered by `myOrg` or a sibling query in useNavCtx). `nav-config.ts` items gain `cap?: Capability`; `show` becomes `has(cap) && <existing role predicate>`. AppShell and CommandPalette both filter via `show(ctx)` already, so both follow.
- **Routes**: a shared TanStack `beforeLoad` helper `requireRouteCapability(cap)` — async, calls a small server fn (`requireOrg` + resolver) and `redirect({ to: "/" })` when the capability is missing. This is the first route guard in the tree; the note accepts that router context must not be widened (the async server-fn check is the pattern, matching how `/platform` answers rather than throws).
- **Server functions are authoritative**: new `requireCapability(cap)` middleware composes after `requireOrg`/`requireRole`/`requirePanel` in each function's `.middleware([...])` chain (it needs only `context.orgId`, which `requirePanel` also yields — the panel-only interviewer's own `requirePanel` interview fns keep working under `recruiting.interviews`), plus an imperative `assertCapability(orgId, cap)` (mirroring `assertRole`) for functions with conditional behaviour.
- **Agent tools are gated too**: the `AgentTool` shape (src/server/agents/registry.ts:24) gains an optional `capability`; the tool executor refuses a tool whose capability is missing from `capabilitiesOf(run.orgId)` with a vendor-neutral error, and `enabledOrgs`/`startRun` skip agent types whose entire toolset is gated off, so a gated-off agent never starts and never bills. Without this, the copilot (`/desk`) and tools like `draft_requisition`/`publish_to_job_board` would bypass the profile entirely — the profile would be cosmetic.
- **Completeness is enforced, not asserted**: a CI test (the `agents.lock.json` precedent) walks every tenant-scoped server fn (anything behind a `requireOrg`-chain middleware) and the agent tool registry, and fails unless each declares `requireCapability`/`assertCapability`/a tool `capability`, or appears on a reviewed explicit allowlist in `capabilities.ts` (governance fns, platform fns, public/apply paths).
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

---

## 2. Branded JD templates (row 5 / B2)

### 2.1 Today

`content_templates` kind `jd` (schema.ts:1952) holds only `JdTemplateConfig` = `sections[]` + `boilerplate` (src/lib/templates.server.ts:45). Branding fields exist on the table but are documented as job_card/offer_letter: `logoPath/logoContentType` (already used by offer letters), `backgroundPath`, plus per-kind config fields `accentColor` (offer_letter :137), `headerLines/footerLines/refFormat/signatory`, and `fontFamily` enum `system|serif|mono` on job-card zones (:79). Import from a sample file exists (`analyzeTemplateFile`, templates.functions.ts:87, feature `template_import`, suggestion-only) — note this path today interpolates the uploaded file's text into the prompt **without `untrusted()` fencing and without `INJECTION_RULES`**, a pre-existing gap B2 fixes as part of the work. PDF generation is exclusively client-side jsPDF; the offer letter (`src/lib/offer-letter-pdf.ts`) is the closest branded-export precedent: logo via `getTemplateLogo`, accent via `hexRgb`, WinAnsi `pdfText()` glyph sanitizer (₹ → "Rs. "), per-page footer. **There is no Word/DOCX writer anywhere** — mammoth/fflate DOCX code is read-only.

### 2.2 Branding on the `jd` template

Extend `JdTemplateConfig` (zod in `templates.server.ts`) with the offer_letter-shaped fields; **no schema migration is needed** — config lives in the jsonb `config` column and the logo columns are already kind-agnostic at the DB level:

- `accentColor` (`#rrggbb`, default `#4f46e5` — same default as offer_letter)
- `headerLines` (≤6) and `footerLines` (≤4) — letterhead/footer furniture
- `writingStyle` (≤500 chars) — extracted/declared tone rules
- `fontFamily: 'system' | 'serif' | 'mono'` — the job_card enum; maps to the same CSS/jsPDF built-in stacks

Logo: reuse the existing `logoPath/logoContentType` columns and `uploadTemplateLogo` / `getTemplateLogo` (templates.functions.ts:405/:513) unchanged — the comment on schema.ts:1966 ("job_card only") is corrected. Storage keys stay `${orgId}/branding/logo-<templateId>-<ts>`. Theme = accent + footer/header furniture; a full-bleed background is _not_ offered for JDs (it is a print layout, not a card).

**Fonts constraint, stated honestly**: jsPDF ships only WinAnsi built-ins (the offer letter literally rewrites ₹ → "Rs. ", offer-letter-pdf.ts:14). Brand TTF embedding is possible (`addFont`) but is new scope; B2 ships the three built-in stacks + accent + logo, and defers embedded brand fonts (open question §6).

**Prompt hygiene**: extracted `writingStyle`, `boilerplate`, section headings and `instructions` originate in an uploaded external file — stored as template _data_ and rendered into `buildTemplateSystemPrompt` inside an `untrusted_data` fence (reusing the gateway's `untrusted()` sanitation), never spliced into the system prompt as bare instructions. The same fencing applies to the import analyst call (§2.3).

### 2.3 Import from a sample JD

Extend the existing `analyzeTemplateFile` jd path rather than adding a flow: `TEMPLATE_EXTRACTION_HINT.jd` (templates.server.ts:28) and the jd analyst spec gain "header/footer lines and a writing-style summary" alongside the existing section-order/boilerplate/tone extraction. **Fix the pre-existing invariant gap on this path in the same PR**: the sample file's text enters the prompt through `untrusted("sample_jd", text)` and the analyst system prompt starts with `INJECTION_RULES` (matching `suggestWeightsCore`/`parseResume`, not the legacy shape). **Accent colour is not AI-extracted from text** (consistent with §6 Q4): the editor pre-fills from `organizations.brandColor` and the user picks; only image/vision samples may hint at colour later. Same rules as today otherwise: one `aiJson` call, feature `template_import`, zod-validated suggestion, nothing persists until Save; the sample's original file is kept via the existing `uploadTemplateSource`. Save-time validation: the editor path validates the jd config against the kind schema at save (today `saveTemplate` accepts any record, templates.functions.ts:311, and a corrupt config silently degrades on read — kept as backstop only).

### 2.4 PDF / Word export

- **PDF** (client-side jsPDF, new `src/lib/jd-pdf.ts` mirroring `offer-letter-pdf.ts`): A4, logo from `getTemplateLogo`, accent-coloured section headings built from the template's `sections` order, `pdfText()` glyph sanitizer, footer lines per page. Input is the JD's `full_text` markdown (render headings/paragraphs/bullets; no tables in v1). Trigger: "Download PDF" on the requisition JD panel.
- **Word** (new dependency `docx` npm, client-side, new `src/lib/jd-docx.ts`): same content model → `.docx` Blob download. This is the only new dependency in Track B; there is no existing writer to reuse (open question §6).
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

### 3.2 Flow

New screen **JD import** (route `/jd-import`, capability `pipeline.requisitions`, roles `hr_head | president_cbo | recruiter` via `requireOrg` middleware plus an in-handler `assertRole(userId, orgId, ["hr_head","president_cbo","recruiter"])` — `requireRole` takes exactly one role in this codebase (auth.middleware.ts:186), so the array form goes through `assertRole`, matching its existing signature). The UI mirrors `CvUpload`:

1. Recruiter drops N files (PDF/DOCX/TXT; client-side extraction via `extractResumeText`, scanned-PDF and `.doc` refused as today).
2. Per file, client → `importJdBulk` (server fn, `mapWithLimit` 3 in the client): server extracts the **requirement profile** (§3.3), runs the duplicate check **before creating anything** (§4), and returns one of `created` (requisition + JD made), `duplicate_review` (nothing created; the extracted profile is held in the review row for the side-by-side decision), or `error`.
3. Review list shows per-file state; `duplicate_review` rows open the side-by-side UI (§4.4). Review state is held client-side in the import session; re-importing recomputes deterministically, and a decided `duplicate` row never leaves a half-created requisition behind.

All per-file failures are isolated; the batch never aborts. AI spend is capped automatically by the existing per-org monthly cap; comparison counts are bounded per §4.5 (per-JD K=5 and a per-import ceiling).

### 3.3 Requirement extraction schema

New module `src/lib/jd-requirements.ts` with the shared zod `RequirementProfile`, stored in a new table `jd_requirement_profiles` (one row per `job_descriptions` id, FK cascade, orgId column for tenant scoping, jsonb `profile` + plain `roleFamily` column for narrowing). Extraction is one `aiJson` call, **new AI_FEATURES slug `jd_requirements`**, `INJECTION_RULES` + `untrusted("job_description", text)` (≤20k chars), zod `schema`, following the `parseResume` "use null when genuinely absent" precedent — _not_ the legacy `importJd` shape:

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

Sync to existing columns happens only where semantics match and the field is empty (the `syncRequisitionFromJd` "fills blanks, never overwrites" pattern): must/nice → skill arrays, experience → `experienceMin/Max`, location → `location`, remote → `workMode`, right-to-work → `workAuthorizationRequired`. New column `externalJobCode text null` on `requisitions` (index `(orgId, external_job_code)`) for §4's deterministic check; `sector` stays on the profile row until row 8's taxonomy work lands. Legacy JDs get profiles on demand via a governance-gated `backfillJdProfile` server fn that extracts once, **persists** to `jd_requirement_profiles` (so it is never re-derived), and counts its AI call against the caps in §4.5.

### 3.4 Lightweight requisition

Created only after the duplicate verdict is **distinct** (or the recruiter accepts a variant, §4.4). Per-tenant setting `settings.jdRequisitionMode` on the profile row (§1.3):

- **`auto_approved`** (default): requisition created directly at `status: 'approved'` via a **dedicated opt-in on the core** — `createRequisitionCore(payload, { autoApprove: true })`, a separate explicit field that only the bulk server fn passes (a widened status parameter on the shared core would silently extend the capability to the desk and agent-tool callers, which must remain on `draft`/`pending_dh`). The core builds the `approvalTrail` entry server-side — `{ from: null, to: "approved", actor: <importer email>, decision: "auto_approved", comment: "Bulk JD import" }` — and `writeAudit("requisition.auto_created", ...)` fires. Matching (which requires approved requisitions) can run immediately. The JD version is saved at `status: 'approved'` through the same explicit mechanism (today JDs land at `pending_dh`, requisitions.server.ts:612).
- **`approval_gate`**: requisition at `pending_dh` and JD at `pending_dh` — the existing chain runs untouched.

Both modes skip panel/budget fields (lightweight = `openings`, title, location, skills, pay-band fields only). `assertProfileAllowsRequisition` still runs per row — a tenant with an unapproved org profile refuses the whole file with a clear row error.

### 3.5 Migration & audit

Migration: `jd_requirement_profiles` table + `requisitions.externalJobCode` column, one idempotent SQL file (next free number when the B3 PR opens), `docs/er-diagram.md` regenerated. Audit: `jd_import.bulk_completed` (summary counts) and `requisition.auto_created` per auto-approved row.

---

## 4. Duplicate JD check by meaning (row 7 / B3)

### 4.1 Today

`src/lib/jd-dedupe.ts` is lexical only: token-Jaccard on title (+ department/location/skill boosts), an acknowledgement gate before create (requisitions.index.tsx:264). The agent tool `find_similar_requisitions` is ILIKE word overlap. **No embedding/vector infrastructure exists in the repo.**

### 4.2 Requirement profile

Built once per JD at import (§3.3) and persisted; legacy JDs are backfilled on demand and persisted once (§3.3). Comparison uses the profile, never the raw text.

### 4.3 Narrowing, then field-by-field comparison — before the requisition is created

**Narrow (cheap, deterministic):** candidate set = same org, same `roleFamily`, requisition status live (or created within `settings.jdDuplicateLookbackDays`, default 90), cap K=5 most-recent. Files earlier in the **same batch count too**: files are processed sequentially, so a requisition created earlier in the import is a narrowing candidate for later files, and two files in one batch that duplicate each other resolve through the same side-by-side UI. No embeddings in B3 (open question §6); role family + recency carries the narrowing, and the lexical `findDuplicateRequisitions` Jaccard score re-ranks within the narrowed set.

**Compare (new AI_FEATURES slug `jd_duplicate_check`):** one `aiJson` call per pair, `untrusted()`-fenced with both requirement profiles (small structured JSON, not raw text), zod schema `{ similarity: 0–1, mustHaveOverlap, responsibilityThemes, fieldDiffs[] }`. Ontology equivalents ("B2B sales" ≈ "business development") come from the existing skill-expansion groups (`groupsFor`, pool-match.server.ts:40).

**Hard differences are decided in code, before and after the AI call:** differing country, seniority band (where both known), employment type, hiring client, or pay bands beyond `settings.payVarianceTolerance` ⇒ the pair cannot be `duplicate` (at most `variant`), whatever the AI says. Same `externalJobCode` ⇒ `duplicate` deterministically, no AI call at all.

**Verdicts, with reasons:**

- **Duplicate (repost)** → the import row is marked _linked_ to the existing requisition (which passes `assertRequisitionInOrg` before being accepted) and **no requisition is created** — the existing requisition's shortlist is reused as-is, nothing deleted, no status transitions on live rows.
- **Variant** (same role, different location/level) → recruiter accepts; _then_ the lightweight requisition is created (§3.4) and its shortlist seeded by copying the earlier requisition's shortlist rows once with `source: 'seeded'` (org-scoped, additive, the source shortlist untouched).
- **Distinct** → the lightweight requisition is created (§3.4), no seeding.

Because creation waits for the verdict, there is no "withdraw an auto-approved requisition" problem: nothing to undo.

### 4.4 Side-by-side UI, recruiter decides

The import review row (and a later entry on the requisition page) shows both requirement profiles field by field: pay/currency/period/bound, location + remote, seniority, employment type, must-haves as set-overlap chips with ontology equivalents called out, responsibility themes, job code, hiring client — with the verdict reasons listed and the hard-difference flags marked. Buttons: **Duplicate / Variant / Distinct**. The system never merges JDs on its own; the AI verdict is a suggestion and the recruiter's click is the decision.

**Feedback:** every decision is recorded with `captureFeedback` (src/server/training/capture.server.ts:242): `source: "jd_duplicate_review"`, `label: <verdict>`, `original: { aiVerdict, similarity, fieldDiffs }`, `corrected: { chosenAction }`, `requisitionId` (the existing twin, or the newly created variant). **Inference linkage needs a small extension, stated as B3 scope**: the `jd_duplicate_check` call runs wrapped in `withAiSubject({ requisitionId })` (src/server/agents/context.ts — the gateway already stamps `requisitionId` onto `training_inferences` through it), and `latestInferenceFor` (capture.server.ts:279, which today hard-returns null without an `applicationId`/`candidateId`) gains a `requisitionId` subject branch, so the feedback row links to the exact comparison instead of silently recording `inferenceId: null`. Capture stays consent-gated and never blocks the action.

### 4.5 Caps and edge cases

- **Comparison caps**: per new JD, at most K=5 pairs; per import run, at most 50 comparisons (rows beyond the cap fall back to the lexical verdict with a `not_compared` flag, so the batch never stalls). The per-org monthly AI cap still applies on top of both.
- JD with no pay in both profiles → pay is _equal-unknown_, never a hard difference and never a similarity signal.
- `roleFamily` extraction uncertain → widen the narrowed set to unfamily'd JDs rather than skip the check.
- The lexical check on the manual create-requisition flow stays as-is; the semantic check runs on the bulk path and is exposed on the requisition page for single imports (shared core in `src/lib/jd-duplicate.server.ts`).

---

## 5. Test list

**B1 (row 0)** — `scripts/workflow-profile.test.ts`, plus the completeness test

- New tenant / tenant without a profile row behaves exactly as `full_pipeline` (all capabilities; every existing server fn passes unchanged).
- Apply `template` with a published workflow: nav items with missing capabilities hidden; route `beforeLoad` redirects; gated server fns (e.g. offers) throw the capability error with the same org predicate intact; **agent tools of gated-off types are refused by the executor and their agent types never start** (`startRun`/`enabledOrgs`).
- Switch back to `full_pipeline`: all data still present (requisitions/applications/interviews rows untouched), everything visible again; cancelled runs stay cancelled.
- **Completeness sweep**: a test enumerates every `NavItem` and every route in the generated tree and fails on any item without a capability or recorded exemption; a second sweep walks every tenant-scoped server fn and registered agent tool and fails unless it declares a capability check or sits on the reviewed allowlist (the CI-enforced lock pattern).
- Audit rows written for every apply (`platform.workflow_profile.applied`) and grant/revoke; `from`/`to` in detail; settings changes audited on both the platform and tenant paths.
- Refusals: unpublished workflow, missing studio-agent grant, unknown profile value (zod), non-platform-admin caller.
- Capability cache invalidated on apply **within the same process** (cross-instance staleness ≤30 s is accepted and documented).
- Panel-only members are denied everywhere except their own `requirePanel` interview surfaces, which keep working under `recruiting.interviews`; `/platform*` unaffected by tenant profile.

**B2 (row 5)** — `scripts/jd-template-branding.test.ts`

- `JdTemplateConfig` zod round-trip with new fields; defaults on omission; `fontFamily` enum rejects junk.
- Save-time validation rejects an invalid branding config; read-time degrade to null still behaves for legacy rows.
- `resolveTemplate(orgId, 'jd')` returns logoPath; `getTemplateLogo` refuses a path outside `${orgId}/branding/`.
- `writeAudit` fired on save/delete/set-default of a jd template.
- Import path fencing: the sample text reaches the analyst prompt only inside an `untrusted_data` fence with `INJECTION_RULES` in the system prompt; extracted `writingStyle`/`boilerplate` are stored as data, and `buildTemplateSystemPrompt` renders them fenced.
- PDF/DOCX builder unit tests: section order from template, accent applied, WinAnsi sanitization (₹ → "Rs. "), footer lines per page. Visual acceptance vs sample JD is manual (milestone gate, screenshots in the PR).

**B3 (rows 6–7)** — `scripts/jd-bulk-import.test.ts`, `scripts/jd-duplicate.test.ts`

- Extraction schema: JD with explicit USD/monthly/range → `pay.status 'known'` with fields; JD without salary → `pay.status 'unknown'`, and `requisitions.payCurrency` left untouched (never INR-by-default).
- `untrusted()` + zod enforced: extraction refuses when the model returns shape-invalid JSON (gateway 502 path, one corrective retry).
- Reworded repost (same role, re-worded bullets, new ref) → `duplicate`; same title, different country → blocked to `variant`/`distinct` by the hard-difference rule; same `externalJobCode` → deterministic `duplicate` with zero AI calls.
- **Duplicate action**: no requisition created for the linked row; the existing requisition and its shortlist are untouched; linking with a foreign-org requisitionId is refused (`assertRequisitionInOrg`).
- **Variant action**: exactly one pass of shortlist rows copied with `source: 'seeded'`, org-scoped, additive; the source shortlist unchanged.
- Narrowing never crosses tenants (org predicate on every query), stays inside the role family + lookback window, **and includes requisitions created earlier in the same batch** (in-batch duplicate resolves via the same UI).
- Recruiter decision recorded via `captureFeedback` only when the org's capture consent is on (and `resetCaptureCache` in tests), with `inferenceId` resolved through the `withAiSubject`/`requisitionId` branch; nothing recorded when consent is off; the action never blocks either way.
- Both requisition modes: `auto_approved` trail entry + audit (and the desk/agent-tool callers still cannot produce an auto-approved row — the opt-in is bulk-path-only); `approval_gate` lands at `pending_dh`; lightweight row has no panel/budget writes.
- Caps: per-JD K=5 and per-import 50 respected; over-cap rows fall back to lexical with `not_compared`.
- Per-file failure isolation: one bad file leaves the rest of the batch `created`; `backfillJdProfile` persists once and does not re-derive.

---

## 6. Open questions (for review sign-off)

1. **Embeddings for narrowing.** The plan (§2a) names embedding similarity, but the repo has no vector substrate and the AI invariant restricts provider calls to `aiJson`/`aiResearchJson`/`aiAgentStep` — an embeddings call would need a gateway extension. B3 ships deterministic narrowing (role family + recency) + AI pairwise compare over ≤5 candidates. Acceptable for row 7's "done when", or should the gateway gain an embeddings path first?
2. **Word export dependency.** No DOCX writer exists; propose the `docx` npm package client-side. Any objection to the new dependency?
3. **Brand fonts.** jsPDF built-ins only in B2 (WinAnsi; ₹→"Rs." precedent). True brand fonts need TTF embedding or an HTML-render path that doesn't exist. Defer?
4. **Capture plumbing extension.** §4.4 adds a `requisitionId` subject to `withAiSubject`/`latestInferenceFor` — a small change inside the training-capture module. Confirm it may land in B3 rather than waiting for D4's track (it touches `capture.server.ts`, which D4 also uses).
5. **Default `jdRequisitionMode`.** Plan says "approval gate optional per tenant" — proposing `auto_approved` as the default (matching the plan's "no approval gate" default for lightweight requisitions) with the gate as opt-in. Confirm.
6. **`externalJobCode` uniqueness.** Uniqueness is enforced per org among _live_ requisitions only (a partial unique index) or not at all (check-only)? Proposing check-only + index, since reposts legitimately reuse codes after close-out.
7. **Score contract with D4 (rows 8–9).** To be agreed before C2 build starts, not blocking this note. Today there are two ranking surfaces: the deterministic pool pre-ranker `rankPool` (src/lib/shortlist.ts:9–18: `candidate, fit, mustHits, mustMisses, goodHits, experienceOk, locationOk`) and the talent-search agent's result shape (src/server/agents/talent-search.server.ts:24–31: `skillHits, textHits, inBand, why`); persisted per-application scoring is `match_scores` (schema.ts:800 — seven dimension scores — skills, experience, career, impact, innovation, education, social — plus `overallScore`, `customScores` evidence, `rationale`, `riskFlags`, `recommendation`). C1 decides which of these (or its successor) the shortlist view renders.
8. **Where the semantic check attaches on single imports.** Proposing the same core runs on the manual requisition-page import after B3 lands, replacing the lexical-only gate there; confirm scope is in B3 and not deferred.
