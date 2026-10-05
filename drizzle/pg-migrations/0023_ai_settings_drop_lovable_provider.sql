-- 0023_ai_settings_drop_lovable_provider.sql — retire the Lovable AI gateway
-- provider value.
--
-- ai_settings.provider defaulted to 'lovable' (the hosted gateway this app
-- used before bring-your-own-key). resolveAiConfig (src/lib/ai-gateway.server.ts)
-- only accepts openai | anthropic | google and already treats anything else as
-- 'openai', but kept the gateway-style model id ('google/gemini-…'), which
-- OpenAI rejects. Store what the runtime actually does: provider 'openai' with
-- its default model (DEFAULT_MODEL.openai), and make that the column default.
-- Idempotent: re-running is a no-op.

UPDATE ai_settings
SET provider = 'openai',
    model = 'gpt-5.5',
    updated_at = now()
WHERE provider = 'lovable';

ALTER TABLE ai_settings ALTER COLUMN provider SET DEFAULT 'openai';
ALTER TABLE ai_settings ALTER COLUMN model SET DEFAULT 'gpt-5.5';
