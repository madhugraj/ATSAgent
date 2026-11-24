# ATSIQ ↔ HRMS Integration Study

_Status: study / understanding document only — no code, no schema changes shipped yet._
_Date: 2026-09-29. Vendor facts verified against public developer portals and aggregator docs on this date._

This document studies how ATSIQ (our ATS) can integrate with external HRMS platforms —
ZingHR, Workday, Adrenalin, Darwinbox, Keka, greytHR and the aggregator services that
cover them — and proposes a connector architecture that fits the code we already have.

---

## 1. Why an ATS talks to an HRMS

An ATS owns the _pipeline_; an HRMS owns the _employee_. Integration is the handoff
between them. The concrete use cases, ranked by customer value:

| #   | Use case                                                                                                       | Direction      | Notes                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| UC1 | **On-hire push** — offer accepted → employee record created in HRMS (preboarding, ID, payroll master)          | ATS → HRMS     | The flagship. Every customer asks for this first.                                                                                            |
| UC2 | **Employee master sync** — interviewers, hiring managers, departments, locations, internal-mobility pool       | HRMS → ATS     | Feeds `requisitions.hiring_manager`, `departments`, and internal candidates (`candidates.is_internal`, `employee_id`, `current_department`). |
| UC3 | **Requisition / headcount sync** — approved position in HRMS opens a requisition in ATSIQ                      | HRMS → ATS     | Only feasible where the HRMS has position management (Workday; most Indian HRMS do not expose it via API).                                   |
| UC4 | **SSO + user provisioning** — SAML/OIDC login, SCIM joiner/leaver                                              | Identity       | Table stakes for enterprise; separate track from data sync.                                                                                  |
| UC5 | **Outbound events + public API** — let the _customer's own_ tools (HRMS scripts, BI, RPA) consume ATSIQ events | ATSIQ → anyone | Makes us an integration _platform_, not just a consumer.                                                                                     |
| UC6 | **Reporting / warehouse** — periodic full extracts                                                             | ATS → anywhere | Low priority; CSV export already covers most of it.                                                                                          |

UC1 and UC2 define the connector architecture. Everything else reuses it.

---

## 2. The four universal integration mechanisms

Every HRMS in the market exposes data through some mix of these. Any architecture we
build should treat them as pluggable transports, not vendor-specific one-offs:

1. **REST pull (polling)** — the dominant pattern in Indian HRMS. We poll `GET /employees`
   with a cursor / last-modified watermark. Simple, reliable, never real-time. greytHR,
   Keka (read), Workday (RaaS/REST) all support this.
2. **Push webhooks** — vendor POSTs events to our URL. Rare among Indian HRMS
   (Keka is the notable exception, with retry logs); Workday has limited webhook
   coverage. Where absent, polling with a 5–15 min cadence is the accepted substitute.
3. **File-based bulk** — CSV/XLSX over SFTP or manual upload (Workday EIB). The
   universal fallback; works with _every_ vendor including the ones with no API. Slow,
   but unbeatable as a first deliverable and as an escape hatch.
4. **Standard identity protocols** — SAML/OIDC SSO and SCIM provisioning. Independent
   of the data APIs; usually gated by the same partnership process.

**Reality check on Indian HRMS vendors:** ZingHR, Darwinbox and Adrenalin publish
_no public developer documentation_. Their APIs exist, are real, and are described by
reviewers as capable — but access is provisioned by their support/partnership teams,
usually per customer, sometimes under NDA. Any direct-connector plan for these three is
a _partnership project_, not a coding project. Workday, Keka and greytHR are the
opposite: documented, self-service-ish, buildable today.

---

## 3. Vendor-by-vendor deep dive

### 3.1 Workday (global enterprise standard)

