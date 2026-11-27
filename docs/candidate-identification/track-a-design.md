# Track A design — candidate identity, CV versions, intake

Status: draft for M0 review (2026-11-27). Developer 4, rows 1 → 2 → 3 → 4 of the
[execution plan](../candidate-identification-plan.md), then C1 (row 8).
Scope note: everything here is platform capability; per-client behaviour is tenant
settings, never code. Code references name symbols first; line numbers are approximate
as of origin/main 6f5d8350.

## 0. Today, in one paragraph

Candidates are a single row in `candidates` (drizzle/schema.ts:680): `resumeText` and
one `resumeFilePath` in the private `resumes` bucket are overwritten on every new CV —
there is no version history. Duplicate checks are exact-match and scattered: a
linkedin/email lookup inside `ingestCandidateInner` (src/lib/intake.server.ts:317), an
email lookup on the public apply path (src/lib/apply.functions.ts:184), a raw
non-lowercased email lookup in the IJP handler (src/lib/requisitions.functions.ts:563),
an external-id upsert on provider search import (src/lib/integrations.functions.ts:302),
and **no check at all** on recruiter manual create (src/lib/candidates.functions.ts:118).
Nine paths create candidate rows in total (§1.7). Two merge semantics coexist: intake
overwrites the row with the newest CV (intake.server.ts:354) while the recruiter merge
fills blanks and keeps the longest CV — and a pure client-side clusterer
(src/lib/dedupe.ts) plus a destructive server merge (`mergeCandidatesFn`,
src/lib/dedupe.functions.ts:71) hard-delete duplicate rows with **no audit entry and no
undo**. Every gap the plan lists is real: no unique key on email/phone/linkedin (the
only unique indexes are on applications `(requisitionId, candidateId)` and the
external-provider pair, schema.ts:750), no file hash, no fuzzy matching, no review
queue, no versions, no claims.

## 1. Milestone A1 — candidate identity (plan row 1)

### 1.1 Tables and migration

One migration (`0094_candidate_identity.sql`, next free number; additive and idempotent,
rolled by `scripts/migrate-pg.mjs`, ER diagram regenerated). New tables, all with
`orgId uuid not null references organizations` (see 1.6 on the unassigned pool):

**`candidate_identity_keys`** — the normalised strong keys, one row per key per
candidate. Columns: `id`, `orgId`, `candidateId` (FK → candidates, cascade),
`keyType` enum in (`email`, `phone`, `linkedin`, `github`, `file_hash`, `placeholder`,
`external`), `keyValue` text, `sourceVersionId` (plain uuid in migration 0094 — the FK
constraint to `candidate_cv_versions` is added by the A2 migration, so 0094 never
references a table that does not exist yet), `createdAt`.
Unique index on (`orgId`, `keyType`, `keyValue`) — the schema-level guarantee the plan
asks for. Placeholder emails (§1.2) are keyed under `placeholder` with their
deterministic value, so they match only among themselves exactly as today's lookup
does, and never collide with a real address. `external` keys carry the existing
`(externalProvider, externalId)` pair (schema.ts:750) so board-synced candidates
participate in the same index; the provider's own upsert stays as an additional
write-path signal.

**`candidate_merge_suggestions`** — the review queue, shaped like
`planChangeProposals` (the repo's review-queue template, schema.ts:1189): `id`,
`orgId`, `candidateAId` / `candidateBId` (FKs, cascade), `score` numeric, `reasons`
jsonb (per-signal breakdown, §1.3), `status` text in (`pending`, `merged`,
`kept_separate`, `stale`) with a check constraint, `decidedBy`, `decidedAt`,
`decisionNote`, `mergeId` (nullable FK, set when merged), `createdAt`. Index on
(`orgId`, `status`). Lifecycle is explicit, not FK-event magic: erasure of either
candidate removes the pair row through the cascade FK; a merge that absorbs either
side of a pending suggestion flips it to `stale` in the same transaction as the merge
(service code in the identity module, tested).

**`candidate_merges`** — the reversible merge record: `id`, `orgId`, `survivorId`,
`mergedId` (the row absorbed), `undoSnapshot` jsonb, `undoneAt`, `undoneBy`,
`createdBy`, `createdAt`. `undoSnapshot` holds the **full pre-merge rows of every
record the merge deletes or modifies** — not only re-pointed children: the absorbed
candidate row, the re-pointed children (applications, versions, notes, referrals,
skill evidence, verifications, assessments, social profiles — the full child-table
enumeration of dedupe.functions.ts plus the ones it misses), _and_ any child row the
merge had to delete outright, e.g. a duplicate application for a requisition the
survivor already applied to (forced by the `applications_requisition_candidate_key`
unique index, schema.ts:779). Undo re-inserts deleted rows with their original ids and
`createdAt` values and re-points the rest back, all in one transaction; the snapshot is
then cleared. `writeAudit` entries (`candidate.merge`, `candidate.merge.undo`,
`candidate.merge.suggestion_decided`) are written fire-and-forget alongside — audit
never carries transactional weight, the snapshot does. Automatic strong-key merges
made at intake write the same `candidate.merge` audit with the intake source in
`detail`.

**`candidate_identity_settings`** — thresholds as tenant settings, following the
per-domain settings-table pattern (`panelAgentSettings`, schema.ts:3799): `orgId`
primary key, `autoMergeStrongKeys` bool default true, `fuzzyHighThreshold` numeric
default 0.85, `fuzzyLowThreshold` numeric default 0.60, `defaultPhoneRegion` text
default null, `flagConfig` jsonb (§2.4), `updatedAt`, `updatedBy`. DB defaults mean
existing tenants need no backfill. Check constraints bound the thresholds
(`0 <= low <= high <= 1`). The unique index above and this setting are consistent by
construction: a strong-key collision either merges (setting on) or is routed to the
review queue with the newcomer's key insert **deferred until the decision** (the key
value is recorded on the suggestion row); the second key row is never silently dropped
or rejected. Setting changes are audited (`candidate.identity_settings_updated`,
before/after) since they change destructive behaviour.

