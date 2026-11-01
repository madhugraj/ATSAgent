# Guardrails

How the ATS keeps its AI features and hiring agents safe: what each control does,
where it lives in the code, how it is tested, and what is still open.

- **Audience:** engineers, security reviewers, and the people who answer customer
  security questionnaires.
- **Threat reference:** _ATS Agent System Threat Landscape v2.0_ (OWASP Top 10 for
  Agentic Applications alignment). Section 4 maps each of its nine attack vectors
  and six mitigations to the controls here.
- **Red team:** `docs/red-team.md` covers how these controls are attacked and tested.
- **Rule for changes:** the "Security invariants" in `AGENTS.md` are binding. This
  document explains them. If the two ever disagree, `AGENTS.md` wins, and this file
  gets fixed in the same change.

Last updated 2026-11-01.

---

## 1. Principles

1. **The model never decides.** An AI may read, draft, score and propose. Approving,
   rejecting, releasing, hiring, revoking, declining and accepting are always done
   by a named person, through the same server functions that person uses in the
   app.
2. **Outside text is data, never instructions.** CVs, profiles, mail, transcripts,
   web pages and uploaded documents reach a model only inside a fence. The system
   prompt tells the model to ignore anything inside the fence that reads like an
   instruction.
3. **Defence in depth, not model obedience.** Every protection that matters is
   enforced in code: tool lists, the gate-verb ban, schemas, recipients looked up by
   ID, taint holds, role checks and org predicates. These hold even if a model is
   fully hijacked.
4. **Least agency.** An agent sees only the tools in its manifest. It acts with the
   permissions of the person it works for. It cannot delete or fetch, and it cannot
   choose who receives a message.
5. **Everything is attributable.** Every AI call, tool step, approval and privileged
   action is logged with the organisation, the run, and the person or agent behind
   it.

---

## 2. Layers at a glance

```
 Untrusted input ─► [L1 Intake & parsing] ─► [L2 Fence + rules] ─► MODEL ─► [L3 Schema validation]
                                                                         │
                                                                         ▼
                                    [L4 Agent runtime: tool allow-list · risk/autonomy policy
                                     · taint · gate-verb ban · proposals · HITL]
                                                                         │
                                                                         ▼
                [L5 Server cores: requireOrg/assertRole · orgId predicates · recipients by ID]
                                                                         │
                                  ┌──────────────────────────────────────┼──────────────────┐
                                  ▼                                      ▼                  ▼
                         [L6 Egress: safeFetch · parser sandbox]          [L7 Cost: budgets, limits]   [L8 Audit, health, ledger]
```

---

## 3. Controls by layer

### L1. Intake and document parsing

| Control                             | Where                                                                                                                | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File-type allow-list                | `src/lib/cv-text.server.ts`                                                                                          | `.pdf`, `.docx`, `.txt`, `.rtf` only.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Size caps                           | same                                                                                                                 | Upload limit is 15 MB. PDFs over 30 pages yield no text. A `.docx` whose XML expands past 20 MB yields no text (zip-bomb guard).                                                                                                                                                                                                                                                                                                                                         |
| No active content                   | same                                                                                                                 | PDF text comes from pdf.js `getTextContent` (text only; no scripts, forms or macros run). pdf.js 6 has no eval path for fonts. A `.docx` is unzipped and only its XML text is read. Nothing is executed.                                                                                                                                                                                                                                                                 |
| **Hidden text removed**             | `src/lib/document-hidden-text.ts`, used by the server (`cv-text.server.ts`) and browser (`cv-extract.ts`) extractors | Text a reader cannot see is dropped: white or near-white on a plain page, under 3 pt, PDF invisible or clip render modes, off the page, and hidden, white or tiny Word runs. One line, `[Hidden text removed from this document: N characters]`, replaces it, so reviewers see it and the tripwire flags the candidate. The hidden words never reach a prompt. **Kept:** white text on a coloured shape or image (banners), and the invisible OCR layer of a scanned CV. |
| Public apply page                   | `src/lib/apply.functions.ts`                                                                                         | No sign-in, and the CV text comes from the applicant's browser. It is fenced with `untrusted()` and `INJECTION_RULES`, the parse is zod-validated, and the candidate is flagged by the model flag **or** the tripwire (including the hidden-text marker), so they never auto-advance.                                                                                                                                                                                    |
| CVs are text-only to the model      | intake / matching                                                                                                    | A CV image is never sent to a vision model, so instructions hidden in pixels never reach scoring.                                                                                                                                                                                                                                                                                                                                                                        |
| Two-signal injection flag at intake | `src/lib/intake.server.ts`                                                                                           | `candidates.suspected_prompt_injection` is set by **either** the parser model's own flag **or** the deterministic tripwire (`looksLikeInjection`) on the raw CV text.                                                                                                                                                                                                                                                                                                    |