| Aspect         | Detail                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API surface    | SOAP Web Services (WWS — the mature core, e.g. `Get_Workers`, staffing ops like `Hire_Employee`); REST API (JSON, OAuth 2.0) for a growing subset; **RaaS** (Report-as-a-Service — any custom report exposed as a REST endpoint returning XML/JSON/CSV); EIB + Document Transformation for bulk files; Workday Studio / Integration Cloud (Orchestrate) for in-tenant integrations |
| Auth           | OAuth 2.0 (registered API client: authorization-code, refresh-token, client-credentials/JWT grants); legacy basic auth over SOAP with an **Integration System User (ISU)** bound to an **Integration System Security Group (ISSG)** — the canonical ISV pattern                                                                                                                    |
| Webhooks       | Limited; event-driven work is normally done with Studio/Orchestrate subscriptions or RaaS polling                                                                                                                                                                                                                                                                                  |
| Docs access    | Public developer portal (developer.workday.com); tenant config is the customer's job                                                                                                                                                                                                                                                                                               |
| Effort profile | Highest of any vendor. Field mapping, security-domain permissions and ISU/ISSG setup are per-customer work, typically guided by a Workday partner                                                                                                                                                                                                                                  |

**Strategy for ATSIQ:** the pragmatic enterprise pattern for ISVs is _read via RaaS or
REST with an ISU service account_, not Studio development. We ask the customer to build
one custom report (workers + org assignment) and give us its URL; we poll it. On-hire
push to Workday is a phase-3 item — most Workday customers actually run Workday
Recruiting too, so ATSIQ↔Workday deals are more likely UC2 (org/interviewer sync) than UC1.

### 3.2 Keka (Indian HRMS, self-serve platform)

| Aspect         | Detail                                                                                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API surface    | Full developer portal (developers.keka.com) with OpenAPI specs: Employees, Groups/Departments/Locations/Job titles, Exits, **Preboarding**, and even a Keka **Hire** API (jobs, candidates, requisitions — they have their own ATS) plus Workflow APIs (BGV, assessments, e-sign) |
| Auth           | API-key → access-token grant (form-urlencoded, scoped), plus an OAuth code flow for marketplace apps with refresh tokens                                                                                                                                                          |
| Webhooks       | **Yes — native webhooks with retry/audit logs** — the only Indian HRMS of this set with a real push model                                                                                                                                                                         |
| Docs access    | Fully public, self-serve; partner marketplace for listing apps (self-serve portal replaced ~60-day hand-holding in 2023–25)                                                                                                                                                       |
| Effort profile | Lowest. This is the right _first_ connector                                                                                                                                                                                                                                       |

**Strategy:** build Keka both ways — employee/preboarding read+write for UC1/UC2, and
list in their marketplace later. Note the competitive wrinkle: Keka Hire is an ATS, so
on shared accounts we integrate alongside it, not instead of it.

### 3.3 greytHR (Indian payroll/HR incumbent)

| Aspect         | Detail                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API surface    | Public REST API v2 (api-docs.greythr.com) — employee CRUD, leave, attendance, salary structure endpoints; used in production by Tally, Celigo, Knit and BGV vendors |
| Auth           | Per-tenant **API users + API keys** created by the customer in their admin portal (My Account → API Users / API Details)                                            |
| Webhooks       | Not native — integration ecosystem is polling/middleware based                                                                                                      |
| Docs access    | Public docs + public Postman collections                                                                                                                            |
| Effort profile | Low — second connector after Keka                                                                                                                                   |

**Strategy:** polling connector for employee master (UC2) and employee-create push for
UC1. Because greytHR is payroll-centric, customers see it as the _destination_ for
hires — good fit for on-hire push.

### 3.4 Darwinbox (Indian enterprise HCM leader)

| Aspect         | Detail                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| API surface    | Real APIs exist (payroll implementation APIs, integrations documented case-by-case), but **no public developer portal** |
| Auth           | Partnership-provisioned credentials                                                                                     |
| Webhooks       | Via partner implementations only                                                                                        |
| Docs access    | Distributed through partner guides (Knit, Bindbee, SpringVerify, etc.) and implementation docs                          |
| Effort profile | Medium — gated by partnership, not by engineering                                                                       |