What changes on existing tables: nothing on `candidates` except two nullable columns,
`fileHash` text and `mergedIntoId` uuid (FK → candidates, onDelete set null), so a
merged row is marked rather than deleted. Every existing read path that must not see
absorbed rows gains `isNull(candidates.mergedIntoId)` — at minimum the pool-match
sweep and talent search (pool-match.server.ts:73, talent-search.server.ts:240), the
candidates list/search and export, duplicate clustering, and A3's import hash lookups
— with a test that a merged row is invisible to the pool sweep. The existing direct-merge path in
candidates.index.tsx/dedupe.functions.ts moves behind the new identity service in the
same PR; `src/lib/dedupe.ts` normalisation helpers are absorbed into the new module and
its two duplicated `mergeCandidateFields` implementations collapse into one server-side
copy.

### 1.2 Normalisation rules

All in `src/server/candidates/identity.server.ts` (pure helpers split into
`src/lib/candidates/identity-normalise.ts` so tests need no DB):

- **Email:** trim, lowercase, strip `+tag`, strip dots in the local part for
  gmail/googlemail domains (extending the existing `normEmail` in dedupe.ts:16).
  Placeholder domains are keyed under the `placeholder` key type with their
  deterministic value (`@no-email.atsiq.local` addresses are sha256-derived and
  stable, intake.server.ts:271, so today's email-less dedupe keeps working;
  `@import.local` has no producer in src — tests only). A placeholder key can never
  match a real `email` key; it matches other `placeholder` keys by equality, which is
  exactly what today's lookup does.
- **Phone:** to E.164 using the tenant's `defaultPhoneRegion` (libphonenumber-style
  parsing). A full E.164 result (country code present or resolvable from the
  tenant's region) is required for a phone key to participate in **automatic**
  merge — phone numbers are not person-unique (household landlines, agency front
  desks), and the legacy last-10-digits fallback (dedupe.ts:24) drops country codes
  and collides across regions. When only a weak fallback parse is possible, the key
  is stored but a phone-only hit routes to the review queue, never auto-merge. The
  raw value stays on the candidate row.
- **LinkedIn / profile URLs:** strip protocol, `www.`, trailing slash, and the
  `/in/` prefix is canonicalised away (extending `normUrl`).
- **File:** sha256 of the raw bytes, computed at upload time before parsing; stored in
  `candidate_identity_keys` as `file_hash` and on `candidates.fileHash`.

### 1.3 Match and decision rules

Blocking: candidates are compared only within key buckets (`email`, `phone`,
`linkedin`, `github`, `file_hash`) — no pairwise scans. New intake computes the
newcomer's keys, looks up collisions through the unique index (org-scoped), and:

1. **File hash hit** first, because identical bytes are about the _file_, not the
   person: the file attaches as a new version of the matched candidate **only when a
   corroborating signal agrees** (normalised name match). Identical bytes with a
   different name (an agency template, a reference CV reused across people) go to the
   review queue — a hash alone never merges and never attaches.
2. **Strong key hit** (`email`, `linkedin`, `github`, or full-E.164 `phone`) → automatic
   merge into the existing candidate when the tenant has `autoMergeStrongKeys` on
   (default). This preserves today's semantics (intake already merges on exact
   email/linkedin) while making them tenant-switchable. With the setting off, the hit
   becomes a review suggestion and the newcomer's key insert is deferred to the
   decision (§1.1). A phone-only hit backed by the weak last-10-digits parse is never
   automatic — review queue.
3. **No strong key** → fuzzy score over career-history evidence, since tailored CVs
   change text but rarely the timeline:
   - name similarity (normalised-token Jaccard, 0–1);
   - employment-timeline overlap: Jaccard over (normalised employer, start year) pairs
     from `employmentHistory` (already parsed at intake, intake.server.ts:95);
   - education overlap: institution token overlap plus year proximity;
   - location agreement as a tie-breaker only.
     Score = weighted sum (weights fixed in code, not settings — only the _thresholds_
     are tenant settings, per the plan). `score ≥ fuzzyHighThreshold` → review-queue
     suggestion; `score < fuzzyLowThreshold` → new candidate; between → review queue
     with a lower-confidence reason set. **No automatic merge on fuzzy evidence, ever.**

