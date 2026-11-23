# Verification Report — ATSIQ release validation

**Current release date:** 2026-09-22  
**Architecture under test:** PostgreSQL + Drizzle, first-party cookie sessions, S3-compatible private storage and organisation-owned AI credentials.  
**Status:** RELEASE BLOCKED. On 2026-09-22 at approximately 22:13 UTC, the integration test was invoked without the required disposable database override and its cleanup targeted the configured remote database. The run was stopped after the cleanup failed during fixture creation. No publication is permitted until point-in-time recovery is completed and data counts are reconciled.

## Release incident and containment

- Pre-test known business counts: 73 candidates, 33 requisitions and 80 applications.
- Immediate post-incident counts: 0 candidates, 0 requisitions and 0 applications; the interrupted fixture left 2 test organisations and 2 test users.
- Containment: release work and publishing stopped; no further stateful checks are permitted against the affected database.
- Prevention: the destructive integration suite now rejects every database hostname except `127.0.0.1`, `localhost` and `::1` before its cleanup statement.
- Recovery requirement: restore the database to the latest point immediately before 2026-09-22 22:13 UTC, then reconcile organisation, membership, user, candidate, requisition, application, offer, interview and audit counts before resuming release validation.

## F. Browser-layer round (P2-browser, second verification pass)

| #   | Check                                                                                                                                                                                             | Result                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 26  | `bunx tsc --noEmit` after all 13 browser files converted (data.ts, dedupe, cv-intake, 9 routes + 6 new/extended function files)                                                                   | ✅ PASS                                                                 |
| 27  | Browser supabase-client import surface reduced to P3 scope only: `src/integrations/supabase/client.ts` + `AuthGate.tsx` + `AppShell.tsx` / `OrgGate.tsx` / `OnboardingWizard.tsx` (sign-out only) | ✅                                                                      |
| 28  | `supabaseAdmin`/`context.supabase` anywhere in `src/`                                                                                                                                             | ✅ 0 hits (only the not-yet-deleted `client.server.ts` definition file) |
| 29  | ESLint on all touched files — non-prettier issues: only the 12 pre-existing `no-explicit-any` in original code                                                                                    | ✅                                                                      |
| 30  | Integration suite re-run on fresh scratch DB                                                                                                                                                      | ✅ 16 pass, 0 fail                                                      |
| 31  | Dev-server smoke on plain Postgres: `/`, `/candidates`, `/requisitions`, `/matching`, `/offers`, `/privacy` all HTTP 200; boot log contains **zero** Supabase references                          | ✅                                                                      |

**Conversion summary:** `data.ts` 19 queries → 18 org-scoped server fns in `queries.functions.ts` (snake_case + ISO-date wire shape preserved via `snakeRow` mapper); `dedupe.ts` merge flow → server-side `mergeCandidatesFn`; `cv-intake.ts` → `saveCv` (both callers authenticated; anonymous apply already used `submitApplication`); 9 routes' mutations → 24 server fns across `requisitions.functions.ts` (new), `offers.functions.ts` (new), `matching.functions.ts`, `interviews.functions.ts`, `candidates.functions.ts`, `integrations.functions.ts`, `master.functions.ts` (new). Multi-row social-profile upserts use the real unique-index conflict target; JD versioning computed org-scoped server-side.

## A. Static gates (round 1)

## A. Static gates

| #   | Check                                                                          | Result                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `bunx tsc --noEmit` (whole project, strict)                                    | ✅ PASS (exit 0)                                                                                                                                                                                                                                                   |
| 2   | ESLint on the 35 migration-touched files                                       | ✅ PASS — only pre-existing issues remain: ~17 `no-explicit-any` in `social.server.ts`/`verification.server.ts` (original code pattern), 2 `react-hooks/rules-of-hooks` errors in `matching.tsx` (pre-existing route code). Prettier applied to touched files only |
| 3   | `supabaseAdmin\|context\.supabase\|client\.server` in `src/lib` + `src/routes` | ✅ 0 hits                                                                                                                                                                                                                                                          |
| 4   | `git ls-files public/` — extension zip untracked                               | ✅ only `favicon.png`, `robots.txt`                                                                                                                                                                                                                                |
| 5   | `.env` still public-values-only                                                | ✅ publishable key + URLs only                                                                                                                                                                                                                                     |