**Strategy:** (a) CSV import/export templates in P1 so Darwinbox customers get value on
day one; (b) open a partnership conversation for a direct connector; (c) consider Knit
(§4) which already maintains a Darwinbox connector.

### 3.5 ZingHR (SMB/mid-market, PeopleStrong group)

| Aspect         | Detail                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------- |
| API surface    | API exists (attendance, leave, employee data confirmed by integrators), **no public docs**        |
| Auth           | Credentials provisioned by ZingHR support/partnership; SSO available                              |
| Webhooks       | None public                                                                                       |
| Docs access    | Partnership only; covered as a live connector on Knit's unified HRIS API                          |
| Effort profile | Low value direct / medium via aggregator — ZingHR buyers are SMBs with lower integration appetite |

**Strategy:** CSV templates first; direct connector only if a paying customer demands it.

### 3.6 Adrenalin (Adrenalin e-HCM / Adrenalin Max — Advanced/Adrenalin eSystems)

| Aspect         | Detail                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| API surface    | Marketed as "completely API driven" (Adrenalin Max); REST API listed as a platform feature — but **no public developer docs indexed anywhere** |
| Auth           | Presumably API-key/OAuth, disclosed under NDA                                                                                                  |
| Webhooks       | Not documented publicly                                                                                                                        |
| Docs access    | Via vendor support/implementation teams only                                                                                                   |
| Effort profile | Partnership-gated, like Darwinbox                                                                                                              |

**Strategy:** same play as Darwinbox — CSV templates + partnership conversation; keep
the adapter slot warm so a spec, once obtained, is a 2–3 week build.

### 3.7 Others worth tracking

- **SAP SuccessFactors / Oracle HCM** — the Workday-tier enterprise peers; same
  patterns (SOAP/Compound Employee API, RaaS-like report extracts). Same phase-3 track.
- **BambooHR / Rippling / HiBob** — global SMB/mid-market with good public APIs;
  relevant only if/when we sell outside India.
- **Zoho People / Zoho Recruit** — public APIs, easy builds, low demand today.

### 3.8 Comparison matrix

| HRMS          | Public dev docs | Auth model           | Native webhooks      | Employee read        | Employee write (hire push)     | Direct-build feasibility   |
| ------------- | --------------- | -------------------- | -------------------- | -------------------- | ------------------------------ | -------------------------- |
| **Workday**   | ✅              | OAuth 2.0 / ISU+ISSG | Limited              | ✅ REST/SOAP/RaaS    | ✅ SOAP staffing ops (complex) | 🟡 High value, heavy build |
| **Keka**      | ✅              | API key→token, OAuth | ✅ (with retry logs) | ✅                   | ✅ (incl. preboarding API)     | 🟢 Best first connector    |
| **greytHR**   | ✅              | Per-tenant API keys  | ❌ (poll)            | ✅                   | ✅ (employee add/update)       | 🟢 Easy                    |
| **Darwinbox** | ❌              | Partnership          | ❌                   | via partnership      | via partnership                | 🟡 Partnership-gated       |
| **ZingHR**    | ❌              | Partnership          | ❌                   | via partnership/Knit | via partnership                | 🟡 Partnership-gated       |
| **Adrenalin** | ❌              | Partnership/NDA      | ❌                   | via partnership      | via partnership                | 🟡 Partnership-gated       |

---

## 4. The aggregator shortcut: unified HRIS APIs

A parallel industry exists precisely because the vendors above are hard: unified APIs
maintain the per-vendor connectors and expose one normalized schema.

| Provider                                            | Coverage                                                           | Model                                                                                          | Fit for us                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Merge.dev**                                       | 50+ HRIS (Workday, BambooHR, Rippling, Personio…)                  | Store-and-sync; Employee/Employment/Group common models; sync intervals + third-party webhooks | Strong for _global_ long tail; HRIS is their most mature category. Field coverage varies per provider — check their feature matrix before promising fields |
| **Finch**                                           | 200+ employment systems (Gusto, ADP, Workday…)                     | Employer-permissioned OAuth connection flow; read-first (directory, employment, payroll)       | Strong for payroll-adjacent reads; less suited to hire-push writes                                                                                         |
| **Knit**                                            | **Indian HRMS focus — live ZingHR, Darwinbox, greytHR connectors** | Unified HRIS API                                                                               | The only realistic fast path to ZingHR/Darwinbox data without a partnership                                                                                |
| **Bindbee / Truto / StackOne / Unified.to / Kombo** | Varying                                                            | Same idea                                                                                      | Alternatives; evaluate on per-connection pricing and India data residency                                                                                  |