Every decision path is org-scoped: the blocking lookup carries
`eq(candidate_identity_keys.orgId, ctx.orgId)` behind `requireOrg`. Cross-tenant
matching is impossible by construction; the `candidates.orgId is null` unassigned pool
is its own scope (see 1.6).

**Concurrency:** today's SELECT-then-insert dedupe lets two concurrent arrivals for
the same person both insert (no unique index backs it). Here the key insert is the
arbiter: inside the intake transaction, a unique violation on
`candidate_identity_keys (orgId, keyType, keyValue)` is caught and the arrival
re-resolves as a merge into the key's existing owner (single retry, then fail the
item loudly). Double-submitted apply forms and in-flight mailbox duplicates resolve to
one candidate deterministically.

### 1.4 Consistency of the rule set with existing guards

- Intake's parsed-name-vs-expected-name token-overlap guard (intake.server.ts:249)
  stays where it is; identity runs after it.
- The public apply path (apply.functions.ts:119) keeps its asymmetry, now stated as a
  hard rule for the identity module: on unauthenticated surfaces `resolveIdentity` is
  **lookup-only** — it may return the existing candidate's id (today's behaviour), but
  it never merges, never mutates the existing row, and never attaches a version or
  claim to it. The applicant's CV is stored only on the newly inserted row; a strong
  or fuzzy hit links the application to the existing id and, when the evidence
  conflicts, additionally enqueues a review suggestion for a recruiter. This keeps the
  public page from becoming a record-takeover vector.
- Queue hygiene: erasure of either candidate removes the suggestion row via the
  cascade FK; a merge that absorbs either side of a pending suggestion flips it to
  `stale` in the same transaction (§1.1) — the queue never shows dead pairs, and
  neither behaviour relies on FK events that do not exist.

### 1.5 Merge review queue UI

New route `src/routes/candidates/merge-review.ts` (nav entry under the Candidates hub,
`show: c => c.recruiterView`, mode manual — server fns enforce the role regardless).
Pattern copied from `/agents`: tabs with counts in the label (`Pending (n)` /
`Decided`), `refetchInterval: 15_000`, one `panel p-5` card per pair. The card uses the
`RunCompare` layout language (agents.index.tsx:433 — `grid md:grid-cols-2` of two
bordered blocks): each side shows name, normalised contacts, employment timeline,
education, source, and the per-signal reasons with `SkillPills`-style agree/conflict
tones. Actions: **Merge** (wrapped in `withStepUp()`, the established privileged-decision
pattern from AgentTaskCard.tsx:46) and **Keep separate**. Both write audit and decide
the suggestion row. Merge picks the survivor by the existing convention (oldest row);
the card shows which side will survive. Self-explanatory per house rules: no helper
sentences, counts appear once, `num` class for figures, vendor names nowhere.

The existing bulk-merge toolbar on candidates.index.tsx routes through the same service
(strong-key merges stay instant; `likely` pairs from `findDuplicateGroups` are seeded
into the review queue instead of merging inline).

### 1.6 The unassigned pool

`candidates.orgId` is nullable and today's intake treats `isNull(orgId)` as its own
dedupe scope (intake.server.ts:315). Design decision: identity keys exist only for
org-scoped candidates; unassigned-pool rows keep today's inline lookup (the one
retained exception to §1.7's "all paths") and are out of scope for the identity module
until they are assigned to a tenant, at which point their keys are computed and the
normal flow takes over. Matching never crosses tenants and never crosses between the
pool and a tenant. The same deferral applies to A2: a pool upload keeps CV text only
in today's `resumeText`/`resumeFilePath` columns — no version row exists for
pool-scoped candidates (their table is `orgId not null`) — and on org assignment the
stored text/file is migrated into the candidate's first version and claims extraction
runs then.

### 1.7 Intake paths routed through the module

There are nine creators of candidate rows; all of them route through
`resolveIdentity(orgId, normalizedInput)` before insert, and the scattered lookups are
removed:

| #   | Path                                                                                                                             | Today's duplicate behaviour                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Recruiter bulk upload — `saveCv` (src/lib/intake.functions.ts:24) → `ingestCandidate`                                            | exact linkedin/email inside the intake transaction (intake.server.ts:313)                                    |
| 2   | Public apply page — `submitApplicationImpl` (src/lib/apply.functions.ts:119)                                                     | exact email, org-scoped; never mutates an existing row                                                       |
| 3   | Careers inbox — inbound-email webhook → `receiveMail` (src/lib/local-inbox.server.ts:136) + `retryMessage` (:289)                | via `ingestCandidate`; provider duplicate deliveries skipped by unique `(orgId, providerMessageId)`          |
| 4   | Job-board webhook — `/api/public/boards/$provider/$token` → `fileNormalizedApplication` (src/server/boards/ingest.server.ts:249) | via `ingestCandidate`; idempotent raw-event store; profile-only deliveries never overwrite a stored CV       |
| 5   | Scheduled board pull — `/api/public/board-sync` → `pollAllBoards` (src/server/boards/poll.server.ts:37)                          | same event store as 4                                                                                        |
| 6   | Provider search import — `importCandidates` (src/lib/integrations.functions.ts:224)                                              | `onConflictDoUpdate` on the partial unique `(externalProvider, externalId)` with `setWhere: eq(orgId)`       |
| 7   | Internal IJP apply — `applyInternally` (src/lib/requisitions.functions.ts:535)                                                   | raw, **non-lowercased** email compare (requisitions.functions.ts:560) — normalisation drift the module fixes |
| 8   | Recruiter manual create — `createCandidate` (src/lib/candidates.functions.ts:118)                                                | **no duplicate check at all** — the only path that can silently create a same-email duplicate                |
| 9   | Browser capture — `/api/public/capture` → `capture()` (src/lib/capture.server.ts:190)                                            | via `ingestCandidate`; profile-only records fill blanks, never overwrite                                     |

