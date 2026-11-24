# Roles & rights (R&R) — who can see and do what

Single reference for ATSIQ's permission model. Every claim here is enforced **server-side**
in `src/lib/*.functions.ts` / `src/lib/auth.middleware.ts` — the sidebar/menu visibility
(`src/hooks/useNavCtx.ts`, `src/components/nav-config.ts`) only mirrors it.

## The model

- **Account owner** — the creator of the organisation (`org_members.is_owner`). Passes every
  role check (`assertRole`/`requireRole` semantics, auth.middleware.ts:54/111). Transferable,
  not grantable to two people.
- **Six grantable roles** (`AppRole`): `recruiter`, `hiring_manager`, `department_head`,
  `hr_head`, `president_cbo`, `interviewer` (migration 0081). A member can hold several; a
  member with **no roles gets the recruiter (TA) journey**. A member whose **only** role is
  `interviewer` (and who is not the owner) is **panel-only — denied by default** (see the
  note under the surfaces table).
- **Platform super admin** — separate, cross-tenant (platform console / AI usage only).
- **Golden rule:** reads are **organisation-wide** — every active member (except a panel-only
  `interviewer`) can _see_ the org's requisitions, JDs, candidates (incl. CV text),
  applications, scores, interviews, screening and offers. Roles gate **actions**, not reads.
  Two read exceptions below (HR performance, ROI).

## Roles → surfaces (visibility)

| Surface                                                                            | owner | hr_head | president_cbo | recruiter | dept_head | hiring_manager | interviewer (panel-only) |
| ---------------------------------------------------------------------------------- | ----- | ------- | ------------- | --------- | --------- | -------------- | ------------------------ |
| Dashboard (executive band: ROI, org health, HR team governance)                    | ✅    | ✅      | ✅            | —         | —         | —              | —                        |
| Dashboard (Priority workspace + "Needs you today")                                 | ✅    | ✅      | ✅            | ✅        | ✅        | ✅             | —                        |
| JD↔CV matching (hiring-team tool — run it, review results)                         | ✅    | ✅      | ✅            | ✅        | ✅        | ✅             | —                        |
| Talent pool, Screening calls, Interviews, Offers, Careers inbox, Internal postings | ✅    | ✅      | ✅            | ✅        | —         | —              | —                        |
| Requisitions & JD library                                                          | ✅    | ✅      | ✅            | ✅        | ✅        | ✅             | —                        |
| Reports                                                                            | ✅    | ✅      | ✅            | —         | ✅        | ✅             | —                        |
| Return on Individual, Talent Brain                                                 | ✅    | ✅      | ✅            | —         | —         | —              | —                        |
| Users & roles, Integrations, Master data, Content templates                        | ✅    | ✅      | ✅            | —         | —         | —              | —                        |
| Organisation settings                                                              | ✅    | —       | —             | —         | —         | —              | —                        |
| My interviews only — own rounds, brief & CV, scorecard (`requirePanel`)            | —     | —       | —             | —         | —         | —              | ✅                       |
| Platform console / AI usage                                                        | —     | —       | —             | —         | —         | —              | —                        | (platform super admin only) |

A **panel-only** member (`interviewer` as the only role, never the owner) is denied by default:
`activeOrgOf` resolves them to no organisation, so `requireOrg`, `requireRole`,
`requireOrgOwner` and `assertRole` all refuse; only `requirePanel` functions admit them (My
interviews, scorecard submission, "can't make it", "didn't happen", `myRoundBrief`), each
limited to rounds whose interviewer or panel is the caller's own email. Any other role
alongside `interviewer` restores normal access (auth.middleware.ts).

## Actions matrix (server-enforced)

### Requisitions & JD

| Action                                              | Who                                             |
| --------------------------------------------------- | ----------------------------------------------- |
| Create requisition / draft JD / edit JD / import JD | any member                                      |
| Send to Department Head (→ `pending_dh`)            | any member                                      |
| Approve as Department Head (→ `pending_hr`)         | `department_head`                               |
| Approve as HR Head (→ `pending_cbo`)                | `hr_head`                                       |
| Final approval (→ `approved`)                       | `president_cbo`                                 |
| Reject a pending requisition                        | `department_head`, `hr_head` or `president_cbo` |
| Put on hold / close                                 | `hr_head` or `president_cbo`                    |
| Approve a JD (`jd_status → approved`)               | `department_head`, `hr_head` or `president_cbo` |

(requisitions.functions.ts `REQ_TRANSITIONS`:28-47; assertRole at :76; JD approval :280-296)

### Pipeline — matching, screening, candidates