**Trade-offs to weigh seriously:**

1. **Employee PII flows through a third party** — for Indian customers this raises
   DPDP Act 2023 and data-residency questions that a direct connector avoids. A DPIA is
   mandatory before we route employee master data through an aggregator.
2. **Per-connection pricing** compounds with customer count; direct connectors are
   marginal-cost-zero after the build.
3. **Field coverage is uneven** — the unified schema is the lowest common denominator;
   custom fields often drop out.
4. **Lock-in** — our data model would orient around theirs.

**Recommendation:** own direct connectors for the vendors with public APIs (Keka,
greytHR, Workday) — they are the flagship name-brands anyway — and evaluate Knit _only_
as the coverage play for partnership-gated Indian vendors, behind a DPIA and with
aggregator cost priced into the deal. CSV templates keep us vendor-neutral for everyone
else.

---

## 5. Recommended architecture for ATSIQ

The good news: the codebase already contains every primitive a connector framework
needs. Nothing below invents a new pattern — each piece mirrors something shipped.

### 5.1 What we already have (and will reuse)

| Existing primitive                                                                | Where                                                                                                                              | Role in HRMS integration                                                            |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `source_integrations` + `integration_credentials` (per-org, per-provider, unique) | `drizzle/schema.ts`, `src/lib/integrations.server.ts`                                                                              | Connection registry + encrypted secret store. `category` gains a new value `"hrms"` |
| AES-256-GCM `encryptSecret`/`decryptSecret`                                       | `src/server/crypto.ts`                                                                                                             | All HRMS credentials at rest                                                        |
| Outbox pattern (idempotency key, attempts, backoff, claim lease)                  | `email_outbox`, `src/lib/email-outbox.server.ts`                                                                                   | Template for both outbound webhook delivery and outbound HRMS write retries         |
| Cron routes authenticated by `authenticateCronRequest`                            | `src/routes/api/public/{inbox-sync,sync-candidates,process-email-outbox}.ts`, Cloud Scheduler per `infra/DEPLOYMENT-HANDOFF.md` §7 | Two new scheduled jobs (§5.4, §5.5)                                                 |
| Idempotent external upsert                                                        | `candidates.external_id` + `external_provider` partial-unique + `last_synced_at`/`sync_status`                                     | The sync xref pattern, generalized                                                  |
| Domain-event choke point                                                          | `src/lib/stage-events.server.ts` (immutable `stage_events`)                                                                        | Single hook where outbound events (stage change, hire) get emitted                  |
| SSRF-safe outbound HTTP                                                           | `src/server/safe-fetch.ts`                                                                                                         | Every adapter's outbound call                                                       |
| HMAC-signed OAuth state + public callback routes                                  | `src/lib/oauth-state.ts`, `src/routes/api/public/integrations/*/callback.ts`                                                       | Reused as-is if a vendor offers OAuth (Keka marketplace apps, Workday clients)      |
| Audit trail                                                                       | `writeAudit` (`src/server/audit.ts`)                                                                                               | Credential changes, connection create/revoke, key lifecycle                         |
| Rate limiter                                                                      | `src/server.ts` (sliding window on `/api/public/*` and `/_serverFn/*`)                                                             | Extended with per-API-key buckets for the public v1 API                             |

### 5.2 Connector framework