Dispositions for the two paths the current code handles differently: the provider
search import (path 6) routes through `resolveIdentity` like every other path while
keeping its external-id upsert as an additional signal (`external` key type, §1.1) —
the two must reconcile, and the external upsert's `setWhere: eq(orgId)` guard stays.
Recruiter manual create (path 8) also resolves identity: a colliding insert becomes a
review suggestion instead of today's silent duplicate — a recruiter's deliberate
"new person" entry is never auto-merged, only queued. §1.7's "every creator" means
every **org-scoped** creator; the unassigned-pool branch of intake keeps its inline
lookup per §1.6.

The intake core's existing protections are preserved through the refactor: the
name-mismatch guard (intake.server.ts:248), the placeholder-email scheme for
email-less captures (`@no-email.atsiq.local`, intake.server.ts:271 — load-bearing for
email dedupe), the "never lose the person, never block on the file" behaviour, and AI
cost re-attribution (`withAiSubject` + `labelCvCost`, intake.server.ts:174-216).
`poolUse='role_only'` candidates (portal-terms CVs, erased when their roles end) stay
out of pool matching exactly as pool-match.server.ts:73 excludes them today.

A race today's code has and this design closes: with no unique index on email, two
concurrent arrivals for the same person can both insert; the unique index on
`candidate_identity_keys (orgId, keyType, keyValue)` makes the second arrival resolve
to the existing candidate deterministically (last-writer merges instead of
duplicating).

## 2. Milestone A2 — CV versions and the evidence profile (plan row 2)

### 2.1 Tables

**`candidate_cv_versions`** — `id`, `orgId`, `candidateId` (FK cascade),
`requisitionId` (nullable FK; client-supplied values pass `assertRequisitionInOrg`
first — authenticated paths pass the caller's `ctx.orgId`, while the public apply path
keeps deriving the org from the requisition row it fetched (apply.functions.ts:128)
and never accepts a client-supplied orgId), `source` text (upload / apply / inbox / board /
ijp / archive_import), `fileHash` text, `filePath` text (`<orgId>/<candidateId>/<versionId>/<file>`
in the same private bucket), `parsedText` text, `parsed` jsonb (the existing `ParsedCv`
shape), `submittedAt`, `receivedAt`, `extractionStatus` text in (`pending`, `done`,
`failed`, `skipped`). Index on (`candidateId`, `submittedAt`). The candidate row keeps
`resumeFilePath`/`resumeText` as the _current_ version's denormalised copy so all
existing readers keep working.

**`candidate_claims`** — `id`, `orgId`, `candidateId` (FK cascade), `versionId` (FK
cascade — a claim belongs to the version that states it), `claimType` enum in
(`skill`, `role`, `project`, `cert`, `achievement`), `normalisedValue` text,
`rawValue` text, `evidenceStrength` enum in (`demonstrated`, `listed`, `inferred`),
`passage` text (the quoted CV span), `passageStart`/`passageEnd` int nullable,
`contextJson` jsonb (role/project anchors: employer, dates), `firstSeenVersionId`,
`extractionModel` text (DB only, stripped from wire returns), `createdAt`.
Index on (`orgId`, `candidateId`) and (`versionId`).

Erasure: both tables cascade from `candidates.id`, so `eraseCandidatesCore`
(erase.server.ts:15) removes every version and claim via the existing cascade walk;
the only change there is deleting the per-version storage objects — the walk gains one
loop over `candidate_cv_versions.filePath` before deleting rows, preserving the
delete-files-first, abort-on-failure discipline. Retention per version (plan §2b.5) is
a per-tenant setting added in A3 with the archive job.

### 2.2 Claims extraction (AI)

New `AI_FEATURES` slug `cv_claims_extract` (appended to the literal array in
src/server/ai-usage.ts:9; no migration — the ledger column is text). Call shape copies
`parseCv` (intake.server.ts:42) exactly:

- system prompt starts with `${INJECTION_RULES}` plus extraction rules (a claim must be
  traceable to a span; classify evidence strength: _demonstrated_ = described inside a
  role/project with context, _listed_ = keyword only, _inferred_ = implied; never
  invent; respond with raw JSON);