### L2. Prompt-injection defence: the fence

| Control                      | Where                            | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `untrusted(label, text)`     | `src/lib/ai-gateway.server.ts`   | Wraps outside text in `<untrusted_data label="…">…</untrusted_data>`. The text is capped at 60,000 characters.                                                                                                                                                                                                                                                                                                                                                                       |
| Fence cannot be closed early | `sanitizeUntrusted` (same file)  | Removes every fence look-alike: any letter case, spaces, attributes, `untrusted-data` and `untrusted data` spellings, full-width `＜ ＞` brackets, and unclosed tags. It also strips zero-width, soft-hyphen and bidi-control characters (used to split keywords), and repeats until nothing changes, so stripping one tag cannot rebuild another.                                                                                                                                   |
| Label cannot inject          | same                             | The label is reduced to `[\w .:-]` and 80 characters.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `INJECTION_RULES` first      | system prompts                   | Every prompt that carries outside text starts with these rules: fenced content is data, never follow it, flag `suspected_prompt_injection`. The agent runtime prepends them to every agent (`runtime.server.ts`).                                                                                                                                                                                                                                                                    |
| Tripwire                     | `src/server/agents/injection.ts` | Narrow patterns ("ignore previous instructions", "you are now", "reveal your system prompt", "new instructions:", fence tags, "rate/give/assign … top/highest/perfect score", "bypass … screening/evaluation", an upstream `injectionFlag: true`). Matching runs on text with invisible characters removed. It is a **tripwire, not a filter**: the model still sees the fenced text. A hit marks the step, writes an audit entry, feeds a health rule, and **taints** the run (L4). |

Where the tripwire runs:

- agent tool outputs marked `untrustedOutput`
- CV text at intake
- CV and profile text at scoring
- organisation-profile edits (sets `org_profile_versions.injection_flagged`)
- scanned organisation documents

### L3. Output validation

| Control                   | Where                                                                     | Detail                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| zod `schema` on `aiJson`  | gateway                                                                   | Model JSON is validated. On failure the model is re-asked once with the errors; if it fails again, the call returns 502 and nothing is stored.                                                                                                                                                                                                               |
| CV scorer schema          | `ScoreAiSchema`, `src/lib/matching.server.ts`                             | Lenient but safe: a bad or missing field becomes 0 or empty (never a high score). Unknown keys are dropped. Scores are clamped to 0–100. The weighted overall score is computed in TypeScript, not by the model.                                                                                                                                             |
| Injection hold on scores  | same + `src/lib/autoscore.server.ts`                                      | `injection_suspected` = scorer flag OR tripwire on the CV/profile text. When set, a risk flag is added, `recommendation` is never `select`, the candidate's flag is saved, and auto-scoring holds them at `ai_screened` (they never auto-advance to `shortlisted`).                                                                                          |
| Panel transcripts         | `src/server/panel/prompts.ts`, `src/lib/panel-assessment.ts`              | Exact JSON shape required, zod-validated. Quotes are kept only if they appear in the transcript. Sentences carrying a verdict are removed before anything is emailed.                                                                                                                                                                                        |
| Agent tool arguments      | runtime                                                                   | Every tool call is checked by the tool's zod input before anything runs. Bad arguments go back to the model as an error.                                                                                                                                                                                                                                     |
| **Prompt-echo redaction** | `src/lib/prompt-echo.ts`, applied in the gateway to every `aiJson` result | Any string in the model's JSON that repeats 10 or more consecutive words of the system prompt's instructions is replaced with `[removed: this text repeated the system's instructions]` before any caller sees it, and logged (`ai.prompt_echo.redacted`). Fenced data inside a system prompt is excluded, so quoting the JD or CV as evidence is untouched. |