```
src/lib/hrms.functions.ts        # server fns for the Integrations UI (no src/server imports — import-protection rule)
src/server/hrms/
  types.ts                       # HrmsAdapter interface + normal Employee/Department/Requisition models
  adapters/
    keka.ts  greythr.ts  workday.ts  csv-sftp.ts
    unified-merge.ts  unified-knit.ts  unified-finch.ts
  sync-engine.server.ts          # run-sync orchestration, cursors, retries, audit
src/routes/api/public/sync-hrms.ts
src/routes/api/public/process-webhook-outbox.ts
```

Adapter interface (server-only; every outbound call via `safeFetch`):

```ts
interface HrmsAdapter {
  capabilities: {
    readEmployees: boolean;
    writeEmployee: boolean;
    readDepartments: boolean;
    webhooks: boolean;
  };
  testConnection(conn: Connection): Promise<TestResult>;
  listEmployees(conn: Connection, cursor?: string): Promise<Page<NormalEmployee>>;
  listDepartments?(conn: Connection): Promise<NormalDepartment[]>;
  createEmployee?(conn: Connection, hire: HirePayload): Promise<{ externalId: string }>;
}
```

Providers registered on `source_integrations` with `category = "hrms"`:
`keka`, `greythr`, `workday`, `darwinbox`, `zinghr`, `adrenalin`, `csv_sftp`,
`unified_merge`, `unified_knit`, `unified_finch`. The three aggregator adapters are one
generic OAuth adapter with different base URLs — near-zero marginal cost.

### 5.3 Data model (proposed, drizzle conventions: uuid PKs, `orgId` FK cascade, tz timestamps, jsonb bags)

| Table                   | Purpose                                      | Key columns                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hrms_sync_state`       | Per-connection, per-entity sync progress     | `integration_id` FK, `entity` (`employees`\|`departments`), `cursor` jsonb, `last_full_sync_at`, `last_run_status`, `last_error`, `stats` jsonb                                                                           |
| `hrms_employees`        | Normalized employee-master cache (read side) | `org_id`, `integration_id`, `external_id`, `full_name`, `email`, `department`, `location`, `job_title`, `manager_external_id`, `employment_status`, `raw` jsonb, `last_synced_at`; unique `(integration_id, external_id)` |
| `hrms_person_xref`      | Maps external people ↔ ATSIQ rows            | `org_id`, `integration_id`, `external_id`, `user_id?`, `candidate_id?`; unique per integration+external_id                                                                                                                |
| `hrms_field_mappings`   | Per-connection field mapping profile         | `integration_id`, `direction`, `mappings` jsonb (HRMS field → ATSIQ field / constant / script), custom-field bag                                                                                                          |
| `webhook_subscriptions` | Outbound ATSIQ events for customer tools     | `org_id`, `url` (https), `secret` (encrypted), `events` text[], `enabled`                                                                                                                                                 |
| `webhook_outbox`        | Delivery queue (mirror of `email_outbox`)    | `org_id`, `subscription_id`, `event`, `payload` jsonb, `idempotency_key` (unique), `status`, `attempts`, `last_error`, `available_at`, `delivered_at`                                                                     |
| `api_keys`              | Inbound public API keys                      | `org_id`, `name`, `key_hash` (sha-256), `key_prefix` (display), `scopes` text[], `created_by`, `last_used_at`, `revoked_at`                                                                                               |

Each schema change ships as an idempotent SQL file under `drizzle/pg-migrations/` and
`docs/er-diagram.md` regenerates — per AGENTS.md.

### 5.4 Sync flows

**Read (UC2, HRMS → ATSIQ):** new Cloud Scheduler job → `POST /api/public/sync-hrms`
(bearer cron secret, like `inbox-sync`) → for each enabled connection: adapter
`listEmployees(cursor)` → upsert into `hrms_employees` → maintain `hrms_person_xref` →
write `sync_status`/`last_synced_at`. Full sync on connect; incremental by
last-modified cursor where the vendor supports it (greytHR/Keka do; RaaS reports can be
built with an effective-date filter). Exits tombstone `employment_status = "terminated"`
— never delete, matching the `stage_events` immutability philosophy.

**Write (UC1, ATSIQ → HRMS):** when an application hits the hired/offer-accepted stage
(hook inside `stage-events.server.ts`), enqueue a hire payload to a new
`hrms_outbox`-style queue (or reuse `webhook_outbox` mechanics) → drained by cron with
attempts/backoff → adapter `createEmployee()` → record external id in xref. HR ops
confirm via the Integrations page sync log; failures surface as a health badge, never
silently.

**Outbound events (UC5):** `stage-events.server.ts` also enqueues to `webhook_outbox`
for enabled subscriptions; `POST /api/public/process-webhook-outbox` drains with the
same claim-lease/backoff discipline as the email outbox. Deliveries signed with
`X-Atsiq-Signature: sha256=<hmac(secret, body)>`; https-only destinations enforced via
the `safeFetch` guards.

**Inbound public API (UC5):** `/api/public/v1/{candidates,applications,requisitions}`
with `X-Api-Key` auth (hash lookup, scope check), per-key rate-limit buckets in
`src/server.ts`, `writeAudit` on every mutating call. This is what lets a customer's
HRMS _pull_ from us even without any connector work — and it unblocks RPA/BIPOC
customers immediately.

### 5.5 Security mapping (against AGENTS.md invariants)

| Invariant                                                | How the feature honors it                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requireOrg`/`requireRole` + explicit `orgId` predicates | Every connection/sync/subscription server fn scoped by `context.orgId`; adapter queries filtered by connection's org                                         |
| `assertRequisitionInOrg` before inserts                  | Unchanged for req-sync flows (UC3)                                                                                                                           |
| `safeFetch` for server-side outbound                     | Mandatory inside every adapter and webhook delivery — no raw `fetch`                                                                                         |
| Credentials encrypted                                    | HRMS tokens/keys live in `integration_credentials.secrets` / `webhook_subscriptions.secret` via `encryptSecret`; API keys stored hash-only                   |
| Audit on privileged actions                              | `writeAudit` on connection create/test/disconnect, API-key create/revoke, field-mapping changes, manual sync triggers                                        |
| Rate limiting on public surfaces                         | New `/api/public/v1/*` and webhook-drain routes covered by the `src/server.ts` limiter (per-key buckets for v1)                                              |
| AI vendor abstraction                                    | N/A here; note the analogous product rule we should adopt: HRMS vendor _credentials_ never leave the server; vendor names in UI are fine (unlike AI vendors) |

