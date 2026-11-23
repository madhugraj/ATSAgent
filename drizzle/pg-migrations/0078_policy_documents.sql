-- Labour policy: documents read from a source (docs/labour-policy-agent-plan.md,
-- 11 November 2026). A source page lists PDFs (Codes, Rules, Notifications); the
-- agent may read one listed on the source, on the source's own site. The read is
-- kept with its document's address so a finding's quote is checked against it.
-- Idempotent.
alter table policy_reads add column if not exists document_url text;
create index if not exists policy_reads_document_idx on policy_reads (org_id, source_id, document_url, fetched_at);
