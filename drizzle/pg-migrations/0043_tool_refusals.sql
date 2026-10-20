-- 0043_tool_refusals.sql — tell refusals from failures in recorded tool steps.
--
-- A tool step with status 'error' is either a business rule / guardrail saying
-- no (output.refused = true: shown as "refused by a rule", not counted as a
-- failure) or something that broke. The runtime now records the flag; this
-- marks earlier steps by the same rule: a readable message that is not an
-- infrastructure error, nor the agent calling a tool wrongly.
--
-- Idempotent: re-running is a no-op.

update agent_steps
set output = coalesce(output, '{}'::jsonb) || '{"refused": true}'::jsonb
where kind = 'tool' and status = 'error'
  and coalesce(output ->> 'refused', '') = ''
  and coalesce(output ->> 'error', '') <> ''
  and length(output ->> 'error') < 600
  and (output ->> 'error') !~* '(ECONN|ETIMEDOUT|timed? ?out|fetch failed|network|socket|database|Failed query|syntax error|duplicate key|deadlock|violates|does not exist|undefined|null|NaN|Cannot read|Invalid arguments|Unknown tool|not valid JSON|The tool failed)';