## B. Schema integrity (disposable DB, dropped after)

| #   | Check                                                                                                                                                                                                                                                   | Result                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 6   | Fresh DB + `0000_baseline.sql` with `ON_ERROR_STOP=1`                                                                                                                                                                                                   | ✅ 125 statements, 0 errors       |
| 7   | `drizzle-kit push` round-trip vs applied DB                                                                                                                                                                                                             | ✅ "No changes detected" (exit 0) |
| 8   | **Runtime DB smoke** (`scripts/verify-db.ts` via real `src/server/db.ts`): users/orgs/org_members insert-select, column defaults, unique(org,email) enforcement, authz query shape (role miss/hit), FK cascade on user delete, FK cascade on org delete | ✅ 7/7 PASS                       |

## C. Integration tests (`scripts/integration.verify.test.ts`, bun test — 16 tests)

| #   | Check                                                                                                                                                                  | Result |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 9   | `activeOrgOf`: first-active-membership, null when none, ignores disabled                                                                                               | ✅ 3/3 |
| 10  | `assertRole`: owner passes without role row; granted role passes; wrong role throws                                                                                    | ✅     |
| 11  | **C2**: second public apply with same email must NOT overwrite record (name/phone preserved, `merged: true`)                                                           | ✅     |
| 12  | **C2**: same email in another org → separate candidate (no cross-org leak)                                                                                             | ✅     |
| 13  | Unapproved requisition rejects applications                                                                                                                            | ✅     |
| 14  | Capture token: valid resolves / short+garbage null / **archived org rejected**                                                                                         | ✅     |
| 15  | **Capture full flow without LLM keys**: files candidate with correct org/source, logs `capture_events`, detail shows "verification needs retry" (graceful degradation) | ✅     |
| 16  | Insufficient text → `skipped`; invalid token → error, DB untouched                                                                                                     | ✅     |
| 17  | **H4**: `storeResumeFile` without S3 env returns clean error, no throw, path-traversal filename neutralised                                                            | ✅     |

`16 pass, 0 fail, 37 expect() calls` (397 ms). The two error-looking console traces during the run are the intended graceful-degradation paths (LLM absent, vault unconfigured), not failures.

## D. Live server E2E (`bun run dev` on :8080 against scratch DB)

| #   | Check                                                                                                                                    | Result |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 18  | `GET /` → 200 with `Content-Security-Policy: frame-ancestors 'self'; object-src 'none'; base-uri 'self'` + `X-Frame-Options: SAMEORIGIN` | ✅     |
| 19  | `GET /privacy` → 200 (SSR through new server entry)                                                                                      | ✅     |
| 20  | `POST /api/public/capture` bogus token → JSON `{"status":"error","detail":"This capture key is not valid any more."}` with CORS headers  | ✅     |
| 21  | Rate limit: burst of 65 → first 60 pass (422 invalid-token), remainder **429**; window saturated afterwards                              | ✅     |

## Deployment notes discovered during testing

1. **postgres.js does not accept libpq-style `?host=/tmp` URL params** — it forwards them as startup parameters and Postgres rejects them (`unrecognized configuration parameter "host"`). Client deployments must use plain TCP URLs (`postgresql://user@host:5432/db`) — goes in the P6 deployment guide.
2. `drizzle/pg-migrations` emits a benign identifier-truncation NOTICE for the long `integration_credentials` FK name — cosmetic.

## Current architecture confirmation

- Browser business-data reads and mutations use TanStack server functions backed by Drizzle and PostgreSQL.
- Sign-in uses first-party password verification and a database-backed `atsiq_session` HttpOnly cookie.
- Tenant operations use organisation middleware plus explicit `orgId` query predicates; PostgreSQL row-level security is not treated as the application boundary.
- AI work requires the active organisation's encrypted Gemini, OpenAI or Claude credential. No platform key is substituted.
- Privileged role, tenant and credential changes write to the central audit log.
- The labelled `test_roi_cohort` contains 50 accepted-offer application records created only to validate RoI analytics; it is excluded from claims about production hiring outcomes.

## Environment-dependent checks