### L4. Agent runtime (the hiring agents)

| Control                                  | Where                                             | Detail                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest                                 | `src/server/agents/definitions.ts`, `registry.ts` | Each agent has a versioned contract: owner, responsibility, must-never list, scope, gates, risk tier, evals, tools. Every run records the manifest version and hash it ran under. CI fails if a manifest changes without a version bump (`scripts/agents.lock.json`).                                                                     |
| Tool allow-list                          | runtime `handleCall`                              | An agent can call only the tools its manifest lists. Unknown tools are refused.                                                                                                                                                                                                                                                           |
| Gate-verb ban                            | `registry.ts` `isGateToolName`                    | A tool named approve, approval, release, reject, hire, revoke, decline or accept **cannot be registered**. Agents use `propose_` / `request_` / `submit_` tools instead.                                                                                                                                                                  |
| Risk and autonomy policy                 | `src/server/agents/policy.ts` `decideToolCall`    | `read` runs. `write` asks the user in _Suggest_ mode. `external` asks unless the organisation pre-approved that template (_Act and notify_) or chose _Autonomous_. Job-board posts run only at Autonomous on a pre-approved board. External actions without a template always ask. Agents are off until an organisation switches them on. |
| **Taint**                                | `policy.ts` + `runtime.server.ts` `runTainted`    | Once any step of a run has returned outside text that tripped the tripwire, **every later write or external action in that run waits for a person**, whatever the autonomy level or whitelist. Reads still run. The approval card opens with a system-written warning (`TAINT_NOTE`).                                                     |
| Proposals never run                      | runtime                                           | A `proposes` tool only opens a person's decision. Its `run` is never called.                                                                                                                                                                                                                                                              |
| Human-in-the-loop tools                  | `src/server/agents/hitl.ts`                       | `ask_human`, `request_approval` (typed subjects with UUIDs), `handoff`. The approver role comes from where the item sits in its approval chain, not from the agent.                                                                                                                                                                       |
| System-stated facts                      | `brief`, `precheck` on tools                      | The approval card states facts the system computed (times, amounts, recipients). Prechecks refuse pointless or repeated calls before anyone is asked.                                                                                                                                                                                     |
| Server-built gates                       | `gateFor` / `performGate`                         | Approval transitions and trails are built on the server with `assertRole`. The client and the agent never supply status logic or trail entries.                                                                                                                                                                                           |
| **Model safety check before Autonomous** | `src/server/redteam/`, `saveAgentPolicy`          | Switching an agent **to Autonomous** is refused on the server unless the organisation's current model passed the red-team probes in the last 30 days (`docs/red-team.md` §4). Health rule `harness.autonomous_unverified` flags Autonomous agents left without a current pass.                                                            |
| Run limits                               | `RUN_LIMITS`                                      | Per stretch of work between two human decisions: up to 60 model steps and 1M tokens (organisations can tune these within bounds). A hard ceiling of 4 stretches. Each step returns at most 8,192 output tokens and times out after 120 s. Each agent has a monthly token budget.                                                          |
| Single-subject work                      | autoscore loop, run subjects                      | Each CV is scored in its own AI call. Agents keep no long-term memory between runs. Older tool results are shortened in what the model re-reads, but stay intact in the run trail.                                                                                                                                                        |
| Prompt confidentiality                   | agent register, wire returns                      | Prompts live only on the server. The agent register (with prompts) is visible to governance roles only (HR head, CBO). Vendor and model names are removed from every response sent to the browser. The voice charter forbids revealing instructions.                                                                                      |

### L5. Server cores and tenant isolation

- **Step-up re-authentication** (`src/server/step-up.ts`, migration 0066):
  - These actions need the person to have re-entered their password in this
    session within 10 minutes: releasing an offer, rejecting several candidates
    at once, and approving an agent's offer release or rejection batch in the
    inbox.
  - The check runs in the server-function handlers. The browser shows a password
    dialog and retries the action (`withStepUp`).
  - Confirmations are audited (`auth.step_up`). Wrong passwords are audited
    (`auth.step_up_failed`), and five within 15 minutes lock step-up.

- Every tenant-scoped server function uses `requireOrg` / `requireRole` /
  `requireOrgOwner` / `requirePlatformAdmin` (`src/lib/auth.middleware.ts`). Every
  query carries `eq(table.orgId, context.orgId)`. There is no row-level security,
  so this is the boundary.
