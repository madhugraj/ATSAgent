# Guardrails

How the ATS keeps its AI features and hiring agents safe: what each control does,
where it lives in the code, how it is tested, and what is still open.

- **Audience:** engineers, security reviewers, and the people who answer customer
  security questionnaires.
- **Threat reference:** _ATS Agent System Threat Landscape v2.0_ (OWASP Top 10 for
  Agentic Applications alignment). Section 4 maps each of its nine attack vectors
  and six mitigations to the controls here.
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
                         [L6 Egress: safeFetch]          [L7 Cost: budgets, limits]   [L8 Audit, health, ledger]
```

---

## 3. Controls by layer

### L1. Intake and document parsing

| Control                             | Where                       | Detail                                                                                                                                                                |
| ----------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File-type allow-list                | `src/lib/cv-text.server.ts` | `.pdf`, `.docx`, `.txt`, `.rtf` only.                                                                                                                                 |
| Size caps                           | same                        | Upload limit is 15 MB. PDFs over 30 pages yield no text. A `.docx` whose XML expands past 20 MB yields no text (zip-bomb guard).                                      |
| No active content                   | same                        | PDF text comes from pdf.js `getTextContent` (text only; no scripts, forms or macros run). A `.docx` is unzipped and only its XML text is read. Nothing is executed.   |
| CVs are text-only to the model      | intake / matching           | A CV image is never sent to a vision model, so instructions hidden in pixels never reach scoring.                                                                     |
| Two-signal injection flag at intake | `src/lib/intake.server.ts`  | `candidates.suspected_prompt_injection` is set by **either** the parser model's own flag **or** the deterministic tripwire (`looksLikeInjection`) on the raw CV text. |

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

| Control                  | Where                                         | Detail                                                                                                                                                                                                                                                              |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zod `schema` on `aiJson` | gateway                                       | Model JSON is validated. On failure the model is re-asked once with the errors; if it fails again, the call returns 502 and nothing is stored.                                                                                                                      |
| CV scorer schema         | `ScoreAiSchema`, `src/lib/matching.server.ts` | Lenient but safe: a bad or missing field becomes 0 or empty (never a high score). Unknown keys are dropped. Scores are clamped to 0–100. The weighted overall score is computed in TypeScript, not by the model.                                                    |
| Injection hold on scores | same + `src/lib/autoscore.server.ts`          | `injection_suspected` = scorer flag OR tripwire on the CV/profile text. When set, a risk flag is added, `recommendation` is never `select`, the candidate's flag is saved, and auto-scoring holds them at `ai_screened` (they never auto-advance to `shortlisted`). |
| Agent tool arguments     | runtime                                       | Every tool call is checked by the tool's zod input before anything runs. Bad arguments go back to the model as an error.                                                                                                                                            |

### L4. Agent runtime (the hiring agents)

| Control                  | Where                                             | Detail                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest                 | `src/server/agents/definitions.ts`, `registry.ts` | Each agent has a versioned contract: owner, responsibility, must-never list, scope, gates, risk tier, evals, tools. Every run records the manifest version and hash it ran under. CI fails if a manifest changes without a version bump (`scripts/agents.lock.json`).                                                                     |
| Tool allow-list          | runtime `handleCall`                              | An agent can call only the tools its manifest lists. Unknown tools are refused.                                                                                                                                                                                                                                                           |
| Gate-verb ban            | `registry.ts` `isGateToolName`                    | A tool named approve, approval, release, reject, hire, revoke, decline or accept **cannot be registered**. Agents use `propose_` / `request_` / `submit_` tools instead.                                                                                                                                                                  |
| Risk and autonomy policy | `src/server/agents/policy.ts` `decideToolCall`    | `read` runs. `write` asks the user in _Suggest_ mode. `external` asks unless the organisation pre-approved that template (_Act and notify_) or chose _Autonomous_. Job-board posts run only at Autonomous on a pre-approved board. External actions without a template always ask. Agents are off until an organisation switches them on. |
| **Taint**                | `policy.ts` + `runtime.server.ts` `runTainted`    | Once any step of a run has returned outside text that tripped the tripwire, **every later write or external action in that run waits for a person**, whatever the autonomy level or whitelist. Reads still run. The approval card opens with a system-written warning (`TAINT_NOTE`).                                                     |
| Proposals never run      | runtime                                           | A `proposes` tool only opens a person's decision. Its `run` is never called.                                                                                                                                                                                                                                                              |
| Human-in-the-loop tools  | `src/server/agents/hitl.ts`                       | `ask_human`, `request_approval` (typed subjects with UUIDs), `handoff`. The approver role comes from where the item sits in its approval chain, not from the agent.                                                                                                                                                                       |
| System-stated facts      | `brief`, `precheck` on tools                      | The approval card states facts the system computed (times, amounts, recipients). Prechecks refuse pointless or repeated calls before anyone is asked.                                                                                                                                                                                     |
| Server-built gates       | `gateFor` / `performGate`                         | Approval transitions and trails are built on the server with `assertRole`. The client and the agent never supply status logic or trail entries.                                                                                                                                                                                           |
| Run limits               | `RUN_LIMITS`                                      | Per stretch of work between two human decisions: up to 60 model steps and 1M tokens (organisations can tune these within bounds). A hard ceiling of 4 stretches. Each step returns at most 8,192 output tokens and times out after 120 s. Each agent has a monthly token budget.                                                          |
| Single-subject work      | autoscore loop, run subjects                      | Each CV is scored in its own AI call. Agents keep no long-term memory between runs. Older tool results are shortened in what the model re-reads, but stay intact in the run trail.                                                                                                                                                        |
| Prompt confidentiality   | agent register, wire returns                      | Prompts live only on the server. The agent register (with prompts) is visible to governance roles only (HR head, CBO). Vendor and model names are removed from every response sent to the browser. The voice charter forbids revealing instructions.                                                                                      |

### L5. Server cores and tenant isolation

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

### L7. Cost and denial of wallet

- **Bring your own key, strictly.** Each organisation uses its own AI key. There is
  no platform fallback key, so one tenant can never spend another tenant's (or the
  vendor's) budget.
- **Input caps:** file size, page count, zip-bomb limit and the 60,000-character
  fence cap (L1, L2).
- **Agent caps:** per-stretch step and token limits, the stretch ceiling, the monthly
  agent budget (an over-budget run pauses), per-step output cap and timeouts (L4).
- **Rate limits:** a 60-requests-per-minute sliding window per caller on public
  routes and on each server function (`src/server.ts`).
- **Ledger:** every provider request writes a row to `ai_usage_events` with the
  tokens the provider reported (never estimated), tied to the agent run and the
  candidate or requisition.

### L8. Audit, monitoring and data handling

- `writeAudit` (`src/server/audit.ts`) records privileged actions, agent writes and
  external actions (`agent.tool.<name>`, actor `agent:<type>:<runId>`), suspected
  injections (`agent.injection.suspected`) and human decisions.
- Health rules (`src/server/agents/health.server.ts`) include `tools.injection`,
  which counts suspected injections per agent over 24 hours and becomes "serious"
  past a threshold. Tool error rates, budgets, missing assessments and similar
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
  `scripts/guardrails.test.ts` and the scripted red-team evals.
- Agent manifest lock (`bun run agents:lock`): any change to an agent's instructions
  or tools must bump its version.

---

## 4. Threat-by-threat status

Threats are from _ATS Agent System Threat Landscape v2.0_. ✅ = covered,
◐ = partly covered (open item in §5).

| #   | Attack vector                                                                    | Status                      | How it is handled                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Indirect prompt injection** (hidden "rate me top" text in a CV)                | ✅ text · ◐ hidden PDF text | Hardened fence and `INJECTION_RULES`. Model flag plus tripwire at intake and at scoring. A flagged candidate is never `select` and never auto-advances. Humans make every decision. **Open:** text hidden in a PDF (white-on-white, micro-font, off-page) is still extracted (P1-1).                                               |
| 2   | **Tool abuse and hijacking** (CV makes the agent email data out or purge rivals) | ✅                          | No delete, purge or fetch tools. Gate-verb ban. Tool allow-list per manifest. Recipients looked up by ID. Taint holds every write and external action after a tripwire hit. Every agent write is audited.                                                                                                                          |
| 3   | **Context and memory poisoning** (mid-batch corruption)                          | ✅                          | One CV per AI call. No long-term agent memory. Manifests are version-locked. Within a run, taint contains a poisoned tool result.                                                                                                                                                                                                  |
| 4   | **System prompt extraction**                                                     | ✅ · ◐ free text            | Prompts stay on the server. Register is governance-only. Outputs are schema-shaped. Vendor and model names are removed. Voice charter forbids revealing instructions. Tripwire catches "reveal your system prompt". **Open:** free-text fields (such as `rationale`) are not checked for echoed prompt text (P1-5).                |
| 5   | **Multimodal injection** (instructions hidden in images or certificates)         | ✅                          | CVs never go to a vision model. Onboarding and scanned org documents use `INJECTION_RULES`, a schema and the flag, and their result only opens a person's validation. Vision output never feeds scoring.                                                                                                                           |
| 6   | **Supply chain**                                                                 | ◐                           | Frozen lockfile, high-severity audit gate, gitleaks, trusted-only install scripts, no third-party prompt libraries or plugins, scraping only through `safeFetch`. **Open:** Actions pinned by SHA, automated update PRs, SBOM and image provenance (P2-3).                                                                         |
| 7   | **Knowledge-base / RAG poisoning** (an insider rewrites reference files)         | ◐                           | Org profile is versioned, draft → approved by the HR head or an owner. Rule-breaking items are refused. Tripwire flag on every save. Audited. In scoring, the profile is fenced and never replaces stated requirements. **Open:** two-person rule (author ≠ approver), and watching for score drift after a profile change (P1-3). |
| 8   | **Cascading hallucinations** (one agent's error triggers a contract)             | ✅                          | Agents never trust each other for decisions. Offer amounts are band-checked on the server. Approval chains are built on the server with `assertRole`. Release is human only. Approval cards state system-computed facts.                                                                                                           |
| 9   | **Denial of wallet**                                                             | ◐                           | BYO key, input caps, agent step, token and monthly budgets, output caps, timeouts, rate limits, ledger. **Open:** an organisation-wide AI spend cap covering non-agent features such as bulk scoring (P1-2), and rate limiting shared across instances (P2-2).                                                                     |

| Mitigation (from v2.0)       | Status | Implementation                                                                                                                                     |
| ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dual-LLM pipeline            | ◐      | The intake parser is a separate structured step. The scorer still sees fenced raw text; hidden-text stripping (P1-1) narrows this further.         |
| Principle of least agency    | ✅     | L4 and L5: allow-list, gate-verb ban, acting as the user, no delete or fetch, recipients by ID, taint.                                             |
| Deterministic sandboxing     | ◐      | No active content is executed (L1). **Open:** parsing in an isolated container with no network (P2-1).                                             |
| Outbound egress controls     | ◐      | No agent fetch tool, `safeFetch`, recipients by ID. **Open:** firewall on Cloud Run outbound traffic (P2-1).                                       |
| Human-in-the-loop validation | ✅     | Every gate is human. Taint forces approval. Server-built trails. Step-up re-authentication for offer release and bulk rejection is planned (P2-4). |
| Rigid schema enforcement     | ✅     | zod on every structured AI output, including the CV scorer.                                                                                        |

---

## 5. Open items (roadmap)

**P1 — next**

1. **Hidden-text stripping in PDF extraction.** Drop text that is invisible, tiny or
   off-page. Record a `hidden_text` flag that holds the candidate like an injection
   flag. Set pdf.js `isEvalSupported: false` as an extra safeguard.
2. **Organisation-wide monthly AI spend cap** enforced in the gateway from the
   `ai_usage_events` ledger, plus a daily intake cap per requisition.
3. **Two-person rule** for org-profile and knowledge edits (author ≠ approver), and a
   check for score distribution drift after a profile change.
4. **Live red-team eval run** against each organisation's configured model before
   enabling Autonomous (the scripted versions already run in CI).
5. **Prompt-echo check** on free-text model fields (refuse output that quotes system
   prompt lines).

**P2 — infrastructure**

1. Parse documents in a separate Cloud Run job with no outbound network. Send Cloud
   Run outbound traffic through a VPC (private network) with a firewall that allows
   only the AI provider and mail endpoints.
2. Shared rate limiting (Redis or Cloud Armor) so limits hold across all server
   instances.
3. Pin GitHub Actions by commit SHA, turn on Renovate or Dependabot, and produce an
   SBOM and image provenance in `deploy.yml`.
4. Step-up re-authentication (recent sign-in or passkey) for offer release and bulk
   rejection.

---

## 6. How it is verified

| Suite                                                                    | What it proves                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/guardrails.test.ts`                                             | 12 fence-escape variants are stripped. Ordinary CV text is untouched. Invisible characters and labels are sanitised. The 60,000-character cap holds. The tripwire fires on attacks and stays quiet on normal CV phrasing. Taint policy. Scorer schema fallbacks.                                                 |
| `scripts/agent-runtime.test.ts`                                          | Third-party output is fenced. A tainted run holds a write at _Act and notify_ with the warning on the card. Reads still run. The autonomy matrix, including taint.                                                                                                                                               |
| `scripts/agent-eval.test.ts` (scenarios in `scripts/evals/scenarios.ts`) | Red-team scenarios: "instructions inside a CV are ignored", "a CV cannot close the untrusted fence", and "a hijacked run cannot send": the scripted model obeys the injection, and the email is still held and never runs (`neverRuns`). A mutation check confirms this scenario fails if taint is switched off. |
| `scripts/agent-governance.test.ts`                                       | Manifest change control, traceability, budget, audit.                                                                                                                                                                                                                                                            |
| `scripts/agent-health.test.ts`                                           | Health rules, including `tools.injection`.                                                                                                                                                                                                                                                                       |
| `scripts/agent-phase5.test.ts`                                           | Tripwire patterns.                                                                                                                                                                                                                                                                                               |

Run locally against a disposable database:

```bash
DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/guardrails.test.ts scripts/agent-runtime.test.ts scripts/agent-eval.test.ts
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
