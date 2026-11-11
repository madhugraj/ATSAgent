# Pay terms — currency, pay basis, kinds of work and joining dates

Status: **approved** (11 November 2026). **Phases 1–3 built** (migrations 0073–0074; `src/lib/pay-terms.ts`, `pay-convert.ts`, `pay-settings*.ts`; the `pay_conventions` gate; Organisation context agent 1.2.0 and Requisition agent 1.10.0; `scripts/pay-terms.test.ts`, `scripts/pay-settings.test.ts`, `scripts/pay-logistics.test.ts`; screening call 1.10.0 and matching in Phase 3); Phase 4 to come.

## Why

Today every pay figure is a bare number that every agent reads as an annual
CTC in rupees for a permanent job:

- `organizations.currency` exists (default INR) but only salary benchmarks and
  ROI read it.
- Requisition budget and band, candidate current/expected CTC and offers store
  numbers with no currency or basis.
- The voice calls are hard-wired to India: "rupees per year", lakhs/crores,
  rupee validation, "18 lakh 50 thousand rupees" in the negotiation call.
- `engagement_type` / `billing_type` describe internal vs client work only;
  there is no permanent / contract / hourly distinction.
- Notice period is a logistics flag from the CV only; the screening call's
  notice and joining date go to the HR-only compensation record and never reach
  the match check. A requisition has no "needed by" date, so joining date is
  used nowhere.

A USD hourly contract role, or a London candidate quoting £90k, is compared
against rupee CTC bands today — silently wrong.

## Principles

1. **One shape, everywhere.** A single `PayTerms` (role) and `Money` (figure)
   type in `src/lib/pay-terms.ts`. No bare pay number crosses a boundary.
2. **The organisation sets defaults; the role sets the terms; everyone else
   reads them.** No new agent.
3. **Never guess a conversion.** Compare like with like; when that is not
   possible (no rate, unknown hours), say so and flag — never estimate.
4. **Nothing in use changes.** Existing rows backfill to INR · annual ·
   permanent; behaviour for Indian annual roles is identical.
5. **Logistics are not merit.** Notice, joining date and pay stay out of the
   score; they become urgency, flags and blockers.

## The shapes

```ts
type KindOfWork = "permanent" | "fixed_term" | "contract_hourly" | "part_time" | "intern";
type PayBasis = "annual" | "monthly" | "daily" | "hourly";

type PayTerms = {
  kind: KindOfWork;
  basis: PayBasis;
  currency: string;          // ISO 4217: INR, USD, EUR, GBP…
  hoursPerWeek: number | null;
  daysPerWeek: number | null;
  contractMonths: number | null;   // fixed_term / contract
  extendable: boolean | null;
  neededBy: string | null;         // YYYY-MM-DD — the role's urgency
};

type Money = { amount: number; currency: string; basis: PayBasis };
```