- Live AI quality and quota behaviour require a test organisation's own provider key.
- Sending email, creating Google Meet/Microsoft Teams/Zoom meetings, and LinkedIn/Naukri/Indeed operations require valid provider approvals and credentials.
- Destructive organisation, membership, offer and merge scenarios run only against a disposable database fixture.
- The in-process rate limiter is instance-local; a shared limiter is required before horizontally scaling public write traffic.

## Historical migration evidence

The checks above sections A–F are retained as the migration baseline from 2026-09-12. References there to pending P2–P6 work describe that historical test round and are superseded by the current architecture confirmation in this report.

---

## Addendum — 2026-09-28 verification round (AI usage ledger, vendor abstraction, candidate emails, password policy)

Scope: the 2026-09-27/28 feature set — candidate email outbox (11c13e7), enterprise password policy (6ff14c4), AI usage ledger + platform AI-usage console + vendor/model abstraction (df1139c). This round was run against the disposable local stack (`scripts/local-e2e/local-dev.sh`: PostgreSQL on 127.0.0.1:54333, dev server on 127.0.0.1:8080) and does not lift the release-blocked status above, which remains tied to the 2026-09-22 production-data incident.

| #   | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Result  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A1  | `bun run typecheck` (strict, whole project)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ✅ PASS |
| A2  | `bun run build` (production build; regenerates route tree incl. `/platform-ai-usage`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | ✅ PASS |
| A3  | `node scripts/migrate-pg.mjs` applies `0015_ai_usage_events.sql` + `0016_scrub_model_ids.sql`; second run reports "database is up to date" (idempotency)                                                                                                                                                                                                                                                                                                                                                                                                                                      | ✅ PASS |
| A4  | `ai_usage_events` shape verified in psql: columns, four indexes, FKs to organizations (cascade) and users (set null)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | ✅ PASS |
| A5  | Migration `0016` scrub tested transactionally: `"Auto-shortlisted … 87/100 (gemini-2.5-flash) — prompt-injection flag held"` → model id removed, suffix intact, double-space avoided; idempotent (0 rows on re-run); rolled back, no residue                                                                                                                                                                                                                                                                                                                                                  | ✅ PASS |
| A6  | Dashboard aggregate SQL exercised with seeded rows in a rolled-back transaction: totals/errors/avg-latency/org counts, per-feature, per-org, per-model, `date_trunc` daily series                                                                                                                                                                                                                                                                                                                                                                                                             | ✅ PASS |
| B1  | Browser round (`/tmp/atsiq-e2e/abstraction-usage-e2e.mjs`, playwright-core headless Chrome) — **10/10 PASS**: landing (logged out) has zero vendor-name hits and shows the neutral copy; /catalogue (super admin) zero hits with neutral BYO wording; /help zero hits; `/platform-ai-usage` renders totals/charts/tables/log for the super admin with the "AI usage" nav entry; nav entry hidden and page locked ("Super-user access only") for an org owner; response-payload scan on /matching + /candidates as org owner found no `model`/`engine` strings outside integrations/auth calls | ✅ PASS |
| B2  | Populated-data visual check: seeded 63 ledger rows, screenshotted `/platform-ai-usage` (stat tiles, stacked daily tokens, tokens-by-module bars, org/model tables, error badges, pagination), then deleted the synthetic rows                                                                                                                                                                                                                                                                                                                                                                 | ✅ PASS |
| C1  | In-app manual refreshed: Integrations described as four tabs (Candidate sources, Interview meetings, Candidate emails, AI model) with a candidate-email toggles step; password-policy step added to sign-in/recovery                                                                                                                                                                                                                                                                                                                                                                          | ✅ PASS |

Known limits of this round:

- Live token harvesting (`include_usage` for OpenAI, Anthropic `message_start`/`message_delta` frames, Gemini `usageMetadata`) was not exercised against real provider keys — the local fixture has none. The code paths are typed, unit of truth is the gateway, and the no-key path correctly logs nothing. First production run with a valid organisation key should confirm non-zero token counts per provider in `/platform-ai-usage`.
- Candidate email delivery was verified in the earlier e2e round (see `/tmp/atsiq-e2e/email-e2e-*.mjs` history); this round only re-verified documentation and settings surfaces.
