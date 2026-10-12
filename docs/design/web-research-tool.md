# Design: web research tool (Bright Data)

Status: **approved for a proof of concept (phases 1–2)** — decisions recorded in §10 · Author: platform team · Date: 2026-10-12

## 1. Summary

Give the hiring agents a governed way to search the public web and read public
pages, using Bright Data's SERP and page APIs with each organisation's own key.
It strengthens what already exists (market pay research, company context) and
removes our dependence on one AI vendor for web search. It is **not** a way to
collect candidate profiles: job boards and professional networks stay on their
official APIs (the Naukri adapter, LinkedIn), and anything that would defeat a
site's protections where its terms forbid automated access is out of scope.

Decisions needed from you are in §10.

## 2. What we have today

| Need                                         | How it works now                                                                                                               | Gap                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Web search for market pay                    | The model's own grounded search (`aiResearchJson`, Gemini Google Search grounding; `grounded` flag on the ledger)              | Only on Gemini; organisations on OpenAI or Anthropic get no live search; results and sources are whatever the model chose |
| Reading pay pages                            | `src/lib/market.server.ts` deep-links a vetted list of publishers (`QUALITY_DOMAINS`) and fetches them through `safeFetchText` | Some publishers block server-side fetches ("pages we cannot fetch server-side"); those sources silently drop out          |
| Company context for requisitions and JDs     | Model knowledge plus what the person types                                                                                     | No live company facts (size, funding, recent news)                                                                        |
| Candidate-supplied links (portfolio, GitHub) | `safeFetch`                                                                                                                    | Works for most; dynamic pages return little                                                                               |

## 3. Goals and non-goals

**Goals**

1. Live web search that does not depend on the AI vendor, with sources we can
   show and audit.
2. Reliable reads of **public** pages on an approved list of publishers.
3. Every request attributed, priced and capped like AI spend (hiring cost per
   candidate and per role includes it).
4. The same safety rules as all third-party text: untrusted, injection-fenced,
   size-capped.

**Non-goals (will not be built)**

- Scraping candidate profiles from job boards or professional networks
  (Naukri / Resdex, LinkedIn, Indeed, foundit, Instahyre, …). Those sources are
  licensed databases of personal data; they are used only through official
  APIs under the customer's own contract.
- Defeating CAPTCHAs, logins or bot protection on sites whose terms prohibit
  automated access. "Unblocking" is used only on publishers on the approved
  list (§5.3), which are reviewed for terms first.
- Browser automation (form filling, clicking through sites) and the
  "ask ChatGPT / Perplexity" tools.
- The MCP server itself inside the product (see §5.1).

## 4. Use cases (in priority order)

1. **Market pay research** (Requisition agent, Offer agent, Salary benchmark):
   search results for the role × location × level, then read the approved pay
   publishers that `safeFetch` cannot reach today.
2. **Company context** (Requisition and JD agents): the hiring organisation's and
   competitors' public pages for size, locations, products, recent news — to
   improve JDs and sell the role.
3. **Competitor hiring signals** (Sourcing agent): which companies are hiring for
   the same role in the same city (public job listings pages on company career
   sites, not job-board candidate data).
4. **Candidate-supplied links** (Intake agent; phase 3, opt-in): read a portfolio
   or public repository the candidate gave us. No search about the candidate.

## 5. Design

### 5.1 Integration: Bright Data's REST APIs, not the MCP server

The MCP server is built for interactive clients (desktop assistants, coding
agents): it hands a model 32 tools and lets it roam. Inside the product we
need the opposite — a few narrow tools under our own tool registry, gates,
audit, cost ledger and training capture. So the server module calls Bright
Data's HTTP APIs directly:

- **SERP API** — search engine results as structured JSON.
- **Page fetch (Web Unlocker / scrape as Markdown)** — one URL in, Markdown out.

New module `src/server/web-research/` with one client (`brightdata.server.ts`)
behind a small interface (`search(query, opts)`, `readPage(url, opts)`) so the
provider can be swapped (or replaced by our own crawler) without touching the
agents.

### 5.2 Credentials and switch-on

- New integration provider `brightdata` in `source_integrations`, its API
  token in `integration_credentials`, encrypted with `encryptSecret` — the same
  bring-your-own-key model as AI providers. **No platform key**: one tenant
  never spends another's (or our) quota.
- Integrations page card: paste token (write-only), **Test connection** (one
  search, shows success, not data), monthly spend cap, on/off.
- Off until an HR head switches it on; switching on and off is audited
  (`writeAudit`), and so is any key change.

### 5.3 Domain policy

`src/server/web-research/policy.ts`, versioned in code and reviewed like any
other change:

- **Allowed for reading** (`readPage`): the existing `QUALITY_DOMAINS` pay
  publishers, plus company and news sites — each entry records the reason and
  the date its terms were checked. Unblocking (Bright Data's anti-bot
  handling) is used **only** for entries marked `unblockOk: true` after that
  review; every other allowed site is fetched through plain `safeFetch` first.
- **Never read**, whatever the allowlist says: job boards and professional
  networks' candidate and profile pages (`naukri.com`, `linkedin.com/in/…`,
  `indeed.com/r/…`, `foundit.in`, `instahyre.com`, …), social media personal
  profiles, anything behind a login.
- **Search** may return any public result, but only allowed domains are read;
  other results are shown as titles and links only.
- Candidate-supplied links (phase 3): the exact URL the candidate gave, one
  hop, no unblocking.

### 5.4 No personal data in queries

Search queries are built from the requisition (title, location, level,
skills, company) — never from a candidate record. A guard rejects any query
containing an email, phone number, or a name of a candidate or member of the
organisation (the same matcher as the training-data pseudonymiser). This keeps
candidate data from ever reaching the vendor in a query.