Import-protection constraint respected: `src/server/hrms/**` is server-only; the
Integrations UI talks to it exclusively through `*.functions.ts` server fns.

### 5.6 Sync semantics and conflict rules

- **System of record:** HRMS owns employee/org data; ATSIQ owns pipeline. On conflict,
  HRMS wins for employee fields, ATSIQ wins for pipeline fields. No bidirectional
  write-back on the same field — that's how sync systems die.
- **PII minimization:** pull only what UC1/UC2 need (identity, org assignment,
  employment status). Compensation fields stay in the HRMS unless a customer explicitly
  maps them; DPDP Act 2023 notice/consent posture is the customer's as employer, but our
  data minimization should reflect it.
- **Idempotency everywhere:** every write carries an idempotency key (outbox pattern
  already does this); every read upserts on `(integration_id, external_id)`.
- **Reconciliation:** nightly full-sync for employees (tables are small — org headcounts
  are hundreds to low thousands; a full pull is cheaper and safer than trusting cursors).

### 5.7 UI

New **HRMS** tab in `src/routes/integrations.tsx` alongside sourcing/meetings/emails/ai:
connection cards (reuse `IntegrationCard`), capability badges (read/write/webhooks),
connection test (existing `testIntegration` pattern), last-sync health, sync-log viewer,
field-mapping editor (start with a per-vendor default mapping + json override), and
webhook-subscription management for UC5.

---

## 6. Phased roadmap (rough, engineer-weeks, single dev)