- Agent tools wrap the same lifecycle cores and run as the run's human user, so role
  checks and org filters apply exactly as they do for that person.
- `requisitionId`s supplied by the client pass `assertRequisitionInOrg`
  (`src/server/guards.ts`) before any insert that references them.
- **Recipients are looked up by ID.** Outbound tools take record IDs (an application,
  negotiation or offer) and the server resolves who receives the message. An agent
  can never type an email address. Pay messages always need the HR head's approval,
  and the HR head may edit them.
- Offer amounts are checked against the requisition's approved band on the server
  (`draft_offer`).
- **Two-person rule on the organisation profile** (`twoPersonCheck`,
  `src/lib/org-profile.server.ts`). Everyone who started, edited (from the audit
  trail) or submitted a version is barred from approving it while another owner
  or HR head exists. A one-person organisation may self-approve, recorded as
  `selfApproved`. Health rule `context.score_drift` flags an average CV score that
  moves 10+ points in the 14 days after an approval, and is serious when the
  version was self-approved.

### L6. Egress

- Agents have **no fetch, browse or HTTP tool**.
- Server-side fetches of user-supplied URLs go through `safeFetch` /
  `safeFetchText` (`src/server/safe-fetch.ts`):
  - http/https only
  - DNS is resolved, and private, loopback, link-local and metadata ranges are
    blocked, with the resolved IP pinned (protects against DNS rebinding)
  - every redirect is re-checked
  - 10 s timeout and 512 KB response cap by default
  - only allowed methods are used
- AI provider calls go only through the gateway (`aiJson`, `aiResearchJson`,
  `aiAgentStep`). Nothing calls provider REST endpoints directly.
- **Sandboxed document parsing** (`src/server/parser/`, `infra/network/parser-sandbox.sh`):
  - With `PARSER_URL` set (production), every uploaded, mailed or captured document
    is parsed by the `atsiq-parser` Cloud Run service, never in the app's process.
  - That service runs from the same image (`.output/parser-worker/index.mjs`), with
    Direct VPC egress into a network that has **no NAT and a deny-all egress
    firewall**. It has a service account with no roles and no secrets beyond its
    token, IAM-only invocation by the app's service account, one document per
    instance, and a 30 s parse limit (the instance exits on timeout).
  - If the parser is unreachable, the document yields no text (fail closed).
  - Text extracted in the applicant's own browser (public apply, bulk upload) is
    re-checked on the server (L1, L2).
- **Main app egress** is not allow-listed: the app must reach customer websites
  and profile links (through `safeFetch`, which blocks private and metadata
  ranges), AI providers, mail, meeting providers and job boards. A stricter
  per-destination policy would need an egress proxy (`docs/red-team.md` §7).

### L7. Cost and denial of wallet

- **Bring your own key, strictly.** Each organisation uses its own AI key. There is
  no platform fallback key, so one tenant can never spend another tenant's (or the
  vendor's) budget.
- **Input caps:** file size, page count, zip-bomb limit and the 60,000-character
  fence cap (L1, L2).
- **Agent caps:** per-stretch step and token limits, the stretch ceiling, the monthly
  agent budget (an over-budget run pauses), per-step output cap and timeouts (L4).
- **Organisation spend limits** (`src/server/ai-spend-cap.ts`, migration 0064, set in
  Integrations → AI model settings by the HR head, audited `ai.limits.save`):
  - a **monthly token cap** across every AI feature (scoring, agents, research,
    voice), counted from the ledger. At the cap the gateway refuses new requests
    with a vendor-neutral 429 before contacting the provider;
  - a **daily cap on automatic CV scorings per role**. Applications over it wait
    for the next day.
- **Rate limits** (`src/server/rate-limit.ts`): 60 requests per minute per caller
  on public routes and on each server function. With `RATE_LIMIT_STORE=postgres`
  (production) the limit is **shared across every instance** through the UNLOGGED
  `rate_limit_hits` table (a sliding-window counter, migration 0066). A database
  error falls back to the per-instance window rather than blocking traffic.
- **Ledger:** every provider request writes a row to `ai_usage_events` with the
  tokens the provider reported (never estimated), tied to the agent run and the
  candidate or requisition.