`src/lib/pay-convert.ts` — the only converter: `toBasis(money, terms)` (uses
the role's hours/days; refuses without them) and `toCurrency(money, to, rate)`
(rate and its date recorded with the result; no rate → `null`, never a guess).
Spoken form per currency: `spokenMoney(money)` — "18 lakh 50 thousand rupees a
year", "ninety thousand pounds a year", "sixty-five dollars an hour".

## Phase 1 — foundation (schema, shapes, converter)

- Migration `0073_pay_terms.sql` (idempotent):
  - `organizations`: `pay_basis_default`, `hours_per_week_default`,
    `days_per_week_default`, `kinds_of_work text[]`.
  - `requisitions`: `kind_of_work`, `pay_basis`, `currency`, `hours_per_week`,
    `days_per_week`, `contract_months`, `extendable`, `needed_by`.
  - `candidates`, `compensation_details`, `offers`: `currency`, `pay_basis`
    beside each figure; `compensation_details` gains `available_from`.
  - Backfill: org currency (else INR), `annual`, `permanent`. Checks on enums
    and ISO codes.
- `pay-terms.ts`, `pay-convert.ts`, `spokenMoney`; unit tests including
  hourly↔annual and refused conversions.
- `docs/er-diagram.md` regenerated; `drizzle/schema.ts` updated.

## Phase 2 — the owners

**Organisation context agent** (version bump): asks for and records the
organisation's conventions — currency, how pay is quoted, kinds of work it
hires, standard hours. Conventions, never figures (its must-never on pay
figures stands). HR-head approval per version, as today. These become part of
the context every agent receives.

**Requisition agent** (version bump): drafts the role's `PayTerms` from the
org defaults and asks only what differs ("Is this permanent or a contract?
Paid annually or by the hour?" "When must they start?"). The band is set in
the role's basis and currency. Approval shows the terms in one line. Approval
trail and `assertRole` unchanged.

UI: Organisation page (defaults), requisition form (terms), Phone screening
card unaffected.

## Phase 3 — screening call and matching

**Screening call** (version bump; charter updated):
- Asks in the role's terms: "What is your current hourly rate?" / "current CTC
  per year?"; contract roles ask availability date and contract length
  accepted instead of notice period.
- `record_details` takes `Money` (amount + currency + basis); figures in
  another currency are recorded as said, never converted on the call.
- `STATES_AMOUNT` and pay vocabulary become per-currency (lakh/crore, k,
  thousand, "an hour").
- Consequence line and required details unchanged in spirit.

**Matching / logistics** (`logistics.ts`, `autoscore.server.ts`):
- Reads the latest of CV data **and** the call's compensation record (call
  wins, newer wins) — fixes notice/joining/pay never reaching the check.
- Band comparison via `pay-convert`; unconvertible → flag "pay in another
  currency/basis — not compared", never a blocker.
- `needed_by`: earliest joining / available-from after it → high join risk;
  more than the org's tolerance after it → blocker a person can override.
  Notice beyond the cap stays a flag.
- Hiring agent orders shortlists by fit, then by can-join-in-time — still
  outside the score.
- Rescore of affected applications when a call records new details.

## Phase 4 — negotiation, offer, JD, distribution, onboarding

- **Negotiation call** (version bump): `spokenMoney`, rate card for hourly
  roles, contract length as a lever; graders parse per currency.
- **Offer agent** (version bump): offer in the role's basis and currency;
  contracts get start/end dates and rate; offer letter templates per kind.
- **JD / Publishing / Distribution** (version bumps): state kind, length and
  pay basis; map to each board's employment-type and salary-unit fields.
- **Onboarding**: contract start/end instead of probation for contract kinds.
- Reports (ROI, hiring cost): sum only same-currency figures, or convert with
  a recorded rate; label the currency.

## Governance, tests and docs (every phase)

- Each touched agent: version bump + `bun run agents:lock`; manifest scope
  updated.
- Evals in `scripts/evals/scenarios.ts`: USD hourly contract screened end to
  end; GBP permanent; INR annual unchanged (regression); candidate quoting a
  different currency from the role.
- Health rules (`health.server.ts` + `scripts/agent-health.test.ts`): a pay
  figure saved without currency/basis; a comparison made across currencies
  without a recorded rate; a joining date after `needed_by` not flagged.
- Vendor-neutral copy; no pay figures to the Voice Guard (unchanged).
- Docs in the same change: README, roadmap, voice-screening-agent,
  voice-agents-charter, user-manual, SECURITY (no change expected),
  DEPLOYMENT docs (migration).

## Order and size

| Phase | Depends on | Rough size |
|---|---|---|
| 1 Foundation | — | 1–2 days |
| 2 Owners | 1 | 2 days |
| 3 Call + matching | 1, 2 | 3 days |
| 4 Downstream | 1, 2 | 3–4 days |

Phases 3 and 4 can run in parallel once 2 lands.

## Global organisations — pay zones, normalisation and regional pooling

An organisation like Accenture hires in 50 countries through many legal
entities. Three currencies are in play for one figure, and they must never be
confused:

| Currency | Whose | Example |
|---|---|---|
| **Quoted** | what the candidate said | Milan candidate: "€52,000 RAL" |
| **Pay** | what the role is paid in — set by where the job is, not where the requisition was raised | Milan role → EUR |
| **Reporting** | what the organisation normalises to for budgets and comparisons across regions | USD |

Every figure is **stored as said** (quoted), and **derived** into pay and
reporting currency with the rate, its source and its date kept beside it.
Conversions never overwrite the original; a re-run with a newer rate is a new
derived value, not an edit.

### What the organisation agent makes customisable

Through the organisation chat (HR-head approved, versioned — as today):

1. **Reporting currency** (e.g. USD) and how budgets are shown (pay, reporting
   or both).
2. **Pay zones** — the heart of it. A zone is a country or a group of cities
   with one way of paying:
   - currency (EUR), pay basis norm (annual gross; IT "RAL"), payments a year
     (IT 13 or 14, BR 13, IN 12), what a quoted figure includes (IN CTC
     includes employer PF and gratuity; US base excludes bonus and equity;
     Gulf quotes are tax-free with housing and transport allowances),
   - standard hours per week and working days a year (for hourly ↔ annual),
   - kinds of work offered there and their contract types (UK: permanent,
     fixed-term, contractor inside or outside IR35, day rate; US: W-2, 1099,
     C2C; IN: payroll, third-party contract),
   - the legal entity that employs in it,
   - a geo pay factor against a reference zone, when the organisation pays by
     location for remote roles.
3. **Regions for pooling** — named groups of zones (EMEA, South Europe, India
   South) and the pooling rule per role kind: *same zone*, *same region*,
   *anywhere the entity can employ*, or *global remote*.
4. **Exchange rates** — the source (an organisation rate table, its treasury
   rates, or a rates service), refresh cadence, and a rate lock at offer time
   (the offer letter uses the rate on the day it was approved).
5. **Tolerances** — how far over the band is a flag versus a blocker, in pay
   currency, so currency moves alone never flip a decision.

These are conventions, not figures — the organisation agent's must-never on
storing pay figures stands; bands live on requisitions as today.

### How a role and a candidate meet

1. **Requisition** — location(s) resolve to a pay zone (by city/country; the
   requisition agent asks when ambiguous). The band is set **in the pay
   currency and basis**; the reporting-currency view is shown beside it,
   derived. A role open in several locations has one band per zone.
2. **Pooling** — the candidate pool for a role is filtered by the role's
   pooling rule *before* matching: a Milan role on *same region* draws from
   South Europe candidates and those who said they will relocate there, with
   work authorisation for the entity's country. Others are not hidden — they
   appear as "outside the role's region" with the reason, never scored down.
3. **Candidate's figures** — captured as said (CV, form or call), with
   currency, basis and what it includes ("€52k RAL over 14 payments"). The
   call asks in the zone's own terms: in Italy "your RAL, gross per year"; in
   India "CTC per year"; for a US contractor "your hourly rate, W-2 or 1099".
4. **Comparison** — candidate figure → role's pay currency and basis via the
   zone's rules (hours, payments a year, what is included), then the band
   check. Shown three ways on the match: as said · in pay currency · in
   reporting currency.
5. **Offer** — always in the pay currency and the zone's form (14 payments in
   Italy, CTC breakdown in India, base + bonus + equity in the US), rate locked
   on approval for the reporting view.