- CV text enters through `untrusted("cv_version", text)` — and only the stored
  `parsedText` is ever sent, so a re-run from the same row yields the same claim set
  (idempotent re-extraction, mirroring `retryMessage`);
- zod schema via aiJson's `schema` option, written to survive strict validation with
  partial data (all arrays optional, nullable fields) because a validation failure
  after the single corrective retry fails the whole call:

```ts
z.object({
  claims: z
    .array(
      z.object({
        type: z.enum(["skill", "role", "project", "cert", "achievement"]),
        value: z.string().min(1),
        evidence: z.enum(["demonstrated", "listed", "inferred"]),
        passage: z.string().min(1),
        employer: z.string().nullable().optional(),
        start: z.string().nullable().optional(),
        end: z.string().nullable().optional(),
      }),
    )
    .max(200)
    .default([]),
});
```

- wrapped in `withAiSubject({ candidateId, ... })` so `ai_usage_events` and training
  capture carry the candidate (gateway/ledger fact, src/server/agents/context.ts:32),
  with the `labelCvCost` relabel kept for per-candidate cost reporting
  (intake.server.ts:174-216);
- text budgets are explicit: `untrusted()` caps at 60 000 chars and `parseCv` slices at
  20 000 — versions longer than the cap are chunked at role boundaries (open question
  §8); the model/provider fields of the gateway result are consumed server-side only.

Extraction runs per version at ingest (synchronous for single uploads, queued for
archive import in A3).

### 2.3 Consolidated profile

Built read-side, not stored: a `getConsolidatedProfile(orgId, candidateId)` server
function groups claims by `normalisedValue` (exact match first; ontology-equivalent
match reuses the `expandSkills` grouping idea, talent-search.server.ts:58, at lower
volume), and per claim reports: strength (max across versions: demonstrated > listed >
inferred), which versions mention it and when it first appeared, and a passage from the
strongest version. The employment timeline is merged across versions by (employer,
start year) with conflicts surfaced rather than silently resolved; projects keep the
fullest description. This keeps the profile correct as versions and merges change —
no second source of truth to maintain.

### 2.4 Consistency flags

Computed in the same server function, per candidate, each with an explicit rule:

| Flag                | Computed how                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date conflict       | two versions give different (start, end) for the same (employer, title) pair                                                                                                                                                                                                                |
| Title conflict      | same employer+period, different titles across versions                                                                                                                                                                                                                                      |
| Employer conflict   | overlapping date ranges at different employers across versions                                                                                                                                                                                                                              |
| Single-source claim | claim of strength `listed` that appears in exactly one version, and that version is the one submitted for the JD being viewed                                                                                                                                                               |
| JD mirroring        | keyword-overlift: content-word Jaccard over the JD's must-have/requirement terms between a version and the requisition it was submitted against, above a default threshold of 0.5 (fixed in code; the flagConfig entry carries the on/off switch and may override the threshold per tenant) |

