# Panel directory

Interview panels are drawn from one directory per organisation (`panelists`, migration 0068):

- **Internal** — every org member is an entry (kept in step automatically), plus employees
  without a login whom HR adds.
- **External** — people outside the organisation: a client, an advisor, a partner's engineer.

Each entry has a name, e-mail, job title, company (external), the areas they assess and the
rounds (L1–L3) they take, and records who added and approved it.

## Adding someone

- **On the Interview coordinator's request.** When nobody in the directory takes a round — or
  nobody covers what the round rates — the coordinator (2.2.0) calls `request_new_panelist`. The
  HR head gets a card in the hiring desk saying what the round needs, types the person in
  (internal or external) and approves. Typing is approving: it is recorded as self-approved in the
  audit log (`panelist.added`, `detail.selfApproved`). The coordinator is told who was added, lists
  the eligible people again and proposes the panel, which a person approves as before. The agent
  never invents a person, an e-mail or a company.
- **On the Team page** (Team → Panel directory), by the HR head or an owner. People added there
  can be taken off panels and put back; members are managed with their interviewer profile.

An e-mail that belongs to an org member makes that member's entry; the same e-mail cannot be
added twice; a member cannot be added as external.

## Panels and stand-ins

`role_panels.panelist_ids` and `round_substitutes.*_panelist_id` hold directory ids. Panels and
stand-ins stored before the directory (org-member ids) still resolve, and code that predates it
keeps working on the same database (`member_ids` is still written for members).

## External panellists' scorecards

External panellists have no account. Their interviewer brief carries a private link,
`/scorecard/<token>`, for that round only:

- the token is an HMAC of the server secret, interview, panellist and booked time — only its
  SHA-256 is stored; a resent brief carries the same link and a reschedule replaces it;
- the page shows the round, role, candidate name and the round's competencies — nothing else;
- it opens once the interview has started and closes seven days after it; one scorecard, final;
- an external scorecard never moves a candidate into the offer pipeline — that waits for the
  HR head;
- the brief leaves out internal material: match score, screening result and the candidate page.

See SECURITY.md for the public-link rules shared with the candidate links.

## Health

`interview.new_panelist_waiting` — a request for a new panellist unanswered for more than 24 hours
holds the round up. `interview.no_eligible_panel` — candidates wait on a round nobody in the
directory takes.