### Scenarios this has to get right

| # | Situation | Handling |
|---|---|---|
| 1 | Milan role, org reports in USD, candidate says €52k | Stored €52k annual; pay EUR = as said; USD derived at the dated rate. Band check in EUR. |
| 2 | Same role, candidate quotes in $ "because the posting said $" | Stored as said in USD; converted to EUR for the band; flagged "quoted in another currency" so a person sees it. |
| 3 | Italian candidate quotes monthly net ("€2,400 a month") | Net is never converted to gross by us: recorded, flagged "net figure — ask gross"; the call asks once for gross RAL. |
| 4 | 13th/14th month: "€45k over 14" vs "€3,200 × 14" | Payments a year from the zone; monthly × payments = annual; both kept. |
| 5 | India CTC vs US base | Zone rule says what is included; comparison only within the same definition; cross-zone view labelled "different pay definitions". |
| 6 | Remote role, pay by candidate's location | Pay zone = candidate's zone; band = reference band × geo factor; set on the role as "pays by location". |
| 7 | Remote role, one global band in USD | Pay currency USD for everyone; local quotes converted to USD; noted on the offer. |
| 8 | Candidate relocating Bangalore → Milan | Current pay in INR (as said), expectation asked in EUR for Milan; hike % computed only after converting with a cost-of-living note, never raw. |
| 9 | UK contractor, day rate outside IR35 | Kind contract, basis daily, £; compared with a day-rate band; never with a permanent salary band. |
| 10 | US hourly W-2 vs 1099 vs C2C | Contract type stored; bands per type; a 1099 rate is not compared with a W-2 band without the zone's loading factor. |
| 11 | Gulf: tax-free + housing/transport | Components kept separately; band defines whether allowances are inside it. |
| 12 | Volatile currency (ARS, TRY) | Short rate validity; stale rate → comparison refused until refreshed; reporting view labelled with rate age. |
| 13 | Exchange rate moves between screening and offer | Decisions are made in pay currency, so the move does not flip a decision; the reporting view updates; offer locks its rate. |
| 14 | Candidate says a range, or "k", or "lakhs", or "1.2 M" | Parsed per zone vocabulary; a range records its lower end and the range in words (as built on 11 November). |
| 15 | Candidate with no currency ("ninety thousand") | Assumed the candidate's current zone **only for display**; flagged "currency not said"; the call confirms. |
| 16 | Requisition raised in India HQ for a Milan opening | Pay zone from the job's location, not the requester's; the requisition agent confirms. |
| 17 | One requisition, openings in Pune and Kraków | One band per zone; pooling per opening; reports per zone and in reporting currency. |
| 18 | Hourly part-time 20 h/week vs full-time annual | Conversion uses the role's hours, not the zone default; shown as an equivalent, never as the offer. |
| 19 | Candidate works abroad, wants to return home | Current pay in their current zone's currency; expectation in the role's zone; no hike % across currencies without conversion. |
| 20 | Org changes reporting currency | Derived values recomputed; originals untouched; audit entry. |