All flags are display-only integrity signals — nothing auto-rejects (plan §2b.3). The
tenant chooses which flags show (`Which flags show` is row 2's configurable column): a
`candidate_identity_settings.flagConfig` jsonb defaulting to all-on (each flag gets a
boolean; the JD-mirroring entry also carries an optional threshold override). On the candidate
page (candidates.$id.tsx) the consolidated profile is a new `panel p-5` section in the
main column: claims grouped by type with strength chips, each claim showing its source
version and passage, timeline panel, and the flags row. Merged candidates' panels read
across all versions from both sides (versions are re-pointed to the survivor on merge).

### 2.5 Erasure

Covered by 2.1's cascade design plus the storage walk extension. Test: erase a
candidate with three versions and claims → no version rows, no claim rows, no storage
objects remain; the capture_events link is still cleared first.

**Erasure × merge.** Three cases the cascade alone does not cover, each specified:

- _Erase a candidate that absorbed someone_ (survivor): the survivor's own versions
  and claims cascade away; the absorbed person's PII must not survive inside
  `candidate_merges.undoSnapshot` — the erasure walk deletes every
  `candidate_merges` row whose `survivorId` or `mergedId` is the erased candidate
  (undo is no longer possible once either side is erased; the audit trail of the
  merge itself remains in `audit_log`, which records the action without CV content).
- _Erase a tombstone row_ (`mergedIntoId` set, its versions already re-pointed to the
  survivor): the row and its remaining children (its own verifications, notes,
  referrals) cascade; the survivor's data is untouched, and the survivor's
  `candidate_merges` row is deleted by the same rule as above, which also removes the
  tombstone's snapshot PII. `mergedIntoId` on the tombstone points _to_ the survivor,
  so erasing the survivor first sets it null via the FK before the tombstone's own
  erasure completes.
- _Pending suggestions_ referencing the erased candidate: removed by the cascade FK
  (§1.1).

No path leaves an absorbed person's name, email, phone or CV text in any table after
erasure; a test enumerates all three cases.

## 3. Milestone A3 — archive import and ongoing intake (plan rows 3–4)

### 3.1 The import job

No queue framework exists; background work is Postgres queue tables drained by
cron-routed POST endpoints (screening-prep is the canonical worker: backfill → reclaim
expired leases → `FOR UPDATE SKIP LOCKED` claim → `mapWithConcurrency` process →
attempts/backoff, src/lib/screening-prep.server.ts:65). The import copies that shape:

- **`candidate_archive_imports`** — one row per upload batch: `id`, `orgId`,
  `createdBy`, `status` in (`pending`, `running`, `paused`, `done`, `failed`),
  `trialRun` bool, `counts` jsonb (total / done / failed / merged / needs_review /
  skipped), `fileCount`, `createdAt`, `updatedAt`.
- **`candidate_archive_items`** — one row per file: `id`, `orgId`, `importId` (FK),
  `fileName`, `fileHash` (sha256, unique per (`orgId`, `importId`) — plus a per-org
  historical lookup against `candidate_identity_keys.file_hash` making re-runs
  idempotent: an item whose hash already exists is marked `skipped` with the existing
  candidate id, never re-imported), `status` in (`pending`, `running`, `done`,
  `failed`, `needs_review`, `skipped`), `candidateId` nullable, `detail` text
  (vendor-neutral failure from a `FRIENDLY_ERRORS`-style allowlist, never provider
  text), `attempts`, `lastErrorAt`, timestamps. Queue index on (`status`, `updatedAt`).
- Storage and its lifecycle: files staged at
  `<orgId>/archive-import/<importId>/<n>/<fileName>` via `putObject`
  (src/server/storage.ts:106). The manifest lives in the table, not in bucket listing —
  progress counts, idempotent re-runs and the failure list all need per-item rows, and
  the storage module exposes no enumeration primitive for this use. Staged bytes are
  personal data with no owning candidate row, so the erasure cascade can never reach
  them; every item therefore has an explicit terminal-state rule: on success the
  staged object moves to the version path (A2); on `skipped` / `failed` / trial-run
  completion the staged object is deleted when the item reaches that state; and an
  import-level sweep deletes any object remaining under the import prefix before the
  import is marked `done`. Trial runs keep extracted text and hashes in the report,
  never the file bytes.
- **Worker:** `src/server/candidates/archive-import.server.ts`, ticked by a new
  `/api/public/archive-import-tick` route behind `authenticateCronRequest` (Cloud
  Scheduler registration is a devops step, infra/DEPLOYMENT-HANDOFF.md:200 — the
  backfill phase self-heals a missed tick, same as screening-prep). Per tick: claim a
  small batch (default 10 — each item may cost a 45 s parser call plus an AI call),
  process with bounded concurrency, per-org checks first: import enabled?
  `spendCapRefusal(orgId)` (the monthly org token cap, src/server/ai-spend-cap.ts:83,
  normally enforced inside the gateway) → defer items to a later tick without burning
  attempts — this defer-instead-of-fail behaviour is new, covered by the A3 spend-cap
  test. Reclaim running items whose lease expired. Tenant settings: batch size,
  retention, and (for §3.2) the pull schedule join
  `candidate_identity_settings` / the connection table.
- **OCR:** scanned PDFs extract no text today (attachmentText returns `""`,
  src/lib/cv-text.server.ts:20) — there is no CV OCR. Design: items with empty text
  after parse go to a `needs_review`/`failed` state with an actionable reason, and a
  new `cv_ocr` AI_FEATURES slug (vision call through the gateway, precedent:
  `org_document_ocr`) processes them when the tenant enables it — spend-capped and
  ledger-recorded like every other call. Parse-service outage must be distinguished
  from bad files: empty text with a healthy parser is retryable, not a permanent
  failure (parseRemote returns `""` on every failure, so the probe is attempts +
  backoff, escalating to failed only after MAX_ATTEMPTS).
- **Progress UI:** an Imports section on the candidates page (or
  `/candidates/import`): per-import card with the six counts and a downloadable CSV of
  failed/needs-review items generated server-side from `candidate_archive_items`.
  **Trial-run mode:** `trialRun: true` processes N files (setting, default 250) and
  produces the report the gate asks for — parse quality (text extracted vs empty),
  duplicate rate (strong-key hits + review suggestions per 100), cost per CV from
  `ai_usage_events` rows attributed via `withAiSubject` — without writing candidates;
  items are marked `skipped` after processing with results kept in the report.

### 3.2 Ongoing intake channels

Upload, mailbox, board webhook and API already funnel into `ingestCandidate` /
`submitApplicationImpl` (§1.7), and a scheduled pull already exists for job boards
(`/api/public/board-sync` → `pollAllBoards`, with its own idempotent event store) and
for other ATSs (`/api/public/sync-hrms`, the per-connection org-loop tick). A3's job
is rewiring, not inventing: every channel's insert step goes through the A1 identity
module and writes an A2 CV version (replacing today's lossy newest-CV-overwrites
semantics, intake.server.ts:354, with real history), each with its existing
idempotency key preserved (`providerMessageId`, board event store,
`externalProvider+externalId`). A per-tenant scheduled _file-drop_ pull (job-board
export CSV / SFTP-style) is the only genuinely new channel, reusing the sync-hrms
connection pattern with `safeFetch` for any user-supplied URL (AGENTS.md invariant)
and the same item pipeline as the archive import (hash → parse → identity → version →
claims); each connection carries its own schedule/cadence column (per-connection
cron expression or interval), satisfying row 4's "Channels, schedule" configurable
column. Rate limiter coverage for any new public route is added in src/server.ts in
the same PR. Incremental matching (new CV against open JDs) remains the sourcing
agent's remit with `roleMatchCheckedAt` as its cursor — A3 only guarantees every new
CV is matchable within minutes of intake (done-when of row 4); the matching engine
itself is C1.

## 4. C1 — matching engine (plan row 8), after A2 + B3 merge

Preliminary here; the score output contract is agreed with Developer 5 before any
code (hard rule).

- **Score against the consolidated profile, not one document** (plan §2b.4): each JD
  requirement is evidenced by claims across all versions; per-claim weight by evidence
  strength (demonstrated 1.0 / listed 0.5 / inferred 0.25 — starting values, tenant
  tunable later with row 8's `weights` setting), and a must-have backed only by a
  keyword in a JD-mirrored version earns partial credit _and_ surfaces the flag.
- **Sector factor** from the tenant taxonomy (D5/B3-adjacent; seeded default from
  `org-ontology.ts` domain packs until the configurable taxonomy lands).
- **POOL_MATCH constants become settings** (pool-match.server.ts:25: `recentDays` 7,
  `batch` 50, `minCoverage` 0.75, `maxPerRole` 5, `expansionTtlMs` 6 h) — moved into a
  tenant/workflow settings table with those values as defaults, plus a full-pool sweep
  per JD and incremental matching on new CVs. The sweep keeps `roleMatchCheckedAt`-style
  cursors per (JD, candidate) so both modes are idempotent.
- **No embeddings exist** (no pgvector anywhere); C1 stays coarse-then-rank SQL + code
  scoring, reusing the skills GIN index. Introducing vectors is an open question, not a
  dependency.
- **Output contract (to agree with D5):** per candidate × JD, a score row holding
  overall score plus a per-factor breakdown (skills-by-evidence, experience, sector,
  location/right-to-work, pay), each factor with its score, its weight, and evidence
  references as `{claimId, versionId, passage}` triples — so the C2 shortlist view can
  cite version and passage without re-deriving anything. Likely home: extend the
  `match_scores` jsonb columns (`customScores` already carries `{key, score, evidence}`)
  or a sibling `profile_match_scores` table; decided with D5 before building.
- Today's sweep never writes `match_scores` (it only inserts `pool_match` applications;
  scores come later from autoscore) — C1 must decide whether profile scores replace or
  sit beside that flow; also noted for the D5 conversation.

## 5. Test list

`scripts/*.test.ts` per the house convention:

**A1**

- normalisation: gmail dots/+tags, E.164 with and without default region, LinkedIn
  canonical forms, placeholder keys match only among themselves and never a real
  address (extends candidates-domain.test.ts:717);
- strong-key merge: same person, different email on the second CV → merged via phone/
  linkedin; `autoMergeStrongKeys` off → same hit produces a suggestion, and the
  newcomer's key row appears only after the decision;
- file hash: same file, same name → version attach; same file bytes, different name →
  review suggestion, never merge or attach; same file hash never creates a second
  candidate;
- phone strength: full-E.164 hit merges; last-10-digits-only hit goes to the review
  queue even when it is the only signal;
- fuzzy: same name + overlapping timeline → suggestion; same name, disjoint timeline →
  kept separate; tailored CVs of one person (timeline stable, text differs) → merged or
  suggestion, never two candidates;
- thresholds: high/low thresholds read from tenant settings, changed behaviour per
  tenant, defaults apply when unset; settings change writes
  `candidate.identity_settings_updated` with before/after;
- merge undo: absorbed row restored, children re-pointed back, **deleted child rows
  re-inserted with original ids/createdAt** (merge two candidates that each applied to
  the same requisition, undo, assert both applications exist again), audit rows written
  (`candidate.merge` for automatic intake merges too, `candidate.merge.undo`);
- review queue: decision transitions; pending suggestion flips `stale` in-transaction
  when a merge absorbs either side; erasure removes the pair row;
- concurrency: two simultaneous intakes of the same email → one candidate, one merge,
  via the key unique-violation retry;
- merged-row invisibility: a candidate with `mergedIntoId` set is excluded from the
  pool-match sweep, talent search, candidates list and duplicate clustering;
- cross-tenant isolation: identical keys in two orgs produce no suggestion and no
  merge; unassigned-pool rows never match org rows;
- public apply: strong or fuzzy hit never merges, never mutates the existing row and
  never attaches a version to it; the application links and a suggestion is enqueued
  on conflicting evidence.

**A2**

- version per upload with source/requisition; same-hash re-upload attaches, not
  duplicates; pool-scoped uploads create no version until org assignment, then the
  stored text becomes version 1;
- claims extraction: prompt carries `INJECTION_RULES` + `untrusted` CV; zod-validated
  shape; strength classification respected; ledger row written with the new slug and
  `candidateId` attribution (assert via `ai_usage_events`, never token estimates);
- consolidated profile: claim across two versions counts once with max strength and
  first-seen; timeline merge; fullest project description wins;
- flags: each of the five computed per §2.4 rules, including the single-source and
  JD-mirroring cases (threshold at the default 0.5); flags never alter scores or stages;
- erasure: candidate with versions + claims erased → zero rows, zero storage objects;
- erasure × merge: erasing the survivor or a tombstone deletes the `candidate_merges`
  rows and their `undoSnapshot` PII; no absorbed person's name/email/phone/CV text
  survives in any table;
- wire returns carry no `model`/`engine` fields.

**A3**

- queue mechanics: claim with skip-locked, lease reclaim, attempts/backoff, empty-text
  retryable vs permanently failed after max attempts;
- idempotent re-run: half-done import re-run → nothing duplicated (hash skips);
- spend cap reached → items deferred without burning attempts, resumed after;
- trial run: N files, report counts, no candidates written, **no staged bytes remain
  after terminal states** (per-item delete + import-prefix sweep);
- CSV failure list contents;
- per-item OCR path gated on the tenant setting.

**C1** (post-contract) — evidence weighting, sector factor, sweep idempotence, settings
override of every `POOL_MATCH` constant, ranking eval on seeded data.

## 6. Invariants touched (summary for the reviewer)

- `requireOrg` + explicit `eq(orgId, ctx.orgId)` on every new query; `assertRequisitionInOrg`
  before any version row references a client-supplied requisition (A2) — with the
  public apply path deriving org from the fetched requisition row, never from the
  client.
- AI only via `aiJson` with `untrusted()` + `INJECTION_RULES` and new `AI_FEATURES`
  slugs (`cv_claims_extract`, `cv_ocr`); ledger rows carry the candidate attribution;
  vendor/model names never on the wire or in UI copy (A2/A3).
- `writeAudit` on merges (including automatic strong-key merges at intake), undos,
  suggestion decisions and identity-settings changes (A1), and import lifecycle events
  (A3).
- Erasure completeness extended and tested, including the merge/undo-snapshot PII
  cases (A2).
- Rate-limit coverage for new public cron routes in src/server.ts (A3).
- No agent changes in A1–A3; if the sourcing agent's pool-match behaviour changes in
  C1, that lands with a version bump, `agents:lock` refresh, eval and health rules per
  AGENTS.md.

## 7. Milestone / PR plan

| PR        | Contains                                                                              | Gate                                        |
| --------- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| M0 (this) | this design note only                                                                 | reviewer sign-off                           |
| A1        | 0094 migration, identity module, review queue UI, intake paths switched, audit + undo | review + tests green                        |
| A2        | versions + claims tables, extraction, profile UI, erasure extension                   | review + eval sample                        |
| A3        | archive import job + UI + trial mode, scheduled-pull channel                          | 300-CV trial-run report                     |
| C1        | profile-based scoring, sector factor, full-pool sweep, settings                       | ranking eval; contract agreed with D5 first |

## 8. Open questions

1. **Placeholder emails:** settled for A1 — intake's deterministic
   `@no-email.atsiq.local` addresses (intake.server.ts:271) are keyed under the
   `placeholder` key type and match among themselves by equality, preserving today's
   email-less dedupe; they never match a real `email` key. `@import.local` has no
   producer in src (tests only) and stays handled in normalisation for compatibility.
   Still open: whether a placeholder-keyed candidate whose _real_ email arrives later
   should auto-merge with the placeholder record (today it never does — the new email
   is a different key) or enqueue a review suggestion. Leaning: review suggestion.
2. **Long CVs vs the 60 k `untrusted()` cap:** chunk at role boundaries and merge claim
   sets, or accept the 20 k slice `parseCv` already uses? Chunking doubles AI cost per
   long CV; decide after the trial-run cost report (A3).
3. **Survivor rules:** oldest-wins is today's convention; should the most complete
   record win instead (more fields filled, more versions)? Queue UI must show which
   side survives either way.
4. **Merge of application rows:** same-requisition duplicates are deleted today
   (unique index on (requisitionId, candidateId)); undo restores them — confirm product
   is happy that a post-undo application reappears with its original created date.
5. **Retention per version** (plan §2b.5): per-tenant days-based retention implies a
   reaper tick in A3; confirm the default (keep everything vs 24 months) with the
   product owner before A3.
6. **OCR scope:** is `cv_ocr` in A3 or deferred until a tenant actually ships scanned
   archives? Cost per scanned CV will drive adoption; the trial-run report should
   measure it either way.
7. **C1 contract items for the D5 conversation** (blocking C1 code, not A1–A3): new
   table vs `match_scores` extension; whether profile scores replace the autoscore
   flow for identification-mode tenants; exact factor list and weights schema; how
   knock-outs are represented.
8. **Sector taxonomy source for C1:** does the configurable taxonomy (plan row 8's
   `Sectors` setting) come from D5's track or is it D4's table? Assumed D5-adjacent;
   C1 consumes it either way.