### L8. Audit, monitoring and data handling

- `writeAudit` (`src/server/audit.ts`) records privileged actions, agent writes and
  external actions (`agent.tool.<name>`, actor `agent:<type>:<runId>`), suspected
  injections (`agent.injection.suspected`) and human decisions.
- Health rules (`src/server/agents/health.server.ts`) include `tools.injection`,
  which counts suspected injections per agent over 24 hours and becomes "serious"
  past a threshold. `harness.autonomous_unverified` flags Autonomous agents with no
  current model safety check, and `context.score_drift` flags score shifts after a
  profile approval. Tool error rates, budgets, missing assessments and similar
  failures each have their own rule.
- OpenTelemetry spans carry `atsagent.injection_suspected`.
- Credentials are encrypted at rest with AES-256-GCM (`src/server/crypto.ts`).
- Training-data capture (`captureFeedback`) needs the organisation's consent,
  never blocks the work, and is linked to the candidate so erasure cascades.

### L9. Supply chain and CI (`.github/workflows/ci.yml`)

- `bun install --frozen-lockfile`. Bun runs lifecycle install scripts only for
  explicitly trusted dependencies.
- `bun audit --audit-level=high` blocks the build.
- `gitleaks` scans for committed secrets.
- Typecheck, lint, migrations, and the agent and guardrail test suites, including
  `scripts/guardrails.test.ts`, `hidden-text`, `guardrails-p1`, `redteam-check`
  and the scripted red-team evals (`docs/red-team.md`).
- Agent manifest lock (`bun run agents:lock`): any change to an agent's instructions
  or tools must bump its version.
- **Pinned and attested:**
  - Every GitHub Action is pinned by commit SHA, and the base images by digest.
  - Dependabot (`.github/dependabot.yml`) proposes bun, Actions and Docker
    updates weekly as PRs that go through full CI.
  - The CI token is read-only.
  - The deploy builds with BuildKit and attaches an **SBOM** (SPDX) and **SLSA
    provenance** (max mode) to the image. It deploys by digest and keeps the SBOM
    as a 90-day workflow artifact.

---

## 4. Threat-by-threat status

Threats are from _ATS Agent System Threat Landscape v2.0_. ✅ = covered,
◐ = partly covered (open item in §5).

