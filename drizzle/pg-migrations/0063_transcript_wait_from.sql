-- 0063_transcript_wait_from.sql — silent panel agents, after the first real
-- Teams call (docs/silent-panel-agent-plan.md).
--
-- interviews.transcript_wait_from: when the current wait for a round's
-- transcript started. Null = the booked end of the call. "Try again" on a
-- round with no transcript (e.g. after the meeting account's transcript
-- permission was granted) sets it to the moment of the retry, giving the
-- fetch a fresh 6 hours.
--
-- Idempotent: re-running is a no-op.

alter table interviews add column if not exists transcript_wait_from timestamptz;
