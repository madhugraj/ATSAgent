-- 0042_agent_run_legs.sql — run limits per leg, and per-agent run limits.
--
-- A run that waits on people (an approval chain, a question) is not a
-- runaway loop: each human decision now starts a new leg with a fresh
-- allowance of AI turns and tokens. agent_runs.leg_step_start /
-- leg_token_start record where the current leg began; a hard ceiling of four
-- legs' worth (enforced by the runtime) still stops a looping agent.
-- agent_policies.max_steps_per_leg / max_tokens_per_leg let the HR head / CBO
-- raise an agent's allowance (within platform maximums); null keeps the
-- agent's own default. The monthly token budget stays the cost control.
--
-- Idempotent: re-running is a no-op.

alter table agent_runs add column if not exists leg_step_start integer not null default 0;
alter table agent_runs add column if not exists leg_token_start integer not null default 0;

alter table agent_policies add column if not exists max_steps_per_leg integer;
alter table agent_policies add column if not exists max_tokens_per_leg integer;
do $$ begin
  alter table agent_policies add constraint agent_policies_max_steps_per_leg_check
    check (max_steps_per_leg is null or max_steps_per_leg between 4 and 60);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table agent_policies add constraint agent_policies_max_tokens_per_leg_check
    check (max_tokens_per_leg is null or max_tokens_per_leg between 20000 and 1000000);
exception when duplicate_object then null; end $$;