| #   | Attack vector                                                                    | Status | How it is handled                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Indirect prompt injection** (hidden "rate me top" text in a CV)                | ✅     | Hardened fence and `INJECTION_RULES`. Model flag plus tripwire at intake, at scoring and on the public apply page. Hidden PDF and Word text is removed and the candidate flagged. A flagged candidate is never `select` and never auto-advances. Humans make every decision. Red-team probes: `direct_override`, `fence_escape`, `multilingual`, `authority_claim`. **Open:** the tripwire is English-only. |
| 2   | **Tool abuse and hijacking** (CV makes the agent email data out or purge rivals) | ✅     | No delete, purge or fetch tools. Gate-verb ban. Tool allow-list per manifest. Recipients looked up by ID. Taint holds every write and external action after a tripwire hit. Every agent write is audited.                                                                                                                                                                                                   |
| 3   | **Context and memory poisoning** (mid-batch corruption)                          | ✅     | One CV per AI call. No long-term agent memory. Manifests are version-locked. Within a run, taint contains a poisoned tool result.                                                                                                                                                                                                                                                                           |
| 4   | **System prompt extraction**                                                     | ✅     | Prompts stay on the server. Register is governance-only. Outputs are schema-shaped and **echo-redacted** (10+ words of instructions are replaced). Vendor and model names are removed. Voice charter forbids revealing instructions. Tripwire catches "reveal your system prompt". Probe `prompt_extraction`.                                                                                               |
| 5   | **Multimodal injection** (instructions hidden in images or certificates)         | ✅     | CVs never go to a vision model. Onboarding and scanned org documents use `INJECTION_RULES`, a schema and the flag, and their result only opens a person's validation. Vision output never feeds scoring.                                                                                                                                                                                                    |
| 6   | **Supply chain**                                                                 | ✅     | Frozen lockfile, high-severity audit gate, gitleaks, trusted-only install scripts. Actions pinned by SHA and base images by digest. Dependabot. Read-only CI token. SBOM and SLSA provenance attached to every deployed image, deployed by digest. No third-party prompt libraries or plugins. Scraping only through `safeFetch`.                                                                           |
| 7   | **Knowledge-base / RAG poisoning** (an insider rewrites reference files)         | ✅     | Org profile is versioned, draft → approved. **Two-person rule:** the author cannot approve while another approver exists. Score drift after an approval is flagged. Rule-breaking items are refused. Tripwire flag on every save. Audited. In scoring, the profile is fenced and never replaces stated requirements.                                                                                        |
| 8   | **Cascading hallucinations** (one agent's error triggers a contract)             | ✅     | Agents never trust each other for decisions. Offer amounts are band-checked on the server. Approval chains are built on the server with `assertRole`. Release is human only. Approval cards state system-computed facts.                                                                                                                                                                                    |
| 9   | **Denial of wallet**                                                             | ✅     | BYO key. Input caps. Agent step, token and monthly budgets. Organisation-wide monthly token cap in the gateway. Daily scoring cap per role. Output caps, timeouts, ledger. **Rate limits shared across instances** (Postgres-backed). A 30 s parse limit in the sandbox.                                                                                                                                    |

| Mitigation (from v2.0)       | Status     | Implementation                                                                                                                                                                                                                                  |
| ---------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dual-LLM pipeline            | ◐          | The intake parser is a separate structured step. Hidden text is removed before any model sees the CV. The scorer still sees fenced raw visible text.                                                                                            |
| Principle of least agency    | ✅         | L4 and L5: allow-list, gate-verb ban, acting as the user, no delete or fetch, recipients by ID, taint.                                                                                                                                          |
| Deterministic sandboxing     | ✅         | Documents are parsed in the `atsiq-parser` service: no egress, no roles, IAM-only, one document per instance, a time limit, and fail closed (L6). Hidden text is removed there.                                                                 |
| Outbound egress controls     | ✅ · ◐ app | The processing instance (parser) has no route out. Agents have no fetch tool. Recipients come by ID. `safeFetch` blocks private and metadata ranges. **Open:** a per-destination allow-list for the main app needs an egress proxy.             |
| Human-in-the-loop validation | ✅         | Every gate is human. Taint forces approval. Autonomous needs a passed model safety check. Server-built trails. **Step-up:** offer release and bulk rejection (by hand or approved from the inbox) need a password re-entered within 10 minutes. |
| Rigid schema enforcement     | ✅         | zod on every structured AI output, including the CV scorer.                                                                                                                                                                                     |

---

## 5. Open items (roadmap)

**P1 — shipped (2026-11-01)**

1. Hidden-text stripping in PDF and Word extraction (L1). pdf.js 6 has no eval path,
   so `isEvalSupported` no longer exists to switch off.
2. Organisation-wide monthly AI token cap and daily scoring cap per role (L7).
3. Two-person rule for the organisation profile, and the score-drift health rule (L5).
4. Model safety check required before Autonomous (L4, `docs/red-team.md` §4).
5. Prompt-echo redaction on model JSON (L3).
6. Found along the way: the public apply page sent CV text to the model unfenced
   and never saved the injection flag. It is now fenced, validated and flagged (L1).

**Next (from `docs/red-team.md` §7)**

1. A multilingual and encoding-aware tripwire (NFKC, confusables, non-English
   patterns).
2. A generated cross-tenant sweep test over every tenant server function.
3. Tests for `safeFetch` (SSRF) and for the document size and bomb caps.
4. A scheduled weekly live red-team run against the default models.

**P2 — shipped (2026-11-01)**

1. Sandboxed document parser with no egress (L6). Turn it on with
   `infra/network/parser-sandbox.sh` and `PARSER_ENABLED=true`.
2. Rate limiting shared across instances through Postgres (L7). Production sets
   `RATE_LIMIT_STORE=postgres`.
3. Actions pinned by SHA, base images by digest, Dependabot, a read-only CI
   token, and SBOM and provenance on every image (L9).
4. Step-up re-authentication for offer release and bulk rejection (L5).

---

## 6. How it is verified

| Suite                                                                    | What it proves                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/guardrails.test.ts`                                             | 12 fence-escape variants are stripped. Ordinary CV text is untouched. Invisible characters and labels are sanitised. The 60,000-character cap holds. The tripwire fires on attacks and stays quiet on normal CV phrasing. Taint policy. Scorer schema fallbacks.                                                 |
| `scripts/agent-runtime.test.ts`                                          | Third-party output is fenced. A tainted run holds a write at _Act and notify_ with the warning on the card. Reads still run. The autonomy matrix, including taint.                                                                                                                                               |
| `scripts/agent-eval.test.ts` (scenarios in `scripts/evals/scenarios.ts`) | Red-team scenarios: "instructions inside a CV are ignored", "a CV cannot close the untrusted fence", and "a hijacked run cannot send": the scripted model obeys the injection, and the email is still held and never runs (`neverRuns`). A mutation check confirms this scenario fails if taint is switched off. |
| `scripts/agent-governance.test.ts`                                       | Manifest change control, traceability, budget, audit.                                                                                                                                                                                                                                                            |
| `scripts/agent-health.test.ts`                                           | Health rules, including `tools.injection`.                                                                                                                                                                                                                                                                       |
| `scripts/panel-assessment.test.ts`, `scripts/agent-phase5.test.ts`       | Transcript fencing and the injection flag. Tripwire patterns.                                                                                                                                                                                                                                                    |
| `scripts/hidden-text.test.ts`                                            | White, near-white, 1-pt and invisible PDF text, and hidden, white and tiny Word runs, are removed and marked. Banners and scanned-CV OCR layers are kept (mutation-checked).                                                                                                                                     |
| `scripts/guardrails-p1.test.ts`                                          | At the monthly cap, JSON and agent calls are refused before any provider request. Test-model calls are not capped. The daily scoring count is per application. The public apply page flags injected and hidden-text CVs.                                                                                         |
| `scripts/redteam-check.test.ts`                                          | Every probe runs fenced, with `INJECTION_RULES`, on the `redteam_probe` ledger feature. A pass is tied to the model and expires. One complied or failed probe fails the check. Reruns are throttled.                                                                                                             |
| `scripts/org-profile.test.ts`                                            | Two-person rule, including editors known only from the audit trail, and self-approval in a one-person organisation.                                                                                                                                                                                              |
| `scripts/rate-limit.test.ts`                                             | The per-instance window. The sliding estimate. Two separate processes sharing one Postgres-backed limit (40 + 20 of 60 allowed). Different callers have separate budgets.                                                                                                                                        |
| `scripts/step-up.test.ts`                                                | Refused without a recent password. The right password unlocks only that session, for 10 minutes. Another user's session never counts. Wrong passwords are audited and lock after five.                                                                                                                           |
| `scripts/parser-sandbox.test.ts`                                         | The worker runs as a separate process and the app parses through it, with hidden text removed there. A wrong token or an unreachable parser yields no text, never an in-process fallback. Oversize bodies get 413.                                                                                               |

Run locally against a disposable database:

```bash
DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/guardrails.test.ts scripts/hidden-text.test.ts scripts/guardrails-p1.test.ts scripts/redteam-check.test.ts scripts/rate-limit.test.ts scripts/step-up.test.ts scripts/parser-sandbox.test.ts scripts/agent-runtime.test.ts scripts/agent-eval.test.ts
```

---

## 7. Checklist for new code

- [ ] Outside text goes into a prompt only through `untrusted(...)`, with
      `INJECTION_RULES` first in the system prompt.
- [ ] Structured AI output has a zod `schema` on the `aiJson` call, and bad fields
      fall back to the _conservative_ value.
- [ ] Output that is candidate-controlled and can move a candidate respects
      `suspectedPromptInjection` / `injection_suspected`.
- [ ] Every AI call goes through the gateway with a `feature` slug from `AI_FEATURES`.
- [ ] A new agent tool: correct `risk`; `untrustedOutput: true` if it returns outside
      text; recipients looked up by ID; no gate verbs; `skills` declared; manifest
      version bumped and `bun run agents:lock` run; at least one eval.
- [ ] A new failure mode has a health rule and a test.
- [ ] A user-supplied URL is fetched only through `safeFetch`.
- [ ] Tenant queries carry an `orgId` predicate. Privileged actions call `writeAudit`.
- [ ] No vendor or model names leave the server.
- [ ] A new place where outside text enters a prompt adds a red-team case
      (`docs/red-team.md`).
