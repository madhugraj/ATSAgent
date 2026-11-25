-- Talent-pool contact: people can opt out of role emails from a link in
-- invitations and introductions, and pool matches are told they are being
-- considered (email_outbox kind 'pool_match_intro', text column — no enum).
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs
alter table candidates add column if not exists contact_opt_out_at timestamptz;
-- Cross-role outreach gap looks up recent outreach per person.
create index if not exists email_outbox_outreach_idx
  on email_outbox (org_id, created_at)
  where kind in ('role_invite', 'pool_match_intro');
