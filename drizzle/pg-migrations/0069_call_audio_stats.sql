-- 0069_call_audio_stats.sql — how smoothly the assistant's voice went out on each
-- live call (Agent observability → Voice agents): 20 ms frames sent, gaps where its
-- speech ran out mid-sentence, send ticks over 40 ms late and the worst lateness.
-- Written when the call ends (src/server/voice/rtp.ts AudioStats). Never audio.
--
-- Idempotent: re-running is a no-op.

alter table screening_calls add column if not exists audio_stats jsonb;
