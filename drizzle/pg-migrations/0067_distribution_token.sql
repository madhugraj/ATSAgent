-- Distribution-surface capture token (2026-11 audit N-15): the browser
-- companion derives a per-surface token (HMAC-SHA256 of the capture key with
-- the message "distribution") so a key seen by a job-board destination cannot
-- be replayed against the candidate-capture endpoint. The server stores only
-- the SHA-256 of the derived token, found lazily on the next Integrations
-- page load or key rotation.
-- Idempotent: re-running is a no-op.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS distribution_token_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_distribution_token_hash_key
  ON organizations USING btree (distribution_token_hash);