| Phase                                  | Scope                                                                                                                                                                  | Effort                           | Dependency           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------- |
| **P0 — Foundations**                   | `"hrms"` category + connection model, adapter interface, sync engine + `sync-hrms` cron, `hrms_employees`/xref/mappings tables, Integrations HRMS tab with test+health | 3–4 wk                           | none                 |
| **P1 — Read connectors**               | Keka + greytHR employee/department sync (public APIs)                                                                                                                  | 2–3 wk                           | P0                   |
| **P2 — Outbound platform**             | `webhook_subscriptions`/`webhook_outbox` + drainer cron, `api_keys` + `/api/public/v1/*`, HMAC signing                                                                 | 2–3 wk                           | P0                   |
| **P3 — On-hire push**                  | `createEmployee` for Keka (incl. preboarding API) + greytHR; hire-stage hook in `stage-events.server.ts`                                                               | 2–3 wk                           | P1                   |
| **P4 — Workday**                       | OAuth client + RaaS/REST read adapter, per-customer ISU/ISSG setup guide; partnership application in parallel                                                          | 4–6 wk                           | P0; sales motion     |
| **P5 — Partnership-gated Indian HRMS** | CSV import/export templates (universal, ship anytime from P0); Darwinbox/ZingHR/Adrenalin direct adapters as specs arrive; evaluate Knit behind a DPIA                 | 1–2 wk (CSV) + per-vendor 2–3 wk | vendor conversations |
| **P6 — SSO/SCIM**                      | SAML/OIDC + SCIM provisioning                                                                                                                                          | separate track                   | demand-driven        |

The deliberate sequencing: P0+P1 make us demonstrably integrated with two named Indian
vendors in ~6 weeks; P2 turns integration into a platform story; P3 closes the flagship
on-hire loop; P4–P5 are where partnership calendars dominate, so they start in parallel
with sales conversations, not before them.

---

## 7. Risks and open questions

**Risks**

1. **Partnership latency** (Darwinbox/ZingHR/Adrenalin) — API specs arrive on vendor
   timelines; CSV templates and the unified-API option are the hedge.
2. **Per-customer config burden** on Workday (ISU/ISSG, report design) — needs a written
   customer setup guide and possibly a paid integration service tier.
3. **PII through aggregators** — DPIA + data-residency review before Knit/Merge carry
   employee master data.
4. **Rate limits and API churn** on vendor APIs — adapters must centralize retry/backoff
   and pin API versions per provider.
5. **Support surface** — every connector adds a failure mode a customer will blame on
   us; the sync-log viewer and health badges are not optional polish, they're the support
   deflection layer.

**Open questions (for product)**

1. Which use case leads the pitch — on-hire push (UC1) or interviewer/org sync (UC2)?
   (Determines whether P1 targets read-first or we jump straight to Keka write.)
2. Do we pursue Keka marketplace listing (requires their OAuth app flow) early for
   distribution, or stay API-key-only initially?
3. Is there a paying customer anchored to a specific HRMS? That decides P5 ordering.
4. For `/api/public/v1/*` (UC5): do we commit to a versioned public API contract now
   (with its changelog/deprecation obligations), or ship webhooks only in P2?

---

## 8. Sources

- Workday: developer.workday.com (ISU/ISSG auth, Build program), workday.com
  (Integration Cloud/Orchestrate); Rollout and Portable.io Workday API guides
- Keka: developers.keka.com (API reference, authentication, webhooks + retry logs,
  llms.txt index), keka.com marketplace pages
- greytHR: api-docs.greythr.com (API v2), greythr.com help-center (API users/keys),
  Postman community collection, Celigo greytHR connector docs
- Darwinbox: darwinbox.com; Knit and Bindbee integration guides; SpringVerify
  integration notes
- ZingHR: Knit unified-API connector listing (getknit.dev); SaaSworthy/Slashdot
  capability listings
- Adrenalin: myadrenalin.com; GetApp/Slashdot listings (API-driven HCM claims)
- Unified APIs: docs.merge.dev (HRIS common models, per-integration feature matrix);
  Finch via Jentic/Explorium/Bindbee writeups; getknit.dev evaluation guides
