# M0 verdict — Track A design note (PR #112)

Reviewer: Claude. Product owner final approval pending (identity is an
invariant-touching track).

**APPROVED WITH CONDITIONS — start A1.** Fold findings 1–4 into the design note in the
A1 PR (no separate re-review needed). Findings 5–6 are for A2.

> Strong work: the undo snapshot, the lookup-only rule on public apply, and the
> erasure × merge section are exactly right.

## Findings (fix in A1)

1. **"Keep separate" on a strong-key collision is unspecified.** The unique index
   (orgId, keyType, keyValue) means the newcomer can never hold that key. State the
   rule: the key stays with the existing owner, and the newcomer's copy is recorded as
   a non-unique "shared" signal (e.g. a shared family or agency email), so later
   intakes with that key go to review rather than auto-merging into either person.
   Add a test.
2. **Public apply contradicts itself.** §1.4 says a hit "links the application to the
   existing id", yet "the applicant's CV is stored only on the newly inserted row".
   Pick one. Recommended: link the application to the existing candidate (today's
   behaviour), and store the submitted CV as a pending version that only becomes part
   of the profile after a recruiter accepts it from the review queue. Unauthenticated
   input never changes the profile.
3. **The file-hash test "same file hash never creates a second candidate" contradicts
   §1.3**, where same bytes with a different name go to review, which needs a second
   row. Reword the test to: same bytes + same name → no second candidate.
4. **Undo after later activity.** Define what undo does when the survivor has changed
   since the merge (new applications, stage moves on re-pointed applications, new
   versions). Rule: undo is refused if a re-pointed child changed after the merge,
   with a clear message; otherwise proceed. Test both cases.

## Findings (A2)

5. **Consent must survive a merge.** A merge must keep the most restrictive
   poolUse / consent / retention of the two records. A 'role_only' candidate (portal
   terms) merged into a 'pool' candidate must never become pool-matchable. Add this to
   the merge rules and a test, and show it on the review card.
6. **Trial-run mode writes no candidates.** Say how within-batch duplicates and the
   "duplicate rate" are measured without them: an in-memory key map for the batch plus
   lookups against existing keys.

## Open questions — answers

- **Q1** Placeholder → real email arrives: review suggestion. Agreed.
- **Q2** Long CVs: use the 20k slice for now; decide on chunking from the A3 trial-run
  cost report.
- **Q3** Survivor: keep oldest-wins as the default, and let the reviewer swap the
  survivor on the review card.
- **Q4** Restoring applications with their original dates on undo: yes.
- **Q5** Retention default: keep everything until the tenant sets a period. Product
  owner to confirm before A3.
- **Q6** OCR: in A3, behind a tenant setting, off by default; measure the cost in the
  trial run.
- **Q7** C1 contract: settle it with Developer 5 before any C1 code, as written.
- **Q8** Sector taxonomy: Developer 5 owns the taxonomy table (B3 needs it for
  extraction). C1 consumes it.

## Coordination

Developer 5 is changing `capture.server.ts` (`latestInferenceFor` gains a
`requisitionId` branch) and `withAiSubject` in B3. Rebase on that rather than editing
the same functions in parallel.

## Reminders for A1

- Migration 0094 is ours unless D5 merges a migration first.
- Merges go through `withStepUp`, are audited, and can be undone; nothing fuzzy is
  merged automatically.
- Keep the PR under about 800 changed lines. If intake rewiring makes it bigger, split
  it into A1a (tables + module + queue UI) and A1b (the nine paths switched).