| Action                                                                                     | Who                                                                                                        |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Run JD↔CV matching / AI screening / view score evidence                                    | any member (org-gated); hiring managers & department heads see the matching results for their requisitions |
| Prepare / edit / grade a screening kit; upload CVs; add candidates; attach pool candidates | any member (org-gated)                                                                                     |
| Delete candidates                                                                          | `hr_head` or `president_cbo`                                                                               |

### Interviews & stage moves

| Action                                                                       | Who                                                                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Schedule / reschedule an interview                                           | any member (reschedule needs a reason)                                                                               |
| Submit a scorecard                                                           | the assigned evaluator, or a directory panellist without a login through the private expiring link (locks on submit) |
| Add a Team → Panel directory entry                                           | `hr_head` or owner; on the coordinator's desk card, typing the person in is the approval (self-approved, audited)    |
| Move a candidate through applied → ai_screened → shortlisted → L1 → L2 → L3  | any member (legal transitions only; reasons required on closes)                                                      |
| Move into the offer pipeline (`offer_pending/released/accepted`) or `joined` | `hr_head` or `president_cbo`                                                                                         |

(lifecycle.functions.ts:13-20,58-65; interviews.functions.ts:33,209-216)

### Offers

| Action                                                                      | Who                                       |
| --------------------------------------------------------------------------- | ----------------------------------------- |
| Raise an offer (lands at `pending_hr`, candidate parked at `offer_pending`) | `recruiter`, `hr_head` or `president_cbo` |
| HR approval (→ `pending_cbo`) — requires the offer letter first             | `hr_head`                                 |
| CBO approval (→ `approved`)                                                 | `president_cbo`                           |
| Release (→ `released`) — requires pre-onboarding documents validated        | `hr_head`                                 |
| Revoke a released/accepted offer                                            | `hr_head` or `president_cbo`              |

(offers.functions.ts `OFFER_TRANSITIONS`:31-42, assertRole :121; create gate at the top of createOffer)

### Users, roles & settings

| Action                                                     | Who                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Invite members, grant/revoke roles, disable/remove members | **owner or `president_cbo`** only (`assertAdmin`, org.functions.ts:410-431); cannot act on owners or yourself |
| Organisation settings, archive organisation                | owner                                                                                                         |
| Transfer ownership                                         | owner                                                                                                         |

### Integrations & platform

| Action                                                               | Who                                             |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| Save/test integration credentials, rotate webhooks                   | `hr_head` (owner passes)                        |
| Platform console, cross-org AI usage, impersonation-free super admin | platform super admin                            |
| Candidate emails / HRMS / board / inbox configuration                | follows the integrations + settings rules above |

### Read exceptions (the only role-filtered reads)

- **HR team performance** — owner, `president_cbo`, `hr_head` only (hr-performance.functions.ts:51-57).
- **ROI** — nav-gated to leadership; server check covers membership + cross-org (see hardening notes).

## Hardening notes

Enforcement tightened 2026-10-01 (previously org-gated): **offer creation** (now recruiter /
hr_head / president_cbo), **candidate deletion** (now hr_head / president_cbo). Verified
already-correct: **ROI** was server-gated to owner / president_cbo / hr_head all along
(roi.functions.ts:112-120). Matching and screening remain org-gated on purpose — the whole
hiring team works them; hiring managers and department heads get the matching view without
the sourcing tools (pool, screening, offers, inbox).

Panel-only members (2026-11, migration 0081): `activeOrgOf` resolves a member whose only role
is `interviewer` (and who is not the owner) to no organisation, so every
`requireOrg`/`requireRole`/`requireOrgOwner`/`assertRole` path refuses them; code that reads
membership directly checks `assertNotPanelOnly`/`isPanelOnly` (org.functions, collaboration,
notifications). Only `requirePanel` functions admit them, each limited to the caller's own
rounds by email. The external panellist's scorecard link is the other restricted surface added
with the panel directory: HMAC token with only its hash stored, valid from the interview's
start until seven days after, one final scorecard, never moves a candidate into the offer
pipeline (SECURITY.md, docs/panel-directory.md).

## Demo logins (local stack, password `demo1234`)

| Login                | Role                                    | View                               |
| -------------------- | --------------------------------------- | ---------------------------------- |
| `hr@yavar.ai`        | owner, Yavar Technologies               | owner (label "Organisation owner") |
| `madhu@demo.com`     | owner + platform super admin, Demo Corp | owner + platform                   |
| `hrhead@demo.com`    | **`hr_head`**, Demo Corp                | HR head (executive-lite)           |
| `dh@demo.com`        | `department_head`, Demo Corp            | approver workspace                 |
| `hm@demo.com`        | `hiring_manager`, Demo Corp             | approver workspace                 |
| `recruiter@demo.com` | `recruiter`, Demo Corp                  | recruiter (TA)                     |
| `owner@newdemo.com`  | owner, New Demo Technologies            | second-org owner                   |