### 5.5 Agent tools

| Tool            | Risk   | Behaviour                                                                                                                                                                                                                              |
| --------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search`    | `read` | `{ query, location?, count ≤ 10 }` → title, URL, snippet, domain, whether it is readable under the policy. `untrustedOutput: true`.                                                                                                    |
| `read_web_page` | `read` | `{ url }` → Markdown (capped, e.g. 60 KB) reduced to the relevant passages, with the URL and fetch date. Refused by `precheck` when the domain is not allowed, the cap is reached, or the integration is off. `untrustedOutput: true`. |

- Declared in the `skills` of the agents that get them (Requisition, JD,
  Offer, Sourcing); each agent's version bumps and `scripts/agents.lock.json`
  is refreshed; each gets a real-agent eval (§7).
- `src/lib/market.server.ts` uses the same client as an extra **discover**
  source (vendor-independent search) and as a fallback **read** for allowed
  publishers that `safeFetch` cannot reach. Without the integration it behaves
  exactly as today.
- Page text enters prompts only through `untrusted(...)` with
  `INJECTION_RULES` (AGENTS.md); suspected injections are flagged on the step
  like CV text.

### 5.6 Cost, attribution and limits

- New ledger `web_requests` (migration): org, feature, kind (search / read),
  host (no full URL for searches), status, result count, billed units, latency,
  and the same attribution columns as `ai_usage_events` (`agent_run_id`,
  `requisition_id`, `application_id`, `candidate_id`, filled from the existing
  scopes).
- Priced from the price catalogue (`src/server/ai-pricing.ts` extended with
  per-request prices — Bright Data publishes $1.50 per 1,000 search/scrape
  results with 5,000 free requests a month; to be re-checked on their pricing
  page before build). Included in Hiring cost (per candidate, per role,
  organisation dashboard) as its own line.
- Monthly cap per organisation (requests and money), enforced in `precheck`;
  80 % and 100 % alerts to the HR head.
- Cache: identical searches and page reads per organisation are served from a
  24-hour cache keyed by a hash, to cut cost and load on publishers.
- Health rules (`health.server.ts`): `web_research.blocked_rate` (reads
  failing), `web_research.cap_reached`, `web_research.injection_suspected`.

### 5.7 Data protection

- Bright Data becomes a **sub-processor**: it sees every query and every URL
  read. Before switch-on for customers: a data processing agreement, listing in
  our sub-processor list, and a note in `SECURITY.md`. Customers enable it
  themselves (§5.2).
- Because of §5.4, no candidate personal data goes to the vendor in phases 1–2.
  Phase 3 (candidate links) sends only the URL the candidate gave us, and is a
  separate opt-in.
- Fetched pages are not stored beyond the 24-hour cache; what an agent used
  is kept in its run steps (as today) and, with consent, in training data.

### 5.8 Training data

Searches and page reads become part of the agent's context, so they are
already captured in `training_inferences` (the prompt includes the tool
results). `web_requests` rows link to the run, so trajectories show which
sources the agent looked at — useful for teaching the future model when to
search and what to trust.

## 6. Rollout

| Phase | Scope                                                                                              | Exit criteria                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1     | Integration, credentials, ledger, caps; `web_search`; market research uses it as a discover source | Evals pass; pay research on an OpenAI/Anthropic org returns cited sources; cost visible in Hiring cost   |
| 2     | `read_web_page` with the domain policy; market research fallback reads                             | Fewer dropped publishers on a fixed benchmark set of roles; no read outside the policy in a week of logs |
| 3     | Candidate-supplied links (opt-in)                                                                  | Separate review of the privacy note; consent wording approved                                            |

## 7. Tests

- Policy: allowed / never-read / unblock flags; profile URLs on job boards
  always refused, including redirects and look-alike hosts.
- Query guard: candidate and member names, emails and phones rejected.
- Precheck: integration off, cap reached, domain refused → the agent is told
  why, nobody is asked.
- Ledger: attribution, pricing, cap arithmetic, cache hits not billed.
- Untrusted text: an injection on a fetched page does not change tool use
  (scripted eval, as for CVs).
- Real-agent evals: Requisition agent sets a band with web sources on a
  non-Gemini model; Sourcing agent reports competitor hiring without reading a
  job-board profile.
- Failure: provider down or 429 → current behaviour, no error to the person.

## 8. Alternatives considered

| Option                                            | Why not (now)                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Use the Bright Data MCP server inside the product | Unbounded tool surface, bypasses our registry, gates, ledger and capture                                                  |
| Rely only on the model's grounded search          | Vendor lock-in; OpenAI/Anthropic organisations get no search; no control over sources                                     |
| Our own crawler                                   | Right long-term for allowed publishers; not worth building before demand is proven. The interface in §5.1 keeps this open |
| Other SERP providers                              | Viable; the interface keeps the provider swappable. Bright Data is chosen only because it also covers page reads          |

## 9. Effort (estimate)

Phase 1 ≈ 4–5 days (integration and credentials, client, ledger and pricing,
caps, `web_search`, market discover source, tests, evals, docs). Phase 2 ≈ 3
days. Phase 3 ≈ 2 days after the privacy review.

## 10. Decisions (2026-10-12)

1. **Who pays — decided:** each organisation brings its own Bright Data key
   (§5.2). No platform account.
2. **Domain policy sign-off — decided:** the allowlist and every `unblockOk`
   entry are signed off by product and legal review, recorded in
   `policy.ts` with the reviewer and date.
3. **DPA — decided:** signed with Bright Data after a successful proof of
   concept, and before any customer organisation can switch the integration
   on. Until then it runs only in our own organisations.
4. **Phase 3 (candidate-supplied links) — open.**