### Changes to the shapes

```ts
type PayZone = {
  id: string; name: string; countries: string[]; cities?: string[];
  currency: string; basis: PayBasis; paymentsPerYear: number;
  includes: string[];            // "employer_pf", "gratuity", "bonus", "allowances"…
  hoursPerWeek: number; workingDaysPerYear: number;
  kinds: KindOfWork[]; contractTypes: string[]; entity: string | null;
  geoFactor: number | null;      // vs the reference zone
};

type Money = {
  amount: number; currency: string; basis: PayBasis;
  gross: boolean | null;          // null: not said
  paymentsPerYear: number | null;
  includes: string[] | null;
  saidAs: string;                 // their words
};

type Derived = { money: Money; rate: number; rateSource: string; rateAt: string };
```

New tables: `pay_zones`, `pooling_regions`, `exchange_rates` (org, pair,
rate, source, at), and `pay_figures` (owner, kind — band/current/expected/
offer, Money, derived pay/reporting, rate snapshot) replacing bare columns over
time.

### Added phases

- **Phase 1** adds `pay_zones`, `pooling_regions`, `exchange_rates`,
  `pay_figures`, the zone-aware converter (payments a year, hours, gross/net
  refusal) and the scenario table above as unit tests (one test per row).
- **Phase 2** — the organisation agent's zone and region interview, rate
  source set-up, tolerance; the requisition agent resolves location → zone.
- **Phase 3** — pooling before matching; the call's zone vocabulary; three-way
  display on the match.
- **Phase 4** — offers in the zone's form with locked rate; reports in
  reporting currency.

## Decisions needed

1. **Exchange rates:** a rate table per organisation, kept by finance
   (recommended first), or a rates service, or both (service with manual
   override).
2. **Joining after "needed by":** a blocker a person overrides (recommended),
   or a high-risk flag only.
3. **Kinds of work:** the five above, or your own list.
4. **Pooling default:** *same region* with "outside the region" shown but not
   matched (recommended), or *same zone* strictly.
5. **Net figures:** always ask for gross (recommended), or allow a
   zone-specific net-to-gross estimate (we advise against — it is a guess).
